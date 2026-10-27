"""🧾 EVVEL YENİ · ŞUBE PANELİ (sunucu) — tak-çıkar modül "panel" (SUBE_PANELI_TASARIM.md, Fable + Codex + sahip kararları).

Sahip: "Yeni Şube Paneli" — sıfırdan; eski panele / eski tablolara bağ YOK. Personel aynı akışı görür, altta her işlem
Evvel Yeni'nin MEVCUT defterlerine yazar (yeni tablo yok):
  · ham olay → ey_sube_olay (Olay modülü `olay_yaz`)       · para → Kasa `kasa_yaz` (kapanış / teslim)
  · stok     → Depo `hareket_yaz` / `sayim_yaz` (ey_urun)   · ürün kimliği = yeni katalog (ey_urun)
Tek işlem: bir düğmenin yazdığı her şey ya hep birlikte yazılır ya hiç (hata → "Kaydedilemedi, tekrar deneyin").
Tekrar gönderim (istek_id / kaynak_ref) ikinci kez yazılmaz.

DENEME MODU: `ey_ayar.panel_baslangic` (varsayılan 2026-11-01) gelmeden panel KAYDETMEZ — her şeyi doğrular, ne yazacağını
gösterir, işlemi geri alır ("kuru"). Böylece 1 Kasım öncesi canlı defterler kirlenmeden denenir.
Uyarılar personele GİTMEZ (sahip): eksi stok, fiyatı eksik ürün vb. yalnız merkez Bekleyen işler'e.
Faz 1: açılış · kapanış · kasa devri · ara teslim · ürün aç · fire. (Teslim al / depodan gelen / anlık gider: faz 2.)
"""

import json
import logging
import re
import uuid

import psycopg2.errors
from datetime import date, timedelta
from decimal import Decimal

from evvel_yeni_cekirdek import TrTutar   # para alanı: Türkçe tutar kuralı (E2E #10)
from evvel_yeni_cekirdek import tl as _tl_tr   # Türkçe para biçimi TEK yer (f-string içinde iç içe tırnak YOK — canlı Python 3.11)
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from database import db, savepoint
from evvel_yeni_urun_api import tezgahta_sayilir   # TEK 'tezgahta sayılır' kuralı (Dalga 4, F#7)
from evvel_yeni_olay import panel_kok   # kök biçimi tek yerde (K9)
from evvel_yeni_cekirdek import merkez_aktor
from evvel_yeni_cekirdek import bekleyen_is_kaydet, deneme_mi, is_gunu as _bugun, kurus as _kurus   # şube İŞ GÜNÜ (gece 02:00'ye kadar önceki gün)

router = APIRouter(prefix="/api/evvel-yeni/panel", tags=["evvel-yeni-panel"])
log = logging.getLogger(__name__)
from evvel_yeni_kasa_api import TESLIM_HEDEFLERI as _TH   # TEK liste Kasa'da (C-T1-34; Fethi → geçiş hesabı)
TESLIM_ALANLAR = tuple(_TH.values())     # sahip kararı: teslim yalnız Onur / Fethi / Fatma
KIM = "şube paneli"


from evvel_yeni_cekirdek import KuruGeriAl as _Kuru   # deneme modunda geri al (sonuç taşır) — Depo ile ortak (F#21)


def _baslangic(cur, sube_id: Optional[str] = None) -> date:
    """Şubenin gerçek kayda geçtiği iş günü (🧪 pilot şubede pilot günü) — sube_id verilmezse en erken başlayan şube (merkez işleri)."""
    from evvel_yeni_cekirdek import en_erken_baslangic, sube_baslangic
    return sube_baslangic(cur, sube_id) if sube_id else en_erken_baslangic(cur)


def _sube(cur, sube_id: str) -> dict:
    from evvel_yeni_tanim_api import subeler
    s = next((x for x in subeler(cur) if str(x["id"]) == str(sube_id)), None)
    if not s:
        raise HTTPException(404, "Şube bulunamadı")
    return s


def _yoklama():
    """Yumuşak bağ: yoklama modülü yüklüyse PUBLIC servisleri; değilse None (panel yoklamasız çalışır)."""
    from evvel_yeni_moduller import acik as _acik
    if not _acik("yoklama"):
        return None
    import evvel_yeni_yoklama_api as y
    return y


def _qr_gerekli(cur, sube_id: Optional[str] = None) -> bool:
    """QR kapısı: yoklama yüklü + şubenin deneme dönemi bitti (panel_baslangic / 🧪 pilot). Denemede kapı uyarı olarak görünür, engel olmaz."""
    from evvel_yeni_cekirdek import yeni_donem
    return _yoklama() is not None and yeni_donem(cur, sube_id=sube_id)


def _personel(cur, sube_id: str, pid: Optional[str], kapi: bool = True, gun=None) -> dict:
    """Ad seçimi (sahip: yetki fazına kadar PIN yok). Her kayıt personel kimliği taşır."""
    from evvel_yeni_tanim_api import secim_listeleri
    if not pid:
        raise HTTPException(400, "Adını seç")
    p = next((x for x in secim_listeleri(cur)["personel"] if str(x["id"]) == str(pid) and x["aktif"]), None)
    if not p:
        raise HTTPException(400, "Personel bulunamadı")
    if __import__("evvel_yeni_tanim_api").ayrildi_mi(p.get("cikis"), gun or _bugun()):   # S-B7: Tanımlar TEK kural
        raise HTTPException(400, "Bu personelin ayrılış tarihi geçti — merkeze haber ver")
    y = _yoklama()
    # sahip (2026-10-19): "bütün personeller bütün şubelere gider" — QR'la BU şubeye girmiş olan (deneme döneminde de) burada çalışır
    burada = y is not None and (
        y.acik_mi(cur, sube_id, str(p["id"])) if kapi
        else y.girdi_mi(cur, sube_id, str(p["id"]), gun or _bugun()))   # K11: QR'la bu şubeye girmiş (kapanış: o gün girmiş)
    if str(p.get("sube_id") or "") != str(sube_id) and not burada:   # Codex: QR'sız başka şubenin personeli bu şubeye yazamasın
        raise HTTPException(400, "Önce bu şubeye telefonundan QR ile giriş yap")
    if kapi and y is not None and _qr_gerekli(cur, sube_id) and not y.acik_mi(cur, sube_id, str(p["id"])):   # K: panel ad listesi = bugün girenler
        raise HTTPException(400, "Önce telefonundan QR ile giriş yap")
    return {"id": str(p["id"]), "ad": p["ad"], "erken_acilis": bool(p.get("erken_acilis"))}


def _pin(cur, p: dict, pin: Optional[str]) -> None:
    """Sık işlem (ürün aç, fire, ara teslim…): QR ile girmiş kişi + kendi 4 haneli PIN'i (sahip R1b). Doğrulama Tanımlar'da."""
    from evvel_yeni_tanim_api import pin_dogrula
    pin_dogrula(cur, p["id"], pin)


def _tam(v, ad: str) -> int:
    """Tam sayı adet (kesir / eksi yok) — çekirdek adet_oku TEK kural (Dalga 4, F#17)."""
    from evvel_yeni_cekirdek import adet_oku
    return adet_oku(v, ad)


def _tl(v, ad: str) -> int:
    try:
        k = _kurus(v if v not in (None, "") else 0)
    except HTTPException:
        raise HTTPException(400, f"{ad}: tutarı yaz")
    if k < 0:
        raise HTTPException(400, f"{ad}: eksi olamaz")
    return k


def _urunler(cur, idler: List[str], takip: Optional[str] = None, pasif_olur: bool = False) -> dict:
    """takip verilirse ürün o takip türünde olmalı (Codex: sayım = 'sayim'). pasif_olur: Ürün Aç "Pasifleri göster" (eski panel)."""
    from evvel_yeni_urun_api import urun_bilgi
    b = urun_bilgi(cur, idler)
    for i in idler:
        if i not in b or (not b[i]["aktif"] and not pasif_olur):
            raise HTTPException(400, "Ürün bulunamadı — listeyi yenileyin")
        if takip and (b[i].get("takip") or "sayim") != takip:
            raise HTTPException(400, f"{b[i]['ad']}: bu listede yok — listeyi yenileyin")
        if takip == "sayim" and not tezgahta_sayilir(b[i]):
            raise HTTPException(400, f"{b[i]['ad']}: sayım listesinde yok — listeyi yenileyin")
    return b


ACILIS_SAAT = (7, 0)       # sahip D10: 07:00'den önce açılış ENGELLENİR (kişiye özel erken açılış izni hariç)
KAPANIS_SAAT = (22, 30)    # sahip D10: 22:30'dan önce kapanış ENGELLENİR
# 🔥 FIRE SEBEP KARTLARI — TEK yer (sahip 20 Eki: "burayı sen yeniden tasarlayabilirsin"; Fable fire denetimi). Eski 9 kart → 8:
# 'Yanlış ürün' + 'Hazırlık/deneme' TEK kart (alt seçimle), 'Sipariş iptali' / 'Panel hatası' kalktı (eski ekranda kartı yoktu).
# oneri = ürün adımında ÖNCE gösterilen katalog grupları (kategori adı; '__bardak__' = bardak işaretli ürünler) — sabit ürün kodu YOK
# (eski 'fincan kahve' karosu depodan PAKET kahve düşürüyordu). Ekran bu listeyi /durum'dan okur.
FIRE_SEBEP_LISTE = [
    {"kod": "kirilma_dokulme", "ad": "Kırıldı / döküldü", "ikon": "💔", "oneri": ["__bardak__", "Sütler", "Şuruplar", "Soslar", "Püreler", "İçecekler"]},
    {"kod": "skt_bozulma", "ad": "Bozuldu / tarihi geçti", "ikon": "🟡", "oneri": ["Pastalar", "Sütler", "Püreler", "Şuruplar", "İçecekler"]},
    {"kod": "iade", "ad": "Müşteri iadesi", "ikon": "↩️", "oneri": ["Pastalar", "İçecekler", "__bardak__"]},
    {"kod": "hazirlik_deneme", "ad": "Hatalı hazırlık / deneme", "ikon": "🔄", "oneri": ["__bardak__", "Kahveler", "Sütler", "Şuruplar"]},
    {"kod": "personel_kullanim", "ad": "Personel kullanımı", "ikon": "👤", "oneri": ["İçecekler", "__bardak__", "Sütler", "Pastalar"]},
    {"kod": "ikram", "ad": "İkram", "ikon": "🎁", "oneri": ["Pastalar", "İçecekler", "__bardak__"]},
    {"kod": "sayim_hatasi", "ad": "Sayım düzeltmesi (eksik çıktı)", "ikon": "🔢", "oneri": [],
     "not": "Yalnız eksiği düzeltir — fazla çıkanı merkez sayar. Gidere girmez."},
    {"kod": "diger", "ad": "Diğer", "ikon": "❓", "oneri": [], "not": "Ne olduğunu en az 10 harfle yaz."},
]
FIRE_SEBEPLERI = {x["kod"]: x["ad"] for x in FIRE_SEBEP_LISTE}


def _fire_sebepleri(kategoriler) -> list:
    """Ekrana: öneri grupları kategori KİMLİĞİ olarak (Fable D6-S: adla eşleme katalogda ad değişince sessizce boşalıyordu).
    '__bardak__' olduğu gibi; katalogda bulunmayan ad uyarı olarak loglanır (ekranda o grup yalnız görünmez)."""
    from evvel_yeni_cekirdek import ad_anahtari
    idx = {ad_anahtari(k.get("ad")): str(k.get("id")) for k in kategoriler if k.get("aktif", True)}
    out = []
    for x in FIRE_SEBEP_LISTE:
        ids = []
        for o in x["oneri"]:
            if o == "__bardak__":
                ids.append(o)
            elif ad_anahtari(o) in idx:
                ids.append(idx[ad_anahtari(o)])
            else:
                log.warning("fire önerisi: '%s' kategorisi katalogda yok", o)
        out.append({**x, "oneri": ids})
    return out
IADE_SEBEPLERI = {"begenmedi": "Beğenmedi", "sicaklik": "Sıcaklık / ısı", "yanlis_verildi": "Yanlış ürün verildi",
                  "yabanci_madde": "Yabancı madde", "bekleme": "Uzun bekleme", "hasar": "Hasar / ambalaj"}   # eski 6 kart (eski sunucu ATIYORDU)
HAZIRLIK_TURLERI = {"yanlis_urun": "Yanlış ürün yapıldı", "bardak_degisti": "Bardak / boy değişti", "deneme": "Deneme / eğitim"}
# fire DIŞI çıkışlar ayrı konuma gider (maliyet raporunda ayrı satır — sahip D9; iade ayrı satır — sahip 20 Eki)
FIRE_HEDEF = {"ikram": "dışarı:ikram", "personel_kullanim": "dışarı:personel", "sayim_hatasi": "dışarı:sayim", "iade": "dışarı:iade"}


from evvel_yeni_cekirdek import simdi_tr as _simdi_tr, tr_saat as _saat_tr   # Dalga 4 (F#4): saat biçimi TEK yerde — çekirdek


def _saat_kurali(tur: str, personel: dict) -> Optional[str]:
    """Açılış / kapanış saat kuralı (iş günü saatiyle). Engelse mesaj döner."""
    n = _simdi_tr()
    hm = (n.hour, n.minute)
    if tur == "acilis" and hm < ACILIS_SAAT and not personel.get("erken_acilis"):
        return (f"Açılış onayı yalnızca {ACILIS_SAAT[0]:02d}:{ACILIS_SAAT[1]:02d} ve sonrasında yapılabilir (Türkiye saati). "
                "Bu personelin erken açılış izni yok — izin merkezden verilir.")
    if tur == "kapanis" and 2 <= n.hour and hm < KAPANIS_SAAT:
        return f"Kapanış {KAPANIS_SAAT[0]:02d}:{KAPANIS_SAAT[1]:02d}'dan önce yapılamaz"   # sınır TEK sabitte (K10)
    return None


def _gun_kapali(cur, sube_id: str, gun) -> bool:
    """Bugünün kapanışı yapıldıysa gün kapalıdır (D7): ürün aç / fire / ara teslim / kasa devri yazılmaz."""
    from evvel_yeni_olay import gun_kapandi
    return gun_kapandi(cur, sube_id, gun)   # Olay'ın kapısı (F#11)


def _gun_acik_mi(cur, c: dict, sube_id: str) -> None:
    if not c.get("merkez") and _gun_kapali(cur, sube_id, c["gun"]):
        raise HTTPException(409, "Gün kapandı — bu işlem yapılamaz")
    if not c.get("merkez"):
        a = _ara_sayim_guncelle(cur, sube_id, c["gun"])
        if a and a["durum"] in ARA_AKTIF:   # ⏱ ara sayım: 15 dk kilit — sık işlem uçları da bekler (A5; Fable: isleniyor/hata dahil)
            raise HTTPException(409, "⏱ Ara kasa sayımı bekliyor — önce çekmeceyi say ve telefonla onayla")


# ─────────────── 🛟 KAPANIŞ KAYBOLMASIN (Zafer 16 Ekim dersi; sahip: "gönderdim sandı ama gelmedi — bunu atlama") ───────────────
# Her gönderim, asıl işlemden ÖNCE ayrı bağlantıyla ey_panel_deneme'ye yazılır (ham gövde); sonuç / ret SEBEBİ sonra ayrı
# bağlantıyla işlenir → asıl işlem geri alınsa da deneme kalır. Reddedilen / hata veren kapanış merkez Bekleyen işler'e
# "Geç kapanış olarak işle" diye düşer; merkez tek tıkla, personelin girdiği verilerle o iş gününe işler.
_DENEME_HAZIR = False


def _deneme_hazirla() -> None:
    global _DENEME_HAZIR
    if _DENEME_HAZIR:
        return
    with db() as (_c, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012045)")
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_panel_deneme (
            id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, tur TEXT NOT NULL, is_gunu DATE NOT NULL, istek_id TEXT, personel_id TEXT,
            govde JSONB NOT NULL DEFAULT '{}'::jsonb, sonuc TEXT NOT NULL DEFAULT 'bekliyor', sebep TEXT,
            zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), islendi BOOLEAN NOT NULL DEFAULT FALSE, isleyen TEXT)""")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_panel_deneme ON ey_panel_deneme (tur, sonuc, zaman)")
        # Basamak 3: uyarılı kapanış → merkez Bekleyen işler "⚠ Kapanış uyarılı — Gördüm" (Kasa'daki eski panel satırıyla AYNI biçim)
        cur.execute("ALTER TABLE ey_panel_deneme ADD COLUMN IF NOT EXISTS uyarilar JSONB")
        cur.execute("ALTER TABLE ey_panel_deneme ADD COLUMN IF NOT EXISTS goruldu TEXT")
    _DENEME_HAZIR = True


def _kapanis_govde_ozet(govde) -> Optional[str]:
    """Personelin kapanış formundaki rakamlar tek satır (merkez Bekleyen işler 'geç kapanış' satırı — kendini anlatsın)."""
    g = govde if isinstance(govde, dict) else {}
    if not any(g.get(k) not in (None, "") for k in ("nakit", "pos", "online", "kor_sayim", "birakilan")):
        return None   # gövde yok / bozuk → satır yazılmaz
    try:
        def t(k):
            v = g.get(k)
            return None if v in (None, "") or not _tl(v, k) else _tl_tr(_tl(v, k))   # sıfır yazılmaz (online 0 ₺ gürültü)
        tes = [x for x in (g.get("teslimler") or []) if isinstance(x, dict) and x.get("tutar") not in (None, "") and _tl(x.get("tutar"), "Teslim")]
        par = [f"nakit {t('nakit') or '0 ₺'}", f"POS {t('pos') or '0 ₺'}"]
        if t("online"):
            par.append(f"online {t('online')}")
        if t("kor_sayim"):
            par.append(f"çekmece {t('kor_sayim')}")
        if tes:
            _ad = {c: a for a, c in _TH.items()}   # ev:onur → Onur (ham kimlik yazılmasın)
            par.append("teslim " + ", ".join(f"{_ad.get(x.get('alan'), x.get('alan'))} {_tl_tr(_tl(x.get('tutar'), 'Teslim'))}" for x in tes))
        if t("birakilan"):
            par.append(f"bırakılan {t('birakilan')}")
        return " · ".join(par)
    except Exception:  # noqa: BLE001 — bilgi satırı; bozuk gövde listeyi düşürmez
        return None


def _deneme_ac(sube_id: str, tur: str, gun, govde: dict) -> Optional[str]:
    try:
        _deneme_hazirla()
        did = str(uuid.uuid4())
        with db() as (_c, cur):
            cur.execute("""INSERT INTO ey_panel_deneme (id, sube_id, tur, is_gunu, istek_id, personel_id, govde)
                           VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                        (did, str(sube_id), tur, gun, govde.get("istek_id"), govde.get("personel_id") or govde.get("devreden_id"),
                         json.dumps(govde, ensure_ascii=False, default=str)))
        return did
    except Exception as e:  # noqa: BLE001 — Codex: deneme yazılamazsa işlem YAPILMAZ (iz garantisi); tablet kuyruğu tekrar dener
        log.error("panel denemesi yazılamadı (%s %s): %s", sube_id, tur, str(e)[:200])
        raise HTTPException(503, "Kaydedilemedi — tekrar deneyin")


