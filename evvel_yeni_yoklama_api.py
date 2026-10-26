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
                       ("vekil", "BOOLEAN NOT NULL DEFAULT FALSE"), ("devralan_sayilan_kurus", "BIGINT"),
                       # v2 (DEVIR_KURGU_V2, sahip 23 Eki): iki taraf kör sayar → devralanın kendi sayımı + tur + merkez kararı
                       ("devralan_bardak", "JSONB"), ("devralan_urunler", "JSONB"), ("devralan_pasta", "INT"), ("devralan_ustlen_ts", "TIMESTAMPTZ"),
                       ("devralan_muaf", "BOOLEAN"), ("devralan_cihaz_id", "TEXT"), ("tur", "INT NOT NULL DEFAULT 1"), ("tur1", "JSONB"),
                       ("fark_kalem", "JSONB")):
            cur.execute(f"ALTER TABLE ey_devir ADD COLUMN IF NOT EXISTS {_k} {_t}")
        try:
            with savepoint(cur, "sp_ey_devir_acik2"):
                cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_devir_acik2 ON ey_devir (sube_id, is_gunu)
                               WHERE durum IN ('baslatildi','dolduruluyor','hazir','devreden_onayladi')""")   # tek açık devir (yeni durumlar)
        except Exception:  # noqa: BLE001
            log.warning("ux_ey_devir_acik2 kurulamadı — uygulama kilidi korur", exc_info=True)
        try:
            with savepoint(cur, "sp_ey_devir_acik3"):
                cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS ux_ey_devir_acik3 ON ey_devir (sube_id, is_gunu)
                               WHERE durum IN ('baslatildi','sayiliyor','yeniden')""")   # v2: tek açık devir
        except Exception:  # noqa: BLE001
            log.warning("ux_ey_devir_acik3 kurulamadı — uygulama kilidi korur", exc_info=True)
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


def konum_gerekli(cur, sube_id: str, personel: dict) -> bool:
    """PUBLIC: bu kişi bu şubede konum göstermek zorunda mı — konum_kontrol ile AYNI kural, tek yer (F1.2 · L4b Opus + Fable + Codex C:
    telefon bilmeden düğmeyi açık bırakıyordu → bas, bekle, 403). Yönetici muaf (K2); şube koordinatsızsa gerekmez (K3)."""
    if personel.get("konum_muaf") or not sube_id:
        return False
    s = tanim_oku(cur, "ey_sube", sube_id, ("lat", "lng")) or {}
    return s.get("lat") is not None and s.get("lng") is not None


def konum_kontrol(cur, sube_id: str, personel: dict, lat, lng) -> dict:
    """PUBLIC: {mesafe_m, muaf}. Yönetici muaf (K2); şube koordinatsızsa serbest (K3). Uzaksa 403."""
    if not konum_gerekli(cur, sube_id, personel):
        return {"mesafe_m": None, "muaf": bool(personel.get("konum_muaf"))}
    s = tanim_oku(cur, "ey_sube", sube_id, ("lat", "lng", "yaricap_m")) or {}
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


def kisinin_bugunku_subesi(cur, personel_id: str) -> Optional[str]:
    """PUBLIC (Avans 'Elden ver' öntanımı · F4.2): kişinin BUGÜN QR'la girdiği şube — içerideyse o, iki şubede girip çıktıysa en son
    girdiği; bugün hiç girmediyse None (çağıran kadro şubesine düşer)."""
    if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_yoklama"):
        return None
    cur.execute("""SELECT sube_id FROM ey_yoklama WHERE personel_id=%s AND is_gunu=%s
                    ORDER BY (cikis_ts IS NULL) DESC, giris_ts DESC LIMIT 1""", (str(personel_id), is_gunu()))
    r = cur.fetchone()
    return str(dict(r)["sube_id"]) if r else None


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
    cur.execute("""SELECT 1 FROM ey_devir WHERE sube_id=%s AND is_gunu=%s AND (durum IN ('devreden_onayladi','baslatildi','sayiliyor','yeniden')
                     OR (durum='dolduruluyor' AND COALESCE(ustlen_ts, panel_ts) > NOW() - INTERVAL '30 minutes'))
                   LIMIT 1""", (str(sube_id), gun))   # Opus B6: v2 açık devri (günde bir — düşmez) kapanışta uyarılır
    return cur.fetchone() is not None


def acik_mi(cur, sube_id: str, personel_id: str) -> bool:
    """PUBLIC: kişinin bu şubede BUGÜN açık (çıkış yapılmamış) girişi var mı (panel ad listesi / kapısı). Dünün açığı sayılmaz."""
    yoklama_hazirla()
    cur.execute("SELECT 1 FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND cikis_ts IS NULL AND is_gunu >= %s",
                (personel_id, sube_id, is_gunu()))
    return bool(cur.fetchone())


def acik_giris_id(cur, sube_id: str, personel_id: str) -> Optional[str]:
    """PUBLIC: kişinin bu şubede BUGÜN açık girişinin kimliği (yoksa None) — K-5 telefonsuz gönderimde sabitlenir."""
    yoklama_hazirla()
    cur.execute("""SELECT id FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND cikis_ts IS NULL AND is_gunu >= %s
                   ORDER BY giris_ts DESC LIMIT 1""", (personel_id, sube_id, is_gunu()))
    r = cur.fetchone()
    return dict(r)["id"] if r else None


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


