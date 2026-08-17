"""
sube_ici_borc_api.py — ŞUBELER ARASI BORÇ (izole modül)
================================================================================
🔴 SAHİP TALEBİ (2026-08-17): "para yetişmediği zaman şubeler birbirine borç
veriyor, bunu da sistemde görmeli ve takip etmeliyim."

NEDEN AYRI BİR KAVRAM
─────────────────────
Sistem bu para akışını HİÇ BİLMİYORDU — tıpkı kasa teslimlerinin 2026-08-17
öncesinde defterde izsiz olması gibi (144 teslim / 848.714 ₺ görünmüyordu).
Şube A'nın parası yetmeyince B'den alıyor; para fiziksel olarak yer değiştiriyor
ama defterde hiçbir iz kalmıyor. Sonuç: her iki şubenin de kasası yanlış, ve
"kim kimi finanse ediyor" sorusu cevapsız.

MODEL — İKİ KATMAN (bu ayrım kritik)
────────────────────────────────────
1) PARA HAREKETİ (kasa defteri) — çift kayıt, TOPLAM KASA DEĞİŞMEZ:
       SUBE_BORC_VER   veren şubeden   −tutar
       SUBE_BORC_AL    alan şubeye     +tutar
   Bu, kasa teslimiyle aynı desendir (KASA_TESLIM_CIKIS/GIRIS). Fark: teslim
   şube→merkez tek yönlüdür ve kapanmaz; şube borcu şube→şube'dir ve KAPANIR.

2) BORÇ KAYDI (bu tablo) — para hareketinden AYRI yaşar:
   Para hemen yer değiştirir ama borç AÇIK kalır; geri ödenince kapanır.
   PARA HAREKETİ ≠ BORCUN KAPANMASI. İkisini tek şeye indirgemek, "ödedim"
   diyen ama borcu duran vakaları görünmez yapardı (BAĞLAMA ≠ KAPATMA
   doktrininin bu alandaki karşılığı).

GERİ ÖDEME
──────────
Kapatma da bir para hareketidir: ters yönde ikinci bir çift kayıt yazılır
(alan şubeden çıkar, veren şubeye girer). Borç kaydı 'kapandi' olur.
⛔ Borcu SİLMEK yok — GERİ-ALMA ≠ SİLME. Yanlış açılan kayıt 'iptal' damgası
ve gerekçesiyle kapanır, para hareketi de ters kayıtla geri alınır.

DOKTRİN
───────
· Toplam kasa ASLA değişmez (her işlem net 0) — çapası testte
· Açıklama zorunlu: para çıkışı adsız olamaz
· veren ≠ alan, tutar > 0 — kaynakta doğrulanır
· İdempotans: kasa anahtarı borç kaydının ID'sinden türer → çift kayıt doğmaz
· Şube kimliği `subeler`den doğrulanır; 'MERKEZ' burada geçersizdir (merkez
  bir şube değil — şube borcu iki GERÇEK şube arasındadır)
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit, insert_kasa_hareketi

router = APIRouter(prefix="/api/sube-ici-borc", tags=["sube-ici-borc"])


def _tablo(cur) -> None:
    """Lazy migration — modül ilk çağrıldığında tabloyu kurar."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sube_ici_borc (
            id             TEXT PRIMARY KEY,
            veren_sube_id  TEXT NOT NULL,
            alan_sube_id   TEXT NOT NULL,
            tutar          NUMERIC(14,2) NOT NULL,
            tarih          DATE NOT NULL,
            aciklama       TEXT NOT NULL,
            durum          TEXT NOT NULL DEFAULT 'acik',   -- acik | kapandi | iptal
            kapanma_tarihi DATE,
            kapanma_notu   TEXT,
            olusturma      TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    cur.execute("""CREATE INDEX IF NOT EXISTS idx_sube_ici_borc_durum
                   ON sube_ici_borc (durum, tarih DESC)""")


