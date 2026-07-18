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
                      va.tedarikci AS vadeli_tedarikci,
                      (CURRENT_DATE - op.tarih) AS gun_gecikme
               FROM odeme_plani op
               LEFT JOIN kartlar k ON k.id = op.kart_id
               LEFT JOIN vadeli_alimlar va
                      ON op.kaynak_tablo = 'vadeli_alimlar' AND va.id = op.kaynak_id
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
        satir = {
            "id": r["id"],
            "baslik": baslik,
            "tip": tip,
            "kaynak_tablo": r.get("kaynak_tablo"),
            "tutar": float(r["odenecek_tutar"]) if r["odenecek_tutar"] is not None else 0.0,
            "asgari": float(r["asgari_tutar"]) if r.get("asgari_tutar") is not None else None,
            "tarih": str(r["tarih"]),
            "gecikmis": gun_g > 0,
            "gun_gecikme": gun_g,
        }
        # 🏷 vadeli satıra tedarikçi + mal/hizmet sınıfı (ÖM: elektrik gibi
        # hizmet faturaları Tedarikçi sekmesine DEĞİL Giderler'e düşer)
        if r.get("vadeli_tedarikci"):
            satir["tedarikci"] = r["vadeli_tedarikci"]
            try:
                from fatura_api import tedarikci_sinif
                satir["tedarikci_sinif"] = tedarikci_sinif(r["vadeli_tedarikci"])
            except Exception:  # noqa: BLE001
                satir["tedarikci_sinif"] = "mal"
        out.append(satir)

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


@router.get("/api/odeme-plani/kokpit")
def odeme_plani_kokpit(personel: int = 0):
    """💸 NAKİT KOKPİTİ (2026-07-19, sahip 'adam akıllı ele alalım'; Codex çaprazlı).
    SALT-OKUR karar bağlamı: kasa bakiyesi + gecikmiş + 7/30 gün zorunlu çıkış +
    gün gün 'en düşük beklenen bakiye' (≈ projected floor — ciro tahminli, kesinlik
    iddiası YOK; UI ≈ ile gösterir). ABEK motoru kurulunca zenginleşir, onu beklemez.
    ?personel=0: maaş planları hariç (hub v1 ile aynı kapsam — maaş sonra)."""
    from finans_core import kasa_bakiyesi, gunluk_ciro_ortalama
    from tr_saat import bugun_tr
    from datetime import timedelta
    bugun = bugun_tr()
    with db() as (conn, cur):
        kasa = float(kasa_bakiyesi(cur) or 0)
        cur.execute(
            """SELECT tarih, COALESCE(odenecek_tutar,0)::float AS tutar, kaynak_tablo
               FROM odeme_plani
               WHERE durum = 'bekliyor' AND tarih <= %s""",
            (bugun + timedelta(days=30),))
        rows = [dict(r) for r in cur.fetchall() or []]
        ciro = gunluk_ciro_ortalama(cur)
    if not personel:
        rows = [r for r in rows if (r.get("kaynak_tablo") or "") != "personel"]
    gecikmis = [r for r in rows if r["tarih"] < bugun]
    gecikmis_t = round(sum(r["tutar"] for r in gecikmis), 2)
    gun_cikis: dict = {}
    for r in rows:
        d = max(0, (r["tarih"] - bugun).days)  # gecikmiş = bugün ödenmeli varsayımı
        gun_cikis[d] = gun_cikis.get(d, 0.0) + r["tutar"]
    cikis_7 = round(sum(t for d, t in gun_cikis.items() if d <= 7), 2)
    cikis_30 = round(sum(t for d, t in gun_cikis.items() if d <= 30), 2)
    # ── Projected floor: bakiye(d) = kasa + ciro_tahmini(1..d) − çıkışlar(0..d).
    # Gün 0 ciro eklemez (bugünün cirosu belirsiz) — bilinçli temkin.
    tahmin = float(ciro.get("tahmin") or 0)
    katsayi = ciro.get("gunluk_katsayi") or {}
    bakiye, en_dusuk, en_dusuk_gun, seri = kasa, kasa, bugun, []
    for d in range(0, 31):
        t = bugun + timedelta(days=d)
        if d > 0:
            bakiye += tahmin * float(katsayi.get(str(t.isoweekday()), 1.0) or 1.0)
        bakiye -= gun_cikis.get(d, 0.0)
        seri.append({"tarih": str(t), "bakiye": round(bakiye, 2)})
        if bakiye < en_dusuk:
            en_dusuk, en_dusuk_gun = bakiye, t
    return {
        "kasa": round(kasa, 2),
        "gecikmis_toplam": gecikmis_t,
        "gecikmis_adet": len(gecikmis),
        "cikis_7": cikis_7,
        "cikis_30": cikis_30,
        "ciro_gunluk_tahmin": round(tahmin, 2),
        "en_dusuk_bakiye": round(en_dusuk, 2),
        "en_dusuk_tarih": str(en_dusuk_gun),
        "projeksiyon": seri,
        "not": ("≈ tahmindir: ciro son 7/30 gün ağırlıklı ortalama + gün-tipi katsayısı; "
                "çıkışlar yalnız bekleyen ödeme planı (maaş hariç). Kesinlik iddiası yok."),
    }


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
