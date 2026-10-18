"""📱 EVVEL YENİ · YOKLAMA / QR TELEFON — tak-çıkar modül "yoklama" (YOKLAMA_QR_TASARIM.md · sahip kararları K1–K11, F1a–F7).

Sıfırdan; eski gorev_yoklama / kasa_devir_onay / personel_panel_auth tablolarına köprü YOK (eski içerik yalnız bir kez: şube koordinatı,
yönetici konum muafiyeti). Faz Y0: telefon / tablet bağlama · dönen QR · telefondan giriş / çıkış · konum · panel "bugün girenler".
  · KİMLİK PIN'siz: cihaz bir kez kişiye (telefon) ya da şubeye (tablet) bağlanır (merkezin tek kullanımlık linki, K1/K9 uzaktan olur).
    Telefon WebCrypto ECDSA P-256 ÇIKARILAMAZ anahtar üretir; her istek imzalı (zaman + tek kullanımlık nonce). Eski tarayıcıda zayıf bağ
    (jeton) istisnası — merkez "zayıf bağ" görür.
  · QR: 60 sn dilimli HMAC jetonu, şubeye bağlı, ömür 60–120 sn; yalnız o şubenin KAYITLI TABLETİ üretebilir. Jeton + kişi + işlem tek kullanım.
  · KONUM ≤ şube yarıçapı (varsayılan 150 m); yönetici konum muaf (K2); koordinatsız şube serbest + merkeze iş (K3).
  · Aynı anda tek açık giriş (K11); çıkıştan sonra aynı gün yeniden giriş ayrı satır (K4).
  · Uyarı personele GİTMEZ: eksikler yalnız merkez Bekleyen işler › Personel.
VAR OLAN OKUMADAN DEVAM (yerleşim denetimi F1–F10): Personel takvimi / Günlük yoklama / maaş yemek kalemi / Satış devir defteri / Bar kapanışçı
okuyucuları 1 Kasım'dan itibaren bu modülün PUBLIC servislerine KAYNAK DEĞİŞTİRİR — ikinci okuyucu kurulmaz (Y3).
"""

import base64
import hashlib
import hmac
import json
import logging
import math
import secrets
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from database import db, savepoint
from evvel_yeni_cekirdek import aktor as _aktor, ayar_oku, ayar_yaz, bekleyen_is_kaydet, is_gunu

router = APIRouter(prefix="/api/evvel-yeni/yoklama", tags=["evvel-yeni-yoklama"])
log = logging.getLogger(__name__)
QR_DILIM_SN = 60
SAAT_PAYI_SN = 120
DAVET_SAAT = 48
VARSAYILAN_YARICAP = 150
_HAZIR = False


