"""🧾 EVVEL YENİ · FATURALARI ŞUBELERE DAĞIT (2026-10-17) — İŞLETMEYE ÖZEL modül (sektor: ozel).

Sahip: "Bu ödemeler genelde kartla OTOMATİK ödeniyor; şube sayısı olunca tek tek girmek zor. Kartın ekstresinden
şubenin abone kodlarıyla eşleşme kurarak çözüm bulalım." + "çıkarıldığında başka alanları sıkıntıya sokmasın;
sadece bize özgü, genelle bağı yok."  Codex + Fable kurgusu:
  · Tahakkuk / tanım YOK. Ayda bir: kart ekstresi PDF (ya da yapıştırılan metin) → fatura satırları listesi →
    her satırın şubesi seçilir → Ödeme modülünün KENDİ kaydı (konu=fatura, kartla) yazılır. Yeni para defteri yok:
    gider o şubeye geçer, kasaya dokunmaz (para kart borcu ödenince düşer).
  · Eşleştirme: satırda abone/tesisat NUMARASI varsa → o numaranın kuralı (kesin). Numara yoksa → bu kart + sağlayıcı
    imzası ("KONYA SU") kuralı; aynı kart+imza farklı şubelere seçildiyse kural BELİRSİZ olur, her ay sorulur
    (Codex: tutar kimlik değildir).
  · Çift sayım: (1) her satırın kimliği Ödeme'ye istek_id olarak gider → ikinci kez yazılmaz; (2) aynı kart, aynı tutar,
    ±5 gün içinde zaten bir kart ödemesi varsa satır "zaten girilmiş" görünür.
Tak-çıkar: yalnız Ödeme'nin PUBLIC uçlarını (odeme_gir, odeme_listesi, listeler) kullanır; kimse bu modülü import etmez.
Kapatmak = evvel_yeni_moduller.py'de acik=False → Ödeme altındaki "Faturaları dağıt" sekmesi de kalkar.
"""

import base64
import hashlib
import logging
import re
from datetime import date
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db
from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun

router = APIRouter(prefix="/api/evvel-yeni/fatura", tags=["evvel-yeni-fatura"])
log = logging.getLogger(__name__)

from evvel_yeni_kasa_api import PATRONLAR   # TEK liste Kasa'da (C-T1-34)
# Fatura/abonelik olabilecek satırları tanıyan sözcükler (büyük harf, Türkçe karakter sadeleştirilmiş)
ADAY_SOZLER = ("SU ", " SU", "KOSKI", "ISKI", "ELEKTR", "ENERJ", "ENERYA", "DOGALGAZ", "GAZ DAG", "INTERNET", "TELEKOM",
               "TURKCELL", "VODAFONE", "SUPERONLINE", "TURKNET", "AIDAT", "FATURA", "TALIMAT", "OTOMATIK ODEME", "POS ")
TUR_IPUCU = [("Elektrik", ("ELEKTR", "ENERJ")), ("Su", ("SU ", " SU", "KOSKI", "ISKI")), ("Doğalgaz", ("GAZ",)),
             ("İnternet / telefon", ("INTERNET", "TELEKOM", "TURKCELL", "VODAFONE", "SUPERONLINE", "TURKNET"))]
AYLAR = {"OCAK": 1, "SUBAT": 2, "MART": 3, "NISAN": 4, "MAYIS": 5, "HAZIRAN": 6, "TEMMUZ": 7, "AGUSTOS": 8, "EYLUL": 9,
         "EKIM": 10, "KASIM": 11, "ARALIK": 12}
_HAZIR = False


def _sade(s: str) -> str:
    t = (s or "").replace("i̇", "i").upper()
    for a, b in (("Ç", "C"), ("Ğ", "G"), ("İ", "I"), ("I", "I"), ("Ö", "O"), ("Ş", "S"), ("Ü", "U"), ("Â", "A")):
        t = t.replace(a, b)
    return re.sub(r"\s+", " ", t).strip()