def _deneme_kapat(did: Optional[str], sonuc: str, sebep: Optional[str] = None, uyarilar: Optional[list] = None) -> None:
    if not did:
        return
    try:
        with db() as (_c, cur):
            cur.execute("UPDATE ey_panel_deneme SET sonuc=%s, sebep=%s, uyarilar=%s::jsonb WHERE id=%s",
                        (sonuc, (sebep or "")[:300] or None, json.dumps(uyarilar, ensure_ascii=False) if uyarilar else None, did))
    except Exception as e:  # noqa: BLE001
        log.error("panel denemesi sonucu yazılamadı (%s): %s", did, str(e)[:200])


def _calistir(sube_id: str, istek_id: Optional[str], is_fn, tur: Optional[str] = None, govde: Optional[dict] = None,
              gun=None, merkez: Optional[str] = None, isle_deneme: Optional[str] = None) -> dict:
    """Ortak iskelet: deneme kaydı → hazırlık → tek işlem → (deneme modunda geri al) → deneme sonucu.
    gun/merkez: yalnız merkezin 'geç kapanış' işlemi (o iş gününe; saat kuralı ve gün kilidi uygulanmaz)."""
    gun0 = gun or _bugun()
    govde = {k: v for k, v in (govde or {}).items() if k != "pin"}   # PIN asla saklanmaz
    ig = govde.get("istemci_gunu")
    if not merkez and ig:   # Codex: tablette kalıp gün değiştikten sonra gelen kayıt yanlış güne yazılmasın → deneme o güne, ret
        try:
            from datetime import date as _d
            igd = _d.fromisoformat(str(ig)[:10])
        except ValueError:
            igd = gun0
        if igd != gun0:
            did = _deneme_ac(sube_id, tur, igd, govde or {}) if tur else None
            _deneme_kapat(did, "ret", f"gün değişti — tablette {igd.isoformat()} günü girilmişti")
            raise HTTPException(409, "Gün değişti — bu kayıt merkeze iletildi")
    did = _deneme_ac(sube_id, tur, gun0, govde or {}) if tur and not merkez else None   # Fable: merkez koşusu yeni deneme açmaz
    try:
        sonuc = _calistir_ic(sube_id, istek_id, is_fn, gun, merkez, isle_deneme)
    except HTTPException as e:
        _deneme_kapat(did, "ret" if e.status_code < 500 else "hata", str(e.detail))
        raise
    except Exception as e:  # noqa: BLE001
        _deneme_kapat(did, "hata", str(e)[:300])
        raise
    mu = sonuc.pop("merkez_uyarilari", None)   # sahip: kasa uyarısı panele / telefona GİTMEZ — yalnız merkez kaydına
    mu = sonuc.get("uyarilar") if mu is None else mu
    _deneme_kapat(did, "deneme" if sonuc.get("kuru") and not sonuc.get("kalici") else ("ok_uyarili" if mu else "ok"), uyarilar=mu)
    if merkez and isle_deneme and mu and not sonuc.get("kuru"):   # Codex P2-3: geç kapanış uyarısı Bekleyen işler'e
        _deneme_kapat(isle_deneme, "ok_uyarili", f"geç kapanış merkezde işlendi · {merkez}", uyarilar=mu)
    return sonuc


def _calistir_ic(sube_id: str, istek_id: Optional[str], is_fn, gun=None, merkez: Optional[str] = None,
                 isle_deneme: Optional[str] = None) -> dict:
    """Hazırlık → tek işlem → (deneme modunda geri al). is_fn(cur, ctx) yazar ve özet döner."""
    if istek_id is not None:
        __import__("evvel_yeni_cekirdek").istek_dogrula(istek_id)   # TEK kural (F#15) — '#', '%', '_' ref çakışması üretmesin
    from evvel_yeni_depo_api import depo_hazirla
    from evvel_yeni_kasa_api import kasa_hazirla
    from evvel_yeni_olay import olay_tablosu_kur
    from evvel_yeni_urun_api import katalog as _katalog_hazir
    kasa_hazirla()
    olay_tablosu_kur()
    with db() as (_c, hc):   # Codex: tablo hazırlıkları ANA işlemin dışında (deneme geri alınca hazır bayrağı yalan kalmasın)
        _katalog_hazir(hc)
        depo_hazirla(hc)
        if _modul_acik("toptanci"):   # Fable: Toptancı tabloları da ana işlemin DIŞINDA (deneme geri alınca hazır bayrağı yalan kalmasın)
            from evvel_yeni_toptanci_api import toptanci_hazirla
            toptanci_hazirla(hc)
    try:
        with db() as (conn, cur):
            g = gun or _bugun()
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_gun:{sube_id}:{g.isoformat()}",))
            ctx = {"gun": g, "sube": _sube(cur, sube_id), "kuru": deneme_mi(cur, g, sube_id), "merkez": merkez}
            sonuc = is_fn(cur, ctx)
            if isle_deneme and not ctx["kuru"]:   # Codex: geç kapanış ile 'işlendi' işareti AYNI işlemde (yarıda kalmaz)
                cur.execute("UPDATE ey_panel_deneme SET islendi=TRUE, isleyen=%s WHERE id=%s", (merkez, isle_deneme))
            sonuc = {"ok": True, "kuru": ctx["kuru"], "kalici": bool(ctx.get("kalici")), **sonuc}
            if ctx["kuru"] and not ctx.get("kalici"):   # sahip D2 (S5): stok yazmayan sipariş talebi/hazırlığı denemede de kalır
                raise _Kuru(sonuc)
            return sonuc
    except _Kuru as k:
        return {**k.sonuc, "mesaj": "DENEME — kaydedilmedi (panel henüz açılmadı)" + (f" · gerçekte: {k.sonuc['saat_engeli']}" if k.sonuc.get("saat_engeli") else "")}


# ─────────────────────────── OKUMA ───────────────────────────
@router.get("/{sube_id}/durum")
def panel_durum(sube_id: str):
    """Panelin açılışta ihtiyacı olan her şey: şube, personel, sayılacak / açılacak ürünler, bugün yapılanlar."""
    from evvel_yeni_olay import olay_tablosu_kur, olaylar
    from evvel_yeni_tanim_api import secim_listeleri
    from evvel_yeni_urun_api import katalog
    olay_tablosu_kur()
    with db() as (conn, cur):
        s = _sube(cur, sube_id)
        gun = _bugun()
        sl = secim_listeleri(cur)   # K13: aynı istekte iki kez çağrılıyordu
        per = [{"id": str(p["id"]), "ad": p["ad"]} for p in sl["personel"]
               if p["aktif"] and str(p.get("sube_id") or "") == str(sube_id)]
        kat_hepsi = katalog(cur, hepsi=True)   # Fable: tek sorgu — aktif liste bundan süzülür
        toptancilar = [{"id": str(t["id"]), "ad": t["ad"], "kategori": t.get("kategori")} for t in sl.get("toptancilar") or []]
        kat = [{**k, "urunler": [x for x in k["urunler"] if x.get("aktif", True)]} for k in kat_hepsi if k.get("aktif", True)]
        bugunku = [{"id": o["id"], "tur": o["tur"], "zaman": str(o["olay_zamani"])[11:16], "kim": o.get("personel_ad"),
                    "iptal": o.get("iptal", False)}
                   for o in olaylar(cur, sube_id=sube_id, bas=gun, son=gun) if (o.get("kaynak_tablo") or "") == "panel"]
        bas = _baslangic(cur, sube_id)
        ara = _ara_durum(cur, sube_id, gun)   # bağlantı AÇIKKEN (yanıt sözlüğü işlem kapandıktan sonra kuruluyor)
        y = _yoklama()
        yok = {"var": y is not None, "qr_gerekli": False, "girenler": [], "son_okutanlar": [], "tablet_kayitli": False}
        if y is not None:
            yok["qr_gerekli"] = gun >= bas
            yok["girenler"] = y.bugun_girenler(cur, str(sube_id), gun)
            yok["son_okutanlar"] = y.son_okutanlar(cur, str(sube_id), 120)
            yok["tablet_kayitli"] = y.tablet_kayitli(cur, str(sube_id))   # Yoklama'nın kapısı (F#26)
            yok["devir"] = y.devir_durum(cur, str(sube_id), gun)
            yok["kapanis_sorumlusu"] = y.kapanis_sorumlusu(cur, str(sube_id), gun)
            if yok["qr_gerekli"]:   # ad listesi = bu şubede QR'la girmiş olanlar (K11: başka şubenin personeli dahil)
                per = [{"id": g["personel_id"], "ad": g["ad"]} for g in yok["girenler"] if g["acik"]]
        avans_elden = []
        if _modul_acik("avans"):   # 🤝 bu şubeden elden verilecek onaylı avanslar (yumuşak bağ)
            try:
                with savepoint(cur, "sp_panel_avans"):
                    from evvel_yeni_avans_api import elden_bekleyen
                    avans_elden = [{"id": t["id"], "ad": t["ad"], "tutar": t["tutar"]} for t in elden_bekleyen(cur, str(sube_id))]
            except Exception:  # noqa: BLE001
                log.warning("panel durum: avans okunamadı", exc_info=True)
        depo_acik, depo_yolda, depo_mu = _modul_acik("depo"), [], False
        if depo_acik:   # Basamak 5 (Fable F3/F6): gelen paketler (ADET YOK — kör sayım) + Tema depo bayrağı; yumuşak bağ
            try:
                with savepoint(cur, "sp_panel_depo"):
                    from evvel_yeni_depo_api import yoldakiler
                    from evvel_yeni_tanim_api import depo_sube_id   # depo bayrağı Tanımlar'ın PUBLIC'i (F#28 — Depo'nun özel fonksiyonu değil)
                    depo_yolda = yoldakiler(cur, str(sube_id))
                    depo_mu = depo_sube_id(cur) == str(sube_id)
            except Exception:  # noqa: BLE001
                log.warning("panel durum: depo okunamadı", exc_info=True)
        gonderilecek_sayi = 0
        if depo_mu and _modul_acik("siparis"):   # D1 (sim 24 Eki): Tema menüsünde 'Gönderilecek' rozeti yoktu — depocu barda iken işi göremiyordu
            try:
                with savepoint(cur, "sp_panel_gonderilecek"):
                    gonderilecek_sayi = sum(len(g["kalemler"]) for g in _siparis().gonderilecek(cur, str(sube_id)))
            except Exception:  # noqa: BLE001
                log.warning("panel durum: gönderilecek okunamadı", exc_info=True)
        # ⑥ SON TESLİM / KABUL (eski ana sayfa kartı, S11-3 KALIR): son 3 gün tedarikçi teslimi + depodan kabul — olay defterinden, ADETSİZ
        son_teslimler, geri_refler = [], set()
        for o in olaylar(cur, sube_id=sube_id, bas=gun - timedelta(days=2), son=gun, turler={"teslim_al", "depo_kabul", "teslim_geri_al"}):
            if (o.get("kaynak_tablo") or "") != "panel" or o.get("iptal"):
                continue
            v = o.get("veri") or {}
            v = json.loads(v) if isinstance(v, str) else v
            if o["tur"] == "teslim_geri_al":
                geri_refler.add(v.get("teslim_ref"))
                continue
            son_teslimler.append({"gun": o["is_gunu"].isoformat(), "saat": str(o["olay_zamani"])[11:16], "kim": o.get("personel_ad"), "kok": o.get("kok"),
                                  "ne": (f"🚚 {v.get('toptanci_ad') or 'Tedarikçi'} · {len(v.get('kalemler') or [])} kalem" if o["tur"] == "teslim_al"
                                         else f"📦 Depodan paket · {len(v.get('satirlar') or [])} ürün")})
        if _modul_acik("toptanci"):   # Codex 22 Eki: merkezin iptal ettiği teslim de işaretli (geri alma olayı yalnız şubeninkinde var)
            try:
                with savepoint(cur, "sp_panel_iptal_ref"):
                    geri_refler |= __import__("evvel_yeni_toptanci_api").iptal_teslim_refleri(cur, gun - timedelta(days=2), gun)
            except Exception:  # noqa: BLE001
                log.warning("panel durum: iptal teslimler okunamadı", exc_info=True)
        son_teslimler = [{**{k: x[k] for k in ("gun", "saat", "kim", "ne")}, "geri": x["kok"] in geri_refler}
                         for x in sorted(son_teslimler, key=lambda z: (z["gun"], z["saat"]), reverse=True)[:8]]
        siparis_red = []
        if _modul_acik("siparis"):   # ④ reddedilen sipariş talepleri (son 7 gün, merkezin iptali) — yumuşak bağ
            try:
                with savepoint(cur, "sp_panel_sip_red"):
                    siparis_red = __import__("evvel_yeni_siparis_api").sube_redleri(cur, str(sube_id))
            except Exception:  # noqa: BLE001
                log.warning("panel durum: sipariş redleri okunamadı", exc_info=True)
        teslimler_bugun = []
        if _modul_acik("toptanci"):   # S9: bugün alınan tedarikçi teslimleri — "Hatalı? Geri al" listesi (yumuşak bağ; tutar yok)
            try:
                with savepoint(cur, "sp_panel_teslimler"):
                    from evvel_yeni_toptanci_api import panel_teslimleri
                    teslimler_bugun = panel_teslimleri(cur, str(sube_id), gun)
            except Exception:  # noqa: BLE001
                log.warning("panel durum: teslimler okunamadı", exc_info=True)
    def _u(x):
        return {"id": x["id"], "ad": x["ad"], "birim": x["birim"], "koli_ici": x.get("koli_ici"),
                "bardak": __import__("evvel_yeni_urun_api").bardak_mi(x["ad"])}   # TEK bardak kuralı (F#9) — ekran tahmin etmez
    return {"sube": {"id": s["id"], "ad": s["ad"], "depo": depo_mu}, "depo_acik": depo_acik, "depo_yolda": depo_yolda, "gonderilecek_sayi": gonderilecek_sayi, "avans_elden": avans_elden, "gun": gun.isoformat(), "kuru": gun < bas, "panel_baslangic": bas.isoformat(),
            "personel": per, "teslim_alanlar": [{"id": c, "ad": a} for a, c in _TH.items()],
            "sayilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if tezgahta_sayilir(x)]}
                        for k in kat],
            "acilan": [{"kategori": k["ad"], "urunler": [_u(x) for x in k["urunler"] if x.get("takip") == "acilinca"]} for k in kat],
            # Basamak 5 Ürün Aç: BÜTÜN katalog (aktif kategoriler; ürünlerde aktif bayrağı — "Pasifleri göster")
            "ac_katalog": [{"id": str(k.get("id")), "kategori": k["ad"], "emoji": k.get("emoji"),
                            # Codex P1: pasta (gununde) BURADAN atılmaz — Tedarikçiden teslim + Sipariş ver aynı listeyi kullanır (pasta seçilemiyordu).
                            # Ürün Aç ekranı 'gununde'yi kendisi gizler; sunucu da açmayı reddeder (girişte tüketildi).
                            "urunler": [{**_u(x), "takip": x.get("takip") or "sayim", "aktif": bool(x.get("aktif", True))} for x in k["urunler"]]}
                           for k in kat_hepsi if k.get("aktif", True)],
            "bugun": bugunku, "yoklama": yok,
            "ara_sayim": ara,   # ⏱ yalnız BEKLİYORKEN (plan saati / fark ASLA dönmez — kör)
            # gün çizgisi (eski ana sayfa ①): AÇILIŞ · KAPANIŞ — kim, saat (KONTROL noktası yok: sahip istisnası 10)
            "gun_cizgisi": {t: next(({"kim": o["kim"], "saat": o["zaman"]} for o in bugunku if o["tur"] == t and not o["iptal"]), None)
                            for t in ("acilis", "kapanis")},
            "acilis_var": any(o["tur"] == "acilis" and not o["iptal"] for o in bugunku),
            "kapanis_var": any(o["tur"] == "kapanis" and not o["iptal"] for o in bugunku),
            "kapanis_merkezde": _merkezde_mi(sube_id, gun),   # Fable B5: telefonsuz merkeze gönderildi (panel aynı geceyi yeniden doldurmasın)
            "fire_sebepleri": _fire_sebepleri(kat_hepsi),
            "iade_sebepleri": [{"kod": k, "ad": v} for k, v in IADE_SEBEPLERI.items()],
            "hazirlik_turleri": [{"kod": k, "ad": v} for k, v in HAZIRLIK_TURLERI.items()],
            "toptancilar": toptancilar, "teslimler_bugun": teslimler_bugun, "son_teslimler": son_teslimler, "siparis_red": siparis_red, "toptanci_acik": _modul_acik("toptanci"), "siparis_acik": _modul_acik("siparis"),   # Basamak 8: Tedarikçiden teslim al (yumuşak bağ)
            "saat": {"acilis": "%02d:%02d" % ACILIS_SAAT, "kapanis": "%02d:%02d" % KAPANIS_SAAT}}


def _merkezde_mi(sube_id: str, gun) -> Optional[str]:
    """Bugün telefonsuz 'Merkeze gönder' yapıldı ve henüz işlenmedi mi → gönderim saati (yoksa None)."""
    try:
        with db() as (_c, cur):
            if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_panel_deneme"):
                return None
            cur.execute("""SELECT zaman FROM ey_panel_deneme WHERE sube_id=%s AND is_gunu=%s AND tur='kapanis' AND sonuc='ret'
                             AND sebep LIKE 'Telefonsuz%%' AND NOT islendi ORDER BY zaman DESC LIMIT 1""", (str(sube_id), gun))
            r = cur.fetchone()
            return _saat_tr(dict(r)["zaman"]) if r else None
    except Exception:  # noqa: BLE001
        return None




# ─────────────────────────── YAZMA ───────────────────────────
class SayimSatir(BaseModel):
    urun_id: str
    sayilan: Optional[Decimal] = None


class AcilisBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    kasa_sayim: TrTutar                      # sabah kasadaki nakit (TL)
    sayim: List[SayimSatir] = []             # sayılan ürünler (boş bırakılan SAYILMAZ)
    pasta_toplam: Optional[Decimal] = None   # sahip: pasta yalnız TOPLAM adet (eski panel "Pasta adedi")
    istek_id: Optional[str] = None


def _olay(cur, **kw) -> Optional[str]:
    """Olay yaz — aynı kök ZATEN varsa: içerik aynıysa tekrar (None), farklıysa 409 (Codex: olay ile defterler ayrışmasın;
    düzeltme personelde değil merkezde). Kök kilidi altında (eşzamanlı iki gönderim aynı sürümü alamasın)."""
    from evvel_yeni_olay import olay_yaz
    kw.setdefault("sema_surumu", 2)   # Fable (altyapı #9): yeni panel biçimi (kuruş int, sayim listesi, ey_urun) ≠ eski çift yazım (1)
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_panel_kok:" + kw["kok"],))
    from evvel_yeni_olay import kok_durumu
    r = kok_durumu(cur, kw["kok"])   # Olay modülünün kapısı (ham SQL değil — F#25)
    iptalli = r.get("son") is not None and r.get("iptal") is not None and r["iptal"] >= r["son"]
    vardi = r.get("son") is not None and not iptalli   # Fable: iptal edilen gün yeniden açılabilsin
    if r.get("iptal") is not None:   # Codex: iptal varsa içerik son iptale bağlanır → yeniden açılış yeni sürüm, aynı isteğin tekrarı yine "tekrar"
        kw["veri"] = {**(kw.get("veri") or {}), "iptal_sonrasi": str(r["iptal"])}
    oid = olay_yaz(cur, **kw)
    if vardi and oid is not None:
        raise HTTPException(409, "Bu kayıt zaten yapıldı — değiştirmek için merkeze haber verin")
    return oid


