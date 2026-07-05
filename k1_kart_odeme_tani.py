# ─────────────────────────────────────────────────────────────────────────────
# K1 KART ÖDEME TANI — kısmi kart ödemesi defter mutabakatı (2026-07-06)
#
# BULGU (denetim K1): main.py kismi_odeme_yap kart ODEME satırını id=f"kodm_{oid}"
# (plan-bazlı SABİT) + ON CONFLICT DO NOTHING ile yazıyordu → aynı kart kesim planına
# 2. kısmi ödeme kart borcunu DÜŞÜRMEZ ama nakit kasadan yine çıkar → borç kalıcı şişik.
# Ayrıca kasa idempotency anahtarı ref_id=oid + tarih + tutar'dan türediği için aynı gün
# aynı tutarla 2. ödeme kasada da sessizce yutulur ama plan sayacı artar.
#
# Bu modül İZOLE tanı toplayıcıdır (salt-okur uç + önizleme-varsayılan onarım):
#   GET  /api/k1/hasar-tarama          → hiçbir şeye dokunmaz, mutabakat raporu döner
#   POST /api/k1/onar?uygula=false     → önizleme (varsayılan); uygula=true ancak insan
#                                        onayıyla çağrılır, telafi ODEME satırı ekler
#                                        (append-only: mevcut kayıt silinmez/değişmez)
#
# Mutabakat ekseni (yanlış alarm üretmesin diye dar tutuldu):
#   kasa tarafı = kasa_hareketleri WHERE ref_type='KISMI_ODE' AND durum='aktif'  (plan bazlı)
#   kart tarafı = kart_hareketleri WHERE id 'kodm_<plan>' / 'kodm_<plan>_*' AND ODEME aktif
# İki toplam eşit olmalı. kasa > kart → K1 hasarı (onarılabilir).
# plan.odenen_tutar sadece BİLGİ alanıdır (tam-ödeme yolları da artırır, otomatik onarıma girmez).
# ─────────────────────────────────────────────────────────────────────────────
import uuid

from fastapi import APIRouter, HTTPException

from database import db
from kasa_service import audit, kart_plan_guncelle_tx
from tr_saat import dt_now_tr

router = APIRouter()

EPS = 0.01  # kuruş toleransı


def _mutabakat(cur) -> dict:
    """Kart_id'li tüm planlar için kasa(KISMI_ODE) ↔ kart(kodm ODEME) mutabakatı. Salt-okur."""
    cur.execute("""
        SELECT id::text, kart_id::text, aciklama, durum,
               COALESCE(odenecek_tutar, 0) AS odenecek_tutar,
               COALESCE(odenen_tutar, 0)   AS odenen_tutar,
               COALESCE(kaynak_tablo, '')  AS kaynak_tablo,
               tarih
        FROM odeme_plani
        WHERE kart_id IS NOT NULL
    """)
    planlar = [dict(r) for r in (cur.fetchall() or [])]

    # Kasa tarafı: kısmi ödeme nakit çıkışları (plan id = ref_id)
    cur.execute("""
        SELECT ref_id, COALESCE(SUM(ABS(tutar)), 0) AS toplam
        FROM kasa_hareketleri
        WHERE ref_type = 'KISMI_ODE' AND durum = 'aktif'
        GROUP BY ref_id
    """)
    kasa_map = {str(r["ref_id"]): float(r["toplam"]) for r in (cur.fetchall() or [])}

    # Kart tarafı: kodm_* ODEME satırları (eski format kodm_<oid>, yeni kodm_<oid>_<seq>)
    cur.execute("""
        SELECT id, kart_id::text, COALESCE(tutar, 0) AS tutar
        FROM kart_hareketleri
        WHERE id LIKE 'kodm\\_%' AND islem_turu = 'ODEME' AND durum = 'aktif'
    """)
    kodm_satirlar = [dict(r) for r in (cur.fetchall() or [])]

    vakalar, temiz = [], 0
    for p in planlar:
        oid = p["id"]
        kasa_t = kasa_map.get(oid, 0.0)
        kart_t = sum(
            float(k["tutar"]) for k in kodm_satirlar
            if k["id"] == f"kodm_{oid}" or k["id"].startswith(f"kodm_{oid}_")
        )
        if kasa_t < EPS and kart_t < EPS:
            continue  # bu eksende hiç kısmi ödeme izi yok — kapsam dışı
        eksik = round(kasa_t - kart_t, 2)
        satir = {
            "plan_id": oid,
            "kart_id": p["kart_id"],
            "aciklama": p["aciklama"],
            "plan_durum": p["durum"],
            "plan_odenen_bilgi": float(p["odenen_tutar"]),
            "kasa_kismi_toplam": round(kasa_t, 2),
            "kart_kodm_toplam": round(kart_t, 2),
            "eksik_kart_odeme": eksik,
        }
        if eksik > EPS:
            satir["tip"] = "K1_EKSIK_KART_ODEME"   # onarılabilir
            vakalar.append(satir)
        elif eksik < -EPS:
            satir["tip"] = "TERS_FARK_ELLE_DEGERLENDIR"  # kart > kasa — otomatik onarıma girmez
            vakalar.append(satir)
        else:
            temiz += 1

    return {
        "taranan_kartli_plan": len(planlar),
        "kismi_odeme_izli_plan": len(vakalar) + temiz,
        "temiz": temiz,
        "vaka_sayisi": len(vakalar),
        "toplam_eksik_kart_odeme": round(
            sum(v["eksik_kart_odeme"] for v in vakalar if v["tip"] == "K1_EKSIK_KART_ODEME"), 2
        ),
        "vakalar": vakalar,
    }