def _hazirla():
    global _HAZIR
    if _HAZIR:
        return
    with db() as (conn, cur):
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_fatura_kural (
            kart_id TEXT NOT NULL DEFAULT '', anahtar TEXT NOT NULL,
            hedef TEXT, fatura_turu TEXT, belirsiz BOOLEAN NOT NULL DEFAULT FALSE,
            ornek TEXT, kim TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (kart_id, anahtar))""")
    _HAZIR = True


# ─────────────────────────── EKSTRE OKUMA (bankaya özel kalıp YOK) ───────────────────────────
_TUTAR = re.compile(r"([+-]?\d{1,3}(?:\.\d{3})*,\d{2}|[+-]?\d+,\d{2})\s*(?:TL|₺)?\s*([+-])?\s*$")
_T1 = re.compile(r"^(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b")
_T2 = re.compile(r"^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})\b")


def _tarih(satir: str):
    m = _T1.match(satir)
    if m:
        g, a, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = y + 2000 if y < 100 else y
        try:
            return date(y, a, g), satir[m.end():]
        except ValueError:
            return None, satir
    m = _T2.match(satir)
    if m and _sade(m.group(2)) in AYLAR:
        try:
            return date(int(m.group(3)), AYLAR[_sade(m.group(2))], int(m.group(1))), satir[m.end():]
        except ValueError:
            return None, satir
    return None, satir


def _satirlar(metin: str) -> List[dict]:
    """Her satır: başında tarih, sonunda tutar → işlem. Arada açıklama. Bankaya özel kalıp yok (bakım yükü olmasın)."""
    out = []
    for ham in (metin or "").splitlines():
        s = re.sub(r"\s+", " ", ham).strip()
        if len(s) < 12:
            continue
        gun, kalan = _tarih(s)
        if not gun:
            continue
        m = _TUTAR.search(kalan)
        if not m:
            continue
        ham_t = m.group(1)
        tutar = Decimal(ham_t.replace(".", "").replace(",", "."))
        aciklama = kalan[:m.start()].strip(" -*")
        if not aciklama:
            continue
        # Codex/Fable: işaret tutarın ÖNÜNDE ya da ARKASINDA olabilir ('250,00+' iade, '1.234,56 -') → fatura değil
        isaret = bool(m.group(2)) or ham_t.startswith(("+", "-"))
        out.append({"tarih": gun, "aciklama": aciklama[:160], "tutar": abs(tutar), "eksi": isaret})
    return out


def _pdf_metin(b64: str) -> str:
    try:
        raw = base64.b64decode(b64.split(",")[-1])
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Dosya okunamadı")
    try:
        import fitz  # pymupdf
        doc = fitz.open(stream=raw, filetype="pdf")
        return "\n".join(p.get_text() for p in doc)
    except Exception as e:  # noqa: BLE001
        log.warning("fatura dağıt: PDF okunamadı: %s", str(e)[:150])
        raise HTTPException(400, "PDF okunamadı — ekstrenin metnini kopyalayıp yapıştırabilirsin")


def _numara(aciklama: str) -> Optional[str]:
    """Abone/tesisat numarası adayı: 6+ haneli sayı (baştaki sıfırlar atılır — '01445524' = '1445524')."""
    temiz = re.sub(r"\d+[.,]\d{2}(?!\d)", " ", aciklama)                   # tutar parçaları (123456,78)
    temiz = re.sub(r"\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b", " ", temiz)        # tarih (01.10.2026)
    for n in re.findall(r"(?<![\d.,])(\d{6,14})(?![\d.,])", temiz):
        if len(n) == 8 and (n[:2] in ("19", "20") or n[4:6] in ("19", "20")):
            continue                                                         # 20261001 / 01102026 = tarih
        return n.lstrip("0") or "0"
    return None


def _imza(aciklama: str) -> str:
    """Numarasız satırın sağlayıcı imzası: sayı/işaret atılmış ilk iki kelime ("KONYA SU", "ENAY ENERJI")."""
    genel = {"OTOMATIK", "ODEME", "TALIMAT", "TALIMATINIZ", "TALIMATI", "FATURA", "FATURASI", "TAHSILAT", "POS", "KREDI", "KARTI", "ISLEM"}
    k = [w for w in re.sub(r"[^A-Z ]", " ", _sade(aciklama)).split() if len(w) > 1 and w not in genel]
    return " ".join(k[:2])


def _aday(aciklama: str) -> bool:
    t = " " + _sade(aciklama) + " "
    return any(s in t for s in ADAY_SOZLER)


def _tur_tahmin(aciklama: str) -> Optional[str]:
    t = " " + _sade(aciklama) + " "
    for tur, sozler in TUR_IPUCU:
        if any(s in t for s in sozler):
            return tur
    return None


def _satir_id(kart_id: str, x: dict, sira: int = 0) -> str:
    """Aynı gün + tutar + açıklamalı İKİ gerçek işlem ayrı kimlik alır (kaçıncı tekrar olduğu eklenir — Fable/Codex)."""
    ek = f"|{sira}" if sira else ""      # ilk satır ESKİ kimlikle aynı (önceki kayıtlar tanınsın — Codex 2. tur)
    h = hashlib.sha1(f"{kart_id}|{x['tarih']}|{x['tutar']}|{_sade(x['aciklama'])}{ek}".encode()).hexdigest()[:16]
    return f"ekstre:{h}"


def _odeme():
    """Ödeme modülünün PUBLIC uçları — yoksa (Ödeme kapalı) bu modül de çalışmaz (manifest: gerekir)."""
    import evvel_yeni_odeme_api as o
    return o


# ─────────────────────────── UÇLAR ───────────────────────────
class OkuBody(BaseModel):
    kart_id: str
    pdf: Optional[str] = None      # base64 (data URL olabilir)
    metin: Optional[str] = None    # PDF okunamazsa yapıştırılan metin


@router.post("/oku")
def oku(body: OkuBody):
    """Ekstreyi okur, fatura satırlarını ve şube önerisini döner. HİÇBİR ŞEY YAZMAZ."""
    _hazirla()
    o = _odeme()
    L = o.listeler()
    kart = next((k for k in L["kartlar"] if str(k["id"]) == body.kart_id), None)
    if not kart:
        raise HTTPException(400, "Kart seç")
    metin = _pdf_metin(body.pdf) if body.pdf else (body.metin or "")
    tum = _satirlar(metin)
    if not tum:
        raise HTTPException(400, "Ekstrede işlem satırı bulunamadı — PDF görüntü olabilir; metnini kopyalayıp yapıştır")
    with db() as (conn, cur):
        cur.execute("SELECT kart_id, anahtar, hedef, fatura_turu, belirsiz FROM ey_fatura_kural WHERE kart_id IN ('', %s)", (body.kart_id,))
        K = {(r["kart_id"], r["anahtar"]): dict(r) for r in cur.fetchall() or []}
    # benzer kayıt: aynı kart, aynı tutar, ±5 gün — YALNIZ UYARI (Codex: başka bir harcama faturayı engellemesin).
    # Kesin tekrar koruması satır kimliğidir (istek_id) → aynı satır ikinci kez yazılmaz; daha önce yazılanlar 'girilmiş'.
    import evvel_yeni_kasa_api as kasa
    with db() as (conn, cur):
        mevcut = [(date.fromisoformat(m["tarih"]), Decimal(m["tutar"]) / 100, m["aciklama"]) for m in o.kart_harcamalari(cur, body.kart_id)]
        bas = kasa.donem_baslangici(cur)
        # C-T1-29: iptal edilen satır "yeni" görünüp aynı kimlikle yazılamıyordu (ON CONFLICT sessizce). Etkin kayıt → girilmiş;
        # yalnız iptal edilmiş sürümler varsa yeni sürüm kimliği (ekstre:…:rN) ile yeniden yazılır.
        cur.execute("""SELECT kaynak_ref, id IN (SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal' AND veri ? 'hedef_id') AS iptal
                         FROM para_izi_hareket WHERE kaynak_ref LIKE 'odeme_formu:ekstre:%%'""")
        yazilmis, iptalli = set(), {}
        for r in cur.fetchall() or []:
            ref = dict(r)["kaynak_ref"][len("odeme_formu:"):]
            kok = ref.split(":r", 1)[0]
            if dict(r)["iptal"]:
                iptalli[kok] = iptalli.get(kok, 0) + 1
            else:
                yazilmis.add(kok)
    out, diger, sayac = [], 0, {}
    for x in tum:
        if x["eksi"]:
            continue   # ödeme/iade satırı — fatura değil
        no = _numara(x["aciklama"])
        imza = _imza(x["aciklama"])
        k_no = K.get(("", f"no:{imza}:{no}")) if no else None      # numara SAĞLAYICIYLA birlikte (referans no her ay farklı → eşleşmez)
        k_ad = K.get((body.kart_id, "ad:" + imza))
        kural = k_no or k_ad
        if k_no and k_ad and not k_no["belirsiz"] and not k_ad["belirsiz"] and k_no["hedef"] != k_ad["hedef"]:
            kural = {**k_no, "belirsiz": True}                       # Codex: numara ve imza farklı şube diyorsa kesin değil
        if not kural and not _aday(x["aciklama"]):
            diger += 1
            continue
        if kural and kural["hedef"] == "yoksay":
            diger += 1
            continue
        oneri, kesin = None, False
        if kural and not kural["belirsiz"]:
            oneri, kesin = kural["hedef"], kural["anahtar"].startswith("no:") and k_ad is not None and not k_ad["belirsiz"] and k_ad["hedef"] == kural["hedef"]
        anahtar = (x["tarih"], x["tutar"], _sade(x["aciklama"]))
        sayac[anahtar] = sayac.get(anahtar, -1) + 1
        sid = _satir_id(body.kart_id, x, sayac[anahtar])
        g = next((m for m in mevcut if m[1] == x["tutar"] and abs((m[0] - x["tarih"]).days) <= 5), None)
        if sid in yazilmis:
            durum = "girilmis"              # bu ekstre satırı daha önce buradan kaydedildi
        elif x["tarih"] > _bugun():
            durum = "gelecek"
        elif bas and x["tarih"] < bas:
            durum = "donem_oncesi"          # Fable: seçtirip sonra reddetmesin
        else:
            durum = "yeni"
        out.append({"id": sid, "istek": sid if not iptalli.get(sid) or durum == "girilmis" else f"{sid}:r{iptalli[sid]}",
                    "tarih": x["tarih"].isoformat(), "benzer": (g[2] if g and durum == "yeni" else None), "aciklama": x["aciklama"],
                    "tutar": float(x["tutar"]), "no": no, "imza": imza, "oneri": oneri, "kesin": kesin,
                    "belirsiz": bool(kural and kural["belirsiz"]),
                    "fatura_turu": (kural or {}).get("fatura_turu") or _tur_tahmin(x["aciklama"]) or "Diğer abonelik",
                    "durum": durum})
    return {"kart": {"id": kart["id"], "ad": kart["ad"]}, "satirlar": out, "diger_sayi": diger, "toplam_satir": len(tum),
            "subeler": L["subeler"], "fatura_turleri": L["fatura_turleri"], "patronlar": list(PATRONLAR)}


class Satir(BaseModel):
    id: str
    tarih: str
    aciklama: str
    tutar: Decimal
    hedef: str                       # şube id | patron:Ad | yoksay
    fatura_turu: Optional[str] = None
    no: Optional[str] = None
    imza: Optional[str] = None
    istek: Optional[str] = None      # iptal edilip yeniden girilen satırın sürüm kimliği (ekstre:…:rN)


class KaydetBody(BaseModel):
    kart_id: str
    satirlar: List[Satir]


@router.post("/kaydet")
def kaydet(body: KaydetBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Seçilen satırları Ödeme'nin kendi kaydı olarak yazar (kartla ödenen fatura) + kuralı öğrenir. Satır başına ayrı işlem:
    biri hata verirse diğerleri yazılır, hata satırın yanında döner."""
    _hazirla()
    o = _odeme()
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
    sonuc = []
    for s in body.satirlar:
        h = s.hedef or ""
        ik = s.istek if s.istek and s.istek.startswith(s.id) else s.id
        try:
            if h == "yoksay":
                r = {"ok": True, "mesaj": "yok sayıldı"}
            elif h.startswith("patron:") and h[7:] in PATRONLAR:
                r = o.odeme_gir(o.OdemeBody(konu="diger", tarih=s.tarih, kimin="patron", patron=h[7:],
                                            aciklama=f"{s.aciklama[:80]} (kart ekstresi)", istek_id=ik, tekrar_onay=True,
                                            parcalar=[o.Parca(yontem="kart", kart_id=body.kart_id, tutar=s.tutar)]), x_evvel_oturum)
            else:
                r = o.odeme_gir(o.OdemeBody(konu="fatura", tarih=s.tarih, ait_ay=s.tarih[:7], sube_id=h,
                                            fatura_turu=s.fatura_turu or "Diğer abonelik", aciklama=s.aciklama[:80],
                                            istek_id=ik, tekrar_onay=True,
                                            parcalar=[o.Parca(yontem="kart", kart_id=body.kart_id, tutar=s.tutar)]), x_evvel_oturum)
            sonuc.append({"id": s.id, "ok": True, "tekrar": bool(r.get("tekrar")), "mesaj": r.get("mesaj")})
        except HTTPException as e:
            sonuc.append({"id": s.id, "ok": False, "mesaj": str(e.detail)})
            continue
        _ogren(body.kart_id, s, kim)
    yazilan = sum(1 for x in sonuc if x["ok"] and not x.get("tekrar") and x["mesaj"] != "yok sayıldı")
    return {"ok": True, "yazilan": yazilan, "sonuc": sonuc,
            "mesaj": f"{yazilan} fatura şube giderine yazıldı" + (f" · {sum(1 for x in sonuc if not x['ok'])} satır yazılamadı" if any(not x['ok'] for x in sonuc) else "")}


def _ogren(kart_id: str, s: Satir, kim: str) -> None:
    """Numara varsa numara kuralı (kartsız) + kart+imza kuralı. Aynı anahtar farklı hedefe seçilirse BELİRSİZ olur (üzerine
    yazılmaz — Codex); belirsiz kural öneri vermez, her ay sorulur. 'Yok say' de öğrenilir (Kurallar'dan unutulabilir)."""
    anahtarlar = ([("", f"no:{s.imza or ''}:{s.no}")] if s.no else []) + ([(kart_id, "ad:" + s.imza)] if s.imza else [])
    try:
        with db() as (conn, cur):
            for kart_, anahtar in anahtarlar:
                cur.execute("SELECT hedef, belirsiz FROM ey_fatura_kural WHERE kart_id=%s AND anahtar=%s", (kart_, anahtar))
                r = cur.fetchone()
                if r is None:
                    cur.execute("""INSERT INTO ey_fatura_kural (kart_id, anahtar, hedef, fatura_turu, ornek, kim) VALUES (%s,%s,%s,%s,%s,%s)
                                   ON CONFLICT DO NOTHING""", (kart_, anahtar, s.hedef, s.fatura_turu, s.aciklama[:120], kim))
                elif not r["belirsiz"] and r["hedef"] != s.hedef:
                    cur.execute("UPDATE ey_fatura_kural SET belirsiz=TRUE, kim=%s, zaman=NOW() WHERE kart_id=%s AND anahtar=%s",
                                (kim, kart_, anahtar))
    except Exception as e:  # noqa: BLE001 — öğrenme yazılamazsa ödeme yine yazılmıştır
        log.warning("fatura dağıt: kural öğrenilemedi: %s", str(e)[:150])


@router.get("/kurallar")
def kurallar():
    _hazirla()
    with db() as (conn, cur):
        cur.execute("SELECT kart_id, anahtar, hedef, fatura_turu, belirsiz, ornek, kim, zaman FROM ey_fatura_kural ORDER BY zaman DESC")
        return {"kurallar": [{**dict(r), "zaman": str(r["zaman"])[:16]} for r in cur.fetchall() or []]}


@router.post("/kural-sil")
def kural_sil(kart_id: str, anahtar: str):
    _hazirla()
    with db() as (conn, cur):
        cur.execute("DELETE FROM ey_fatura_kural WHERE kart_id=%s AND anahtar=%s", (kart_id, anahtar))
    return {"ok": True}