def _degirmen(d: Optional[dict]) -> Optional[dict]:
    """Eski paneldeki 4 sayaç: Bugünkü çekim · Doz I · Doz II · Doz III (boş bırakılan yazılmaz)."""
    if not d:
        return None
    out = {}
    for k, ad in (("gunluk", "Bugünkü çekim"), ("doz1", "Doz I"), ("doz2", "Doz II"), ("doz3", "Doz III")):
        if d.get(k) not in (None, ""):
            out[k] = _tam(d[k], ad)
    return out or None


def _sayim_satirlari(cur, sayim: List[SayimSatir]) -> list:
    satir = [{"urun_id": x.urun_id, "sayilan": _tam(x.sayilan, "Sayım")} for x in sayim if x.sayilan is not None]
    if satir:
        _urunler(cur, [x["urun_id"] for x in satir], takip="sayim")
    return satir


def _sayim_tam(cur, sayim, pasta_toplam) -> None:
    """Açılış ve kapanış ORTAK sayım zorunluluğu (Dalga 4, F#19 — iki kopyaydı): tezgahta sayılan HER ürün dolu (0 yazılabilir),
    aynı ürün iki kez yok, pasta toplamı dolu."""
    from evvel_yeni_urun_api import katalog
    gerek = {str(x["id"]): x["ad"] for k in katalog(cur) for x in k["urunler"] if tezgahta_sayilir(x)}
    gelen = {}
    for x in sayim:
        if x.urun_id in gelen:
            raise HTTPException(400, "Aynı ürün iki kez sayılmış — formu yenile")
        gelen[x.urun_id] = x.sayilan
    for uid, ad in gerek.items():
        if gelen.get(uid) is None:
            raise HTTPException(400, f"{ad} adedini girin")
    if pasta_toplam is None:
        raise HTTPException(400, "Pasta adedini girin")
    _tam(pasta_toplam, "Pasta")


def _acilis_tam(cur, b: "AcilisBody") -> None:
    """Eski sihirbaz: her alan dolu (boş → 'X adedini girin'), 0 yazılabilir. Liste = katalogda panelde sayılan ürünler (S5)."""
    _sayim_tam(cur, b.sayim, b.pasta_toplam)
    _tl(b.kasa_sayim, "Kasadaki para")
    _sayim_satirlari(cur, b.sayim)
    if not b.istemci_gunu:
        raise HTTPException(400, "Form günü yok — sayfayı yenile")


def _onay_sart(sube_id: str, ad: str, tur: str, govde: dict) -> None:
    """Canlıda (QR kapısı açık) açılış / kapanış panelden DOĞRUDAN yazılamaz — telefon onayı (R1) zorunlu. Deneme döneminde serbest."""
    with db() as (_c, cur):
        if _bugun() < _baslangic(cur, sube_id):
            return   # deneme dönemi
        if _yoklama() is None:   # Codex: yoklama yüklenemedi diye onay şartı kalkmasın
            kod, msg = 503, f"{ad} şu an kaydedilemiyor — QR sistemi çalışmıyor, merkeze haber ver"
        else:
            kod, msg = 409, f"{ad} telefonla onaylanır — ekrandaki 'QR ile onayla' düğmesini kullan"
    # Fable: reddedilen gün kaydı kaybolmasın → deneme defterine 'ret' (merkez Bekleyen işler / geç kapanış görür); PIN asla
    gun = _bugun()
    try:
        if govde.get("istemci_gunu"):
            gun = date.fromisoformat(str(govde["istemci_gunu"])[:10])   # Codex: formun açıldığı iş günü
    except ValueError:
        pass
    did = _deneme_ac(sube_id, tur, gun, {k: v for k, v in govde.items() if k != "pin"})
    _deneme_kapat(did, "ret" if kod == 409 else "hata", msg)
    raise HTTPException(kod, msg)


@router.post("/{sube_id}/acilis")
def acilis_uc(sube_id: str, b: AcilisBody):
    _onay_sart(sube_id, "Açılış", "acilis", b.model_dump(mode="json"))
    return acilis(sube_id, b)


def acilis(sube_id: str, b: AcilisBody):
    """Açılış: kasadaki nakit + sayılan ürünler. Kasa sabah sayımı (gün−1'e) Kasa'nın kendi takvimiyle sonra yazılır
    (geç gelen kayıtlar kilide takılmasın — mevcut kural); burada ham olay + Depo günlük sayımı."""
    _TUR = "acilis"
    _onay_hazirla()   # ara sayım görevi ey_panel_onay'a yazılır (tablo hazırlığı işlem DIŞINDA — 19 Eki dersi)
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        p = _personel(cur, sube_id, b.personel_id)
        _acilis_tam(cur, b)
        engel = _saat_kurali("acilis", p)
        if engel and not c["kuru"]:
            raise HTTPException(409, engel)
        kasa = _tl(b.kasa_sayim, "Kasadaki para")
        satir = _sayim_satirlari(cur, b.sayim)
        kok = panel_kok("acilis", sube_id, c['gun'].isoformat())
        oid = _olay(cur, sube_id=sube_id, tur="acilis", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(kasa) / 100,
                       veri={"kasa_sayim": kasa, "sayim": satir, "istek_id": b.istek_id,
                             "pasta_toplam": None if b.pasta_toplam is None else _tam(b.pasta_toplam, "Pasta")})
        d = sayim_yaz(cur, konum=f"bar:{sube_id}", satirlar=satir, kim=f"{KIM} · {p['ad']}", tur="gunluk", gun=c["gun"],
                      kaynak_ref=f"{kok}:sayim:{oid}") if satir and oid else None   # Codex: sürüme bağlı (iptal sonrası yeni sayım); Fable: iş günü
        if oid and not c["kuru"]:
            _ara_sayim_planla(cur, sube_id, c["gun"])   # ⏱ gizli rastgele saat (A5) — açılış işlemiyle birlikte
        return {"olay": oid, "tekrar": oid is None, "sayilan": len(satir) if d else 0, "mesaj": "Açılış kaydedildi", "saat_engeli": engel}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class TeslimSatir(BaseModel):
    alan: str          # ev:onur · ev:fethi · ev:fatma
    tutar: TrTutar


class KapanisBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    nakit: TrTutar
    pos: TrTutar = Decimal(0)
    online: TrTutar = Decimal(0)
    kor_sayim: Optional[TrTutar] = None      # kasada sayılan (sağlama — Kasa'ya SAYIM yazılmaz, mevcut karar)
    teslimler: List[TeslimSatir] = []
    birakilan: Optional[TrTutar] = None      # kasada bırakılan
    degirmen: Optional[dict] = None          # değirmen sayaçları (sahip: kalır) — {gunluk, doz1, doz2, doz3} (eski panelle aynı 4 alan)
    sayim: List[SayimSatir] = []
    pasta_toplam: Optional[Decimal] = None   # sahip: pasta yalnız TOPLAM adet
    istek_id: Optional[str] = None
    x_rapor: bool = False                    # eski 5. adım: "X raporu yazıcıdan çıktı alındı ve gönderildi"
    urun_ac_yok: bool = False                # S11-5: bugün Ürün Aç kaydı yok → personel "açılmadı" dedi
    merkeze: bool = False                    # sahip (19 Eki): telefonsuz kapanış → kayıt yazılmaz, merkeze iletilir (geç kapanış)
    pin: Optional[str] = None                # yalnız "Merkeze gönder" — doğrulanır, hiçbir yere yazılmaz


def _kapanis_tam(cur, b: "KapanisBody", merkez: bool = False) -> None:
    """Eski kapanış korumaları (sube_operasyon.py KAPANIS 1267-1333, sube_panel.html kapNext1 — Fable F2, fonksiyon kaybı yok):
    en az bir ciro · online = nakit+POS → RED (çift sayım) · çekmecedeki TÜM para (kör) ZORUNLU · bırakılan ZORUNLU ·
    tezgah sayımı her kalem (0 yazılabilir) + pasta ZORUNLU (açılışla aynı liste)."""
    n, p_, o = _tl(b.nakit, "Nakit"), _tl(b.pos, "POS"), _tl(b.online, "Online")
    if n + p_ + o <= 0:
        raise HTTPException(400, "En az bir ciro tutarı girin")
    if o > 0 and n > 0 and p_ > 0 and abs(o - (n + p_)) < 50:
        raise HTTPException(400, "Online alanı nakit+POS toplamına eşit olamaz. Online satış yoksa 0 bırakın.")
    if merkez:   # Fable B3: merkez geç kapanışı — personelin o gün girdiği veri ESAS; katalog sonradan değiştiyse / eski kayıtsa tıkanmaz
        return
    if b.kor_sayim is None:
        raise HTTPException(400, "Çekmecedeki TÜM parayı sayıp girin (teslim etmeden önce, kör sayım)")
    _tl(b.kor_sayim, "Çekmecedeki para")
    if b.birakilan is None:
        raise HTTPException(400, "Kasada bırakılan (devir) tutarı zorunlu")
    _tl(b.birakilan, "Bırakılan")
    _sayim_tam(cur, b.sayim, b.pasta_toplam)


def _kapanis_uyarilari(cur, sube_id: str, gun, p: dict, b: "KapanisBody") -> tuple:
    """EKSİK VAR (sarı kart) + merkez "⚠ Kapanış uyarılı". Kapanışı ENGELLEMEZ. Kasa sağlaması YENİDEN YAZILMAZ — Satış'ın tek
    hesabı (kasa_mutabakat, yeni evren; bu işlemde yazılan kapanış dahil). Dönüş: (uyarılar, ek veri: sorumlu / içeride kalanlar,
    kasa_uyarilari). SAHİP (2026-10-19): KASA UYARISI PANELE VERİLMEZ (kör sayım — personel tuttu mu bilmez) → ek["kasa_uyarilari"]
    yalnız merkeze (olay + Bekleyen işler)."""
    from evvel_yeni_moduller import acik as _acik
    u, ek, ku = [], {}, []
    bugun = __import__("evvel_yeni_olay").panel_olaylari(cur, sube_id=sube_id, bas=gun, son=gun)   # F#12
    if not any(o["tur"] == "acilis" for o in bugun):
        u.append("Bugün açılış kaydı yok")
    if not any(o["tur"] == "urun_ac" for o in bugun):
        u.append("Bugün Ürün Aç kaydı yok" + (" — personel 'ürün açılmadı' dedi" if b.urun_ac_yok else ""))
    if not b.x_rapor:
        u.append("'X raporu gönderildi' işaretlenmedi")
    if _acik("satis"):
        try:
            from evvel_yeni_satis_api import kasa_mutabakat
            m = kasa_mutabakat(cur, gun.isoformat(), evren="yeni").get(str(sube_id)) or {}
            if m.get("kor_belirsiz"):
                ku.append("Kör sayım teslimden SONRA yapılmış görünüyor — sağlama yapılamadı")
            elif m.get("kor_fark") is not None and abs(m["kor_fark"]) >= 1:
                _t = lambda x: _tl_tr(int(round((x or 0) * 100)))   # noqa: E731 — TL → Türkçe biçim
                ku.append(f"Kör sayım tutmuyor: sayılan {_t(m['kor_sayim'])} − teslim {_t(m['teslim'])} = {_t(m['kor_kalan'])}, "
                         f"bırakılan {_t(m['devir'])} (fark {'+' if (m['kor_fark'] or 0) > 0 else ''}{_t(m['kor_fark'])})")
            ku.extend(m.get("ara_uyari") or [])   # ⏱ ara sayım iki sınır (A1) — merkez görür, panel GÖRMEZ
            # Kasa farkı burada YAZILMAZ (sahip 2026-10-20: tek evi Kasa › Açık farklar — tekrar etmesin)
        except Exception:  # noqa: BLE001 — uyarı kapanışı ASLA durdurmaz
            log.warning("kapanış uyarısı: kasa sağlaması okunamadı", exc_info=True)
    y = _yoklama()
    if y is not None:
        try:
            if y.devir_tamamlanmadi(cur, str(sube_id), gun):   # Yoklama'nın kapısı (F#26)
                u.append("Kasa devri tamamlanmadı")
            s = y.kapanis_sorumlusu(cur, str(sube_id), gun)
            if s:
                ek["sorumlu"] = s
                if str(s["personel_id"]) != str(p["id"]):
                    u.append(f"Kapanışı sorumlu ({s['ad']}) değil {p['ad']} yaptı")
            kalan = [g["ad"] for g in y.bugun_girenler(cur, str(sube_id), gun) if g.get("acik") and str(g["personel_id"]) != str(p["id"])]
            ek["iceride_kalanlar"] = kalan
            if kalan:
                u.append("Kapanışta içeride kalan: " + ", ".join(kalan) + " (QR ile çıkış yapmazsa gece otomatik kapanır)")
        except Exception:  # noqa: BLE001
            log.warning("kapanış uyarısı: yoklama okunamadı", exc_info=True)
    ek["kasa_uyarilari"] = ku
    return u, ek


def _kapanis_yaz(sube_id: str, b: "KapanisBody", gun=None, merkez: Optional[str] = None, isle_deneme: Optional[str] = None,
                 telefonsuz: Optional[dict] = None) -> dict:
    """Kapanış: ciro (nakit / POS / online) → Kasa kapanış beyanı; teslimler → Kasa teslim; sayım → Depo günlük sayımı
    (düşüş = kullanılan, sahip kararı); hepsi tek işlemde. Aynı gün ikinci kapanış Kasa'da reddedilir (düzeltme merkezde)."""
    _TUR = "kapanis"
    def is_(cur, c):
        from evvel_yeni_depo_api import sayim_yaz
        from evvel_yeni_kasa_api import HareketBody, kasa_yaz
        p = _personel(cur, sube_id, b.personel_id, kapi=False, gun=c["gun"])   # QR kapısı aşağıda: tekrar gönderim ve merkez geç kapanış geçer
        _kapanis_tam(cur, b, merkez=bool(c.get("merkez")))
        engel = None if c.get("merkez") else _saat_kurali("kapanis", p)
        if engel and not c["kuru"]:
            raise HTTPException(409, engel)
        gun = c["gun"].isoformat()
        nakit, pos, onl = _tl(b.nakit, "Nakit"), _tl(b.pos, "POS"), _tl(b.online, "Online")
        tes = []
        for i, t in enumerate(b.teslimler):
            if t.alan not in TESLIM_ALANLAR:
                raise HTTPException(400, "Teslim alan: Onur / Fethi / Fatma")
            k = _tl(t.tutar, "Teslim")
            if k:
                tes.append({"alan": t.alan, "tutar": k})
        dusen = []
        try:
            satir = _sayim_satirlari(cur, b.sayim)
        except HTTPException:
            if not c.get("merkez"):
                raise
            from evvel_yeni_urun_api import urun_bilgi   # merkez geç kapanış: personelin o gün saydığı ürün sonradan değiştiyse
            bil = urun_bilgi(cur, [x.urun_id for x in b.sayim])
            satir = [{"urun_id": x.urun_id, "sayilan": _tam(x.sayilan, "Sayım")} for x in b.sayim
                     if x.sayilan is not None and x.urun_id in bil and tezgahta_sayilir(bil[x.urun_id])]
            dusen = [(bil.get(x.urun_id) or {}).get("ad") or x.urun_id for x in b.sayim
                     if x.sayilan is not None and x.urun_id not in {s_["urun_id"] for s_ in satir}]
        kok = panel_kok("kapanis", sube_id, gun)
        _ara_iptal(cur, sube_id, c["gun"], "gün kapandı")   # Fable D-A: kapanıştan sonra ara sayım doğmasın (merkez geç kapanış dahil)
        oid = _olay(cur, sube_id=sube_id, tur="kapanis", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(nakit) / 100,
                       veri={"nakit": nakit, "pos": pos, "online": onl, "teslimler": tes, "sayim": satir,
                             "kor_sayim": None if b.kor_sayim is None else _tl(b.kor_sayim, "Kör sayım"),
                             "birakilan": None if b.birakilan is None else _tl(b.birakilan, "Bırakılan"),
                             "degirmen": _degirmen(b.degirmen),
                             "pasta_toplam": None if b.pasta_toplam is None else _tam(b.pasta_toplam, "Pasta"),
                             "x_rapor": bool(b.x_rapor), "urun_ac_yok": bool(b.urun_ac_yok), "istek_id": b.istek_id})
        kim = (f"merkez (geç kapanış) · {c['merkez']} · {p['ad']}" if c.get("merkez") else f"{KIM} · {p['ad']}")
        k = kasa_yaz(cur, HareketBody(tur="kapanis", is_gunu=gun, cep=f"sube:{sube_id}", tutar=Decimal(nakit) / 100,
                                      kart=Decimal(pos) / 100, online=Decimal(onl) / 100), kim,
                     kaynak_ref=f"kapanis:{sube_id}:{gun}", kor=True)
        if k.get("tekrar") and oid is not None and not c["kuru"]:
            # içerik değişmiş ikinci kapanış: Kasa'daki beyan sessizce eski kalmasın → hepsi geri alınır, düzeltme merkezde
            raise HTTPException(409, "Bugünün kapanışı zaten yapıldı — değiştirmek için merkeze haber verin")
        for i, t in enumerate(tes):
            kasa_yaz(cur, HareketBody(tur="teslim", is_gunu=gun, kaynak=f"sube:{sube_id}", hedef=t["alan"],
                                      tutar=Decimal(t["tutar"]) / 100, teslim_eden=p["ad"]), kim,
                     kaynak_ref=f"{kok}:teslim:{i}", kor=True)   # kör sayım: ret mesajı rakamsız (E2E #4)
        # Codex BLOKER: geç kapanışta sayım BUGÜNÜN bakiyesine uygulanmaz (geçmiş gün uzlaştırılamaz) — olayda kalır, merkez görür
        gecmis = bool(c.get("merkez")) and c["gun"] != _bugun()
        # Fable: sayım kaynak_ref olay SÜRÜMÜNE bağlı (iptal sonrası yeniden kapanışta sayım yeniden yazılır; tekrar gönderimde yazılmaz)
        # ve İŞ GÜNÜNE yazılır (00:00–02:00 kapanışı dünün hareketi)
        d = sayim_yaz(cur, konum=f"bar:{sube_id}", satirlar=satir, kim=kim, tur="gunluk", gun=c["gun"],
                      kaynak_ref=f"{kok}:sayim:{oid}") if satir and oid and not gecmis else None
        if satir and gecmis:
            log.warning("geç kapanış %s %s: ürün sayımı geçmiş güne uygulanmadı (olayda duruyor)", sube_id, gun)
            __import__("evvel_yeni_olay").olay_veri_ekle(cur, oid, {"sayim_uygulanmadi": True})
        uyarilar, merkez_uyarilari = [], []
        y = _yoklama()
        kisi_kilidi = y is not None and not c["kuru"] and not c.get("merkez") and oid is not None
        if kisi_kilidi:   # TEK kez (F#20 — aynı kilit iki kez alınıyordu): Codex P2-5 devir telefonuyla aynı sıra (kişi → devir)
            y.personel_kilidi(cur, p["id"])   # + telefon çıkış/giriş ile yarışmasın
        if oid is not None:   # yeni yazım: uyarılar + sorumlu + içeride kalanlar (değişken bilgi → tekrar korumasının DIŞINDA, sonradan eklenir)
            uyarilar, ek = _kapanis_uyarilari(cur, sube_id, c["gun"], p, b)
            if dusen:
                uyarilar.append("Geç kapanış: sayımdaki " + ", ".join(dusen) + " artık sayım listesinde değil — uygulanmadı")
            merkez_uyarilari = ek["kasa_uyarilari"] + uyarilar   # merkez HEPSİNİ görür; panel kasa uyarısını GÖRMEZ
            __import__("evvel_yeni_olay").olay_veri_ekle(cur, oid, {"uyarilar": uyarilar, **ek})
        if kisi_kilidi:
            if _qr_gerekli(cur, sube_id) and not y.acik_mi(cur, sube_id, p["id"]):
                raise HTTPException(400, "Önce telefonundan QR ile giriş yap")   # yeni kapanış; işlem geri alınır
            y.cikis_yaz(cur, p["id"], "kapanis", kim=kim, sube_id=str(sube_id))   # tasarım: kapanış = kapanışçının çıkışı
        # K-5: telefonsuz kapanış merkezde işlenince gönderenin çıkışı GÖNDERİM saatiyle — aynı işlemde (yarıda kalmaz), deneme dönemi ve
        # tekrar (oid None) hariç. Kimlik + saat gönderim anında sunucuda sabitlendi (açıklama metninden karar verilmez — Codex)
        if (telefonsuz and y is not None and not c["kuru"] and oid is not None
                and telefonsuz.get("personel_id") and telefonsuz.get("yoklama_id") and telefonsuz.get("zaman")):
            if not y.telefonsuz_kapanis_cikisi(cur, str(telefonsuz["personel_id"]), str(telefonsuz["yoklama_id"]), telefonsuz["zaman"],
                                               kim=f"telefonsuz kapanış — merkez işledi · {c.get('merkez') or kim}"):
                merkez_uyarilari.append("Telefonsuz kapanış: gönderenin çıkışı yazılamadı (giriş satırı değişmiş) — Çıkışı yapılmamışlar'dan bak")   # Fable nit
        return {"olay": oid, "tekrar": oid is None and bool(k.get("tekrar")), "sayilan": len(satir) if d else 0,
                "mesaj": "Kapanış kaydedildi" + (" — ürün sayımı geçmiş güne uygulanmadı (olayda duruyor)" if satir and gecmis else ""),
                "saat_engeli": engel, "uyarilar": uyarilar, "merkez_uyarilari": merkez_uyarilari, "kapanisci": p["ad"]}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"), gun=gun, merkez=merkez,
                     isle_deneme=isle_deneme)


