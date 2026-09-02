"""
🚑 CİRO KURTARMA — `ciro` tablosunu `ciro_taslak`tan yeniden inşa eder.

NEDEN VAR (2026-09-02):
  `/api/sistem-sifirla` ucu, PIN'i olmayan bir kapıyla `TRUNCATE TABLE ciro
  CASCADE` çalıştırdı ve canlı ciro tablosu boşaldı. Kaskad yayılmadı:
  `ciro`'ya yabancı anahtarla bağlı tablo yok, dolayısıyla `ciro_taslak` ve
  `kasa_hareketleri` sağlam kaldı.

NİYE KURTARILABİLİYOR:
  Onaylanan her taslak, ürettiği ciro satırının kimliğini `ciro_taslak.ciro_id`
  alanında saklıyordu. Yani silinen satırların ORİJİNAL ID'leri elimizde —
  ciroları eski kimlikleriyle geri yazınca `kasa_hareketleri.kaynak_id`
  bağları kendiliğinden yerine oturur, kırık bağ kalmaz.

⛔ KASAYA DOKUNMAZ — EN ÖNEMLİ KURAL:
  `kasa_hareketleri`'ndeki CIRO satırları SİLİNMEDİ. Kurtarma sırasında kasa
  hareketi de üretilirse ciro kasaya İKİNCİ KEZ girer ve kasa şişer. Bu modül
  YALNIZ `ciro` tablosuna yazar; `insert_kasa_hareketi` hiç çağrılmaz.

🧪 KURU ÇALIŞTIRMA ZORUNLU:
  `uygula=true` yalnız daha önce aynı parametrelerle kuru çalıştırma yapılmış
  ve LİSTE OKUNMUŞSA anlamlıdır. Uç her iki modda da satır satır listeyi döner;
  para değiştiren toplu işlem, listesi okunmadan çalıştırılmaz.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

router = APIRouter(prefix="/api/ciro-kurtarma", tags=["ciro-kurtarma"])


class KurtarmaBody(BaseModel):
    uygula: bool = False
    onay: Optional[str] = None          # uygula=true için 'EVET_KURTAR'
    onay_pin: Optional[str] = None      # işletme PIN'i (Merve Karabacak)


def _plan_uret(cur) -> Dict[str, Any]:
    """Ne yazılacağını hesaplar — HİÇBİR ŞEY YAZMAZ."""
    cur.execute(
        """
        SELECT t.id AS taslak_id, t.ciro_id, t.sube_id, t.tarih::text AS tarih,
               t.nakit, t.pos, t.online, t.aciklama, t.onay_zamani,
               COALESCE(s.ad, t.sube_id) AS sube_adi
        FROM ciro_taslak t
        LEFT JOIN subeler s ON s.id = t.sube_id
        WHERE t.durum = 'onaylandi' AND COALESCE(t.ciro_id, '') <> ''
        ORDER BY t.tarih, t.sube_id, t.onay_zamani
        """
    )
    taslaklar = [dict(r) for r in (cur.fetchall() or [])]

    # Halihazırda duran ciro satırları — üzerine YAZILMAZ (idempotent kurtarma).
    cur.execute("SELECT id FROM ciro")
    mevcut = {str(r["id"]) for r in (cur.fetchall() or [])}

    # ⚠️ AYNI GÜN + AYNI ŞUBE için birden çok onaylı taslak olabilir (düzeltme
    # sonrası ikinci onay). İkisini de yazmak o günü İKİYE KATLAR. Kural:
    # onay_zamani EN YENİ olan kazanır; elenen satır gizlenmez, RAPORLANIR.
    en_iyi: Dict[tuple, dict] = {}
    elenen: List[dict] = []
    for t in taslaklar:
        anahtar = (t["tarih"], str(t["sube_id"]))
        onceki = en_iyi.get(anahtar)
        if onceki is None:
            en_iyi[anahtar] = t
            continue
        yeni_daha_taze = (t.get("onay_zamani") or "") > (onceki.get("onay_zamani") or "")
        if yeni_daha_taze:
            elenen.append({**onceki, "eleme_nedeni": "daha eski onay"})
            en_iyi[anahtar] = t
        else:
            elenen.append({**t, "eleme_nedeni": "daha eski onay"})

    yazilacak, zaten_var = [], []
    for t in en_iyi.values():
        (zaten_var if str(t["ciro_id"]) in mevcut else yazilacak).append(t)

    def _f(x) -> float:
        return float(x or 0)

    satirlar = [
        {
            "ciro_id": str(t["ciro_id"]),
            "tarih": t["tarih"],
            "sube_id": str(t["sube_id"]),
            "sube_adi": t["sube_adi"],
            "nakit": round(_f(t["nakit"]), 2),
            "pos": round(_f(t["pos"]), 2),
            "online": round(_f(t["online"]), 2),
            "toplam": round(_f(t["nakit"]) + _f(t["pos"]) + _f(t["online"]), 2),
            "aciklama": t.get("aciklama") or "",
            "kaynak": "taslak",
            "taslak_id": str(t["taslak_id"]),
        }
        for t in sorted(yazilacak, key=lambda x: (x["tarih"], str(x["sube_id"])))
    ]

    # ═══ İKİNCİ KAYNAK: RAPOR CACHE ═════════════════════════════════════════
    # Bazı cirolar şube panelinden geçmedi — doğrudan girildi ya da Evo'dan
    # aktarıldı (GECMIS_CIRO_EVO). Taslakları yok, dolayısıyla birinci kaynak
    # onları göremiyor. Ama `rapor_gunluk_sube_ozet` gece batch'inde her gün
    # için nakit/pos/online KIRILIMINI saklıyor — kaybolan tek şey ciro
    # satırıydı, kırılım başka bir defterde duruyordu.
    #
    # ⚠️ Ciro TASLAKTAN geçmiş her kimlik burada DIŞLANIR: birinci kaynak o
    # kayıtlar için zaten karar verdi (mükerrer eleme dahil). İptal edilmiş bir
    # ciroyu ikinci kaynaktan geri diriltmek, elenen mükerreri geri getirirdi.
    cur.execute("SELECT COALESCE(ciro_id,'') AS cid FROM ciro_taslak")
    taslak_kimlikleri = {str(r["cid"]) for r in (cur.fetchall() or []) if r["cid"]}

    cur.execute(
        """
        SELECT kh.kaynak_id::text AS ciro_id, kh.tarih::text AS tarih,
               kh.sube_id::text AS sube_id, kh.tutar::float AS net,
               kh.aciklama,
               COALESCE(s.ad, kh.sube_id) AS sube_adi,
               COALESCE(s.pos_oran, 0)::float AS pos_oran,
               COALESCE(s.online_oran, 0)::float AS online_oran,
               g.ciro_nakit::float  AS c_nakit,
               g.ciro_pos::float    AS c_pos,
               g.ciro_online::float AS c_online
        FROM kasa_hareketleri kh
        LEFT JOIN subeler s ON s.id = kh.sube_id
        LEFT JOIN rapor_gunluk_sube_ozet g
               ON g.sube_id = kh.sube_id AND g.tarih = kh.tarih
        WHERE kh.kaynak_tablo = 'ciro'
          AND COALESCE(kh.durum, 'aktif') = 'aktif'
          AND kh.tutar > 0
        """
    )
    ikinci, kurtarilamayan = [], []
    for r in (cur.fetchall() or []):
        d = dict(r)
        cid = str(d.get("ciro_id") or "")
        if not cid or cid in mevcut or cid in taslak_kimlikleri:
            continue
        n, p, o = _f(d.get("c_nakit")), _f(d.get("c_pos")), _f(d.get("c_online"))
        if (n + p + o) <= 0:
            kurtarilamayan.append({
                "ciro_id": cid, "tarih": d.get("tarih"), "sube_adi": d.get("sube_adi"),
                "net": round(_f(d.get("net")), 2),
                "aciklama": (d.get("aciklama") or "")[:80],
                "neden": "rapor cache'inde de kırılım yok",
            })
            continue
        # DOĞRULAMA: kırılımdan hesaplanan net, kasadaki net ile tutuyor mu?
        # Tutmuyorsa satır yine sunulur ama "doğrulanamadı" diye İŞARETLENİR —
        # sessizce doğru saymak, kurtarmayı sahte yeşile çevirirdi.
        hesap_net = n + p * (1 - _f(d.get("pos_oran")) / 100.0) \
                      + o * (1 - _f(d.get("online_oran")) / 100.0)
        fark = round(hesap_net - _f(d.get("net")), 2)
        ikinci.append({
            "ciro_id": cid,
            "tarih": d.get("tarih"),
            "sube_id": str(d.get("sube_id") or ""),
            "sube_adi": d.get("sube_adi"),
            "nakit": round(n, 2), "pos": round(p, 2), "online": round(o, 2),
            "toplam": round(n + p + o, 2),
            "aciklama": (d.get("aciklama") or "Kurtarma: rapor cache kırılımı"),
            "kaynak": "rapor_cache",
            "dogrulama_farki": fark,
            "dogrulandi": abs(fark) <= 1.0,
        })

    satirlar.extend(sorted(ikinci, key=lambda x: (x["tarih"], str(x["sube_id"]))))
    satirlar.sort(key=lambda x: (x["tarih"], str(x["sube_id"])))

    # Kasa tarafı: bağ tutacak mı? Kurtarma sonrası kırık kalan var mı?
    cur.execute(
        """
        SELECT COUNT(*) AS adet, COALESCE(SUM(tutar), 0)::float AS net
        FROM kasa_hareketleri
        WHERE kaynak_tablo = 'ciro' AND COALESCE(durum, 'aktif') = 'aktif'
        """
    )
    kasa = dict(cur.fetchone() or {})
    hedef = {s["ciro_id"] for s in satirlar} | mevcut
    cur.execute(
        """
        SELECT COUNT(*) AS adet FROM kasa_hareketleri
        WHERE kaynak_tablo = 'ciro' AND COALESCE(durum, 'aktif') = 'aktif'
          AND NOT (kaynak_id = ANY(%s))
        """,
        (list(hedef) or [""],),
    )
    yetim = int((cur.fetchone() or {}).get("adet") or 0)

    return {
        "satirlar": satirlar,
        "yazilacak_adet": len(satirlar),
        "kaynak_dagilimi": {
            "taslak": sum(1 for x in satirlar if x.get("kaynak") == "taslak"),
            "rapor_cache": len(ikinci),
            "rapor_cache_dogrulanamayan": sum(1 for x in ikinci if not x.get("dogrulandi")),
        },
        # Hâlâ kurtarılamayanlar GİZLENMEZ: elle girilecek olan tam olarak bunlar.
        "kurtarilamayan": kurtarilamayan,
        "zaten_duran_adet": len(zaten_var),
        "elenen_mukerrer": [
            {
                "tarih": e["tarih"], "sube_adi": e["sube_adi"],
                "ciro_id": str(e["ciro_id"]), "neden": e["eleme_nedeni"],
                "toplam": round(_f(e["nakit"]) + _f(e["pos"]) + _f(e["online"]), 2),
            }
            for e in elenen
        ],
        "toplamlar": {
            "nakit": round(sum(s["nakit"] for s in satirlar), 2),
            "pos": round(sum(s["pos"] for s in satirlar), 2),
            "online": round(sum(s["online"] for s in satirlar), 2),
            "brut": round(sum(s["toplam"] for s in satirlar), 2),
        },
        "kasa_ciro_satiri": {
            "adet": int(kasa.get("adet") or 0),
            "net_toplam": round(float(kasa.get("net") or 0), 2),
            "not": "Bu satırlara DOKUNULMAZ — kurtarma kasaya yazmaz.",
        },
        "kurtarma_sonrasi_yetim_kasa_satiri": yetim,
    }


@router.post("")
def ciro_kurtar(body: KurtarmaBody) -> Dict[str, Any]:
    """Kuru çalıştırma (varsayılan) veya uygulama. Kasaya asla yazmaz."""
    with db() as (conn, cur):
        plan = _plan_uret(cur)

        if not body.uygula:
            plan["kuru"] = True
            plan["mesaj"] = (
                f"KURU ÇALIŞTIRMA — hiçbir şey yazılmadı. "
                f"{plan['yazilacak_adet']} ciro satırı geri yazılacak "
                f"({plan['toplamlar']['brut']:,.2f} ₺ brüt)."
            )
            return plan

        if (body.onay or "").strip() != "EVET_KURTAR":
            raise HTTPException(400, "Onay gerekli: onay='EVET_KURTAR'")

        from operasyon_merkez_api import _isletme_onay_dogrula
        onayci = _isletme_onay_dogrula(cur, body.onay_pin)  # PIN hatalı → 403

        yazilan = 0
        for s in plan["satirlar"]:
            # ⚠️ ON CONFLICT DO NOTHING: uç iki kez çağrılsa da satır çoğalmaz.
            # `toplam` GENERATED kolon — yazılmaz, veritabanı üretir.
            cur.execute(
                """
                INSERT INTO ciro (id, tarih, sube_id, nakit, pos, online, aciklama, durum)
                VALUES (%s, %s::date, %s, %s, %s, %s, %s, 'aktif')
                ON CONFLICT (id) DO NOTHING
                """,
                (s["ciro_id"], s["tarih"], s["sube_id"], s["nakit"], s["pos"],
                 s["online"], s["aciklama"] or "Kurtarma: taslaktan geri yazıldı"),
            )
            yazilan += cur.rowcount or 0

        from kasa_service import audit
        audit(cur, "ciro", "KURTARMA", "CIRO_KURTARMA",
              yeni={"yazilan": yazilan, "planlanan": plan["yazilacak_adet"],
                    "brut": plan["toplamlar"]["brut"],
                    "onaylayan": onayci.get("ad_soyad"),
                    "onaylayan_id": str(onayci.get("id"))})

        plan["kuru"] = False
        plan["yazilan_adet"] = yazilan
        plan["onaylayan"] = onayci.get("ad_soyad")
        plan["mesaj"] = f"{yazilan} ciro satırı geri yazıldı. Kasaya dokunulmadı."
        return plan