def telefonsuz_kapanis_cikisi(cur, personel_id: str, yoklama_id: str, ts, kim: str) -> Optional[str]:
    """PUBLIC — K-5 (sim 26 Eki · Opus + Codex + Fable A): telefonsuz kapanış merkezde GEÇ KAPANIŞ olarak işlenince, gönderen kişinin
    çıkışı "Merkeze gönder" saatiyle yazılır (telefonlu yolda onay anında yazılan çıkışın karşılığı; ertesi gün "Çıkışı yapılmamışlar"a
    elle iş düşmesin). YALNIZ gönderim anında sabitlenen giriş satırı (Codex: sonradan yeniden giriş kapatılmasın) ve yalnız açık ya da
    gece işinin saatsiz kapattığı hâliyle (qr / merkez / devir çıkışı EZİLMEZ). Saat girişten önce görünürse girişe kırpılır."""
    yoklama_hazirla()
    personel_kilidi(cur, personel_id)
    cur.execute("""SELECT id, giris_ts FROM ey_yoklama WHERE id=%s AND personel_id=%s
                     AND (cikis_ts IS NULL OR cikis_tur = 'gece_otomatik') FOR UPDATE""", (yoklama_id, personel_id))
    r = cur.fetchone()
    if not r:
        return None
    r = dict(r)
    cur.execute("SELECT GREATEST(%s::timestamptz, %s::timestamptz) AS t", (ts, r["giris_ts"]))
    t = dict(cur.fetchone())["t"]
    cur.execute("UPDATE ey_yoklama SET cikis_ts=%s, cikis_tur='kapanis_telefonsuz', degistiren=%s WHERE id=%s", (t, kim, r["id"]))
    try:   # Fable: mola başlangıcı gönderimden sonraysa _mola_kapat 400 atar — geç kapanışın tamamı geri alınmasın
        with savepoint(cur, "sp_tel_kap_mola"):
            _mola_kapat(cur, personel_id, "kapanis_telefonsuz", ts=t, kim=kim)
    except HTTPException:
        log.warning("telefonsuz kapanış çıkışı: mola kapatılamadı (%s) — gece kuralı kapatır", personel_id)
    return r["id"]


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
            pr = tanim_oku(cur, "ey_personel", b.personel_id, ("ad", "cikis"))   # R4-6 (sim 25 Eki · Opus): merkeze telefon diliyle hata dönüyordu
            if pr and __import__("evvel_yeni_tanim_api").ayrildi_mi(dict(pr).get("cikis"), is_gunu()):
                c_ = dict(pr)["cikis"]
                c_ = c_.strftime("%d.%m") if hasattr(c_, "strftime") else str(c_)[8:10] + "." + str(c_)[5:7]
                raise HTTPException(409, f"{dict(pr)['ad']} {c_} tarihinde ayrıldı — bağlantı üretilmez. Geri döndüyse önce Tanımlar'dan ayrılış tarihini kaldır.")
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
        _ayr = __import__("evvel_yeni_tanim_api").ayrildi_mi
        per = [{"id": p["id"], "ad": p["ad"], "sube_id": p["sube_id"], "sube_ad": sad.get(str(p["sube_id"])), "konum_muaf": p["konum_muaf"],
                "mudur": mudur_mu(p.get("gorev")),
                "ayrildi": (str(p.get("cikis"))[:10] if _ayr(p.get("cikis"), is_gunu()) else None)}   # R4-7: yeşil "bağlı" yanlış bilgi veriyordu
               for p in tanim_listesi(cur, "ey_personel", ("ad", "sube_id", "konum_muaf", "gorev", "cikis"), aktif=True)]
        from evvel_yeni_cekirdek import tr_sira
        per.sort(key=lambda p: (bool(p["ayrildi"]), p["sube_ad"] is None, tr_sira(p["sube_ad"]), tr_sira(p["ad"])))   # Türkçe sıra (Fable B6) · ayrılanlar en altta
        cur.execute("""SELECT id, tur, personel_id, sube_id, guc, etiket, durum, davet_son, olusturma, son_kullanim
                         FROM ey_cihaz WHERE durum<>'iptal' ORDER BY olusturma DESC""")
        cz = [dict(r) for r in cur.fetchall() or []]
        subeler = [{"id": s["id"], "ad": s["ad"], "konum": s["lat"] is not None}
                   for s in tanim_listesi(cur, "ey_sube", ("ad", "lat"), aktif=True)]
    def _c(x):
        return {"id": x["id"], "guc": x["guc"], "etiket": x["etiket"], "durum": x["durum"],
                "son_kullanim": str(x["son_kullanim"])[:16] if x["son_kullanim"] else None,
                "davet_son": str(x["davet_son"])[:16] if x["davet_son"] else None,
                # B-1 (F1.1): süre dolumu SUNUCUDA (davet_son saat dilimsiz metin gidiyor; telefonun "süresi doldu" kontrolüyle aynı kural)
                "davet_doldu": bool(x["durum"] == "davet" and x["davet_son"] and x["davet_son"] < datetime.now(x["davet_son"].tzinfo))}
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
        if mola and p.get("mudur"):   # F1.7: müdürün yemek hakkı şartsız (Maaş ile aynı) — 61. dk kapanışında "kaybettin" denmez
            mola = {**mola, "hak_dustu": False}
        burada = acik and son.get("sube_id") == sube
        yap = ["giris"] if not acik and sube else []
        from evvel_yeni_olay import gun_kapandi as _gk
        gun_kapali = bool(sube) and _gk(cur, str(sube), is_gunu())   # Q-1 (sim 26 Eki · Opus + Codex + Fable A): kapanmış güne giriş yok
        if gun_kapali:
            yap = [x for x in yap if x != "giris"]
        if burada:
            yap = (["mola_bitir"] if mola and mola["durum"] == "suruyor" else ([] if mola else ["mola_baslat"])) + ["cikis"]
        devir = None
        if sube and not gun_kapali:   # Codex (Q-1): kapanmış günde devir sunulmaz (devir zaten yasak) — çıkış düğmesi süzülmesin
            d = devir_durum(cur, sube)
            # v2 (sahip 23 Eki): devir açıkken şube QR'ını okutan → devir sayfasına davet (KÖR: rakam yok). Kasa sahibi "devret",
            # diğeri "kasayı devral" (devralanın vardiyası devirle başlar — ayrı 'giriş' yerine). Geçerli QR şart (Codex P1).
            if d and d["durum"] in DEVIR_YENI_ACIK and qr_dogrula(cur, str(sube), qr or "") is not None:
                sahip = kasa_sahibi(cur, sube)
                rol = "devreden" if p["id"] in (sahip, d.get("devreden_id"), d.get("ustlenen_id")) else "devralan"
                # G66 (sim 23 Eki): kasayı başkası devralıyorsa (geçerli üstlenme) diğerlerine 'Kasayı devral' gösterilmez — yalnız giriş
                if not (rol == "devralan" and d.get("devralan_id") and d["devralan_id"] != p["id"] and _devralan_gecerli(cur, d["id"])):
                    devir = {"rol": rol, "dv": d["id"], "devreden": d.get("kasa_sahibi") or d.get("devreden"), "giris_acilir": not acik}
            # sahip 24 Eki: "devir işlemi içinse sadece devir görünmesi mantıklı" — kasayı veren, devralmaya başlayan ve DIŞARIDAN gelen
            # yalnız devir düğmesini görür (G63, G66; sürmekte olan mola bitirilebilir). İçeride olup devirle ilgisi olmayan (ör. işi
            # biten yarı zamanlı) çıkış/mola düğmelerini de görür — 15 dk'lık devir onu bekletmesin.
            if devir and (devir["rol"] == "devreden" or not acik or _devir_tarafi(cur, str(sube), p["id"])):
                # G71 (sim 24 Eki, Zafer): kimse devralmaya başlamadan gelen İKİNCİ kişi mesaisini başlatabilsin — giriş KÜÇÜK bağlantı olarak kalır
                ikincil = devir["rol"] == "devralan" and not acik and not _devir_tarafi(cur, str(sube), p["id"])
                yap = [x for x in yap if x == "mola_bitir" or (ikincil and x == "giris")]
                devir["giris_ikincil"] = ikincil
        elif not sube and acik and son.get("sube_id"):   # EV (/q, şubesiz) — yalnız ROL + ad (tutar yok; işlem devir QR'ında)
            d = devir_durum(cur, str(son["sube_id"]))
            if d and d["durum"] in DEVIR_YENI_ACIK and p["id"] in (d.get("devreden_id"), d.get("devralan_id")):
                devir = {"rol": "devreden" if p["id"] == d.get("devreden_id") else "devralan", "devreden": d.get("devreden"), "ev": True}
        return {"kisi": p["ad"], "muaf": bool(p.get("konum_muaf")), "konum_gerekli": konum_gerekli(cur, str(sube or ""), p), "gun": is_gunu().isoformat(), "sube": sube, "sube_ad": sube_ad,
                "mola": mola, "devir": devir,
                "qr_gecerli": (qr_dogrula(cur, str(sube), qr or "") is not None) if sube else None,   # Fable #7: süresi dolan QR baştan söylensin
                "yemek_tam": bool(p.get("mudur")),   # müdür: yemek mola şartsız tam (Maaş ile aynı kural; _personel 'mudur' hesaplar)
                "acik": acik, "acik_sube": son.get("sube_id") if acik else None, "acik_sube_ad": son.get("sube_ad") if acik else None,
                "giris": _saat(son.get("giris_ts")) if son and son.get("is_gunu") == is_gunu() else None,
                "giris_ts": son["giris_ts"].isoformat() if son and son.get("is_gunu") == is_gunu() and son.get("giris_ts") else None,   # ev kartı süre halkası
                "mola_limit_dk": mola_limit(cur), "mola_en_az_dk": mola_en_az(cur),
                "cikis": _saat(son.get("cikis_ts")) if son and son.get("is_gunu") == is_gunu() else None,
                "yapabilir": yap, "gun_kapali": gun_kapali}
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
                          "sube": d["acik"].get("sube"), "talep": d["acik"]["talep_ts"]} if d["acik"] else None), "ay": d["ay"],
                "son": ({**d["son"], "tutar": int(d["son"]["tutar"]) / 100} if d.get("son") else None),
                "bu_ay": [{**x, "tutar": x["tutar"] / 100} for x in d.get("bu_ay") or []]}   # F4.2 sahip: alınan avans telefonda kalıcı (ay boyu)
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
        _sb = str(v.get("sube") or "")
        if _sb:   # Q-1 (Codex P1 + Fable): kapanışı YAZAN işlemle aynı gün kilidi, kişi kilidinden ÖNCE (kapanışla aynı sıra → kilitlenme yok)
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_gun:{_sb}:{is_gunu().isoformat()}",))
        personel_kilidi(cur, p["id"])
        r = _istek_kaydi(cur, "ey_yoklama", "istek_id", ist, "personel_id, giris_ts", {"personel_id": p["id"]})   # K2: tekrar bloğu tek
        if r:
            return {"ok": True, "tekrar": True, "mesaj": f"Giriş zaten kaydedildi · {_saat(dict(r)['giris_ts'])}"}
        cur.execute("SELECT y.id, y.sube_id FROM ey_yoklama y WHERE y.personel_id=%s AND y.cikis_ts IS NULL", (p["id"],))
        a = cur.fetchone()
        sube, k = _qr_islem(cur, c, p, v, "giris")
        if a and dict(a)["sube_id"] == sube:
            return {"ok": True, "tekrar": True, "mesaj": "Zaten girişin var"}
        # Q-1 (sim 26 Eki · Opus + Codex + Fable A): gün kapandıktan sonra o şubeye GİRİŞ yok (D7 · hayalet "çalışılan gün" olmasın);
        # çıkış her zaman serbest. Gün kilidi fn başında alındı (eşzamanlı kapanış görülür). Kapanış iptal edilirse kendiliğinden açılır.
        from evvel_yeni_olay import gun_kapandi as _gk
        if _gk(cur, str(sube), is_gunu()):
            raise HTTPException(409, "Bu şubenin günü kapandı — yeni iş günü 02:00'de başlar")
        if a:
            a = dict(a)
            a["ad"] = adlar(cur, "ey_sube", [a["sube_id"]]).get(str(a["sube_id"]))
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
        from evvel_yeni_olay import gun_kapandi as _gun_kapandi
        dr = _devir_tarafi(cur, str(dict(a)["sube_id"]), p["id"])
        if dr and _gun_kapandi(cur, str(dict(a)["sube_id"]), is_gunu()):   # Opus N5: gün kapandıysa kilit yok
            dr = None
        if dr:   # Opus Y1: gün kapandıysa açık devir çıkışı KİLİTLEMEZ (devir artık sürdürülemez)   # G63 (sim 23 Eki): devir sürerken taraf çıkamaz — devir takılı kalmasın
            if dr.get("devreden_ts") and not dr.get("devralan_id"):   # V30: kasa sahibi saydı, kimse almadı — mesaj duruma uysun
                raise HTTPException(409, "Kasayı henüz kimse almadı — içeriden biri QR okutup 'Kasayı devral' desin; kasa teslim edilmeden çıkış olmaz")
            if (p["id"] == dr.get("devreden_id") and dr.get("devreden_ts")) or (p["id"] == dr.get("devralan_id") and dr.get("devralan_ts")):
                raise HTTPException(409, "Sayımın gönderildi — karşı taraf sayınca devir biter, çıkışın kendiliğinden yazılır")
            raise HTTPException(409, "Kasa devri sürüyor — önce sayımını gönder; devir bitince çıkışın kendiliğinden yazılır")
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
        sartsiz = bool(p.get("mudur"))   # F1.7 (Fable + Codex): müdürün yemek hakkı şartsız (Maaş ile aynı kural) — "kazanılamadı" denmez
        if r:
            dustu = not r["yemek_hakki"] and not sartsiz
            return {"ok": True, "tekrar": True, "hak_dustu": dustu,
                    "mesaj": f"Mola zaten bitti · {_saat(r['bitis_ts'])} · {r['sure_dk']} dk" + (" — Bugün yemek hakkı kazanılamadı" if dustu else "")}
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
            dustu = not md.get("yemek_hakki") and not md.get("hak_elle") and not sartsiz
            return {"ok": True, "tekrar": True, "hak_dustu": dustu,
                    "mesaj": f"Mola zaten kapanmıştı · {md.get('sure_dk', '—')} dk" + (" — yemek hakkını kaybettin" if dustu else "")}
        dustu = not m["yemek_hakki"] and not sartsiz
        return {"ok": True, "hak_dustu": dustu,   # K7: tek bilgi satırı (bildirim değil)
                "mesaj": f"Mola bitti · {_saat(datetime.now(timezone.utc))} · {m['sure_dk']} dk" + (" — Bugün yemek hakkı kazanılamadı" if dustu else "")}
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