@router.post("/{sube_id}/kapanis")
def kapanis_uc(sube_id: str, b: KapanisBody):
    if b.merkeze:
        return _kapanis_merkeze(sube_id, b)
    _onay_sart(sube_id, "Kapanış", "kapanis", b.model_dump(mode="json"))   # telefon onayı zorunlu (canlı); telefonsuz → merkeze=True
    return kapanis(sube_id, b)


def _kapanis_merkeze(sube_id: str, b: KapanisBody) -> dict:
    """Sahip (2026-10-19): MÜHÜRSÜZ GÖNDER YOK. Kapanışçının telefonu yoksa ve içeride telefonla onaylayacak başka kimse yoksa:
    QR'la girmiş kişi ad + PIN → form doğrulanır, KAYIT YAZILMAZ; girilen rakamlar deneme defterine 'ret' ("telefonsuz — merkeze
    gönderildi") → merkez Bekleyen işler'den tek tıkla GEÇ KAPANIŞ (var olan yol). Rakamlar kaybolmaz; PIN hiçbir yere yazılmaz."""
    with db() as (_c, cur):
        p = _personel(cur, sube_id, b.personel_id)   # QR'la girmiş (içeride)
        _pin(cur, p, b.pin)
        _kapanis_tam(cur, b)
        _onay_hazirla()
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{sube_id}:kapanis",))   # onay ile aynı sıra
        cur.execute("""SELECT 1 FROM ey_panel_onay WHERE sube_id=%s AND tur='kapanis' AND durum='isleniyor'
                       AND islenme > NOW() - INTERVAL '2 minutes' LIMIT 1""", (str(sube_id),))
        if cur.fetchone():
            raise HTTPException(409, "Kapanış şu an telefondan onaylanıyor — birkaç saniye bekle")
        try:
            fg = date.fromisoformat(str(b.istemci_gunu or "")[:10])
        except ValueError:
            fg = _bugun()
        if _gun_kapali(cur, sube_id, fg):   # Codex: formun GÜNÜ (dünkü eksik kapanış da gönderilebilsin)
            raise HTTPException(409, "Bu günün kapanışı zaten yapıldı")
        cur.execute("""UPDATE ey_panel_onay SET durum='iptal', mesaj='merkeze gönderildi' WHERE sube_id=%s AND tur='kapanis'
                       AND durum IN ('bekliyor','hata')""", (str(sube_id),))   # açık QR onayı kalmasın
        if not b.istemci_gunu:
            raise HTTPException(400, "Form günü yok — sayfayı yenile")
    gun = _bugun()
    try:
        gun = date.fromisoformat(str(b.istemci_gunu)[:10])
    except ValueError:
        pass
    govde = {k: v for k, v in b.model_dump(mode="json").items() if k not in ("pin", "merkeze")}
    # K-5: kimlik + gönderim saati SUNUCUDA sabitlenir (geç kapanış işlenince çıkış bu saatle yazılır — ad / açıklama metninden karar yok)
    _y = _yoklama()
    with db() as (_c, cur):   # Codex: gönderim anındaki AÇIK giriş satırı sabitlenir (sonradan yeniden giriş kapatılmasın)
        _yid = _y.acik_giris_id(cur, str(sube_id), p["id"]) if _y is not None else None
    govde["_telefonsuz"] = {"personel_id": p["id"], "yoklama_id": _yid,
                            "zaman": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}
    did = _deneme_ac(sube_id, "kapanis", gun, govde)
    _deneme_kapat(did, "ret", f"Telefonsuz — {p['ad']} merkeze gönderdi (geç kapanış olarak işleyin)")
    with db() as (_c, cur):
        kuru = deneme_mi(cur, gun, sube_id)
    return {"ok": True, "merkeze": True, "kuru": kuru,
            "mesaj": ("DENEME — gerçekte merkeze iletilirdi" if kuru else "Kapanış merkeze iletildi — merkez işleyince gün kapanır. Rakamlar kaydedildi.")}


def kapanis(sube_id: str, b: KapanisBody):
    return _kapanis_yaz(sube_id, b)


# Kasa devri (Basamak 4, sahip 2026-10-19): panel YALNIZ başlatır (yoklama /devir-baslat, kayıtlı PC imzası) ve gösterir;
# devreden formu kendi telefonunda doldurur. Eski panel formu (DevirBody) ve 'yoklama yoksa doğrudan vardiya olayı' dalı KALDIRILDI (tek yol).


class DevirIptalBody(BaseModel):
    istek_id: Optional[str] = None


async def _tablet_imzasi(request: Request, sube_id: str) -> None:
    """🔒 Kimliksiz YAZAN panel uçları (Codex P1 · Fable L4b C + dar B, 28 Eki): şube GERÇEK kayıttaysa (🧪 pilot / 1 Kasım sonrası)
    istek o şubeye bağlı panel PC'sinin cihaz imzasını taşımalı — şube kimliğini bilen dış istemci devri iptal edemez, taslak silemez,
    sahte onay isteyemez, ara sayımı değiştiremez. Deneme şubesinde serbest (bağlanmamış PC "QR'sız geç" kırılmasın). İmza
    doğrulayıcı Yoklama'nın PUBLIC cihaz_coz'u (QR / devir başlat ile AYNI kapı); gövde Starlette'te önbellekli, uç yine okur."""
    ham = await request.body()
    with db() as (conn, cur):
        if deneme_mi(cur, sube_id=sube_id):
            return
        y = _yoklama()
        if y is None:
            raise HTTPException(503, "Cihaz doğrulaması çalışmıyor — merkeze haber ver")
        c = y.cihaz_coz(cur, request.headers, request.method, request.url.path, ham, tur="tablet")
        if str(c.get("sube_id") or "") != str(sube_id):
            raise HTTPException(403, "Bu işlem bu şubenin panel bilgisayarından yapılır")


_IMZALI = [Depends(_tablet_imzasi)]


@router.post("/{sube_id}/devir-iptal", dependencies=_IMZALI)
def kasa_devri_iptal(sube_id: str, b: DevirIptalBody):
    """Panel: devreden henüz onaylamadıysa açık devri iptal eder (onaylandıysa merkez kapatır)."""
    y = _yoklama()
    if y is None:
        raise HTTPException(400, "Devir onayı açık değil")
    with db() as (conn, cur):
        if not y.devir_iptal(cur, str(sube_id), _bugun()):
            raise HTTPException(409, "İptal edilecek bekleyen devir yok (devreden onayladıysa merkeze haber verin)")
    return {"ok": True, "mesaj": "Devir iptal edildi"}


class AraTeslimBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    alan: str
    tutar: TrTutar
    aciklama: Optional[str] = None     # isteğe bağlı (eski aynen) — aracı kişi vb. ("Ahmet götürdü")
    istek_id: str


@router.post("/{sube_id}/ara-teslim")
def ara_teslim(sube_id: str, b: AraTeslimBody):
    """Gün içi para teslimi (Onur / Fethi / Fatma) → Kasa teslim ('onay bekliyor')."""
    _TUR = "ara_teslim"
    def is_(cur, c):
        from evvel_yeni_kasa_api import HareketBody, kasa_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        if b.alan not in TESLIM_ALANLAR:
            raise HTTPException(400, "Teslim alan: Onur / Fethi / Fatma")
        k = _tl(b.tutar, "Tutar")
        if not k:
            raise HTTPException(400, "Tutarı yaz")
        aciklama = " ".join((b.aciklama or "").split())[:120] or None
        # Fable (21 Eki): eski kural — aynı tutar 1 dk içinde ikinci kez (pencere kapanıp açılınca yeni istek kimliği) → çift teslim olmasın
        if __import__("evvel_yeni_olay").yakin_ayni_olay(cur, sube_id=str(sube_id), tur="teslim", veri_alan="tutar", deger=str(k),
                                                         dakika=1, istek_haric=b.istek_id):
            raise HTTPException(409, "Bu teslim az önce kaydedildi")
        kok = panel_kok("ara", sube_id, b.istek_id)
        oid = _olay(cur, sube_id=sube_id, tur="teslim", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(k) / 100,
                       veri={"alan": b.alan, "tutar": k, "aciklama": aciklama, "istek_id": b.istek_id})
        r = kasa_yaz(cur, HareketBody(tur="teslim", is_gunu=c["gun"].isoformat(), kaynak=f"sube:{sube_id}", hedef=b.alan,
                                      tutar=Decimal(k) / 100, teslim_eden=p["ad"], not_=aciklama), f"{KIM} · {p['ad']}", kaynak_ref=kok, kor=True)
        alan_ad = next((a for a, c in _TH.items() if c == b.alan), b.alan)   # G33: ne kaydedildi açık yazsın
        return {"olay": oid, "tekrar": oid is None and bool(r.get("tekrar")),
                "mesaj": f"Teslim kaydedildi ✓ — {alan_ad} · {_tl_tr(k)}"}   # denetim: ek yok (Fethi'a hatası)
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class Kalem(BaseModel):
    urun_id: str
    adet: Decimal


class UrunAcBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    kalemler: List[Kalem]
    istek_id: str
    aciklama: Optional[str] = None     # eski panel "Not (isteğe bağlı)"


def _kalemler(cur, kalemler: List[Kalem], takip: Optional[str] = None, pasif_olur: bool = False) -> list:
    k = [{"urun_id": x.urun_id, "adet": _tam(x.adet, "Adet")} for x in kalemler]
    k = [x for x in k if x["adet"] > 0]
    if not k:
        raise HTTPException(400, "En az bir ürün seç")
    if len({x["urun_id"] for x in k}) != len(k):
        raise HTTPException(400, "Aynı ürün iki kez seçildi")
    b = _urunler(cur, [x["urun_id"] for x in k], takip=takip, pasif_olur=pasif_olur)
    for x in k:
        x["ad"] = b[x["urun_id"]]["ad"]
        x["takip"] = b[x["urun_id"]].get("takip") or "sayim"
        x["panel_sayim"] = tezgahta_sayilir(b[x["urun_id"]])   # TEK kural (F#7)
    return k


def _modul_acik(kod: str) -> bool:
    from evvel_yeni_moduller import acik as _acik
    return _acik(kod)


# ─────────────── BASAMAK 5 S3 · DEPODAN GELEN — TESLİM AL (PANEL_YENIDEN_KURULUM.md §6 + "Basamak 5", sahip P3) ───────────────
# Kalem kalem KÖR sayım (panel beklenen adedi hiç görmez) → Depo PUBLIC kabul_yaz (0 gerçek; hasarlı/fazla askıda; merkez karar).
# Gün kapalıyken de AÇIK (D7: sevk kabulü kapanıştan sonra gelebilir). Paketin bekleyen BÜTÜN kalemleri tek seferde sayılır.
class DepoKabulSatir(BaseModel):
    bag: str
    sayilan: int
    hasarli: int = 0


class DepoKabulBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    parti_id: str
    satirlar: List[DepoKabulSatir]
    istek_id: str


@router.post("/{sube_id}/depodan-kabul")
def depodan_kabul(sube_id: str, b: DepoKabulBody):
    _TUR = "depo_kabul"
    if not _modul_acik("depo"):
        raise HTTPException(503, "Depo modülü kapalı — paket şu an kabul edilemiyor, merkeze haber ver")

    def is_(cur, c):
        from evvel_yeni_depo_api import kabul_yaz, yoldakiler
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        bek = next((x for x in yoldakiler(cur, str(sube_id)) if x["parti_id"] == b.parti_id), None)
        kok = panel_kok("depo_kabul", sube_id, b.istek_id)
        if bek is None:   # tekrar gönderim (aynı istek) ya da başka yerden kabul edildi / merkez geri aldı
            if __import__("evvel_yeni_olay").kok_var(cur, kok):
                return {"tekrar": True, "mesaj": "Bu paket zaten kabul edilmişti ✓"}
            raise HTTPException(409, "Bu paket artık bekleyenlerde yok — sayfayı yenile")
        gerek = {k["bag"]: k["ad"] for k in bek["kalemler"]}
        gelen = {x.bag: x for x in b.satirlar}
        if set(gelen) != set(gerek) or len(gelen) != len(b.satirlar):
            raise HTTPException(400, "Paketin bütün ürünleri sayılmalı — sayfayı yenile")
        for x in b.satirlar:
            _tam(x.sayilan, "Sayılan")
            _tam(x.hasarli, "Hasarlı")
        kim = f"{KIM} · {p['ad']}"
        oid = _olay(cur, sube_id=sube_id, tur="depo_kabul", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"],
                    veri={"parti_id": b.parti_id, "nereden": bek["nereden"], "istek_id": b.istek_id,
                          "satirlar": [{"bag": x.bag, "ad": gerek[x.bag], "sayilan": x.sayilan, "hasarli": x.hasarli} for x in b.satirlar]})
        if oid is None:
            return {"tekrar": True, "mesaj": "Bu paket zaten kabul edilmişti ✓"}
        fark = False
        for x in sorted(b.satirlar, key=lambda z: int(z.bag.rsplit(":", 1)[1])):   # Fable S3 #1: kalem İNDEKS sırası (sevk_iptal ile aynı)
            r = kabul_yaz(cur, bag=x.bag, sayilan=x.sayilan, hasarli=x.hasarli, kim=kim, gun=c["gun"], beklenen_hedef=str(sube_id))
            fark = fark or bool(r.get("eksik") or r.get("fazla") or r.get("hasar"))
        # KÖR kalır: personele rakam söylenmez (beklenen sızmasın) — yalnız "merkeze iletildi"
        return {"olay": oid, "tekrar": False,
                "mesaj": f"{len(b.satirlar)} ürün kabul edildi ✓ · sayım merkeze iletildi"}   # G26: fark VAR/YOK personele söylenmez (kör)
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


# ─────────────── 🤝 AVANS — ELDEN TESLİM (kesim engeli T3-17, sahip 20 Eki: panelde ad + PIN; personel "aldım" onayı YOK) ───────────────
class AvansTeslimBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str                  # avansı ÇEKMECEDEN veren (QR'la içeride)
    pin: Optional[str] = None
    talep_id: str
    istek_id: str


