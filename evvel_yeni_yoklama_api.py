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
from evvel_yeni_olay import panel_kok   # kök biçimi tek yerde (K9)
from evvel_yeni_cekirdek import merkez_aktor
from evvel_yeni_cekirdek import tl as _tl_tr   # Türkçe para biçimi TEK yer (f-string içinde iç içe tırnak YOK — canlı Python 3.11)
from evvel_yeni_cekirdek import adet_oku, ayar_oku, ayar_yaz, bekleyen_is_kaydet, is_gunu

router = APIRouter(prefix="/api/evvel-yeni/yoklama", tags=["evvel-yeni-yoklama"])
log = logging.getLogger(__name__)
QR_DILIM_SN = 60
SAAT_PAYI_SN = 120
DAVET_SAAT = 48
VARSAYILAN_YARICAP = 150
_HAZIR = False
# Müdür = görevinde MÜDÜR yazan — TEK kural Tanımlar PUBLIC mudur_mu (Maaş da onu çağırır; F#10)


# ── Tanımlar'ın okuma kapıları (F#31: yoklama ey_personel / ey_sube'ye ~35 ayrı SQL atıyordu — ad / müdür / konum tek yerden) ──
from evvel_yeni_tanim_api import adlar, mudur_mu, tanim_listesi, tanim_oku  # noqa: E402


def _padlar(cur, rows: list) -> dict:
    """Satırlardaki personel_id → ad (yalnız Tanımlar'da olanlar; JOIN'in 'kayıtsız kişi görünmez' davranışı korunur)."""
    return adlar(cur, "ey_personel", {r["personel_id"] for r in rows})


def _adla(cur, rows: list) -> list:
    """Satırlara 'ad' (personel) + 'sube_ad' ekle; Tanımlar'da olmayan kişinin satırı düşer (önceki JOIN ile aynı)."""
    pad = _padlar(cur, rows)
    sad = adlar(cur, "ey_sube", {r.get("sube_id") for r in rows})
    return [{**r, "ad": pad[r["personel_id"]], "sube_ad": sad.get(str(r.get("sube_id")))} for r in rows if r["personel_id"] in pad]


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
        # lat / lng / yaricap_m / konum_muaf Tanımlar'da tanımlı — tek şema sahibi (Dalga 3, F#31)
        # F1b müdür: AYRI İŞARET YOK — tek gerçek Tanımlar › Personel'deki görev ("MÜDÜR"); Maaş da aynı kuralı okur (Tanımlar mudur_mu)
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
        # Kasa devri çift onay (D5/K5, B8 durum makinesi): hazir → devreden_onayladi → tamam | tutmuyor | iptal | merkez_kapatti
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_devir (
            id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, is_gunu DATE NOT NULL, devreden_id TEXT NOT NULL, devralan_id TEXT NOT NULL,
            sayilan_kurus BIGINT NOT NULL, bardak JSONB, surum TEXT NOT NULL, durum TEXT NOT NULL DEFAULT 'hazir',
            panel_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), devreden_ts TIMESTAMPTZ, devreden_mesafe_m INT, devreden_surum TEXT,
            devralan_ts TIMESTAMPTZ, devralan_mesafe_m INT, devralan_surum TEXT, devralan_not TEXT,
            merkez_sonuc TEXT, merkez_kim TEXT, merkez_aciklama TEXT, gorulen TEXT, olay_id TEXT,
            istek_id TEXT UNIQUE, devret_istek_id TEXT UNIQUE, kabul_istek_id TEXT UNIQUE, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            devreden_yoklama_id TEXT, istekler JSONB NOT NULL DEFAULT '{}'::jsonb)""")
        cur.execute("ALTER TABLE ey_devir ADD COLUMN IF NOT EXISTS devreden_yoklama_id TEXT")
        cur.execute("ALTER TABLE ey_devir ADD COLUMN IF NOT EXISTS istekler JSONB NOT NULL DEFAULT '{}'::jsonb")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_devir_gun ON ey_devir (sube_id, is_gunu)")
        # Basamak 4 (sahip 2026-10-19): panel kişisiz başlatır, devreden telefonda doldurur → başlangıçta kişi/tutar/sürüm boş
        _devir_goc_tamam = True
        for _k in ("devreden_id", "devralan_id", "sayilan_kurus", "surum"):
            try:
                with savepoint(cur, "sp_ey_devir_nn_" + _k):
                    cur.execute(f"ALTER TABLE ey_devir ALTER COLUMN {_k} DROP NOT NULL")
            except Exception:  # noqa: BLE001
                _devir_goc_tamam = False   # Fable: kilit zaman aşımı → hazır sayma, sonraki istekte yeniden dene
                log.warning("ey_devir %s NOT NULL kaldırılamadı", _k, exc_info=True)
        for _k, _t in (("urunler", "JSONB"), ("pasta_adet", "INT"), ("ustlenen_id", "TEXT"), ("ustlen_ts", "TIMESTAMPTZ"), ("ustlen_mesafe_m", "INT"),
                       ("vekil", "BOOLEAN NOT NULL DEFAULT FALSE"), ("devralan_sayilan_kurus", "BIGINT")):
            cur.execute(f"ALTER TABLE ey_devir ADD COLUMN IF NOT EXISTS {_k} {_t}")
        try:
            with savepoint(cur, "sp_ey_devir_acik2"):
                cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_devir_acik2 ON ey_devir (sube_id, is_gunu)
                               WHERE durum IN ('baslatildi','dolduruluyor','hazir','devreden_onayladi')""")   # tek açık devir (yeni durumlar)
        except Exception:  # noqa: BLE001
            log.warning("ux_ey_devir_acik2 kurulamadı — uygulama kilidi korur", exc_info=True)
        try:
            with savepoint(cur, "sp_ey_devir_acik"):
                cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_devir_acik ON ey_devir (sube_id, is_gunu)
                               WHERE durum IN ('hazir','devreden_onayladi')""")   # tek açık devir
        except Exception:  # noqa: BLE001
            log.warning("ux_ey_devir_acik kurulamadı — uygulama kilidi korur", exc_info=True)
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
        # eski şube koordinatları + konum muafiyeti kopyası Tanımlar'ın kendi hazırlığında (tanim_hazirla → bir_kez, K5)
    _HAZIR = _devir_goc_tamam


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
    s = tanim_oku(cur, "ey_sube", sube_id, ("lat", "lng", "yaricap_m")) or {}
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
        raise HTTPException(403, "Bu panel bilgisayarı merkez onayı bekliyor")
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
        jwk = __import__("evvel_yeni_cekirdek").json_ac(c["acik_anahtar"], {})
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
    r = tanim_oku(cur, "ey_personel", pid, ("ad", "sube_id", "aktif", "konum_muaf", "gorev", "cikis"))   # Tanımlar'ın kapısı (F#31)
    if not r or not r["aktif"]:
        raise HTTPException(403, "Personel kaydı aktif değil")
    if __import__("evvel_yeni_tanim_api").ayrildi_mi(r.get("cikis"), is_gunu()):   # S-B7: ayrılış tarihi geçti
        raise HTTPException(403, "Ayrılış tarihin geçti — bu telefonla işlem yapılamaz, merkeze haber ver")
    return {k: r[k] for k in ("id", "ad", "sube_id", "aktif", "konum_muaf")} | {"mudur": mudur_mu(r.get("gorev"))}


def telefon_kisisi(cur, basliklar, method: str, yol: str, govde: bytes) -> tuple:
    """PUBLIC — imzalı TELEFON isteği → (cihaz, aktif personel). Yoklama telefon uçları, Toptancı belge, panel QR onay özeti AYNI
    iki adımı ayrı yazıyordu (Dalga 4, K4). Kimlik istemciden gelmez — cihazdan çözülür."""
    c = cihaz_coz(cur, basliklar, method, yol, govde, tur="telefon")
    return c, _personel(cur, c["personel_id"])


def personel_oku(cur, pid: str) -> dict:
    """PUBLIC: aktif personel (konum muafiyeti dahil) — telefon kimliğinden gelen kişi."""
    return _personel(cur, pid)


def qr_kullan(cur, sube_id: str, dilim: int, personel_id: str, islem: str) -> bool:
    """PUBLIC: QR dilimi + kişi + işlem tek kullanım kaydı. Daha önce kullanıldıysa False."""
    cur.execute("""INSERT INTO ey_qr_kullanim (sube_id, dilim, personel_id, islem) VALUES (%s,%s,%s,%s)
                   ON CONFLICT DO NOTHING RETURNING sube_id""", (sube_id, dilim, personel_id, islem[:60]))
    return bool(cur.fetchone())


def bugun_girenler(cur, sube_id: str, gun: Optional[date] = None) -> list:
    """PUBLIC: şubenin iş günündeki girişleri (kişi başına son satır): ad · giriş · çıkış."""
    yoklama_hazirla()
    gece_kapat(cur)   # geçmiş günlerin açıkları kapanır (sahip: gece kapanır, iş bırakmaz)
    g = gun or is_gunu()
    cur.execute("""SELECT DISTINCT ON (y.personel_id) y.personel_id, y.giris_ts, y.cikis_ts, y.cikis_tur,
                          EXISTS (SELECT 1 FROM ey_mola m WHERE m.personel_id=y.personel_id AND m.bitis_ts IS NULL) AS molada
                     FROM ey_yoklama y
                    WHERE y.sube_id=%s AND y.is_gunu=%s ORDER BY y.personel_id, y.giris_ts DESC""", (sube_id, g))
    rows = [dict(x) for x in cur.fetchall() or []]
    pad = _padlar(cur, rows)
    out = [{"personel_id": r["personel_id"], "ad": pad[r["personel_id"]], "giris": _saat(r["giris_ts"]), "cikis": _saat(r["cikis_ts"]),
            "cikis_tur": r["cikis_tur"], "acik": r["cikis_ts"] is None, "molada": bool(r["molada"]) and r["cikis_ts"] is None}
           for r in rows if r["personel_id"] in pad]
    out.sort(key=lambda x: (not x["acik"], x["giris"] or ""))
    return out


def son_yoklama_gunu(cur, personel_id: str) -> Optional[date]:
    """PUBLIC (Maaş › işten çıkış): kişinin QR'la girdiği SON iş günü (yoksa None)."""
    if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_yoklama"):
        return None
    cur.execute("SELECT MAX(is_gunu) AS t FROM ey_yoklama WHERE personel_id=%s", (str(personel_id),))
    return (dict(cur.fetchone() or {}) or {}).get("t")


def tablet_kayitli(cur, sube_id: str) -> bool:
    """PUBLIC (panel durumu): şubeye bağlı aktif tablet/PC var mı."""
    cur.execute("SELECT 1 FROM ey_cihaz WHERE sube_id=%s AND tur='tablet' AND durum='aktif' LIMIT 1", (str(sube_id),))
    return cur.fetchone() is not None


def devir_tamamlanmadi(cur, sube_id: str, gun) -> bool:
    """PUBLIC (kapanış uyarısı) — SALT OKUMA (Codex P2-5: UPDATE'li devir_durum kilit almasın): devreden onayladı ama devralan
    onaylamadı, ya da son 30 dakikada başlatılmış/dolduruluyor."""
    cur.execute("""SELECT 1 FROM ey_devir WHERE sube_id=%s AND is_gunu=%s AND (durum='devreden_onayladi'
                     OR (durum IN ('baslatildi','dolduruluyor') AND COALESCE(ustlen_ts, panel_ts) > NOW() - INTERVAL '30 minutes'))
                   LIMIT 1""", (str(sube_id), gun))
    return cur.fetchone() is not None