def capraz_odeme_borcu_kur(cur, odeyen_sube: str, maliyet_sube: str, tutar: float,
                           tarih: str, aciklama: str, kaynak_id: str) -> Optional[str]:
    """🔁 ÇAPRAZ ÖDEME → OTOMATİK ŞUBE BORCU (sahip kararı 2026-08-18).

    Sahip: "ödemesini yaparken BORÇ OLARAK DA YAZSIN ve bu iyi bir şey bence!"
    Yani Gazze, Alsancak'ın kredisini ödediğinde bu yalnız analitik bir denge
    değil, GÖRÜNÜR BİR BORÇ olsun.

    ⚠️ CODEX'İN İTİRAZI VE NASIL KARŞILANDI:
    Codex "otomatik borç üretme — sahte alacak/borç ŞİŞMESİ olur" demişti ve
    haklıydı: her çapraz ödeme ayrı kayıt açsaydı bir yılda yüzlerce hiç
    kapanmayan açık borç birikir, sayı anlamsızlaşırdı. Sahip yine de borç
    olarak görmek istedi — kararı onun. Şişme riski MEKANİZMAYLA çözüldü:
      1) ÇİFT YÖNLÜ NETLEŞTİRME: aynı şube çiftinde TERS yönde açık borç varsa
         önce ondan düşülür. Gazze→Alsancak 30.000 varken Alsancak→Gazze 12.000
         geldiğinde iki kayıt DEĞİL, tek kayıt 18.000'e iner.
      2) TEK KAYIT: aynı yöndeki çapraz ödemeler yeni kayıt açmaz, mevcut
         otomatik kaydın tutarını büyütür.
      3) KAYNAK AYRIMI: `kaynak='otomatik'` — elle girilen gerçek borçlarla
         (kaynak='elle') karışmaz; ikisi ayrı sayılabilir.

    ⛔ KASA HAREKETİ YAZMAZ. Elle açılan şube borcu parayı taşır (çift kayıt);
    burada para ZATEN ödemenin kendisiyle taşındı. İkisini aynı fonksiyona
    bağlamak parayı İKİ KEZ hareket ettirirdi — bu, bugün kapattığımız
    çift-sayım kusurlarının aynısı olurdu.

    Dönüş: dokunulan borç kaydının id'si (netleşme tam kapattıysa None).
    """
    if not odeyen_sube or not maliyet_sube or odeyen_sube == maliyet_sube:
        return None
    try:
        kalan = round(abs(float(tutar)), 2)
    except (TypeError, ValueError):
        return None
    if kalan <= 0:
        return None
    _tablo(cur)
    cur.execute("""ALTER TABLE sube_ici_borc ADD COLUMN IF NOT EXISTS
                   kaynak TEXT NOT NULL DEFAULT 'elle'""")

    # 1) TERS YÖNDE açık otomatik borç varsa önce ondan düş (netleştirme)
    cur.execute("""SELECT id, tutar FROM sube_ici_borc
                    WHERE durum='acik' AND kaynak='otomatik'
                      AND veren_sube_id=%s AND alan_sube_id=%s
                    ORDER BY tarih ASC FOR UPDATE""",
                (maliyet_sube, odeyen_sube))
    for r in cur.fetchall():
        if kalan <= 0.009:
            break
        mevcut = float(dict(r)["tutar"])
        dus = min(mevcut, kalan)
        yeni = round(mevcut - dus, 2)
        if yeni <= 0.009:
            cur.execute("""UPDATE sube_ici_borc SET durum='kapandi',
                             kapanma_tarihi=%s, kapanma_notu='Ters yönlü çapraz ödemeyle netleşti'
                            WHERE id=%s""", (tarih, dict(r)["id"]))
        else:
            cur.execute("UPDATE sube_ici_borc SET tutar=%s WHERE id=%s", (yeni, dict(r)["id"]))
        kalan = round(kalan - dus, 2)
    if kalan <= 0.009:
        return None   # tamamı netleşti — yeni borç doğmadı

    # 2) AYNI YÖNDE açık otomatik kayıt varsa büyüt, yoksa aç (tek kayıt kuralı)
    cur.execute("""SELECT id, tutar FROM sube_ici_borc
                    WHERE durum='acik' AND kaynak='otomatik'
                      AND veren_sube_id=%s AND alan_sube_id=%s
                    ORDER BY tarih ASC LIMIT 1 FOR UPDATE""",
                (odeyen_sube, maliyet_sube))
    var = cur.fetchone()
    if var:
        bid = dict(var)["id"]
        cur.execute("UPDATE sube_ici_borc SET tutar=%s, tarih=%s WHERE id=%s",
                    (round(float(dict(var)["tutar"]) + kalan, 2), tarih, bid))
    else:
        bid = str(uuid.uuid4())
        cur.execute("""INSERT INTO sube_ici_borc
            (id, veren_sube_id, alan_sube_id, tutar, tarih, aciklama, durum, kaynak)
            VALUES (%s,%s,%s,%s,%s,%s,'acik','otomatik')""",
            (bid, odeyen_sube, maliyet_sube, kalan, tarih,
             f"Çapraz ödeme (otomatik): {aciklama}"[:300]))
    audit(cur, "sube_ici_borc", bid, "AUTO")
    return bid


