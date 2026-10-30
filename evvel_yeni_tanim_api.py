"""⚙️ EVVEL YENİ · TANIMLAR (2026-10-16) — şube · personel · banka · kart · toptancı.

Sahip: "Eski sistem tamamen kaldırılacak; ekleme/düzeltme buraya yazılsın." · "Şube sayısı artarsa şube
ekle, personel artarsa personel ekle (maaş/yemek bilgisiyle), banka, kart, toptancı ekle."

Kural:
  · Evvel Yeni KENDİ tablolarını tutar (ey_sube, ey_personel, ey_kart, ey_toptanci; bankalar = Kasa cepleri).
  · Eski tablolardan KİMLİĞİ AYNEN koruyarak kopyalanır; ON CONFLICT DO NOTHING → burada yapılan
    düzeltmenin üstüne ASLA yazılmaz. Eski tablo silinince kopyalama sessizce durur, hiçbir şey bozulmaz.
  · Hiçbir şey SİLİNMEZ — "pasif" yapılır (geçmiş kayıtlar adı kaybetmesin).
Bu dosya eski sisteme YAZMAZ.
"""

import hashlib
import logging
import math
import re
import secrets
import uuid
from datetime import date
from decimal import Decimal

from evvel_yeni_cekirdek import TrTutar   # para alanı: Türkçe tutar kuralı (TEK yer)
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evvel-yeni/tanim", tags=["evvel-yeni-tanim"])

_HAZIR = False


# Dalga 3 (F#31, C-T2-05/06): Yoklama/Kira/Kart/Toptancı'nın Tanımlar tablolarına eklediği kolonlar artık BURADA tanımlı (tek şema sahibi);
# o modüller ALTER atmaz, yazarken tanim_guncelle'yi çağırır.
_TANIM_NESNE = {"ey_sube": ("depo", "lat", "lng", "yaricap_m", "kira_artis_ayi", "kira_odeme_gunu", "kira_yok"),
                "ey_personel": ("cikis", "calisma_turu", "kisi_id", "erken_acilis", "pin_salt", "pin_hash", "yetki_geri_alma", "konum_muaf"),
                "ey_kart": ("limit_tutar", "kesim_gunu", "son_odeme_gunu", "limit_grup", "eklenme"), "ey_toptanci": ("vade_gun",),
                "ey_personel_ucret": ("saatlik", "yol"), "ey_pin_deneme": ()}
_GUNCELLENIR = {"ey_sube": {"lat", "lng", "yaricap_m", "kira_artis_ayi", "kira_odeme_gunu", "kira_yok"},
                "ey_personel": {"konum_muaf", "aktif", "cikis"},
                "ey_kart": {"limit_tutar", "kesim_gunu", "son_odeme_gunu", "limit_grup"}, "ey_toptanci": {"vade_gun"}}


def tanim_guncelle(cur, tablo: str, kid: str, alanlar: Optional[dict] = None, bos_ise: Optional[dict] = None,
                   kim: Optional[str] = None) -> Optional[dict]:
    """PUBLIC — başka modüllerin Tanımlar tablosuna yazdığı alanların TEK kapısı (beyaz listeli). alanlar: koşulsuz; bos_ise: yalnız
    alan boşsa (COALESCE). Dönüş: güncellenen satır {id, ad} ya da None (bulunamadı)."""
    tanim_hazirla(cur)
    alanlar, bos_ise = dict(alanlar or {}), dict(bos_ise or {})
    izin = _GUNCELLENIR.get(tablo) or set()
    hepsi = set(alanlar) | set(bos_ise)
    if not hepsi or not hepsi <= izin:
        raise HTTPException(400, "Bu alan buradan değiştirilemez")
    parca, deg = [], []
    for k, v in alanlar.items():
        parca.append(f"{k}=%s")
        deg.append(v)
    for k, v in bos_ise.items():
        parca.append(f"{k}=COALESCE({k}, %s)")
        deg.append(v)
    if kim is not None:
        parca.append("degistiren=%s")
        deg.append(kim)
    cur.execute(f"UPDATE {tablo} SET {', '.join(parca)}, zaman=NOW() WHERE id=%s RETURNING id, ad", tuple(deg) + (str(kid),))
    r = cur.fetchone()
    return dict(r) if r else None


def _tanim_tam(cur) -> bool:
    """Bütün Tanımlar tabloları ve kolonları VAR mı (salt okur, kilit istemez)."""
    cur.execute("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY(%s)",
                (list(_TANIM_NESNE),))
    var = {}
    for r in cur.fetchall() or []:
        var.setdefault(dict(r)["table_name"], set()).add(dict(r)["column_name"])
    return all(t in var and set(k) <= var[t] for t, k in _TANIM_NESNE.items())