@router.post("/{sube_id}/avans-teslim")
def avans_teslim(sube_id: str, b: AvansTeslimBody):
    if not _modul_acik("avans"):
        raise HTTPException(503, "Avans modülü kapalı — merkeze haber ver")

    def is_(cur, c):
        from evvel_yeni_avans_api import elden_teslim_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        kok = panel_kok("avans", sube_id, b.talep_id)
        oid = _olay(cur, sube_id=sube_id, tur="avans", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"], veri={"talep_id": b.talep_id})   # kök talep başına — aynı talep iki kez teslim edilemez
        if oid is None:
            return {"tekrar": True, "mesaj": "Bu avans zaten teslim edilmişti ✓"}
        r = elden_teslim_yaz(cur, talep_id=b.talep_id, sube_id=str(sube_id), kim=f"{KIM} · {p['ad']}", gun=c["gun"], veren_pid=p["id"])
        return {"olay": oid, "tekrar": r["tekrar"],
                "mesaj": "Bu avans zaten teslim edilmişti ✓" if r["tekrar"] else f"🤝 {r['personel']} — {_tl_tr(r['tutar'])} avans teslim edildi"}
    return _calistir(sube_id, b.istek_id, is_, tur="avans", govde=b.model_dump(mode="json"))


# ─────────────── ANLIK GİDER (1 Kasım listesi madde 7, sahip kararları 20 Eki) ───────────────
# Şube çekmecesinden ödenen küçük gider: olay 'gider' + Kasa dukkan_gideri_yaz (tek yazıcı). Onay YOK, yalnız NAKİT, eksiye düşse de
# yazılır (personele kasa uyarısı GÖSTERİLMEZ — kör sayım; merkez Kasa'da görür). Gün kapalıyken girilmez (kasa sayıldı).
class GiderBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None
    tutar: TrTutar
    aciklama: str
    kategori: Optional[str] = None
    fis: Optional[bool] = None        # fiş / fatura alındı mı (Fiş kontrol merkezde)
    istek_id: str


@router.post("/{sube_id}/gider")
def gider_gir(sube_id: str, b: GiderBody):
    def is_(cur, c):
        from evvel_yeni_kasa_api import dukkan_gideri_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        t = _tl(b.tutar, "Tutar")
        if t <= 0:
            raise HTTPException(400, "Tutar sıfırdan büyük olmalı")
        ac = " ".join((b.aciklama or "").split())
        if len(ac) < 3:
            raise HTTPException(400, "Açıklama zorunlu — neye ödendiğini yaz")
        if b.fis is None:
            raise HTTPException(400, "Fiş / fatura alındı mı? — EVET ya da HAYIR seç")
        kok = panel_kok("gider", sube_id, b.istek_id)
        oid = _olay(cur, sube_id=sube_id, tur="gider", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(t) / 100,
                    veri={"tutar": t, "aciklama": ac[:120], "kategori": (b.kategori or "").strip()[:40] or None, "fis": bool(b.fis)})
        if oid is not None:
            dukkan_gideri_yaz(cur, sube_id=str(sube_id), gun=c["gun"].isoformat(), tutar=t, aciklama=ac, kim=f"{KIM} · {p['ad']}",
                              kaynak_ref=kok, giren_id=p["id"], giren=p["ad"], kategori=b.kategori, fis=b.fis)
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Bu gider zaten kaydedilmişti ✓" if oid is None else f"💸 Gider kaydedildi — {_tl_tr(t)}"}
    return _calistir(sube_id, b.istek_id, is_, tur="gider", govde=b.model_dump(mode="json"))


# ─────────────── BASAMAK 5 S5 · SİPARİŞ VER · TAKİP · GÖNDERİLECEK (sahip D1–D4, 2026-10-20) ───────────────
# Kayıt Sipariş modülünün PUBLIC kapılarından (evvel_yeni_siparis_api); panel yalnız kimlik + iskelet. Modül kapalıysa 503 (yumuşak bağ).
def _siparis():
    if not _modul_acik("siparis"):
        raise HTTPException(503, "Sipariş modülü kapalı — merkeze haber ver")
    import evvel_yeni_siparis_api as s
    return s


class SiparisKalem(BaseModel):
    urun_id: Optional[str] = None
    ad: Optional[str] = None       # katalog dışı öneri (D4)
    adet: int


class SiparisBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None
    kalemler: List[SiparisKalem]
    notu: Optional[str] = None
    istek_id: str


@router.post("/{sube_id}/siparis")
def siparis_ver(sube_id: str, b: SiparisBody):
    """Sipariş ver (A2): gün AÇIK şart (A14). 1 Kasım öncesi talep GERÇEK yazılır, deneme işaretli (D2 — stok yok)."""
    S = _siparis()

    def is_(cur, c):
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        r = S.siparis_yaz(cur, sube_id=str(sube_id), kalemler=[x.model_dump() for x in b.kalemler], kim=f"{KIM} · {p['ad']}",
                          personel_id=p["id"], istek_id=b.istek_id, notu=b.notu, deneme=c["kuru"], gun=c["gun"])
        if not c["kuru"]:   # olay defteri yalnız gerçek dönemde (deneme siparişi okuyuculara karışmasın)
            _olay(cur, sube_id=sube_id, tur="siparis", is_gunu=c["gun"], kok=panel_kok("siparis", sube_id, b.istek_id), kaynak_tablo="panel",
                  personel_id=p["id"], personel_ad=p["ad"], veri={"siparis_id": r["siparis_id"], "kalem": r["kalem"], "istek_id": b.istek_id})
        c["kalici"] = True
        return {"siparis_id": r["siparis_id"], "tekrar": r["tekrar"],
                "mesaj": ("Bu sipariş zaten gönderilmişti ✓" if r["tekrar"] else f"🛒 Sipariş gönderildi — {r['kalem']} kalem")
                + (" · 🧪 deneme (1 Kasım'a kadar sevk yapılmaz)" if c["kuru"] else "")}
    return _calistir(sube_id, b.istek_id, is_, tur="siparis", govde=b.model_dump(mode="json"))


@router.get("/{sube_id}/siparisler")
def panel_siparisler(sube_id: str):
    """Sipariş takip (A7, KÖR — sevk/kabul adedi yok) + Sipariş ver rozetleri (A2/A12, adetsiz) + Gönderilecek (yalnız merkez depo şubesi)
    + Tedarikçi 'beklenen' kartları (A10)."""
    S = _siparis()
    with db() as (conn, cur):
        S.siparis_hazirla(cur)
        _sube(cur, sube_id)
        from evvel_yeni_tanim_api import depo_sube_id
        depo_mu = depo_sube_id(cur) == str(sube_id)
        sip = S.subenin_siparisleri(cur, str(sube_id))
        return {"siparisler": sip, "rozet": S.bekleyen_urunler(cur, str(sube_id), sip),   # Fable #8: ikinci türetme yok
                "gonderilecek": S.gonderilecek(cur, str(sube_id)) if depo_mu else [], "depo": depo_mu,
                "toptanci_beklenen": S.toptanci_beklenen(cur, str(sube_id)) if _modul_acik("toptanci") else []}   # #16


class SiparisIptalBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None
    istek_id: str


@router.post("/{sube_id}/siparis/{sid}/iptal")
def panel_siparis_iptal(sube_id: str, sid: str, b: SiparisIptalBody):
    """Şube yalnız HİÇ yönlendirilmemiş kendi siparişini geri çeker (ad + PIN)."""
    S = _siparis()

    def is_(cur, c):
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        S.siparis_hazirla(cur)
        S.siparis_iptal(cur, sid=sid, kim=f"{KIM} · {p['ad']}", sebep="şube geri çekti", sube_id=str(sube_id))
        c["kalici"] = True
        return {"mesaj": "Sipariş geri çekildi"}
    return _calistir(sube_id, b.istek_id, is_, tur="siparis_iptal", govde=b.model_dump(mode="json"))


class GonderSatir(BaseModel):
    yon_id: str
    siparis_id: str
    surum: Optional[int] = None
    hazir: Optional[int] = None
    gonderilen: Optional[int] = None


class GonderBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None
    hedef: str
    satirlar: List[GonderSatir]
    yola_cik: bool = False          # False = yalnız "Hazırlığı kaydet" (stok yazmaz)
    istek_id: str


@router.post("/{sube_id}/gonderilecek")
def panel_gonderilecek(sube_id: str, b: GonderBody):
    """Gönderilecek (A9, yalnız merkez depo şubesi): 'Hazırlığı kaydet' (stok yok, denemede de kalır) ya da '🚚 Yola çıkar'
    (Depo sevk_yaz — 1 Kasım öncesi DENEME, geri alınır). Gün kapalıyken de açık (D7). Kısmi → kalan yönlendirilmemişe döner."""
    S = _siparis()
    if b.yola_cik and not _modul_acik("depo"):   # Fable 21 Eki (tak-çıkar): Depo kapalıyken 500 değil, personele düz dil
        raise HTTPException(503, "Depo modülü kapalı — şu an yola çıkarılamaz, merkeze haber ver")

    def is_(cur, c):
        from evvel_yeni_tanim_api import depo_sube_id
        if depo_sube_id(cur) != str(sube_id):
            raise HTTPException(403, "Gönderilecek yalnız merkez depo şubesinde")
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        kim = f"{KIM} · {p['ad']}"
        if not b.yola_cik:
            n = S.hazirlik_yaz(cur, depo_sube=str(sube_id), satirlar=[x.model_dump() for x in b.satirlar])
            c["kalici"] = True
            return {"mesaj": f"Hazırlık kaydedildi ({n} kalem)"}
        if any(x.gonderilen is None for x in b.satirlar):
            raise HTTPException(400, "Her kalem için VAR / KISMİ / YOK seç")
        if c["kuru"] and not __import__("evvel_yeni_cekirdek").deneme_mi(cur, c["gun"], b.hedef):
            c["kalici"] = True   # 🧪 pilot şubeye gönderim: depo şubesi denemede olsa da sevk GERÇEK (geri alınmaz)
        r = S.yola_cikar(cur, depo_sube=str(sube_id), hedef_sube=b.hedef, kim=kim, istek_id=b.istek_id[:58],
                         satirlar=[{"yon_id": x.yon_id, "siparis_id": x.siparis_id, "surum": x.surum, "gonderilen": x.gonderilen} for x in b.satirlar])
        _olay(cur, sube_id=sube_id, tur="sevk_cikis", is_gunu=c["gun"], kok=panel_kok("sevk", sube_id, b.istek_id), kaynak_tablo="panel",
              personel_id=p["id"], personel_ad=p["ad"], veri={"hedef": b.hedef, "parti_id": r.get("parti_id"), "istek_id": b.istek_id})
        return {"parti_id": r.get("parti_id"), "mesaj": (f"🚚 {r['kalem']} ürün yola çıktı" if r.get("kalem") else "Gönderilen ürün yok")
                + (f" · {r['yok']} kalem YOK — merkez yeniden karar verecek" if r.get("yok") else "")
                + (f" · {r['kismi']} kalem kısmi — kalanı merkeze döndü" if r.get("kismi") else "")}
    return _calistir(sube_id, b.istek_id, is_, tur="gonderilecek", govde=b.model_dump(mode="json"))


# ─────────────── BASAMAK 8 · TEDARİKÇİDEN TESLİM AL (sahip onayı 2026-10-19; PANEL_YENIDEN_KURULUM.md "BASAMAK 8") ───────────────
# TEK teslim kapısı (Tema = merkez depo da). Var olan Toptancı kurgusu ESAS: teslim_yaz (TEK KAYIT = TESLİM, borç teslimde) +
# Depo 'giris' (dışarı:toptanci → depo:şube) TEK işlemde. Toptancı kendiliğinden açılmaz; fiyat şube tutarından öğrenilmez (E5).
class TeslimAlBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    toptanci_id: str
    kalemler: List[Kalem]
    fatura_geldi: Optional[bool] = None   # zorunlu soru (eski "🧾 FATURA GELDİ Mİ?")
    tutar: Optional[TrTutar] = None       # EVET → faturadaki TOPLAM (zorunlu) · HAYIR → kâğıtta yazıyorsa
    fatura_no: Optional[str] = None
    aciklama: Optional[str] = None
    koli: Optional[dict] = None           # yalnız iz: {urun_id: {koli, koli_ici, tek}} (hesap ekranda)
    siparis_yon: Optional[List[str]] = None   # S5 (A10): seçilen "beklenen toptancı siparişi" kart satırları
    siparis_disi: bool = False   # Codex F (24 Eki): açık kart varken işaretlemeden aynı ürün → personel "sipariş dışı" diye bilerek seçti
    istek_id: str


@router.post("/{sube_id}/teslim-al")
def teslim_al(sube_id: str, b: TeslimAlBody):
    _TUR = "teslim_al"
    if not _modul_acik("toptanci"):
        raise HTTPException(503, "Toptancılar modülü kapalı — teslim şu an alınamıyor, merkeze haber ver")
    def is_(cur, c):
        import hashlib
        from evvel_yeni_depo_api import hareket_yaz
        from evvel_yeni_toptanci_api import teslim_yaz
        _gun_acik_mi(cur, c, sube_id)   # eski: gün kapalıyken teslim alınmaz (merkez girer)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        from evvel_yeni_tanim_api import tanim_oku   # toptancı tablosu Tanımlar'ın (F#27)
        t = tanim_oku(cur, "ey_toptanci", b.toptanci_id, ("ad", "aktif"))
        if not t or not t["aktif"]:   # Fable: panel toptancı AÇMAZ (çift kimlik — eski hastalık)
            raise HTTPException(400, "Toptancı listede yok — merkeze haber ver")
        k = _kalemler(cur, b.kalemler, pasif_olur=True)
        if b.fatura_geldi is None:
            raise HTTPException(400, "🧾 Fatura geldi mi? — EVET ya da HAYIR seç")
        tutar = _tl(b.tutar, "Tutar") if b.tutar not in (None, "") else None
        if tutar == 0:
            tutar = None
        if b.fatura_geldi and not tutar:
            raise HTTPException(400, "Fatura geldiyse faturadaki TOPLAM tutarı yaz")
        if not b.siparis_disi and _modul_acik("siparis"):   # Codex F (24 Eki): kart işaretlenmeden teslim → sipariş sonsuza "bekleniyor" kalıyordu
            from evvel_yeni_siparis_api import toptanci_beklenen
            acik = next((g for g in toptanci_beklenen(cur, str(sube_id)) if str(g["toptanci_id"]) == str(t["id"])), {"kalemler": []})["kalemler"]
            secili = set(b.siparis_yon or [])
            bagli_urun = {y["urun_id"] for y in acik if y["yon_id"] in secili}   # o üründen bir kart işaretlendiyse teslim zaten bağlı (sim 24 Eki F3)
            bagsiz = sorted({y["ad"] for y in acik if y["urun_id"] in {x["urun_id"] for x in k} and y["urun_id"] not in bagli_urun})
            if bagsiz:
                raise HTTPException(409, f"Açık sipariş kartı var: {', '.join(bagsiz[:3])} — kartı işaretle ya da 'Sipariş dışı teslim' seç")
        ozet = hashlib.sha1(json.dumps(sorted((x["urun_id"], x["adet"]) for x in k)).encode()).hexdigest()[:16] + ":" + str(t["id"])
        if not c["kuru"]:   # Fable: "kaydedildi mi?" deyip yeni istekle ikinci basış → 3 dk aynı içerik kilidi (eski SUBE-004)
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_teslim_al:{sube_id}",))
            _geri = {(o.get("v") or {}).get("teslim_ref") for o in __import__("evvel_yeni_olay").panel_olaylari(
                cur, sube_id=str(sube_id), bas=c["gun"], son=c["gun"], turler={"teslim_geri_al"})} - {None}   # geri alınan teslim kilidi tutmaz
            if __import__("evvel_yeni_olay").yakin_ayni_olay(cur, sube_id=str(sube_id), tur="teslim_al", veri_alan="ozet", deger=ozet, haric_kokler=_geri,
                                                             dakika=3, istek_haric=b.istek_id):
                raise HTTPException(409, "Bu teslim az önce kaydedildi — tekrar gönderme. Gerçekten ikinci teslimse 3 dk sonra dene.")
        kok = panel_kok("teslim", sube_id, b.istek_id)
        kalem_veri = [{"urun_id": x["urun_id"], "ad": x["ad"], "adet": x["adet"]} for x in k]
        oid = _olay(cur, sube_id=sube_id, tur="teslim_al", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"], tutar=(Decimal(tutar) / 100 if tutar else None),
                    veri={"toptanci_id": t["id"], "toptanci_ad": t["ad"], "kalemler": kalem_veri, "fatura_geldi": bool(b.fatura_geldi),
                          "tutar": tutar, "fatura_no": (b.fatura_no or "").strip()[:40] or None, "aciklama": (b.aciklama or "").strip()[:300] or None,
                          "koli": b.koli or None, "ozet": ozet, "istek_id": b.istek_id})
        tid = None
        if oid is not None:
            tid = teslim_yaz(cur, kaynak_ref=kok, toptanci_id=t["id"], toptanci_ad=t["ad"], sube_id=str(sube_id), gun=c["gun"],
                             kalemler=[{"urun_id": x["urun_id"], "urun_ad": x["ad"], "adet": x["adet"]} for x in k],
                             fatura_geldi=bool(b.fatura_geldi), kesin_tutar=tutar, fatura_no=b.fatura_no, teslim_alan=p["ad"],
                             aciklama=b.aciklama, kesin_kaynak="şube")
            for i, x in enumerate(k):
                hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="giris", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                            kaynak="dışarı:toptanci", hedef=f"depo:{sube_id}", kim=f"{KIM} · {p['ad']}", bag=kok, gun=c["gun"],
                            aciklama=f"{t['ad']} teslimi")
            if b.siparis_yon and tid:
                if not _modul_acik("siparis"):
                    raise HTTPException(503, "Sipariş modülü kapalı — kart seçmeden teslim al ya da merkeze haber ver")
                from evvel_yeni_siparis_api import teslime_bagla
                teslime_bagla(cur, sube_id=str(sube_id), teslim_id=tid, toptanci_id=t["id"], yon_idler=b.siparis_yon)
        return {"olay": oid, "teslim_id": tid, "tekrar": oid is None, "toptanci": t["ad"],
                "mesaj": f"✅ {t['ad']} teslimi kaydedildi — {len(k)} kalem / {sum(x['adet'] for x in k)} adet"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class TeslimGeriAlBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str                  # geri alan — QR'la içeride + Tanımlar'da 'Hatalı teslimi geri alabilir' yetkisi (S9)
    pin: Optional[str] = None
    teslim_id: str
    sebep: str
    istek_id: str


@router.post("/{sube_id}/teslim-geri-al")
def teslim_geri_al(sube_id: str, b: TeslimGeriAlBody):
    """S9 (sahip: "yetkili personel geri alabilsin") — eski "Hatalı? Geri Al". Yalnız BU şubenin BUGÜNKÜ panel teslimi, gün açıkken,
    merkez teslimi işlemeden (tutar düzeltmesi yok). İptal = Toptancılar'ın TEK iptal yolu (borç düşer + depo girişi geri + sipariş çözülür).
    Merkez Toptancılar'da 'iptal · şube geri aldı · kişi · sebep' olarak görür (Bekleyen işler'e düşmez — karar gerektirmez)."""
    _TUR = "teslim_geri_al"
    if not _modul_acik("toptanci"):
        raise HTTPException(503, "Toptancılar modülü kapalı — merkeze haber ver")
    sebep = (b.sebep or "").strip()
    if len(sebep) < 3:
        raise HTTPException(400, "Neden geri alındığını yaz (ör. yanlış tedarikçi seçildi)")
    if not _modul_acik("depo"):   # Fable P3: personele merkez dili gitmesin (depo girişi de geri alınmalı)
        raise HTTPException(503, "Depo modülü kapalı — geri almak için merkeze haber ver")
    def is_(cur, c):
        from evvel_yeni_tanim_api import tanim_oku
        from evvel_yeni_toptanci_api import panel_teslim_kilitle, teslim_iptal_et
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        if not (tanim_oku(cur, "ey_personel", p["id"], ("yetki_geri_alma",)) or {}).get("yetki_geri_alma"):   # Fable P3: PIN'den ÖNCE
            raise HTTPException(400, "Geri alma yetkin yok — yetkili arkadaşına ya da merkeze haber ver")       # (PIN sayacı harcanmasın)
        _pin(cur, p, b.pin)
        t = panel_teslim_kilitle(cur, b.teslim_id, str(sube_id))   # Toptancılar'ın PUBLIC kapısı (Fable P2: tabloya doğrudan SQL yok)
        if not t:
            raise HTTPException(404, "Teslim bulunamadı — sayfayı yenile")
        if t["iptal"]:
            return {"tekrar": True, "mesaj": "Bu teslim zaten geri alınmıştı ✓"}
        if t["tarih"] != c["gun"]:
            raise HTTPException(409, "Yalnız bugünkü teslim geri alınır — merkeze haber ver")
        if t["merkez_isledi"]:
            raise HTTPException(409, "Merkez bu teslimi işlemiş — geri almak için merkeze haber ver")
        kok = panel_kok("teslim_geri", sube_id, b.teslim_id)   # teslim başına TEK geri alma
        oid = _olay(cur, sube_id=sube_id, tur="teslim_geri_al", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"],
                    veri={"teslim_id": b.teslim_id, "teslim_ref": t["ref"], "sebep": sebep[:200], "istek_id": b.istek_id})
        if oid is None:
            return {"tekrar": True, "mesaj": "Bu teslim zaten geri alınmıştı ✓"}
        # sonradan sayılmış ürün varsa iptal_et 409 atar → bütün işlem (olay dahil) geri alınır (Fable P2: sessiz stok fazlası yok)
        ek = teslim_iptal_et(cur, b.teslim_id, sebep, sayilan_varsa_dur=True, sube_kim=p["ad"])
        # personele yalnız "geri alındı" — depo/sipariş ayrıntısı merkez kaydında (Toptancılar iptal sebebi + olay)
        return {"olay": oid, "tekrar": False, "merkez_uyarilari": [ek.strip(" ·")] if ek else None,
                "mesaj": "↩ Teslim geri alındı — doğrusunu yeniden girebilirsin"}
    try:
        return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))
    except psycopg2.errors.DeadlockDetected:   # Fable P2: merkez 'Yola çıkar' ile çapraz kilit → personele 500 değil 'yeniden dene'
        raise HTTPException(409, "Şu an başka bir işlem sürüyor — birkaç saniye sonra yeniden dene")