# ─────────── KASA DEVRİ v2 (DEVIR_KURGU_V2.md · sahip 23 Eki "baştan sona yeniden kurgula") ───────────
# Devreden = KASA SAHİBİ (sistem bilir: günün son devralanı, yoksa açılışı yapan) · iki taraf KENDİ telefonunda KÖR sayar
# (nakit · bardak ZORUNLU · ürün · pasta) · sistem karşılaştırır (0 ₺, adetler birebir) · tutmazsa BİR KEZ birlikte yeniden ·
# yine tutmazsa devir biter, resmi rakam DEVRALANIN, fark merkeze BİLGİ (karar yok — sahip). Devralanın vardiyası devirle başlar.
DEVIR_ACIK = ("baslatildi", "sayiliyor", "yeniden", "dolduruluyor", "hazir", "devreden_onayladi")   # son üçü eski akış (tarihsel)
DEVIR_YENI_ACIK = ("baslatildi", "sayiliyor", "yeniden")
DEVIR_BITTI = ("tamam", "tutmadi", "tutmuyor")   # 'tutmuyor' = eski akış (tarihsel)
DEVIR_PENCERE_DK = 15   # taraf QR'ı BİR KEZ okutur, sayımı 15 dk içinde gönderir (QR sayım sırasında dolmaz)
DEVIR_DUSME_DK = 30     # başlatılıp kimsenin göndermediği devir sessizce düşer