@router.get("/api/k1/hasar-tarama")
def k1_hasar_tarama():
    """K1 mutabakat raporu — tamamen salt-okur, hiçbir kaydı değiştirmez."""
    with db() as (conn, cur):
        return _mutabakat(cur)


@router.post("/api/k1/onar")
def k1_onar(uygula: bool = False):
    """
    K1 telafi: eksik kart ODEME satırlarını ekler (yalnız K1_EKSIK_KART_ODEME vakaları).
    - uygula=false (VARSAYILAN): önizleme — ne yazılacağını gösterir, HİÇBİR ŞEY yazmaz.
    - uygula=true: telafi satırı id=f"kodm_{oid}_onarim" ON CONFLICT DO NOTHING (idempotent,
      iki kez çağrılsa da tek telafi) + audit izi + kart planları yeniden senkron.
    Append-only: mevcut hiçbir kayıt silinmez/değiştirilmez, yalnız eksik ödeme satırı eklenir.
    """
    with db() as (conn, cur):
        rapor = _mutabakat(cur)
        onarilacak = [v for v in rapor["vakalar"] if v["tip"] == "K1_EKSIK_KART_ODEME"]
        if not uygula:
            return {"uygula": False, "onizleme": True, "onarilacak": onarilacak,
                    "toplam": rapor["toplam_eksik_kart_odeme"]}

        bugun = str(dt_now_tr().date())
        yazilan = []
        for v in onarilacak:
            oid = v["plan_id"]
            hid = f"kodm_{oid}_onarim"
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, taksit_sayisi, aciklama, kaynak_id, kaynak_tablo)
                VALUES (%s, %s, %s, 'ODEME', %s, 1, %s, %s, 'odeme_plani')
                ON CONFLICT (id) DO NOTHING
            """, (hid, v["kart_id"], bugun, v["eksik_kart_odeme"],
                  f"K1 telafi: geçmiş kısmi ödemelerin kart defterine eksik yazılan kısmı "
                  f"({v['aciklama'] or ''})", oid))
            if cur.rowcount > 0:
                audit(cur, "kart_hareketleri", hid, "K1_TELAFI_ODEME",
                      eski={"kasa": v["kasa_kismi_toplam"], "kart": v["kart_kodm_toplam"]},
                      yeni={"telafi": v["eksik_kart_odeme"]})
                yazilan.append({"plan_id": oid, "tutar": v["eksik_kart_odeme"]})
        if yazilan:
            kart_plan_guncelle_tx(cur)  # kesim planları yeni borçla senkron
        return {"uygula": True, "yazilan": yazilan,
                "toplam_telafi": round(sum(y["tutar"] for y in yazilan), 2)}