@router.post("/{sube_id}/urun-ac")
def urun_ac(sube_id: str, b: UrunAcBody):
    """Ürün aç — BÜTÜN katalog (sahip: "bütün mekanizma", Basamak 5). Sahip (2026-10-19): açılış/kapanışta YALNIZ tezgah sayılır.
    Panelde sayılan (panel_sayim: bardak/süt/su…) → depo:şube → bar:şube (taşıma; tüketimi bar sayım farkı) · diğer HER ürün
    (açılınca biten ya da depoda dönem sayımlı: kahve, şurup, toz…) → depo:şube → dışarı:tuketim (= gider; eski panel kuralı,
    Fable 2026-10-19). Eksi stok ENGELLENMEZ (merkeze iş)."""
    _TUR = "urun_ac"
    def is_(cur, c):
        from evvel_yeni_depo_api import hareket_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        k = _kalemler(cur, b.kalemler, pasif_olur=True)
        if any(__import__("evvel_yeni_urun_api").gununde_tuketilir(x) for x in k):   # sahip P1: pasta depoya girerken tüketildi — açılırsa çift gider
            raise HTTPException(400, "Pasta gibi gününde tüketilen ürün Ürün Aç'ta açılmaz — listeyi yenileyin")
        kok = panel_kok("ac", sube_id, b.istek_id)
        oid = _olay(cur, sube_id=sube_id, tur="urun_ac", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                       personel_id=p["id"], personel_ad=p["ad"], veri={"kalemler": k, "aciklama": (b.aciklama or "").strip()[:200] or None})
        for i, x in enumerate(k):
            if oid is None:   # tekrar gönderim
                continue
            if x["panel_sayim"]:   # tezgahta sayılan (bardak, süt, su…) → bara TAŞINIR; tüketimi bar sayım farkı verir (çift gider yok)
                hedef = f"bar:{sube_id}"
            else:                  # diğer her şey (kahve, şurup, toz, kapak, temizlik…) açılınca GİDER — eski panel kuralı;
                hedef = "dışarı:tuketim"   # merkez depo sayımındaki fark ayrıca 'kayıp/fazla' görünür (gidere karışmaz)
            hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="ac", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                        kaynak=f"depo:{sube_id}", hedef=hedef, kim=f"{KIM} · {p['ad']}", bag=kok, gun=c["gun"])
        return {"olay": oid, "tekrar": oid is None, "mesaj": f"{len(k)} kalem · {sum(x['adet'] for x in k)} adet açıldı"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


class IadeBilgi(BaseModel):
    sebep: Optional[str] = None       # IADE_SEBEPLERI (zorunlu — eski panel soruyordu ama kaydetmiyordu)
    fis_no: str
    iade_saat: str                    # "HH:MM"
    musteri_ad: Optional[str] = None  # personele GÖSTERİLMEZ (yalnız merkez)
    musteri_tel: Optional[str] = None


class FireBody(BaseModel):
    istemci_gunu: Optional[str] = None   # tabletin formu açtığı iş günü (gün değiştiyse kayıt merkeze iletilir)
    personel_id: str
    pin: Optional[str] = None          # 4 hane — doğrulanır, hiçbir yere yazılmaz
    kalemler: List[Kalem]
    sebep: str                         # FIRE_SEBEPLERI kodu
    aciklama: Optional[str] = None     # 'diger' için zorunlu
    iade: Optional[IadeBilgi] = None   # 'iade' için zorunlu
    hazirlik_turu: Optional[str] = None   # 'hazirlik_deneme' için zorunlu (HAZIRLIK_TURLERI)
    istek_id: str


@router.post("/{sube_id}/fire")
def fire(sube_id: str, b: FireBody):
    """Fire: Depo 'fire' depo:şube (tezgahta sayılan ürün: bar:şube) → dışarı:fire (sebep zorunlu)."""
    _TUR = "fire"
    def is_(cur, c):
        from evvel_yeni_depo_api import hareket_yaz
        _gun_acik_mi(cur, c, sube_id)
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        if b.sebep not in FIRE_SEBEPLERI:
            raise HTTPException(400, "Fire sebebini seç")
        aciklama = (b.aciklama or "").strip()[:200]
        if b.sebep == "diger" and len(aciklama) < 10:
            raise HTTPException(400, "Ne olduğunu en az 10 harfle yaz")   # eski kural (Diğer ≥10)
        hazirlik = None
        if b.sebep == "hazirlik_deneme":
            if b.hazirlik_turu not in HAZIRLIK_TURLERI:
                raise HTTPException(400, "Ne oldu? — yanlış ürün / bardak değişti / deneme seç")
            hazirlik = b.hazirlik_turu
        iade = None
        if b.sebep == "iade":
            m_ = re.fullmatch(r"(\d{1,2}):(\d{2})", (b.iade.iade_saat or "").strip()) if b.iade else None
            if not b.iade or b.iade.sebep not in IADE_SEBEPLERI:
                raise HTTPException(400, "İade sebebini seç")
            if not (b.iade.fis_no or "").strip() or not m_ or int(m_.group(1)) > 23 or int(m_.group(2)) > 59:
                raise HTTPException(400, "İadede fiş numarası ve iade saati zorunlu")
            _sim = _simdi_tr()
            _n, _t = _sim.hour * 60 + _sim.minute, int(m_.group(1)) * 60 + int(m_.group(2))
            if not (_n < 120 and _t >= 120) and _t > _n + 5:   # Fable D6-S: ileri saat yazılmasın (gece yarısı sonrası: dünkü saat geçerli)
                raise HTTPException(400, "İade saati şu andan ileri olamaz")
            iade = {"sebep": b.iade.sebep, "sebep_ad": IADE_SEBEPLERI[b.iade.sebep],
                    "fis_no": b.iade.fis_no.strip()[:40], "iade_saat": b.iade.iade_saat.strip(),
                    "musteri_ad": (b.iade.musteri_ad or "").strip()[:80] or None,
                    "musteri_tel": re.sub(r"[^\d+]", "", b.iade.musteri_tel or "")[:20] or None}
        sebep_ad = FIRE_SEBEPLERI[b.sebep]
        k = _kalemler(cur, b.kalemler)
        kok = panel_kok("fire", sube_id, b.istek_id)
        oid = _olay(cur, sube_id=sube_id, tur="fire", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"],
                    veri={"kalemler": k, "sebep": b.sebep, "sebep_ad": sebep_ad, "aciklama": aciklama or None, "iade": iade,
                          "hazirlik_turu": hazirlik, "hazirlik_ad": HAZIRLIK_TURLERI.get(hazirlik) if hazirlik else None})
        hedef = FIRE_HEDEF.get(b.sebep, "dışarı:fire")
        for i, x in enumerate(k):
            if x.get("takip") == "gununde":
                continue   # Fable D6-B: pasta girişte 'gününde tüketildi' (gider) — fire hareketi çift gider + eksi depo yapardı; olayda kalır
            # Sahip (20 Eki, Fable D-4): tezgahta sayılan ürünün (süt / su / bardak) firesi BARDAN düşer — depodan düşerse bir sonraki
            # depo sayımında sahte fazla çıkıyordu. Maliyeti bar sayım farkında (Gider bu satırı ayrıca yazmaz — kaynak 'bar:').
            tezgah = x.get("panel_sayim")   # _kalemler tezgahta_sayilir ile doldurur (TEK kural)
            hareket_yaz(cur, kaynak_ref=f"{kok}:{i}", tur="fire", urun_id=x["urun_id"], urun_ad=x["ad"], adet=x["adet"],
                        kaynak=f"{'bar' if tezgah else 'depo'}:{sube_id}", hedef=hedef, kim=f"{KIM} · {p['ad']}",
                        aciklama=sebep_ad + (f" ({HAZIRLIK_TURLERI[hazirlik]})" if hazirlik else "") + (f" — {aciklama}" if aciklama else "")
                        + (f" · {iade['sebep_ad']} · fiş {iade['fis_no']}" if iade else ""),
                        bag=kok, gun=c["gun"])
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Fire kaydedildi"}
    return _calistir(sube_id, b.istek_id, is_, tur=_TUR, govde=b.model_dump(mode="json"))


# ─────────────────────────── 📝 MERKEZ NOTU (Fable + Codex 21 Eki · Tema 470 ₺ dersi) ───────────────────────────
# Şube personeli merkeze not yazar (ad + PIN, ≥3 harf) → olay 'not' (iş günü 02:00 kuralı). KURAL: 'not' türünü YALNIZ insan yazar —
# sistem bildirimi bu türe ASLA yazılmaz (eski sube_merkez_not'ta 169 notun 166'sı sistem satırıydı, gerçek not gömülüyordu).
# Merkez: Bekleyen işler › 📝 Şube notları (ayrı alan, sahip 21 Eki) · 'Gördüm' ile düşer · Kasa farkın altında aynı günün notunu gösterir.
# Eski tabloya köprü / kopya YOK (1 Kasım'a kadar eski notlar eski Operasyon Merkezi'nde).
NOT_EN_AZ, NOT_EN_COK = 3, 2000


class NotBody(BaseModel):
    istemci_gunu: Optional[str] = None
    personel_id: str
    pin: Optional[str] = None          # doğrulanır, hiçbir yere yazılmaz
    metin: str
    istek_id: str


@router.post("/{sube_id}/not")
def merkez_notu(sube_id: str, b: NotBody):
    """📝 Merkez notu — iade, sorun, kasa hatası… Para / stok yazmaz."""
    def is_(cur, c):
        p = _personel(cur, sube_id, b.personel_id)
        _pin(cur, p, b.pin)
        metin = re.sub(r"\s+", " ", (b.metin or "")).strip()
        if len(metin) < NOT_EN_AZ:
            raise HTTPException(400, "Notu yaz (en az 3 harf)")
        metin = metin[:NOT_EN_COK]
        if __import__("evvel_yeni_olay").yakin_ayni_olay(cur, sube_id=str(sube_id), tur="not", veri_alan="metin", deger=metin,
                                                         dakika=2, istek_haric=b.istek_id):
            raise HTTPException(409, "Bu not az önce gönderildi")
        oid = _olay(cur, sube_id=sube_id, tur="not", is_gunu=c["gun"], kok=panel_kok("not", sube_id, b.istek_id), kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"], veri={"metin": metin, "istek_id": b.istek_id})
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Not merkeze iletildi"}
    return _calistir(sube_id, b.istek_id, is_, tur="not", govde=b.model_dump(mode="json", exclude={"istemci_gunu"}))   # gün değişse de not kaybolmasın


def sube_notlari(cur, sube_id: Optional[str] = None, bas=None, son=None, gorulmemis: bool = False) -> list:
    """PUBLIC — şube notları (yalnız insan; 'not' türü). Her satır: id, sube_id, is_gunu (ISO), saat, personel, metin, goruldu.
    Kasa (fark altında) ve Bekleyen işler AYNI okuyucuyu kullanır."""
    from evvel_yeni_olay import panel_olaylari
    out = []
    for o in panel_olaylari(cur, sube_id=sube_id, bas=bas, son=son, turler={"not"}):
        v = o["v"] or {}
        if gorulmemis and v.get("goruldu"):
            continue
        g = o["is_gunu"]
        out.append({"id": o["id"], "sube_id": str(o["sube_id"]), "is_gunu": g.isoformat() if hasattr(g, "isoformat") else str(g)[:10],
                    "saat": _saat_tr(o["olay_zamani"], g if hasattr(g, "isoformat") else None) or "", "personel": o.get("personel_ad") or "—",
                    "metin": v.get("metin") or "", "goruldu": v.get("goruldu")})
    return out


def _not_isleri(cur, baglam: dict) -> list:
    """Bekleyen işler › 📝 Şube notları — yalnız GÖRÜLMEMİŞ insan notları, panel başlangıcından sonra (deneme dönemi iş üretmez)."""
    from evvel_yeni_tanim_api import adlar
    bas = _baslangic(cur)
    sad = adlar(cur, "ey_sube")
    return [{"genel": True, "grup": "not", "tur": "sube_not", "id": f"not:{n['id']}", "tarih": n["is_gunu"], "etiket": "📝 Şube notu",
             "ad": f"{sad.get(n['sube_id'], n['sube_id'])} · {n['personel']}", "alt": n["metin"] + f" · {n['saat']}",   # Codex P2: notun TAMAMI (Gördüm'den önce okunsun)
             "gordum": {"yol": "/evvel-yeni/panel/not-gordum", "govde": {"id": n["id"]}}}
            for n in sube_notlari(cur, bas=bas, gorulmemis=True)
            if str(n["is_gunu"])[:10] >= _baslangic(cur, str(n["sube_id"])).isoformat()]   # 🧪 pilot dışı şubenin deneme notu iş değil


bekleyen_is_kaydet("sube_not", _not_isleri)


class NotGordumBody(BaseModel):
    id: str


@router.post("/not-gordum")
def not_gordum(body: NotGordumBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: şube notunu gördü (iz: kim, ne zaman) — Bekleyen işler'den düşer; Kasa farkının altında görünmeye devam eder."""
    from evvel_yeni_olay import olay_veri_ekle
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)
        if not any(n["id"] == body.id for n in sube_notlari(cur)):
            raise HTTPException(404, "Not bulunamadı")
        olay_veri_ekle(cur, body.id, {"goruldu": {"kim": kim, "zaman": _simdi_tr().isoformat(timespec="seconds")}})
    return {"ok": True}


# ─────────────────────────── MERKEZ: geç kapanış (reddedilen / hata veren kapanış) ───────────────────────────
# ─────────────────────────── R1 · İŞLEM SONUNDA QR İLE ONAY (sahip 2026-10-18 — "Adını seç" ve PIN yok) ───────────────────────────
# Panel formu doldurur → onay isteği (para/stok YAZILMAZ) → ekranda QR (+ onay kimliği) → personel KENDİ telefonuyla okutur → ONAYLA →
# kişi telefondan (istemciden gelmez), QR + konum yoklama modülünün PUBLIC servisleriyle doğrulanır → panelin MEVCUT yazma ucu o kişi adına
# çalışır (tek yazar). SUBE_PANELI_TASARIM.md §R1.
# ─────────────────────────── ⏱ ARA SAYIM (PANEL_YENIDEN_KURULUM.md 'ARA SAYIM' A1–A5 · Fable + Codex 21 Eki) ───────────────────────────
# Günde BİR kez, açılışta sunucuda gizlice seçilen rastgele saatte (açılış+60 dk … 20:30) panel 15 dk kilitlenir; çekmece KÖR sayılır,
# telefonla QR onaylanır. YENİ TABLO YOK: görev = ey_panel_onay satırı tur='ara_sayim' (planli → bekliyor → onaylandi / yapilmadi).
# Gün ortasında 'beklenen' HESAPLANAMAZ (nakit satış kapanışta) → Kasa'ya hareket YAZILMAZ (A2); kayıt olay 'ara_sayim' + iki sınır
# sağlaması Satış mutabakatında (A1): sayılan ≥ taban · kapanışta ara sonrası satış ≥ 0. Panele fark / uyarı DÖNMEZ (kör).
ARA_SAYIM_SURE_DK = 15
ARA_SAYIM_ILK_DK = 60          # açılıştan en erken
ARA_SAYIM_SON = (20, 30)       # en geç (kapanışla çakışmasın)
ARA_AKTIF = ("bekliyor", "hata", "isleniyor")   # süre içinde kilit + QR sürer (Fable D-A B2: onay 'hata'da görev sessizce kayboluyordu)


def _ara_iptal(cur, sube_id: str, gun, neden: str) -> None:
    """Gün kapanınca (ya da deneme yerine) o günün açık ara sayımı iptal — kapalı günde kilit / olay doğmasın (Fable D-A)."""
    if __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_panel_onay"):
        cur.execute("""UPDATE ey_panel_onay SET durum='iptal', mesaj=%s WHERE sube_id=%s AND tur='ara_sayim' AND govde->>'gun'=%s
                        AND durum IN ('planli','bekliyor','hata')""", (neden, str(sube_id), gun.isoformat()))


def _ara_satir(cur, sube_id: str, gun) -> Optional[dict]:
    if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_panel_onay"):
        return None
    cur.execute("""SELECT *, son < NOW() AS gecti FROM ey_panel_onay WHERE sube_id=%s AND tur='ara_sayim' AND govde->>'gun' = %s
                    AND durum <> 'iptal' ORDER BY olusturma DESC LIMIT 1""", (str(sube_id), gun.isoformat()))
    r = cur.fetchone()
    return dict(r) if r else None


def _ara_sayim_planla(cur, sube_id: str, gun) -> None:
    """Açılış işleminde BİR KEZ: saat sunucuda `secrets` ile seçilir; panele vakti gelene kadar DÖNMEZ (tahmin edilemez)."""
    import secrets
    from datetime import timedelta
    from evvel_yeni_cekirdek import is_gunu_zamani, simdi_tr
    if _ara_satir(cur, sube_id, gun):
        return
    bas, son = simdi_tr() + timedelta(minutes=ARA_SAYIM_ILK_DK), is_gunu_zamani(gun, *ARA_SAYIM_SON)
    if bas >= son:
        return   # geç açılış → o gün ara sayım yok, kayıt da yok (A3)
    plan = bas + timedelta(minutes=secrets.randbelow(int((son - bas).total_seconds() // 60) + 1))
    oid = "as-" + uuid.uuid4().hex[:16]
    cur.execute("""INSERT INTO ey_panel_onay (id, sube_id, tur, govde, ozet, durum, son)
                   VALUES (%s,%s,'ara_sayim',%s::jsonb,'Ara kasa sayımı','planli', %s)""",
                (oid, str(sube_id), json.dumps({"gun": gun.isoformat(), "plan_ts": plan.isoformat(), "oid": oid}), plan + timedelta(minutes=ARA_SAYIM_SURE_DK)))


def _ara_sayim_guncelle(cur, sube_id: str, gun) -> Optional[dict]:
    """Görevin durumunu ilerletir (idempotent): vakti gelen 'planli' → 'bekliyor' (15 dk başlar; açık açılış/kapanış telefon onayı
    varsa en geç 20:30'a kadar ERTELENİR) · süresi dolan 'bekliyor' → 'yapilmadi'. Dönüş: güncel satır ya da None."""
    from datetime import datetime
    from evvel_yeni_cekirdek import is_gunu_zamani, json_ac, simdi_tr
    r = _ara_satir(cur, sube_id, gun)
    if not r:
        return None
    if r["durum"] in ("planli",) + ARA_AKTIF and _gun_kapali(cur, sube_id, gun):
        _ara_iptal(cur, sube_id, gun, "gün kapandı")   # Fable D-A: kapanıştan sonra kilit / ara sayım olayı doğmasın
        return None
    simdi = simdi_tr()
    g = json_ac(r["govde"], {})
    if r["durum"] == "planli" and r["gecti"]:
        return r   # Fable son denetim S-1: vakti (plan + 15 dk) panel kapalıyken geçti → kilit yok, merkez 'açık değildi' görür
    if r["durum"] == "planli" and g.get("plan_ts") and simdi >= datetime.fromisoformat(g["plan_ts"]):
        cur.execute("""SELECT 1 FROM ey_panel_onay WHERE sube_id=%s AND tur IN ('acilis','kapanis') AND durum IN ('bekliyor','isleniyor')
                        AND son > NOW() LIMIT 1""", (str(sube_id),))
        mesgul = bool(cur.fetchone())
        if not mesgul:   # Fable D-A: açık KASA DEVRİ (para el değiştirirken) de erteler — Yoklama'nın kapısı, yumuşak bağ
            yk = _yoklama()
            if yk is not None:
                try:
                    with savepoint(cur, "sp_ara_devir"):
                        dv = yk.devir_durum(cur, str(sube_id), gun)
                    mesgul = bool(dv and dv.get("durum") in yk.DEVIR_ACIK)
                except Exception:  # noqa: BLE001
                    log.warning("ara sayım: devir durumu okunamadı", exc_info=True)
        if mesgul and simdi < is_gunu_zamani(gun, *ARA_SAYIM_SON):
            cur.execute("""UPDATE ey_panel_onay SET son = NOW() + %s * INTERVAL '1 minute', govde = govde || '{"ertelendi": true}'::jsonb
                            WHERE id=%s AND durum='planli'""", (ARA_SAYIM_SURE_DK, r["id"]))   # ertelendi — Bekleyen işler 'yapılmadı' saymasın
            return _ara_satir(cur, sube_id, gun)
        cur.execute("""UPDATE ey_panel_onay SET durum='bekliyor', son = NOW() + %s * INTERVAL '1 minute', govde = govde || %s::jsonb
                        WHERE id=%s AND durum='planli'""", (ARA_SAYIM_SURE_DK, json.dumps({"istenme": simdi.isoformat()}), r["id"]))
        return _ara_satir(cur, sube_id, gun)
    if r["durum"] in ARA_AKTIF and r["gecti"]:
        cur.execute("""UPDATE ey_panel_onay SET durum='yapilmadi', mesaj=COALESCE(NULLIF(mesaj, ''), '15 dk içinde sayılmadı')
                        WHERE id=%s AND durum IN ('bekliyor','hata','isleniyor')""", (r["id"],))   # Fable D-A B2: hata/takılı da 'yapılmadı'
        return _ara_satir(cur, sube_id, gun)
    return r


def _ara_taban(cur, sube_id: str, gun) -> dict:
    """Sınır 1 tabanı (kuruş): sabah açılış sayımı − o ana kadar çekmece çıkışı (Kasa PUBLIC) − ara teslim (olay). Açılış yoksa None."""
    from evvel_yeni_olay import panel_olaylari
    acilis, ara = None, 0
    for o in panel_olaylari(cur, sube_id=str(sube_id), bas=gun, son=gun, turler={"acilis", "teslim"}):
        if o["tur"] == "acilis":
            acilis = int(o["v"].get("kasa_sayim") or 0)
        else:
            ara += int(o["v"].get("tutar") or 0)
    cikis = 0
    if not _modul_acik("kasa"):
        return {"acilis": acilis, "cekmece_cikis": None, "ara_teslim": ara, "taban": None}
    try:
        with savepoint(cur, "sp_ara_cekmece"):
            from evvel_yeni_kasa_api import cekmece_cikislari
            cikis = sum(_kurus(c["tutar"]) for c in cekmece_cikislari(cur, gun.isoformat()) if str(c["sube_id"]) == str(sube_id))
    except Exception:  # noqa: BLE001 — Kasa okunamazsa taban bilinmez (uyarı üretilmez, sahte alarm yok)
        log.warning("ara sayım: çekmece çıkışları okunamadı", exc_info=True)
        return {"acilis": acilis, "cekmece_cikis": None, "ara_teslim": ara, "taban": None}
    return {"acilis": acilis, "cekmece_cikis": cikis, "ara_teslim": ara, "taban": (acilis - cikis - ara) if acilis is not None else None}


class AraSayimBody(BaseModel):
    personel_id: str
    gun: str
    oid: str
    sayilan: Optional[int] = None      # kuruş (panel 'Sayımı gönder' ile yazar)
    istenme: Optional[str] = None
    plan_ts: Optional[str] = None


def ara_sayim_yaz(sube_id: str, b: AraSayimBody) -> dict:
    """Telefon ONAYLA → olay 'ara_sayim' (sayan = telefonun sahibi). Kasa'ya hareket YOK (A2). Yanıtta fark / uyarı YOK (kör)."""
    if b.sayilan is None:
        raise HTTPException(400, "Önce çekmecedeki parayı yazıp 'Sayımı gönder' de")
    _TUR = "ara_sayim"

    def is_(cur, c):
        from evvel_yeni_cekirdek import simdi_tr
        if c["gun"].isoformat() != b.gun:
            raise HTTPException(409, "Bu ara sayım bugünün değil")
        p = _personel(cur, sube_id, b.personel_id)
        t = _ara_taban(cur, sube_id, c["gun"])
        kok = panel_kok("ara_sayim", sube_id, b.gun)
        oid = _olay(cur, sube_id=sube_id, tur="ara_sayim", is_gunu=c["gun"], kok=kok, kaynak_tablo="panel",
                    personel_id=p["id"], personel_ad=p["ad"], tutar=Decimal(b.sayilan) / 100,
                    veri={"sayilan": b.sayilan, **t, "plan": b.plan_ts, "istenme": b.istenme, "yapilma": simdi_tr().isoformat()})
        return {"olay": oid, "tekrar": oid is None, "mesaj": "Ara sayım kaydedildi"}
    return _calistir(sube_id, "ara-" + b.oid, is_, tur=_TUR, govde=b.model_dump(mode="json"))


ONAY_SURE_DK = 10
ONAY_TURLERI = {
    "acilis": (AcilisBody, lambda s, b: acilis(s, b), "Açılış"),
    "kapanis": (KapanisBody, lambda s, b: kapanis(s, b), "Kapanış"),
    "ara_sayim": (AraSayimBody, lambda s, b: ara_sayim_yaz(s, b), "Ara kasa sayımı"),   # görev sistemin (onay-iste ile açılmaz)
}   # sahip (2026-10-18): sık işlemler (ürün aç, fire, ara teslim, anlık gider, teslim al) QR DEĞİL — "giriş yapmış personelin adı + PIN" (R1b)
_ONAY_HAZIR = False


def _onay_hazirla() -> None:
    global _ONAY_HAZIR
    if _ONAY_HAZIR:
        return
    with db() as (_c, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012051)")
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_panel_onay (
            id TEXT PRIMARY KEY, sube_id TEXT NOT NULL, tur TEXT NOT NULL, govde JSONB NOT NULL, ozet TEXT,
            durum TEXT NOT NULL DEFAULT 'bekliyor', personel_id TEXT, personel_ad TEXT, mesaj TEXT, sonuc JSONB,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW(), son TIMESTAMPTZ NOT NULL, islenme TIMESTAMPTZ)""")
    _ONAY_HAZIR = True


# ─────────────── PANEL TASLAĞI (eski /urun-ac/taslak — sahip: "fonksiyon kaybı istemiyorum") ───────────────
# Seçimler SUNUCUDA da durur: tarayıcı verisi silinse / panel başka PC'ye taşınsa yarım iş geri gelir. PIN ASLA yazılmaz.
TASLAK_TURLERI = {"urun_ac"}
_TASLAK_HAZIR = False


def _taslak_hazirla() -> None:
    global _TASLAK_HAZIR
    if _TASLAK_HAZIR:
        return
    with db() as (_c, cur):
        cur.execute("SELECT pg_advisory_xact_lock(7012052)")
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_panel_taslak (
            sube_id TEXT NOT NULL, tur TEXT NOT NULL, is_gunu DATE NOT NULL, veri JSONB NOT NULL, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (sube_id, tur, is_gunu))""")
    _TASLAK_HAZIR = True


class TaslakBody(BaseModel):
    gun: str
    veri: dict


def _taslak_gun(gun: str):
    try:
        return date.fromisoformat(str(gun)[:10])
    except ValueError:
        raise HTTPException(400, "Gün geçersiz")


@router.get("/{sube_id}/taslak/{tur}")
def taslak_oku(sube_id: str, tur: str, gun: str):
    if tur not in TASLAK_TURLERI:
        raise HTTPException(404, "Taslak yok")
    _taslak_hazirla()
    with db() as (conn, cur):
        cur.execute("SELECT veri FROM ey_panel_taslak WHERE sube_id=%s AND tur=%s AND is_gunu=%s", (sube_id, tur, _taslak_gun(gun)))
        r = cur.fetchone()
    return {"veri": dict(r)["veri"] if r else None}


@router.post("/{sube_id}/taslak/{tur}", dependencies=_IMZALI)
def taslak_yaz(sube_id: str, tur: str, b: TaslakBody):
    if tur not in TASLAK_TURLERI:
        raise HTTPException(404, "Taslak yok")
    v = {k: x for k, x in (b.veri or {}).items() if k != "pin"}   # PIN asla
    ham = json.dumps(v, ensure_ascii=False, default=str)
    if len(ham) > 50000:
        raise HTTPException(400, "Taslak çok büyük")
    _taslak_hazirla()
    with db() as (conn, cur):
        _sube(cur, sube_id)
        cur.execute("""INSERT INTO ey_panel_taslak (sube_id, tur, is_gunu, veri) VALUES (%s,%s,%s,%s::jsonb)
                       ON CONFLICT (sube_id, tur, is_gunu) DO UPDATE SET veri=EXCLUDED.veri, zaman=NOW()""",
                    (sube_id, tur, _taslak_gun(b.gun), ham))
    return {"ok": True}


@router.delete("/{sube_id}/taslak/{tur}", dependencies=_IMZALI)
def taslak_sil(sube_id: str, tur: str, gun: str):
    if tur not in TASLAK_TURLERI:
        raise HTTPException(404, "Taslak yok")
    _taslak_hazirla()
    with db() as (conn, cur):
        cur.execute("DELETE FROM ey_panel_taslak WHERE sube_id=%s AND tur=%s AND is_gunu=%s", (sube_id, tur, _taslak_gun(gun)))
    return {"ok": True}


def _tl_yaz(x) -> str:
    """₺ sayı → '1.234,50 ₺' — çekirdek tl (kuruştan) TEK biçim (Dalga 4, F#5)."""
    from evvel_yeni_cekirdek import kurus_yuvarla, tl
    try:
        return tl(kurus_yuvarla(x))
    except Exception:  # noqa: BLE001
        return str(x)


def _onay_ozet(cur, tur: str, g: dict) -> str:
    """Telefonda gösterilecek tek satır özet (personel ne onayladığını görür)."""
    def adlar(kalemler):
        ids = [str(k.get("urun_id")) for k in kalemler or [] if k.get("urun_id")]
        try:
            u = _urunler(cur, ids) if ids else {}
        except HTTPException:
            u = {}
        return ", ".join(f"{(u.get(str(k.get('urun_id'))) or {}).get('ad', '?')} × {k.get('adet') if k.get('adet') is not None else k.get('sayilan')}" for k in kalemler or [])
    if tur == "acilis":   # Codex: telefonda her kalemin adı ve sayısı (kişi neyi onayladığını görsün)
        return (f"Kasa {_tl_yaz(g.get('kasa_sayim', 0))} · " + adlar(g.get("sayim"))
                + (f" · pasta {g['pasta_toplam']}" if g.get("pasta_toplam") not in (None, "") else ""))
    if tur == "kapanis":
        tes = " · teslim " + ", ".join(f"{str(t.get('alan', '')).split(':')[-1].capitalize()} {_tl_yaz(t.get('tutar', 0))}" for t in g.get("teslimler") or []) if g.get("teslimler") else ""
        return (f"Nakit {_tl_yaz(g.get('nakit', 0))} · POS {_tl_yaz(g.get('pos', 0))} · online {_tl_yaz(g.get('online', 0))}"
                f" · çekmece {_tl_yaz(g.get('kor_sayim') or 0)}{tes} · bırakılan {_tl_yaz(g.get('birakilan') or 0)} · " + adlar(g.get("sayim"))
                + (f" · pasta {g['pasta_toplam']}" if g.get("pasta_toplam") not in (None, "") else ""))
    if tur == "ara-teslim":
        return f"{str(g.get('alan', '')).split(':')[-1].capitalize()}'a {_tl_yaz(g.get('tutar', 0))} teslim"
    if tur in ("urun-ac", "fire"):
        return adlar(g.get("kalemler")) + (f" · sebep {g.get('sebep_ad') or FIRE_SEBEPLERI.get(g.get('sebep'), g.get('sebep'))}" if tur == "fire" else "")
    return ""


class OnayIsteBody(BaseModel):
    tur: str
    govde: dict


@router.post("/{sube_id}/onay-iste", dependencies=_IMZALI)
def onay_iste(sube_id: str, b: OnayIsteBody):
    """Panel: form hazır → onay isteği. Biçim burada denetlenir (telefon geçersiz form görmesin); kayıt telefon onaylayınca yazılır."""
    if _yoklama() is None:
        raise HTTPException(503, "QR sistemi çalışmıyor — merkeze haber ver")
    if b.tur not in ONAY_TURLERI or b.tur == "ara_sayim":
        raise HTTPException(400, "Bu işlem QR ile onaylanmaz")
    Body, _f, ad = ONAY_TURLERI[b.tur]
    try:
        g = Body(**{**(b.govde or {}), "personel_id": "-"}).model_dump(mode="json", exclude={"personel_id", "pin"})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Form eksik: {str(e)[:160]}")
    _onay_hazirla()
    oid = "on-" + uuid.uuid4().hex[:16]
    with db() as (conn, cur):
        _sube(cur, sube_id)
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{sube_id}:{b.tur}",))   # Codex: tek sıra
        cur.execute("""SELECT 1 FROM ey_panel_onay WHERE sube_id=%s AND tur=%s AND durum='isleniyor'
                       AND islenme > NOW() - INTERVAL '2 minutes' LIMIT 1""", (str(sube_id), b.tur))
        if cur.fetchone():
            raise HTTPException(409, "Önceki onay şu an telefondan işleniyor — birkaç saniye bekle")
        if b.tur == "acilis":
            _acilis_tam(cur, Body(**{**g, "personel_id": "-"}))
        elif b.tur == "kapanis":   # eski korumalar QR çıkmadan (telefon geçersiz form görmesin)
            if g.get("merkeze"):
                raise HTTPException(400, "Merkeze gönderim QR ile yapılmaz")
            _kapanis_tam(cur, Body(**{**g, "personel_id": "-"}))
        ozet = _onay_ozet(cur, b.tur, g)
        cur.execute("""UPDATE ey_panel_onay SET durum='iptal', mesaj='yerine yeni onay istendi'
                       WHERE sube_id=%s AND tur=%s AND durum IN ('bekliyor','hata')""", (str(sube_id), b.tur))
        cur.execute("""INSERT INTO ey_panel_onay (id, sube_id, tur, govde, ozet, son)
                       VALUES (%s,%s,%s,%s::jsonb,%s, NOW() + (%s || ' minutes')::interval)""",
                    (oid, str(sube_id), b.tur, json.dumps(g, ensure_ascii=False, default=str), ozet, str(ONAY_SURE_DK)))
    return {"ok": True, "onay_id": oid, "ad": ad, "ozet": ozet, "sure_dk": ONAY_SURE_DK,
            "mesaj": "Telefonunla ekrandaki QR'ı okut ve onayla"}


def _onay_oku(cur, oid: str) -> dict:
    cur.execute("SELECT *, son < NOW() AS gecti FROM ey_panel_onay WHERE id=%s", (oid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Onay bulunamadı")
    return dict(r)


@router.get("/onay/{oid}")
def onay_durum(oid: str):
    """Panel 2 sn'de bir sorar: bekliyor / onaylandi / hata / iptal / sure_doldu."""
    _onay_hazirla()
    with db() as (conn, cur):
        o = _onay_oku(cur, oid)
    durum = "sure_doldu" if o["durum"] in ("bekliyor", "hata") and o["gecti"] else o["durum"]
    sonuc = o.get("sonuc") if isinstance(o.get("sonuc"), dict) else {}
    return {"durum": durum, "mesaj": o["mesaj"], "kisi": o["personel_ad"], "ozet": o["ozet"], "tur": o["tur"],
            "kuru": bool((sonuc or {}).get("kuru")), "uyarilar": (sonuc or {}).get("uyarilar") or []}   # kapanış: EKSİK VAR kartı


@router.post("/onay/{oid}/iptal")
def onay_iptal(oid: str):
    _onay_hazirla()
    with db() as (conn, cur):
        cur.execute("UPDATE ey_panel_onay SET durum='iptal' WHERE id=%s AND durum IN ('bekliyor','hata') RETURNING id", (oid,))
        if not cur.fetchone():
            raise HTTPException(409, "Bu onay artık iptal edilemez")
    return {"ok": True, "mesaj": "Onay iptal edildi — form duruyor"}


@router.get("/onay/{oid}/ozet")
async def onay_ozet_telefon(oid: str, request: Request):
    """Telefon (imzalı): neyi onaylayacağını görür."""
    y = _yoklama()
    if y is None:
        raise HTTPException(400, "QR onayı kapalı")
    _onay_hazirla()

    def _is():
        with db() as (conn, cur):
            _c, p = y.telefon_kisisi(cur, request.headers, "GET", request.url.path, b"")   # Yoklama'nın tek kapısı (K4)
            o = _onay_oku(cur, oid)
            sube_ad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube", [o["sube_id"]]).get(str(o["sube_id"]))   # F#27
        return {"tur": o["tur"], "ad": ONAY_TURLERI.get(o["tur"], (None, None, o["tur"]))[2], "ozet": o["ozet"], "sube": o["sube_id"],
                "sube_ad": sube_ad, "kisi": p["ad"], "durum": "sure_doldu" if o["durum"] in ("bekliyor", "hata") and o["gecti"] else o["durum"],
                "mesaj": o["mesaj"]}
    return await run_in_threadpool(_is)


@router.post("/onay/{oid}/onayla")
async def onay_onayla(oid: str, request: Request):
    """Telefon (imzalı) ONAYLA: kişi telefondan, QR + konum doğrulanır → panelin mevcut yazma ucu o kişi adına çalışır."""
    y = _yoklama()
    if y is None:
        raise HTTPException(400, "QR onayı kapalı")
    _onay_hazirla()
    ham = await request.body()

    def _dogrula():
        with db() as (conn, cur):
            c, p = y.telefon_kisisi(cur, request.headers, "POST", request.url.path, ham)   # Yoklama'nın tek kapısı (K4)
            try:
                v = json.loads(ham) if ham else {}
            except ValueError:
                raise HTTPException(400, "İstek okunamadı")
            cur.execute("SELECT sube_id, tur FROM ey_panel_onay WHERE id=%s", (oid,))
            _sk = cur.fetchone()
            if _sk:   # onay-iste ile aynı sıra kilidi (yeni QR istenirken eski onay işlenmeye başlayamaz)
                cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{_sk['sube_id']}:{_sk['tur']}",))
            cur.execute("SELECT *, son < NOW() AS gecti, islenme < NOW() - INTERVAL '2 minutes' AS takildi FROM ey_panel_onay WHERE id=%s FOR UPDATE", (oid,))
            o = cur.fetchone()
            if not o:
                raise HTTPException(404, "Onay bulunamadı")
            o = dict(o)
            if o["durum"] == "onaylandi":
                return {"tekrar": True, "mesaj": o["mesaj"], "kisi": o["personel_ad"]}
            if o["durum"] == "isleniyor" and not o["takildi"]:
                raise HTTPException(409, "Onay işleniyor — birazdan panele bak")
            if o["durum"] not in ("bekliyor", "hata", "isleniyor"):
                raise HTTPException(409, "Bu onay artık geçerli değil — panelden yeniden iste")
            if o["gecti"]:
                raise HTTPException(410, "Ara sayım süresi doldu — merkez görecek" if o["tur"] == "ara_sayim"
                                    else "Onayın süresi doldu — panelden yeniden iste")
            sube = str(v.get("sube") or "")
            if sube != o["sube_id"]:
                raise HTTPException(409, "Bu onay başka şubenin — o şubenin QR'ını okut")
            dilim = y.qr_dogrula(cur, sube, str(v.get("qr") or ""))
            if dilim is None:
                raise HTTPException(409, "QR süresi doldu — panelde QR yenilenince tekrar okut")
            y.konum_kontrol(cur, sube, p, v.get("lat"), v.get("lng"))
            y.qr_kullan(cur, sube, dilim, p["id"], "onay:" + oid)   # iz (aynı onayın yeniden denemesi engellenmez; tekrar onay satırıyla korunur)
            cur.execute("UPDATE ey_panel_onay SET durum='isleniyor', personel_id=%s, personel_ad=%s, islenme=NOW() WHERE id=%s",
                        (p["id"], p["ad"], oid))
            return {"o": o, "p": p}
    r = await run_in_threadpool(_dogrula)
    if r.get("tekrar"):
        return {"ok": True, "tekrar": True, "mesaj": r["mesaj"] or "Zaten onaylandı"}
    o, p = r["o"], r["p"]
    Body, fn, ad = ONAY_TURLERI[o["tur"]]
    govde = dict(__import__("evvel_yeni_cekirdek").json_ac(o["govde"], {}))
    govde["personel_id"] = p["id"]   # kimlik KAYNAKTA: telefonun sahibi
    try:
        sonuc = await run_in_threadpool(lambda: fn(o["sube_id"], Body(**govde)))
        durum, mesaj, kod = "onaylandi", f"{p['ad']} adına · {sonuc.get('mesaj') or 'kaydedildi'}", None
    except HTTPException as e:
        sonuc, durum, mesaj, kod = None, "hata", str(e.detail), e.status_code
    except Exception as e:  # noqa: BLE001
        log.error("panel onay işlenemedi %s: %s", oid, str(e)[:300])
        sonuc, durum, mesaj, kod = None, "hata", "Kaydedilemedi — tekrar dene", 503

    def _kapat():
        with db() as (conn, cur):
            cur.execute("UPDATE ey_panel_onay SET durum=%s, mesaj=%s, sonuc=%s::jsonb WHERE id=%s",
                        (durum, mesaj, json.dumps(sonuc or {}, ensure_ascii=False, default=str), oid))
    await run_in_threadpool(_kapat)
    if kod:
        raise HTTPException(kod, mesaj)
    return {"ok": True, "mesaj": mesaj, "kuru": bool((sonuc or {}).get("kuru"))}


class AraSayimGonderBody(BaseModel):
    sayilan: TrTutar


@router.post("/{sube_id}/ara-sayim", dependencies=_IMZALI)
def ara_sayim_gonder(sube_id: str, b: AraSayimGonderBody):
    """Panel: kör sayılan tutar → görev satırına (henüz KAYIT değil); ekranda QR, kimlik telefondan. Süre içinde yeniden gönderilebilir."""
    _onay_hazirla()
    with db() as (conn, cur):
        _sube(cur, sube_id)
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{sube_id}:ara_sayim",))   # onayla ile aynı sıra
        r = _ara_sayim_guncelle(cur, sube_id, _bugun())
        if not r or r["durum"] not in ("bekliyor", "hata"):   # 'hata' sonrası düzeltip yeniden gönderilebilir (e2e yakaladı)
            raise HTTPException(409, "Sayım şu an telefondan onaylanıyor — birkaç saniye bekle" if r and r["durum"] == "isleniyor"
                                else "Şu an ara sayım istenmiyor")
        k = _tl(b.sayilan, "Çekmecedeki para")
        cur.execute("""UPDATE ey_panel_onay SET govde = govde || %s::jsonb, ozet=%s WHERE id=%s AND durum IN ('bekliyor','hata')
                        RETURNING id""", (json.dumps({"sayilan": k}), f"Ara kasa sayımı · çekmece {_tl_yaz(Decimal(k) / 100)}", r["id"]))   # k KURUŞ — _tl_yaz ₺ bekler (sim 22 Eki: 1.345 → '134.500 ₺')
        if not cur.fetchone():   # Fable D-A: telefon o an işliyorsa 'gönderildi' sanılmasın
            raise HTTPException(409, "Sayım şu an telefondan onaylanıyor — birkaç saniye bekle")
    return {"ok": True, "onay_id": r["id"], "mesaj": "Telefonunla QR'ı okut ve onayla"}


@router.post("/{sube_id}/ara-sayim-duzelt", dependencies=_IMZALI)
def ara_sayim_duzelt(sube_id: str):
    """'Tutarı düzelt': sunucudaki tutar SİLİNİR — eski QR / telefonda açık ekran eski tutarı ONAYLAYAMAZ (Fable D-A)."""
    _onay_hazirla()
    with db() as (conn, cur):
        _sube(cur, sube_id)
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"ey_panel_onay:{sube_id}:ara_sayim",))
        r = _ara_sayim_guncelle(cur, sube_id, _bugun())
        if not r or r["durum"] not in ("bekliyor", "hata"):
            raise HTTPException(409, "Sayım şu an düzeltilemez — onaylanıyor ya da süresi doldu")
        cur.execute("UPDATE ey_panel_onay SET govde = govde - 'sayilan', ozet='Ara kasa sayımı' WHERE id=%s", (r["id"],))
    return {"ok": True}


@router.post("/{sube_id}/ara-sayim-deneme")
def ara_sayim_deneme(sube_id: str):
    """Yalnız DENEME döneminde (28–30 Ekim provası, A4): ara sayımı hemen iste — kayıt denemede kalıcı değil."""
    _onay_hazirla()
    with db() as (conn, cur):
        _sube(cur, sube_id)
        gun = _bugun()
        if not deneme_mi(cur, gun, sube_id):
            raise HTTPException(409, "Deneme düğmesi yalnız deneme döneminde")
        cur.execute("""UPDATE ey_panel_onay SET durum='iptal', mesaj='yerine deneme istendi'
                        WHERE sube_id=%s AND tur='ara_sayim' AND govde->>'gun'=%s AND durum IN ('planli','bekliyor')""", (str(sube_id), gun.isoformat()))
        oid = "as-" + uuid.uuid4().hex[:16]
        from evvel_yeni_cekirdek import simdi_tr
        cur.execute("""INSERT INTO ey_panel_onay (id, sube_id, tur, govde, ozet, durum, son)
                       VALUES (%s,%s,'ara_sayim',%s::jsonb,'Ara kasa sayımı (deneme)','bekliyor', NOW() + %s * INTERVAL '1 minute')""",
                    (oid, str(sube_id), json.dumps({"gun": gun.isoformat(), "oid": oid, "istenme": simdi_tr().isoformat(), "deneme": True}),
                     ARA_SAYIM_SURE_DK))
    return {"ok": True, "mesaj": "Deneme ara sayımı başladı (15 dk)"}


class AraGordumBody(BaseModel):
    id: str


@router.post("/ara-sayim-gordum")
def ara_sayim_gordum(body: AraGordumBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: 'ara sayım yapılmadı' işini gördü (iz: kim) — Bekleyen işler'den düşer."""
    _onay_hazirla()
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)
        cur.execute("""UPDATE ey_panel_onay SET sonuc = COALESCE(sonuc, '{}'::jsonb) || jsonb_build_object('goruldu', %s::text)
                        WHERE id=%s AND tur='ara_sayim' RETURNING id""", (kim, body.id))
        if not cur.fetchone():
            raise HTTPException(404, "Ara sayım bulunamadı")
    return {"ok": True}


def _ara_durum(cur, sube_id: str, gun) -> Optional[dict]:
    try:
        with savepoint(cur, "sp_panel_ara_durum"):
            r = _ara_sayim_guncelle(cur, sube_id, gun)
    except Exception:  # noqa: BLE001 — ara sayım okunamazsa panel çalışmaya devam eder
        log.warning("panel durum: ara sayım okunamadı", exc_info=True)
        return None
    if not r or r["durum"] not in ARA_AKTIF:
        return None
    from evvel_yeni_cekirdek import json_ac
    g = json_ac(r["govde"], {})
    cur.execute("SELECT GREATEST(0, EXTRACT(EPOCH FROM (son - NOW())))::int AS k FROM ey_panel_onay WHERE id=%s", (r["id"],))
    return {"durum": r["durum"], "onay_id": r["id"], "kalan_sn": int(dict(cur.fetchone())["k"]), "gonderildi": g.get("sayilan") is not None,
            "deneme": bool(g.get("deneme")), "mesaj": r.get("mesaj") if r["durum"] == "hata" else None}   # hata: telefonun gördüğü sebep (kör — tutar/fark yok)


def _ara_sayim_isleri(cur) -> list:
    """Bekleyen işler (A5): YALNIZ 'yapılmadı' — şube × gün TEK satır (yapılan sayım ve sınır uyarıları kapanış uyarısına girer)."""
    from evvel_yeni_cekirdek import json_ac, tablo_var
    from evvel_yeni_tanim_api import subeler
    if not tablo_var(cur, "ey_panel_onay"):
        return []
    cur.execute("""SELECT id, sube_id, govde, durum FROM ey_panel_onay WHERE tur='ara_sayim' AND olusturma >= NOW() - INTERVAL '7 days'
                    AND (durum = 'yapilmadi' OR (durum IN ('planli','bekliyor','hata','isleniyor') AND son < NOW()))
                    AND COALESCE(sonuc->>'goruldu', '') = '' ORDER BY olusturma""")
    satir = [dict(x) for x in cur.fetchall() or []]
    if not satir:
        return []
    adlar = {str(s["id"]): s["ad"] for s in subeler(cur)}
    out = []
    for r in satir:
        g = json_ac(r["govde"], {})
        if (g.get("gun") or "") < _baslangic(cur, str(r.get("sube_id") or "") or None).isoformat() or g.get("deneme"):
            continue   # deneme dönemi merkeze iş üretmez
        out.append({"genel": True, "grup": "kasa", "tur": "ara_sayim_yapilmadi", "id": f"ara:{r['id']}", "tarih": g.get("gun"),
                    "etiket": "⏱ Ara sayım yapılmadı", "ad": adlar.get(str(r["sube_id"]), r["sube_id"]),
                    "alt": ("15 dk içinde sayılmadı" if r["durum"] != "planli" else
                            "istenen saatte panel açık değildi" + (" (açık onay / devir yüzünden ertelenmişti)" if g.get("ertelendi") else "")),
                    "gordum": {"yol": "/evvel-yeni/panel/ara-sayim-gordum", "govde": {"id": r["id"]}}})
    return out


class DenemeBody(BaseModel):
    deneme_id: str


@router.post("/gec-kapanis")
def gec_kapanis(body: DenemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: reddedilen / hata veren panel kapanışını, personelin girdiği verilerle O İŞ GÜNÜNE işler
    (saat kuralı ve gün kilidi uygulanmaz; yeni istek kimliğiyle — eski deneme izli kalır)."""
    _deneme_hazirla()
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)   # çekirdek kapısı (F#2)
        cur.execute("SELECT * FROM ey_panel_deneme WHERE id=%s FOR UPDATE", (body.deneme_id,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Deneme bulunamadı")
        r = dict(r)
        if r["tur"] != "kapanis" or r["sonuc"] not in ("ret", "hata", "bekliyor") or r["islendi"]:
            raise HTTPException(409, "Bu deneme işlenemez (kapanış değil, başarılı ya da zaten işlendi)")
    govde = __import__("evvel_yeni_cekirdek").json_ac(r["govde"], {})
    govde["istek_id"] = "gec-" + body.deneme_id.replace("-", "")[:32]   # sabit: yarıda kalırsa tekrar = aynı kayıt (çift yazım yok)
    govde.pop("istemci_gunu", None)
    telefonsuz = govde.pop("_telefonsuz", None)   # K-5: yalnız telefonsuz gönderimde var
    try:
        kb = KapanisBody(**govde)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Kayıtlı kapanış verisi okunamadı: {str(e)[:150]}")
    sonuc = _kapanis_yaz(r["sube_id"], kb, gun=r["is_gunu"], merkez=kim, isle_deneme=body.deneme_id,
                         telefonsuz=telefonsuz if isinstance(telefonsuz, dict) else None)
    return {"ok": True, "mesaj": "Geç kapanış işlendi", "sonuc": sonuc}


def _kapanis_isleri(cur) -> list:
    """Son 7 gün: kapanış denemesi reddedilmiş / hata vermiş ve o gün için başarılı panel kapanışı YOK → merkez işi."""
    from evvel_yeni_tanim_api import subeler
    if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_panel_deneme"):
        return []
    _deneme_hazirla()   # uyarilar / goruldu sütunları (ayrı kısa işlem)
    cur.execute("""SELECT DISTINCT ON (sube_id, is_gunu) id, sube_id, is_gunu, sonuc, sebep, zaman, govde FROM ey_panel_deneme
                    WHERE tur='kapanis' AND zaman >= NOW() - INTERVAL '7 days' AND NOT islendi
                      AND (sonuc IN ('ret','hata') OR (sonuc = 'bekliyor' AND zaman < NOW() - INTERVAL '10 minutes'))
                      AND is_gunu >= %s
                    ORDER BY sube_id, is_gunu, zaman DESC""", (_baslangic(cur),))   # deneme dönemi merkeze iş üretmez
    satirlar = [dict(x) for x in cur.fetchall() or []]   # Codex BLOKER: subeler() imleci tüketmeden ÖNCE
    adlar = {str(s["id"]): s["ad"] for s in subeler(cur)}
    out = []
    for r in satirlar:
        if r["is_gunu"] < _baslangic(cur, str(r["sube_id"])):   # 🧪 pilot dışı şubenin deneme günü iş üretmez
            continue
        kapali = __import__("evvel_yeni_olay").gun_kapandi(cur, r["sube_id"], r["is_gunu"])   # F#11
        if kapali:
            continue
        out.append({"tur": "kapanis_red", "merkeze": (r.get("sebep") or "").startswith("Telefonsuz"),
                    "grup": "kasa", "id": r["id"], "tarih": r["is_gunu"].isoformat(),
                    "ad": adlar.get(str(r["sube_id"]), r["sube_id"]), "sebep": r.get("sebep") or "sonuç alınamadı",
                    "saat": __import__("evvel_yeni_cekirdek").tr_tarih_saat(r["zaman"]), "islem": "/evvel-yeni/panel/gec-kapanis",
                    "ozet": _kapanis_govde_ozet(__import__("evvel_yeni_cekirdek").json_ac(r.get("govde"), {}))})   # K-4 (sim 26 Eki): patron neyi işlediğini görmeden "geç kapanış" diyordu
    cur.execute("""SELECT id, sube_id, is_gunu, uyarilar, zaman FROM ey_panel_deneme
                    WHERE tur='kapanis' AND sonuc='ok_uyarili' AND goruldu IS NULL AND zaman >= NOW() - INTERVAL '7 days'
                      AND is_gunu >= %s ORDER BY zaman DESC""", (_baslangic(cur),))
    for r in [dict(x) for x in cur.fetchall() or []]:
        if r["is_gunu"] < _baslangic(cur, str(r["sube_id"])):
            continue
        out.append({"tur": "kapanis_uyarili", "grup": "kasa", "id": r["id"], "tarih": r["is_gunu"].isoformat(), "sube_id": str(r["sube_id"]),
                    "ad": adlar.get(str(r["sube_id"]), r["sube_id"]), "uyarilar": r.get("uyarilar") or [],
                    "saat": __import__("evvel_yeni_cekirdek").tr_tarih_saat(r["zaman"]),   # B97: GG.AA SS:DD (ay.gün değil)
                    "gordum": "/evvel-yeni/panel/kapanis-uyari-gordum"})
    return out


@router.post("/kapanis-uyari-gordum")
def kapanis_uyari_gordum(body: DenemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: uyarılı kapanışı gördü (iz: kim)."""
    _deneme_hazirla()
    with db() as (conn, cur):
        kim = merkez_aktor(cur, x_evvel_oturum)   # çekirdek kapısı (F#2)
        cur.execute("""UPDATE ey_panel_deneme SET goruldu=%s WHERE id=%s AND tur='kapanis' AND sonuc='ok_uyarili' AND goruldu IS NULL
                       RETURNING id""", (kim, body.deneme_id))
        if not cur.fetchone():
            raise HTTPException(404, "Görülecek uyarılı kapanış yok")
    return {"ok": True}


# ─────────────────────────── MERKEZ: Bekleyen işler (personele gitmez) ───────────────────────────
def _bekleyen(cur, baglam: dict) -> list:
    """Panel açıldıysa: dün kapanışı olmayan aktif şube."""
    out = []
    try:
        out.extend(_kapanis_isleri(cur))   # 🛟 reddedilen kapanış — panel açılmadan da (deneme dışı) görünür
    except Exception as e:  # noqa: BLE001
        log.warning("panel kapanış denemeleri okunamadı: %s", str(e)[:150])
        baglam.setdefault("_okunamayan", []).append("panel:kapanis")   # Codex: karar veren çağıran (toplu onay) eksik uyarıyla onaylamasın
    try:
        with savepoint(cur, "sp_panel_ara_isleri"):
            out.extend(_ara_sayim_isleri(cur))   # ⏱ yalnız 'yapılmadı'
    except Exception as e:  # noqa: BLE001
        log.warning("panel ara sayım işleri okunamadı: %s", str(e)[:150])
    # C-T1-16: "dün kapanış yok" satırı artık yalnız Kasa'dan (eksik_kapanis — yeni panel kapanışı Kasa'ya yazar); burada ikinci
    # kopya üretilmez (aynı gün iki bekleyen iş çıkıyordu).
    return out


bekleyen_is_kaydet("panel", _bekleyen)
