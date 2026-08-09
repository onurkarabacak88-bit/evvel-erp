"""Ödeme planı — salt okuma uçları (GET).

Mutasyon uçları (POST /ode, /ertele, /kismi-ode, DELETE vb.) main.py içinde kalır;
ortak iş mantığı (odeme_yap vb.) ile sıkı bağlı oldukları için aşamalı taşınır.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from database import db

router = APIRouter(tags=["odeme-plani"])


@router.get("/api/odeme-plani/gecikmis-iz-tarama")
def odeme_plani_gecikmis_iz_tarama(gun_tol: int = 45, oran_tol: float = 0.02):
    """🔍 GECİKMİŞ ÖDEMELERİN İZİ VAR MI? — "ödedim ama sistem görmüyor" ihtimali.

    Sahip (2026-08-09): "bu sistemde ödeme izleri var mı? ki bence olmalı!!!"
    Panelde 28 kalem / 952.313 ₺ gecikmiş görünüyor, en eskisi iki aylık.
    Bir kısmı GERÇEKTEN ödenmiş olabilir — para kasadan/karttan çıkmış ama
    plan satırı 'bekliyor' kalmıştır. O zaman gecikme sahtedir.

    Bu uç her gecikmiş kalem için kasa ve kart hareketlerinde iz arar:
      · tutar   → ±%2 (kısmi/yuvarlama payı)
      · tarih   → vadeden 15 gün ÖNCE ile gun_tol gün SONRA arası
      · metin   → tedarikçi adı ya da fatura numarası geçiyor mu (KANIT)

    ⚠️ ÖNERİ-ONLY: hiçbir plan KAPATILMAZ. Bulunan iz "aday"dır; sahip
    bakar, doğruysa ödemeyi kaydeder. Bu sistemde otomatik kapatma yok —
    yanlış eşleşme parayı yok eder, geri alması zordur.
    """
    import re as _re
    with db() as (conn, cur):
        cur.execute("""
            SELECT p.id, p.tarih::text AS vade, p.aciklama,
                   COALESCE(p.odenecek_tutar,0)::float AS tutar,
                   COALESCE(p.odenen_tutar,0)::float AS odenen,
                   p.kaynak_tablo, p.kaynak_id,
                   (CURRENT_DATE - p.tarih) AS gun_gecikme
              FROM odeme_plani p
             WHERE p.durum = 'bekliyor' AND p.tarih < CURRENT_DATE
             ORDER BY p.tarih
        """)
        kalemler = [dict(r) for r in (cur.fetchall() or [])]
        # Aday iz havuzu: kasa çıkışları + kart harcamaları (tek sorgu)
        cur.execute("""
            SELECT 'kasa' AS kanal, tarih::text AS tarih,
                   ABS(COALESCE(tutar,0))::float AS tutar,
                   COALESCE(aciklama,'') AS metin
              FROM kasa_hareketleri
             WHERE tutar < 0 AND COALESCE(durum,'aktif')='aktif'
            UNION ALL
            SELECT 'kart', tarih::text, ABS(COALESCE(tutar,0))::float,
                   COALESCE(aciklama,'')
              FROM kart_hareketleri
             WHERE islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
        """)
        izler = [dict(r) for r in (cur.fetchall() or [])]

    def _sadele(s: str) -> str:
        s = (s or "").translate(str.maketrans("çğıöşüÇĞİıÖŞÜ", "cgiosuCGIIOSU"))
        return s.upper()

    def _anahtarlar(aciklama: str):
        """Plan açıklamasından KANIT anahtarları: fatura no + tedarikçi adı."""
        a = _sadele(aciklama)
        cikti = set()
        # 'Fatura FEZ2026000001455 (FEZ ...)' → fatura no ve parantez içi
        for m in _re.findall(r"\b([A-Z0-9]{6,})\b", a):
            if any(ch.isdigit() for ch in m):
                cikti.add(m)
        m2 = _re.search(r"\(([^)]{3,})\)", a)
        if m2:
            for kelime in m2.group(1).split():
                if len(kelime) >= 4:
                    cikti.add(kelime)
        # 'Vadeli Alım: makine mühendisi' gibi serbest metinler
        for kelime in a.replace(":", " ").split():
            if len(kelime) >= 5 and not kelime.startswith("VADELI"):
                cikti.add(kelime)
        return {k for k in cikti if k not in ("FATURA", "VADELI", "ALIM", "ODEME")}

    from datetime import date as _d
    sonuc, izli, izsiz = [], 0, 0
    for k in kalemler:
        kalan = round(float(k["tutar"] or 0) - float(k["odenen"] or 0), 2)
        if kalan <= 0.01:
            continue
        anah = _anahtarlar(k["aciklama"] or "")
        try:
            vade = _d.fromisoformat(str(k["vade"])[:10])
        except Exception:  # noqa: BLE001
            continue
        adaylar = []
        for iz in izler:
            t = float(iz["tutar"] or 0)
            if not t or abs(t - kalan) > max(2.0, kalan * oran_tol):
                continue
            try:
                it = _d.fromisoformat(str(iz["tarih"])[:10])
            except Exception:  # noqa: BLE001
                continue
            fark = (it - vade).days
            if fark < -15 or fark > gun_tol:
                continue
            metin = _sadele(iz["metin"])
            kanit = sorted([a for a in anah if a and a in metin])
            adaylar.append({
                "kanal": iz["kanal"], "tarih": iz["tarih"], "tutar": t,
                "metin": iz["metin"][:70], "gun_farki": fark,
                "kanit": kanit,
                # Ad/fatura-no eşleşmesi yoksa bu YALNIZ tutar tesadüfüdür
                "guclu": bool(kanit),
            })
        adaylar.sort(key=lambda x: (not x["guclu"], abs(x["gun_farki"])))
        guclu = [a for a in adaylar if a["guclu"]]
        if guclu:
            izli += 1
        else:
            izsiz += 1
        sonuc.append({
            "plan_id": k["id"], "vade": k["vade"], "gun_gecikme": k["gun_gecikme"],
            "aciklama": (k["aciklama"] or "")[:80], "kalan": kalan,
            "guclu_iz_adet": len(guclu),
            "zayif_iz_adet": len(adaylar) - len(guclu),
            "adaylar": adaylar[:4],
            "hal": ("iz_bulundu" if guclu
                    else "yalniz_tutar_eslesmesi" if adaylar else "iz_yok"),
        })
    sonuc.sort(key=lambda x: (x["hal"] != "iz_bulundu", -x["kalan"]))
    return {
        "gecikmis_kalem": len(sonuc),
        "iz_bulunan": izli, "iz_bulunamayan": izsiz,
        "iz_bulunan_tutar": round(
            sum(x["kalan"] for x in sonuc if x["hal"] == "iz_bulundu"), 2),
        "iz_yok_tutar": round(
            sum(x["kalan"] for x in sonuc if x["hal"] != "iz_bulundu"), 2),
        "satirlar": sonuc[:60],
        "not": "ÖNERİ-ONLY: hiçbir plan kapatılmadı. 'iz_bulundu' = tutar VE "
               "tedarikçi/fatura-no eşleşti (güçlü kanıt). "
               "'yalniz_tutar_eslesmesi' = sadece rakam tuttu, ad tutmadı — "
               "tesadüf olabilir, sahip bakmalı.",
    }


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
                      COALESCE(op.odenen_tutar,0)::float AS odenen_tutar,
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
    # 🔗 kanonik eşleştirme haritası (bir kez çekilir; hata-yutar)
    try:
        from fatura_api import tedarikci_eslestirme_haritasi, tedarikci_sinif as _sinif
        _harita = tedarikci_eslestirme_haritasi()
    except Exception:  # noqa: BLE001
        _harita, _sinif = {}, (lambda a: "mal")
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
            # kaynak_id SQL'de zaten seçiliyordu ama yanıta konmuyordu; v2 Ödeme
            # Merkezi vadeli alım kaydını düzeltmek/silmek için buna ihtiyaç duyuyor.
            # Salt-okur ek alan — mevcut tüketicileri etkilemez.
            "kaynak_id": (str(r["kaynak_id"]) if r.get("kaynak_id") is not None else None),
            # 💰 KISMİ ÖDEME (2026-08-08): "tutar" artık KALAN borçtur, tam tutar
            # değil. Sahip borcun bir kısmını ödeyince satır 'bekliyor' kalır ve
            # burada kalanı görmelidir — yoksa ödediği para ekranda hiç görünmez.
            "tutar": round(float(r["odenecek_tutar"] or 0) - float(r.get("odenen_tutar") or 0), 2),
            "tam_tutar": float(r["odenecek_tutar"]) if r["odenecek_tutar"] is not None else 0.0,
            "odenen": float(r.get("odenen_tutar") or 0),
            "kismi_odenmis": float(r.get("odenen_tutar") or 0) > 0.01,
            "asgari": float(r["asgari_tutar"]) if r.get("asgari_tutar") is not None else None,
            "tarih": str(r["tarih"]),
            "gecikmis": gun_g > 0,
            "gun_gecikme": gun_g,
        }
        # 🏷 vadeli satıra tedarikçi + sınıf: kanonik eşleştirme (kisa ad) önce,
        # kelime heuristiği yedek (ÖM: hizmet/gecici satırlar Tedarikçi'ye düşmez)
        if r.get("vadeli_tedarikci"):
            ad = r["vadeli_tedarikci"]
            e = _harita.get((ad or "").strip().upper()) or {}
            satir["tedarikci"] = e.get("kisa") or ad
            satir["tedarikci_sinif"] = e.get("sinif") or _sinif(ad)
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


# ── 🗂 TÜR GRUPLARI — "maaştan kredi kartına hepsi tek alanda" (sahip 2026-08-08).
# Ödeme kuyruğundaki her satır tam olarak BİR gruba düşer; gruplar toplamı
# kuyruk toplamına eşittir (kayıp kalem olmaz).
GRUP_AD = {
    "personel": ("👤 Maaş & Personel", "maas"),
    "vadeli_alimlar": ("🚚 Tedarikçi", "tedarikci"),
    "sabit_giderler": ("🏠 Sabit Gider", "sabit"),
    "borc_envanteri": ("🏦 Kredi Taksiti", "kredi"),
    "kartlar": ("💳 Kredi Kartı", "kart"),
}


def _grup_coz(kaynak_tablo, kart_id):
    """Satırın grubu: kaynak tablosu → grup; kaynağı yoksa kartlıysa kart."""
    kt = (kaynak_tablo or "").strip()
    if kt in GRUP_AD:
        return GRUP_AD[kt]
    if kart_id:
        return GRUP_AD["kartlar"]
    return ("📄 Diğer", "diger")


@router.get("/api/odeme-plani/kokpit")
def odeme_plani_kokpit(personel: int = 1):
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
        # 💰 KALAN borç = ödenecek − ödenen (kısmi ödeme desteği, 2026-08-08).
        # Eskiden odenecek_tutar okunuyordu; kısmi ödenmiş satır tam tutarıyla
        # sayılıp nakit projeksiyonunu olduğundan kötü gösteriyordu.
        cur.execute(
            """SELECT tarih,
                      GREATEST(0, COALESCE(odenecek_tutar,0) - COALESCE(odenen_tutar,0))::float
                          AS tutar,
                      COALESCE(odenen_tutar,0)::float AS odenen,
                      kaynak_tablo, kart_id
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
    # ── 🗂 TEK ALANDA KIRILIM: maaştan kredi kartına her tür, tek tabloda.
    # Gruplar toplamı cikis_30'a eşittir — hiçbir kalem kaybolmaz.
    gruplar: dict = {}
    for r in rows:
        ad, kod = _grup_coz(r.get("kaynak_tablo"), r.get("kart_id"))
        g = gruplar.setdefault(kod, {"kod": kod, "ad": ad, "adet": 0, "tutar": 0.0,
                                     "gecikmis_adet": 0, "gecikmis_tutar": 0.0,
                                     "kismi_odenmis": 0})
        g["adet"] += 1
        g["tutar"] = round(g["tutar"] + r["tutar"], 2)
        if float(r.get("odenen") or 0) > 0.01:
            g["kismi_odenmis"] += 1
        if r["tarih"] < bugun:
            g["gecikmis_adet"] += 1
            g["gecikmis_tutar"] = round(g["gecikmis_tutar"] + r["tutar"], 2)
    grup_listesi = sorted(gruplar.values(), key=lambda x: -x["tutar"])
    for g in grup_listesi:
        g["pay_yuzde"] = (round(g["tutar"] / cikis_30 * 100, 1) if cikis_30 > 0 else 0.0)

    return {
        "kasa": round(kasa, 2),
        "gecikmis_toplam": gecikmis_t,
        "gecikmis_adet": len(gecikmis),
        "cikis_7": cikis_7,
        "cikis_30": cikis_30,
        "gruplar": grup_listesi,
        "maas_dahil": bool(personel),
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