def acik_mi(cur, sube_id: str, personel_id: str) -> bool:
    """PUBLIC: kişinin bu şubede BUGÜN açık (çıkış yapılmamış) girişi var mı (panel ad listesi / kapısı). Dünün açığı sayılmaz."""
    yoklama_hazirla()
    cur.execute("SELECT 1 FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND cikis_ts IS NULL AND is_gunu >= %s",
                (personel_id, sube_id, is_gunu()))
    return bool(cur.fetchone())


def gece_kapat(cur) -> int:
    """PUBLIC: geçmiş iş gününden açık kalan girişleri ve molaları kapatır (tür 'gece_otomatik'). Çıkış saati bilinmediği için
    giriş anı yazılır (süre uydurulmaz; ileride vardiya planı gelince oradan alınabilir). Maaşa etkisi YOK: maaş yoklamadan yalnız
    "çalışılan gün" (giriş olan gün) ve mola süresini (yemek hakkı) okur; çıkış saatini okumaz. Bitirilmemiş mola: yemek hakkı YOK
    (sahip 2026-10-19); Bekleyen işler'e düşmez (gorulen='gece_otomatik')."""
    g = is_gunu()
    sinir = mola_limit(cur) + 1   # sahip: mola limit+1 (61.) dakikada sistem kapatır, yemek hakkı yok
    cur.execute("""SELECT EXISTS (SELECT 1 FROM ey_yoklama WHERE cikis_ts IS NULL AND is_gunu < %s)
                       OR EXISTS (SELECT 1 FROM ey_mola WHERE bitis_ts IS NULL AND (is_gunu < %s
                                  OR baslangic_ts < NOW() - (%s || ' minutes')::interval)) AS var""", (g, g, str(sinir)))
    if not dict(cur.fetchone() or {}).get("var"):
        return 0
    # Codex: AYRI kısa işlem + SKIP LOCKED → çağıranın işleminde satır kilidi kalmaz (kişi kilidiyle ters sıra / deadlock yok);
    # o an başka işlemin tuttuğu satır bir sonraki bakışta kapanır
    with db() as (_c, k):
        k.execute("""UPDATE ey_yoklama SET cikis_ts=giris_ts, cikis_tur='gece_otomatik' WHERE id IN (
                       SELECT id FROM ey_yoklama WHERE cikis_ts IS NULL AND is_gunu < %s FOR UPDATE SKIP LOCKED) RETURNING id""", (g,))
        n = len(k.fetchall() or [])
        k.execute("""UPDATE ey_mola SET bitis_ts=baslangic_ts, bitis_tur='gece_otomatik', sure_dk=0, yemek_hakki=FALSE, gorulen='gece_otomatik' WHERE id IN (
                       SELECT id FROM ey_mola WHERE bitis_ts IS NULL AND is_gunu < %s FOR UPDATE SKIP LOCKED)""", (g,))
        # sahip (2026-10-19): bugünkü mola 61. dakikaya ulaştı → sistem kapatır (bitiş = başlangıç + 61 dk), "yemek hakkını kaybettin"
        k.execute("""UPDATE ey_mola SET bitis_ts=baslangic_ts + (%s || ' minutes')::interval, bitis_tur='otomatik_limit', sure_dk=%s,
                            yemek_hakki=FALSE, gorulen='otomatik_limit' WHERE id IN (
                       SELECT id FROM ey_mola WHERE bitis_ts IS NULL AND baslangic_ts < NOW() - (%s || ' minutes')::interval
                       FOR UPDATE SKIP LOCKED)""", (str(sinir), sinir, str(sinir)))
    return n


def personel_kilidi(cur, personel_id: str) -> None:
    """PUBLIC: kişinin yoklama işlemleri sıraya girer (telefon giriş/çıkış ile panel kapanışı yarışmasın)."""
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_yoklama:" + str(personel_id),))


def girdi_mi(cur, sube_id: str, personel_id: str, gun: date) -> bool:
    """PUBLIC: kişi o iş gününde bu şubeye QR'la girmiş mi (açık ya da kapanmış). Kapanış tekrarı / geç kapanış için (K11)."""
    yoklama_hazirla()
    cur.execute("SELECT 1 FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND is_gunu=%s LIMIT 1", (personel_id, sube_id, gun))
    return bool(cur.fetchone())


def cikis_yaz(cur, personel_id: str, tur: str, kim: Optional[str] = None, mesafe: Optional[int] = None,
              cihaz_id: Optional[str] = None, istek_id: Optional[str] = None, sube_id: Optional[str] = None,
              yoklama_id: Optional[str] = None) -> Optional[str]:
    """PUBLIC: açık girişi kapatır (tur: qr / devir / kapanis / merkez). sube_id verilirse yalnız o şubedeki açık giriş.
    Açık giriş yoksa sessizce None (zaten çıkmış)."""
    yoklama_hazirla()
    gece_kapat(cur)   # Codex: geçmiş günün unutulan molası bu yoldan uzun süreyle kapanmasın (önce gece kuralı)
    personel_kilidi(cur, personel_id)
    cur.execute("""SELECT id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL AND (%s::text IS NULL OR sube_id=%s)
                     AND (%s::text IS NULL OR id=%s) FOR UPDATE""", (personel_id, sube_id, sube_id, yoklama_id, yoklama_id))
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


def mola_en_az(cur) -> int:
    """Sahip (2026-10-19): mola en az bu kadar dakika sürmeden personel tarafından BİTİRİLEMEZ (varsayılan 45)."""
    try:
        return int(ayar_oku(cur, "mola_en_az_dk", "45") or 45)
    except ValueError:
        return 45


def _mola_kapat(cur, personel_id: str, tur: str, ts=None, mesafe: Optional[int] = None, istek_id: Optional[str] = None,
                kim: Optional[str] = None) -> Optional[dict]:
    """Açık molayı bitirir: süre + yemek hakkı (≤ limit). Açık mola yoksa None."""
    cur.execute("SELECT id, baslangic_ts, is_gunu FROM ey_mola WHERE personel_id=%s AND bitis_ts IS NULL FOR UPDATE", (personel_id,))
    r = cur.fetchone()
    if not r:
        return None
    r = dict(r)
    if ts is None and r["is_gunu"] < is_gunu():   # Codex: geçmiş günün unutulan molası her yoldan GECE kuralıyla kapanır (sahip: hak YOK)
        cur.execute("""UPDATE ey_mola SET bitis_ts=baslangic_ts, bitis_tur='gece_otomatik', sure_dk=0, yemek_hakki=FALSE,
                              gorulen='gece_otomatik', bitis_istek_id=%s, degistiren=COALESCE(%s, degistiren) WHERE id=%s""", (istek_id, kim, r["id"]))
        return {"id": r["id"], "sure_dk": 0, "yemek_hakki": False}
    sinir = mola_limit(cur) + 1
    if ts is None and (datetime.now(timezone.utc) - r["baslangic_ts"]).total_seconds() >= sinir * 60:   # sahip: 61. dk kuralı
        cur.execute("""UPDATE ey_mola SET bitis_ts=baslangic_ts + (%s || ' minutes')::interval, bitis_tur='otomatik_limit', sure_dk=%s,
                              yemek_hakki=FALSE, gorulen='otomatik_limit', bitis_istek_id=%s, degistiren=COALESCE(%s, degistiren)
                        WHERE id=%s""", (str(sinir), sinir, istek_id, kim, r["id"]))
        return {"id": r["id"], "sure_dk": sinir, "yemek_hakki": False}
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
        return {"durum": "suruyor", "bas": _saat(m["baslangic_ts"]), "sure_dk": int(sn // 60), "limit_dk": lim, "en_az_dk": mola_en_az(cur),
                "hak_dustu": sn > lim * 60}
    return {"durum": "bitti", "bas": _saat(m["baslangic_ts"]), "bit": _saat(m["bitis_ts"]), "sure_dk": m["sure_dk"], "limit_dk": lim,
            "hak_dustu": not m["yemek_hakki"] and not m["hak_elle"],
            "otomatik": m.get("bitis_tur") in ("otomatik_limit", "gece_otomatik")}


def yemek_ozet(cur, bas: date, son: date) -> dict:
    """PUBLIC (Maaş yemek kalemi, F4): kişi → {calisilan_gun, hak_gun, dusen:[{gun, sure_dk}]} + müdür listesi.
    Çalışılan gün = QR girişi ∪ panel izi (F1a). Hak gün = molası ≤ limit ya da merkezin elle verdiği gün (K7; K8: molasız gün hak yok)."""
    yoklama_hazirla()
    gece_kapat(cur)   # geçmiş günlerin açıkları kapanır (sahip: gece kapanır, iş bırakmaz)
    gunler: dict = {}
    cur.execute("SELECT personel_id, is_gunu FROM ey_yoklama WHERE is_gunu BETWEEN %s AND %s", (bas, son))
    for r in [dict(x) for x in cur.fetchall() or []]:
        gunler.setdefault(r["personel_id"], set()).add(r["is_gunu"])
    try:
        from evvel_yeni_olay import panel_olaylari
        for o in panel_olaylari(cur, bas=bas, son=son):   # F#12
            if o.get("personel_id"):
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
    mudur = {r["id"] for r in tanim_listesi(cur, "ey_personel", ("gorev",)) if mudur_mu(r.get("gorev"))}
    return {"mudur": mudur, "limit_dk": mola_limit(cur), "kisi": {pid: {"calisilan_gun": len(g), "hak_gun": hak.get(pid, 0), "dusen": dusen.get(pid, [])}
                                     for pid, g in gunler.items()}}


def yoklama_satirlari(cur, bas: date, son: date) -> list:
    """PUBLIC (Maaş › Personel takvimi + Günlük yoklama — Y3): iş günü aralığındaki QR giriş satırları.
    {pid, tarih (iş günü), sid, giris_ts, cikis_ts, cikis_tur} — eski gorev_yoklama okuyucusunun yeni dönem kaynağı."""
    yoklama_hazirla()
    gece_kapat(cur)
    cur.execute("""SELECT personel_id, is_gunu, sube_id, giris_ts, cikis_ts, cikis_tur FROM ey_yoklama
                    WHERE is_gunu BETWEEN %s AND %s ORDER BY giris_ts""", (bas, son))
    return [{"pid": str(r["personel_id"]), "tarih": r["is_gunu"], "sid": str(r["sube_id"]), "giris_ts": r["giris_ts"],
             "cikis_ts": r["cikis_ts"], "cikis_tur": r["cikis_tur"]} for r in [dict(x) for x in cur.fetchall() or []]]


def son_okutanlar(cur, sube_id: str, sn: int = 300) -> list:
    """PUBLIC: panelde canlı 'son okutanlar' (yabancı ad hemen görülsün)."""
    # Codex (kısmen kapalı #16): ad süzgeci SQL'DE, sınır SONRA — 'LIMIT 50' sonra süzmek, ilk 50 kayıtsızsa geçerlileri yine saklıyordu.
    # Geçerli kişiler Tanımlar'ın PUBLIC kapısından (ey_personel'e JOIN yok — modül sınırı)
    pad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_personel")
    if not pad:
        return []
    cur.execute("""SELECT q.islem, q.zaman, q.personel_id FROM ey_qr_kullanim q
                    WHERE q.sube_id=%s AND q.zaman > NOW() - (%s || ' seconds')::interval AND q.personel_id = ANY(%s)
                    ORDER BY q.zaman DESC LIMIT 8""", (sube_id, str(sn), list(pad)))
    return [{"ad": pad[str(r["personel_id"])], "islem": r["islem"], "saat": _saat(r["zaman"])} for r in [dict(x) for x in cur.fetchall() or []]]


from evvel_yeni_cekirdek import tr_saat as _saat  # noqa: E402   # Dalga 4 (F#4): saat biçimi TEK yerde — çekirdek


# ─────────────────────────── MERKEZ: cihaz yönetimi ───────────────────────────
def _merkez(cur, jeton: Optional[str]) -> str:
    kim = merkez_aktor(cur, jeton)   # çekirdek kapısı (F#2)
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
            r = tanim_oku(cur, "ey_sube", b.sube_id, ("ad", "aktif"))
            if not r or not r["aktif"]:
                raise HTTPException(404, "Şube bulunamadı")
            ad = dict(r)["ad"]
        cid = "cz-" + uuid.uuid4().hex[:16]
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_cihaz_hedef:" + (f"p:{b.personel_id}" if b.personel_id else f"s:{b.sube_id}"),))
        # sahip (2026-10-19): yeniden link üretilince ÖNCEKİ kullanılmamış link geçersiz olur (tek geçerli link)
        if b.personel_id:
            cur.execute("UPDATE ey_cihaz SET durum='iptal', iptal_zaman=NOW(), davet_hash=NULL WHERE tur='telefon' AND personel_id=%s AND durum='davet'",
                        (b.personel_id,))
        else:
            cur.execute("UPDATE ey_cihaz SET durum='iptal', iptal_zaman=NOW(), davet_hash=NULL WHERE tur='tablet' AND sube_id=%s AND durum='davet'",
                        (b.sube_id,))
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
        cur.execute("SELECT personel_id, sube_id, tur FROM ey_cihaz WHERE davet_hash=%s", (h,))
        _h = cur.fetchone()
        if _h:   # Codex: hedef kilidi satır kilidinden ÖNCE (iki cihaz aynı anda devreye girerse karşılıklı bekleme olmasın)
            _h = dict(_h)
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                        ("ey_cihaz_hedef:" + (f"p:{_h['personel_id']}" if _h["tur"] == "telefon" else f"s:{_h['sube_id']}"),))
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
        if c["tur"] == "telefon" and c["personel_id"]:   # sahip: yeni telefon devreye girince eskisi iptal
            cur.execute("""UPDATE ey_cihaz SET durum='iptal', iptal_zaman=NOW(), davet_hash=NULL
                           WHERE tur='telefon' AND personel_id=%s AND id<>%s AND durum IN ('aktif','onay','davet')""", (c["personel_id"], c["id"]))
        ad = (tanim_oku(cur, "ey_personel", c["personel_id"], ("ad",)) if c["personel_id"]
              else tanim_oku(cur, "ey_sube", c["sube_id"], ("ad",)) or {}) or {}
        ad = ad.get("ad")
    return {"ok": True, "cihaz_id": c["id"], "tur": c["tur"], "durum": durum, "ad": ad, "guc": guc, "sube_id": c.get("sube_id"),
            "mesaj": (f"Bu telefon artık {ad} adına" if c["tur"] == "telefon"
                      else f"Bu bilgisayar {ad} paneli olarak kaydedildi — merkez onayı bekleniyor")}