# ─────────────────────────── KURULUM (uygulama açılışında; ayrı işlem) ───────────────────────────
def yoklama_hazirla() -> None:
    global _HAZIR
    if _HAZIR:
        return
    from evvel_yeni_tanim_api import tanim_hazirla
    with db() as (_c, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012047)")
        tanim_hazirla(cur)
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION")
        cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION")
        cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS yaricap_m INT NOT NULL DEFAULT 150")
        cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS konum_muaf BOOLEAN NOT NULL DEFAULT FALSE")   # K2
        cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS mudur BOOLEAN NOT NULL DEFAULT FALSE")        # F1b
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_cihaz (
            id TEXT PRIMARY KEY, tur TEXT NOT NULL, personel_id TEXT, sube_id TEXT, acik_anahtar JSONB, jeton_hash TEXT,
            guc TEXT, etiket TEXT, durum TEXT NOT NULL DEFAULT 'davet', davet_hash TEXT UNIQUE, davet_son TIMESTAMPTZ,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW(), son_kullanim TIMESTAMPTZ, olusturan TEXT, iptal_zaman TIMESTAMPTZ)""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_cihaz_nonce (
            cihaz_id TEXT NOT NULL, nonce TEXT NOT NULL, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (cihaz_id, nonce))""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_qr_kullanim (
            sube_id TEXT NOT NULL, dilim BIGINT NOT NULL, personel_id TEXT NOT NULL, islem TEXT NOT NULL,
            zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (sube_id, dilim, personel_id, islem))""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_yoklama (
            id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, personel_id TEXT NOT NULL, is_gunu DATE NOT NULL,
            giris_ts TIMESTAMPTZ NOT NULL, giris_mesafe_m INT, giris_muaf BOOLEAN NOT NULL DEFAULT FALSE, giris_cihaz_id TEXT,
            cikis_ts TIMESTAMPTZ, cikis_tur TEXT, cikis_mesafe_m INT, cikis_cihaz_id TEXT,
            istek_id TEXT UNIQUE, cikis_istek_id TEXT UNIQUE, degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_yoklama_acik ON ey_yoklama (personel_id) WHERE cikis_ts IS NULL")   # K11
        # Yemek molası (K7/K8): kişi başı iş gününde 1; hak = süre ≤ mola_limit_dk; merkez elle hak verebilir (izli)
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_mola (
            id TEXT PRIMARY KEY, personel_id TEXT NOT NULL, sube_id TEXT NOT NULL, is_gunu DATE NOT NULL, yoklama_id TEXT,
            baslangic_ts TIMESTAMPTZ NOT NULL, baslangic_mesafe_m INT, bitis_ts TIMESTAMPTZ, bitis_mesafe_m INT, bitis_tur TEXT,
            sure_dk INT, yemek_hakki BOOLEAN, hak_elle BOOLEAN NOT NULL DEFAULT FALSE, hak_veren TEXT, hak_zaman TIMESTAMPTZ,
            hak_aciklama TEXT, gorulen TEXT, istek_id TEXT UNIQUE, bitis_istek_id TEXT UNIQUE, degistiren TEXT,
            zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (personel_id, is_gunu))""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_mola_gun ON ey_mola (is_gunu)")
        try:
            with savepoint(cur, "sp_ey_mola_acik"):
                cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_mola_acik ON ey_mola (personel_id) WHERE bitis_ts IS NULL")   # Codex: 02:00 sonrası ikinci açık mola yok
        except Exception:  # noqa: BLE001
            log.warning("ux_ey_mola_acik kurulamadı (açık mola çakışması) — uygulama kontrolü korur", exc_info=True)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_yoklama_gun ON ey_yoklama (sube_id, is_gunu)")
        # QR sırrı: ortam değişkeni yoksa bir kez üretilir (ayar defterinde; dışarı verilmez)
        import os
        if not os.getenv("EVVEL_QR_GIZ") and not ayar_oku(cur, "qr_giz"):
            ayar_yaz(cur, "qr_giz", secrets.token_hex(32), "kurulum")
        # İÇERİK bir kez (köprü değil): eski şube koordinatları (K3) ve yönetici konum muafiyeti (K2)
        if ayar_oku(cur, "sube_konum_kopya") is None:
            try:
                with savepoint(cur, "sp_ey_konum_kopya"):
                    cur.execute("""UPDATE ey_sube e SET lat = s.lat, lng = s.lng, yaricap_m = COALESCE(s.konum_radius_m, 150)
                                     FROM subeler s WHERE s.id::text = e.id AND e.lat IS NULL AND s.lat IS NOT NULL AND s.lng IS NOT NULL""")
            except Exception:  # noqa: BLE001
                log.warning("şube koordinatları kopyalanamadı", exc_info=True)
            ayar_yaz(cur, "sube_konum_kopya", "1", "kurulum")
        if ayar_oku(cur, "konum_muaf_kopya") is None:
            try:
                with savepoint(cur, "sp_ey_muaf_kopya"):
                    cur.execute("""UPDATE ey_personel e SET konum_muaf = TRUE FROM personel p
                                    WHERE p.id::text = e.id AND COALESCE(p.panel_yonetici, FALSE)""")
            except Exception:  # noqa: BLE001
                log.warning("konum muafiyeti kopyalanamadı", exc_info=True)
            ayar_yaz(cur, "konum_muaf_kopya", "1", "kurulum")
    _HAZIR = True


# ─────────────────────────── QR jetonu ───────────────────────────
def _giz(cur) -> bytes:
    import os
    g = os.getenv("EVVEL_QR_GIZ") or ayar_oku(cur, "qr_giz") or ""
    if not g:
        raise HTTPException(503, "QR sırrı hazır değil")
    return g.encode("utf-8")


def _dilim(t: Optional[float] = None) -> int:
    return int((t if t is not None else time.time()) // QR_DILIM_SN)


def qr_jeton(cur, sube_id: str, dilim: Optional[int] = None) -> str:
    """PUBLIC: şubeye bağlı, 60 sn dilimli jeton (sunucu saati)."""
    d = _dilim() if dilim is None else dilim
    m = hmac.new(_giz(cur), f"{sube_id}:{d}".encode("utf-8"), hashlib.sha256).digest()
    return base64.b32encode(m).decode("ascii")[:10].lower()


def qr_dogrula(cur, sube_id: str, jeton: str) -> Optional[int]:
    """PUBLIC: geçerli dilimi döner (şimdiki ya da bir önceki → ömür 60–120 sn); değilse None."""
    j = (jeton or "").strip().lower()
    for d in (_dilim(), _dilim() - 1):
        if j and hmac.compare_digest(j, qr_jeton(cur, sube_id, d)):
            return d
    return None


# ─────────────────────────── Konum ───────────────────────────
def _haversine_m(a1, o1, a2, o2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a1), math.radians(a2)
    dp, dl = math.radians(a2 - a1), math.radians(o2 - o1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def konum_kontrol(cur, sube_id: str, personel: dict, lat, lng) -> dict:
    """PUBLIC: {mesafe_m, muaf}. Yönetici muaf (K2); şube koordinatsızsa serbest (K3). Uzaksa 403."""
    if personel.get("konum_muaf"):
        return {"mesafe_m": None, "muaf": True}
    cur.execute("SELECT lat, lng, yaricap_m FROM ey_sube WHERE id=%s", (sube_id,))
    s = dict(cur.fetchone() or {})
    if s.get("lat") is None or s.get("lng") is None:
        return {"mesafe_m": None, "muaf": False}
    if lat is None or lng is None:
        raise HTTPException(403, "Konum izni gerekli")
    m = _haversine_m(float(lat), float(lng), float(s["lat"]), float(s["lng"]))
    if m > int(s.get("yaricap_m") or VARSAYILAN_YARICAP):
        raise HTTPException(403, f"Şubeden uzaksın ({int(m)} m)")
    return {"mesafe_m": int(m), "muaf": False}


# ─────────────────────────── Cihaz kimliği (imzalı istek) ───────────────────────────
def _b64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _imza_dogru(jwk: dict, mesaj: bytes, imza_b64: str) -> bool:
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
            return False
        pub = ec.EllipticCurvePublicNumbers(int.from_bytes(_b64u(jwk["x"]), "big"), int.from_bytes(_b64u(jwk["y"]), "big"),
                                            ec.SECP256R1()).public_key()
        ham = base64.b64decode(imza_b64)
        if len(ham) != 64:   # WebCrypto ECDSA çıktısı r||s (64 bayt)
            return False
        der = encode_dss_signature(int.from_bytes(ham[:32], "big"), int.from_bytes(ham[32:], "big"))
        try:
            pub.verify(der, mesaj, ec.ECDSA(hashes.SHA256()))
            return True
        except InvalidSignature:
            return False
    except Exception:  # noqa: BLE001
        log.warning("imza doğrulanamadı", exc_info=True)
        return False


def cihaz_coz(cur, basliklar, method: str, yol: str, govde: bytes, tur: Optional[str] = None) -> dict:
    """PUBLIC: imzalı istekten cihazı çözer → {cihaz_id, tur, personel_id, sube_id, guc}. personel kimliği İSTEMCİDEN gelmez."""
    cid = (basliklar.get("x-evvel-cihaz") or "").strip()
    if not cid:
        raise HTTPException(403, "Bu cihaz tanımlı değil")
    cur.execute("SELECT * FROM ey_cihaz WHERE id=%s", (cid,))
    c = cur.fetchone()
    if c and dict(c)["durum"] == "onay":
        raise HTTPException(403, "Bu tablet merkez onayı bekliyor")
    if not c or dict(c)["durum"] != "aktif":
        raise HTTPException(403, "Bu cihaz tanımlı değil ya da iptal edildi — merkezden bağlantı iste")
    c = dict(c)
    if tur and c["tur"] != tur:
        raise HTTPException(403, "Bu işlem bu cihazdan yapılamaz")
    if c["guc"] == "anahtar":
        try:
            z = int(basliklar.get("x-evvel-zaman") or "0")
        except ValueError:
            z = 0
        if abs(time.time() - z) > SAAT_PAYI_SN:
            raise HTTPException(403, "Cihaz saati yanlış ya da istek eski — tekrar dene")
        nonce = (basliklar.get("x-evvel-nonce") or "").strip()[:64]
        imza = (basliklar.get("x-evvel-imza") or "").strip()
        mesaj = f"{cid}|{z}|{nonce}|{method.upper()}|{yol}|{hashlib.sha256(govde or b'').hexdigest()}".encode("utf-8")
        jwk = c["acik_anahtar"] if isinstance(c["acik_anahtar"], dict) else json.loads(c["acik_anahtar"] or "{}")
        if not nonce or not _imza_dogru(jwk, mesaj, imza):
            raise HTTPException(403, "Cihaz doğrulanamadı")
        cur.execute("INSERT INTO ey_cihaz_nonce (cihaz_id, nonce) VALUES (%s,%s) ON CONFLICT DO NOTHING RETURNING nonce", (cid, nonce))
        if not cur.fetchone():
            raise HTTPException(409, "Bu istek zaten işlendi")
    else:   # zayıf bağ (eski tarayıcı) — merkez "zayıf bağ" görür
        j = (basliklar.get("x-evvel-cihaz-jeton") or "").strip()
        if not j or not c.get("jeton_hash") or not hmac.compare_digest(hashlib.sha256(j.encode()).hexdigest(), c["jeton_hash"]):
            raise HTTPException(403, "Cihaz doğrulanamadı")
    cur.execute("UPDATE ey_cihaz SET son_kullanim=NOW() WHERE id=%s", (cid,))
    if secrets.randbelow(50) == 0:
        cur.execute("DELETE FROM ey_cihaz_nonce WHERE zaman < NOW() - INTERVAL '10 minutes'")
    return {"cihaz_id": cid, "tur": c["tur"], "personel_id": c.get("personel_id"), "sube_id": c.get("sube_id"), "guc": c["guc"]}


# ─────────────────────────── PUBLIC okuma servisleri (panel / maaş bunları çağırır) ───────────────────────────
def _personel(cur, pid: str) -> dict:
    cur.execute("SELECT id, ad, sube_id, aktif, konum_muaf, mudur FROM ey_personel WHERE id=%s", (pid,))
    r = cur.fetchone()
    if not r or not dict(r)["aktif"]:
        raise HTTPException(403, "Personel kaydı aktif değil")
    return dict(r)


def bugun_girenler(cur, sube_id: str, gun: Optional[date] = None) -> list:
    """PUBLIC: şubenin iş günündeki girişleri (kişi başına son satır): ad · giriş · çıkış."""
    yoklama_hazirla()
    g = gun or is_gunu()
    cur.execute("""SELECT DISTINCT ON (y.personel_id) y.personel_id, p.ad, y.giris_ts, y.cikis_ts, y.cikis_tur,
                          EXISTS (SELECT 1 FROM ey_mola m WHERE m.personel_id=y.personel_id AND m.bitis_ts IS NULL) AS molada
                     FROM ey_yoklama y JOIN ey_personel p ON p.id = y.personel_id
                    WHERE y.sube_id=%s AND y.is_gunu=%s ORDER BY y.personel_id, y.giris_ts DESC""", (sube_id, g))
    out = [{"personel_id": r["personel_id"], "ad": r["ad"], "giris": _saat(r["giris_ts"]), "cikis": _saat(r["cikis_ts"]),
            "cikis_tur": r["cikis_tur"], "acik": r["cikis_ts"] is None, "molada": bool(r["molada"]) and r["cikis_ts"] is None}
           for r in [dict(x) for x in cur.fetchall() or []]]
    out.sort(key=lambda x: (not x["acik"], x["giris"] or ""))
    return out


def acik_mi(cur, sube_id: str, personel_id: str) -> bool:
    """PUBLIC: kişinin bu şubede açık (çıkış yapılmamış) girişi var mı (panel ad listesi / kapısı)."""
    yoklama_hazirla()
    cur.execute("SELECT 1 FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND cikis_ts IS NULL", (personel_id, sube_id))
    return bool(cur.fetchone())


def personel_kilidi(cur, personel_id: str) -> None:
    """PUBLIC: kişinin yoklama işlemleri sıraya girer (telefon giriş/çıkış ile panel kapanışı yarışmasın)."""
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_yoklama:" + str(personel_id),))


def girdi_mi(cur, sube_id: str, personel_id: str, gun: date) -> bool:
    """PUBLIC: kişi o iş gününde bu şubeye QR'la girmiş mi (açık ya da kapanmış). Kapanış tekrarı / geç kapanış için (K11)."""
    yoklama_hazirla()
    cur.execute("SELECT 1 FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND is_gunu=%s LIMIT 1", (personel_id, sube_id, gun))
    return bool(cur.fetchone())


def cikis_yaz(cur, personel_id: str, tur: str, kim: Optional[str] = None, mesafe: Optional[int] = None,
              cihaz_id: Optional[str] = None, istek_id: Optional[str] = None, sube_id: Optional[str] = None) -> Optional[str]:
    """PUBLIC: açık girişi kapatır (tur: qr / devir / kapanis / merkez). sube_id verilirse yalnız o şubedeki açık giriş.
    Açık giriş yoksa sessizce None (zaten çıkmış)."""
    yoklama_hazirla()
    personel_kilidi(cur, personel_id)
    cur.execute("SELECT id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL AND (%s::text IS NULL OR sube_id=%s) FOR UPDATE",
                (personel_id, sube_id, sube_id))
    r = cur.fetchone()
    if not r:
        return None
    yid = dict(r)["id"]
    cur.execute("""UPDATE ey_yoklama SET cikis_ts=NOW(), cikis_tur=%s, cikis_mesafe_m=%s, cikis_cihaz_id=%s, cikis_istek_id=%s,
                          degistiren=COALESCE(%s, degistiren) WHERE id=%s""", (tur, mesafe, cihaz_id, istek_id, kim, yid))
    _mola_kapat(cur, personel_id, tur, kim=kim)   # D6: çıkış / devir / kapanış açık molayı da kapatır (hak o anda hesaplanır)
    return yid


# ─────────────────────────── Yemek molası (K7 / K8) ───────────────────────────
def mola_limit(cur) -> int:
    try:
        return int(ayar_oku(cur, "mola_limit_dk", "60") or 60)
    except ValueError:
        return 60


def _mola_kapat(cur, personel_id: str, tur: str, ts=None, mesafe: Optional[int] = None, istek_id: Optional[str] = None,
                kim: Optional[str] = None) -> Optional[dict]:
    """Açık molayı bitirir: süre + yemek hakkı (≤ limit). Açık mola yoksa None."""
    cur.execute("SELECT id, baslangic_ts FROM ey_mola WHERE personel_id=%s AND bitis_ts IS NULL FOR UPDATE", (personel_id,))
    r = cur.fetchone()
    if not r:
        return None
    r = dict(r)
    if ts is not None and ts < r["baslangic_ts"]:
        raise HTTPException(400, f"Saat molanın başlangıcından ({_saat(r['baslangic_ts'])}) önce olamaz")   # Codex: sahte hak üretmesin
    bit = ts if ts is not None else max(datetime.now(timezone.utc), r["baslangic_ts"])   # Codex 2: saat kayması kapanışı geri aldırmasın
    sn = (bit - r["baslangic_ts"]).total_seconds()
    sure = int(sn // 60)
    hak = sn <= mola_limit(cur) * 60   # Codex: 60 dk 59 sn hak değil
    cur.execute("""UPDATE ey_mola SET bitis_ts=%s, bitis_tur=%s, bitis_mesafe_m=%s, bitis_istek_id=%s, sure_dk=%s, yemek_hakki=%s,
                          degistiren=COALESCE(%s, degistiren) WHERE id=%s""", (bit, tur, mesafe, istek_id, sure, hak, kim, r["id"]))
    return {"id": r["id"], "sure_dk": sure, "yemek_hakki": hak}


def _mola_durum(cur, personel_id: str, gun: date) -> Optional[dict]:
    cur.execute("""SELECT * FROM ey_mola WHERE personel_id=%s AND (is_gunu=%s OR bitis_ts IS NULL)
                    ORDER BY (bitis_ts IS NULL) DESC LIMIT 1""", (personel_id, gun))
    m = cur.fetchone()
    if not m:
        return None
    m = dict(m)
    lim = mola_limit(cur)
    if m["bitis_ts"] is None:
        sn = max(0, (datetime.now(timezone.utc) - m["baslangic_ts"]).total_seconds())
        return {"durum": "suruyor", "bas": _saat(m["baslangic_ts"]), "sure_dk": int(sn // 60), "limit_dk": lim, "hak_dustu": sn > lim * 60}
    return {"durum": "bitti", "bas": _saat(m["baslangic_ts"]), "bit": _saat(m["bitis_ts"]), "sure_dk": m["sure_dk"], "limit_dk": lim,
            "hak_dustu": not m["yemek_hakki"] and not m["hak_elle"]}


def yemek_ozet(cur, bas: date, son: date) -> dict:
    """PUBLIC (Maaş yemek kalemi, F4): kişi → {calisilan_gun, hak_gun, dusen:[{gun, sure_dk}]} + müdür listesi.
    Çalışılan gün = QR girişi ∪ panel izi (F1a). Hak gün = molası ≤ limit ya da merkezin elle verdiği gün (K7; K8: molasız gün hak yok)."""
    yoklama_hazirla()
    gunler: dict = {}
    cur.execute("SELECT personel_id, is_gunu FROM ey_yoklama WHERE is_gunu BETWEEN %s AND %s", (bas, son))
    for r in [dict(x) for x in cur.fetchall() or []]:
        gunler.setdefault(r["personel_id"], set()).add(r["is_gunu"])
    try:
        from evvel_yeni_olay import olaylar
        for o in olaylar(cur, bas=bas, son=son):
            if (o.get("kaynak_tablo") or "") == "panel" and not o.get("iptal") and o.get("personel_id"):
                gunler.setdefault(str(o["personel_id"]), set()).add(o["is_gunu"])
    except Exception:  # noqa: BLE001
        log.warning("yemek özeti: panel izi okunamadı", exc_info=True)
    hak: dict = {}
    dusen: dict = {}
    cur.execute("""SELECT personel_id, is_gunu, sure_dk, yemek_hakki, hak_elle FROM ey_mola
                    WHERE is_gunu BETWEEN %s AND %s AND bitis_ts IS NOT NULL ORDER BY is_gunu""", (bas, son))
    for r in [dict(x) for x in cur.fetchall() or []]:
        gunler.setdefault(r["personel_id"], set()).add(r["is_gunu"])
        if r["yemek_hakki"] or r["hak_elle"]:
            hak[r["personel_id"]] = hak.get(r["personel_id"], 0) + 1
        else:
            dusen.setdefault(r["personel_id"], []).append({"gun": r["is_gunu"].isoformat(), "sure_dk": r["sure_dk"]})
    cur.execute("SELECT id FROM ey_personel WHERE mudur")
    mudur = {dict(r)["id"] for r in cur.fetchall() or []}
    return {"mudur": mudur, "limit_dk": mola_limit(cur), "kisi": {pid: {"calisilan_gun": len(g), "hak_gun": hak.get(pid, 0), "dusen": dusen.get(pid, [])}
                                     for pid, g in gunler.items()}}


def son_okutanlar(cur, sube_id: str, sn: int = 300) -> list:
    """PUBLIC: panelde canlı 'son okutanlar' (yabancı ad hemen görülsün)."""
    cur.execute("""SELECT q.islem, q.zaman, p.ad FROM ey_qr_kullanim q JOIN ey_personel p ON p.id = q.personel_id
                    WHERE q.sube_id=%s AND q.zaman > NOW() - (%s || ' seconds')::interval ORDER BY q.zaman DESC LIMIT 8""", (sube_id, str(sn)))
    return [{"ad": r["ad"], "islem": r["islem"], "saat": _saat(r["zaman"])} for r in [dict(x) for x in cur.fetchall() or []]]


def _saat(ts) -> Optional[str]:
    if not ts:
        return None
    from zoneinfo import ZoneInfo
    try:
        return (ts.astimezone(ZoneInfo("Europe/Istanbul")) if getattr(ts, "tzinfo", None) else ts).strftime("%H:%M")
    except Exception:  # noqa: BLE001
        return None


# ─────────────────────────── MERKEZ: cihaz yönetimi ───────────────────────────
def _merkez(cur, jeton: Optional[str]) -> str:
    kim = _aktor(cur, jeton)
    if kim in ("oturumsuz", "bilinmiyor"):
        raise HTTPException(401, "Merkez oturumu gerekli")
    return kim


class DavetBody(BaseModel):
    personel_id: Optional[str] = None
    sube_id: Optional[str] = None
    etiket: Optional[str] = None


@router.post("/cihaz/davet")
def cihaz_davet(b: DavetBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: kişiye (telefon) ya da şubeye (tablet) tek kullanımlık bağlantı linki (48 saat). Link bir kez gösterilir."""
    yoklama_hazirla()
    if bool(b.personel_id) == bool(b.sube_id):
        raise HTTPException(400, "Kişi ya da şube seç")
    kod = secrets.token_urlsafe(18)
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        if b.personel_id:
            p = _personel(cur, b.personel_id)
            ad = p["ad"]
        else:
            cur.execute("SELECT ad FROM ey_sube WHERE id=%s AND aktif", (b.sube_id,))
            r = cur.fetchone()
            if not r:
                raise HTTPException(404, "Şube bulunamadı")
            ad = dict(r)["ad"]
        cid = "cz-" + uuid.uuid4().hex[:16]
        cur.execute("""INSERT INTO ey_cihaz (id, tur, personel_id, sube_id, etiket, durum, davet_hash, davet_son, olusturan)
                       VALUES (%s,%s,%s,%s,%s,'davet',%s, NOW() + (%s || ' hours')::interval, %s)""",
                    (cid, "telefon" if b.personel_id else "tablet", b.personel_id, b.sube_id, (b.etiket or "")[:60] or None,
                     hashlib.sha256(kod.encode()).hexdigest(), str(DAVET_SAAT), kim))
    return {"ok": True, "cihaz_id": cid, "yol": f"/q/bagla/{kod}", "ad": ad, "gecerlilik_saat": DAVET_SAAT,
            "mesaj": f"{ad} için bağlantı linki hazır (48 saat, tek kullanım)"}


class BaglaBody(BaseModel):
    davet: str
    acik_anahtar: Optional[dict] = None   # WebCrypto P-256 JWK (önerilen)
    jeton: Optional[str] = None           # eski tarayıcı geri düşüşü (zayıf bağ)
    etiket: Optional[str] = None


@router.post("/cihaz-bagla")
def cihaz_bagla(b: BaglaBody):
    """Telefon / tablet linki açınca: davet tek kullanım. Telefon hemen aktif (K9 uzaktan olur); tablet merkez onayı bekler."""
    yoklama_hazirla()
    h = hashlib.sha256((b.davet or "").encode()).hexdigest()
    with db() as (conn, cur):
        cur.execute("SELECT * FROM ey_cihaz WHERE davet_hash=%s FOR UPDATE", (h,))
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, "Bağlantı geçersiz — merkezden yeni link iste")
        c = dict(c)
        if c["durum"] != "davet":
            raise HTTPException(409, "Bu bağlantı zaten kullanıldı — merkezden yeni link iste")
        if c["davet_son"] and c["davet_son"] < datetime.now(c["davet_son"].tzinfo):
            raise HTTPException(410, "Bağlantının süresi doldu — merkezden yeni link iste")
        if b.acik_anahtar:
            j = b.acik_anahtar
            if j.get("kty") != "EC" or j.get("crv") != "P-256" or not j.get("x") or not j.get("y") or j.get("d"):
                raise HTTPException(400, "Anahtar geçersiz")
            guc, anahtar, jh = "anahtar", json.dumps({k: j[k] for k in ("kty", "crv", "x", "y")}), None
        elif b.jeton and len(b.jeton) >= 32:
            guc, anahtar, jh = "jeton", None, hashlib.sha256(b.jeton.encode()).hexdigest()
        else:
            raise HTTPException(400, "Cihaz anahtarı gerekli")
        durum = "aktif" if c["tur"] == "telefon" else "onay"
        cur.execute("""UPDATE ey_cihaz SET acik_anahtar=%s::jsonb, jeton_hash=%s, guc=%s, durum=%s, davet_hash=NULL,
                              etiket=COALESCE(etiket, %s) WHERE id=%s""",
                    (anahtar, jh, guc, durum, (b.etiket or "")[:60] or None, c["id"]))
        if c["personel_id"]:
            cur.execute("SELECT ad FROM ey_personel WHERE id=%s", (c["personel_id"],))
        else:
            cur.execute("SELECT ad FROM ey_sube WHERE id=%s", (c["sube_id"],))
        ad = dict(cur.fetchone() or {}).get("ad")
    return {"ok": True, "cihaz_id": c["id"], "tur": c["tur"], "durum": durum, "ad": ad, "guc": guc,
            "mesaj": (f"Bu telefon artık {ad} adına" if c["tur"] == "telefon" else f"Tablet {ad} için kaydedildi — merkez onayı bekleniyor")}


@router.post("/cihaz/{cid}/onayla")
def cihaz_onayla(cid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        cur.execute("UPDATE ey_cihaz SET durum='aktif' WHERE id=%s AND durum='onay' AND tur='tablet' RETURNING id", (cid,))
        if not cur.fetchone():
            raise HTTPException(404, "Onay bekleyen tablet bulunamadı")
    return {"ok": True, "mesaj": "Tablet onaylandı"}


@router.post("/cihaz/{cid}/iptal")
def cihaz_iptal(cid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        cur.execute("UPDATE ey_cihaz SET durum='iptal', iptal_zaman=NOW(), davet_hash=NULL WHERE id=%s AND durum<>'iptal' RETURNING id", (cid,))
        if not cur.fetchone():
            raise HTTPException(404, "Cihaz bulunamadı")
    return {"ok": True, "mesaj": "Cihaz iptal edildi — bu telefon/tablet artık çalışmaz"}


@router.get("/cihazlar")
def cihazlar(x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez Personel › Telefonlar: aktif personel → telefonu var/yok; şube → tablet. (Link kodu gösterilmez.)"""
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        cur.execute("""SELECT p.id, p.ad, p.sube_id, s.ad AS sube_ad, p.konum_muaf, p.mudur FROM ey_personel p
                         LEFT JOIN ey_sube s ON s.id = p.sube_id WHERE p.aktif ORDER BY s.ad NULLS LAST, p.ad""")
        per = [dict(r) for r in cur.fetchall() or []]
        cur.execute("""SELECT id, tur, personel_id, sube_id, guc, etiket, durum, davet_son, olusturma, son_kullanim
                         FROM ey_cihaz WHERE durum<>'iptal' ORDER BY olusturma DESC""")
        cz = [dict(r) for r in cur.fetchall() or []]
        cur.execute("SELECT id, ad, lat IS NOT NULL AS konum FROM ey_sube WHERE aktif ORDER BY ad")
        subeler = [dict(r) for r in cur.fetchall() or []]
    def _c(x):
        return {"id": x["id"], "guc": x["guc"], "etiket": x["etiket"], "durum": x["durum"],
                "son_kullanim": str(x["son_kullanim"])[:16] if x["son_kullanim"] else None,
                "davet_son": str(x["davet_son"])[:16] if x["davet_son"] else None}
    return {"personel": [{**p, "cihazlar": [_c(x) for x in cz if x["personel_id"] == p["id"]]} for p in per],
            "subeler": [{**s, "tabletler": [_c(x) for x in cz if x["sube_id"] == s["id"]]} for s in subeler]}


# ─────────────────────────── TABLET: QR üretimi (yalnız kayıtlı tablet) ───────────────────────────
@router.get("/qr.png")
async def qr_png(request: Request):
    """Tabletin imzalı isteğiyle dönen QR resmi. Uzaktan 'güncel QR'ı çekmek' kapalı (Codex)."""
    yoklama_hazirla()

    def _is():
        with db() as (conn, cur):
            c = cihaz_coz(cur, request.headers, "GET", request.url.path, b"", tur="tablet")
            return c["sube_id"], qr_jeton(cur, c["sube_id"])
    sube_id, jeton = await run_in_threadpool(_is)
    import io
    import os
    import qrcode
    taban = os.getenv("APP_URL", "https://evvel-erp-production.up.railway.app").rstrip("/")
    q = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=3)
    q.add_data(f"{taban}/q/{sube_id}/{jeton}")
    q.make(fit=True)
    buf = io.BytesIO()
    q.make_image(fill_color="black", back_color="white").save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


# ─────────────────────────── TELEFON: durum / giriş / çıkış (imzalı) ───────────────────────────
async def _telefon(request: Request, fn):
    yoklama_hazirla()
    govde = await request.body()

    def _is():
        with db() as (conn, cur):
            c = cihaz_coz(cur, request.headers, request.method, request.url.path, govde, tur="telefon")
            p = _personel(cur, c["personel_id"])
            try:
                veri = json.loads(govde) if govde else {}
            except ValueError:
                raise HTTPException(400, "İstek okunamadı")
            if not isinstance(veri, dict):
                raise HTTPException(400, "İstek okunamadı")
            return fn(cur, c, p, veri)
    return await run_in_threadpool(_is)


@router.get("/ben")
async def ben(request: Request, sube: Optional[str] = None):
    """Telefon ekranı: kim, hangi şube, bugün giriş / çıkış, yapabileceği tek düğme."""
    def fn(cur, c, p, _v):
        cur.execute("""SELECT y.*, s.ad AS sube_ad FROM ey_yoklama y LEFT JOIN ey_sube s ON s.id=y.sube_id
                        WHERE y.personel_id=%s ORDER BY y.giris_ts DESC LIMIT 1""", (p["id"],))
        son = dict(cur.fetchone() or {})
        acik = bool(son) and son.get("cikis_ts") is None
        sube_ad = None
        if sube:
            cur.execute("SELECT ad FROM ey_sube WHERE id=%s", (sube,))
            sube_ad = dict(cur.fetchone() or {}).get("ad")
        mola = _mola_durum(cur, p["id"], is_gunu())
        burada = acik and son.get("sube_id") == sube
        yap = ["giris"] if not acik and sube else []
        if burada:
            yap = (["mola_bitir"] if mola and mola["durum"] == "suruyor" else ([] if mola else ["mola_baslat"])) + ["cikis"]
        return {"kisi": p["ad"], "muaf": bool(p.get("konum_muaf")), "gun": is_gunu().isoformat(), "sube": sube, "sube_ad": sube_ad,
                "mola": mola,
                "acik": acik, "acik_sube": son.get("sube_id") if acik else None, "acik_sube_ad": son.get("sube_ad") if acik else None,
                "giris": _saat(son.get("giris_ts")) if son and son.get("is_gunu") == is_gunu() else None,
                "cikis": _saat(son.get("cikis_ts")) if son and son.get("is_gunu") == is_gunu() else None,
                "yapabilir": yap}
    return await _telefon(request, fn)


def _qr_islem(cur, c, p, v, islem: str) -> tuple:
    sube = str(v.get("sube") or "")
    cur.execute("SELECT 1 FROM ey_sube WHERE id=%s AND aktif", (sube,))
    if not cur.fetchone():
        raise HTTPException(404, "Şube bulunamadı")
    d = qr_dogrula(cur, sube, str(v.get("qr") or ""))
    if d is None:
        raise HTTPException(409, "QR süresi doldu — tekrar okut")
    k = konum_kontrol(cur, sube, p, v.get("lat"), v.get("lng"))
    cur.execute("""INSERT INTO ey_qr_kullanim (sube_id, dilim, personel_id, islem) VALUES (%s,%s,%s,%s)
                   ON CONFLICT DO NOTHING RETURNING sube_id""", (sube, d, p["id"], islem))
    if not cur.fetchone():
        raise HTTPException(409, "Bu QR ile bu işlem zaten yapıldı — yeni QR'ı okut")
    return sube, k


def _istek(v) -> str:
    i = str(v.get("istek_id") or "")
    if not (8 <= len(i) <= 64) or not all(ch.isalnum() or ch == "-" for ch in i):
        raise HTTPException(400, "İstek kimliği geçersiz")
    return i


@router.post("/giris")
async def giris(request: Request):
    """QR + konum ile giriş. Açık girişi varsa: aynı şubeyse aynı kayıt; başka şubeyse önce çıkış (K11). Çıkıştan sonra yeni satır (K4)."""
    def fn(cur, c, p, v):
        ist = _istek(v)
        personel_kilidi(cur, p["id"])
        cur.execute("SELECT personel_id, giris_ts FROM ey_yoklama WHERE istek_id=%s", (ist,))
        r = cur.fetchone()
        if r:
            if dict(r)["personel_id"] != p["id"]:
                raise HTTPException(409, "İstek kimliği başka bir kayda ait — tekrar dene")
            return {"ok": True, "tekrar": True, "mesaj": f"Giriş zaten kaydedildi · {_saat(dict(r)['giris_ts'])}"}
        cur.execute("SELECT y.id, y.sube_id, s.ad FROM ey_yoklama y LEFT JOIN ey_sube s ON s.id=y.sube_id "
                    "WHERE y.personel_id=%s AND y.cikis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        sube, k = _qr_islem(cur, c, p, v, "giris")
        if a:
            a = dict(a)
            if a["sube_id"] == sube:
                return {"ok": True, "tekrar": True, "mesaj": "Zaten girişin var"}
            raise HTTPException(409, f"Önce {a['ad'] or 'diğer şube'}'den çıkış yap")
        cur.execute("""INSERT INTO ey_yoklama (id, sube_id, personel_id, is_gunu, giris_ts, giris_mesafe_m, giris_muaf, giris_cihaz_id, istek_id)
                       VALUES (%s,%s,%s,%s,NOW(),%s,%s,%s,%s)""",
                    ("yk-" + uuid.uuid4().hex[:16], sube, p["id"], is_gunu(), k["mesafe_m"], k["muaf"], c["cihaz_id"], ist))
        return {"ok": True, "mesaj": f"Giriş kaydedildi · {_saat(datetime.now(timezone.utc))}"}
    return await _telefon(request, fn)


@router.post("/cikis")
async def cikis(request: Request):
    def fn(cur, c, p, v):
        ist = _istek(v)
        personel_kilidi(cur, p["id"])
        cur.execute("SELECT personel_id, cikis_ts FROM ey_yoklama WHERE cikis_istek_id=%s", (ist,))
        r = cur.fetchone()
        if r:
            if dict(r)["personel_id"] != p["id"]:
                raise HTTPException(409, "İstek kimliği başka bir kayda ait — tekrar dene")
            return {"ok": True, "tekrar": True, "mesaj": f"Çıkış zaten kaydedildi · {_saat(dict(r)['cikis_ts'])}"}
        cur.execute("SELECT sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        if not a:
            raise HTTPException(409, "Açık girişin yok")
        sube, k = _qr_islem(cur, c, p, v, "cikis")
        if dict(a)["sube_id"] != sube:
            raise HTTPException(409, "Girişin başka şubede — o şubenin QR'ını okut")
        cikis_yaz(cur, p["id"], "qr", mesafe=k["mesafe_m"], cihaz_id=c["cihaz_id"], istek_id=ist)
        return {"ok": True, "mesaj": f"Çıkış kaydedildi · {_saat(datetime.now(timezone.utc))}. İyi günler."}
    return await _telefon(request, fn)


# ─────────────────────────── MERKEZ: okuma + düzeltme ───────────────────────────
@router.get("/gunler")
def gunler(bas: Optional[str] = None, son: Optional[str] = None, acik: bool = False,
           x_evvel_oturum: Optional[str] = Header(default=None)):
    """acik=1: iş günü geçmiş, çıkışı yazılmamış TÜM kayıtlar (Bekleyen işler ile aynı ölçüt)."""
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        if acik:
            cur.execute("""SELECT y.*, p.ad, s.ad AS sube_ad FROM ey_yoklama y JOIN ey_personel p ON p.id=y.personel_id
                             LEFT JOIN ey_sube s ON s.id=y.sube_id WHERE y.cikis_ts IS NULL AND y.is_gunu < %s
                            ORDER BY y.is_gunu, y.giris_ts""", (is_gunu(),))
        elif bas and son:
            cur.execute("""SELECT y.*, p.ad, s.ad AS sube_ad FROM ey_yoklama y JOIN ey_personel p ON p.id=y.personel_id
                             LEFT JOIN ey_sube s ON s.id=y.sube_id WHERE y.is_gunu BETWEEN %s AND %s ORDER BY y.is_gunu, y.giris_ts""", (bas, son))
        else:
            raise HTTPException(400, "bas/son ya da acik=1")
        rows = [dict(r) for r in cur.fetchall() or []]
    return {"satirlar": [{"id": r["id"], "gun": r["is_gunu"].isoformat(), "ad": r["ad"], "sube": r["sube_ad"], "giris": _saat(r["giris_ts"]),
                          "cikis": _saat(r["cikis_ts"]), "cikis_tur": r["cikis_tur"], "mesafe": r["giris_mesafe_m"], "muaf": r["giris_muaf"]}
                         for r in rows]}


class DuzeltBody(BaseModel):
    yoklama_id: str
    cikis_saat: str          # "HH:MM" (o iş gününün saati; 00–02 arası ertesi takvim günü)
    aciklama: str


@router.post("/duzelt")
def duzelt(b: DuzeltBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: çıkış yapılmamış girişe çıkış saati yazar (tur merkez) + iz."""
    yoklama_hazirla()
    try:
        hh, mm = [int(x) for x in (b.cikis_saat or "").split(":")]
        assert 0 <= hh <= 23 and 0 <= mm <= 59
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Saat SS:DD olmalı")
    if len((b.aciklama or "").strip()) < 2:
        raise HTTPException(400, "Açıklama yaz")
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        cur.execute("SELECT personel_id FROM ey_yoklama WHERE id=%s", (b.yoklama_id,))
        k0 = cur.fetchone()
        if k0:
            personel_kilidi(cur, dict(k0)["personel_id"])   # Codex: telefondan mola başlatma ile yarışmasın
        cur.execute("SELECT * FROM ey_yoklama WHERE id=%s FOR UPDATE", (b.yoklama_id,))
        r = cur.fetchone()
        if not r or dict(r)["cikis_ts"] is not None:
            raise HTTPException(404, "Açık giriş bulunamadı")
        r = dict(r)
        from zoneinfo import ZoneInfo
        g = r["is_gunu"] + (timedelta(days=1) if hh < 2 else timedelta(0))
        ts = datetime(g.year, g.month, g.day, hh, mm, tzinfo=ZoneInfo("Europe/Istanbul"))
        if ts < r["giris_ts"]:
            raise HTTPException(400, "Çıkış girişten önce olamaz")
        iz = f"merkez: {kim} — {b.aciklama.strip()[:120]}"
        cur.execute("UPDATE ey_yoklama SET cikis_ts=%s, cikis_tur='merkez', degistiren=%s WHERE id=%s", (ts, iz, r["id"]))
        _mola_kapat(cur, r["personel_id"], "merkez", ts=ts, kim=iz)
    return {"ok": True, "mesaj": "Çıkış saati yazıldı"}


# ─────────────────────────── TELEFON: yemek molası (QR + konum, giriş gibi) ───────────────────────────
@router.post("/mola-baslat")
async def mola_baslat(request: Request):
    def fn(cur, c, p, v):
        ist = _istek(v)
        personel_kilidi(cur, p["id"])
        cur.execute("SELECT personel_id, baslangic_ts FROM ey_mola WHERE istek_id=%s", (ist,))
        r = cur.fetchone()
        if r:
            if dict(r)["personel_id"] != p["id"]:
                raise HTTPException(409, "İstek kimliği başka bir kayda ait — tekrar dene")
            return {"ok": True, "tekrar": True, "mesaj": f"Mola zaten başladı · {_saat(dict(r)['baslangic_ts'])}"}
        cur.execute("SELECT id, sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        if not a:
            raise HTTPException(409, "Önce giriş yap")
        a = dict(a)
        sube, k = _qr_islem(cur, c, p, v, "mola_bas")
        if a["sube_id"] != sube:
            raise HTTPException(409, "Girişin başka şubede — o şubenin QR'ını okut")
        gun = is_gunu()
        cur.execute("SELECT is_gunu, bitis_ts FROM ey_mola WHERE personel_id=%s AND (is_gunu=%s OR bitis_ts IS NULL) LIMIT 1", (p["id"], gun))
        r = cur.fetchone()
        if r:
            raise HTTPException(409, "Molan zaten sürüyor — önce bitir" if dict(r)["bitis_ts"] is None else "Bugünkü yemek molanı kullandın")
        cur.execute("""INSERT INTO ey_mola (id, personel_id, sube_id, is_gunu, yoklama_id, baslangic_ts, baslangic_mesafe_m, istek_id)
                       VALUES (%s,%s,%s,%s,%s,NOW(),%s,%s)""",
                    ("ml-" + uuid.uuid4().hex[:16], p["id"], sube, gun, a["id"], k["mesafe_m"], ist))
        return {"ok": True, "mesaj": f"Yemek molası başladı · {_saat(datetime.now(timezone.utc))}"}
    return await _telefon(request, fn)


@router.post("/mola-bitir")
async def mola_bitir(request: Request):
    def fn(cur, c, p, v):
        ist = _istek(v)
        personel_kilidi(cur, p["id"])
        cur.execute("SELECT personel_id, sure_dk, yemek_hakki, bitis_ts FROM ey_mola WHERE bitis_istek_id=%s", (ist,))
        r = cur.fetchone()
        if r:
            r = dict(r)
            if r["personel_id"] != p["id"]:
                raise HTTPException(409, "İstek kimliği başka bir kayda ait — tekrar dene")
            return {"ok": True, "tekrar": True, "hak_dustu": not r["yemek_hakki"],
                    "mesaj": f"Mola zaten bitti · {_saat(r['bitis_ts'])} · {r['sure_dk']} dk" + ("" if r["yemek_hakki"] else " — Bugün yemek hakkı kazanılamadı")}
        cur.execute("SELECT sube_id FROM ey_mola WHERE personel_id=%s AND bitis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        if not a:
            raise HTTPException(409, "Açık molan yok")
        sube, k = _qr_islem(cur, c, p, v, "mola_bit")
        if dict(a)["sube_id"] != sube:
            raise HTTPException(409, "Molan başka şubede — o şubenin QR'ını okut")
        m = _mola_kapat(cur, p["id"], "qr", mesafe=k["mesafe_m"], istek_id=ist)
        return {"ok": True, "hak_dustu": not m["yemek_hakki"],   # K7: tek bilgi satırı (bildirim değil)
                "mesaj": f"Mola bitti · {_saat(datetime.now(timezone.utc))} · {m['sure_dk']} dk" + ("" if m["yemek_hakki"] else " — Bugün yemek hakkı kazanılamadı")}
    return await _telefon(request, fn)


# ─────────────────────────── MERKEZ: Personel › Yemek molaları ───────────────────────────
@router.get("/molalar")
def molalar(bas: Optional[str] = None, son: Optional[str] = None, acik: bool = False,
            x_evvel_oturum: Optional[str] = Header(default=None)):
    """Gün gün mola: kişi · şube · başlangıç–bitiş · süre · hak (✓ / ✗ / ✓ elle). acik=1: bitmemiş + görülmemiş uzun (Bekleyen işler ölçütü)."""
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        q = """SELECT m.*, p.ad, s.ad AS sube_ad FROM ey_mola m JOIN ey_personel p ON p.id=m.personel_id
                 LEFT JOIN ey_sube s ON s.id=m.sube_id WHERE """
        if acik:
            cur.execute(q + """(m.bitis_ts IS NULL AND (m.is_gunu < %s OR m.baslangic_ts < NOW() - (%s || ' minutes')::interval))
                                OR (m.yemek_hakki = FALSE AND NOT m.hak_elle AND m.gorulen IS NULL)
                                ORDER BY m.is_gunu, m.baslangic_ts""", (is_gunu(), str(mola_limit(cur))))
        elif bas and son:
            cur.execute(q + "m.is_gunu BETWEEN %s AND %s ORDER BY m.is_gunu, m.baslangic_ts", (bas, son))
        else:
            raise HTTPException(400, "bas/son ya da acik=1")
        rows = [dict(r) for r in cur.fetchall() or []]
        lim = mola_limit(cur)
    bugun = is_gunu()

    def _durum(r):
        if r["bitis_ts"] is None:
            return "suruyor" if r["is_gunu"] >= bugun else "bitmedi"
        return {"merkez": "merkez yazdı", "qr": "bitti"}.get(r["bitis_tur"], "çıkışla kapandı")
    return {"limit_dk": lim, "satirlar": [{
        "id": r["id"], "personel_id": r["personel_id"], "gun": r["is_gunu"].isoformat(), "ad": r["ad"], "sube": r["sube_ad"], "bas": _saat(r["baslangic_ts"]),
        "bit": _saat(r["bitis_ts"]), "sure_dk": r["sure_dk"], "durum": _durum(r), "yemek_hakki": r["yemek_hakki"],
        "hak_elle": r["hak_elle"], "hak_veren": r["hak_veren"], "hak_aciklama": r["hak_aciklama"],
        "hak_zaman": str(r["hak_zaman"])[:16] if r["hak_zaman"] else None, "gorulen": r["gorulen"], "mesafe": r["baslangic_mesafe_m"]}
        for r in rows]}


class MolaDuzeltBody(BaseModel):
    bitis_saat: str
    aciklama: str


class AciklamaBody(BaseModel):
    aciklama: Optional[str] = None


def _saat_coz(saat: str):
    try:
        hh, mm = [int(x) for x in (saat or "").split(":")]
        assert 0 <= hh <= 23 and 0 <= mm <= 59
        return hh, mm
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Saat SS:DD olmalı")


@router.post("/mola/{mid}/duzelt")
def mola_duzelt(mid: str, b: MolaDuzeltBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: bitmemiş molaya bitiş saati yazar → süre + hak hesaplanır + iz."""
    yoklama_hazirla()
    hh, mm = _saat_coz(b.bitis_saat)
    if len((b.aciklama or "").strip()) < 2:
        raise HTTPException(400, "Açıklama yaz")
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        cur.execute("SELECT personel_id, is_gunu, baslangic_ts FROM ey_mola WHERE id=%s AND bitis_ts IS NULL", (mid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Bitmemiş mola bulunamadı")
        r = dict(r)
        from zoneinfo import ZoneInfo
        g = r["is_gunu"] + (timedelta(days=1) if hh < 2 else timedelta(0))
        ts = datetime(g.year, g.month, g.day, hh, mm, tzinfo=ZoneInfo("Europe/Istanbul"))
        if ts < r["baslangic_ts"]:
            raise HTTPException(400, "Bitiş başlangıçtan önce olamaz")
        personel_kilidi(cur, r["personel_id"])
        m = _mola_kapat(cur, r["personel_id"], "merkez", ts=ts, kim=f"merkez: {kim} — {b.aciklama.strip()[:120]}")
    return {"ok": True, "mesaj": f"Mola bitişi yazıldı · {m['sure_dk'] if m else '?'} dk"}


@router.post("/mola/{mid}/hak-ver")
def mola_hak_ver(mid: str, b: AciklamaBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: uzun moladan düşen yemek hakkını elle verir (K7 'gerekirse ödemesini yaparız') — izli."""
    yoklama_hazirla()
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        cur.execute("""UPDATE ey_mola SET hak_elle=TRUE, hak_veren=%s, hak_zaman=NOW(), hak_aciklama=%s, gorulen=COALESCE(gorulen, %s)
                        WHERE id=%s AND bitis_ts IS NOT NULL AND yemek_hakki = FALSE AND NOT hak_elle RETURNING id""",
                    (kim, (b.aciklama or "").strip()[:200] or None, kim, mid))
        if not cur.fetchone():
            raise HTTPException(404, "Hakkı düşmüş mola bulunamadı")
    return {"ok": True, "mesaj": "Yemek hakkı elle verildi"}


@router.post("/mola/{mid}/gordum")
def mola_gordum(mid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: uzun molayı gördü (hak düşük kalır) → Bekleyen işlerden kalkar."""
    yoklama_hazirla()
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        cur.execute("UPDATE ey_mola SET gorulen=%s WHERE id=%s AND gorulen IS NULL RETURNING id", (kim, mid))
        if not cur.fetchone():
            raise HTTPException(404, "Mola bulunamadı")
    return {"ok": True, "mesaj": "Görüldü"}


# ─────────────────────────── Bekleyen işler (grup personel; personele gitmez) ───────────────────────────
def _bekleyen(cur, baglam: dict) -> list:
    yoklama_hazirla()
    out = []
    bugun = is_gunu()
    cur.execute("""SELECT y.id, y.is_gunu, p.ad, s.ad AS sube_ad FROM ey_yoklama y JOIN ey_personel p ON p.id=y.personel_id
                     LEFT JOIN ey_sube s ON s.id=y.sube_id WHERE y.cikis_ts IS NULL AND y.is_gunu < %s ORDER BY y.is_gunu""", (bugun,))
    for r in [dict(x) for x in cur.fetchall() or []]:
        out.append({"tur": "yoklama_cikis_yok", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                    "etiket": "🚪 Çıkış yok", "ad": f"{r['ad']} — {r['sube_ad'] or ''} {r['is_gunu'].strftime('%d.%m')} çıkış yapmadı",
                    "alt": "Çıkış saatini Personel › Telefonlar'dan yaz", "sayfa": "personel_telefon", "dugme": "Aç"})
    cur.execute("""SELECT m.id, m.is_gunu, m.sure_dk, m.bitis_ts, p.ad, s.ad AS sube_ad FROM ey_mola m
                     JOIN ey_personel p ON p.id=m.personel_id LEFT JOIN ey_sube s ON s.id=m.sube_id
                    WHERE (m.bitis_ts IS NULL AND (m.is_gunu < %s OR m.baslangic_ts < NOW() - (%s || ' minutes')::interval))
                       OR (m.yemek_hakki = FALSE AND NOT m.hak_elle AND m.gorulen IS NULL)
                    ORDER BY m.is_gunu""", (bugun, str(mola_limit(cur))))
    for r in [dict(x) for x in cur.fetchall() or []]:
        if r["bitis_ts"] is None and r["is_gunu"] >= bugun:
            out.append({"tur": "yoklama_mola_uzun", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "⏱ Mola uzun", "ad": f"{r['ad']} — {r['sube_ad'] or ''} molası sürüyor, sınır aşıldı (yemek hakkı düşüyor)",
                        "alt": "Personel › Yemek molaları", "sayfa": "personel_mola", "dugme": "Aç"})
        elif r["bitis_ts"] is None:
            out.append({"tur": "yoklama_mola_bitmedi", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "🍽 Mola bitmedi", "ad": f"{r['ad']} — {r['sube_ad'] or ''} {r['is_gunu'].strftime('%d.%m')} molası bitmedi",
                        "alt": "Bitiş saatini Personel › Yemek molaları'ndan yaz", "sayfa": "personel_mola", "dugme": "Aç"})
        else:
            out.append({"tur": "yoklama_mola_uzun", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "⏱ Mola uzun", "ad": f"{r['ad']} mola {r['sure_dk']} dk ({r['is_gunu'].strftime('%d.%m')}) — yemek hakkı düştü",
                        "alt": "Gördüm ya da hakkı elle ver — Personel › Yemek molaları", "sayfa": "personel_mola", "dugme": "Aç"})
    cur.execute("""SELECT COUNT(*) AS n FROM ey_personel p WHERE p.aktif AND NOT p.mudur
                     AND NOT EXISTS (SELECT 1 FROM ey_cihaz c WHERE c.personel_id=p.id AND c.durum='aktif')""")
    n = int(dict(cur.fetchone())["n"])
    if n:
        out.append({"tur": "yoklama_telefon_yok", "genel": True, "grup": "personel", "id": "telefon_yok", "tarih": bugun.isoformat(),
                    "etiket": "📱 Telefon", "ad": f"{n} personelin telefonu bağlı değil", "alt": "Bağlantı linki üret — 1 Kasım'dan önce herkes",
                    "sayfa": "personel_telefon", "dugme": "Telefonlar"})
    cur.execute("""SELECT s.ad, EXISTS (SELECT 1 FROM ey_cihaz c WHERE c.sube_id=s.id AND c.durum='onay') AS onay,
                          EXISTS (SELECT 1 FROM ey_cihaz c WHERE c.sube_id=s.id AND c.durum='aktif') AS aktif, s.lat IS NULL AS konumsuz
                     FROM ey_sube s WHERE s.aktif AND NOT COALESCE(s.depo, FALSE)""")   # depo QR göstermez
    for r in [dict(x) for x in cur.fetchall() or []]:
        if r["onay"]:
            out.append({"tur": "yoklama_tablet_onay", "genel": True, "grup": "personel", "id": "tablet_onay:" + r["ad"], "tarih": bugun.isoformat(),
                        "etiket": "📟 Tablet", "ad": f"{r['ad']} tableti onay bekliyor", "alt": "Bu tablet o şubenin mi? Onayla",
                        "sayfa": "personel_telefon", "dugme": "Telefonlar"})
        elif not r["aktif"]:
            out.append({"tur": "yoklama_tablet_yok", "genel": True, "grup": "personel", "id": "tablet_yok:" + r["ad"], "tarih": bugun.isoformat(),
                        "etiket": "📟 Tablet", "ad": f"{r['ad']} tableti kayıtlı değil", "alt": "Tablet için bağlantı linki üret (QR'ı tablet gösterir)",
                        "sayfa": "personel_telefon", "dugme": "Telefonlar"})
        if r["konumsuz"]:
            out.append({"tur": "yoklama_konum_yok", "genel": True, "grup": "personel", "id": "konum_yok:" + r["ad"], "tarih": bugun.isoformat(),
                        "etiket": "📍 Koordinat", "ad": f"{r['ad']} şubesinin koordinatı yok", "alt": "Konum kontrolü yapılamıyor",
                        "sayfa": "personel_telefon", "dugme": "Telefonlar"})
    return out


bekleyen_is_kaydet("yoklama", _bekleyen)
