"""Ödeme planı — salt okuma uçları (GET).

Mutasyon uçları (POST /ode, /ertele, /kismi-ode, DELETE vb.) main.py içinde kalır;
ortak iş mantığı (odeme_yap vb.) ile sıkı bağlı oldukları için aşamalı taşınır.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

router = APIRouter(tags=["odeme-plani"])

# 🚫 KANIT SAYILMAYAN KELİMELER (2026-08-09 canlı ders)
# İlk taramada "kanıt" olarak PERSONEL · DÖNEMİ · GIDA gibi kelimeler kabul
# edildi ve TALHA TUYGUN'un maaşı MERVE KARABACAK'ın ödemesiyle, AKALIN'ın
# 684 ₺'lik faturası "GÖZDE KUNDURA GIDA" ile eşleşti. Kimlik kanıtı MARKA/
# KİŞİ ADI ya da FATURA NUMARASI olmalı; herkeste geçen kelime kanıt değildir.
# (Aynı ders fatura eşleştirmede de alınmıştı: şehir adı gürültüsü.)
_JENERIK = {
    # işlem/belge sözlüğü
    "FATURA", "VADELI", "VADELİ", "ALIM", "ODEME", "ÖDEME", "ODEMESI",
    "PERSONEL", "MAAS", "MAAŞ", "DONEMI", "DÖNEMİ", "DONEM", "GIDER",
    "ANLIK", "SABIT", "KREDI", "KREDİ", "TAKSIT", "TAKSİT", "BORC", "BORÇ",
    "EKSTRE", "KART", "NAKIT", "HAVALE", "TUTAR", "TOPLAM", "KISMI",
    # sektör/jenerik ticaret
    "GIDA", "GİDA", "TICARET", "TİCARET", "SANAYI", "SANAYİ", "LIMITED",
    "SIRKETI", "ŞİRKETİ", "ANONIM", "ANONİM", "HIZMET", "HİZMET", "GRUP",
    "MARKET", "MAGAZA", "MAĞAZA", "SUBE", "ŞUBE", "MERKEZ",
    # aylar
    "OCAK", "SUBAT", "ŞUBAT", "MART", "NISAN", "NİSAN", "MAYIS", "HAZIRAN",
    "HAZİRAN", "TEMMUZ", "AGUSTOS", "AĞUSTOS", "EYLUL", "EYLÜL", "EKIM",
    "EKİM", "KASIM", "ARALIK",
    # şehir/coğrafya
    "KONYA", "ISTANBUL", "İSTANBUL", "ANKARA", "IZMIR", "İZMİR", "KARAMAN",
    "ALSANCAK", "ZAFER", "KOYCEGIZ", "KÖYCEĞİZ", "GAZZE", "TEMA",
}


@router.get("/api/odeme-plani/cari-uyumsuzluk")
def odeme_plani_cari_uyumsuzluk():
    """⚖️ CARİ AÇIK ≠ ÖDEME PLANI — "ödedim ama kuyrukta duruyor".

    Sahip (2026-08-09): "FEZ'e yapılmış ödeme var, fazla tutar olsa da;
    kapanmış, kalan borcun vadesi diğer aya gitmesi lazımdı."

    Canlı vaka: FEZ cari açığı 51.428,59 ₺ ama ödeme planında 86.576,59 ₺
    duruyor (3.939 + 35.148 + 47.490). Aradaki 35.148 ₺ fazlalığın sebebi:
    70.000 ₺'lik ödeme CARİ HESABA yapıldı ("Cari borç ödemesi — FEZ"), plan
    kalemleriyle eşleştirilmedi. Cari doğru, kuyruk şişkin.

    Doğru davranış FIFO: ödeme en eski kalemden başlayarak kapatır; yetmediği
    kalem KISMİ kalır ve kalanı ileri vadeye taşınır.

    ⚠️ ÖNERİ-ONLY: bu uç hiçbir plan kapatmaz. Hangi kalemin kapanması
    gerektiğini FIFO ile HESAPLAR ve sahibin önüne koyar.
    """
    import re as _re2
    # Takma ad haritası (ESHİM = 'hüseyin makina' gibi). Hata-yutar: harita
    # okunamazsa eşleştirme kısa ad + resmî ünvanlarla sürer.
    try:
        from fatura_api import tedarikci_eslestirme_haritasi as _teh
        _harita = _teh() or {}
    except Exception:  # noqa: BLE001
        _harita = {}
    with db() as (conn, cur):
        # Plan tarafı: bekleyen kalemler, tedarikçiye göre
        cur.execute("""
            SELECT p.id, p.tarih::text AS vade, COALESCE(p.aciklama,'') AS aciklama,
                   COALESCE(p.odenecek_tutar,0)::float AS tutar,
                   COALESCE(p.odenen_tutar,0)::float AS odenen,
                   p.kaynak_tablo, p.kaynak_id,
                   COALESCE(v.tedarikci,'') AS ted
              FROM odeme_plani p
              LEFT JOIN vadeli_alimlar v
                     ON p.kaynak_tablo='vadeli_alimlar' AND v.id::text = p.kaynak_id::text
             -- ⚠️ YALNIZ TEDARİKÇİ ALIMI (2026-08-09 canlı ders): ilk sürüm
             -- tüm bekleyen planları tarıyordu ve "fethi" tedarikçisi, kart
             -- sahibi "Fethi Karabacak" ile eşleşip 177.906 ₺'lik kredi
             -- taksiti + kart ekstresini cari borç sanıyordu. Kredi/kart/maaş
             -- kalemleri cari hesaba AİT DEĞİLDİR; yalnız vadeli alım sayılır.
             WHERE p.durum='bekliyor'
               AND COALESCE(p.kaynak_tablo,'') = 'vadeli_alimlar'
             ORDER BY p.tarih
        """)
        planlar = [dict(r) for r in (cur.fetchall() or [])]
    # Cari açıkları fatura_api'den al (tek gerçek kaynak — yeniden hesaplamıyoruz)
    try:
        from fatura_api import cari_ozet as _cari_ozet
        _oz = _cari_ozet()
        cariler = _oz.get("tedarikciler") or _oz.get("ozet") or []
    except Exception as e:  # noqa: BLE001
        return {"hata": f"cari özet okunamadı: {str(e)[:120]}", "satirlar": []}

    def _norm(s):
        s = (s or "").translate(str.maketrans("çğıöşüÇĞİıÖŞÜ", "cgiosuCGIIOSU"))
        return s.upper().strip()

    sonuc = []
    for c in cariler:
        ad = c.get("tedarikci") or ""
        acik = round(float(c.get("hesaplanan_acik") or 0), 2)
        adn = _norm(ad)
        if not adn:
            continue
        # Bu tedarikçiye ait bekleyen plan kalemleri.
        # (1) vadeli_alimlar.tedarikci ALANI — kanonik bağ, her zaman geçerli
        # (2) açıklamada KELİME SINIRIYLA geçmesi
        # ⚠️ Önce "ad ≥5 harf" şartı koymuştum; 'FEZ' (3 harf) elendi ve
        # kuyruğu 86.577 yerine 47.490 gösterdi. Kısa adı elemek yerine
        # KELİME SINIRI kullanılır: 'FEZ' eşleşir, 'FEZA'nın içinde eşleşmez.
        #
        # 🔗 KANONİK ÜNVANLAR (2026-08-10): cari kaydın adı kısa ad ("ATALAY
        # KAHVE") ama faturalar resmî ünvanla gelir ("MEHMET ATALAY",
        # "Napolés"). Yalnız kısa adı aramak ATALAY'ın 54.186,50 ₺'lik
        # kalemini kaçırdı ve 54.187 ₺'lik SAHTE bir eksik üretti. cari_ozet
        # zaten `resmi_adlar` listesini veriyor — hepsi denenir.
        _adaylar = {adn}
        for _ra in (c.get("resmi_adlar") or []):
            _n2 = _norm(_ra)
            if len(_n2) >= 3:
                _adaylar.add(_n2)
        # 🔗 TAKMA ADLAR (2026-08-10, ESHİM vakası): eşleştirme tablosunda aynı
        # tedarikçiye bağlanmış BAŞKA yazımlar da var ('hüseyin makina' = ESHİM).
        # `resmi_adlar` yalnız faturada geçen ünvanları taşır; söz/vadeli alım
        # kayıtları takma adla girilmiş olabilir. Onları görmezsek kuyruk EKSİK
        # ölçülür — ESHİM'de 40.800 ₺'lik kalem kaçtı, sahibe yanlış soru sordum
        # ve fazladan kalem eklenmesine yol açtı (geri alındı).
        for _resmi, _bilgi in (_harita or {}).items():
            if _norm((_bilgi or {}).get("kisa") or "") == adn:
                _n3 = _norm(_resmi)
                if len(_n3) >= 3:
                    _adaylar.add(_n3)
        _kaliplar = [_re2.compile(r"(?<![A-Z0-9])" + _re2.escape(a) + r"(?![A-Z0-9])")
                     for a in _adaylar]
        kendi = [p for p in planlar
                 if _norm(p["ted"]) in _adaylar
                 or any(k.search(_norm(p["aciklama"])) for k in _kaliplar)]
        if not kendi:
            continue
        plan_top = round(sum(float(p["tutar"] or 0) - float(p["odenen"] or 0)
                             for p in kendi), 2)
        fark = round(plan_top - acik, 2)
        if abs(fark) < 1:
            continue
        # FIFO: cari açık kadarı ayakta kalmalı; fazlası en ESKİ kalemlerden kapanır
        kalan_acik = acik
        oneri = []
        for p in sorted(kendi, key=lambda x: str(x["vade"])):
            p_kalan = round(float(p["tutar"] or 0) - float(p["odenen"] or 0), 2)
            if kalan_acik <= 0.01:
                oneri.append({**{k: p[k] for k in ("id", "vade", "aciklama")},
                              "kalan": p_kalan, "karar": "KAPANMALI",
                              "neden": "cari açık bu kalemden önce tükendi"})
            elif p_kalan <= kalan_acik + 0.01:
                kalan_acik = round(kalan_acik - p_kalan, 2)
                oneri.append({**{k: p[k] for k in ("id", "vade", "aciklama")},
                              "kalan": p_kalan, "karar": "durur"})
            else:
                oneri.append({**{k: p[k] for k in ("id", "vade", "aciklama")},
                              "kalan": p_kalan, "karar": "KISMİ",
                              "kalmasi_gereken": kalan_acik,
                              "kapanmasi_gereken": round(p_kalan - kalan_acik, 2),
                              "neden": "cari açığın kalanı bu kalemin bir kısmını karşılıyor"})
                kalan_acik = 0.0
        sonuc.append({
            "tedarikci": ad, "cari_acik": acik, "plan_toplam": plan_top,
            "fark": fark,
            "yon": "plan FAZLA — ödenmiş ama kuyrukta duruyor" if fark > 0
                   else "plan EKSİK — cari borç var ama kuyrukta yok",
            "kalem_adet": len(kendi), "oneri": oneri,
        })
    sonuc.sort(key=lambda x: -abs(x["fark"]))
    return {
        "uyumsuz_tedarikci": len(sonuc),
        "toplam_fark": round(sum(x["fark"] for x in sonuc), 2),
        "satirlar": sonuc,
        "not": "ÖNERİ-ONLY: hiçbir plan kapatılmadı. 'plan FAZLA' = ödeme cari "
               "hesaba yapılmış ama kuyruk kalemi kapanmamış; FIFO ile hangi "
               "kalemin kapanması, hangisinin kısmi kalması gerektiği hesaplandı. "
               "Cari hesap ESAS, kuyruk YORUMDUR.",
    }


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
                   p.kaynak_tablo, p.kaynak_id, p.kart_id::text AS kart_id,
                   (CURRENT_DATE - p.tarih) AS gun_gecikme
              FROM odeme_plani p
             WHERE p.durum = 'bekliyor' AND p.tarih < CURRENT_DATE
             ORDER BY p.tarih
        """)
        kalemler = [dict(r) for r in (cur.fetchall() or [])]
        # ── ADAY İZ HAVUZU ────────────────────────────────────────────────
        # 🔴 (2026-08-14) KART BORCU ÖDEMELERİ HAVUZDA YOKTU: kart kanalında
        # yalnız islem_turu='HARCAMA' okunuyordu. Ama bir KART EKSTRESİ planını
        # kapatan para hareketi harcama değil ÖDEME'dir (kart borcunun kapatılması).
        # Canlı vaka: Ziraat 268.443 ₺ ekstre planı 'bekliyor' dururken kartta
        # 20 Tem 182.275 + 28 Tem 86.168 ODEME kaydı vardı — dedektif havuzunda
        # bu satırlar hiç bulunmadığı için "iz yok" diyordu. kart_id de alınır:
        # kart planlarında EN GÜÇLÜ kanıt metin değil, aynı kart olmasıdır.
        # kaynak_tablo/kaynak_id de alınır: bir hareket ZATEN bir ödeme planına
        # bağlıysa, o para başka planın izi olamaz (A1 — bağlı-iz elemesi).
        cur.execute("""
            SELECT 'kasa' AS kanal, tarih::text AS tarih,
                   ABS(COALESCE(tutar,0))::float AS tutar,
                   COALESCE(aciklama,'') AS metin,
                   NULL::text AS kart_id,
                   COALESCE(kaynak_tablo,'') AS kaynak_tablo,
                   COALESCE(kaynak_id,'')    AS kaynak_id
              FROM kasa_hareketleri
             WHERE tutar < 0 AND COALESCE(durum,'aktif')='aktif'
            UNION ALL
            SELECT 'kart', tarih::text, ABS(COALESCE(tutar,0))::float,
                   COALESCE(aciklama,''), NULL::text,
                   COALESCE(kaynak_tablo,''), COALESCE(kaynak_id,'')
              FROM kart_hareketleri
             WHERE islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
            UNION ALL
            SELECT 'kart-odeme', tarih::text, ABS(COALESCE(tutar,0))::float,
                   COALESCE(aciklama,''), kart_id::text,
                   COALESCE(kaynak_tablo,''), COALESCE(kaynak_id,'')
              FROM kart_hareketleri
             WHERE islem_turu='ODEME' AND COALESCE(durum,'aktif')='aktif'
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
            if len(kelime) >= 5:
                cikti.add(kelime)
        return {k for k in cikti if k not in _JENERIK}

    from datetime import date as _d

    # İz başına tarih ve sadeleştirilmiş metni BİR KEZ hesapla (eskiden her
    # kalem × her iz için yeniden yapılıyordu). Tarihi bozuk satır havuzdan düşer.
    havuz = []
    for iz in izler:
        try:
            iz_t = _d.fromisoformat(str(iz["tarih"])[:10])
        except Exception:  # noqa: BLE001
            continue
        havuz.append({**iz, "_d": iz_t, "_sade": _sadele(iz["metin"])})

    def _iz_anahtar(z):
        """İzin kimliği — rezervasyon defterinin anahtarı."""
        return (z["kanal"], z["tarih"], float(z["tutar"] or 0), z["kart_id"])

    def _bagli_durum(z, plan_id):
        """🔴 A1 — BAĞLI-İZ ELEMESİ (2026-08-14, canlıda kapatma son anda durduruldu)

        Vaka: MERVE KARABACAK Temmuz-2026 maaşı (32.000, bekliyor) için dedektif
        28 Tem kasa çıkışını "güçlü iz" gösterdi. Ama o çıkış HAZİRAN maaşının
        KENDİ ödemesiydi (kaynak_tablo='odeme_plani', kaynak_id=Haziran planı).
        Maaş/kira gibi SABİT TUTARLI TEKRARLAYAN ödemelerde tutar + isim + tarih
        penceresi üçlüsü her ay birbirini tutar → dedektif her ay sahte iz üretir.

        Bir para bir borcu kapatır: hareket zaten bir plana bağlıysa
          · başka planın id'si → bu iz O PLANIN parası, aday olamaz ('yabanci')
          · taranan planın id'si → tersine, en kesin kanıt ('kendi')
        """
        if str(z.get("kaynak_tablo") or "") != "odeme_plani":
            return "serbest"
        kid = str(z.get("kaynak_id") or "")
        if not kid:
            return "serbest"
        return "kendi" if kid == str(plan_id) else "yabanci"

    # ── A2: DÖNEM ÇELİŞKİSİ ────────────────────────────────────────────────
    # Bağ kurulmamış (kaynak_id'siz) tekrarlayan ödemelerde ikinci emniyet:
    # "Temmuz 2026" planı "Haziran 2026" izini kanıt sayamaz.
    # ⚠️ _sadele() Türkçe harfleri düzleyip BÜYÜTÜR → desenler ASCII büyük harf.
    _AY_NO = {"OCAK": 1, "SUBAT": 2, "MART": 3, "NISAN": 4, "MAYIS": 5,
              "HAZIRAN": 6, "TEMMUZ": 7, "AGUSTOS": 8, "EYLUL": 9,
              "EKIM": 10, "KASIM": 11, "ARALIK": 12}
    _AY_RE = _re.compile(r"\b(" + "|".join(_AY_NO) + r")\b")
    _YM_RE = _re.compile(r"\b(20\d{2})-(0[1-9]|1[0-2])\b")
    _YIL_RE = _re.compile(r"\b(20\d{2})\b")

    def _donem(sade):
        """Metinden dönem etiketi: {'yil','ay','etiket'} — bulunamazsa None."""
        m = _YM_RE.search(sade)
        if m:
            return {"yil": int(m.group(1)), "ay": int(m.group(2)),
                    "etiket": f"{m.group(1)}-{m.group(2)}"}
        ma = _AY_RE.search(sade)
        if ma:
            my = _YIL_RE.search(sade)
            yil = int(my.group(1)) if my else None
            return {"yil": yil, "ay": _AY_NO[ma.group(1)],
                    "etiket": f"{ma.group(1)}{' ' + str(yil) if yil else ''}"}
        return None

    def _donem_catisir(d_iz, d_plan):
        """İki dönem etiketi çelişiyor mu? Biri yoksa hüküm verilmez (False)."""
        if not d_iz or not d_plan:
            return False
        if d_iz["ay"] != d_plan["ay"]:
            return True
        return bool(d_iz["yil"] and d_plan["yil"] and d_iz["yil"] != d_plan["yil"])

    # 🔒 REZERVASYON DEFTERİ: çok-parçalı eşleşmede KULLANILMIŞ izler.
    # Aynı iz grubu (ör. Ziraat'e yapılan iki ödeme) birden çok gecikmiş kaleme
    # birden "bunlar seni kapatıyor" diyebiliyordu → sahip aynı parayı birkaç
    # kalemde görüp hepsini kapatmaya kalkarsa borç sahte biçimde erir.
    # Bir para bir kez harcanır: kesin eşleşmede parçalar rezerve edilir.
    # ⚠️ TEK-İZ adayları rezerve EDİLMEZ — onlar "aday"dır, kesin hüküm değil;
    # sahip hangisinin doğru olduğuna bakar (mevcut davranış korunur).
    rezerve = set()

    def _cok_parcali_ara(kalan, vade, plan_kart, anah, plan_id, plan_donem):
        """Tek iz oturmadıysa: PARÇA TOPLAMI kalanı karşılıyor mu?

        Canlı vaka (Ziraat 268.443 ₺): ekstre tek kalem ama ödeme iki taksitte
        yapılmış (182.275 + 86.168). Tek-iz eşleşmesi bunu göremez.

        İki grup denenir: (a) aynı karta yapılmış kart-ödeme izleri — kart
        planlarında en güvenilir bağ, (b) aynı güçlü metin-kanıtını taşıyan izler.
        Grup tarihe sıralanır, PREFIX (ardışık) toplamı alınır.

        ⚠️ Kombinatorik alt-küme ARANMAZ: n izde 2^n kombinasyon denemek hem
        pahalı hem de YANLIŞ POZİTİF üretir (alakasız üç kalemin toplamı tesadüfen
        tutabilir ve sahibe "ödenmiş" der). Ardışıklık şartı bu riski keser;
        canlı vaka zaten prefix ile oturuyor. En fazla 5 parça.

        Rezerve edilmiş (başka kaleme sayılmış) izler bu aramaya girmez.
        Başka plana BAĞLI izler ve DÖNEMİ ÇELİŞEN izler de havuza alınmaz —
        yoksa parça toplamı "güçlü" çıkıp yeşil kovaya ve kapat düğmesine düşer.
        Tek istisna: kaynak bağı BU planı gösteren iz (kaynak bağı metin ay adını ezer).
        """
        tol = max(2.0, kalan * oran_tol)
        # Kalemler vade sırasına göre işleniyor → en eski gecikmiş kalem izi
        # önce kapar. Bu kasıtlı: en uzun süredir açık duran kalem önceliklidir.
        serbest = []
        for z in havuz:
            if _iz_anahtar(z) in rezerve:
                continue
            _bagli = _bagli_durum(z, plan_id)
            if _bagli == "yabanci":
                continue
            # kaynak bağı metin ay adını ezer
            if _bagli != "kendi" and _donem_catisir(_donem(z["_sade"]), plan_donem):
                continue
            serbest.append(z)
        gruplar = []
        if plan_kart:
            gruplar.append(("ayni_kart", [
                z for z in serbest
                if z["kanal"] == "kart-odeme" and z["kart_id"]
                and str(z["kart_id"]) == str(plan_kart)
            ]))
        if anah:
            gruplar.append(("ayni_kanit", [
                z for z in serbest
                if any(a in z["_sade"] for a in anah)
            ]))
        for grup_ad, grup in gruplar:
            pencere = sorted(
                (z for z in grup if -15 <= (z["_d"] - vade).days <= gun_tol),
                key=lambda z: z["_d"],
            )
            toplam, parcalar = 0.0, []
            for z in pencere[:5]:
                toplam = round(toplam + float(z["tutar"] or 0), 2)
                parcalar.append(z)
                # Tek parça zaten tek-iz eşleşmesidir — burada 2+ aranır.
                if len(parcalar) >= 2 and abs(toplam - kalan) <= tol:
                    # Kesin eşleşme: bu izler artık başka kaleme sayılmaz.
                    for _z in parcalar:
                        rezerve.add(_iz_anahtar(_z))
                    return {
                        "cok_parcali": True,
                        "dayanak": grup_ad,
                        "kanal": parcalar[0]["kanal"],
                        "toplam": toplam,
                        "fark": round(toplam - kalan, 2),
                        "parcalar": [{
                            "tarih": z["tarih"], "tutar": float(z["tutar"] or 0),
                            "metin": (z["metin"] or "")[:70],
                        } for z in parcalar],
                        "kanit": (["AYNI_KART"] if grup_ad == "ayni_kart"
                                  else sorted({a for a in anah
                                               for z in parcalar if a in z["_sade"]})),
                        "guclu": True,
                    }
        return None

    sonuc, izli, izsiz, parcali_adet, elenen_bagli = [], 0, 0, 0, 0
    for k in kalemler:
        kalan = round(float(k["tutar"] or 0) - float(k["odenen"] or 0), 2)
        if kalan <= 0.01:
            continue
        anah = _anahtarlar(k["aciklama"] or "")
        plan_kart = k.get("kart_id")
        plan_donem = _donem(_sadele(k["aciklama"] or ""))
        try:
            vade = _d.fromisoformat(str(k["vade"])[:10])
        except Exception:  # noqa: BLE001
            continue
        adaylar = []
        for iz in havuz:
            t = float(iz["tutar"] or 0)
            if not t or abs(t - kalan) > max(2.0, kalan * oran_tol):
                continue
            fark = (iz["_d"] - vade).days
            if fark < -15 or fark > gun_tol:
                continue
            # A1: tutar+tarih tutmuş olsa bile, para BAŞKA planın parasıysa
            # bu bir iz değil — listeye hiç girmez (yanlış pozitifin kökü).
            bagli = _bagli_durum(iz, k["id"])
            if bagli == "yabanci":
                elenen_bagli += 1
                continue
            kanit = sorted([a for a in anah if a and a in iz["_sade"]])
            # 🔑 KANIT HİYERARŞİSİ (güçlüden zayıfa):
            #   PLANA_BAGLI (kaynak_id bu planı gösteriyor)  → kimliğin ta kendisi
            #   AYNI_KART   (kart planında aynı kart)        → kimlik bağı
            #   metin       (tedarikçi adı / fatura no)      → serbest metin
            if plan_kart and iz["kart_id"] and str(iz["kart_id"]) == str(plan_kart):
                kanit = ["AYNI_KART"] + kanit
            if bagli == "kendi":
                kanit = ["PLANA_BAGLI"] + kanit
            # A2: dönem çelişkisi — "Temmuz 2026" planı "Haziran 2026" izini
            # kanıt sayamaz. Aday SİLİNMEZ (bilgi kalsın) ama GÜÇLÜ olamaz:
            # yeşil kovaya ve "planı kapat" düğmesine düşmesin.
            # MUAFİYET: kaynak bağı metin ay adını ezer — kaynak_id bu planı
            # gösteriyorsa kimlik kesindir, açıklamadaki ay adı onu düşüremez.
            iz_donem = _donem(iz["_sade"])
            catisma = (bagli != "kendi") and _donem_catisir(iz_donem, plan_donem)
            if catisma:
                kanit = [f"DONEM_CELISKISI:{iz_donem['etiket']}≠{plan_donem['etiket']}"] + kanit
            adaylar.append({
                "kanal": iz["kanal"], "tarih": iz["tarih"], "tutar": t,
                "metin": (iz["metin"] or "")[:70], "gun_farki": fark,
                "kanit": kanit,
                # Ad/fatura-no/kart eşleşmesi yoksa bu YALNIZ tutar tesadüfüdür.
                # Dönem çelişkisi varsa hiçbir kanıt onu güçlü yapmaz.
                "guclu": bool(kanit) and not catisma,
            })
        adaylar.sort(key=lambda x: (not x["guclu"], abs(x["gun_farki"])))
        guclu = [a for a in adaylar if a["guclu"]]
        # Tek iz oturmadıysa parça toplamını dene (kısmi/taksitli ödeme).
        parcali = (None if guclu
                   else _cok_parcali_ara(kalan, vade, plan_kart, anah, k["id"], plan_donem))
        if parcali:
            parcali_adet += 1
        if guclu or parcali:
            izli += 1
        else:
            izsiz += 1
        sonuc.append({
            "plan_id": k["id"], "vade": k["vade"], "gun_gecikme": k["gun_gecikme"],
            "aciklama": (k["aciklama"] or "")[:80], "kalan": kalan,
            "guclu_iz_adet": len(guclu),
            "zayif_iz_adet": len(adaylar) - len(guclu),
            "adaylar": ([parcali] if parcali else []) + adaylar[:4],
            "hal": ("iz_bulundu" if guclu
                    else "cok_parcali_iz" if parcali
                    else "yalniz_tutar_eslesmesi" if adaylar else "iz_yok"),
        })
    # Sıra: tek güçlü iz → çok parçalı iz → gerisi; her kovada büyük para önce.
    _SIRA = {"iz_bulundu": 0, "cok_parcali_iz": 1}
    sonuc.sort(key=lambda x: (_SIRA.get(x["hal"], 2), -x["kalan"]))
    _IZLI = {"iz_bulundu", "cok_parcali_iz"}
    kesildi = max(0, len(sonuc) - 60)
    return {
        "gecikmis_kalem": len(sonuc),
        "iz_bulunan": izli, "iz_bulunamayan": izsiz,
        "cok_parcali_bulunan": parcali_adet,
        # Şeffaflık: tutar+tarih tutmuş ama BAŞKA planın parası olduğu için
        # elenen iz sayısı. Yüksekse dedektif eskiden o kadar sahte iz üretiyordu.
        "elenen_bagli_iz": elenen_bagli,
        "iz_bulunan_tutar": round(
            sum(x["kalan"] for x in sonuc if x["hal"] in _IZLI), 2),
        "iz_yok_tutar": round(
            sum(x["kalan"] for x in sonuc if x["hal"] not in _IZLI), 2),
        "satirlar": sonuc[:60],
        # Kesme notu: liste sessizce kırpılmasın (özet sayılar TAM evreni sayar,
        # satırlar ilk 60 — ikisi tutmayınca "eksik veri mi?" şüphesi doğuyordu).
        "kesilen_satir": kesildi,
        "not": "ÖNERİ-ONLY: hiçbir plan kendiliğinden kapatılmadı. "
               "'iz_bulundu' = tutar VE tedarikçi/fatura-no/aynı-kart eşleşti "
               "(güçlü kanıt). 'cok_parcali_iz' = tek hareket değil ama ardışık "
               "parçaların TOPLAMI kalanı karşılıyor (taksitli/bölünmüş ödeme). "
               "'yalniz_tutar_eslesmesi' = sadece rakam tuttu, ad tutmadı — "
               "tesadüf olabilir, sahip bakmalı. Kapatma yalnız sahip onayıyla, "
               "/iz-ile-kapat ucundan yapılır. "
               "Zaten BAŞKA bir ödeme planına bağlı hareketler (o planın kendi "
               "ödemesi) aday sayılmaz; dönemi çelişen izler (Temmuz planına "
               "Haziran ödemesi) güçlü kanıt sayılmaz — sabit tutarlı tekrarlayan "
               "ödemelerde (maaş/kira) sahte iz bu iki filtreyle kesilir.",
    }


class IzIleKapatIstek(BaseModel):
    """İz mutabakatıyla plan kapatma — sahip gerekçesi ZORUNLU."""
    aciklama: str
    iz_ozet: str = ""
    # Paranın GERÇEKTE çıktığı gün (izin tarihi). Gönderilmezse bugün yazılır;
    # o zaman "ödendi" der ama tarihi yanlış olur — FE izin tarihini gönderir.
    iz_tarih: str | None = None


@router.post("/api/odeme-plani/{pid}/iz-ile-kapat")
def odeme_plani_iz_ile_kapat(pid: str, istek: IzIleKapatIstek):
    """✅ SAHİP ONAYLI KAPATMA — "iz doğru, planı kapat" kapısı.

    Dedektif (gecikmis-iz-tarama) yalnız ÖNERİR; kapatma insan tıklamasıyla
    buradan olur. Sistem hiçbir planı kendiliğinden kapatmaz.

    ⚠️ KASA HAREKETİ ÜRETİLMEZ — kasıtlı. Bu uç "para çıktı" demiyor, "para
    ZATEN çıkmıştı, plan satırı açık kalmış" diyor. İzin kendisi (kasa çıkışı ya
    da kart ödemesi) defterde duruyor; bir de kasa kaydı yazmak parayı İKİ KEZ
    düşürür ve kasa bakiyesini bozar. Kapanan tek şey plan satırıdır.

    Karar izi: açıklamanın BAŞINA '[İZ-MUTABAKAT] ...' damgası eklenir, eski
    metin korunur (ezilmez) — sonradan "bu neden kapandı?" sorusu cevaplanabilsin.

    🔀 ROL AYRIMI — /api/odeme-plani/{oid}/cari-odemesiyle-kapat ile karıştırma:
      · cari-odemesiyle-kapat → para TEDARİKÇİ CARİ HESABINA ödenmiş, kuyruk
        kalemiyle bağı yok; dayanak cari ekstredir.
      · iz-ile-kapat (bu uç)  → para KASADAN ya da KARTTAN çıkmış, dedektif
        hareketi bulmuş; dayanak kasa/kart hareket izidir.
    İkisi de kasa hareketi üretmez ama gerekçeleri ve damgaları ayrıdır; hangi
    kanıtla kapandığı defterde okunabilsin diye ayrı uçlar olarak durur.
    """
    gerekce = (istek.aciklama or "").strip()
    if not gerekce:
        raise HTTPException(400, "Kapatma gerekçesi zorunlu — hangi ize dayanarak kapatıldığı yazılmalı.")
    from datetime import date as _d
    odeme_gunu = None
    if istek.iz_tarih:
        try:
            odeme_gunu = _d.fromisoformat(str(istek.iz_tarih)[:10])
        except Exception:  # noqa: BLE001
            odeme_gunu = None
    with db() as (conn, cur):
        # FOR UPDATE: satırı kilitle — kardeş uç (cari-odemesiyle-kapat) de aynı
        # deseni kullanıyor; iki kapatma yarışırsa ikincisi kilidi bekler.
        cur.execute(
            "SELECT id, durum, COALESCE(aciklama,'') AS aciklama,"
            "       COALESCE(odenecek_tutar,0)::float AS odenecek"
            "  FROM odeme_plani WHERE id=%s FOR UPDATE", (pid,))
        plan = cur.fetchone()
        if not plan:
            raise HTTPException(404, "Ödeme planı bulunamadı.")
        # Tek kapı: satır kilitli olduğu için durum burada kesindir. İkinci sekme
        # kilidi bekler, sırası gelince durumu 'odendi' görür ve buradan döner —
        # UPDATE'te ikinci bir durum süzgeci (ve erişilemez 409 dalı) gereksizdi.
        if plan["durum"] != "bekliyor":
            raise HTTPException(
                400, f"Plan zaten kapalı/iptal (durum: {plan['durum']}) — yalnız bekleyen plan kapatılabilir.")
        damga = f"[İZ-MUTABAKAT] {gerekce}"
        if (istek.iz_ozet or "").strip():
            damga += f" · iz: {istek.iz_ozet.strip()}"
        # Damga ASLA kırpılmaz (karar izi eksiksiz kalmalı); yer sıkışırsa MEVCUT
        # metin kırpılır ve '…' ile kırpıldığı görünür. Eskiden toplam sağdan
        # kesiliyordu → uzun açıklamada damganın kuyruğu sessizce uçabiliyordu,
        # üstelik docstring "ezilmez" diyordu. 600 mutlak tavan (gerekçe çok
        # uzunsa damganın kendisi de bir yerde durmalı).
        eski = plan["aciklama"] or ""
        yer = 500 - len(damga)
        if yer <= 0:
            yeni_aciklama = damga[:600]
        else:
            kirpik = eski if len(eski) <= yer else f"{eski[:max(0, yer - 1)]}…"
            yeni_aciklama = f"{damga} | {kirpik}".strip(" |")[:600]
        cur.execute(
            """UPDATE odeme_plani
                  SET durum='odendi',
                      odenen_tutar=odenecek_tutar,
                      odeme_tarihi=COALESCE(%s, CURRENT_DATE),
                      odeme_yontemi='iz_mutabakat',
                      aciklama=%s
                WHERE id=%s""",
            (odeme_gunu, yeni_aciklama, pid))
        conn.commit()
    return {
        "ok": True, "plan_id": pid,
        "kapatilan_tutar": plan["odenecek"],
        "odeme_tarihi": str(odeme_gunu) if odeme_gunu else None,
        "not": "Plan kapatıldı. Kasa hareketi ÜRETİLMEDİ — para zaten çıkmıştı, "
               "mükerrer düşüş olmaması için yalnız plan satırı kapandı.",
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
              -- ⭐ 4. KONTROL — EKSTREDEN ÖDENMİŞ Mİ? (sahip, 2026-08-10:
              -- "ekstre yüklendiğinde buradan faturaları yakalayıp ayına göre
              -- ödendi olarak mı tanımlıyor?")
              -- Yukarıdaki üç kontrol kasa izini, fatura_giderleri kaynaklı kart
              -- hareketini ve ödeme planını arıyordu. Ama otomatik talimatlı
              -- fatura ekstreden `kaynak_tablo='ekstre_import'` olarak iniyor —
              -- hiçbiri onu görmüyordu. Sonuç: fatura karttan ödenmiş olmasına
              -- rağmen "tutar girilmedi" hatırlatması ay boyunca duruyordu.
              -- Kimlik = gider adındaki ABONE NUMARASI ("GAZZE ELEKTRİK (01638544)").
              -- Numara yoksa bu kontrol devreye girmez (eski davranış korunur).
              AND NOT EXISTS (
                  SELECT 1 FROM kart_hareketleri kx
                  WHERE kx.islem_turu = 'HARCAMA'
                    AND COALESCE(kx.durum,'aktif') = 'aktif'
                    AND DATE_TRUNC('month', kx.tarih) = DATE_TRUNC('month', CURRENT_DATE)
                    AND substring(sg.gider_adi from '([0-9]{5,})') IS NOT NULL
                    -- Rakam sınırı: kısa numara uzun numaranın içinde eşleşmesin
                    -- (Codex denetimi 2026-08-10) — yanlış "ödendi" üretirdi.
                    AND COALESCE(kx.aciklama,'') ~
                        ('(^|[^0-9])' || substring(sg.gider_adi from '([0-9]{5,})') || '([^0-9]|$)'))
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
                # ⚠️ GECİKMİŞ DEĞİL (2026-08-10, sahip: "gecikmiş borçta Ağustos'un
                # bütün borçları da gözüküyor galiba"). Bu satırların TUTARI YOK
                # ve VADESİ YOK — henüz borç değiller, fatura bekleniyor. Eskiden
                # `gecikmis: gun_g > 0` diyordu; tutarları 0 olduğu için toplamı
                # bozmuyordu ama gecikmiş KALEM SAYISINI şişiriyordu (31 görünüyor,
                # gerçekte 28). "Vadesi geçti" demek için önce bir vade gerekir.
                "gecikmis": False,
                # Bilgi kaybolmasın: ödeme günü geçmişse ayrı bayrakla söylenir —
                # ekran isterse "fatura gecikti" uyarısı verebilir.
                "odeme_gunu_gecti": gun_g > 0,
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