@router.post("/cihaz/{cid}/onayla")
def cihaz_onayla(cid: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        cur.execute("SELECT sube_id FROM ey_cihaz WHERE id=%s", (cid,))
        _s = cur.fetchone()
        if _s:   # aynı hedef kilidi (bağlama / davet ile aynı sıra)
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_cihaz_hedef:s:" + str(dict(_s)["sube_id"]),))
        cur.execute("UPDATE ey_cihaz SET durum='aktif' WHERE id=%s AND durum='onay' AND tur='tablet' RETURNING id, sube_id", (cid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Onay bekleyen tablet bulunamadı")
        cur.execute("""UPDATE ey_cihaz SET durum='iptal', iptal_zaman=NOW(), davet_hash=NULL
                       WHERE tur='tablet' AND sube_id=%s AND id<>%s AND durum IN ('aktif','onay')""", (dict(r)["sube_id"], cid))
        eski = cur.rowcount
    return {"ok": True, "mesaj": "Panel bilgisayarı onaylandı" + (f" — eski {eski} bağlantı iptal edildi" if eski else "")}


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
        sad = adlar(cur, "ey_sube")
        per = [{"id": p["id"], "ad": p["ad"], "sube_id": p["sube_id"], "sube_ad": sad.get(str(p["sube_id"])), "konum_muaf": p["konum_muaf"],
                "mudur": mudur_mu(p.get("gorev"))}
               for p in tanim_listesi(cur, "ey_personel", ("ad", "sube_id", "konum_muaf", "gorev"), aktif=True)]
        from evvel_yeni_cekirdek import tr_sira
        per.sort(key=lambda p: (p["sube_ad"] is None, tr_sira(p["sube_ad"]), tr_sira(p["ad"])))   # Türkçe sıra (Fable B6)
        cur.execute("""SELECT id, tur, personel_id, sube_id, guc, etiket, durum, davet_son, olusturma, son_kullanim
                         FROM ey_cihaz WHERE durum<>'iptal' ORDER BY olusturma DESC""")
        cz = [dict(r) for r in cur.fetchall() or []]
        subeler = [{"id": s["id"], "ad": s["ad"], "konum": s["lat"] is not None}
                   for s in tanim_listesi(cur, "ey_sube", ("ad", "lat"), aktif=True)]
    def _c(x):
        return {"id": x["id"], "guc": x["guc"], "etiket": x["etiket"], "durum": x["durum"],
                "son_kullanim": str(x["son_kullanim"])[:16] if x["son_kullanim"] else None,
                "davet_son": str(x["davet_son"])[:16] if x["davet_son"] else None}
    return {"personel": [{**p, "cihazlar": [_c(x) for x in cz if x["personel_id"] == p["id"]]} for p in per],
            "subeler": [{**s, "tabletler": [_c(x) for x in cz if x["sube_id"] == s["id"]]} for s in subeler]}


class IsaretBody(BaseModel):
    konum_muaf: bool


@router.post("/personel/{pid}/konum-muaf")
def konum_muaf_ayarla(pid: str, b: IsaretBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """B7: yönetici konum muafiyeti (K2) — Personel › Telefonlar'dan."""
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        from evvel_yeni_tanim_api import tanim_guncelle
        r = tanim_guncelle(cur, "ey_personel", pid, {"konum_muaf": bool(b.konum_muaf)})   # Tanımlar'ın kapısı (F#31)
        if not r:
            raise HTTPException(404, "Personel bulunamadı")
    return {"ok": True, "mesaj": f"{dict(r)['ad']}: konum " + ("muaf" if b.konum_muaf else "kontrol edilir")}


# ─────────────────────────── TABLET: QR üretimi (yalnız kayıtlı tablet) ───────────────────────────
@router.get("/qr.png")
async def qr_png(request: Request):
    """Tabletin imzalı isteğiyle dönen QR resmi. Uzaktan 'güncel QR'ı çekmek' kapalı (Codex)."""
    yoklama_hazirla()

    istenen = (request.query_params.get("s") or "").strip()[:60]   # B5: panelin AÇIK olduğu şube

    def _is():
        with db() as (conn, cur):
            c = cihaz_coz(cur, request.headers, "GET", request.url.path, b"", tur="tablet")
            if istenen and str(c["sube_id"]) != istenen:   # B5 (Fable): başka şubeye bağlı PC yanlış şubenin QR'ını göstermesin — baştan söyle
                from evvel_yeni_tanim_api import subeler as _sb
                ad = {str(x["id"]): x["ad"] for x in _sb(cur, hepsi=True)}
                raise HTTPException(409, f"Bu bilgisayar {ad.get(str(c['sube_id']), c['sube_id'])} şubesine bağlı — "
                                         f"{ad.get(istenen, istenen)} için QR veremez. Merkezden bu şube için bağlantı iste.")
            return c["sube_id"], qr_jeton(cur, c["sube_id"])
    sube_id, jeton = await run_in_threadpool(_is)
    # R1: panelin "QR ile onayla" adımı → QR onay kimliğini taşır (telefon o işlemi onaylar)
    onay = (request.query_params.get("o") or "").strip()
    onay = onay if onay and len(onay) <= 40 and all(ch.isalnum() or ch == "-" for ch in onay) else ""
    # Basamak 4: panelin devir ekranı → QR devir kimliğini taşır (okutan telefon doğrudan devir akışına girer; yetki sunucuda)
    dv = (request.query_params.get("dv") or "").strip()
    dv = dv if dv and len(dv) <= 40 and all(ch.isalnum() or ch == "-" for ch in dv) else ""
    # Basamak 8 / E1: teslim sonrası "Faturayı çek" → QR teslim kimliğini taşır (yükleme imzalı telefonla, yetki Toptancı'da)
    tb = (request.query_params.get("tb") or "").strip()
    tb = tb if tb and len(tb) <= 40 and all(ch.isalnum() or ch == "-" for ch in tb) else ""
    import io
    import os
    import qrcode
    taban = os.getenv("APP_URL", "https://evvel-erp-production.up.railway.app").rstrip("/")
    q = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=3)
    q.add_data(f"{taban}/q/{sube_id}/{jeton}" + (f"?o={onay}" if onay else f"?dv={dv}" if dv else f"?tb={tb}" if tb else ""))
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
            c, p = telefon_kisisi(cur, request.headers, request.method, request.url.path, govde)
            gece_kapat(cur)   # sahip: dünkü girişi kapanmamış kişi bugün "Giriş yap" görsün
            try:
                veri = json.loads(govde) if govde else {}
            except ValueError:
                raise HTTPException(400, "İstek okunamadı")
            if not isinstance(veri, dict):
                raise HTTPException(400, "İstek okunamadı")
            return fn(cur, c, p, veri)
    return await run_in_threadpool(_is)


@router.get("/ben")
async def ben(request: Request, sube: Optional[str] = None, qr: Optional[str] = None):
    """Telefon ekranı: kim, hangi şube, bugün giriş / çıkış, yapabileceği tek düğme."""
    def fn(cur, c, p, _v):
        cur.execute("SELECT y.* FROM ey_yoklama y WHERE y.personel_id=%s ORDER BY y.giris_ts DESC LIMIT 1", (p["id"],))
        son = dict(cur.fetchone() or {})
        if son:
            son["sube_ad"] = adlar(cur, "ey_sube", [son.get("sube_id")]).get(str(son.get("sube_id")))
        acik = bool(son) and son.get("cikis_ts") is None
        sube_ad = None
        if sube:
            sube_ad = adlar(cur, "ey_sube", [sube]).get(str(sube))
        elif acik:   # telefon EV sayfası (/q, şubesiz): açık girişin şubesi (Fable B8)
            sube_ad = son.get("sube_ad")
        mola = _mola_durum(cur, p["id"], is_gunu())
        burada = acik and son.get("sube_id") == sube
        yap = ["giris"] if not acik and sube else []
        if burada:
            yap = (["mola_bitir"] if mola and mola["durum"] == "suruyor" else ([] if mola else ["mola_baslat"])) + ["cikis"]
        devir = None
        if sube:
            d = devir_durum(cur, sube)
            # Codex P1 (21 Eki): devrin beyan ayrıntısı (sayılan tutar) yalnız o şubenin GEÇERLİ QR'ıyla — adrese şube yazmak yetmez
            if (d and d["durum"] == "devreden_onayladi" and d.get("devreden_id") != p["id"] and (burada or not acik)
                    and qr_dogrula(cur, str(sube), qr or "") is not None):
                devir, yap = {**d, "rol": "devralan", "giris_acilir": not acik}, ["kabul"] + [x for x in yap if x != "giris"]
        elif acik and son.get("sube_id"):   # EV (/q, şubesiz) — Fable T1 #2: yalnız ROL + devredenin adı (tutar yok; işlem QR'da)
            d = devir_durum(cur, str(son["sube_id"]))
            if d and d["durum"] == "devreden_onayladi" and d.get("devreden_id") != p["id"]:
                devir = {"rol": "devralan", "devreden": d.get("devreden"), "ev": True}
            elif d and d["durum"] in DEVIR_ACIK and d.get("devreden_id") == p["id"]:
                devir = {"rol": "devreden", "ev": True}
        return {"kisi": p["ad"], "muaf": bool(p.get("konum_muaf")), "gun": is_gunu().isoformat(), "sube": sube, "sube_ad": sube_ad,
                "mola": mola, "devir": devir,
                "qr_gecerli": (qr_dogrula(cur, str(sube), qr or "") is not None) if sube else None,   # Fable #7: süresi dolan QR baştan söylensin
                "yemek_tam": bool(p.get("mudur")),   # müdür: yemek mola şartsız tam (Maaş ile aynı kural; _personel 'mudur' hesaplar)
                "acik": acik, "acik_sube": son.get("sube_id") if acik else None, "acik_sube_ad": son.get("sube_ad") if acik else None,
                "giris": _saat(son.get("giris_ts")) if son and son.get("is_gunu") == is_gunu() else None,
                "giris_ts": son["giris_ts"].isoformat() if son and son.get("is_gunu") == is_gunu() and son.get("giris_ts") else None,   # ev kartı süre halkası
                "mola_limit_dk": mola_limit(cur), "mola_en_az_dk": mola_en_az(cur),
                "cikis": _saat(son.get("cikis_ts")) if son and son.get("is_gunu") == is_gunu() else None,
                "yapabilir": yap}
    return await _telefon(request, fn)


def _qr_islem(cur, c, p, v, islem: str) -> tuple:
    sube = str(v.get("sube") or "")
    s_ = tanim_oku(cur, "ey_sube", sube, ("aktif",)) if sube else None
    if not s_ or not s_["aktif"]:
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


def _avans():
    """Yumuşak bağ: Avans modülü yüklüyse PUBLIC servisleri; değilse None. 1 Kasım öncesi telefon talebi KAPALI (eski sayfadan)."""
    from evvel_yeni_moduller import acik as _acik
    if not _acik("avans"):
        return None
    import evvel_yeni_avans_api as a
    return a


@router.get("/avans")
async def avans_durum_tel(request: Request):
    """🤝 Telefon: avans tavanı · kullanılabilir · açık talep (sahip 20 Eki: tavan eski oran)."""
    def fn(cur, c, p, _v):
        from evvel_yeni_cekirdek import yeni_donem
        A = _avans()
        if A is None:
            return {"kapali": "Avans şu an kapalı — merkeze sor"}
        if not yeni_donem(cur):
            return {"kapali": "Avans talebi 1 Kasım'dan itibaren buradan — şimdilik eski personel sayfasından"}
        d = A.avans_durumu(cur, p["id"])
        return {"tavan": d["tavan"] / 100, "kullanilan": d["kullanilan"] / 100, "kullanilabilir": d["kullanilabilir"] / 100,
                "acik": ({"tutar": int(d["acik"]["tutar"]) / 100, "durum": d["acik"]["durum"], "yontem": d["acik"].get("yontem"),
                          "talep": d["acik"]["talep_ts"]} if d["acik"] else None), "ay": d["ay"],
                "son": ({**d["son"], "tutar": int(d["son"]["tutar"]) / 100} if d.get("son") else None)}
    return await _telefon(request, fn)


@router.post("/avans")
async def avans_talep_tel(request: Request):
    """🤝 Telefon: avans talebi (imzalı cihaz = kişi). Merkez onaylar (havale / elden)."""
    def fn(cur, c, p, v):
        from evvel_yeni_cekirdek import yeni_donem
        A = _avans()
        if A is None or not yeni_donem(cur):
            raise HTTPException(409, "Avans talebi şu an buradan alınmıyor")
        ist = _istek(v)
        from evvel_yeni_cekirdek import kurus, tutar_oku
        t = kurus(tutar_oku(v.get("tutar"), "Avans tutarı"))   # Türkçe yazı tek ayrıştırıcıdan (Dalga 4)
        r = A.talep_yaz(cur, personel_id=p["id"], tutar=t, not_=v.get("not"), istek_id=ist)
        return {"ok": True, "tekrar": r["tekrar"], "mesaj": "Talebin merkeze iletildi ✓" if not r["tekrar"] else "Talebin zaten iletilmişti ✓"}
    return await _telefon(request, fn)


def _istek_kaydi(cur, tablo: str, kolon: str, ist: str, alanlar: str, sahip: dict) -> Optional[dict]:
    """Aynı istek kimliğiyle daha önce yazılmış satır (yoksa None). Satır BAŞKA kişiye / kayda aitse 409 (Dalga 4, K2: telefon
    giriş · çıkış · mola başlat · mola bitir · devret · kabul aynı 6 satırı ayrı yazıyordu). tablo/kolon/alanlar sabit (kod içi)."""
    cur.execute(f"SELECT {alanlar} FROM {tablo} WHERE {kolon}=%s", (ist,))
    r = cur.fetchone()
    if not r:
        return None
    r = dict(r)
    if any(str(r.get(k)) != str(v) for k, v in sahip.items()):
        raise HTTPException(409, "İstek kimliği başka bir kayda ait — tekrar dene")
    return r


def _istek(v) -> str:
    return __import__("evvel_yeni_cekirdek").istek_dogrula(v.get("istek_id"))   # TEK kural (F#15; isalnum Türkçe harfi de geçiriyordu)


@router.post("/giris")
async def giris(request: Request):
    """QR + konum ile giriş. Açık girişi varsa: aynı şubeyse aynı kayıt; başka şubeyse önce çıkış (K11). Çıkıştan sonra yeni satır (K4)."""
    def fn(cur, c, p, v):
        ist = _istek(v)
        personel_kilidi(cur, p["id"])
        r = _istek_kaydi(cur, "ey_yoklama", "istek_id", ist, "personel_id, giris_ts", {"personel_id": p["id"]})   # K2: tekrar bloğu tek
        if r:
            return {"ok": True, "tekrar": True, "mesaj": f"Giriş zaten kaydedildi · {_saat(dict(r)['giris_ts'])}"}
        cur.execute("SELECT y.id, y.sube_id FROM ey_yoklama y WHERE y.personel_id=%s AND y.cikis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        sube, k = _qr_islem(cur, c, p, v, "giris")
        if a:
            a = dict(a)
            a["ad"] = adlar(cur, "ey_sube", [a["sube_id"]]).get(str(a["sube_id"]))
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
        r = _istek_kaydi(cur, "ey_yoklama", "cikis_istek_id", ist, "personel_id, cikis_ts", {"personel_id": p["id"]})   # K2: tekrar bloğu tek
        if r:
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
        gece_kapat(cur)
        if acik:
            # B33 (Fable 22 Eki): gece_kapat önce çalıştığı için 'cikis_ts IS NULL' hep boştu → sistemin GECE kapattığı (son 14 gün)
            # ve hâlâ açık kalanlar; merkez saat yazınca cikis_tur='merkez' olur, listeden kendiliğinden düşer
            cur.execute("""SELECT y.* FROM ey_yoklama y WHERE y.is_gunu < %s
                             AND (y.cikis_ts IS NULL OR (y.cikis_tur = 'gece_otomatik' AND y.is_gunu >= %s))
                            ORDER BY y.is_gunu, y.giris_ts""", (is_gunu(), is_gunu() - timedelta(days=14)))
        elif bas and son:
            cur.execute("SELECT y.* FROM ey_yoklama y WHERE y.is_gunu BETWEEN %s AND %s ORDER BY y.is_gunu, y.giris_ts", (bas, son))
        else:
            raise HTTPException(400, "bas/son ya da acik=1")
        rows = _adla(cur, [dict(r) for r in cur.fetchall() or []])
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
        if not r or (dict(r)["cikis_ts"] is not None and dict(r).get("cikis_tur") != "gece_otomatik"):   # B33: gece kapatılan da düzeltilir
            raise HTTPException(404, "Açık giriş bulunamadı")
        r = dict(r)
        from evvel_yeni_cekirdek import is_gunu_zamani
        ts = is_gunu_zamani(r["is_gunu"], hh, mm)   # Dalga 4 (F#4): iki kopya tek yerde
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
        r = _istek_kaydi(cur, "ey_mola", "istek_id", ist, "personel_id, baslangic_ts", {"personel_id": p["id"]})   # K2: tekrar bloğu tek
        if r:
            return {"ok": True, "tekrar": True, "mesaj": f"Mola zaten başladı · {_saat(dict(r)['baslangic_ts'])}"}
        cur.execute("SELECT id, sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        if not a:
            raise HTTPException(409, "Önce giriş yap")
        a = dict(a)
        gun = is_gunu()
        cur.execute("SELECT is_gunu, bitis_ts FROM ey_mola WHERE personel_id=%s AND (is_gunu=%s OR bitis_ts IS NULL) LIMIT 1", (p["id"], gun))
        r = cur.fetchone()
        if r:   # Fable: QR harcanmadan ÖNCE (yoksa yeniden okutma gerekirdi)
            raise HTTPException(409, "Molan zaten sürüyor — önce bitir" if dict(r)["bitis_ts"] is None else "Bugünkü yemek molanı kullandın")
        sube, k = _qr_islem(cur, c, p, v, "mola_bas")
        if a["sube_id"] != sube:
            raise HTTPException(409, "Girişin başka şubede — o şubenin QR'ını okut")
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
        r = _istek_kaydi(cur, "ey_mola", "bitis_istek_id", ist, "personel_id, sure_dk, yemek_hakki, bitis_ts", {"personel_id": p["id"]})   # K2: tekrar bloğu tek
        if r:
            return {"ok": True, "tekrar": True, "hak_dustu": not r["yemek_hakki"],
                    "mesaj": f"Mola zaten bitti · {_saat(r['bitis_ts'])} · {r['sure_dk']} dk" + ("" if r["yemek_hakki"] else " — Bugün yemek hakkı kazanılamadı")}
        cur.execute("SELECT sube_id, baslangic_ts, NOW() - baslangic_ts AS gecen FROM ey_mola WHERE personel_id=%s AND bitis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        if not a:
            raise HTTPException(409, "Açık molan yok")
        en_az = mola_en_az(cur)
        gecen_dk = int(dict(a)["gecen"].total_seconds() // 60)
        if gecen_dk < en_az:   # sahip: 45 dk'dan önce mola bitirilemez (QR harcanmadan önce reddedilir)
            raise HTTPException(409, f"Mola {en_az} dakikadan önce bitirilemez — {en_az - gecen_dk} dk kaldı "
                                     f"(başlangıç {_saat(dict(a)['baslangic_ts'])})")
        sube, k = _qr_islem(cur, c, p, v, "mola_bit")
        if dict(a)["sube_id"] != sube:
            raise HTTPException(409, "Molan başka şubede — o şubenin QR'ını okut")
        m = _mola_kapat(cur, p["id"], "qr", mesafe=k["mesafe_m"], istek_id=ist)
        if not m:   # Codex: arada sistem (61. dk / gece) kapattıysa — 500 yerine o molanın kendi durumunu söyle (gün değişse de)
            cur.execute("SELECT sure_dk, yemek_hakki, hak_elle FROM ey_mola WHERE personel_id=%s ORDER BY baslangic_ts DESC LIMIT 1", (p["id"],))
            md = dict(cur.fetchone() or {})
            dustu = not md.get("yemek_hakki") and not md.get("hak_elle")
            return {"ok": True, "tekrar": True, "hak_dustu": dustu,
                    "mesaj": f"Mola zaten kapanmıştı · {md.get('sure_dk', '—')} dk" + (" — yemek hakkını kaybettin" if dustu else "")}
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
        q = """SELECT m.* FROM ey_mola m WHERE """
        if acik:
            cur.execute(q + """(m.bitis_ts IS NULL AND (m.is_gunu < %s OR m.baslangic_ts < NOW() - (%s || ' minutes')::interval))
                                OR (m.yemek_hakki = FALSE AND NOT m.hak_elle AND m.gorulen IS NULL)
                                ORDER BY m.is_gunu, m.baslangic_ts""", (is_gunu(), str(mola_limit(cur) + 1)))
        elif bas and son:
            cur.execute(q + "m.is_gunu BETWEEN %s AND %s ORDER BY m.is_gunu, m.baslangic_ts", (bas, son))
        else:
            raise HTTPException(400, "bas/son ya da acik=1")
        rows = _adla(cur, [dict(r) for r in cur.fetchall() or []])
        lim = mola_limit(cur)
        # B56: müdürün yemek hakkı mola şartsız (Maaş 'müdür — tam') → mola ekranı 'hak düşen' demesin, Bekleyen'e düşmesin
        from evvel_yeni_tanim_api import mudur_mu, tanim_listesi
        _mud = {str(p["id"]) for p in tanim_listesi(cur, "ey_personel", ("gorev",)) if mudur_mu(p.get("gorev"))}
        for r in rows:
            r["mudur"] = str(r["personel_id"]) in _mud
        if acik:
            rows = [r for r in rows if not (r["mudur"] and r["bitis_ts"] is not None)]
    bugun = is_gunu()

    def _durum(r):
        if r["bitis_ts"] is None:
            return "suruyor" if r["is_gunu"] >= bugun else "bitmedi"
        return {"merkez": "merkez yazdı", "qr": "bitti", "gece_otomatik": "gece sistem kapattı",
                "otomatik_limit": "süre doldu — sistem kapattı"}.get(r["bitis_tur"], "çıkışla kapandı")   # B56 · S-B5
    return {"limit_dk": lim, "satirlar": [{
        "id": r["id"], "personel_id": r["personel_id"], "gun": r["is_gunu"].isoformat(), "ad": r["ad"], "sube": r["sube_ad"], "bas": _saat(r["baslangic_ts"]),
        "bit": _saat(r["bitis_ts"]), "sure_dk": r["sure_dk"], "durum": _durum(r), "yemek_hakki": r["yemek_hakki"],
        "hak_elle": r["hak_elle"], "hak_veren": r["hak_veren"], "hak_aciklama": r["hak_aciklama"],
        "hak_zaman": str(r["hak_zaman"])[:16] if r["hak_zaman"] else None, "gorulen": r["gorulen"], "mesafe": r["baslangic_mesafe_m"], "mudur": r["mudur"]}
        for r in rows]}


class MolaDuzeltBody(BaseModel):
    bitis_saat: str
    aciklama: str


class AciklamaBody(BaseModel):
    aciklama: Optional[str] = None


def _saat_coz(saat: str):
    t = __import__("evvel_yeni_cekirdek").saat_oku(saat)   # TEK saat kuralı çekirdekte (vardiya ile ortak)
    return t.hour, t.minute


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
        from evvel_yeni_cekirdek import is_gunu_zamani
        ts = is_gunu_zamani(r["is_gunu"], hh, mm)
        if ts < r["baslangic_ts"]:
            raise HTTPException(400, "Bitiş başlangıçtan önce olamaz")
        personel_kilidi(cur, r["personel_id"])
        m = _mola_kapat(cur, r["personel_id"], "merkez", ts=ts, kim=f"merkez: {kim} — {b.aciklama.strip()[:120]}")
    return {"ok": True, "mesaj": f"Mola bitişi yazıldı · {m['sure_dk'] if m else '?'} dk"}


@router.post("/mola/{mid}/hak-ver")
def mola_hak_ver(mid: str, b: AciklamaBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: uzun moladan düşen yemek hakkını elle verir (K7 'gerekirse ödemesini yaparız') — izli."""
    if len((b.aciklama or "").strip()) < 2:   # B56: ekran "NEDEN yazılır" diyor — boş geçilemez
        raise HTTPException(400, "Nedenini yaz")
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


# ─────────────────────────── KASA DEVRİ (çift onay, kişinin kendi telefonunda — D5/D5a, K5, B8) ───────────────────────────
DEVIR_ACIK = ("baslatildi", "dolduruluyor", "hazir", "devreden_onayladi")   # 'hazir' = eski akış (tarihsel satırlar)
DEVIR_PENCERE_DK = 15   # sahip: devreden QR'ı BİR KEZ okutur, formu 15 dk içinde telefonda doldurur
DEVIR_DUSME_DK = 30     # başlatılıp okutulmayan / yarıda kalan devir sessizce düşer (Bekleyen işler'e düşmez)


def _devir_surum(devreden_id, sayilan_kurus, bardak, urunler=None, pasta=None) -> str:
    g = json.dumps({"a": devreden_id, "s": int(sayilan_kurus or 0), "b": bardak or [], "u": urunler or [], "p": pasta},
                   sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(g.encode("utf-8")).hexdigest()[:16]


def _devir_kilit(cur, sube_id: str, gun) -> None:
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_devir:{sube_id}:{gun}",))


def _devir_dus(cur) -> None:
    """Başlatılıp okutulmayan / formu yarıda kalan devir 30 dk sonra sessizce düşer (panel yeniden başlatabilir)."""
    cur.execute("""UPDATE ey_devir SET durum='dustu' WHERE durum IN ('baslatildi','dolduruluyor')
                   AND COALESCE(ustlen_ts, panel_ts) < NOW() - (%s || ' minutes')::interval""", (str(DEVIR_DUSME_DK),))


def devir_listesi(cur) -> dict:
    """Devir formunun kalemleri = katalogda 'panelde sayılır' ürünler (S5) → bardaklar (adında bardak) + diğer ürünler. Ürün modülü yoksa boş."""
    try:
        from evvel_yeni_urun_api import katalog
        kat = katalog(cur)
    except Exception:  # noqa: BLE001
        log.warning("devir: katalog okunamadı", exc_info=True)
        return {"bardak": [], "urun": []}
    hep = [{"id": str(x["id"]), "ad": x["ad"]} for k in kat for x in k["urunler"] if __import__("evvel_yeni_urun_api").tezgahta_sayilir(x)]
    bardak = [u for u in hep if __import__("evvel_yeni_urun_api").bardak_mi(u["ad"])]   # TEK bardak kuralı (F#9)
    bid = {u["id"] for u in bardak}
    return {"bardak": bardak, "urun": [u for u in hep if u["id"] not in bid]}


def devir_baslat(cur, sube_id: str, gun, istek_id: str) -> dict:
    """PUBLIC (panel, kayıtlı PC): kişisiz / formsuz devir açar → durum 'baslatildi'. Açık devir varsa onu döner (tek açık devir)."""
    yoklama_hazirla()
    _devir_kilit(cur, sube_id, gun)
    _devir_dus(cur)
    cur.execute("SELECT id FROM ey_devir WHERE istek_id=%s", (istek_id,))
    r = cur.fetchone()
    if r:
        return {"devir_id": dict(r)["id"], "tekrar": True}
    cur.execute("SELECT id, durum FROM ey_devir WHERE sube_id=%s AND is_gunu=%s AND durum = ANY(%s) FOR UPDATE",
                (sube_id, gun, list(DEVIR_ACIK)))
    a = cur.fetchone()
    if a:
        return {"devir_id": dict(a)["id"], "zaten": True}
    did = "dv-" + uuid.uuid4().hex[:16]
    cur.execute("""INSERT INTO ey_devir (id, sube_id, is_gunu, durum, istek_id) VALUES (%s,%s,%s,'baslatildi',%s)""",
                (did, sube_id, gun, istek_id))
    return {"devir_id": did}


def devir_iptal(cur, sube_id: str, gun) -> bool:
    """PUBLIC (panel): devreden onaylamadan önce iptal (başlatıldı / dolduruluyor / eski 'hazir'). Onaylandıysa merkez kapatır."""
    yoklama_hazirla()
    _devir_kilit(cur, sube_id, gun)
    cur.execute("""UPDATE ey_devir SET durum='iptal' WHERE sube_id=%s AND is_gunu=%s AND durum IN ('baslatildi','dolduruluyor','hazir')
                   RETURNING id""", (sube_id, gun))
    return bool(cur.fetchone())


def _devir_dict(cur, r: dict) -> dict:
    ids = [x for x in (r.get("devreden_id"), r.get("devralan_id"), r.get("ustlenen_id")) if x]
    ad = adlar(cur, "ey_personel", ids)
    sk = r.get("sayilan_kurus")
    ds = r.get("devralan_sayilan_kurus")
    pencere = bool(r.get("ustlen_ts")) and r["durum"] == "dolduruluyor" and (
        datetime.now(timezone.utc) - r["ustlen_ts"]).total_seconds() < DEVIR_PENCERE_DK * 60
    return {"id": r["id"], "durum": r["durum"], "gun": r["is_gunu"].isoformat(), "surum": r.get("surum"),
            "devreden_id": r.get("devreden_id"), "devreden": ad.get(r.get("devreden_id")),
            "devralan_id": r.get("devralan_id"), "devralan": ad.get(r.get("devralan_id")),
            "ustlenen_id": r.get("ustlenen_id"), "ustlenen": ad.get(r.get("ustlenen_id")), "vekil": bool(r.get("vekil")),
            "sayilan": None if sk is None else int(sk) / 100, "bardak": r.get("bardak") or [], "urunler": r.get("urunler") or [],
            "pasta": r.get("pasta_adet"), "panel": _saat(r["panel_ts"]), "ustlen_saat": _saat(r.get("ustlen_ts")), "pencere": pencere,
            "devreden_saat": _saat(r.get("devreden_ts")), "devralan_saat": _saat(r.get("devralan_ts")), "not": r.get("devralan_not") or (f"merkez: {r.get('merkez_aciklama')}" if r.get("merkez_aciklama") else None),   # B57
            "devralan_sayilan": None if ds is None else int(ds) / 100, "merkez_sonuc": r.get("merkez_sonuc")}


def devir_durum(cur, sube_id: str, gun: Optional[date] = None) -> Optional[dict]:
    """PUBLIC: şube+günün açık devri; yoksa günün son devri (panel durum + telefon)."""
    yoklama_hazirla()
    _devir_dus(cur)
    cur.execute("""SELECT * FROM ey_devir WHERE sube_id=%s AND is_gunu=%s AND durum NOT IN ('iptal','dustu')
                    ORDER BY (durum = ANY(%s)) DESC, panel_ts DESC LIMIT 1""", (sube_id, gun or is_gunu(), list(DEVIR_ACIK)))
    r = cur.fetchone()
    return _devir_dict(cur, dict(r)) if r else None


def kapanis_sorumlusu(cur, sube_id: str, gun: Optional[date] = None) -> Optional[dict]:
    """PUBLIC: son tamamlanan (tamam / tutmuyor / merkez kapandı) devrin devralanı (F7: kapanışçı = gönderen esas; bu yanında)."""
    yoklama_hazirla()
    cur.execute("""SELECT d.devralan_id FROM ey_devir d
                    WHERE d.devralan_id IS NOT NULL AND d.sube_id=%s AND d.is_gunu=%s AND (d.durum IN ('tamam','tutmuyor') OR (d.durum='merkez_kapatti' AND d.merkez_sonuc='kapandi'))
                    ORDER BY COALESCE(d.devralan_ts, d.panel_ts) DESC LIMIT 1""", (sube_id, gun or is_gunu()))
    r = cur.fetchone()
    if not r:
        return None
    pid = dict(r)["devralan_id"]
    return {"personel_id": pid, "ad": adlar(cur, "ey_personel", [pid]).get(str(pid))}


def _devir_olay(cur, d: dict, veri_ek: dict) -> Optional[str]:
    """'vardiya' olayı — Satış › Devir defteri / kasa sağlaması bunu okur (var olan okuyucu; kaynak değişmez)."""
    from evvel_yeni_olay import olay_yaz
    from evvel_yeni_cekirdek import deneme_mi
    if deneme_mi(cur, date.fromisoformat(str(d["is_gunu"])[:10])):   # tek kural (F#1) — deneme dönemi: telefon onayları denenir, vardiya olayı (Satış › Devir defteri) yazılmaz
        return None
    ad = adlar(cur, "ey_personel", [d.get("devreden_id"), d.get("devralan_id")])
    a = {"id": d.get("devreden_id"), "ad": ad.get(d.get("devreden_id"))}
    v = {"id": d.get("devralan_id"), "ad": ad.get(d.get("devralan_id"))}
    return olay_yaz(cur, sube_id=d["sube_id"], tur="vardiya", is_gunu=d["is_gunu"], kok=panel_kok("vardiya", d['sube_id'], d['id']),
                    kaynak_tablo="panel", kaynak_id=d["id"], personel_id=a["id"], personel_ad=a["ad"],
                    tutar=__import__("decimal").Decimal(int(d.get("sayilan_kurus") or 0)) / 100,
                    veri={"devreden": a, "devralan": v, "sayilan": int(d.get("sayilan_kurus") or 0), "bardak": d.get("bardak") or [],
                          "urunler": d.get("urunler") or [], "pasta": d.get("pasta_adet"), "vekil": bool(d.get("vekil")),
                          "ustlenen_id": d.get("ustlenen_id"), "devir_id": d["id"], "surum": d.get("surum"), **veri_ek})


def _devir_al(cur, did: str, ek_kisi: Optional[str] = None, ek_kisi2: Optional[str] = None) -> dict:
    """Codex: TEK kilit sırası — devir (şube+gün) kilidi → ilgili kişilerin kilidi kimlik sırasıyla → satır FOR UPDATE."""
    cur.execute("SELECT sube_id, is_gunu FROM ey_devir WHERE id=%s", (did,))
    r0 = cur.fetchone()
    if not r0:
        raise HTTPException(404, "Devir bulunamadı")
    r0 = dict(r0)
    _devir_kilit(cur, r0["sube_id"], r0["is_gunu"])
    cur.execute("SELECT devreden_id, devralan_id, ustlenen_id FROM ey_devir WHERE id=%s", (did,))
    r1 = dict(cur.fetchone())
    for pid in sorted({x for x in (r1["devreden_id"], r1["devralan_id"], r1["ustlenen_id"], ek_kisi, ek_kisi2) if x}):
        personel_kilidi(cur, pid)
    cur.execute("SELECT * FROM ey_devir WHERE id=%s FOR UPDATE", (did,))
    return dict(cur.fetchone())


def _canli_konum_sart(cur, sube_id: str) -> None:
    """Para devri: canlıda (1 Kasım sonrası) şube koordinatı tanımsızsa devir yapılmaz (Fable — QR fotoğrafı uzaktan okutulmasın)."""
    from evvel_yeni_cekirdek import deneme_mi
    if deneme_mi(cur):   # tek kural (F#1)
        return
    s = tanim_oku(cur, "ey_sube", sube_id, ("lat", "lng")) or {}
    if s.get("lat") is None or s.get("lng") is None:
        raise HTTPException(409, "Şubenin konumu tanımlı değil — devir yapılamaz, merkeze haber ver (Tanımlar › Şube)")


@router.post("/devir-baslat")
async def devir_baslat_uc(request: Request):
    """Panel (kayıtlı PC imzası): 💵 Kasa Devri → 'Devri başlat'. Kişi / form panelde YOK — devreden QR'ı okutup telefonda doldurur."""
    yoklama_hazirla()
    ham = await request.body()

    def _is():
        with db() as (conn, cur):
            c = cihaz_coz(cur, request.headers, "POST", request.url.path, ham, tur="tablet")
            try:
                v = json.loads(ham) if ham else {}
            except ValueError:
                raise HTTPException(400, "İstek okunamadı")
            if not c.get("sube_id"):
                raise HTTPException(403, "Bu bilgisayar bir şubeye bağlı değil — merkezden bağlantı iste")
            try:
                from evvel_yeni_olay import gun_kapandi
                if gun_kapandi(cur, c["sube_id"], is_gunu()):   # Olay'ın kapısı (F#11)
                    raise HTTPException(409, "Gün kapandı — devir başlatılamaz")
            except HTTPException:
                raise
            except Exception:  # noqa: BLE001
                log.warning("devir: gün kapanış kontrolü okunamadı", exc_info=True)
            r = devir_baslat(cur, c["sube_id"], is_gunu(), _istek(v))
            return {"ok": True, **r, "devir": devir_durum(cur, c["sube_id"]),
                    "mesaj": "Devir başladı — devreden QR'ı telefonuyla okutsun"}
    return await run_in_threadpool(_is)


def _devir_rol(cur, d: dict, p: dict, sube: str) -> str:
    """Telefonda bu kişinin bu devirdeki yeri."""
    if d["durum"] == "baslatildi" or (d["durum"] == "dolduruluyor" and not d["pencere"]):
        return "ustlenebilir"
    if d["durum"] == "dolduruluyor":
        return "form" if d.get("ustlenen_id") == p["id"] else "bekle"
    if d["durum"] == "devreden_onayladi":
        return "devreden_bekle" if d.get("devreden_id") == p["id"] else "devralan"
    return "bitti"


@router.get("/devir/{did}/telefon")
async def devir_telefon(did: str, request: Request, sube: Optional[str] = None, qr: Optional[str] = None):
    """Telefon (imzalı): devir QR'ı okutuldu → bu kişinin rolü + devir + form kalemleri + içeride mi."""
    def fn(cur, c, p, _v):
        cur.execute("SELECT * FROM ey_devir WHERE id=%s", (did,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Devir bulunamadı")
        _devir_dus(cur)
        cur.execute("SELECT * FROM ey_devir WHERE id=%s", (did,))
        d = _devir_dict(cur, dict(cur.fetchone()))
        s = dict(r)["sube_id"]
        # Codex P1 (21 Eki): kasa beyanı / ürünler / adlar yalnız devrin TARAFINA ya da o şubenin GEÇERLİ QR'ını okutana
        # (eski / kopyalanmış devir bağlantısı yetmez; adresteki şube devrin şubesi olmalı)
        if sube and str(sube) != str(s):
            raise HTTPException(404, "Devir bulunamadı")
        taraf = p["id"] in {dict(r).get("devreden_id"), dict(r).get("ustlenen_id"), dict(r).get("devralan_id")} - {None}
        if not taraf and qr_dogrula(cur, str(s), qr or "") is None:
            raise HTTPException(409, "QR süresi doldu — paneldeki devir QR'ını yeniden okut")
        sube_ad = adlar(cur, "ey_sube", [s]).get(str(s))
        icerde = acik_mi(cur, s, p["id"])
        cur.execute("SELECT DISTINCT y.personel_id FROM ey_yoklama y WHERE y.sube_id=%s AND y.cikis_ts IS NULL AND y.is_gunu=%s AND y.personel_id<>%s",
                    (s, is_gunu(), p["id"]))
        _ic = [dict(x)["personel_id"] for x in cur.fetchall() or []]
        _ad = adlar(cur, "ey_personel", _ic)
        digerleri = sorted(({"id": i, "ad": _ad[i]} for i in _ic if i in _ad), key=lambda x: __import__("evvel_yeni_cekirdek").tr_sira(x["ad"]))   # "başka personel adına" adayları
        cur.execute("SELECT sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (p["id"],))
        ac = cur.fetchone()
        return {"kisi": p["ad"], "muaf": bool(p.get("konum_muaf")), "sube": s, "sube_ad": sube_ad, "gun": is_gunu().isoformat(),
                "devir": d, "rol": _devir_rol(cur, d, p, s), "icerde": icerde,
                "baska_subede": bool(ac) and dict(ac)["sube_id"] != s, "digerleri": digerleri,
                "liste": devir_listesi(cur), "pencere_dk": DEVIR_PENCERE_DK}
    return await _telefon(request, fn)


@router.post("/devir/{did}/ustlen")
async def devir_ustlen(did: str, request: Request):
    """Devreden QR'ı okuttu → devir onun (formda 'X adına' seçilebilir — telefonu olmayan içerideki personel) → 15 dk form penceresi.
    Sahip: ilk okutan içerideki kişi OTOMATİK devreden (soru yok)."""
    def fn(cur, c, p, v):
        ist = _istek(v)
        cur.execute("SELECT id FROM ey_devir WHERE id=%s AND jsonb_exists(istekler, %s)", (did, "u:" + ist))
        if cur.fetchone():   # aynı istek (ağ tekrarı) → durum
            cur.execute("SELECT * FROM ey_devir WHERE id=%s", (did,))
            return {"ok": True, "tekrar": True, "devir": _devir_dict(cur, dict(cur.fetchone()))}
        d = _devir_al(cur, did, ek_kisi=p["id"])
        if (d.get("istekler") or {}).get("u:" + ist):   # Fable: aynı istek kilit beklerken tamamlandı
            return {"ok": True, "tekrar": True, "devir": _devir_dict(cur, d)}
        if d["durum"] not in ("baslatildi", "dolduruluyor"):
            raise HTTPException(409, "Bu devir artık devredene açık değil" if d["durum"] != "devreden_onayladi"
                                else "Devreden zaten onayladı — devralan isen KABUL ET")
        dd = _devir_dict(cur, d)
        if d["durum"] == "dolduruluyor" and dd["pencere"] and d.get("ustlenen_id") != p["id"]:
            raise HTTPException(409, f"{dd['ustlenen'] or 'Başka biri'} şu an devrediyor — bekle")
        _canli_konum_sart(cur, d["sube_id"])
        sube, k = _qr_islem(cur, c, p, v, "ustlen")
        if sube != d["sube_id"]:
            raise HTTPException(409, "Devir başka şubede — o şubenin QR'ını okut")
        if d["is_gunu"] != is_gunu():
            raise HTTPException(409, "Bu devir önceki güne ait — panelden yeniden başlat")
        if not acik_mi(cur, sube, p["id"]):
            raise HTTPException(409, "Önce bu şubeye giriş yap — sonra devredersin (aynı QR)")
        cur.execute("""UPDATE ey_devir SET durum='dolduruluyor', devreden_id=%s, ustlenen_id=%s, ustlen_ts=NOW(), vekil=FALSE, ustlen_mesafe_m=%s,
                              istekler = istekler || jsonb_build_object(%s::text, 'u') WHERE id=%s""",
                    (p["id"], p["id"], k["mesafe_m"], "u:" + ist, did))
        cur.execute("SELECT * FROM ey_devir WHERE id=%s", (did,))
        return {"ok": True, "devir": _devir_dict(cur, dict(cur.fetchone())), "mesafe_m": k["mesafe_m"]}
    return await _telefon(request, fn)


def _devir_sayilar(cur, v: dict) -> tuple:
    """Telefondan gelen form (eski 5 adım AYNEN): her kalem dolu (0 yazılabilir), tam sayı, eksi yok, katalog dışı yok."""
    from decimal import Decimal
    if v.get("dogruladim") is not True:
        raise HTTPException(400, "Kasadaki nakit sayımını doğruladığını işaretle")
    from evvel_yeni_cekirdek import tutar_oku
    kasa = tutar_oku(v.get("kasa"), "Kasadaki nakit")   # Türkçe yazı tek ayrıştırıcıdan (Dalga 4)
    if kasa < 0 or kasa > 1000000 or kasa != kasa.quantize(Decimal("0.01")):
        raise HTTPException(400, "Kasadaki nakit için geçerli değer gir")
    liste = devir_listesi(cur)

    def kalemler(anahtar: str, gerek: list) -> list:
        gelen = {}
        for x in v.get(anahtar) or []:
            uid = str((x or {}).get("urun_id") or "")
            if uid in gelen:
                raise HTTPException(400, "Aynı ürün iki kez — formu yenile")
            gelen[uid] = (x or {}).get("sayilan")
        izinli = {u["id"] for u in gerek}
        if set(gelen) - izinli:
            raise HTTPException(400, "Listede olmayan ürün — formu yenile")
        out = []
        for u in gerek:
            out.append({"urun_id": u["id"], "ad": u["ad"], "sayilan": adet_oku(gelen.get(u["id"]), u["ad"])})   # TEK adet kuralı (F#17)
        return out
    bardak = kalemler("bardak", liste["bardak"])
    urunler = kalemler("urunler", liste["urun"])
    pn = adet_oku(v.get("pasta"), "Pasta", en_cok=10000)
    return int(kasa * 100), bardak, urunler, pn


@router.post("/devir/{did}/devret")
async def devir_devret(did: str, request: Request):
    """Devreden (ya da adına dolduran) telefondan: 5 adım form + ☑ doğruladım → 'Devrediyorum'. QR yeniden İSTENMEZ
    (15 dk pencere, sahip); konum yeniden ölçülür."""
    def fn(cur, c, p, v):
        ist = _istek(v)
        r = _istek_kaydi(cur, "ey_devir", "devret_istek_id", ist, "id, ustlenen_id", {"id": did, "ustlenen_id": p["id"]})   # K2: tekrar bloğu tek
        if r:
            return {"ok": True, "tekrar": True, "mesaj": "Devir zaten gönderildi"}
        adina = str(v.get("adina") or "").strip() or None   # sahip: devredenin telefonu yoksa içerideki başka personel ONUN ADINA
        d = _devir_al(cur, did, ek_kisi=p["id"], ek_kisi2=adina if adina and adina != p["id"] else None)
        if d.get("devret_istek_id") == ist:   # Fable: aynı istek kilit beklerken tamamlandı
            return {"ok": True, "tekrar": True, "mesaj": "Devir zaten gönderildi"}
        if d["durum"] != "dolduruluyor" or d.get("ustlenen_id") != p["id"]:
            raise HTTPException(409, "Bu devir artık senin formunda değil — QR'ı tekrar okut" if d["durum"] in ("baslatildi", "dolduruluyor")
                                else "Bu devir artık onay beklemiyor")
        if (datetime.now(timezone.utc) - d["ustlen_ts"]).total_seconds() > DEVIR_PENCERE_DK * 60:
            raise HTTPException(409, f"{DEVIR_PENCERE_DK} dakika doldu — QR'ı tekrar okut (yazdıkların duruyor)")
        if d["is_gunu"] != is_gunu():
            raise HTTPException(409, "Bu devir önceki güne ait — panelden yeniden başlat")
        sube = str(v.get("sube") or "")
        if sube != d["sube_id"]:
            raise HTTPException(409, "Devir başka şubede")
        _canli_konum_sart(cur, sube)
        k = konum_kontrol(cur, sube, p, v.get("lat"), v.get("lng"))
        kasa, bardak, urunler, pasta = _devir_sayilar(cur, v)
        if adina and adina != p["id"]:
            d["devreden_id"] = adina
        else:
            d["devreden_id"] = p["id"]
        if not acik_mi(cur, sube, d["devreden_id"]):
            raise HTTPException(409, "Devreden bu şubede içeride görünmüyor — önce giriş yapsın")
        cur.execute("SELECT id FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND cikis_ts IS NULL AND is_gunu=%s",
                    (d["devreden_id"], sube, is_gunu()))
        yk = dict(cur.fetchone() or {}).get("id")
        surum = _devir_surum(d["devreden_id"], kasa, bardak, urunler, pasta)
        cur.execute("""UPDATE ey_devir SET durum='devreden_onayladi', devreden_id=%s, vekil=%s, sayilan_kurus=%s, bardak=%s::jsonb,
                              urunler=%s::jsonb, pasta_adet=%s, surum=%s, devreden_ts=NOW(), devreden_mesafe_m=%s, devreden_surum=%s,
                              devret_istek_id=%s, devreden_yoklama_id=%s WHERE id=%s""",
                    (d["devreden_id"], d["devreden_id"] != p["id"], kasa, json.dumps(bardak, ensure_ascii=False),
                     json.dumps(urunler, ensure_ascii=False), pasta, surum, k["mesafe_m"], surum, ist, yk, did))
        return {"ok": True, "mesaj": f"Devrettin · {_saat(datetime.now(timezone.utc))}. Şimdi devralan paneldeki QR'ı okutup kabul etsin."}
    return await _telefon(request, fn)


@router.post("/devir/{did}/kabul")
async def devir_kabul(did: str, request: Request):
    """Devralan = devredenden farklı, QR'ı okutup İLK kabul eden kişi. 'Kabul ediyorum' ya da 'Tutmuyor' + KENDİ saydığı kasa tutarı
    (sahip). TEK işlemde: devir tamam + vardiya olayı + devredenin çıkışı ('devir') + devralanın girişi (yoksa)."""
    def fn(cur, c, p, v):
        ist = _istek(v)
        r = _istek_kaydi(cur, "ey_devir", "kabul_istek_id", ist, "id, devralan_id, durum", {"id": did, "devralan_id": p["id"]})   # K2: tekrar bloğu tek
        if r:
            return {"ok": True, "tekrar": True, "mesaj": "Devir zaten " + ("kabul edildi" if dict(r)["durum"] == "tamam" else "kaydedildi")}
        d = _devir_al(cur, did, ek_kisi=p["id"])
        if d.get("kabul_istek_id") == ist:   # Fable: aynı istek kilit beklerken tamamlandı
            return {"ok": True, "tekrar": True, "mesaj": "Devir zaten " + ("kabul edildi" if d["durum"] == "tamam" else "kaydedildi")}
        if d["durum"] in ("tamam", "tutmuyor"):
            raise HTTPException(409, f"{adlar(cur, 'ey_personel', [d.get('devralan_id')]).get(str(d.get('devralan_id'))) or 'Başka biri'} zaten devraldı")
        if d["durum"] != "devreden_onayladi":
            raise HTTPException(409, "Önce devreden telefonundan göndersin" if d["durum"] in ("baslatildi", "dolduruluyor")
                                else "Bu devir artık onay beklemiyor")
        if d.get("devreden_id") == p["id"]:
            raise HTTPException(403, "Kendi devrettiğin kasayı alamazsın — devralan okutsun")
        if str(v.get("surum") or "") != (d.get("surum") or ""):
            raise HTTPException(409, "Devir değişti — tekrar bak")
        if d["is_gunu"] != is_gunu():
            raise HTTPException(409, "Bu devir önceki güne ait — merkez kapatsın")   # Codex: eski devir bugünün mesaisini kapatmasın
        tutuyor = bool(v.get("tutuyor", True))
        not_ = str(v.get("not") or "").strip()[:200]
        ds = None
        if not tutuyor:   # sahip: tutmuyorsa devralanın KENDİ saydığı tutar zorunlu → fark merkeze
            from evvel_yeni_cekirdek import kurus, tutar_oku
            dsd = tutar_oku(v.get("sayilan"), "Kendi saydığın kasa tutarı")   # Türkçe yazı tek ayrıştırıcıdan (Dalga 4)
            if dsd < 0 or dsd > 1000000:
                raise HTTPException(400, "Kendi saydığın kasa tutarını yaz")
            ds = kurus(dsd)
        _canli_konum_sart(cur, d["sube_id"])
        sube, k = _qr_islem(cur, c, p, v, "kabul")
        if sube != d["sube_id"]:
            raise HTTPException(409, "Devir başka şubede — o şubenin QR'ını okut")
        cur.execute("SELECT sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        if a and dict(a)["sube_id"] != sube:
            raise HTTPException(409, "Önce diğer şubeden çıkış yap")
        d["devralan_id"] = p["id"]
        oid = _devir_olay(cur, d, {"tutuyor": tutuyor, "not": not_ or None,
                                   "devralan_sayilan": ds, "fark": None if ds is None else ds - int(d.get("sayilan_kurus") or 0)})
        if d.get("devreden_yoklama_id"):
            cikis_yaz(cur, d["devreden_id"], "devir", kim=f"devir · {p['ad']}", sube_id=sube, yoklama_id=d["devreden_yoklama_id"])
        if not a:   # devralan henüz girmemişti → girişi bu onayla açılır (QR + konum doğrulandı)
            cur.execute("""INSERT INTO ey_yoklama (id, sube_id, personel_id, is_gunu, giris_ts, giris_mesafe_m, giris_muaf, giris_cihaz_id, istek_id)
                           VALUES (%s,%s,%s,%s,NOW(),%s,%s,%s,%s)""",
                        ("yk-" + uuid.uuid4().hex[:16], sube, p["id"], is_gunu(), k["mesafe_m"], k["muaf"], c["cihaz_id"], "dv-" + ist))
        cur.execute("""UPDATE ey_devir SET durum=%s, devralan_id=%s, devralan_ts=NOW(), devralan_mesafe_m=%s, devralan_surum=%s, devralan_not=%s,
                              devralan_sayilan_kurus=%s, olay_id=%s, kabul_istek_id=%s WHERE id=%s""",
                    ("tamam" if tutuyor else "tutmuyor", p["id"], k["mesafe_m"], d["surum"], not_ or None, ds, oid, ist, did))
        return {"ok": True, "mesaj": (f"Devir tamam · {_saat(datetime.now(timezone.utc))}. Kasa artık sende — girişin açık." if tutuyor
                                      else "Devir kaydedildi — saydığın tutar merkeze iletildi. Kasa artık sende — girişin açık.")}
    return await _telefon(request, fn)


@router.get("/devirler")
def devirler(bas: Optional[str] = None, son: Optional[str] = None, acik: bool = False,
             x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: devir listesi. acik=1: tamamlanmamış (Bekleyen işler ölçütü) + görülmemiş 'tutmuyor'."""
    yoklama_hazirla()
    with db() as (conn, cur):
        _merkez(cur, x_evvel_oturum)
        q = "SELECT d.* FROM ey_devir d WHERE "
        if acik:
            cur.execute(q + """(d.durum IN ('hazir','devreden_onayladi') AND (d.is_gunu < %s OR COALESCE(d.devreden_ts, d.panel_ts) < NOW() - INTERVAL '2 hours'))
                               OR ((d.durum='tutmuyor' OR (d.durum='tamam' AND d.vekil)) AND d.gorulen IS NULL) ORDER BY d.is_gunu, d.panel_ts""", (is_gunu(),))
        elif bas and son:
            cur.execute(q + "d.is_gunu BETWEEN %s AND %s AND d.durum NOT IN ('iptal','dustu','baslatildi','dolduruluyor') ORDER BY d.is_gunu, d.panel_ts", (bas, son))
        else:
            raise HTTPException(400, "bas/son ya da acik=1")
        rows = [dict(r) for r in cur.fetchall() or []]
        sad = adlar(cur, "ey_sube", {r["sube_id"] for r in rows})
        out = [{**_devir_dict(cur, r), "sube": sad.get(str(r["sube_id"])), "gorulen": r.get("gorulen")} for r in rows]
    return {"satirlar": out}


class MerkezKapatBody(BaseModel):
    sonuc: str          # iptal | kapandi
    aciklama: str


@router.post("/devir/{did}/merkez-kapat")
def devir_merkez_kapat(did: str, b: MerkezKapatBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: tamamlanmamış devri kapatır — 'iptal' (yan etki yok) ya da 'kapandı' (vardiya olayı merkez_istisna + devreden çıkışı).
    Ekranda 'merkez kapattı' görünür; kişi onayı gibi görünmez."""
    yoklama_hazirla()
    if b.sonuc not in ("iptal", "kapandi"):
        raise HTTPException(400, "Sonuç: iptal ya da kapandı")
    if len((b.aciklama or "").strip()) < 2:
        raise HTTPException(400, "Açıklama yaz")
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        d = _devir_al(cur, did)
        if d["durum"] not in ("baslatildi", "dolduruluyor", "hazir", "devreden_onayladi"):
            raise HTTPException(409, "Bu devir zaten kapanmış")
        if b.sonuc == "kapandi" and d["durum"] in ("baslatildi", "dolduruluyor"):
            raise HTTPException(400, "Devreden formu göndermemiş — yalnız iptal edilebilir")
        oid = None
        if b.sonuc == "kapandi":
            oid = _devir_olay(cur, d, {"merkez_istisna": True, "merkez": kim, "aciklama": b.aciklama.strip()[:200]})
            if d.get("devreden_yoklama_id"):   # Codex: dünkü devir bugünkü yeni girişi kapatmasın
                cikis_yaz(cur, d["devreden_id"], "devir", kim=f"merkez: {kim}", sube_id=d["sube_id"], yoklama_id=d["devreden_yoklama_id"])
        cur.execute("""UPDATE ey_devir SET durum='merkez_kapatti', merkez_sonuc=%s, merkez_kim=%s, merkez_aciklama=%s, olay_id=COALESCE(%s, olay_id)
                        WHERE id=%s""", (b.sonuc, kim, b.aciklama.strip()[:200], oid, did))
    return {"ok": True, "mesaj": "Merkez kapattı — " + ("devir sayıldı" if b.sonuc == "kapandi" else "iptal")}


@router.post("/devir/{did}/gorundu")
def devir_gorundu(did: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    yoklama_hazirla()
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        cur.execute("""UPDATE ey_devir SET gorulen=%s WHERE id=%s AND (durum='tutmuyor' OR (durum='tamam' AND vekil)) AND gorulen IS NULL
                       RETURNING id""", (kim, did))
        if not cur.fetchone():
            raise HTTPException(404, "Görülecek 'tutmuyor' devri yok")
    return {"ok": True, "mesaj": "Görüldü"}


# ─────────────────────────── Bekleyen işler (grup personel; personele gitmez) ───────────────────────────
def _bekleyen(cur, baglam: dict) -> list:
    yoklama_hazirla()
    gece_kapat(cur)   # geçmiş günlerin açıkları kapanır (sahip: gece kapanır, iş bırakmaz)
    out = []
    bugun = is_gunu()
    cur.execute("""SELECT y.id, y.is_gunu, y.personel_id, y.sube_id FROM ey_yoklama y WHERE y.cikis_ts IS NULL AND y.is_gunu < %s
                    ORDER BY y.is_gunu""", (bugun,))
    for r in _adla(cur, [dict(x) for x in cur.fetchall() or []]):
        out.append({"tur": "yoklama_cikis_yok", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                    "etiket": "🚪 Çıkış yok", "ad": f"{r['ad']} — {r['sube_ad'] or ''} {r['is_gunu'].strftime('%d.%m')} çıkış yapmadı",
                    "alt": "Çıkış saatini Personel › Telefonlar'dan yaz", "sayfa": "personel_telefon", "dugme": "Aç"})
    cur.execute("""SELECT m.id, m.is_gunu, m.sure_dk, m.bitis_ts, m.personel_id, m.sube_id FROM ey_mola m
                    WHERE (m.bitis_ts IS NULL AND (m.is_gunu < %s OR m.baslangic_ts < NOW() - (%s || ' minutes')::interval))
                       OR (m.yemek_hakki = FALSE AND NOT m.hak_elle AND m.gorulen IS NULL)
                    ORDER BY m.is_gunu""", (bugun, str(mola_limit(cur) + 1)))
    from evvel_yeni_tanim_api import mudur_mu, tanim_listesi
    _mud = {str(p["id"]) for p in tanim_listesi(cur, "ey_personel", ("gorev",)) if mudur_mu(p.get("gorev"))}   # B56
    for r in _adla(cur, [dict(x) for x in cur.fetchall() or []]):
        if r["bitis_ts"] is not None and str(r["personel_id"]) in _mud:
            continue   # B56: müdürün yemek hakkı şartsız — 'hakkı düştü' işi yok
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
    cur.execute("""SELECT d.id, d.is_gunu, d.durum, d.devralan_not, d.sayilan_kurus, d.devralan_sayilan_kurus, d.vekil,
                          d.sube_id, d.devreden_id, d.devralan_id, d.ustlenen_id
                     FROM ey_devir d
                    WHERE (d.durum IN ('hazir','devreden_onayladi') AND (d.is_gunu < %s OR COALESCE(d.devreden_ts, d.panel_ts) < NOW() - INTERVAL '2 hours'))
                       OR (d.durum IN ('tutmuyor','tamam') AND d.gorulen IS NULL AND (d.durum='tutmuyor' OR d.vekil))
                    ORDER BY d.is_gunu""", (bugun,))
    _drows = [dict(x) for x in cur.fetchall() or []]
    _pa = adlar(cur, "ey_personel", {r[k] for r in _drows for k in ("devreden_id", "devralan_id", "ustlenen_id") if r.get(k)})
    _sa = adlar(cur, "ey_sube", {r["sube_id"] for r in _drows})
    for r in _drows:
        r.update(sube_ad=_sa.get(str(r["sube_id"])), devreden=_pa.get(str(r.get("devreden_id"))), devralan=_pa.get(str(r.get("devralan_id"))),
                 ustlenen=_pa.get(str(r.get("ustlenen_id"))))
        if r["durum"] in ("tutmuyor", "tamam"):   # tutmuyor (fark) ya da başka personel ADINA devir (sahip: merkeze bildirim)
            fark = ""
            if r.get("devralan_sayilan_kurus") is not None and r.get("sayilan_kurus") is not None:
                fark = f" · devreden {_tl_tr(int(r['sayilan_kurus']))}, devralan {_tl_tr(int(r['devralan_sayilan_kurus']))}"
            vek = f" · {r['ustlenen']} adına doldurdu" if r.get("vekil") else ""
            out.append({"tur": "yoklama_devir_tutmuyor", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "⚠ Devir tutmuyor" if r["durum"] == "tutmuyor" else "👥 Devir başkası adına",
                        "ad": f"{r['sube_ad'] or ''} {r['devreden']} → {r['devralan']}{fark}{vek}" + (f": '{r['devralan_not']}'" if r.get("devralan_not") else ""),
                        "alt": "Gördüm — Personel › Devirler", "sayfa": "personel_devir", "dugme": "Aç"})
        else:
            out.append({"tur": "yoklama_devir_tamamlanmadi", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "🔁 Devir tamamlanmadı", "ad": f"{r['sube_ad'] or ''} {r['devreden']} → {r['devralan']} · "
                                                              + ("devreden onaylamadı" if r["durum"] == "hazir" else "devralan kabul etmedi"),
                        "alt": "Kapat: iptal ya da devir sayıldı — Personel › Devirler", "sayfa": "personel_devir", "dugme": "Aç"})
    cur.execute("SELECT DISTINCT personel_id FROM ey_cihaz WHERE durum='aktif' AND personel_id IS NOT NULL")
    _tel = {dict(x)["personel_id"] for x in cur.fetchall() or []}
    n = sum(1 for p in tanim_listesi(cur, "ey_personel", ("gorev",), aktif=True) if not mudur_mu(p.get("gorev")) and p["id"] not in _tel)
    if n:
        out.append({"tur": "yoklama_telefon_yok", "genel": True, "grup": "personel", "id": "telefon_yok", "tarih": bugun.isoformat(),
                    "etiket": "📱 Telefon", "ad": f"{n} personelin telefonu bağlı değil", "alt": "Bağlantı linki üret — 1 Kasım'dan önce herkes",
                    "sayfa": "personel_telefon", "dugme": "Telefonlar"})
    cur.execute("SELECT sube_id, durum FROM ey_cihaz WHERE sube_id IS NOT NULL AND durum IN ('onay','aktif')")
    _cz = {(dict(x)["sube_id"], dict(x)["durum"]) for x in cur.fetchall() or []}
    _sub = [{"ad": s["ad"], "onay": (s["id"], "onay") in _cz, "aktif": (s["id"], "aktif") in _cz, "konumsuz": s["lat"] is None}
            for s in tanim_listesi(cur, "ey_sube", ("ad", "lat", "depo"), aktif=True)
            # yalnız depo olan yer panel istemez; depo + şube (Tema) paneli bağlıysa onun da koordinatı sorulur (B87)
            if not s.get("depo") or (s["id"], "onay") in _cz or (s["id"], "aktif") in _cz]
    for r in _sub:
        if r["onay"]:
            out.append({"tur": "yoklama_tablet_onay", "genel": True, "grup": "personel", "id": "tablet_onay:" + r["ad"], "tarih": bugun.isoformat(),
                        "etiket": "🖥️ Panel", "ad": f"{r['ad']} panel bilgisayarı onay bekliyor", "alt": "Bu bilgisayar o şubenin mi? Onayla",
                        "sayfa": "personel_telefon", "dugme": "Telefonlar"})
        elif not r["aktif"]:
            out.append({"tur": "yoklama_tablet_yok", "genel": True, "grup": "personel", "id": "tablet_yok:" + r["ad"], "tarih": bugun.isoformat(),
                        "etiket": "🖥️ Panel", "ad": f"{r['ad']} panel bilgisayarı kayıtlı değil", "alt": "Panel bilgisayarı için bağlantı linki üret (QR'ı panel ekranı gösterir)",
                        "sayfa": "personel_telefon", "dugme": "Telefonlar"})
        if r["konumsuz"]:
            out.append({"tur": "yoklama_konum_yok", "genel": True, "grup": "personel", "id": "konum_yok:" + r["ad"], "tarih": bugun.isoformat(),
                        "etiket": "📍 Koordinat", "ad": f"{r['ad']} şubesinin koordinatı yok", "alt": "Konum kontrolü yapılamıyor — Tanımlar › Şubeler",
                        "sayfa": "personel_telefon", "dugme": "Telefonlar"})
    return out


bekleyen_is_kaydet("yoklama", _bekleyen)
