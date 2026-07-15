"""Ödeme planı — salt okuma uçları (GET).

Mutasyon uçları (POST /ode, /ertele, /kismi-ode, DELETE vb.) main.py içinde kalır;
ortak iş mantığı (odeme_yap vb.) ile sıkı bağlı oldukları için aşamalı taşınır.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from database import db

router = APIRouter(tags=["odeme-plani"])


@router.get("/api/odeme-plani/{oid}/kaynak")
def odeme_plani_kaynak(oid: str):
    """Panel'in vadeli alım kart önerisi için kaynak_tablo ve kaynak_id döner."""
    with db() as (conn, cur):
        cur.execute("SELECT kaynak_tablo, kaynak_id FROM odeme_plani WHERE id=%s", (oid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404)
        return {"kaynak_tablo": row["kaynak_tablo"], "kaynak_id": row["kaynak_id"]}


@router.get("/api/odeme-plani/bugun")
def odeme_plani_bugun(gun: int = 0, personel: int = 1):
    """Cep + 💸 ÖDEME MERKEZİ — bugün ödenmesi gereken + gecikmiş (+ istenirse
    YAKLAŞAN: ?gun=7) bekleyen ödemeler. TÜM kaynaklar; sadece durum='bekliyor'.
    ?personel=0: maaş planları hariç (hub v1 — maaş kendi ekranından, guard'lı).
    SALT-OKUR — hub'ın tek beslemesi; ödemeler mevcut tek-yazıcı uçlara delege."""
    gun = max(0, min(int(gun or 0), 60))
    KAYNAK_AD = {
        "kartlar": "Kredi Kartı", "borc_envanteri": "Borç Taksiti",
        "sabit_giderler": "Sabit Gider", "vadeli_alimlar": "Vadeli Alım",
        "personel": "Personel Ödemesi",
    }
    with db() as (conn, cur):
        cur.execute(
            """SELECT op.id, op.tarih, op.odenecek_tutar, op.asgari_tutar,
                      op.aciklama, op.kaynak_tablo, op.kaynak_id, k.banka, k.kart_adi,
                      (CURRENT_DATE - op.tarih) AS gun_gecikme
               FROM odeme_plani op
               LEFT JOIN kartlar k ON k.id = op.kart_id
               WHERE op.durum = 'bekliyor'
                 AND op.tarih <= CURRENT_DATE + %s
               ORDER BY op.tarih ASC""", (gun,)
        )
        rows = [dict(r) for r in cur.fetchall()]
    out = []
    for r in rows:
        if not personel and (r.get("kaynak_tablo") or "") == "personel":
            continue
        if r.get("kart_adi"):
            baslik = f"{(r.get('banka') or '').strip()} {r['kart_adi']}".strip()
            tip = "Kredi Kartı"
        else:
            baslik = r.get("aciklama") or KAYNAK_AD.get(r.get("kaynak_tablo") or "", "Ödeme")
            tip = KAYNAK_AD.get(r.get("kaynak_tablo") or "", "Ödeme")
        gun_g = int(r.get("gun_gecikme") or 0)
        out.append({
            "id": r["id"],
            "baslik": baslik,
            "tip": tip,
            "kaynak_tablo": r.get("kaynak_tablo"),
            "tutar": float(r["odenecek_tutar"]) if r["odenecek_tutar"] is not None else 0.0,
            "asgari": float(r["asgari_tutar"]) if r.get("asgari_tutar") is not None else None,
            "tarih": str(r["tarih"]),
            "gecikmis": gun_g > 0,
            "gun_gecikme": gun_g,
        })

    # 🧾 TUTARI GİRİLMEMİŞ değişken faturalar (planı YOK, o yüzden yukarıda çıkmaz) —
    # cep de görsün ki unutulmasın (kullanıcı 2026-07-04: "girmeyi unutmayacak sistem").
    with db() as (conn, cur):
        cur.execute("""
            SELECT sg.id, sg.gider_adi, sg.odeme_gunu, sg.tutar,
                   (EXTRACT(DAY FROM CURRENT_DATE)::int - COALESCE(sg.odeme_gunu, 1)) AS gun_gecikme
            FROM sabit_giderler sg
            WHERE sg.aktif = TRUE AND sg.tip = 'degisken'
              AND COALESCE(sg.odeme_gunu, 1) <= EXTRACT(DAY FROM CURRENT_DATE) + %s
              AND NOT EXISTS (
                  SELECT 1 FROM kasa_hareketleri kh
                  WHERE kh.kaynak_id = sg.id AND kh.kaynak_tablo = 'sabit_giderler'
                    AND kh.islem_turu = 'FATURA_ODEMESI' AND kh.kasa_etkisi = TRUE AND kh.durum = 'aktif'
                    AND DATE_TRUNC('month', kh.tarih) = DATE_TRUNC('month', CURRENT_DATE))
              AND NOT EXISTS (
                  SELECT 1 FROM kart_hareketleri kt
                  WHERE kt.kaynak_id = sg.id AND kt.kaynak_tablo = 'fatura_giderleri'
                    AND kt.islem_turu = 'HARCAMA' AND kt.durum = 'aktif'
                    AND DATE_TRUNC('month', kt.tarih) = DATE_TRUNC('month', CURRENT_DATE))
              AND NOT EXISTS (
                  SELECT 1 FROM odeme_plani op2
                  WHERE op2.kaynak_tablo = 'sabit_giderler' AND op2.kaynak_id = sg.id
                    AND op2.durum != 'iptal'
                    AND op2.referans_ay = DATE_TRUNC('month', CURRENT_DATE))
            ORDER BY gun_gecikme DESC
        """, (gun,))
        for g in (cur.fetchall() or []):
            gun = int(g.get("gun_gecikme") or 0)
            tahmini = float(g["tutar"] or 0)
            tah_ek = f" (≈{tahmini:,.0f} ₺ tahmini)" if tahmini > 0 else ""
            gun_g = int(g.get("gun_gecikme") or 0)
            out.append({
                "id": f"fatura_{g['id']}",  # sadece görüntü anahtarı (plan değil)
                "sabit_gider_id": str(g["id"]),  # hub: fatura-ode / vadeye-yaz delege anahtarı
                "baslik": f"🧾 {g['gider_adi']} — fatura tutarı girilmedi{tah_ek}",
                "tip": "Fatura (tutar bekleniyor)",
                "kaynak_tablo": "sabit_giderler",
                # tutar 0: tahmini rakam "bugün ödenecek toplam"a KARIŞMAZ (kasa izi=tek gerçek)
                "tutar": 0.0,
                "tahmini_tutar": tahmini,
                "asgari": None,
                "tarih": None,
                "gecikmis": gun_g > 0,
                "gun_gecikme": gun_g,
                "tutar_girilmedi": True,
            })
    return out


@router.get("/api/odeme-plani")
def odeme_plani_listele():
    with db() as (conn, cur):
        cur.execute(
            """SELECT op.*, k.banka, k.kart_adi, k.faiz_orani FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.tarih >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY op.tarih ASC"""
        )
        return [dict(r) for r in cur.fetchall()]