def _tanim_ddl(cur) -> None:
    """Tanımlar'ın tabloları / kolonları (IF NOT EXISTS). Yalnız _tanim_tam False iken çağrılır."""
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_sube (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, pos_oran NUMERIC(6,3) NOT NULL DEFAULT 0, online_oran NUMERIC(6,3) NOT NULL DEFAULT 0,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS depo BOOLEAN NOT NULL DEFAULT FALSE")   # merkez depo (Tema) — SIPARIS_TASARIM §1
    # Yoklama (konum) + Kira kolonları — tek şema sahibi Tanımlar (Dalga 3)
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS yaricap_m INT NOT NULL DEFAULT 150")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS kira_artis_ayi INT")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS kira_odeme_gunu INT")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS kira_yok BOOLEAN NOT NULL DEFAULT FALSE")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_personel (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, sube_id TEXT, gorev TEXT, giris DATE,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_kart (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, banka TEXT, kimin TEXT, acilis_borc BIGINT NOT NULL DEFAULT 0,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_toptanci (
        id TEXT PRIMARY KEY, ad TEXT NOT NULL, kategori TEXT, telefon TEXT, acilis_bakiye BIGINT NOT NULL DEFAULT 0,
        aktif BOOLEAN NOT NULL DEFAULT TRUE, kaynak TEXT NOT NULL DEFAULT 'evvel_yeni', degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_personel_ucret (
        personel_id TEXT NOT NULL, gecerli_ay TEXT NOT NULL, maas BIGINT NOT NULL DEFAULT 0, yemek BIGINT NOT NULL DEFAULT 0,
        degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (personel_id, gecerli_ay))""")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS cikis DATE")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS calisma_turu TEXT NOT NULL DEFAULT 'tam'")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS kisi_id TEXT")
    cur.execute("ALTER TABLE ey_personel_ucret ADD COLUMN IF NOT EXISTS saatlik BIGINT NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE ey_personel_ucret ADD COLUMN IF NOT EXISTS yol BIGINT NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS erken_acilis BOOLEAN NOT NULL DEFAULT FALSE")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS pin_salt TEXT")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS pin_hash TEXT")
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS yetki_geri_alma BOOLEAN NOT NULL DEFAULT FALSE")   # S9
    cur.execute("ALTER TABLE ey_personel ADD COLUMN IF NOT EXISTS konum_muaf BOOLEAN NOT NULL DEFAULT FALSE")   # Yoklama K2
    for x in ("limit_tutar BIGINT", "kesim_gunu INT", "son_odeme_gunu INT", "limit_grup TEXT", "eklenme DATE"):   # Kart (eklenme: S-B2, yalnız yeni kart)
        cur.execute(f"ALTER TABLE ey_kart ADD COLUMN IF NOT EXISTS {x}")
    cur.execute("ALTER TABLE ey_toptanci ADD COLUMN IF NOT EXISTS vade_gun INT")   # Toptancı
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_pin_deneme (
        personel_id TEXT PRIMARY KEY, yanlis INT NOT NULL DEFAULT 0, kilit_bitis TIMESTAMPTZ, son TIMESTAMPTZ NOT NULL DEFAULT NOW())""")


def _eski_kopyalar() -> list:
    """Eski sistemden kopya (yalnız EKSİK kimlikler; doldurmalar yalnız BOŞ alanlara — burada düzeltilen ezilmez). [(savepoint, sql)]"""
    return [
        ("sp_ey_k_sube", """INSERT INTO ey_sube (id, ad, pos_oran, online_oran, aktif, kaynak, degistiren)
             SELECT id::text, ad, COALESCE(pos_oran,0), COALESCE(online_oran,0), COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM subeler ON CONFLICT (id) DO NOTHING"""),
        ("sp_ey_k_per", """INSERT INTO ey_personel (id, ad, sube_id, gorev, aktif, kaynak, degistiren)
             SELECT id::text, ad_soyad, sube_id::text, gorev, COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM personel ON CONFLICT (id) DO NOTHING"""),
        ("sp_ey_k_ucret", """INSERT INTO ey_personel_ucret (personel_id, gecerli_ay, maas, yemek, degistiren)
             SELECT p.id::text, '2000-01', ROUND(COALESCE(p.maas,0)*100)::bigint, ROUND(COALESCE(p.yemek_ucreti,0)*100)::bigint, 'eski sistem kopyası'
               FROM personel p WHERE NOT EXISTS (SELECT 1 FROM ey_personel_ucret u WHERE u.personel_id = p.id::text)
             ON CONFLICT DO NOTHING"""),
        ("sp_ey_k_kart", """INSERT INTO ey_kart (id, ad, banka, aktif, kaynak, degistiren)
             SELECT id::text, kart_adi, banka, COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM kartlar ON CONFLICT (id) DO NOTHING"""),
        ("sp_ey_k_top", """INSERT INTO ey_toptanci (id, ad, kategori, telefon, aktif, kaynak, degistiren)
             SELECT id::text, ad, kategori, telefon, COALESCE(aktif,TRUE), 'eski_sistem', 'eski sistem kopyası'
               FROM tedarikciler ON CONFLICT (id) DO NOTHING"""),
    ] + [
        # Yalnız BOŞ alanları doldur — burada düzeltilen ezilmez
        ("sp_ey_k_per2", """UPDATE ey_personel e SET giris = COALESCE(e.giris, p.baslangic_tarihi::date),
                                   cikis = COALESCE(e.cikis, p.cikis_tarihi::date),
                                   calisma_turu = CASE WHEN e.kaynak = 'eski_sistem' AND e.degistiren = 'eski sistem kopyası'
                                                       THEN (CASE WHEN COALESCE(p.calisma_turu,'surekli') = 'surekli' THEN 'tam' ELSE 'yari' END)
                                                       ELSE e.calisma_turu END
                              FROM personel p WHERE p.id::text = e.id"""),
        ("sp_ey_k_kisi", """UPDATE ey_personel e SET kisi_id = p.kisi_id::text FROM personel p
                              WHERE p.id::text = e.id AND e.kisi_id IS NULL AND p.kisi_id IS NOT NULL"""),
        # kart limit/kesim/son ödeme/grup — önce Kart modülü ey_kart'a kendisi UPDATE atıyordu (F#31: tablo Tanımlar'ın)
        ("sp_ey_k_kart2", """UPDATE ey_kart e SET limit_tutar = COALESCE(e.limit_tutar, ROUND(k.limit_tutar*100)::bigint),
                                  kesim_gunu = COALESCE(e.kesim_gunu, k.kesim_gunu), son_odeme_gunu = COALESCE(e.son_odeme_gunu, k.son_odeme_gunu),
                                  limit_grup = COALESCE(e.limit_grup, k.ortak_limit_grup)
                             FROM kartlar k WHERE k.id::text = e.id"""),
        ("sp_ey_k_ucret2", """UPDATE ey_personel_ucret u SET saatlik = ROUND(COALESCE(p.saatlik_ucret,0)*100)::bigint,
                                     yol = ROUND(COALESCE(p.yol_ucreti,0)*100)::bigint
                                FROM personel p WHERE p.id::text = u.personel_id AND u.degistiren = 'eski sistem kopyası'
                                 AND u.saatlik = 0 AND u.yol = 0"""),
    ]


def tanim_hazirla(cur) -> None:
    """Tabloları kurar + eski sistemden EKSİK olanları kopyalar (var olana dokunmaz). Kasa'nın _hazirla'sı da çağırır."""
    global _HAZIR
    if _HAZIR:
        return
    # Dalga 2 (F#13 + 19 Eki dersi): var olan nesneye ALTER/kilit İSTEME — önce bak; eksikse çağıranın işleminde savepoint +
    # kısa lock_timeout (sonra DEFAULT'a döner: önceden SET LOCAL çağıranın işlemine SIZIYORDU); bayrak ancak nesneler görülünce.
    tam = _tanim_tam(cur)
    if not tam:
        try:
            from evvel_yeni_cekirdek import ddl_kur
            ddl_kur(cur, "sp_ey_tanim_ddl", _tanim_ddl)   # TEK DDL modeli — çağıranın lock_timeout'u geri yüklenir (Codex P2)
        except Exception:  # noqa: BLE001
            log.warning("tanım tabloları hazırlanamadı", exc_info=True)
            raise HTTPException(503, "Tanımlar hazırlanıyor — birkaç saniye sonra tekrar dene")
    # Maaş için personel kartı (2026-10-16, Codex): çıkış, çalışma türü, kişi kimliği; ücrette saatlik + yol
    from evvel_yeni_cekirdek import yeni_donem
    # F#45: 1 Kasım'dan sonra eski tablolardan kopya yok (eski sistem kalkıyor); son kopyayı 1 Kasım son aktarımı alır (kesim_dondur)
    kopyalar = [] if yeni_donem(cur) else _eski_kopyalar()
    for sp, sql in kopyalar:
        try:
            with savepoint(cur, sp):
                cur.execute(sql)
        except Exception as e:  # noqa: BLE001 — eski tablo kalktıysa kopya biter, Evvel Yeni yaşar
            log.info("evvel-yeni tanım: eski kopya atlandı (%s): %s", sp, str(e)[:120])
    # 07:00 öncesi açılış izni (sahip D10: 07:00 öncesi açılış engellenir, kişiye özel izin istisnası)
    # İÇERİK bir kez (köprü değil) — çekirdek bir_kez (K5): eski personel kartındaki erken açılış izni; sonra yalnız Evvel Yeni'de değişir
    from evvel_yeni_cekirdek import bir_kez
    bir_kez(cur, "erken_acilis_kopya", lambda c: c.execute("""UPDATE ey_personel e SET erken_acilis = TRUE FROM personel p
                                                             WHERE p.id::text = e.id AND COALESCE(p.erken_acilis_izni, FALSE)"""),
            "erken açılış izni")
    # 🔐 PANEL PIN (sahip 2026-10-19: sık işlemler = ad + PIN; eski panelle AYNI biçim sha256(salt:pin) — personel yeniden PIN almaz)
    # yanlış deneme sayacı AYRI tabloda (Fable: ey_personel izi kirlenmesin; ayrı bağlantıda yazılır)
    # İÇERİK bir kez: eski personel PIN'leri — yalnız PIN'i olmayan satıra (merkezin yeni verdiği ezilmez)
    bir_kez(cur, "pin_kopya", lambda c: c.execute("""UPDATE ey_personel e SET pin_salt = p.panel_pin_salt, pin_hash = p.panel_pin_hash FROM personel p
                                                    WHERE p.id::text = e.id AND e.pin_hash IS NULL
                                                      AND TRIM(COALESCE(p.panel_pin_hash, '')) <> '' AND TRIM(COALESCE(p.panel_pin_salt, '')) <> ''"""),
            "panel PIN'leri")
    # İÇERİK bir kez: eski şube koordinatları (K3) ve yönetici konum muafiyeti (K2) — alanlar Tanımlar'ın (önce Yoklama çağırıyordu)
    bir_kez(cur, "sube_konum_kopya", lambda c: _eski_konum_sql(c, "sube"), "şube koordinatları")
    bir_kez(cur, "konum_muaf_kopya", lambda c: _eski_konum_sql(c, "muaf"), "konum muafiyeti")
    _HAZIR = tam   # bu çağrıda kurulduysa bir SONRAKİ çağrı görüp açar


PIN_YANLIS_LIMIT = 5
PIN_KILIT_DK = 15


def _pin_hash(salt: str, pin: str) -> str:
    return hashlib.sha256(f"{salt}:{pin}".encode()).hexdigest()


def ucret_yaz(cur, *, personel_id: str, ay: str, kim: str, maas: Optional[int] = None, yemek: Optional[int] = None,
              saatlik: Optional[int] = None, yol: Optional[int] = None) -> dict:
    """PUBLIC — personel ücretinin TEK yazıcısı (tekrar denetimi C-T1-01: Ödeme formu ayrı yazıp saatlik/yolu SIFIRLIYORDU).
    Kuruş. O aydan İTİBAREN geçerli; verilmeyen alan (None) o aya kadarki en son tanımdan TAŞINIR — hiçbir alan sessizce 0 olmaz."""
    tanim_hazirla(cur)
    ay = str(ay)[:7]
    yeni = {"maas": maas, "yemek": yemek, "saatlik": saatlik, "yol": yol}
    if any(v is not None and v < 0 for v in yeni.values()):
        raise HTTPException(400, "Tutar eksi olamaz")
    cur.execute("""SELECT maas, yemek, saatlik, yol FROM ey_personel_ucret WHERE personel_id=%s AND gecerli_ay <= %s
                    ORDER BY gecerli_ay DESC LIMIT 1""", (str(personel_id), ay))
    o = dict(cur.fetchone() or {"maas": 0, "yemek": 0, "saatlik": 0, "yol": 0})
    yu = {k: (int(v) if v is not None else int(o[k] or 0)) for k, v in yeni.items()}
    cur.execute("""INSERT INTO ey_personel_ucret (personel_id, gecerli_ay, maas, yemek, saatlik, yol, degistiren)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (personel_id, gecerli_ay) DO UPDATE SET maas=EXCLUDED.maas, yemek=EXCLUDED.yemek,
                     saatlik=EXCLUDED.saatlik, yol=EXCLUDED.yol, degistiren=EXCLUDED.degistiren, zaman=NOW()""",
                (str(personel_id), ay, yu["maas"], yu["yemek"], yu["saatlik"], yu["yol"], kim))
    return yu


def pin_dogrula(cur, personel_id: str, pin: Optional[str]) -> None:
    """PUBLIC (panel): 4 haneli PIN doğru değilse HTTPException. Yanlış sayacı AYRI bağlantıda atomik yazılır
    (asıl işlem geri alınsa / deneme modu olsa da sayılır). 5 yanlış → 15 dk kilit. PIN hiçbir yere yazılmaz."""
    p = (pin or "").strip()
    if not (len(p) == 4 and p.isdigit()):
        raise HTTPException(400, "PIN 4 haneli olmalı")
    cur.execute("SELECT pin_salt, pin_hash FROM ey_personel WHERE id=%s", (personel_id,))
    r = dict(cur.fetchone() or {})
    if not (r.get("pin_hash") or "").strip() or not (r.get("pin_salt") or "").strip():
        raise HTTPException(400, "Bu personelin PIN'i tanımlı değil — merkez Tanımlar › Personel'den versin")
    sonuc = None
    with db() as (_c, k):
        k.execute("INSERT INTO ey_pin_deneme (personel_id, yanlis, son) VALUES (%s, 0, NOW()) ON CONFLICT (personel_id) DO NOTHING",
                  (personel_id,))   # Codex: satır önce var olsun → FOR UPDATE her denemeyi sıraya koyar
        k.execute("""SELECT yanlis, kilit_bitis > NOW() AS kilitli, EXTRACT(EPOCH FROM (kilit_bitis - NOW())) AS kalan
                       FROM ey_pin_deneme WHERE personel_id=%s FOR UPDATE""", (personel_id,))
        d = dict(k.fetchone() or {})
        if d.get("kilitli"):
            sonuc = ("kilit", max(1, math.ceil(float(d.get("kalan") or 60) / 60)))
        elif secrets.compare_digest(_pin_hash(r["pin_salt"], p), r["pin_hash"]):
            k.execute("DELETE FROM ey_pin_deneme WHERE personel_id=%s", (personel_id,))
        else:
            k.execute("""INSERT INTO ey_pin_deneme (personel_id, yanlis, son) VALUES (%s, 1, NOW())
                         ON CONFLICT (personel_id) DO UPDATE SET son=NOW(),
                           yanlis = CASE WHEN ey_pin_deneme.kilit_bitis IS NOT NULL AND ey_pin_deneme.kilit_bitis <= NOW() THEN 1
                                         ELSE ey_pin_deneme.yanlis + 1 END,
                           kilit_bitis = CASE WHEN ey_pin_deneme.kilit_bitis IS NOT NULL AND ey_pin_deneme.kilit_bitis <= NOW() THEN NULL
                                              ELSE ey_pin_deneme.kilit_bitis END
                         RETURNING yanlis""", (personel_id,))
            n = int(dict(k.fetchone())["yanlis"])
            if n >= PIN_YANLIS_LIMIT:
                k.execute("UPDATE ey_pin_deneme SET yanlis=0, kilit_bitis = NOW() + (%s || ' minutes')::interval WHERE personel_id=%s",
                          (str(PIN_KILIT_DK), personel_id))
                sonuc = ("kilit", PIN_KILIT_DK)
            else:
                sonuc = ("yanlis", PIN_YANLIS_LIMIT - n)
    if sonuc and sonuc[0] == "kilit":
        raise HTTPException(429, f"PIN kilitli — yaklaşık {sonuc[1]} dakika sonra dene")
    if sonuc:
        raise HTTPException(403, f"PIN yanlış — {sonuc[1]} hakkın kaldı")


# ── OKUMA YARDIMCILARI (öbür modüller bunları kullanır) ──
# Tekrar denetimi F#27/F#31 + C-T2-04/09/10/11: Yoklama, Maaş, Kira, Kart, Panel, Avans, Satış, Kasa, Toptancı Tanımlar tablolarına
# (şube · personel · kart · toptancı · ücret) ~60 ayrı SQL atıyordu. Okuma TEK kapıdan: kolon adı yalnız burada bilinir.
_OKUNUR = {"ey_sube", "ey_personel", "ey_kart", "ey_toptanci"}
_KOLON = re.compile(r"^[a-z_][a-z0-9_]*$")


def _tablo_kolon(tablo: str, alanlar) -> str:
    if tablo not in _OKUNUR:
        raise ValueError(f"Tanımlar okunamaz: {tablo}")
    if alanlar in (None, "*"):
        return "*"
    al = list(alanlar)
    if not al or not all(_KOLON.match(a) for a in al):
        raise ValueError("Geçersiz kolon")
    return ", ".join(dict.fromkeys(["id", *al]))


def ayrildi_mi(cikis, gun) -> bool:
    """PUBLIC — TEK kural (S-B7, sim 23 Eki): ayrılış tarihi SON iş günüdür; ertesi günden itibaren kişi telefon/panelde iş yapamaz
    (önce yalnız 'aktif' bakılıyordu → ayrılan personel QR giriş + avans isteği yapabiliyordu)."""
    if not cikis:
        return False
    g = gun.isoformat() if hasattr(gun, "isoformat") else str(gun)
    return str(cikis)[:10] < g[:10]


def tanim_oku(cur, tablo: str, kid, alanlar=None) -> Optional[dict]:
    """PUBLIC — tek Tanımlar kaydı (id ile) ya da None. alanlar verilmezse bütün kolonlar."""
    if kid is None:
        return None
    tanim_hazirla(cur)
    cur.execute(f"SELECT {_tablo_kolon(tablo, alanlar)} FROM {tablo} WHERE id=%s", (str(kid),))
    r = cur.fetchone()
    return dict(r) if r else None


def tanim_listesi(cur, tablo: str, alanlar=None, aktif: bool = False, idler=None) -> List[dict]:
    """PUBLIC — Tanımlar listesi (ada göre sıralı). aktif=True yalnız aktifler; idler verilirse yalnız onlar."""
    tanim_hazirla(cur)
    kos, prm = [], []
    if aktif:
        kos.append("aktif")
    if idler is not None:
        kos.append("id = ANY(%s)")
        prm.append([str(x) for x in idler if x is not None])
    cur.execute(f"SELECT {_tablo_kolon(tablo, alanlar)} FROM {tablo}" + (" WHERE " + " AND ".join(kos) if kos else "") + " ORDER BY ad",
                tuple(prm))
    return [dict(r) for r in cur.fetchall() or []]


def adlar(cur, tablo: str, idler=None) -> Dict[str, str]:
    """PUBLIC — {id: ad} (görüntü adı). idler verilmezse tablonun tamamı (pasifler dahil — eski kayıtların adı da çözülsün)."""
    if idler is not None and not [x for x in idler if x is not None]:
        return {}
    return {str(r["id"]): r["ad"] for r in tanim_listesi(cur, tablo, ("ad",), idler=idler)}


# 🕘 SAATLİK KURAL (sahip 30 Eki: "tam personel günde 9,5 saat · haftada izin maaşa dahil · burada hesaplanan saatlik ücret neyse part
# personele de o kadar saatlik ücret verilir" · Codex karar): saatlik = tam zamanlı TABAN aylık ÷ (30 × 9,5) = ÷ 285. Yarı zamanlının
# saatliği Kasım 2026'dan itibaren OTOMATİK (elle değer istisna değil, saklanır ama kullanılmaz); oran kuruşa erken kesilmez.
SAATLIK_BOLEN = 285
TAM_TABAN_VARSAYILAN = {"2026-11": 2807500}   # sahip 30 Eki: asgari ücret 28.075 ₺ (kuruş) — değişince yeni ay sürümü eklenir


def tam_taban(cur, ay: str) -> Optional[int]:
    """PUBLIC — o ay geçerli tam zamanlı taban aylık (kuruş): ey_ayar 'tam_taban' {ay: kuruş} sürümlerinin ay'a kadar en yenisi."""
    from evvel_yeni_cekirdek import ayar_oku, json_ac
    s = json_ac(ayar_oku(cur, "tam_taban", None), None) or TAM_TABAN_VARSAYILAN
    gecerli = [a for a in s if a <= ay]
    return int(s[max(gecerli)]) if gecerli else None


def _u_ay(b, giris) -> str:
    """Ücretin geçerli olduğu ay (personel kaydında aynı kural: ucret_ay, yoksa giriş ayı, yoksa bu ay)."""
    from evvel_yeni_cekirdek import bugun as _bugun
    return (b.ucret_ay or (giris.isoformat() if giris else _bugun().isoformat()))[:7]


def otomatik_saatlik_ayi(cur) -> str:
    """Yarı zamanlı otomatik saatliğin başladığı ay = yeni maaş hesabının ilk ayı (panel_baslangic ayı — Ekim eski bordro korunur)."""
    from evvel_yeni_cekirdek import panel_baslangic
    return panel_baslangic(cur).strftime("%Y-%m")


def ay_ucretleri(cur, ay: str) -> Dict[str, dict]:
    """PUBLIC — {personel_id: {maas, yemek, saatlik, yol, degistiren[, saatlik_oran, saatlik_otomatik]}} o ay GEÇERLİ ücret
    (gecerli_ay <= ay, en yenisi; kuruş). Tablo Tanımlar'ın (ucret_yaz ile yazılır) — Maaş buradan okur (C-T2-10).
    Yarı zamanlıda (otomatik ay ve sonrası) saatlik_oran = tam taban ÷ 285 (Decimal kuruş/saat, yuvarlanmamış) — TEK yer."""
    tanim_hazirla(cur)
    cur.execute("""SELECT DISTINCT ON (personel_id) personel_id, maas, yemek, saatlik, yol, degistiren FROM ey_personel_ucret
                    WHERE gecerli_ay <= %s ORDER BY personel_id, gecerli_ay DESC""", (ay,))
    out = {dict(r)["personel_id"]: dict(r) for r in cur.fetchall() or []}
    if ay >= otomatik_saatlik_ayi(cur):
        taban = tam_taban(cur, ay)
        if taban:
            from decimal import Decimal as _D
            oran = _D(taban) / SAATLIK_BOLEN
            cur.execute("SELECT id FROM ey_personel WHERE calisma_turu = 'yari'")
            for r in cur.fetchall() or []:
                pid = dict(r)["id"]
                x = out.setdefault(pid, {"personel_id": pid, "maas": 0, "yemek": 0, "saatlik": 0, "yol": 0, "degistiren": None})
                x.update({"saatlik_oran": oran, "saatlik": int(oran.quantize(_D(1))), "saatlik_otomatik": True})
    return out


def mudur_mu(gorev: Optional[str]) -> bool:
    """PUBLIC — TEK müdür kuralı (ayrı işaret YOK, sahip F1b): Tanımlar › Personel görevinde 'MÜDÜR'."""
    g = (gorev or "").upper()
    return "MÜDÜR" in g or "MUDUR" in g


def _eski_konum_sql(cur, ne: str) -> None:
    """Tanımlar hazırlığında BİR KEZ (bir_kez): 'sube' = eski şube koordinatları (K3) · 'muaf' = eski panel yöneticisinin konum
    muafiyeti (K2). Tablolar Tanımlar'ın — önce Yoklama UPDATE atıyordu (F#31). Hazırlığı yeniden çağırmaz (özyineleme olmasın)."""
    if ne == "sube":
        cur.execute("""UPDATE ey_sube e SET lat = s.lat, lng = s.lng, yaricap_m = COALESCE(s.konum_radius_m, 150)
                         FROM subeler s WHERE s.id::text = e.id AND e.lat IS NULL AND s.lat IS NOT NULL AND s.lng IS NOT NULL""")
    elif ne == "muaf":
        cur.execute("""UPDATE ey_personel e SET konum_muaf = TRUE FROM personel p
                        WHERE p.id::text = e.id AND COALESCE(p.panel_yonetici, FALSE)""")


def toptanci_yoksa_ac(cur, tid: str, ad: Optional[str], kaynak: str) -> None:
    """PUBLIC (Toptancı teslimi): eski sistemde sonradan açılmış toptancı Evvel Yeni'de yoksa tanımını aç (teslim görünmez kalmasın).
    Tablo Tanımlar'ın — Toptancı modülü kendisi INSERT atmaz (F#32). Panel bunu ÇAĞIRMAZ (panel toptancı açmaz)."""
    tanim_hazirla(cur)
    cur.execute("""INSERT INTO ey_toptanci (id, ad, kaynak, degistiren) VALUES (%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
                (str(tid), ad or str(tid), kaynak, f"{kaynak} ile açıldı"))


def kartlar(cur) -> List[dict]:
    """PUBLIC (Kart modülü): aktif kartlar, ortak limit grubuna göre sıralı (grupsuzlar sonda)."""
    tanim_hazirla(cur)
    cur.execute("SELECT * FROM ey_kart WHERE aktif ORDER BY limit_grup NULLS LAST, ad")
    return [dict(r) for r in cur.fetchall() or []]


def _konum_coz(t: str) -> tuple:
    """B36: '36.96912, 28.68845' (Google Haritalar kopyası) ya da '36,96912 28,68845' → (enlem, boylam)."""
    t = t.strip()
    parca = [x for x in re.split(r"\s*,\s*", t) if x] if "." in t else [x.replace(",", ".") for x in re.split(r"[\s;]+", t) if x]
    try:
        lat, lng = float(parca[0]), float(parca[1])
        if len(parca) != 2 or not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError
    except (ValueError, IndexError):
        raise HTTPException(400, "Konum: Google Haritalar'dan 'enlem, boylam' yapıştır (ör. 36.96912, 28.68845)")
    return lat, lng


def subeler(cur, hepsi: bool = False):
    tanim_hazirla(cur)
    cur.execute(f"SELECT id, ad, pos_oran, online_oran, aktif, depo FROM ey_sube {'' if hepsi else 'WHERE aktif'} ORDER BY ad")
    return [dict(r) for r in cur.fetchall() or []]


def depo_sube_id(cur) -> Optional[str]:
    """PUBLIC: merkez depo olan şube (ey_sube.depo). Hiç işaretli yoksa ilk kez Tema işaretlenir (bugünkü gerçek)."""
    tanim_hazirla(cur)
    cur.execute("SELECT id FROM ey_sube WHERE depo AND aktif ORDER BY ad LIMIT 1")
    r = cur.fetchone()
    if r:
        return dict(r)["id"]
    cur.execute("UPDATE ey_sube SET depo=TRUE WHERE id='sube-tema' AND NOT EXISTS (SELECT 1 FROM ey_sube WHERE depo) RETURNING id")
    r = cur.fetchone()
    return dict(r)["id"] if r else None


def secim_listeleri(cur) -> dict:
    """Ödeme formunun açılır listeleri — YALNIZ aktif olanlar."""
    tanim_hazirla(cur)
    out = {}
    for ad, sql in (
        ("toptancilar", "SELECT id, ad, kategori FROM ey_toptanci WHERE aktif ORDER BY ad"),
        ("personel", "SELECT id, ad, sube_id, gorev, aktif, cikis::text AS cikis, erken_acilis FROM ey_personel ORDER BY aktif DESC, ad"),
        ("kartlar", "SELECT id, ad, banka, kimin FROM ey_kart WHERE aktif ORDER BY ad"),
    ):
        cur.execute(sql)
        out[ad] = [{k: (float(v) if isinstance(v, Decimal) else v) for k, v in dict(r).items()} for r in cur.fetchall() or []]
    return out


# ── EKRAN UÇLARI ──
TURLER = {
    "sube": "ey_sube", "personel": "ey_personel", "kart": "ey_kart", "toptanci": "ey_toptanci",
}


def _tl(k) -> float:
    from evvel_yeni_cekirdek import tl_sayi
    return tl_sayi(k)


def _kurus(x) -> int:
    """ELLE GİRİLEN tutar → kuruş: çekirdeğin TEK kuralı — 2 ondalıktan fazlası SESSİZCE yuvarlanmaz, sorulur (Dalga 4, F#5:
    Tanımlar yuvarlıyor, Ödeme reddediyordu)."""
    from evvel_yeni_cekirdek import kurus
    return kurus(x or 0)


def _slug(ad: str) -> str:
    tr = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")
    return re.sub(r"[^a-z0-9]+", "-", ad.translate(tr).lower()).strip("-")[:30] or uuid.uuid4().hex[:8]


@router.get("/liste")
def liste(x_evvel_oturum: Optional[str] = Header(default=None)):
    """Bütün tanımlar tek seferde (aktif + pasif). 🔐 Ortak liste (seçiciler okur) — izin kapısı ZORLA kipindeyse kişinin
    izni olmayan hassas alanlar budanır (evvel_yeni_yetki.budama_haritasi · Codex: toplu yanıtlar ayrıca süzülür)."""
    from evvel_yeni_yetki import budama_haritasi
    return _liste_buda(_liste_tam(), budama_haritasi(x_evvel_oturum))


def _liste_buda(d: dict, iz: Optional[dict]) -> dict:
    if iz is None:
        return d
    var = lambda *a: any(iz.get(x) for x in a)   # noqa: E731
    if not var("tanim.personel"):   # ücret yalnız personel tanımını görene (maaş satırı kendi ucunda)
        d["personel"] = [{k: v for k, v in x.items() if k not in ("maas", "yemek", "saatlik", "yol", "ucret_eski", "pin_var", "saatlik_otomatik")}
                         for x in d["personel"]]
    if not var("tanim.kart", "kart.liste", "kart.takvim"):
        d["kartlar"] = []
    if not var("tanim.banka", "kasa.banka", "kasa.mutabakat"):
        d["bankalar"] = []
    if not var("tanim.sube", "kira.takvim"):
        d["subeler"] = [{k: v for k, v in x.items() if not k.startswith("kira") and k not in ("pos_oran", "online_oran")} for x in d["subeler"]]
    if not var("tanim.toptanci", "toptanci.liste"):
        d["toptancilar"] = [{k: v for k, v in x.items() if k != "acilis_bakiye"} for x in d["toptancilar"]]
    d["budandi"] = True
    return d


def _liste_tam():
    from evvel_yeni_kasa_api import kasa_hazirla as _hazirla
    from evvel_yeni_cekirdek import bugun as _bugun
    _hazirla()
    ay = _bugun().strftime("%Y-%m")
    with db() as (conn, cur):
        tanim_hazirla(cur)
        sube = subeler(cur, hepsi=True)
        cur.execute("SELECT id, lat, lng, yaricap_m FROM ey_sube")
        konum = {dict(r)["id"]: dict(r) for r in cur.fetchall() or []}   # B36: koordinat Tanımlar'da görünür / düzeltilir
        sube_ad = {s["id"]: s["ad"] for s in sube}
        cur.execute("""SELECT p.*, u.maas, u.yemek, u.saatlik, u.yol, u.gecerli_ay, u.degistiren AS ucret_kim
                         FROM ey_personel p LEFT JOIN LATERAL (
                           SELECT maas, yemek, saatlik, yol, gecerli_ay, degistiren FROM ey_personel_ucret
                            WHERE personel_id = p.id AND gecerli_ay <= %s ORDER BY gecerli_ay DESC LIMIT 1) u ON TRUE
                        ORDER BY p.aktif DESC, p.ad""", (ay,))
        personel = []
        for r in cur.fetchall() or []:
            r = dict(r)
            personel.append({"id": r["id"], "ad": r["ad"], "sube_id": r["sube_id"], "sube_ad": sube_ad.get(r["sube_id"]) or "Ortak",
                             "gorev": r["gorev"], "giris": r["giris"].isoformat() if r["giris"] else None, "aktif": r["aktif"],
                             "maas": _tl(r["maas"]), "yemek": _tl(r["yemek"]), "saatlik": _tl(r["saatlik"]), "yol": _tl(r["yol"]),
                             "cikis": r["cikis"].isoformat() if r.get("cikis") else None, "calisma_turu": r.get("calisma_turu") or "tam",
                             "ucret_eski": (r["ucret_kim"] == "eski sistem kopyası"), "kaynak": r["kaynak"],
                             "erken_acilis": bool(r.get("erken_acilis")), "pin_var": bool((r.get("pin_hash") or "").strip()),
                             "yetki_geri_alma": bool(r.get("yetki_geri_alma"))})
        _U = ay_ucretleri(cur, ay)   # 30 Eki (Codex 6): yarı zamanlıda Kasım'dan otomatik saatlik (asgari ÷ 285) — Maaş ile AYNI çözüm
        for x in personel:
            u = _U.get(x["id"]) or {}
            if x["calisma_turu"] == "yari" and u.get("saatlik_otomatik"):
                x["saatlik"] = float((u["saatlik_oran"] / 100).quantize(Decimal("0.01")))
                x["saatlik_otomatik"] = True
        try:
            from evvel_yeni_kira_api import kira_tanimlari
            with savepoint(cur, "sp_ey_t_kira"):
                kira_t = kira_tanimlari(cur)
        except Exception:  # noqa: BLE001
            kira_t = {}
        cur.execute("SELECT * FROM ey_kart ORDER BY aktif DESC, ad")
        kart = [{**{k: v for k, v in dict(r).items() if k not in ("zaman", "acilis_borc", "limit_tutar")}, "acilis_borc": _tl(dict(r)["acilis_borc"]),
                 "limit_tutar": _tl(dict(r)["limit_tutar"]) if dict(r).get("limit_tutar") is not None else None} for r in cur.fetchall() or []]
        cur.execute("SELECT * FROM ey_toptanci ORDER BY aktif DESC, ad")
        top = [{**{k: v for k, v in dict(r).items() if k not in ("zaman", "acilis_bakiye")}, "acilis_bakiye": _tl(dict(r)["acilis_bakiye"])} for r in cur.fetchall() or []]
        from evvel_yeni_kasa_api import banka_cepleri   # cep tablosu Kasa'nın (F#35)
        banka = [{**r, "sube_ad": sube_ad.get(r["sube_id"])} for r in banka_cepleri(cur)]
    return {
        "subeler": [{"id": s["id"], "ad": s["ad"], "pos_oran": float(s["pos_oran"]), "online_oran": float(s["online_oran"]), "aktif": s["aktif"],
                     "kira": (kira_t.get(s["id"]) or {}).get("kira"), "kira_artis_ayi": (kira_t.get(s["id"]) or {}).get("artis_ayi"),
                     "kira_odeme_gunu": (kira_t.get(s["id"]) or {}).get("odeme_gunu"), "kira_gecmis": (kira_t.get(s["id"]) or {}).get("gecmis", []),
                     "kira_yok": (kira_t.get(s["id"]) or {}).get("kira_yok", False),
                     "konum": (f"{konum[s['id']]['lat']}, {konum[s['id']]['lng']}" if (konum.get(s["id"]) or {}).get("lat") is not None else None),
                     "yaricap_m": (konum.get(s["id"]) or {}).get("yaricap_m")}
                    for s in sube],
        "personel": personel, "kartlar": kart, "toptancilar": top, "bankalar": banka, "ay": ay,
    }


class TanimBody(BaseModel):
    ad: Optional[str] = None
    aktif: Optional[bool] = None
    # şube
    pos_oran: Optional[Decimal] = None
    online_oran: Optional[Decimal] = None
    # personel
    sube_id: Optional[str] = None
    gorev: Optional[str] = None
    giris: Optional[str] = None
    maas: Optional[TrTutar] = None
    yemek: Optional[TrTutar] = None
    ucret_ay: Optional[str] = None       # maaş/yemek değişikliği hangi aydan itibaren
    cikis: Optional[str] = None          # işten ayrılış (YYYY-AA-GG) — son maaş için
    calisma_turu: Optional[str] = None   # 'tam' | 'yari'
    erken_acilis: Optional[bool] = None   # B7: panelde 07:00 öncesi açılış izni
    pin: Optional[str] = None             # panel PIN'i (4 hane) — yalnız değiştirmek için; asla geri dönmez
    yetki_geri_alma: Optional[bool] = None   # S9: hatalı teslimi geri alabilir
    saatlik: Optional[TrTutar] = None    # yarı zamanlı saatlik ücret
    yol: Optional[TrTutar] = None        # aylık yol
    # kart / banka
    banka: Optional[str] = None
    kimin: Optional[str] = None
    acilis_borc: Optional[TrTutar] = None
    limit_tutar: Optional[TrTutar] = None
    vade_gun: Optional[int] = None           # toptancı: teslimden kaç gün sonra ödenir
    kira: Optional[TrTutar] = None           # şube aylık kirası
    kira_ay: Optional[str] = None            # kira hangi aydan geçerli (YYYY-AA)
    kira_artis_ayi: Optional[int] = None     # her yıl hangi ay artar (1–12)
    kira_odeme_gunu: Optional[int] = None
    kira_yok: Optional[bool] = None          # mülk bizim — kira gideri yok
    konum: Optional[str] = None              # B36: "enlem, boylam" (Google Haritalar'dan) — boş bırakılırsa değişmez
    yaricap_m: Optional[int] = None          # telefon yoklamasında kabul yarıçapı (m)
    kesim_gunu: Optional[int] = None
    son_odeme_gunu: Optional[int] = None
    limit_grup: Optional[str] = None
    tur: Optional[str] = None            # banka cebi: 'banka' | 'hesap'
    # toptancı
    kategori: Optional[str] = None
    telefon: Optional[str] = None
    acilis_bakiye: Optional[TrTutar] = None


def _pasif_denetle(cur, tur: str, tid: str) -> None:
    """B69 (Fable 22 Eki) — TEK KURAL: açık borcu olan toptancı / kart pasif yapılmaz. Pasif kart Kartlar'dan ve takvimden, pasif
    toptancı Ödeme formundan düşer → borç ödenemez / görünmez olur. Borç sahibi modülün kendi hesabından okunur (yeni hesap yok);
    modül kapalıysa denetim atlanır (tak-çıkar). Banka cebi kuralı Kasa'nın kendi kapısında (banka_cebi_yaz)."""
    from evvel_yeni_moduller import acik as _acik
    from evvel_yeni_cekirdek import bugun as _bugun, tl as _tl, kurus as _k
    if tur == "toptanci" and _acik("toptanci"):
        from evvel_yeni_toptanci_api import toptanci_bakiyesi
        tb = toptanci_bakiyesi(cur, tid, _bugun())
        bak = tb["bakiye"]
        if bak:
            raise HTTPException(409, (f"Bu toptancıya {_tl(_k(bak))} borç var" if bak > 0 else f"Bu toptancıdan {_tl(_k(-bak))} alacak var")
                                + " — pasif yapılamaz. Önce Ödeme'den kapat.")
        if tb["bilinmeyen"]:
            raise HTTPException(409, f"Bu toptancının tutarı bilinmeyen {tb['bilinmeyen']} teslimi var — pasif yapılamaz. "
                                     "Önce Toptancılar › Tutar gir, sonra borcu kapat.")
    if tur == "kart" and _acik("kart"):
        from evvel_yeni_kart_api import kart_durumu
        k = next((x for x in kart_durumu(cur) if str(x["id"]) == str(tid)), None)
        borc = (k or {}).get("kullanilan") or ((k or {}).get("son_odeme") or {}).get("kalan") or 0
        so_ = (k or {}).get("son_odeme") or {}
        if so_.get("teyit_gerekli") and (so_.get("ekstre") or (k or {}).get("kullanilan")):   # Fable P2: borçsuz/kullanılmamış kart engellenmez   # Fable: son günü geçmiş ekstre teyit edilmeden borç bilinmez
            raise HTTPException(409, "Bu kartın son ödeme günü geçmiş, ekstre teyit edilmemiş — silinemez. Önce Kartlar'da ekstreyi teyit et.")
        if borc:
            raise HTTPException(409, f"Bu kartta {_tl(_k(borc))} borç var — silinemez. Önce Ödeme › Kart borcu ile öde.")


def _ad(b: TanimBody, zorunlu: bool) -> Optional[str]:
    ad = (b.ad or "").strip()
    if zorunlu and len(ad) < 2:
        raise HTTPException(400, "Ad yaz")
    return ad[:80] or None


@router.post("/{tur}")
def ekle(tur: str, body: TanimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    return _yaz(tur, None, body, x_evvel_oturum)


@router.post("/{tur}/{tid}")
def duzelt(tur: str, tid: str, body: TanimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    return _yaz(tur, tid, body, x_evvel_oturum)


def _yaz(tur: str, tid: Optional[str], b: TanimBody, jeton: Optional[str]):
    if tur not in ("sube", "personel", "kart", "toptanci", "banka"):
        raise HTTPException(404, "Bilinmeyen tanım")
    from evvel_yeni_kasa_api import sube_cepleri_yaz
    from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun, kilit as _kilit, ad_anahtari
    yeni = tid is None
    if tur in ("sube", "banka"):
        from evvel_yeni_kasa_api import kasa_hazirla
        kasa_hazirla()   # E2E #9: sıfırdan kurulumda şube cebi tablosu yoktu (500) — Kasa kendi kısa işleminde hazırlanır
    with db() as (conn, cur):
        tanim_hazirla(cur)
        _kilit(cur)
        kim = _aktor(cur, jeton)
        ad = _ad(b, yeni)
        if tur == "banka":
            from evvel_yeni_kasa_api import banka_cebi_yaz   # cep tablosu Kasa'nın — Tanımlar yazmaz, Kasa'nın kapısını çağırır (F#35)
            tid = banka_cebi_yaz(cur, cid=None if yeni else tid, tur=b.tur, ad=ad, sube_id=b.sube_id, aktif=None if yeni else b.aktif,
                                 slug=_slug(ad) if ad else None)   # B68: 'Pasif yap' yalnız aktif gönderir — ad yok, slug yalnız yeni kayıtta
            return {"ok": True, "id": tid, "mesaj": f"Banka {'eklendi' if yeni else 'güncellendi'}"}

        for o_, ad_ in ((b.pos_oran, "POS oranı"), (b.online_oran, "Online oranı")):
            if o_ is not None and not 0 <= float(o_) <= 100:
                raise HTTPException(400, f"{ad_} 0–100 arası olmalı (yüzde)")   # E2E #16: eksi / %150 sessizce komisyonu 0 yapıyordu
        if b.limit_tutar is not None and _kurus(b.limit_tutar) < 0:
            raise HTTPException(400, "Kart limiti eksi olamaz")
        if not yeni and tur in ("sube", "personel", "kart", "toptanci"):
            cur.execute(f"SELECT 1 FROM ey_{tur} WHERE id=%s", (tid,))
            if not cur.fetchone():
                raise HTTPException(404, "Kayıt bulunamadı")   # E2E #11: olmayan kaydı 'güncellendi' diyordu
        if not yeni and b.aktif is False and tur in ("toptanci", "kart"):
            _pasif_denetle(cur, tur, tid)   # B69: borcu olan toptancı / kart pasif yapılamaz (borç gözden kaybolmasın)
        if tur == "sube":
            if yeni:
                tid = "sube-" + _slug(ad)
                cur.execute("SELECT 1 FROM ey_sube WHERE id=%s", (tid,))
                if cur.fetchone():
                    raise HTTPException(409, "Bu adla şube zaten var")
                cur.execute("""INSERT INTO ey_sube (id, ad, pos_oran, online_oran, degistiren) VALUES (%s,%s,%s,%s,%s)""",
                            (tid, ad, b.pos_oran or 0, b.online_oran or 0, kim))
            else:
                cur.execute("""UPDATE ey_sube SET ad=COALESCE(%s,ad), pos_oran=COALESCE(%s,pos_oran), online_oran=COALESCE(%s,online_oran),
                                 aktif=COALESCE(%s,aktif), degistiren=%s, zaman=NOW() WHERE id=%s""",
                            (ad, b.pos_oran, b.online_oran, b.aktif, kim, tid))
            if b.konum is not None and b.konum.strip():
                lat, lng = _konum_coz(b.konum)
                tanim_guncelle(cur, "ey_sube", tid, {"lat": lat, "lng": lng}, kim=kim)
            if b.yaricap_m is not None:
                if not 30 <= b.yaricap_m <= 2000:
                    raise HTTPException(400, "Yarıçap 30–2000 metre olmalı")
                tanim_guncelle(cur, "ey_sube", tid, {"yaricap_m": b.yaricap_m}, kim=kim)
            sube_cepleri_yaz(cur)   # dükkân nakdi + şube bankası cepleri hemen açılır / adı güncellenir
            if any(x is not None for x in (b.kira, b.kira_artis_ayi, b.kira_odeme_gunu, b.kira_yok)):
                from evvel_yeni_kira_api import kira_yaz
                kira_yaz(cur, tid, kim, b.kira, b.kira_ay, b.kira_artis_ayi, b.kira_odeme_gunu, b.kira_yok)
            return {"ok": True, "id": tid, "mesaj": f"Şube {'eklendi — dükkân nakdi ve banka cebi açıldı' if yeni else 'güncellendi'}"}

        if tur == "personel":
            if b.sube_id and b.sube_id != "ortak":
                cur.execute("SELECT 1 FROM ey_sube WHERE id=%s", (b.sube_id,))
                if not cur.fetchone():
                    raise HTTPException(400, "Şube bulunamadı")
            if b.calisma_turu is not None and b.calisma_turu not in ("tam", "yari"):
                raise HTTPException(400, "Çalışma türü: tam | yari")
            cikis = None
            if b.cikis:
                try:
                    cikis = date.fromisoformat(b.cikis[:10])
                except ValueError:
                    raise HTTPException(400, "Ayrılış tarihi YYYY-AA-GG olmalı")
            giris = None
            if b.giris:
                try:
                    giris = date.fromisoformat(b.giris[:10])
                except ValueError:
                    raise HTTPException(400, "İşe giriş tarihi YYYY-AA-GG olmalı")
            if not yeni and (giris or cikis):
                cur.execute("SELECT giris, cikis FROM ey_personel WHERE id=%s", (tid,))
                _e = dict(cur.fetchone() or {})
                giris_, cikis_ = giris or _e.get("giris"), cikis or _e.get("cikis")
            else:
                giris_, cikis_ = giris, cikis
            if giris_ and cikis_ and cikis_ < giris_:
                raise HTTPException(400, "Ayrılış tarihi işe girişten önce olamaz")   # E2E #16
            if yeni:
                if not giris:   # F4.4 P-2 (sim 27 Eki): boş giriş → maaş ayın başından sayılıyordu (bugün eklenene 27 gün, 28.800 ₺)
                    raise HTTPException(400, "İşe giriş tarihini yaz — maaş o günden sayılır")
                if b.maas is None and b.calisma_turu != "yari":
                    raise HTTPException(400, "Maaşı yaz (0 olabilir)")
                if b.calisma_turu == "yari" and b.saatlik is None and not (_u_ay(b, giris) >= otomatik_saatlik_ayi(cur) and tam_taban(cur, _u_ay(b, giris))):   # B35 · 30 Eki: Kasım'dan otomatik
                    raise HTTPException(400, "Yarı zamanlı için saatlik ücreti yaz")
                tid = "ey-" + uuid.uuid4().hex[:12]
                cur.execute("""INSERT INTO ey_personel (id, ad, sube_id, gorev, giris, cikis, calisma_turu, erken_acilis, yetki_geri_alma, degistiren)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (tid, ad, None if b.sube_id in (None, "", "ortak") else b.sube_id, (b.gorev or "").strip()[:40] or None, giris,
                             cikis, b.calisma_turu or "tam", bool(b.erken_acilis), bool(b.yetki_geri_alma), kim))   # Fable: yeni kayıtta yetki yazılmıyordu
            else:
                cur.execute("""UPDATE ey_personel SET ad=COALESCE(%s,ad),
                                 sube_id=CASE WHEN %s THEN NULL ELSE COALESCE(%s,sube_id) END, gorev=COALESCE(%s,gorev),
                                 giris=COALESCE(%s,giris), cikis=COALESCE(%s,cikis), calisma_turu=COALESCE(%s,calisma_turu),
                                 aktif=COALESCE(%s,aktif), erken_acilis=COALESCE(%s,erken_acilis),
                                 yetki_geri_alma=COALESCE(%s,yetki_geri_alma), degistiren=%s, zaman=NOW() WHERE id=%s""",
                            (ad, b.sube_id == "ortak", None if b.sube_id == "ortak" else b.sube_id,
                             (b.gorev or "").strip()[:40] or None, giris, cikis, b.calisma_turu, b.aktif, b.erken_acilis,
                             b.yetki_geri_alma, kim, tid))
            if b.pin is not None and str(b.pin).strip():
                yp = str(b.pin).strip()
                if not (len(yp) == 4 and yp.isdigit()):
                    raise HTTPException(400, "PIN 4 haneli rakam olmalı")
                tuz = secrets.token_hex(8)
                cur.execute("UPDATE ey_personel SET pin_salt=%s, pin_hash=%s, degistiren=%s, zaman=NOW() WHERE id=%s",
                            (tuz, _pin_hash(tuz, yp), kim, tid))
                cur.execute("DELETE FROM ey_pin_deneme WHERE personel_id=%s", (tid,))
            if any(x is not None for x in (b.maas, b.yemek, b.saatlik, b.yol)):
                ay = (b.ucret_ay or (giris.isoformat() if giris else _bugun().isoformat()))[:7]
                ucret_yaz(cur, personel_id=tid, ay=ay, kim=kim,
                          **{k: (_kurus(getattr(b, k)) if getattr(b, k) is not None else None) for k in ("maas", "yemek", "saatlik", "yol")})
            return {"ok": True, "id": tid, "mesaj": f"Personel {'eklendi' if yeni else 'güncellendi'}"}

        if tur == "kart":
            from evvel_yeni_kart_api import kart_hazirla
            kart_hazirla(cur)
            for g_ in (b.kesim_gunu, b.son_odeme_gunu):
                if g_ is not None and not 1 <= g_ <= 31:
                    raise HTTPException(400, "Kesim / son ödeme günü 1–31 olmalı")
            if yeni:
                tid = "ey-" + uuid.uuid4().hex[:12]
                cur.execute("""INSERT INTO ey_kart (id, ad, banka, kimin, acilis_borc, degistiren, eklenme)
                               VALUES (%s,%s,%s,%s,%s,%s,(NOW() AT TIME ZONE 'Europe/Istanbul')::date)""",
                            (tid, ad, (b.banka or "").strip()[:40] or None, (b.kimin or "").strip()[:40] or None, _kurus(b.acilis_borc or 0), kim))
            else:
                cur.execute("""UPDATE ey_kart SET ad=COALESCE(%s,ad), banka=COALESCE(%s,banka), kimin=COALESCE(%s,kimin),
                                 acilis_borc=COALESCE(%s,acilis_borc), aktif=COALESCE(%s,aktif), degistiren=%s, zaman=NOW() WHERE id=%s""",
                            (ad, (b.banka or "").strip()[:40] or None, (b.kimin or "").strip()[:40] or None,
                             _kurus(b.acilis_borc) if b.acilis_borc is not None else None, b.aktif, kim, tid))
            cur.execute("""UPDATE ey_kart SET limit_tutar=COALESCE(%s,limit_tutar), kesim_gunu=COALESCE(%s,kesim_gunu),
                             son_odeme_gunu=COALESCE(%s,son_odeme_gunu), limit_grup=COALESCE(%s,limit_grup) WHERE id=%s""",
                        (_kurus(b.limit_tutar) if b.limit_tutar is not None else None, b.kesim_gunu, b.son_odeme_gunu,
                         (b.limit_grup or "").strip()[:40] or None, tid))
            return {"ok": True, "id": tid, "mesaj": f"Kart {'eklendi' if yeni else 'güncellendi'}"}

        # toptancı
        if yeni:
            if any(ad_anahtari(x["ad"]) == ad_anahtari(ad) for x in tanim_listesi(cur, "ey_toptanci", ("ad",))):
                raise HTTPException(409, "Bu adla toptancı zaten var")   # E2E #12: "ATA GIDA" ↔ "Ata Gıda" ayrı açılıyordu
            tid = "ey-" + uuid.uuid4().hex[:12]
            cur.execute("""INSERT INTO ey_toptanci (id, ad, kategori, telefon, acilis_bakiye, degistiren) VALUES (%s,%s,%s,%s,%s,%s)""",
                        (tid, ad, (b.kategori or "").strip()[:40] or None, (b.telefon or "").strip()[:20] or None, _kurus(b.acilis_bakiye or 0), kim))
        else:
            cur.execute("""UPDATE ey_toptanci SET ad=COALESCE(%s,ad), kategori=COALESCE(%s,kategori), telefon=COALESCE(%s,telefon),
                             acilis_bakiye=COALESCE(%s,acilis_bakiye), aktif=COALESCE(%s,aktif), degistiren=%s, zaman=NOW() WHERE id=%s""",
                        (ad, (b.kategori or "").strip()[:40] or None, (b.telefon or "").strip()[:20] or None,
                         _kurus(b.acilis_bakiye) if b.acilis_bakiye is not None else None, b.aktif, kim, tid))
        if b.vade_gun is not None:
            if not 0 <= int(b.vade_gun) <= 365:
                raise HTTPException(400, "Vade günü 0–365 olmalı")
            from evvel_yeni_toptanci_api import toptanci_hazirla
            toptanci_hazirla(cur)
            cur.execute("UPDATE ey_toptanci SET vade_gun=%s WHERE id=%s", (int(b.vade_gun), tid))
        return {"ok": True, "id": tid, "mesaj": f"Toptancı {'eklendi' if yeni else 'güncellendi'}"}


# ✂️ 1 KASIM SON AKTARIM (manifest 'kesim') — eski şube / personel / ücret / kart / toptancı tanımlarının SON kopyası (süreç başında bir kez
# çalışan kopya 31 Eki gecesinden önceki son yeniden başlatmada kalmış olabilir). Yalnız eksik kimlik + boş alan; hata YUTULMAZ.
def kesim_dondur(cur, yazan: str, ay: str) -> dict:
    out = {}
    for sp, sql in _eski_kopyalar():
        cur.execute(sql)
        out[sp.replace("sp_ey_k_", "") + "_eslesen"] = cur.rowcount   # UPDATE: eşleşen satır (değişmese de sayılır) · INSERT: eklenen
    return out