def _sube_dogrula(cur, sid: str, rol: str) -> Dict[str, Any]:
    """Şube GERÇEKTEN var mı — uydurma kimlikle para taşınmaz.

    'MERKEZ' / pasif 'sube-merkez' burada GEÇERSİZ: merkez bir şube değil,
    şube yokluğudur (2026-08-17 kasa modeli). Şube borcu iki gerçek şube
    arasındadır; merkeze para aktarımı KASA TESLİMİ'dir, borç değil.
    """
    v = (sid or "").strip()
    if not v:
        raise HTTPException(400, f"{rol} şube seçilmedi")
    if v.upper() in ("MERKEZ", "SUBE-MERKEZ"):
        raise HTTPException(
            400,
            "Merkez bir şube değildir — merkeze para aktarımı «kasa teslimi» "
            "olarak kaydedilir, şube borcu olarak değil.",
        )
    cur.execute("""SELECT id::text AS id, ad FROM subeler
                   WHERE id::text=%s AND COALESCE(aktif,TRUE)=TRUE
                     AND UPPER(COALESCE(ad,'')) <> 'MERKEZ' LIMIT 1""", (v,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, f"{rol} şube bulunamadı: {v}")
    return dict(r)


class BorcBody(BaseModel):
    veren_sube_id: str
    alan_sube_id: str
    tutar: float
    tarih: str
    aciklama: str


@router.post("")
def borc_ac(b: BorcBody):
    """Şube A, şube B'ye borç verdi → para taşınır + açık borç kaydı doğar."""
    try:
        tutar = round(float(b.tutar), 2)
    except (TypeError, ValueError):
        raise HTTPException(400, "Tutar sayı olmalı")
    if tutar <= 0:
        raise HTTPException(400, "Tutar pozitif olmalı")
    if (b.veren_sube_id or "").strip() == (b.alan_sube_id or "").strip():
        raise HTTPException(400, "Veren ve alan şube aynı olamaz")
    aciklama = (b.aciklama or "").strip()
    if len(aciklama) < 3:
        raise HTTPException(400, "Açıklama zorunlu — para hareketi adsız olamaz")

    with db() as (conn, cur):
        _tablo(cur)
        veren = _sube_dogrula(cur, b.veren_sube_id, "Veren")
        alan = _sube_dogrula(cur, b.alan_sube_id, "Alan")
        bid = str(uuid.uuid4())
        cur.execute("""INSERT INTO sube_ici_borc
            (id, veren_sube_id, alan_sube_id, tutar, tarih, aciklama, durum)
            VALUES (%s,%s,%s,%s,%s,%s,'acik')""",
            (bid, veren["id"], alan["id"], tutar, b.tarih, aciklama))

        # ── PARA HAREKETİ: çift kayıt, net 0 ──────────────────────────────
        insert_kasa_hareketi(
            cur, b.tarih, "SUBE_BORC_VER", -abs(tutar),
            f"Şube borcu — {veren['ad']} → {alan['ad']}: {aciklama}",
            "sube_ici_borc", bid, f"{bid}_ver", "SUBE_BORC",
            idempotency_key=f"v2|subeborc|ver|{bid}",
            sube_id=veren["id"], odeme_yontemi="elden",
        )
        insert_kasa_hareketi(
            cur, b.tarih, "SUBE_BORC_AL", abs(tutar),
            f"Şube borcu alındı — {veren['ad']} → {alan['ad']}: {aciklama}",
            "sube_ici_borc", bid, f"{bid}_al", "SUBE_BORC",
            idempotency_key=f"v2|subeborc|al|{bid}",
            sube_id=alan["id"], odeme_yontemi="elden",
        )
        audit(cur, "sube_ici_borc", bid, "INSERT")
    return {"id": bid, "success": True,
            "mesaj": f"{veren['ad']} → {alan['ad']} {tutar:,.2f} ₺ borç kaydedildi"}


class KapatBody(BaseModel):
    tarih: str
    not_: Optional[str] = None
    tutar: Optional[float] = None   # kısmi geri ödeme için (boşsa tamamı)


@router.post("/{bid}/kapat")
def borc_kapat(bid: str, b: KapatBody):
    """Geri ödeme: para TERS yönde taşınır, borç kapanır.

    ⚠️ Kısmi geri ödeme: kalan tutar için borç AÇIK kalır ve yeni bir kayıt
    açılmaz — aynı kaydın tutarı düşer. Böylece "aynı borç iki kez görünür"
    tuzağına düşülmez.
    """
    with db() as (conn, cur):
        _tablo(cur)
        cur.execute("SELECT * FROM sube_ici_borc WHERE id=%s FOR UPDATE", (bid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Borç kaydı bulunamadı")
        kayit = dict(r)
        if kayit["durum"] != "acik":
            raise HTTPException(400, f"Bu borç zaten «{kayit['durum']}» durumunda")
        acik_tutar = float(kayit["tutar"])
        odenen = round(float(b.tutar), 2) if b.tutar is not None else acik_tutar
        if odenen <= 0:
            raise HTTPException(400, "Geri ödeme tutarı pozitif olmalı")
        if odenen > acik_tutar + 0.01:
            raise HTTPException(400, f"Geri ödeme borçtan büyük olamaz (açık: {acik_tutar:,.2f} ₺)")

        veren = _sube_dogrula(cur, kayit["veren_sube_id"], "Veren")
        alan = _sube_dogrula(cur, kayit["alan_sube_id"], "Alan")
        tam = odenen >= acik_tutar - 0.01
        kalan = round(acik_tutar - odenen, 2)

        # ── TERS PARA HAREKETİ: alan şubeden çıkar, veren şubeye girer ────
        # Anahtar ÖDENEN TUTARI da içerir: kısmi ödemeler ayrı olaylardır,
        # aynı anahtara düşerlerse ikincisi sessizce yutulurdu.
        _ek = f"{bid}|{odenen:.2f}|{b.tarih}"
        insert_kasa_hareketi(
            cur, b.tarih, "SUBE_BORC_GERI_VER", -abs(odenen),
            f"Şube borcu geri ödendi — {alan['ad']} → {veren['ad']}: {kayit['aciklama']}",
            "sube_ici_borc", bid, f"{bid}_gver", "SUBE_BORC",
            idempotency_key=f"v2|subeborc|gver|{_ek}",
            sube_id=alan["id"], odeme_yontemi="elden",
        )
        insert_kasa_hareketi(
            cur, b.tarih, "SUBE_BORC_GERI_AL", abs(odenen),
            f"Şube borcu tahsil edildi — {alan['ad']} → {veren['ad']}: {kayit['aciklama']}",
            "sube_ici_borc", bid, f"{bid}_gal", "SUBE_BORC",
            idempotency_key=f"v2|subeborc|gal|{_ek}",
            sube_id=veren["id"], odeme_yontemi="elden",
        )

        if tam:
            cur.execute("""UPDATE sube_ici_borc
                SET durum='kapandi', kapanma_tarihi=%s, kapanma_notu=%s
                WHERE id=%s""", (b.tarih, (b.not_ or "").strip() or None, bid))
        else:
            cur.execute("""UPDATE sube_ici_borc SET tutar=%s WHERE id=%s""", (kalan, bid))
        audit(cur, "sube_ici_borc", bid, "UPDATE")
    return {"success": True, "tam_kapandi": tam, "kalan": 0.0 if tam else kalan,
            "mesaj": f"{alan['ad']} → {veren['ad']} {odenen:,.2f} ₺ geri ödendi"
                     + ("" if tam else f" · kalan {kalan:,.2f} ₺")}


class IptalBody(BaseModel):
    gerekce: str


@router.post("/{bid}/iptal")
def borc_iptal(bid: str, b: IptalBody):
    """Yanlış açılmış kaydı GERİ AL — silme değil, izli iptal + ters para hareketi."""
    gerekce = (b.gerekce or "").strip()
    if len(gerekce) < 3:
        raise HTTPException(400, "İptal gerekçesi zorunlu")
    with db() as (conn, cur):
        _tablo(cur)
        cur.execute("SELECT * FROM sube_ici_borc WHERE id=%s FOR UPDATE", (bid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Borç kaydı bulunamadı")
        kayit = dict(r)
        if kayit["durum"] == "iptal":
            raise HTTPException(400, "Bu kayıt zaten iptal edilmiş")
        veren = _sube_dogrula(cur, kayit["veren_sube_id"], "Veren")
        alan = _sube_dogrula(cur, kayit["alan_sube_id"], "Alan")
        tutar = float(kayit["tutar"])
        insert_kasa_hareketi(
            cur, str(kayit["tarih"]), "SUBE_BORC_GERI_VER", -abs(tutar),
            f"Şube borcu İPTAL — {gerekce}", "sube_ici_borc", bid,
            f"{bid}_iptal_v", "SUBE_BORC",
            idempotency_key=f"v2|subeborc|iptalv|{bid}",
            sube_id=alan["id"], odeme_yontemi="elden",
        )
        insert_kasa_hareketi(
            cur, str(kayit["tarih"]), "SUBE_BORC_GERI_AL", abs(tutar),
            f"Şube borcu İPTAL — {gerekce}", "sube_ici_borc", bid,
            f"{bid}_iptal_a", "SUBE_BORC",
            idempotency_key=f"v2|subeborc|iptala|{bid}",
            sube_id=veren["id"], odeme_yontemi="elden",
        )
        cur.execute("""UPDATE sube_ici_borc
            SET durum='iptal', kapanma_tarihi=CURRENT_DATE, kapanma_notu=%s
            WHERE id=%s""", (f"İPTAL: {gerekce}", bid))
        audit(cur, "sube_ici_borc", bid, "UPDATE")
    return {"success": True, "mesaj": "Kayıt izli olarak iptal edildi, para geri alındı"}


@router.get("/cekmece-sayim")
def cekmece_sayim_liste():
    """Fiziksel çekmece sayımları + defterle FARK — dairesel olmayan tek çapa.

    Neden gerekli: kasanın "tuttuğunu" gösteren tüm hesaplar dairesel —
    defter kendi kendini doğrular. Dış dünyadan gelen tek ölçüm ÇEKMECEDE
    GERÇEKTEN NE OLDUĞUdur. (Codex: "en güçlü çapa fiziksel sayımdır";
    ispat formülü `açılış sayımı + nakit giriş − nakit çıkış = kapanış sayımı`
    ancak bir taraf defter dışından gelirse dairesellik kırılır.)

    ⛔ SAYIM ≠ DÜZELTME. Fark otomatik kapatılmaz; kapatılsaydı farkı DOĞURAN
    sebep (eksik ciro, kayıtsız gider) görünmez olurdu. Gözlem açıkta durur.
    """
    with db() as (conn, cur):
        _sayim_tablo(cur)
        cur.execute("""
            SELECT c.*, s.ad AS sube_adi
              FROM cekmece_sayim c
              LEFT JOIN subeler s ON s.id::text = c.sube_id
             ORDER BY c.tarih DESC, c.olusturma DESC
             LIMIT 200
        """)
        kayitlar = []
        for r in cur.fetchall():
            d = dict(r)
            for k in ("sayilan_tutar", "defter_nakit", "fark"):
                if d.get(k) is not None:
                    d[k] = float(d[k])
            for k in ("tarih", "olusturma"):
                if d.get(k):
                    d[k] = str(d[k])
            kayitlar.append(d)
    return {
        "kayitlar": kayitlar,
        "acik_fark_adet": len([k for k in kayitlar if abs(k.get("fark") or 0) > 0.01]),
        "acik_fark_toplam": round(sum(abs(k.get("fark") or 0) for k in kayitlar), 2),
        "not": "Sayım bir GÖZLEMdir, düzeltme değildir. Fark açıkta durur ki "
               "sebebi (eksik ciro / kayıtsız gider / kayıtsız devir) araştırılabilsin.",
    }


def _sayim_tablo(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cekmece_sayim (
            id            TEXT PRIMARY KEY,
            sube_id       TEXT NOT NULL,
            tarih         DATE NOT NULL,
            sayilan_tutar NUMERIC(14,2) NOT NULL,
            defter_nakit  NUMERIC(14,2),
            fark          NUMERIC(14,2),
            aciklama      TEXT,
            olusturma     TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    cur.execute("""CREATE INDEX IF NOT EXISTS idx_cekmece_sayim_sube
                   ON cekmece_sayim (sube_id, tarih DESC)""")


class SayimBody(BaseModel):
    sube_id: str
    tarih: str
    sayilan_tutar: float
    aciklama: Optional[str] = None


@router.post("/cekmece-sayim")
def cekmece_sayim_ekle(b: SayimBody):
    """Çekmecede fiziksel olarak sayılan nakdi kaydeder ve defterle KARŞILAŞTIRIR.

    Defter tarafı `nakit_etki` toplamıdır — `tutar` DEĞİL. Çünkü `tutar` para
    POZİSYONudur (kart cirosu + banka ödemeleri dahil); çekmecede fiziksel
    olarak ne olduğunu yalnız `nakit_etki` söyler.
    NULL nakit_etki'li hareketler AYRICA raporlanır: "bilinmeyen" satırlar
    farkın bir kısmını açıklıyor olabilir, sessizce sıfır sayılmaz.
    """
    try:
        sayilan = round(float(b.sayilan_tutar), 2)
    except (TypeError, ValueError):
        raise HTTPException(400, "Sayılan tutar sayı olmalı")
    if sayilan < 0:
        raise HTTPException(400, "Sayılan tutar negatif olamaz — çekmecede eksi para bulunmaz")

    with db() as (conn, cur):
        _sayim_tablo(cur)
        sube = _sube_dogrula(cur, b.sube_id, "Sayılan")
        cur.execute("""
            SELECT COALESCE(SUM(nakit_etki), 0) AS defter,
                   COUNT(*) FILTER (WHERE nakit_etki IS NULL) AS bilinmeyen_adet
              FROM kasa_hareketleri
             WHERE sube_id::text = %s
               AND COALESCE(durum,'aktif') = 'aktif'
               AND COALESCE(kasa_etkisi, TRUE) = TRUE
               AND tarih <= %s::date
        """, (sube["id"], b.tarih))
        r = dict(cur.fetchone() or {})
        defter = round(float(r.get("defter") or 0), 2)
        bilinmeyen = int(r.get("bilinmeyen_adet") or 0)
        fark = round(sayilan - defter, 2)

        sid = str(uuid.uuid4())
        cur.execute("""INSERT INTO cekmece_sayim
            (id, sube_id, tarih, sayilan_tutar, defter_nakit, fark, aciklama)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (sid, sube["id"], b.tarih, sayilan, defter, fark,
             (b.aciklama or "").strip() or None))
        audit(cur, "cekmece_sayim", sid, "INSERT")

    yon = ("defter FAZLA gösteriyor — çekmecede olması gerekenden az para var "
           "(kayıtsız çıkış olabilir)") if fark < 0 else (
          "defter EKSİK gösteriyor — çekmecede olması gerekenden çok para var "
          "(kayıtsız giriş / eksik ciro olabilir)") if fark > 0 else "defter ile birebir tutuyor"
    return {
        "id": sid, "success": True, "sube": sube["ad"],
        "sayilan": sayilan, "defter_nakit": defter, "fark": fark,
        "nakit_etkisi_bilinmeyen_hareket": bilinmeyen,
        "yorum": yon,
        "uyari": (f"{bilinmeyen} hareketin nakit etkisi BİLİNMİYOR — farkın bir kısmı "
                  "bundan kaynaklanıyor olabilir; ödeme yöntemi (elden/havale) "
                  "girildikçe fark netleşir.") if bilinmeyen else None,
        "not": "Bu bir GÖZLEMdir. Fark otomatik kapatılmadı — kapatılsaydı sebebi "
               "görünmez olurdu.",
    }


@router.get("")
def borc_liste(durum: Optional[str] = None):
    """Açık borçlar + NET POZİSYON (kim kimi ne kadar finanse ediyor).

    Net pozisyon niye lazım: A→B 10.000 ve B→A 4.000 varsa gerçek durum
    "A, B'yi 6.000 finanse ediyor"dur. İki satırı ayrı göstermek sahibi
    yanıltır; ikisi de RAPORLANIR ama net de hesaplanır.
    """
    with db() as (conn, cur):
        _tablo(cur)
        kosul = "WHERE b.durum = %s" if durum else ""
        par = [durum] if durum else []
        cur.execute(f"""
            SELECT b.*, sv.ad AS veren_ad, sa.ad AS alan_ad
              FROM sube_ici_borc b
              LEFT JOIN subeler sv ON sv.id::text = b.veren_sube_id
              LEFT JOIN subeler sa ON sa.id::text = b.alan_sube_id
              {kosul}
             ORDER BY b.durum='acik' DESC, b.tarih DESC
        """, par)
        kayitlar = []
        for r in cur.fetchall():
            d = dict(r)
            d["tutar"] = float(d.get("tutar") or 0)
            for k in ("tarih", "kapanma_tarihi", "olusturma"):
                if d.get(k):
                    d[k] = str(d[k])
            kayitlar.append(d)

    acik = [k for k in kayitlar if k["durum"] == "acik"]
    # Net pozisyon: yön-bağımsız çift anahtar; işaret kimin alacaklı olduğunu söyler
    net: Dict[tuple, float] = {}
    adlar: Dict[str, str] = {}
    for k in acik:
        v, a = k["veren_sube_id"], k["alan_sube_id"]
        adlar[v] = k.get("veren_ad") or v
        adlar[a] = k.get("alan_ad") or a
        anahtar = (v, a) if v < a else (a, v)
        isaret = 1 if (v, a) == anahtar else -1
        net[anahtar] = round(net.get(anahtar, 0.0) + isaret * k["tutar"], 2)

    net_satir = []
    for (x, y), tut in net.items():
        if abs(tut) < 0.01:
            net_satir.append({"alacakli": None, "borclu": None,
                              "alacakli_ad": adlar.get(x, x), "borclu_ad": adlar.get(y, y),
                              "tutar": 0.0, "not": "karşılıklı borçlar birbirini götürüyor"})
        elif tut > 0:
            net_satir.append({"alacakli": x, "borclu": y, "alacakli_ad": adlar.get(x, x),
                              "borclu_ad": adlar.get(y, y), "tutar": tut})
        else:
            net_satir.append({"alacakli": y, "borclu": x, "alacakli_ad": adlar.get(y, y),
                              "borclu_ad": adlar.get(x, x), "tutar": abs(tut)})
    net_satir.sort(key=lambda s: -s["tutar"])

    return {
        "kayitlar": kayitlar,
        "acik_adet": len(acik),
        "acik_toplam": round(sum(k["tutar"] for k in acik), 2),
        "net_pozisyon": net_satir,
        "not": "Para hareketi kasa defterinde ÇİFT KAYITTIR (SUBE_BORC_VER/AL) — "
               "toplam kasa değişmez, yalnız şubeler arası dağılım değişir. "
               "Borcun kapanması para hareketinden AYRI bir olaydır.",
    }