def _devir_surum(devreden_id, sayilan_kurus, bardak, urunler=None, pasta=None) -> str:
    g = json.dumps({"a": devreden_id, "s": int(sayilan_kurus or 0), "b": bardak or [], "u": urunler or [], "p": pasta},
                   sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(g.encode("utf-8")).hexdigest()[:16]


def _devir_kilit(cur, sube_id: str, gun) -> None:
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_devir:{sube_id}:{gun}",))


def _devir_dus(cur) -> None:
    """Eski akış: yarıda kalan 'dolduruluyor' satırı 30 dk sonra düşer. v2 devri düşmez (günde bir devir — sahip)."""
    # v2 (sahip: "devir bir kere olur") YENİ devir kendiliğinden DÜŞMEZ — tamamlanana ya da merkez kapatana kadar açık; yalnız eski akış satırları
    cur.execute("""UPDATE ey_devir SET durum='dustu' WHERE durum='dolduruluyor'
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


def _gun_kapali_mi(cur, sube_id: str, gun) -> None:
    """Opus B6: şubenin o günü kapandıysa devir okutma / sayım yazılmaz (Olay'ın kapısı, F#11)."""
    from evvel_yeni_olay import gun_kapandi
    if gun_kapandi(cur, str(sube_id), gun):
        raise HTTPException(409, "Gün kapandı — devir yapılamaz, merkeze haber ver")


def _devralan_gecerli(cur, did: str) -> bool:
    """G67: devralan üstlenmesi geçerli mi — sayımını gönderdiyse ya da 15 dk penceresi sürüyorsa. Göndermeden süresi dolan
    üstlenme düşer (yanlış kişi kasayı kalıcı kilitlemesin; başkası devralabilir)."""
    cur.execute("SELECT devralan_id, devralan_ts, devralan_ustlen_ts, durum FROM ey_devir WHERE id=%s", (did,))
    r = dict(cur.fetchone() or {})
    if not r.get("devralan_id"):
        return False
    return bool(r.get("devralan_ts")) or r.get("durum") == "yeniden" or _pencere(r.get("devralan_ustlen_ts"))


def _devir_tarafi(cur, sube_id: str, pid: str) -> Optional[dict]:
    """Bugün açık (v2) devrin tarafı mı: devreden / adına sayan / devralan — devreden henüz belli değilse KASA SAHİBİ (G63).
    Tarafsa devir satırını döner (çıkış mesajı duruma göre seçilsin — Opus B20: ikinci sorgu yok), değilse None."""
    cur.execute("""SELECT devreden_id, devralan_id, ustlenen_id, devreden_ts, devralan_ts FROM ey_devir WHERE sube_id=%s AND is_gunu=%s
                     AND durum IN ('baslatildi','sayiliyor','yeniden') LIMIT 1""", (sube_id, is_gunu()))
    r = cur.fetchone()
    if not r:
        return None
    r = dict(r)
    taraf = {r.get("devreden_id"), r.get("devralan_id"), r.get("ustlenen_id")} - {None}
    if not r.get("devreden_id"):
        sahip = kasa_sahibi(cur, sube_id)
        if sahip:
            taraf.add(sahip)
    return r if pid in taraf else None


def kasa_sahibi(cur, sube_id: str, gun=None) -> Optional[str]:
    """PUBLIC: kasa şu an kimde — günün son tamamlanan devrinin devralanı; devir yoksa açılışı yapan (olay defteri, PUBLIC okuyucu).
    Sahip (23 Eki): devreden = kasa sahibi ('ilk okutan devreden' kuralı kalktı — D1)."""
    gun = gun or is_gunu()
    k = kapanis_sorumlusu(cur, sube_id, gun)
    if k:
        return str(k["personel_id"])
    try:
        from evvel_yeni_olay import panel_olaylari
        ac = [o for o in panel_olaylari(cur, sube_id=sube_id, bas=gun, son=gun, turler={"acilis"}) if o.get("personel_id")]
        if ac:
            return str(ac[-1]["personel_id"])
    except Exception:  # noqa: BLE001
        log.warning("devir: açılış okunamadı (kasa sahibi)", exc_info=True)
    return None


def devir_baslat(cur, sube_id: str, gun, istek_id: str) -> dict:
    """PUBLIC (panel, kayıtlı PC): kişisiz devir açar → 'baslatildi'. Açık devir varsa onu döner (tek açık devir)."""
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
    # sahip 23 Eki: "devir bir kere olur, başka olmaz" — o gün başlatılmış HER devir sayılır (panel iptali / kendiliğinden düşme yok);
    # yalnız MERKEZİN iptal ettiği devirden sonra yeniden başlatılabilir (merkez müdahalesi)
    cur.execute("""SELECT 1 FROM ey_devir WHERE sube_id=%s AND is_gunu=%s AND durum NOT IN ('iptal','dustu')   -- Opus B15: eski akış satırı engellemez
                     AND NOT (durum='merkez_kapatti' AND merkez_sonuc='iptal') LIMIT 1""", (sube_id, gun))
    if cur.fetchone():
        raise HTTPException(409, "Bugün kasa devri yapıldı — günde bir devir olur")
    did = "dv-" + uuid.uuid4().hex[:16]
    cur.execute("""INSERT INTO ey_devir (id, sube_id, is_gunu, durum, istek_id, tur) VALUES (%s,%s,%s,'baslatildi',%s,1)""",
                (did, sube_id, gun, istek_id))
    return {"devir_id": did}


def devir_iptal(cur, sube_id: str, gun) -> bool:
    """PUBLIC (panel): yalnız ESKİ akış satırını iptal eder. v2 devri panelden iptal edilmez (sahip: günde bir devir — merkez kapatır)."""
    yoklama_hazirla()
    _devir_kilit(cur, sube_id, gun)
    cur.execute("""UPDATE ey_devir SET durum='iptal' WHERE sube_id=%s AND is_gunu=%s
                     AND durum IN ('dolduruluyor','hazir') RETURNING id""", (sube_id, gun))   # v2: panelden iptal YOK (günde bir devir — merkez kapatır)
    return bool(cur.fetchone())


def _pencere(ts) -> bool:
    return bool(ts) and (datetime.now(timezone.utc) - ts).total_seconds() < DEVIR_PENCERE_DK * 60


def _devir_dict(cur, r: dict) -> dict:
    """MERKEZ görünümü (bütün sayılar). Panel/telefon _devir_gizli kullanır (kör sayım)."""
    ids = [x for x in (r.get("devreden_id"), r.get("devralan_id"), r.get("ustlenen_id")) if x]
    ad = adlar(cur, "ey_personel", ids)
    sk = r.get("sayilan_kurus")
    ds = r.get("devralan_sayilan_kurus")
    return {"id": r["id"], "durum": r["durum"], "gun": r["is_gunu"].isoformat(), "surum": r.get("surum"), "tur": r.get("tur") or 1,
            "devreden_id": r.get("devreden_id"), "devreden": ad.get(r.get("devreden_id")),
            "devralan_id": r.get("devralan_id"), "devralan": ad.get(r.get("devralan_id")),
            "ustlenen_id": r.get("ustlenen_id"), "ustlenen": ad.get(r.get("ustlenen_id")), "vekil": bool(r.get("vekil")),
            "sayilan": None if sk is None else int(sk) / 100, "bardak": r.get("bardak") or [], "urunler": r.get("urunler") or [],
            "pasta": r.get("pasta_adet"),
            "devralan_sayilan": None if ds is None else int(ds) / 100, "devralan_bardak": r.get("devralan_bardak") or [],
            "devralan_urunler": r.get("devralan_urunler") or [], "devralan_pasta": r.get("devralan_pasta"),
            "fark": None if (sk is None or ds is None) else (int(ds) - int(sk)) / 100, "fark_kalem": r.get("fark_kalem") or [],
            "tur1": r.get("tur1"), "panel": _saat(r["panel_ts"]), "ustlen_saat": _saat(r.get("ustlen_ts")),
            "pencere": _pencere(r.get("ustlen_ts")) and r["durum"] in ("dolduruluyor", "sayiliyor", "yeniden"),
            "devreden_saat": _saat(r.get("devreden_ts")), "devralan_saat": _saat(r.get("devralan_ts")),
            "not": r.get("devralan_not") or (f"merkez: {r.get('merkez_aciklama')}" if r.get("merkez_aciklama") else None),   # B57
            "merkez_sonuc": r.get("merkez_sonuc"), "gorulen": r.get("gorulen")}


_GIZLI = ("id", "durum", "gun", "tur", "devreden_id", "devreden", "devralan_id", "devralan", "ustlenen_id", "ustlenen", "vekil",
          "panel", "devreden_saat", "devralan_saat", "fark_kalem", "merkez_sonuc")


def _devir_gizli(d: Optional[dict]) -> Optional[dict]:
    """PANEL / TELEFON görünümü — KÖR: hiçbir tutar/adet yok (sahip: personel kasa derinliğini bilmez; devralan devredenin rakamını görmez).
    Tutmayan KALEMLERİN ADI görünür (rakam değil) — birlikte yeniden sayılsın diye."""
    if not d:
        return None
    return {**{k: d.get(k) for k in _GIZLI}, "devreden_saydi": d.get("devreden_saat") is not None,
            "devralan_saydi": d.get("devralan_saat") is not None}


def devir_durum(cur, sube_id: str, gun: Optional[date] = None) -> Optional[dict]:
    """PUBLIC (panel durum + telefon): şube+günün açık devri; yoksa günün son devri — KÖR görünüm + kasa sahibinin adı."""
    yoklama_hazirla()
    _devir_dus(cur)
    gun = gun or is_gunu()
    cur.execute("""SELECT * FROM ey_devir WHERE sube_id=%s AND is_gunu=%s AND durum NOT IN ('iptal','dustu')
                     AND NOT (durum='merkez_kapatti' AND merkez_sonuc='iptal')   -- Opus B1: merkez iptali → panel yeniden başlatabilsin
                    ORDER BY (durum = ANY(%s)) DESC, panel_ts DESC LIMIT 1""", (sube_id, gun, list(DEVIR_ACIK)))
    r = cur.fetchone()
    if not r:
        return None
    g = _devir_gizli(_devir_dict(cur, dict(r)))
    if g["durum"] in DEVIR_YENI_ACIK:
        sid = kasa_sahibi(cur, sube_id, gun)
        g["kasa_sahibi"] = adlar(cur, "ey_personel", [sid]).get(sid) if sid else None
    return g


def kapanis_sorumlusu(cur, sube_id: str, gun: Optional[date] = None) -> Optional[dict]:
    """PUBLIC: son tamamlanan (tamam / tutmadı / eski tutmuyor / merkez kapandı) devrin devralanı (F7: kapanışçı = gönderen esas; bu yanında)."""
    yoklama_hazirla()
    cur.execute("""SELECT d.devralan_id FROM ey_devir d
                    WHERE d.devralan_id IS NOT NULL AND d.sube_id=%s AND d.is_gunu=%s
                      AND (d.durum IN ('tamam','tutmadi','tutmuyor') OR (d.durum='merkez_kapatti' AND d.merkez_sonuc='kapandi'))
                    ORDER BY COALESCE(d.devralan_ts, d.panel_ts) DESC LIMIT 1""", (sube_id, gun or is_gunu()))
    r = cur.fetchone()
    if not r:
        return None
    pid = dict(r)["devralan_id"]
    return {"personel_id": pid, "ad": adlar(cur, "ey_personel", [pid]).get(str(pid))}


def _devir_olay(cur, d: dict, veri_ek: dict) -> Optional[str]:
    """'vardiya' olayı — Satış › Devir defteri / kasa sağlaması bunu okur (var olan okuyucu; kaynak değişmez).
    v2: 'sayilan' = RESMİ rakam (tuttuysa ortak, tutmadıysa devralanın sayımı); iki taraf ayrıca veri_ek'te."""
    from evvel_yeni_olay import olay_yaz
    from evvel_yeni_cekirdek import deneme_mi
    if deneme_mi(cur, date.fromisoformat(str(d["is_gunu"])[:10])):   # tek kural (F#1) — deneme dönemi: telefon onayları denenir, vardiya olayı yazılmaz
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
    """Panel (kayıtlı PC imzası): 💵 Kasa Devri → 'Devri başlat'. Kişi / form panelde YOK — iki taraf QR'ı okutup telefonda sayar."""
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
            if not kasa_sahibi(cur, c["sube_id"], is_gunu()):
                raise HTTPException(409, "Önce açılış yapılmalı — kasa kimde belli değil")
            if not devir_listesi(cur)["bardak"]:   # Opus B7: bardak sayımı ZORUNLU (sahip) — liste yoksa devir başlamaz
                raise HTTPException(409, "Bardak listesi okunamadı — devir başlatılamaz, merkeze haber ver")
            _canli_konum_sart(cur, c["sube_id"])   # D10 (sim 23 Eki): konum yoksa devir BAŞLAMASIN (günde bir devir — telefonda takılı kalmasın)
            r = devir_baslat(cur, c["sube_id"], is_gunu(), _istek(v))
            return {"ok": True, **r, "devir": devir_durum(cur, c["sube_id"]),
                    "mesaj": "Devir başladı — kasayı veren ve alan QR'ı kendi telefonuyla okutsun"}
    return await run_in_threadpool(_is)


def _devir_rol(d: dict, p: dict, sahip: Optional[str], sahip_icerde: bool, icerde: bool = True) -> str:
    """Telefonda bu kişinin bu devirdeki yeri (v2). devreden = kasa sahibi (ya da adına sayan vekil); başkası = devralan adayı."""
    if d["durum"] in ("dolduruluyor", "hazir", "devreden_onayladi"):
        return "eski"
    if d["durum"] not in DEVIR_YENI_ACIK:
        return "bitti"
    pid = p["id"]
    if pid in (d.get("ustlenen_id"), d.get("devreden_id")) and d.get("devreden_id"):
        if d.get("devreden_saat"):
            return "gonderdin"
        return "form_devreden" if (d.get("ustlenen_id") == pid and d.get("pencere")) else "basla_devreden"
    if pid == d.get("devralan_id"):
        if d.get("devralan_saat"):
            return "gonderdin"
        return "form_devralan" if d.get("devralan_pencere") else "basla_devralan"
    if not d.get("devreden_id") and (pid == sahip or ((not sahip or not sahip_icerde) and icerde)):   # Opus B9: dışarıdan gelen devralan adayı
        return "basla_devreden"
    if d.get("devralan_id") and (d.get("devralan_saat") or d.get("devralan_pencere") or d["durum"] == "yeniden"):
        return "bekle"
    return "basla_devralan"


def _devir_ham(cur, did: str) -> dict:
    cur.execute("SELECT * FROM ey_devir WHERE id=%s", (did,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Devir bulunamadı")
    return dict(r)


@router.get("/devir/{did}/telefon")
async def devir_telefon(did: str, request: Request, sube: Optional[str] = None, qr: Optional[str] = None):
    """Telefon (imzalı): devir QR'ı okutuldu → bu kişinin rolü + KÖR durum + form kalemleri (karşı tarafın rakamı YOK)."""
    def fn(cur, c, p, _v):
        _devir_dus(cur)
        r = _devir_ham(cur, did)
        s = r["sube_id"]
        # Codex P1 (21 Eki): yalnız devrin TARAFINA ya da o şubenin GEÇERLİ QR'ını okutana (eski / kopyalanmış bağlantı yetmez)
        if sube and str(sube) != str(s):
            raise HTTPException(404, "Devir bulunamadı")
        taraf = p["id"] in {r.get("devreden_id"), r.get("ustlenen_id"), r.get("devralan_id")} - {None}
        if not taraf and qr_dogrula(cur, str(s), qr or "") is None:
            raise HTTPException(409, "QR süresi doldu — paneldeki devir QR'ını yeniden okut")
        tam = _devir_dict(cur, r)
        tam["devralan_pencere"] = _pencere(r.get("devralan_ustlen_ts"))
        sahip = kasa_sahibi(cur, s, r["is_gunu"])
        sahip_icerde = bool(sahip) and acik_mi(cur, s, sahip)
        icerde = acik_mi(cur, s, p["id"])
        cur.execute("SELECT sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (p["id"],))
        ac = cur.fetchone()
        ad = adlar(cur, "ey_personel", [sahip] if sahip else [])
        rol = _devir_rol(tam, p, sahip, sahip_icerde, icerde)
        return {"kisi": p["ad"], "muaf": bool(p.get("konum_muaf")), "konum_gerekli": konum_gerekli(cur, str(s or ""), p), "sube": s, "sube_ad": adlar(cur, "ey_sube", [s]).get(str(s)),
                "gun": is_gunu().isoformat(), "devir": _devir_gizli(tam), "rol": rol, "icerde": icerde,
                "sahip": {"id": sahip, "ad": ad.get(sahip) if sahip else None, "icerde": sahip_icerde},
                # vekil: kasa sahibi içeride ama telefonu yok → içerideki başka biri ONUN ADINA devreden sayabilir (merkeze bildirilir)
                "vekil_olabilir": rol == "basla_devralan" and icerde and sahip_icerde and not tam.get("devreden_id") and sahip != p["id"],
                "baska_subede": bool(ac) and dict(ac)["sube_id"] != s, "liste": devir_listesi(cur), "pencere_dk": DEVIR_PENCERE_DK}
    return await _telefon(request, fn)


@router.post("/devir/{did}/basla")
async def devir_basla(did: str, request: Request):
    """Taraf QR'ı okuttu → sayım formu ONUN (15 dk, QR bu sürede yeniden istenmez). taraf: 'devreden' | 'devralan'.
    devreden yalnız KASA SAHİBİ (ya da 'adina'=sahip seçen içerideki vekil / sahip içeride değilse içerideki herkes)."""
    def fn(cur, c, p, v):
        taraf = str(v.get("taraf") or "")
        if taraf not in ("devreden", "devralan"):
            raise HTTPException(400, "Taraf seç")
        adina = str(v.get("adina") or "").strip() or None
        d = _devir_al(cur, did, ek_kisi=p["id"], ek_kisi2=adina)
        if d["durum"] not in DEVIR_YENI_ACIK:
            raise HTTPException(409, "Bu devir artık açık değil — panelden yeniden başlat" if d["durum"] not in DEVIR_BITTI else "Bu devir tamamlandı")
        if d["is_gunu"] != is_gunu():
            raise HTTPException(409, "Bu devir önceki güne ait — panelden yeniden başlat")
        # aynı kişi formu zaten açtıysa (sayfa yenilendi) QR yeniden harcanmaz
        if taraf == "devreden" and d.get("ustlenen_id") == p["id"] and _pencere(d.get("ustlen_ts")):
            return {"ok": True, "tekrar": True}
        if taraf == "devralan" and d.get("devralan_id") == p["id"] and _pencere(d.get("devralan_ustlen_ts")):
            return {"ok": True, "tekrar": True}
        _canli_konum_sart(cur, d["sube_id"])
        sube, k = _qr_islem(cur, c, p, v, f"devir_{taraf}_{d.get('tur') or 1}")
        if sube != d["sube_id"]:
            raise HTTPException(409, "Devir başka şubede — o şubenin QR'ını okut")
        _gun_kapali_mi(cur, sube, d["is_gunu"])   # Opus B6: kapanıştan sonra devir sürmez
        sahip = kasa_sahibi(cur, sube, d["is_gunu"])
        sahip_icerde = bool(sahip) and acik_mi(cur, sube, sahip)
        ad = lambda x: adlar(cur, "ey_personel", [x]).get(str(x)) or "kasa sahibi"   # noqa: E731
        yeniden = d["durum"] == "yeniden"
        if taraf == "devreden":
            kim = adina or p["id"]
            if not acik_mi(cur, sube, p["id"]):
                raise HTTPException(409, "Kasayı devretmek için bu şubede içeride olmalısın")
            if adina and not (adina == sahip and sahip_icerde and adina != p["id"]):   # Opus B3: yalnız içerideki KASA SAHİBİ adına
                raise HTTPException(409, "Yalnız içerideki kasa sahibi adına sayılabilir")
            if p["id"] in (d.get("devralan_id"),) or kim == d.get("devralan_id"):   # Opus B4: devralan devreden de olamaz
                raise HTTPException(409, "Devralan, devreden olamaz")
            if yeniden and d.get("ustlenen_id") and d["ustlenen_id"] != p["id"]:   # Opus B2: 2. sayımı 1. sayımı yapan yapar
                raise HTTPException(409, f"İkinci sayımı {ad(d['ustlenen_id'])} yapar")
            if (not yeniden and d.get("ustlenen_id") and d["ustlenen_id"] != p["id"] and not d.get("devreden_ts")
                    and _pencere(d.get("ustlen_ts"))):   # Opus B12: başkasının açık formu elinden alınmaz
                raise HTTPException(409, f"{ad(d['ustlenen_id'])} sayıyor — bekle")
            if sahip and sahip_icerde and kim != sahip and not yeniden:   # Opus Y16: 2. turda 1. sayımı yapan sürdürür
                raise HTTPException(409, f"Kasa {ad(sahip)}'de — devreden o (telefonu yoksa '{ad(sahip)} adına' seç)")
            if d.get("devreden_id") and d["devreden_id"] != kim:
                raise HTTPException(409, f"Devreden zaten {ad(d['devreden_id'])}")
            if d.get("devralan_id") == kim:
                raise HTTPException(409, "Devralan, devreden olamaz")
            vekil = kim != p["id"] or not sahip_icerde
            cur.execute("""UPDATE ey_devir SET durum=CASE WHEN durum='yeniden' THEN 'yeniden' ELSE 'sayiliyor' END, devreden_id=%s, ustlenen_id=%s, ustlen_ts=NOW(), vekil=%s, ustlen_mesafe_m=%s
                            WHERE id=%s""", (kim, p["id"], vekil, k["mesafe_m"], did))
        else:
            if p["id"] in (d.get("devreden_id"), d.get("ustlenen_id"), sahip if sahip_icerde else None):   # Opus B4: vekil devralan olamaz
                raise HTTPException(403, "Kasa sende — sen devredensin (kasayı alacak kişi okutsun)")
            if yeniden and d.get("devralan_id") and d["devralan_id"] != p["id"]:   # Opus B2: 2. turda devralan değişmez
                raise HTTPException(409, f"İkinci sayımı {ad(d['devralan_id'])} yapar")
            if d.get("devralan_id") and d["devralan_id"] != p["id"] and _devralan_gecerli(cur, did):
                raise HTTPException(409, f"{ad(d['devralan_id'])} devralıyor — bekle")
            cur.execute("SELECT sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (p["id"],))
            a = cur.fetchone()
            if a and dict(a)["sube_id"] != sube:
                raise HTTPException(409, "Önce diğer şubeden çıkış yap")
            cur.execute("""UPDATE ey_devir SET durum=CASE WHEN durum='yeniden' THEN 'yeniden' ELSE 'sayiliyor' END, devralan_id=%s, devralan_ustlen_ts=NOW(), devralan_mesafe_m=%s, devralan_muaf=%s,
                                  devralan_cihaz_id=%s WHERE id=%s""", (p["id"], k["mesafe_m"], k["muaf"], c.get("cihaz_id"), did))
        return {"ok": True}
    return await _telefon(request, fn)


@router.post("/devir/{did}/vazgec")
async def devir_vazgec(did: str, request: Request):
    """G67 (sim 23 Eki): sayımını GÖNDERMEDEN önce 'Vazgeç — kasayı ben almıyorum' (devralan) ya da 'Vazgeç' (adına sayan vekil).
    Üstlenme bırakılır, başkası okutabilir. 2. turda (yeniden) vazgeçilmez — iki taraf belli."""
    def fn(cur, c, p, v):
        d = _devir_al(cur, did, ek_kisi=p["id"])
        if d["durum"] not in ("baslatildi", "sayiliyor"):
            raise HTTPException(409, "Bu aşamada vazgeçilemez" if d["durum"] == "yeniden" else "Bu devir artık açık değil")
        if d.get("devralan_id") == p["id"] and not d.get("devralan_ts"):
            cur.execute("""UPDATE ey_devir SET devralan_id=NULL, devralan_ustlen_ts=NULL, devralan_mesafe_m=NULL, devralan_muaf=NULL,
                                  devralan_cihaz_id=NULL WHERE id=%s""", (did,))
        elif d.get("ustlenen_id") == p["id"] and d.get("vekil") and not d.get("devreden_ts"):
            cur.execute("UPDATE ey_devir SET devreden_id=NULL, ustlenen_id=NULL, ustlen_ts=NULL, vekil=FALSE WHERE id=%s", (did,))
        else:
            raise HTTPException(409, "Vazgeçilecek bir sayım yok (gönderilmiş sayım geri alınmaz)")
        cur.execute("""UPDATE ey_devir SET durum='baslatildi' WHERE id=%s AND devreden_id IS NULL AND devralan_id IS NULL""", (did,))
        return {"ok": True, "mesaj": "Vazgeçtin — kasayı alacak kişi kendi telefonuyla okutsun"}
    return await _telefon(request, fn)


def _devir_sayilar(cur, v: dict) -> tuple:
    """Telefondan gelen form (eski 5 adım AYNEN): her kalem dolu (0 yazılabilir), tam sayı, eksi yok, katalog dışı yok."""
    from decimal import Decimal
    if v.get("dogruladim") is not True:
        raise HTTPException(400, "Saydığını doğruladığını işaretle")
    from evvel_yeni_cekirdek import tutar_oku
    kasa = tutar_oku(v.get("kasa"), "Kasadaki nakit")   # Türkçe yazı tek ayrıştırıcıdan (Dalga 4)
    if kasa < 0 or kasa > 1000000 or kasa != kasa.quantize(Decimal("0.01")):
        raise HTTPException(400, "Kasadaki nakit için geçerli değer gir")
    liste = devir_listesi(cur)
    if not liste["bardak"]:   # Opus B7
        raise HTTPException(409, "Bardak listesi okunamadı — sayım gönderilemez, merkeze haber ver")

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
        return [{"urun_id": u["id"], "ad": u["ad"], "sayilan": adet_oku(gelen.get(u["id"]), u["ad"])} for u in gerek]   # TEK adet kuralı (F#17)
    bardak = kalemler("bardak", liste["bardak"])
    urunler = kalemler("urunler", liste["urun"])
    pn = adet_oku(v.get("pasta"), "Pasta", en_cok=10000)
    return int(kasa * 100), bardak, urunler, pn


def _tur2_doldur(v: dict, t1: dict, fark: list) -> dict:
    """Opus B13: 2. turda yalnız tutmayan kalem sorulur — gerisi bu tarafın 1. tur sayımından (sunucuda)."""
    from decimal import Decimal
    fk = {str(x) for x in (fark if isinstance(fark, list) else json.loads(fark or "[]"))}
    v = dict(v)
    if "Kasa (nakit)" not in fk and t1.get("kasa") is not None:
        v["kasa"] = str(Decimal(int(t1["kasa"])) / 100).replace(".", ",")
    if "Pasta" not in fk and t1.get("pasta") is not None:
        v["pasta"] = t1["pasta"]
    for anahtar in ("bardak", "urunler"):
        eski = {str(u["urun_id"]): u for u in t1.get(anahtar) or []}
        gelen = {str((x or {}).get("urun_id")): x for x in v.get(anahtar) or []}
        for uid, u in eski.items():
            if (u.get("ad") or uid) not in fk:
                gelen[uid] = {"urun_id": uid, "sayilan": u.get("sayilan")}
        v[anahtar] = list(gelen.values())
    return v


def _devir_farki(d: dict) -> list:
    """İki sayımda TUTMAYAN kalemlerin ADLARI (tolerans 0 ₺ / adet birebir — sahip 23 Eki). Rakam dönmez."""
    fark = []
    if int(d.get("sayilan_kurus") or 0) != int(d.get("devralan_sayilan_kurus") or 0):
        fark.append("Kasa (nakit)")
    for a, b in (("bardak", "devralan_bardak"), ("urunler", "devralan_urunler")):
        x = {str(u["urun_id"]): (u.get("sayilan"), u.get("ad")) for u in (d.get(a) or [])}
        y = {str(u["urun_id"]): u.get("sayilan") for u in (d.get(b) or [])}
        yad = {str(u["urun_id"]): u.get("ad") for u in (d.get(b) or [])}
        for uid, (n, adi) in x.items():
            if y.get(uid) != n:
                fark.append(adi or uid)
        fark += [yad.get(uid) or str(uid) for uid in y if uid not in x]   # Opus B14: ham kimlik değil ad
    if (d.get("pasta_adet") or 0) != (d.get("devralan_pasta") or 0):
        fark.append("Pasta")
    return fark


def _iso(t) -> Optional[str]:
    return t.isoformat() if hasattr(t, "isoformat") else (t if isinstance(t, str) else None)


def _sayim_ts(d: dict) -> Optional[str]:
    """Opus Y2/N1: devrin gerçek SAYIM anı (Faz 2 vardiya sınırı) — merkez saatler sonra kapatsa da; 2. tur yapılmadıysa 1. turun anı."""
    t = d.get("devralan_ts") or d.get("devreden_ts")
    if t:
        return _iso(t)
    t1 = d.get("tur1")
    t1 = json.loads(t1) if isinstance(t1, str) else (t1 or {})
    return t1.get("devralan_ts") or t1.get("devreden_ts")


def _devralan_giris(cur, d: dict) -> None:
    """Sahip: devralanın vardiyası devirle başlar (ayrı giriş yok) — girişi yoksa devrin QR/konum kaydıyla açılır.
    Devrin sonuçlandığı HER yol (tuttu · tutmadı · merkez 'kapandı') bunu çağırır (D12, sim 23 Eki)."""
    sube = d["sube_id"]
    if acik_mi(cur, sube, d["devralan_id"]):
        return
    from evvel_yeni_olay import gun_kapandi as _gk
    if _gk(cur, str(sube), is_gunu()):   # Q-1 (Fable): merkez eski devri gün kapandıktan sonra bitirirse kapalı güne giriş açılmasın
        return
    cur.execute("SELECT sube_id FROM ey_yoklama WHERE personel_id=%s AND cikis_ts IS NULL", (d["devralan_id"],))
    if cur.fetchone():
        raise HTTPException(409, "Devralanın başka şubede açık girişi var — önce oradan çıkış yapsın")
    cur.execute("""INSERT INTO ey_yoklama (id, sube_id, personel_id, is_gunu, giris_ts, giris_mesafe_m, giris_muaf, giris_cihaz_id, istek_id)
                   VALUES (%s,%s,%s,%s,NOW(),%s,%s,%s,%s)""",
                ("yk-" + uuid.uuid4().hex[:16], sube, d["devralan_id"], d["is_gunu"], d.get("devralan_mesafe_m"),
                 bool(d.get("devralan_muaf")), d.get("devralan_cihaz_id"), "dv-" + d["id"]))


def _devir_bitir(cur, d: dict, tuttu: bool, fark: list) -> None:
    """Devir sonuçlanır: vardiya olayı (resmi rakam = devralanın sayımı) + devredenin çıkışı + devralanın girişi (yoksa — vardiya devirle başlar)."""
    resmi = {**d, "sayilan_kurus": d.get("devralan_sayilan_kurus"), "bardak": d.get("devralan_bardak"),
             "urunler": d.get("devralan_urunler"), "pasta_adet": d.get("devralan_pasta"),
             "surum": _devir_surum(d.get("devreden_id"), d.get("devralan_sayilan_kurus"), d.get("devralan_bardak"),
                                   d.get("devralan_urunler"), d.get("devralan_pasta"))}
    oid = _devir_olay(cur, resmi, {
        "tutuyor": tuttu, "tuttu": tuttu, "tur": d.get("tur") or 1, "fark_kalem": fark,
        "devreden_sayilan": int(d.get("sayilan_kurus") or 0), "devralan_sayilan": int(d.get("devralan_sayilan_kurus") or 0),
        "fark": int(d.get("devralan_sayilan_kurus") or 0) - int(d.get("sayilan_kurus") or 0),
        "devreden_bardak": d.get("bardak") or [], "devreden_urunler": d.get("urunler") or [], "devreden_pasta": d.get("pasta_adet"),
        "tur1": d.get("tur1"), "sayim_ts": _sayim_ts(d)})
    sube = d["sube_id"]
    pad = adlar(cur, "ey_personel", [d["devralan_id"]]).get(str(d["devralan_id"])) or "devralan"
    cur.execute("SELECT id FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND cikis_ts IS NULL AND is_gunu=%s",
                (d["devreden_id"], sube, is_gunu()))
    yk = dict(cur.fetchone() or {}).get("id")
    if yk:   # Codex: yalnız BUGÜNKÜ açık giriş kapanır (dünkü devir bugünün yeni girişini kapatmasın)
        cikis_yaz(cur, d["devreden_id"], "devir", kim=f"devir · {pad}", sube_id=sube, yoklama_id=yk)
    _devralan_giris(cur, d)
    cur.execute("""UPDATE ey_devir SET durum=%s, fark_kalem=%s::jsonb, olay_id=%s, devreden_yoklama_id=%s, surum=%s WHERE id=%s""",
                ("tamam" if tuttu else "tutmadi", json.dumps(fark, ensure_ascii=False), oid, yk, resmi["surum"], d["id"]))


@router.post("/devir/{did}/say")
async def devir_say(did: str, request: Request):
    """Taraf sayımını gönderir (5 adım + ☑). İki sayım gelince karşılaştırılır: tuttu → tamam · 1. tur tutmadı → 'yeniden'
    (iki telefonda tutmayan KALEM ADLARI, rakam yok) · 2. tur da tutmadı → devir biter (resmi = devralan), merkeze bilgi (Gördüm)."""
    def fn(cur, c, p, v):
        ist = _istek(v)
        cur.execute("""SELECT istekler->>%s AS m FROM ey_devir WHERE id=%s AND jsonb_exists(istekler, %s)
                         AND %s IN (COALESCE(devreden_id,''), COALESCE(ustlenen_id,''), COALESCE(devralan_id,''))""",
                    ("s:" + ist, did, "s:" + ist, p["id"]))   # Opus B19: yalnız taraf
        r0 = cur.fetchone()
        if r0:   # aynı istek (ağ tekrarı)
            return {"ok": True, "tekrar": True, "mesaj": dict(r0)["m"]}
        taraf = str(v.get("taraf") or "")
        d = _devir_al(cur, did, ek_kisi=p["id"])
        if (d.get("istekler") or {}).get("s:" + ist):   # Fable: aynı istek kilit beklerken tamamlandı
            return {"ok": True, "tekrar": True, "mesaj": d["istekler"]["s:" + ist]}
        if d["durum"] not in ("sayiliyor", "yeniden"):
            raise HTTPException(409, "Bu devir tamamlandı" if d["durum"] in DEVIR_BITTI else "Bu devir artık sayım beklemiyor — panelden yeniden başlat")
        if d["is_gunu"] != is_gunu():
            raise HTTPException(409, "Bu devir önceki güne ait — panelden yeniden başlat")
        if taraf == "devreden":
            if d.get("ustlenen_id") != p["id"]:
                raise HTTPException(409, "Bu sayım senin formunda değil — QR'ı tekrar okut")
            if d.get("devreden_ts"):
                raise HTTPException(409, "Sayımını zaten gönderdin")
            if not _pencere(d.get("ustlen_ts")):
                raise HTTPException(409, f"{DEVIR_PENCERE_DK} dakika doldu — QR'ı tekrar okut (yazdıkların duruyor)")
        elif taraf == "devralan":
            if d.get("devralan_id") != p["id"]:
                if d.get("devralan_id"):   # Opus B18
                    raise HTTPException(409, f"Kasayı artık {adlar(cur, 'ey_personel', [d['devralan_id']]).get(str(d['devralan_id'])) or 'başka biri'} devralıyor")
                raise HTTPException(409, "Bu sayım senin formunda değil — QR'ı tekrar okut")
            if d.get("devralan_ts"):
                raise HTTPException(409, "Sayımını zaten gönderdin")
            if not _pencere(d.get("devralan_ustlen_ts")):
                raise HTTPException(409, f"{DEVIR_PENCERE_DK} dakika doldu — QR'ı tekrar okut (yazdıkların duruyor)")
        else:
            raise HTTPException(400, "Taraf seç")
        sube = str(v.get("sube") or "")
        if sube != d["sube_id"]:
            raise HTTPException(409, "Devir başka şubede")
        _gun_kapali_mi(cur, sube, d["is_gunu"])   # Opus B6
        _canli_konum_sart(cur, sube)
        k = konum_kontrol(cur, sube, p, v.get("lat"), v.get("lng"))
        if d["durum"] == "yeniden" and d.get("tur1"):   # Opus B13: 2. turda TUTAN kalemleri sunucu 1. turdan doldurur (telefonun yerel kaydına bağlı değil)
            v = _tur2_doldur(v, (json.loads(d["tur1"]) if isinstance(d["tur1"], str) else d["tur1"]).get(taraf) or {}, d.get("fark_kalem") or [])
        kasa, bardak, urunler, pasta = _devir_sayilar(cur, v)
        if taraf == "devreden":
            cur.execute("""UPDATE ey_devir SET sayilan_kurus=%s, bardak=%s::jsonb, urunler=%s::jsonb, pasta_adet=%s, devreden_ts=NOW(),
                                  devreden_mesafe_m=%s WHERE id=%s""",
                        (kasa, json.dumps(bardak, ensure_ascii=False), json.dumps(urunler, ensure_ascii=False), pasta, k["mesafe_m"], did))
        else:
            cur.execute("""UPDATE ey_devir SET devralan_sayilan_kurus=%s, devralan_bardak=%s::jsonb, devralan_urunler=%s::jsonb, devralan_pasta=%s,
                                  devralan_ts=NOW(), devralan_mesafe_m=%s WHERE id=%s""",
                        (kasa, json.dumps(bardak, ensure_ascii=False), json.dumps(urunler, ensure_ascii=False), pasta, k["mesafe_m"], did))
        d = _devir_ham(cur, did)
        karsi = adlar(cur, "ey_personel", [x for x in (d.get("devreden_id"), d.get("devralan_id")) if x])
        if not (d.get("devreden_ts") and d.get("devralan_ts")):
            diger = d.get("devralan_id") if taraf == "devreden" else d.get("devreden_id")
            mesaj = f"Sayımın kaydedildi ✓ — {karsi.get(str(diger)) if diger else 'kasayı alacak kişi'} sayınca sonuç burada"
        else:
            fark = _devir_farki(d)
            if not fark:
                _devir_bitir(cur, d, True, [])
                mesaj = f"✓ Tuttu — devir tamam. Kasa artık: {karsi.get(str(d['devralan_id']))}"
            elif (d.get("tur") or 1) == 1:
                tur1 = {"devreden": {"kasa": d.get("sayilan_kurus"), "bardak": d.get("bardak"), "urunler": d.get("urunler"), "pasta": d.get("pasta_adet")},
                        "devralan": {"kasa": d.get("devralan_sayilan_kurus"), "bardak": d.get("devralan_bardak"), "urunler": d.get("devralan_urunler"),
                                     "pasta": d.get("devralan_pasta")}, "fark_kalem": fark,
                        "devreden_ts": _iso(d.get("devreden_ts")), "devralan_ts": _iso(d.get("devralan_ts"))}   # Opus N1: Faz 2 sayım anı
                cur.execute("""UPDATE ey_devir SET durum='yeniden', tur=2, tur1=%s::jsonb, fark_kalem=%s::jsonb, devreden_ts=NULL, devralan_ts=NULL,
                                      ustlen_ts=NOW(), devralan_ustlen_ts=NOW() WHERE id=%s""",
                            (json.dumps(tur1, ensure_ascii=False, default=str), json.dumps(fark, ensure_ascii=False), did))
                mesaj = "Tutmadı — birlikte bir kez daha sayın: " + ", ".join(fark)
            else:
                _devir_bitir(cur, d, False, fark)
                mesaj = f"İkinci sayım da tutmadı — devir tamamlandı, merkeze bildirildi. Kasa artık: {karsi.get(str(d['devralan_id']))}"
        cur.execute("UPDATE ey_devir SET istekler = istekler || jsonb_build_object(%s::text, %s::text) WHERE id=%s", ("s:" + ist, mesaj, did))
        return {"ok": True, "mesaj": mesaj}
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
            # D11 (sim 23 Eki): v2 devri panelden iptal edilmez (günde bir devir) → merkez AÇIK devri HEMEN görür/kapatır (2 saat beklemez);
            # Bekleyen işler uyarısı ayrı (2 saat — gereksiz alarm olmasın)
            cur.execute(q + """(d.durum IN ('baslatildi','sayiliyor','yeniden')
                                OR (d.durum IN ('hazir','devreden_onayladi') AND (d.is_gunu < %s OR COALESCE(d.devreden_ts, d.panel_ts) < NOW() - INTERVAL '2 hours')))
                               OR ((d.durum IN ('tutmadi','tutmuyor') OR (d.durum='tamam' AND d.vekil)) AND d.gorulen IS NULL) ORDER BY d.is_gunu, d.panel_ts""", (is_gunu(),))
        elif bas and son:
            cur.execute(q + "d.is_gunu BETWEEN %s AND %s AND d.durum NOT IN ('iptal','dustu','baslatildi','dolduruluyor','sayiliyor','yeniden') ORDER BY d.is_gunu, d.panel_ts", (bas, son))
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
        if d["durum"] not in DEVIR_ACIK:
            raise HTTPException(409, "Bu devir zaten kapanmış")
        yeni_akis = d["durum"] in DEVIR_YENI_ACIK
        if b.sonuc == "kapandi" and (d["durum"] in ("baslatildi", "dolduruluyor")
                                     or (not yeni_akis and d.get("sayilan_kurus") is None)
                                     or (yeni_akis and (not d.get("devralan_id") or not (d.get("devreden_ts") or d.get("devralan_ts") or d.get("tur1"))))):
            raise HTTPException(400, "Kasayı alan belli değil ya da hiç sayım yok — yalnız iptal edilebilir")
        oid = None
        if b.sonuc == "kapandi":
            # Opus B5: resmi rakam — devralan saydıysa ONUN sayımı (kural 4), yoksa devredeninki; olay 'merkez_istisna' işaretli
            r = d
            t1 = (json.loads(d["tur1"]) if isinstance(d.get("tur1"), str) else (d.get("tur1") or {})).get("devralan") or {}
            if yeni_akis and d.get("devralan_ts"):
                r = {**d, "sayilan_kurus": d.get("devralan_sayilan_kurus"), "bardak": d.get("devralan_bardak"),
                     "urunler": d.get("devralan_urunler"), "pasta_adet": d.get("devralan_pasta")}
            elif yeni_akis and t1.get("kasa") is not None:   # Opus Y15: 2. tur yapılmadı → 1. turdaki devralan sayımı
                r = {**d, "sayilan_kurus": t1.get("kasa"), "bardak": t1.get("bardak"), "urunler": t1.get("urunler"), "pasta_adet": t1.get("pasta")}
            oid = _devir_olay(cur, r, {"merkez_istisna": True, "merkez": kim, "aciklama": b.aciklama.strip()[:200],
                                       "resmi": "devralan" if r is not d else "devreden", "tur1": d.get("tur1"),
                                       "devreden_sayilan": d.get("sayilan_kurus"), "devralan_sayilan": d.get("devralan_sayilan_kurus"),
                                       "sayim_ts": _sayim_ts(d)})
            cur.execute("SELECT id FROM ey_yoklama WHERE personel_id=%s AND sube_id=%s AND cikis_ts IS NULL AND is_gunu=%s",
                        (d["devreden_id"], d["sube_id"], d["is_gunu"]))
            yk = d.get("devreden_yoklama_id") or dict(cur.fetchone() or {}).get("id")
            if yk:   # Codex: dünkü devir bugünkü yeni girişi kapatmasın (yalnız o günün girişi)
                cikis_yaz(cur, d["devreden_id"], "devir", kim=f"merkez: {kim}", sube_id=d["sube_id"], yoklama_id=yk)
            if d["is_gunu"] == is_gunu() and d.get("devralan_id"):   # D12: kasa devralana geçti → vardiyası da başlar (yalnız bugünün devrinde)
                _devralan_giris(cur, d)
        cur.execute("""UPDATE ey_devir SET durum='merkez_kapatti', merkez_sonuc=%s, merkez_kim=%s, merkez_aciklama=%s, olay_id=COALESCE(%s, olay_id)
                        WHERE id=%s""", (b.sonuc, kim, b.aciklama.strip()[:200], oid, did))
    return {"ok": True, "mesaj": "Merkez kapattı — " + ("devir sayıldı" if b.sonuc == "kapandi" else "iptal")}


@router.post("/devir/{did}/gorundu")
def devir_gorundu(did: str, x_evvel_oturum: Optional[str] = Header(default=None)):
    yoklama_hazirla()
    with db() as (conn, cur):
        kim = _merkez(cur, x_evvel_oturum)
        cur.execute("""UPDATE ey_devir SET gorulen=%s WHERE id=%s AND (durum IN ('tutmadi','tutmuyor') OR (durum='tamam' AND vekil)) AND gorulen IS NULL
                       RETURNING id""", (kim, did))
        if not cur.fetchone():
            raise HTTPException(404, "Görülecek devir yok")
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
                          d.sube_id, d.devreden_id, d.devralan_id, d.ustlenen_id, d.fark_kalem, d.devralan_ts, d.panel_ts
                     FROM ey_devir d
                    WHERE (d.durum IN ('baslatildi','hazir','devreden_onayladi','sayiliyor','yeniden') AND (d.is_gunu < %s OR GREATEST(d.panel_ts,
                              COALESCE(d.devreden_ts, d.panel_ts), COALESCE(d.devralan_ts, d.panel_ts)) < NOW() - INTERVAL '2 hours'))
                       OR (d.durum IN ('tutmadi','tutmuyor','tamam') AND d.gorulen IS NULL AND (d.durum IN ('tutmadi','tutmuyor') OR d.vekil))
                    ORDER BY d.is_gunu""", (bugun,))
    _drows = [dict(x) for x in cur.fetchall() or []]
    _pa = adlar(cur, "ey_personel", {r[k] for r in _drows for k in ("devreden_id", "devralan_id", "ustlenen_id") if r.get(k)})
    _sa = adlar(cur, "ey_sube", {r["sube_id"] for r in _drows})
    for r in _drows:
        r.update(sube_ad=_sa.get(str(r["sube_id"])), devreden=_pa.get(str(r.get("devreden_id"))), devralan=_pa.get(str(r.get("devralan_id"))),
                 ustlenen=_pa.get(str(r.get("ustlenen_id"))))
        if r["durum"] == "tutmadi":   # v2: iki sayım da tutmadı → merkeze BİLGİ (sahip: karar yok, haber yeterli) — içine girmeden anlaşılır
            fk = int(r.get("devralan_sayilan_kurus") or 0) - int(r.get("sayilan_kurus") or 0)
            kalem = ", ".join((r.get("fark_kalem") or [])[:4])
            out.append({"tur": "yoklama_devir_tutmadi", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "⚠ Devir tutmadı",
                        "ad": f"{r['sube_ad'] or ''} · {r['devreden']} → {r['devralan']} · {_saat(r.get('devralan_ts')) or ''} · "
                              f"kasa {'tuttu' if fk == 0 else (_tl_tr(abs(fk)) + (' eksik' if fk < 0 else ' fazla'))}" + (f" · tutmayan: {kalem}" if kalem else ""),
                        "alt": "İki kör sayım da tutmadı; resmi rakam devralanın — Gördüm (Personel › Devirler)", "sayfa": "personel_devir", "dugme": "Aç"})
            continue
        if r["durum"] in ("tutmuyor", "tamam"):   # tutmuyor (fark) ya da başka personel ADINA devir (sahip: merkeze bildirim)
            fark = ""
            if r.get("devralan_sayilan_kurus") is not None and r.get("sayilan_kurus") is not None:
                fark = f" · devreden {_tl_tr(int(r['sayilan_kurus']))}, devralan {_tl_tr(int(r['devralan_sayilan_kurus']))}"
            sahip_yok = r.get("vekil") and r.get("ustlenen_id") == r.get("devreden_id")   # Opus B10: kasa sahibi içeride değildi, kişi kendisi devretti
            vek = ("" if not r.get("vekil") else " · kasa sahibi içeride değildi" if sahip_yok
                   else f" · {r['ustlenen']}, {r['devreden']} adına saydı")
            out.append({"tur": "yoklama_devir_tutmuyor", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "⚠ Devir tutmuyor" if r["durum"] == "tutmuyor" else ("👤 Kasa sahibi yokken devir" if sahip_yok else "👥 Devir başkası adına"),
                        "ad": f"{r['sube_ad'] or ''} {r['devreden']} → {r['devralan']}{fark}{vek}" + (f": '{r['devralan_not']}'" if r.get("devralan_not") else ""),
                        "alt": "Gördüm — Personel › Devirler", "sayfa": "personel_devir", "dugme": "Aç"})
        else:
            # D13 (sim 23 Eki): başlatılıp kimsenin okutmadığı devir de düşer (panel iptal edemez, yenisi açılamaz — yalnız merkez kapatır);
            # satır kendini anlatır: ne · şube · kim → kim · ne kadar süredir (feedback_bekleyen_is_kendini_anlatsin)
            _sure = int((datetime.now(timezone.utc) - r["panel_ts"]).total_seconds() // 3600) if r.get("panel_ts") else None
            out.append({"tur": "yoklama_devir_tamamlanmadi", "genel": True, "grup": "personel", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                        "etiket": "🔁 Devir tamamlanmadı", "ad": f"{r['sube_ad'] or ''} · {r['devreden'] or '—'} → {r['devralan'] or '—'} · "
                                                              + {"baslatildi": "kimse QR okutmadı", "hazir": "devreden onaylamadı",
                                                                 "sayiliyor": "sayım yarım kaldı",
                                                                 "yeniden": "ikinci sayım yapılmadı"}.get(r["durum"], "devralan kabul etmedi")
                                                              + (f" · {_sure} sa" if _sure is not None else ""),
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
