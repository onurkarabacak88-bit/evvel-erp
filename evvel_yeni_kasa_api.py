"""💰 EVVEL YENİ · KASA — sade çekirdeğin ilk bölümü (2026-10-15; eski adı "Para İzi",
sahip: "para izi hiç kullanma").

Sahip: *"Evvel her şeyi takip etsin dedik ama hem çok karışık hem sürekli hata
yapıyor; sade kurup sonra işlevi artıralım. Eski sistemden AYRI bir modül
olarak kur, bu aydan itibaren."*

Bu modül ESKİ PARA TABLOLARINA HİÇ YAZMAZ (kasa_hareketleri, kasa_teslim,
ciro…). Kendi iki tablosu var; eski sistemden yalnız OKUYARAK, tek yönlü ve
kaynak kimliğiyle (kaynak_ref) aktarım yapar.

MODEL (sahip kararları, [[project_sade_cekirdek_yeniden_kurgu]]):
  · Para TEK HAVUZ. Şubenin "hakkı / emaneti / destek bakiyesi" YOKTUR.
  · Para yalnız CEPLERDE durur: dükkân nakitleri (şube çekmeceleri) · patron evleri (Onur, Fethi,
    Fatma) · geçiş hesabı (Fethi'nin hesabı — "giren çıkmalı").
    İsimsiz "merkez kovası" YOKTUR.
  · Eksik para SİLİNMEZ ve gider SAYILMAZ: "açık fark" olarak sebebi bulunana
    kadar bekler; kapatma kim/ne zaman/neden ile yazılır.
  · Kayıtlar silinmez; geri almak = "iptal" kaydı (kayıt yokmuş gibi yeniden
    hesaplanır, iptal izi kalır).
  · Tutar KURUŞ (BIGINT), eşitlikler kuruşu kuruşuna (tolerans yok).
  · Bakiye saklanmaz, her istekte olaylardan TÜRETİLİR.

Codex denetimi (2026-10-15) sonrası kurallar:
  · Bütün yazmalar tek bir advisory kilit altında → iki istek aynı parayı
    iki kez harcayamaz, aynı fark iki kez çözülemez.
  · SAYIM KİLİDİ: bir cep X günü sayıldıysa, o cebi X ve öncesinde etkileyen
    yeni kayıt/iptal/onay reddedilir → sayımın "beklenen"i bayatlayamaz.
  · TESLİM İKİ OLAYDIR: çıkış (teslim günü, dükkân nakdi → yolda) ve alım
    ("aldım" dendiği gün, yolda → patron evi). Para eve geriye dönük girmez.
  · Çıkış yapan her kayıt, kaydın gününden itibaren HİÇBİR gün sonunda cebi
    eksiye düşüremez (geçmişe girilen ödeme bugünkü parayla finanse edilemez).
"""

import json
import logging

import uuid
from datetime import date, timedelta
from decimal import Decimal

from evvel_yeni_cekirdek import TrTutar   # para alanı: Türkçe tutar kuralı (E2E #10)
from evvel_yeni_cekirdek import is_gunu as _is_gunu_panel   # panel iş günü (02:00) — saatli sayım kilidinde "bugün" (Codex 24 Eki)
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from database import db, savepoint
# 🧩 Ortak yardımcılar ÇEKİRDEKTE (2026-10-17). Eski iç adlar geçiş için burada takma ad olarak duruyor —
#    modüller çekirdeğe geçince (adım 2) bu satırlar silinecek.
from evvel_yeni_cekirdek import (bugun as _bugun, tr_baslik as _tr_baslik, aktor as _aktor, tl_sayi as _tl_sayi, tl as _tl,
                                 kurus as _kurus, kilit as _cekirdek_kilit, KASA_KILIT,
                                 bekleyen_isler, bekleyen_is_kaydet)


def _kilit(cur) -> None:
    _cekirdek_kilit(cur, KASA_KILIT)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evvel-yeni/kasa", tags=["evvel-yeni-kasa"])

BASLANGIC = date(2026, 10, 1)          # ilk dönem — sahip: "bu aydan itibaren kurgula"
# Sahip (2026-10-15): "Şimdi eskiyle birlikte çalışsın; 1 Kasım'da sistemi tamamen
# sıfırlayıp kuruluşu ona göre devam ettireceğim." → DÖNEM: başlangıç günü ayardan
# okunur. Yeni dönem başlayınca önceki kayıtlar SİLİNMEZ (arşiv), hesaplara girmez;
# her cep yeni başlangıç sabahı sayılıp açılış bakiyesiyle başlar.
SENKRON_ARALIK_SN = 600                  # eski sistemden otomatik köprü — en sık 10 dk
# Sahip (2026-10-15): "Annem 65 yaşında, her gün nasıl onaylayacak?" → teslim 'aldım'
# beklemez: dokunulmayan teslim ERTESİ GÜN kendiliğinden kabul edilir (itiraz yok).
# Kontrol tek tek teslimde değil, evdeki para ara sıra SAYILARAK yapılır; 7 gün içinde
# "aslında eksikti" düzeltmesi yapılabilir.
# Sahip (2026-10-17, envanter madde 3-b): "teslim girildiği AN alınmış sayılsın; yalnız 'almadım' denirse açılsın" → 0 gün
# (köprü en geç 10 dk'da bir çeker ve aynı işlemde kabul eder). "Almadım/eksikti" = 7 gün içinde Düzelt.
OTOMATIK_KABUL_GUN = 0
FARK_ESIK_KURUS = 2000      # 20 ₺ — (eski: Bekleyen işler eşiği; 2026-10-20'den beri fark yalnız Açık farklar'da)
DUZELTME_SURESI_GUN = 7
ACIK = "__acik"                          # açık fark kovası (cep değil)
YOLDA = "__yolda"                        # teslim edildi, "aldım" bekleniyor (cep değil)
# Kasa kilidi + para üst sınırı ÇEKİRDEKTE (KASA_KILIT · MAKS_KURUS) — yerel kopya kalktı (Codex T1-35)

PATRON_CEPLERI = [
    ("ev:onur", "Onur'un evi", "Onur", "ev", 10),
    ("ev:fethi", "Fethi'nin evi", "Fethi", "ev", 11),
    ("ev:fatma", "Fatma'nın evi", "Fatma", "ev", 12),
    ("hesap:fethi", "Fethi'nin hesabı", "Fethi hesabı", "hesap", 40),
    ("banka:fatma_kira", "Fatma'nın kira hesabı", "Fatma kira", "banka", 59),
]
# Sahip: "Fatma'nın kirasından ödeme yaparken destek alıyoruz" → kira hesabı havuzun
# İÇİNDE (ödemede kaynak seçilebilir) ama işletme parasından AYRI görünür; ondan çıkan
# ödeme "kiradan destek" diye işaretlenir. ([[project_mulk_defteri]] ayrımı korunur.)
KIRA_CEPLERI = {"banka:fatma_kira"}
# PUBLIC — patronlar + nakit teslim hedefleri TEK liste (tekrar denetimi C-T1-34: Ödeme/Fatura/Panel ayrı listeler tutuyordu;
# yeni panel Fethi teslimini 'ev:fethi'ye, eski aktarım 'hesap:fethi'ye yazıyordu). Sahip (2026-10-16): Fethi'ye teslim GEÇİŞ HESABINA.
PATRONLAR = ("Onur", "Fethi", "Fatma")
TESLIM_HEDEFLERI = {"Onur": "ev:onur", "Fethi": "hesap:fethi", "Fatma": "ev:fatma"}
# Sahip: "POS bir gün sonra hesaba geçiyor" → kapanışın POS'u ERTESİ GÜN şube bankasına
# kendiliğinden yazılır (brüt − komisyon oranı = beklenen net, 'otomatik'). Gerçek kontrol
# EKSTRE BAKİYESİYLE (banka sayımı): yatmayan/farklı yatan POS orada açık fark olur.
# Online platformlar düzensiz öder → otomatik DEĞİL, elle girilir.
POS_YATIS_GUN = 1
SAYIM_UYARI_GUN = 7   # ev son boşalmasından bu yana bu kadar gün doluysa sarı (kalıntı = olası eksik)
DIS_TURLERI = {
    "borc": ("Borç alındı", "Borç", True),
    "kredi": ("Kredi çekildi", "Kredi", True),
    "kira": ("Kira geliri", "Kira", False),
    "satis": ("Satış (demirbaş, eşya vb.)", "Satış dışı", False),
    "destek": ("Patron desteği (maaştan)", "Destek", False),
    "diger": ("Diğer giriş", "Diğer", False),
}
SEBEPLER = {
    "bulundu": "Yanlış sayılmış / bulundu",
    "subede": "Şubede kalmış",
    "harcandi": "Elden harcanmış, kaydı girilmemiş",
    "kayip": "Kayıp / kasa açığı",
    "kabul": "Fazla para kabul edildi",
    "ekstre_dogru": "Ekstre doğru — masraf / komisyon / eksik kayıt",   # Fable (21 Eki): banka eksiğinde döngüsüz yol
    "kartla": "Kartla ödenmiş, nakit olarak da yazılmış (çift kayıt)",   # sahip (21 Eki): kart ZATEN çekildi → POS toplamı doğru; yalnız fazla nakit düşer
}


# ─────────────────────────── TABLOLAR ───────────────────────────
_HAZIR = False


def _hazirla() -> None:
    """Modülün KENDİ tabloları — kendi kısa transaction'ında; yalnız BAŞARIYLA
    commit olursa 'hazır' sayılır. Sıcak tabloya ALTER yok."""
    global _HAZIR
    if _HAZIR:
        return
    sube_tamam = False
    with db() as (conn, cur):
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS para_izi_cep (
                id      TEXT PRIMARY KEY,
                ad      TEXT NOT NULL,
                kisa    TEXT NOT NULL,
                tur     TEXT NOT NULL CHECK (tur IN ('sube','ev','hesap','banka')),
                sube_id TEXT,
                sira    INTEGER NOT NULL DEFAULT 0,
                aktif   BOOLEAN NOT NULL DEFAULT TRUE
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS para_izi_hareket (
                id            TEXT PRIMARY KEY,
                tur           TEXT NOT NULL,
                is_gunu       DATE NOT NULL,
                kayit_zamani  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                kaydeden      TEXT,
                cep           TEXT,
                kaynak        TEXT,
                hedef         TEXT,
                tutar         BIGINT NOT NULL DEFAULT 0,
                durum         TEXT,
                onay_zamani   TIMESTAMPTZ,
                onaylayan     TEXT,
                veri          JSONB NOT NULL DEFAULT '{}'::jsonb,
                kaynak_ref    TEXT UNIQUE
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_para_izi_hareket_gun ON para_izi_hareket (is_gunu, kayit_zamani)")
        # 🏦 BANKA (sahip 2026-10-15): "bankadan gelen ve bankalarda olan parayı görelim" ·
        # "her şubenin tek banka hesabı var, şube adıyla" · "Fatma kira hesabı olarak da gir".
        # Kendi küçük tablomuz — eski CHECK'i genişlet (sıcak tablo değil, modülün kendisi).
        cur.execute("ALTER TABLE para_izi_cep DROP CONSTRAINT IF EXISTS para_izi_cep_tur_check")
        cur.execute("ALTER TABLE para_izi_cep ADD CONSTRAINT para_izi_cep_tur_check CHECK (tur IN ('sube','ev','hesap','banka'))")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS para_izi_ayar (
                anahtar   TEXT PRIMARY KEY,
                deger     TEXT NOT NULL,
                degistiren TEXT,
                zaman     TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        for cid, ad, kisa, tur, sira in PATRON_CEPLERI:
            cur.execute("INSERT INTO para_izi_cep (id, ad, kisa, tur, sira) VALUES (%s,%s,%s,%s,%s) "
                        "ON CONFLICT (id) DO NOTHING", (cid, ad, kisa, tur, sira))
        try:
            with savepoint(cur, "sp_pi_sube"):
                sube_cepleri_yaz(cur)
                sube_tamam = True
        except Exception as e:  # noqa: BLE001
            log.warning("evvel-yeni kasa: subeler okunamadi: %s", str(e)[:200])
    _HAZIR = sube_tamam   # şube listesi okunamadıysa bir sonraki istekte yeniden dene


def sube_cepleri_yaz(cur) -> None:
    """Her AKTİF şubeye dükkân nakdi + şube bankası cebi. Şube listesi Evvel Yeni'nin KENDİ tablosundan (ey_sube);
    eski 'subeler' tablosuna bağımlılık YOK (sahip: eski sistem tamamen kalkacak)."""
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    for i, r in enumerate(_ey_subeler(cur)):
        r = dict(r)
        ad = _tr_baslik((r.get("ad") or "").strip() or str(r["id"]))
        cur.execute(
            "INSERT INTO para_izi_cep (id, ad, kisa, tur, sube_id, sira) VALUES (%s,%s,%s,'sube',%s,%s) "
            "ON CONFLICT (id) DO UPDATE SET ad=EXCLUDED.ad, kisa=EXCLUDED.kisa",
            ("sube:" + str(r["id"]), ad + " dükkân nakdi", ad, str(r["id"]), 20 + i))   # sahip: "şube kasası ismini daha ayrıştırıcı kullan"
        # Her şubenin TEK banka hesabı (sahip) — "Zafer bankası"
        cur.execute(
            "INSERT INTO para_izi_cep (id, ad, kisa, tur, sube_id, sira) VALUES (%s,%s,%s,'banka',%s,%s) "
            "ON CONFLICT (id) DO UPDATE SET ad=EXCLUDED.ad, kisa=EXCLUDED.kisa",
            ("banka:" + str(r["id"]), ad + " bankası", ad + " banka", str(r["id"]), 50 + i))


def banka_cepleri(cur) -> list:
    """PUBLIC (Tanımlar › Bankalar): banka + geçiş hesabı cepleri (tablo Kasa'nın — F#35 / C-T2-03)."""
    cur.execute("SELECT id, ad, kisa, tur, sube_id, aktif FROM para_izi_cep WHERE tur IN ('banka','hesap') ORDER BY aktif DESC, sira, ad")
    return [dict(r) for r in cur.fetchall() or []]


def banka_cebi_yaz(cur, *, cid: Optional[str], tur: Optional[str], ad: str, sube_id: Optional[str] = None,
                   aktif: Optional[bool] = None, slug: Optional[str] = None) -> str:
    """PUBLIC (Tanımlar › Bankalar): yeni banka / geçiş hesabı cebi aç (cid None) ya da adını / aktifliğini değiştir. Dönüş: cep id."""
    if cid is None:
        if tur not in ("banka", "hesap"):
            raise HTTPException(400, "Türü seç: şube/patron bankası ya da geçiş hesabı")
        cid = f"{tur}:{slug or uuid.uuid4().hex[:8]}"
        cur.execute("SELECT 1 FROM para_izi_cep WHERE id=%s", (cid,))
        if cur.fetchone():
            cid += "-" + uuid.uuid4().hex[:4]
        cur.execute("INSERT INTO para_izi_cep (id, ad, kisa, tur, sube_id, sira) VALUES (%s,%s,%s,%s,%s,90)", (cid, ad, ad, tur, sube_id or None))
        return cid
    cur.execute("SELECT id, ad, aktif FROM para_izi_cep WHERE id=%s AND tur IN ('banka','hesap')", (cid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Banka bulunamadı")
    if aktif is False and dict(r)["aktif"]:
        # B69 (Fable 22 Eki): pasif cep _cepler'den düşer → içindeki para toplamdan, bankalardan, ödeme formundan KAYBOLUR.
        # Tek kural: bakiye ≠ 0 (eksi dahil) iken pasif yapılmaz — önce para taşınır.
        _, C_, kayit_, _ = _yukle(cur)
        bak = bakiyeler(kayit_, C_).get(cid, 0)
        if not bak and cid not in _sayim_kilidi(_olaylar(kayit_)):
            # Fable: yeni dönemde HENÜZ SAYILMAMIŞ cep 0 görünür — önceki dönemin BİTİŞ bakiyesine bak (yeni_donem 'devir' ile aynı
            # yöntem). Sayılmış cepte bakılmaz: sayım dönemi zaten çıpalar (tüm-dönem toplamı parayı iki kez sayardı → kalıcı engel).
            bas_ = _baslangic(cur).isoformat()
            # Fable: yalnız BİR ÖNCEKİ dönem (yeni_donem 'donem_gecmisi:{bas}' = önceki başlangıç) — tüm geçmiş, 3. dönemden itibaren
            # her dönemin açılış sayımını üst üste toplardı
            cur.execute("SELECT deger FROM para_izi_ayar WHERE anahtar=%s", ("donem_gecmisi:" + bas_,))
            r_ = cur.fetchone()
            onceki_ = (dict(r_)["deger"] or "")[:10] if r_ else ""
            _, C2, kayit2, _ = _yukle(cur, tum_donemler=True)
            bak = _bakiye([o for o in _olaylar(kayit2) if onceki_ <= o["gun"] < bas_], C2)["b"].get(cid, 0)
        if bak:
            raise HTTPException(409, f"{dict(r)['ad']} cebinde {_tl(bak)} var — pasif yapılamaz. Önce Kasa › Taşı / Yatır ile parayı taşı.")
    cur.execute("UPDATE para_izi_cep SET ad=COALESCE(%s,ad), kisa=COALESCE(%s,kisa), aktif=COALESCE(%s,aktif) WHERE id=%s", (ad, ad, aktif, cid))
    return cid


def defter_ozeti(cur) -> dict:
    """PUBLIC servis (Kira hesabı modülü vb.): iptaller düşülmüş BÜTÜN kayıtlar (hafif) + cepler. Tek okuma.
    {"cepler": {id: {ad, kisa, tur, sube_id, kira}}, "kayitlar": [{id, tur, is_gunu, cep, kaynak, hedef, tutar, veri}]}"""
    _, _, kayit, _ = _yukle(cur, tum_donemler=True)
    cur.execute("SELECT id, ad, kisa, tur, sube_id FROM para_izi_cep")   # Codex: PASİF cepler de — geçmiş hesap sıfırlanmasın
    cep_list = [dict(r) for r in cur.fetchall() or []]
    return {"cepler": {c["id"]: {"ad": c["ad"], "kisa": c.get("kisa"), "tur": c["tur"], "sube_id": c.get("sube_id"),
                                 "kira": c["id"] in KIRA_CEPLERI} for c in cep_list},
            "kayitlar": [{"id": h["id"], "tur": h["tur"], "is_gunu": h["is_gunu"], "cep": h.get("cep"), "kaynak": h.get("kaynak"),
                          "hedef": h.get("hedef"), "tutar": int(h["tutar"] or 0), "veri": h["veri"]} for h in kayit]}


def dis_giris_bagla(cur, hid: str, bag: dict, alt: str) -> bool:
    """PUBLIC servis: var olan, iptal edilmemiş bir DIŞ GİRİŞE (yalnız verilen alt türde) bağ yazar; para DEĞİŞMEZ.
    Zaten bağlıysa False (başka bir şeye bağlanmaz)."""
    cur.execute("""SELECT veri FROM para_izi_hareket WHERE id=%s AND tur='dis'
                    AND id NOT IN (SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal' AND veri ? 'hedef_id') FOR UPDATE""", (hid,))
    r = cur.fetchone()
    if not r:
        return False
    v = dict(r)["veri"]
    v = __import__("evvel_yeni_cekirdek").json_ac(v, {})
    if v.get("alt") != alt or v.get("bag"):
        return False
    v["bag"] = {str(k)[:20]: (str(x)[:80] if x is not None else None) for k, x in list(bag.items())[:6]}
    cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(v, ensure_ascii=False), hid))
    return True


def donem_baslangici(cur) -> date:
    """PUBLIC servis: geçerli dönemin ilk günü (takvimler 'Evvel Yeni öncesi' ayları ayırmak için)."""
    return _baslangic(cur)


def _baslangic(cur) -> date:
    """Geçerli dönemin ilk günü (ayar yoksa ilk dönem: 1 Ekim 2026)."""
    try:
        with savepoint(cur, "sp_pi_ayar"):
            cur.execute("SELECT deger FROM para_izi_ayar WHERE anahtar='baslangic'")
            r = cur.fetchone()
            if r:
                return date.fromisoformat(dict(r)["deger"])
    except Exception:  # noqa: BLE001
        pass
    return BASLANGIC


# ─────────────────────────── OKUMA ───────────────────────────
def _cepler(cur) -> List[dict]:
    cur.execute("SELECT id, ad, kisa, tur, sube_id, sira FROM para_izi_cep WHERE aktif ORDER BY sira, ad")
    rows = [dict(r) for r in cur.fetchall() or []]
    # E2E #6: Tanımlar'da PASİF yapılan şubenin cebi görünür kalır (para kaybolmasın) ama 'aktif' DEĞİL → kapanış beklenmez,
    # eksik kapanış / Gelir eksik günü üretmez. Şube durumu Tanımlar'ın kapısından (tek gerçek).
    try:
        from evvel_yeni_tanim_api import subeler as _ey_subeler
        with savepoint(cur, "sp_kasa_sube_aktif"):
            aktif = {str(s["id"]) for s in _ey_subeler(cur)}
        for c in rows:
            if c["tur"] == "sube" and c.get("sube_id"):
                c["aktif"] = str(c["sube_id"]) in aktif
    except Exception:  # noqa: BLE001
        log.warning("kasa: şube aktiflik okunamadı", exc_info=True)
    return rows


def _ham(cur):
    """(geçerli kayıtlar, iptal kayıtları) — kayıt sırasıyla."""
    cur.execute("""
        SELECT id, tur, is_gunu, kayit_zamani, kaydeden, cep, kaynak, hedef, tutar,
               durum, onay_zamani, onaylayan, veri, kaynak_ref
          FROM para_izi_hareket ORDER BY is_gunu, kayit_zamani, id
    """)
    rows = []
    for r in cur.fetchall() or []:
        r = dict(r)
        v = r.get("veri")
        r["veri"] = v if isinstance(v, dict) else (json.loads(v) if v else {})
        r["is_gunu"] = r["is_gunu"].isoformat() if hasattr(r["is_gunu"], "isoformat") else str(r["is_gunu"])
        r["_sira"] = (r["kayit_zamani"].isoformat() if hasattr(r.get("kayit_zamani"), "isoformat") else str(r.get("kayit_zamani") or ""))
        rows.append(r)
    iptaller = [r for r in rows if r["tur"] == "iptal"]
    iptal_edilen = {r["veri"].get("hedef_id") for r in iptaller}
    by_id = {r["id"]: r for r in rows}
    for i in iptaller:   # F3.3 (sim 25 Eki): iptal satırı neyin iptal edildiğini söylesin — hedef geçerli listede YOK (düşüldü)
        i["_hedef"] = by_id.get(i["veri"].get("hedef_id"))
    return [r for r in rows if r["tur"] != "iptal" and r["id"] not in iptal_edilen], iptaller


def _iptal_hedef(h: Optional[dict], C: dict) -> dict:
    """İptal edilen kaydın kısa kimliği: tür · tutar · cep(ler) · iş günü (Kasam › Günlük hareketler iptal satırı)."""
    if not h:
        return {"hedef_tur": None}
    ad = lambda cid: C.get(cid, {}).get("ad", cid) if cid else None  # noqa: E731
    v = h.get("veri") or {}
    tut = int(v["sayilan"]) if h["tur"] == "sayim" and v.get("sayilan") is not None else h.get("tutar")
    yer = ad(h.get("cep")) or " → ".join(x for x in (ad(h.get("kaynak")), ad(h.get("hedef"))) if x) or (v.get("aciklama") or "")[:60] or None
    return {"hedef_tur": h["tur"], "hedef_tutar": _tl_sayi(int(tut)) if tut is not None else None, "hedef_yer": yer, "hedef_gun": h.get("is_gunu")}


def _olaylar(kayitlar: List[dict]) -> List[dict]:
    """Kayıtları tarihli OLAYLARA açar. Teslim iki olaydır: çıkış (teslim günü) ve
    alım ('aldım' günü). Sıra: gün, sonra kayıt anı."""
    out = []
    for r in kayitlar:
        if r["tur"] == "teslim":
            out.append({**r, "olay": "teslim_cikis", "gun": r["is_gunu"], "s": r["_sira"]})
            if r["durum"] == "onaylandi":
                g = r["veri"].get("onay_gunu") or r["is_gunu"]
                if _geriye_donuk(r):
                    g = r["is_gunu"]   # Fable: sonradan (geriye dönük) girilen teslim evde de TESLİM günü görünür (yoksa günlerce "yolda")
                s = r["onay_zamani"].isoformat() if hasattr(r.get("onay_zamani"), "isoformat") else r["_sira"]
                out.append({**r, "olay": "teslim_alim", "gun": g, "s": s})
        else:
            out.append({**r, "olay": r["tur"], "gun": r["is_gunu"], "s": r["_sira"]})
    # Fable: gün içinde önce GİRİŞ (açılış, satış nakdi, dış giriş, POS) sonra çıkış — teslim kapanıştan önce yazılınca sahte eksi oluyordu
    sira = {"acilis": 0, "kapanis": 1, "dis": 1, "pos_yatis": 1}
    out.sort(key=lambda o: (o["gun"], sira.get(o["olay"], 2), o["s"], o["id"], o["olay"]))
    return out


def _geriye_donuk(r: dict) -> bool:
    """Teslim kaydı, teslim gününden ≥2 gün sonra GİRİLMİŞSE (yönetimin geriye dönük girişi) True."""
    kz = r.get("kayit_zamani")
    try:
        return bool(kz and (kz.date() - date.fromisoformat(str(r["is_gunu"])[:10])).days >= 2)
    except Exception:  # noqa: BLE001
        return False


# ─────────────────────────── MOTOR ───────────────────────────
def _etki(o: dict, C: dict) -> List[dict]:
    """Bir olayın ceplere etkisi (kuruş). Tek doğru yer — ekran tekrar etmez."""
    t, v = o["olay"], o["veri"]
    ad = lambda cid: C.get(cid, {}).get("ad", cid)  # noqa: E731
    kisa = lambda cid: C.get(cid, {}).get("kisa", cid)  # noqa: E731
    if t == "acilis":
        return [{"cep": o["cep"], "d": o["tutar"], "etiket": "Açılış bakiyesi (" + o["gun"] + ")", "kaynak": "Açılış"}]
    if t == "kapanis":
        if v.get("sayimdan_sonra") and v.get("panel_sonradan"):   # F3.2 (sim 25 Eki): 0 tutarlı satır "kayboldu mu?" sorusu doğurmasın
            bey = int((v["panel_sonradan"][-1] or {}).get("nakit") or 0)
            return [{"cep": o["cep"], "d": o["tutar"], "etiket": f"Kapanış (sayımdan sonra) · beyan nakit {_tl(bey)} — para deftere sayımla girdi",
                     "kaynak": "Satış"}]
        return [{"cep": o["cep"], "d": o["tutar"],
                 "etiket": "Kapanış nakdi" + ("" if o["durum"] == "onaylandi" else " (onay bekliyor)"), "kaynak": "Satış"}]
    if t == "pos_yatis":
        k_ = "POS" if v.get("kanal", "pos") == "pos" else "Online"
        return [{"cep": o["cep"], "d": o["tutar"], "etiket": f"{k_} yatışı · {C.get(v.get('sube_cep'), {}).get('kisa', '')}".rstrip(" ·"),
                 "kaynak": f"{k_} " + (C.get(v.get('sube_cep'), {}).get('kisa') or "")}]
    if t == "dis":
        alt = v.get("alt", "diger")
        tanim = DIS_TURLERI.get(alt, DIS_TURLERI["diger"])
        k = ((v.get("kimden") or "Patron") + " desteği") if alt == "destek" else tanim[1]
        return [{"cep": o["cep"], "d": o["tutar"], "etiket": tanim[0] + (" · " + v["kimden"] if v.get("kimden") else ""), "kaynak": k}]
    if t == "teslim_cikis":
        return [{"cep": o["kaynak"], "d": -o["tutar"], "etiket": "Teslim → " + ad(o["hedef"])},
                {"cep": YOLDA, "d": o["tutar"], "etiket": "Yolda"}]
    if t == "teslim_alim":
        al = int(v.get("alinan", o["tutar"]))
        r = [{"cep": YOLDA, "d": -o["tutar"], "etiket": "Yolda"},
             {"cep": o["hedef"], "d": al, "etiket": "Teslim ← " + ad(o["kaynak"]), "kaynak": kisa(o["kaynak"])}]
        if o["tutar"] != al:
            r.append({"cep": ACIK, "d": o["tutar"] - al, "etiket": "Teslim farkı"})
        return r
    if t == "tasima":
        return [{"cep": o["kaynak"], "d": -o["tutar"], "etiket": "→ " + ad(o["hedef"])},
                {"cep": o["hedef"], "d": o["tutar"], "etiket": "← " + ad(o["kaynak"]), "kaynak": kisa(o["kaynak"])}]
    if t == "odeme":
        return [{"cep": p["cep"], "d": -int(p["tutar"]), "etiket": "Ödeme · " + (v.get("aciklama") or "")}
                for p in v.get("parcalar", [])]
    if t == "sayim":
        f = int(v.get("beklenen", 0)) - int(v.get("sayilan", 0))
        if f == 0:
            return []
        return [{"cep": o["cep"], "d": -f, "etiket": "Sayım farkı"}, {"cep": ACIK, "d": f, "etiket": "Sayım farkı"}]
    if t == "cozum":
        f, sb = int(v.get("f", 0)), v.get("sebep")
        r = [{"cep": ACIK, "d": -f, "etiket": "Fark çözüldü"}]
        if sb in ("bulundu", "kartla"):   # kartla: aynı işlemde o günün kapanış nakdi −f (çift kayıt düzeltmesi) → çekmecede net 0
            r.append({"cep": v.get("cep"), "d": f, "etiket": "Fark çözüldü · " + SEBEPLER[sb]})
        elif sb == "subede":
            r.append({"cep": v.get("sube_cep"), "d": f, "etiket": "Fark çözüldü · " + SEBEPLER[sb]})
        return r
    return []


def _bakiye(ol: List[dict], C: dict) -> dict:
    b = {cid: 0 for cid in C}
    b[ACIK] = b[YOLDA] = 0
    kayip = harcanan = acik_kira = 0
    for o in ol:
        for e in _etki(o, C):
            b[e["cep"]] = b.get(e["cep"], 0) + e["d"]
            if e["cep"] == ACIK:
                ilgili = o.get("cep") or (o["veri"].get("cep") if o["olay"] == "cozum" else None) or o.get("hedef")
                if ilgili in KIRA_CEPLERI:
                    acik_kira += e["d"]
        if o["olay"] == "cozum":
            if o["veri"].get("sebep") == "kayip":
                kayip += int(o["veri"].get("f", 0))
            elif o["veri"].get("sebep") == "harcandi":
                harcanan += int(o["veri"].get("f", 0))
    top = lambda tur: sum(b[c] for c, x in C.items() if x["tur"] == tur and c not in KIRA_CEPLERI)  # noqa: E731
    ev, sube, gecis, banka = top("ev"), top("sube"), top("hesap"), top("banka")
    kira = sum(b.get(c, 0) for c in KIRA_CEPLERI)
    toplam = ev + sube + gecis + banka + b[YOLDA]          # İŞLETME parası (kira hariç)
    return {"b": b, "ev": ev, "sube": sube, "gecis": gecis, "banka": banka, "nakit": ev + sube,
            "kira": kira, "hepsi": toplam + kira,
            "yolda": b[YOLDA], "gecis_yolda": gecis + b[YOLDA],
            "toplam": toplam, "acik": b[ACIK], "defter": toplam + b[ACIK] - acik_kira, "acik_kira": acik_kira,
            "kayip": kayip, "harcanan": harcanan}


def _farklar(ol: List[dict], C: dict) -> List[dict]:
    coz: Dict[str, List[dict]] = {}
    for o in ol:
        if o["olay"] == "cozum":
            coz.setdefault(o["veri"].get("fark_id"), []).append(o)   # kısmi kanal düzeltmesi → bir farka birden çok çözüm
    out = []
    for o in ol:
        if o["olay"] == "teslim_alim":
            f = o["tutar"] - int(o["veri"].get("alinan", o["tutar"]))
            if f:
                out.append({"id": o["id"], "tarih": o["gun"], "tur": "teslim", "f": f, "cep": o["hedef"], "sube_cep": o["kaynak"],
                            "ad": f"{C.get(o['kaynak'], {}).get('ad', '?')} → {C.get(o['hedef'], {}).get('ad', '?')} teslimi"})
        if o["olay"] == "sayim":
            f = int(o["veri"].get("beklenen", 0)) - int(o["veri"].get("sayilan", 0))
            if f:
                out.append({"id": o["id"], "tarih": o["gun"], "tur": "sayim", "f": f, "cep": o["cep"], "sube_cep": None,
                            "ad": f"{C.get(o['cep'], {}).get('ad', '?')} sayımı"})
    sayimlar = {o["id"]: o for o in ol if o["olay"] == "sayim"}
    kapanisli = {(o.get("cep"), o["gun"]) for o in ol if o["olay"] == "kapanis"}
    for x in out:
        s = sayimlar.get(x["id"])
        # F3.2 Opus S3 (25 Eki): şube cebinde o günün kapanışı YOKSA fark büyük olasılıkla satış nakdi → "önce kapanışı gir"
        if (s and C.get(x["cep"], {}).get("tur") == "sube" and (x["cep"], x["tarih"]) not in kapanisli
                and not s["veri"].get("baslangic")):   # başlangıç sayımı veri.baslangic=True ile işaretlenir (Fable 5)
            x["kapanis_yok"] = True
        if s:
            if s["veri"].get("kaynak") == "acilis_sayimi":   # Fable R: sabah sayımı bir önceki günün defterine yazılır
                g1 = date.fromisoformat(x["tarih"]) + timedelta(days=1)
                x["sayim_notu"] = f"{g1.strftime('%d.%m')} sabahı sayıldı · {date.fromisoformat(x['tarih']).strftime('%d.%m')} defterine yazıldı"
            if int(s["veri"].get("beklenen", 0)) < 0:
                x["defter_eksi"] = True   # Fable S: beklenen eksiydi → önceki bir çözüm / teslim yanlış olabilir
    for x in out:
        cl = coz.get(x["id"]) or []
        x["kalan"] = x["f"] - sum(int(c["veri"].get("f", 0)) for c in cl)
        if len(cl) > 1 or (cl and x["kalan"] != 0):   # kısmi / çok parçalı (ör. 480 = 470 kartla + 10) — kapanınca da görünür
            x["kismi"] = [{"sebep_ad": SEBEPLER.get(c["veri"].get("sebep"), ""), "f": _tl_sayi(int(c["veri"].get("f", 0))), "tarih": c["gun"]} for c in cl]
        c = cl[-1] if cl and x["kalan"] == 0 else None
        x["coz"] = None if not c else {"sebep": c["veri"].get("sebep"), "sebep_ad": SEBEPLER.get(c["veri"].get("sebep"), ""),
                                        "sorumlu": c["veri"].get("sorumlu"), "not": c["veri"].get("not"), "tarih": c["gun"],
                                        "kaydeden": c.get("kaydeden")}
    # Fable B (21 Eki): fark 'defter doğru' (bulundu) ile kapatıldı ama para yerindeydi → ertesi sayımda AYNI tutar yeniden doğar
    sira = {o["id"]: i for i, o in enumerate(ol) if o["olay"] in ("sayim", "cozum")}   # ol gün + kayıt sırasıyla sıralı
    for x in out:
        if x["coz"] or x["tur"] != "sayim":
            continue
        for p in out:
            pc = p["coz"]
            if (p is x or p["tur"] != "sayim" or p["cep"] != x["cep"] or not pc or pc["sebep"] != "bulundu"
                    or (p["f"] > 0) != (x["f"] > 0)):
                continue
            c_id = coz[p["id"]][-1]["id"]
            if not (sira.get(p["id"], 1 << 30) < sira.get(c_id, 1 << 30) < sira.get(x["id"], -1)):
                continue   # Codex: OLAY sırası sayım → çözüm → yeni sayım olmalı (aynı gün de)
            pf = int(coz[p["id"]][-1]["veri"].get("f", p["f"]))   # 'bulundu' parçasının tutarı (çok parçalı farkta)
            if abs(abs(x["f"]) - abs(pf)) <= max(2000, abs(pf) // 20):
                oner = ("Fazla para kabul edildi" if x["f"] < 0 else
                        "Ekstre doğru" if _banka_mi(x["cep"], C) else "Kayıp ya da Elden harcandı")
                x["tekrar_uyari"] = (f"Bu fark {date.fromisoformat(p['tarih']).strftime('%d.%m')} günü 'defter doğru / bulundu' ile kapatılmıştı ve "
                                     f"yeniden çıktı — {'para gerçekten orada' if x['f'] < 0 else 'para gerçekten yok'}; '{oner}' seç")
                break

    return out


def _not_ekle(cur, fl: List[dict], C: dict) -> None:
    """Fable + Codex (21 Eki, Tema 470 dersi): şubenin merkeze yazdığı notlar farkın ALTINDA görünür. Not farkı KAPATMAZ, yalnız bağlamdır.
    Kaynak Panel modülünün PUBLIC kapısı (tak-çıkar: panel kapalıysa sessiz)."""
    try:
        if not __import__("evvel_yeni_moduller").acik("panel"):
            return
        from evvel_yeni_panel_api import sube_notlari
    except Exception:  # noqa: BLE001
        return
    hedef = [x for x in fl if str((x["cep"] if x["tur"] == "sayim" else x.get("sube_cep")) or "").startswith("sube:")]
    if not hedef:
        return
    bas = min(x["tarih"] for x in hedef)
    son = (date.fromisoformat(max(x["tarih"] for x in hedef)) + timedelta(days=1)).isoformat()
    try:
        with savepoint(cur, "sp_kasa_notlar"):
            notlar = sube_notlari(cur, bas=bas, son=son)
    except Exception:  # noqa: BLE001
        log.warning("kasa: şube notları okunamadı", exc_info=True)
        return
    for x in hedef:
        sid = str(x["cep"] if x["tur"] == "sayim" else x["sube_cep"])[len("sube:"):]
        g1 = (date.fromisoformat(x["tarih"]) + timedelta(days=1)).isoformat()
        x["notlar"] = [n for n in notlar if n["sube_id"] == sid and n["is_gunu"] in (x["tarih"], g1)]


def _gun_fark(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _pos_durumu(ol: List[dict], C: dict, oranlar: Dict[str, tuple], ref: str) -> List[dict]:
    """💳 BANKAYA GELECEK (Codex): kapanıştaki kart/online satışı, bankaya YATANA kadar
    bekler; HARCANABİLİR PARAYA KATILMAZ. Şube + kanal başına: brüt satış − yatışların
    karşıladığı brüt = bekleyen. En eski karşılanmamış gün ilk-giren-ilk-çıkar ile bulunur
    (yalnız 'ne zamandır bekliyor' içindir, paraya dokunmaz)."""
    out = []
    for c in C.values():
        if c["tur"] != "sube":
            continue
        sid = c.get("sube_id")
        for kanal in ("pos", "online"):
            gunler = []
            for o in ol:
                if o["olay"] == "kapanis" and o["cep"] == c["id"]:
                    _n, _p, _o, _ = kapanis_kanallari({"tutar": o.get("tutar") or 0, "veri": o["veri"]})   # TEK kural (T1-14)
                    t = _p if kanal == "pos" else _o
                    if t:
                        gunler.append((o["gun"], t))
            yatan = sum(int(o["veri"].get("brut", o["tutar"])) for o in ol
                        if o["olay"] == "pos_yatis" and o["veri"].get("sube_cep") == c["id"] and o["veri"].get("kanal", "pos") == kanal)
            brut = sum(t for _, t in gunler)
            bekleyen = brut - yatan
            kalan, en_eski = yatan, None
            for g_, t in sorted(gunler):
                if kalan >= t:
                    kalan -= t
                    continue
                en_eski = g_
                break
            if not brut and not yatan:
                continue
            oran = (oranlar.get(sid) or (0, 0))[0 if kanal == "pos" else 1]
            out.append({"sube_cep": c["id"], "sube": c["kisa"], "banka_cep": "banka:" + str(sid), "kanal": kanal,
                        "brut_satis": _tl_sayi(brut), "yatan_brut": _tl_sayi(yatan), "bekleyen_brut": _tl_sayi(bekleyen),
                        "oran": float(oran or 0), "beklenen_net": _tl_sayi(bekleyen - komisyon(bekleyen, oran)),
                        "en_eski_gun": en_eski, "gun_sayisi": _gun_fark(en_eski, ref) if en_eski else 0})
    return out


def kapanis_kanallari(h: dict) -> tuple:
    """PUBLIC — TEK kapanış kanal kuralı (Codex T1-14): (nakit, pos, online, ayrımsız) kuruş. Eski kayıtta POS/online ayrımı yoksa
    'kart'ın tamamı POS sayılır (ayrımsız=True, etiketli). Gelir, Satış (iki kopya), Kasa POS bekleyen ayrı yazıyordu."""
    v = h.get("veri") or {}
    nakit = int(h.get("tutar") or 0)
    if v.get("sayimdan_sonra") and v.get("panel_sonradan"):
        # Fable B1 (21 Eki): sayılmış güne geç gelen kapanış deftere 0 yazılır (sayım bozulmasın) ama CİRO beyandır —
        # Gelir / Satış o günü 0 nakit görmesin
        son = v["panel_sonradan"][-1]
        nakit = int(son.get("nakit") or 0)
        v = {**v, **{a: son[a] for a in ("kart", "pos", "online") if a in son}}
    if "pos" in v or "online" in v:   # Fable D4-8: yalnız 'online' yazılmış kayıt da ayrımlıdır (eski _pos_durumu böyle okuyordu)
        return nakit, int(v.get("pos") or 0), int(v.get("online") or 0), False
    return nakit, int(v.get("kart") or 0), 0, True


def pos_sifir_supheli(kayitlar: list) -> set:
    """PUBLIC — TEK "POS 0 girilmiş ama satış var" kuralı (Codex T1-15, sahip/Fable 16 Eki): POS'u 0 yazılmış, nakdi olan kapanış;
    şube en az 3 günde POS girmiş (gerçekten POS'suz şube değil) ve merkez "gerçekten POS yoktu" (pos_sifir_kabul) DEMEMİŞ.
    Kasa Bekleyen işler + Satış 'kirli gün' AYNI kümeyi kullanır (Satış kabul edilen günü hâlâ kirli sayıyordu). Dönüş: kapanış id'leri."""
    pos_alan = {}
    for h in kayitlar:
        if h["tur"] == "kapanis" and kapanis_kanallari(h)[1] > 0:   # Codex (21 Eki): sayaç da TEK kanal kuralından (geç kapanışta beyan)
            pos_alan[h["cep"]] = pos_alan.get(h["cep"], 0) + 1
    out = set()
    for h in kayitlar:
        v = h.get("veri") or {}
        if (h["tur"] == "kapanis" and "pos" in v and kapanis_kanallari(h)[1] == 0 and kapanis_kanallari(h)[0] > 0
                and pos_alan.get(h["cep"], 0) >= 3 and not v.get("pos_sifir_kabul")):
            out.add(h["id"])
    return out


def komisyon(brut: int, oran) -> int:
    """PUBLIC — TEK komisyon kuralı (Codex T1-12): GÜNLÜK brüt (kuruş) × oran% → kuruş (Decimal, kuruşa yuvarlanır). Gelir aylık toplamı float ile, Gider günlük Decimal ile, Kasa neti ayrı yuvarlıyordu → bütün raporlar
    GÜNLÜK sonucu toplar. Oran 0..100 dışıysa 0 (komisyon yok)."""
    try:
        o = Decimal(str(oran or 0))
    except Exception:  # noqa: BLE001
        return 0
    if not (0 <= o < 100) or not brut:
        return 0
    return int((Decimal(int(brut)) * o / 100).quantize(Decimal("1")))


def _oranlar(cur) -> Dict[str, tuple]:
    try:
        with savepoint(cur, "sp_pi_oran"):
            from evvel_yeni_tanim_api import tanim_listesi   # şube tablosu Tanımlar'ın (F#31)
            return {str(r["id"]): (float(r["pos_oran"] or 0), float(r["online_oran"] or 0))
                    for r in tanim_listesi(cur, "ey_sube", ("pos_oran", "online_oran"))}
    except Exception:  # noqa: BLE001
        return {}


def _iz_kim(o: dict, C: dict) -> dict:
    """Excel görünümü için: hareketin ŞUBESİ ve onu yapan KİŞİ."""
    v, t = o["veri"], o["olay"]
    kisa = lambda cid: C.get(cid, {}).get("kisa") if cid else None  # noqa: E731
    kaydeden = (o.get("kaydeden") or "")
    for on in ("şube paneli · ", "eski sistem aktarımı · ", "otomatik köprü (eski sistem)"):
        kaydeden = kaydeden.replace(on, "")
    if t in ("teslim_cikis", "teslim_alim"):
        # F3.2 (sim 25 Eki): şube çekmecesi ÇIKIŞ satırını gösterir — alındı mı orada da görünsün (eskiden hep "—")
        if o.get("durum") == "onaylandi":
            alan = (kisa(o["hedef"]) or "") + (" · otomatik" if v.get("otomatik") else (" · " + o["onaylayan"] if o.get("onaylayan") else ""))
        else:
            alan = "⏳ bekliyor" if t == "teslim_cikis" else None
        return {"sube": kisa(o["kaynak"]), "personel": v.get("teslim_eden") or None, "alan": alan}
    if t == "kapanis":
        return {"sube": kisa(o["cep"]), "personel": kaydeden or None, "alan": None}
    if t == "dis":
        return {"sube": None, "personel": v.get("kimden") or None, "alan": None}
    if t == "pos_yatis":
        return {"sube": kisa(v.get("sube_cep")), "personel": kaydeden or None, "alan": None}
    if t == "tasima":
        return {"sube": kisa(o["kaynak"]) if C.get(o["kaynak"], {}).get("tur") == "sube" else None, "personel": kaydeden or None, "alan": None}
    return {"sube": None, "personel": kaydeden or None, "alan": None}


def _cep_iz(cid: str, ol: List[dict], C: dict) -> dict:
    bal, seg, tum, bosaldi = 0, [], [], None
    for o in ol:
        for e in _etki(o, C):
            if e["cep"] != cid:
                continue
            bal += e["d"]
            r = {"hareket_id": o["id"], "tur": o["olay"], "tarih": o["gun"], "d": e["d"], "bakiye": bal,
                 "etiket": e["etiket"], "kaynak": e.get("kaynak"), **_iz_kim(o, C)}
            tum.append(r)
            seg.append(r)
            if bal == 0:
                bosaldi, seg = r, []
    return {"bal": bal, "seg": seg, "tum": tum, "bosaldi": bosaldi}


def _son_sayim_yazi(cid: str, ol: List[dict]) -> Optional[str]:
    """R3 (sim 25 Eki): "bu cep en son ne zaman sayıldı, tuttu mu?" — tutan sayım tutar hareketi doğurmaz, hiçbir yerde görünmüyordu."""
    s = next((o for o in reversed(ol) if o["olay"] == "sayim" and o.get("cep") == cid), None)
    if not s:
        return None
    f = int(s["veri"].get("beklenen", 0)) - int(s["veri"].get("sayilan", 0))
    return f"Son sayım {s['gun'][8:10]}.{s['gun'][5:7]} · " + ("tuttu" if f == 0 else f"{_tl(abs(f))} {'eksik' if f > 0 else 'fazla'}")


def _cep_durum(c: dict, ol: List[dict], D: dict, ref: str, fl: List[dict], C: dict) -> dict:
    cid = c["id"]
    iz = _cep_iz(cid, ol, C)
    bal = D["b"].get(cid, 0)
    bos = bal == 0
    kir, sar = [], []
    # B29: gün içi eksi beklenen (satış nakdi kapanışta girer) — SARI yalnız eksi BUGÜNKÜ çıkışlardan geliyorsa; dünden eksi devrediyorsa
    #      gerçek sorundur, KIRMIZI kalır (Codex 22 Eki: 'Tüm günler' görünümünde dünkü eksi bugün kapanış yok diye sarıya dönüyordu)
    onceki = next((r["bakiye"] for r in reversed(iz["tum"]) if r["tarih"] < ref), 0)
    if bal < 0 and c.get("tur") == "sube" and onceki >= 0 and not any(
            o["olay"] == "kapanis" and o.get("cep") == cid and o["gun"] == ref for o in ol):
        sar.append(f"Gün açık — satış nakdi kapanışta girer (şu an {_tl(bal)})" if ref >= _bugun().isoformat()
                   else f"O gün kapanış girilmedi — satış nakdi eksik (şu an {_tl(bal)})")   # B61: geçmiş gün 'açık' değildir
    elif bal < 0:
        kir.append(f"Eksi bakiye {_tl(bal)} — açılış bakiyesi ya da bir giriş eksik")
    gg = lambda t: f"{str(t)[8:10]}.{str(t)[5:7]}"  # noqa: E731
    acik_f = [x for x in fl if not x["coz"] and (x["cep"] == cid or x["sube_cep"] == cid)]
    if len(acik_f) == 1:
        x = acik_f[0]
        kir.append(f"{_tl(abs(x.get('kalan', x['f'])))} {'eksik' if x['f'] > 0 else 'fazla'} · açık fark ({'teslim' if x['tur'] == 'teslim' else 'sayım'}, {gg(x['tarih'])})")
    elif acik_f:   # F3.2 (sim 25 Eki, patron gözü): farklar alt alta yığılmasın — tek satır özet, ayrıntı Açık farklar'da
        net = sum(x.get("kalan", x["f"]) for x in acik_f)
        eks = sum(1 for x in acik_f if x["f"] > 0)
        kir.append(f"{len(acik_f)} açık fark · net {_tl(abs(net))} {'eksik' if net > 0 else 'fazla' if net < 0 else '(birbirini götürüyor)'}"
                   + (f" · {eks} eksik, {len(acik_f) - eks} fazla" if 0 < eks < len(acik_f) else "") + f" · en eskisi {gg(min(str(x['tarih']) for x in acik_f))}")   # B9: "→ Açık farklar" kalktı (o sayfaya götürmüyordu; ayrıntı kartın Özet'inde)
    cikislar = {o["id"]: o for o in ol if o["olay"] == "teslim_cikis"}
    alimlar = {o["id"] for o in ol if o["olay"] == "teslim_alim"}
    for hid, o in cikislar.items():
        if hid not in alimlar and cid in (o["kaynak"], o["hedef"]):
            sar.append(f"{_tl(o['tutar'])} teslim \"aldı\" onayı bekliyor" if o["hedef"] == cid
                       else f"{_tl(o['tutar'])} teslim edildi, alan onaylamadı")
    son_teslim = None
    if c["tur"] == "sube":
        ts = [o["gun"] for o in cikislar.values() if o["kaynak"] == cid]
        son_teslim = max(ts) if ts else None
        onaysiz = [o for o in ol if o["olay"] == "kapanis" and o["cep"] == cid and o["durum"] != "onaylandi"]
        if onaysiz:
            sar.append(f"{len(onaysiz)} kapanış onaysız ({_tl(sum(o['tutar'] for o in onaysiz))})")
        if bal > 0:
            g = _gun_fark(son_teslim, ref) if son_teslim else None
            if g is None or g >= 7:
                kir.append("Bu dönemde hiç teslim yok" if g is None else f"{g} gündür teslim yok")
            elif g >= 4:
                sar.append(f"{g} gündür teslim yok")
    if c["tur"] == "ev" and bal > 0:
        # Sahip: "evdeki para hep taşınıyor ödeme için zaten" → ev düzenli SIFIRLANIR; eksik
        # para, hiç hareket etmeyen KALINTI olarak kalır. Ev son boşalmasından bu yana 7+ gün
        # dolu duruyorsa sor: "bu para gerçekten evde mi?" (sayım gerekirse o zaman).
        ilk = next((r for r in iz["seg"] if r["d"] > 0), None)
        g = _gun_fark(ilk["tarih"], ref) if ilk else 0
        ss_ = max((o["gun"] for o in ol if o["olay"] == "sayim" and o.get("cep") == cid), default=None)
        if g >= SAYIM_UYARI_GUN and not (ss_ and _gun_fark(ss_, ref) < SAYIM_UYARI_GUN):   # B74: yakın zamanda SAYILDIYSA sorma
            sar.append(f"{_tl(bal)} {g} gündür evde bekliyor — gerçekten evde mi? (değilse 'Sayım' gir)")
    if c["tur"] == "hesap" and bal > 0:
        ilk = next((r for r in iz["seg"] if r["d"] > 0), None)
        g = _gun_fark(ilk["tarih"], ref) if ilk else 0
        (kir if g >= 3 else sar).append(f"{_tl(bal)} {g} gündür hesapta bekliyor")
    gelen: Dict[str, int] = {}
    for r in iz["seg"]:
        if r["d"] > 0:
            k_ = r["kaynak"] or {"acilis": "Açılış bakiyesi", "sayim": "Sayım farkı", "cozum": "Fark çözümü"}.get(r["tur"]) or r.get("etiket") or "Diğer"   # B73: '?' yerine ad
            gelen[k_] = gelen.get(k_, 0) + r["d"]
    cikan = sum(-r["d"] for r in iz["seg"] if r["d"] < 0)
    kisa_cep = {x["kisa"]: x["id"] for x in C.values()}
    son_sayim = max((o["gun"] for o in ol if o["olay"] == "sayim" and o["cep"] == cid), default=None)
    seviye = "kirmizi" if kir else "sari" if sar else "gri" if bos else "yesil"
    return {"id": cid, "ad": c["ad"], "kisa": c["kisa"], "tur": c["tur"], "bakiye": _tl_sayi(bal),
            "seviye": seviye, "kirmizi": kir, "sari": sar,
            "gelen": [{"kaynak": k, "tutar": _tl_sayi(v), "cep": kisa_cep.get(k)} for k, v in gelen.items()],
            "gelen_toplam": _tl_sayi(sum(gelen.values())), "cikan": _tl_sayi(cikan), "son_teslim": son_teslim,
            "son_sayim": son_sayim, "son_sayim_yazi": _son_sayim_yazi(cid, ol),
            "bosaldi": None if not iz["bosaldi"] or not bos else {"tarih": iz["bosaldi"]["tarih"], "etiket": iz["bosaldi"]["etiket"]}}


def _eski_sistem_mi(h: dict) -> bool:
    """"eski sistemden" etiketi TEK kural (ekran denemesi 22 Eki: yeni panel ara teslimi 'eski sistemden' görünüyordu — kural 'kaynak izi var mı'
    idi; yeni panel kayıtlarının da izi var). Eski köprünün izleri: kasa_teslim: · anlik_gider: · eski kaynaklı kapanis: (yeni panel kapanışı
    aynı izi paylaşır ama veri.eski_kaynak='panel')."""
    ref = str(h.get("kaynak_ref") or "")
    if ref.startswith(("kasa_teslim:", "anlik_gider:")):
        return True
    if ref.startswith("kapanis:"):
        v = h.get("veri") or {}
        v = v if isinstance(v, dict) else {}
        return (v.get("eski_kaynak") or "") not in ("", "panel")
    return False


def _hareket_dto(r: dict, C: dict, ol: List[dict]) -> dict:
    v = r["veri"]
    d = {"id": r["id"], "tur": r["tur"], "tarih": r["is_gunu"], "kaydeden": r.get("kaydeden"), "durum": r.get("durum"),
         "cep": r.get("cep"), "kaynak": r.get("kaynak"), "hedef": r.get("hedef"), "tutar": _tl_sayi(r["tutar"]),
         "eski_sistem": _eski_sistem_mi(r)}
    if r["tur"] == "kapanis":
        kd = [z for z in (v.get("kanal_duzeltme") or []) if not z.get("iptal")]
        if kd:   # Fable (21 Eki): kapanış nakdi sessizce küçülmüş görünmesin
            d["cift_kayit"] = _tl_sayi(sum(int(z.get("tutar", 0)) for z in kd))
            d["cift_kayit_iz"] = [{"tutar": _tl_sayi(int(z.get("tutar", 0))), "kim": z.get("kim"), "zaman": z.get("zaman")} for z in kd]
        d["kart"] = _tl_sayi(int(v.get("kart", 0)))
        d["pos"] = _tl_sayi(int(v["pos"])) if "pos" in v else None
        d["online"] = _tl_sayi(int(v["online"])) if "online" in v else None
    elif r["tur"] == "pos_yatis":
        d.update(kanal=v.get("kanal", "pos"), sube_cep=v.get("sube_cep"), brut=_tl_sayi(int(v.get("brut", r["tutar"]))),
                 brut_tahmini=bool(v.get("brut_tahmini")), not_=v.get("not"), otomatik=bool(v.get("otomatik")),
                 oran=v.get("oran"))
    elif r["tur"] == "teslim":
        al = int(v.get("alinan", r["tutar"]))
        d.update(alinan=_tl_sayi(al), fark=_tl_sayi(r["tutar"] - al) if r["durum"] == "onaylandi" else 0.0,
                 onay_gunu=v.get("onay_gunu") or (r["is_gunu"] if r["durum"] == "onaylandi" else None),
                 onaylayan=r.get("onaylayan"), not_=v.get("not"), teslim_eden=v.get("teslim_eden"), kilit_sonrasi=v.get("kilit_sonrasi"))
    elif r["tur"] == "dis":
        alt = v.get("alt", "diger")
        t = DIS_TURLERI.get(alt, DIS_TURLERI["diger"])
        d.update(alt=alt, alt_ad=t[0], geri_odenecek=t[2], kimden=v.get("kimden"), not_=v.get("not"))
    elif r["tur"] == "sayim":
        d.update(beklenen=_tl_sayi(int(v.get("beklenen", 0))), sayilan=_tl_sayi(int(v.get("sayilan", 0))),
                 fark=_tl_sayi(int(v.get("beklenen", 0)) - int(v.get("sayilan", 0))))
    elif r["tur"] == "cozum":
        d.update(sebep=v.get("sebep"), sebep_ad=SEBEPLER.get(v.get("sebep"), ""), sorumlu=v.get("sorumlu"),
                 not_=v.get("not"), fark_ad=v.get("fark_ad"), f=_tl_sayi(int(v.get("f", 0))),
                 zarar=v.get("sebep") in ("kayip", "harcandi"))
    elif r["tur"] == "odeme":
        i = next(j for j, o in enumerate(ol) if o["id"] == r["id"])
        once, sonra = _bakiye(ol[:i], C), _bakiye(ol[:i + 1], C)
        d.update(aciklama=v.get("aciklama"), kimin=v.get("kimin") or "Ortak",
                 parcalar=[{"cep": p["cep"], "ad": (C.get(p["cep"]) or {}).get("ad"), "tutar": _tl_sayi(int(p["tutar"])), "pay": round(int(p["tutar"]) * 100 / max(sum(int(q["tutar"]) for q in v.get("parcalar", [])), 1)),
                            "once": _tl_sayi(once["b"].get(p["cep"], 0)), "sonra": _tl_sayi(sonra["b"].get(p["cep"], 0))}
                           for p in v.get("parcalar", [])],
                 toplam_once=_tl_sayi(once["toplam"]), toplam_sonra=_tl_sayi(sonra["toplam"]),
                 konu=(v.get("konu") or {}).get("ad") or ("Dükkân gideri" if v.get("kaynak") == "dukkan_gideri" else None),
                 ait_ay=v.get("ait_ay"), gider=v.get("gider"), not_=v.get("not"), duzeltmeler=v.get("duzeltmeler") or [],
                 kart_parcalar=[{"ad": p.get("kart_ad"), "tutar": _tl_sayi(int(p["tutar"]))} for p in v.get("kart_parcalar", [])],
                 genel_toplam=_tl_sayi(int(v.get("toplam", r["tutar"]))),
                 kiradan_destek=_tl_sayi(sum(int(p["tutar"]) for p in v.get("parcalar", []) if p["cep"] in KIRA_CEPLERI)))
    return d


def _ozet(D: dict, fl: List[dict]) -> dict:
    o = {k: _tl_sayi(D[k]) for k in ("toplam", "ev", "sube", "gecis", "banka", "nakit", "kira", "hepsi", "yolda", "gecis_yolda", "acik", "defter", "kayip", "harcanan")}
    acik = [x for x in fl if not x["coz"]]
    o["acik_eksik"] = _tl_sayi(sum(x.get("kalan", x["f"]) for x in acik if x["f"] > 0))
    o["acik_fazla"] = _tl_sayi(-sum(x.get("kalan", x["f"]) for x in acik if x["f"] < 0))
    o["acik_fark_sayisi"] = len(acik)
    return o


def _isler(kayitlar: List[dict], C: dict, fl: List[dict], bas: Optional[date] = None, ilk: Optional[dict] = None) -> List[dict]:
    """Bekleyen işler — GÜNE BAĞLI DEĞİL, en eski üstte (sahip: 'onayları gözden kaçırırız')."""
    out = []
    _ol = _olaylar(kayitlar)
    kilit, anlar = _sayim_kilidi(_ol), _sayim_anlari(_ol)   # E2E #5: sayım kilidine takılan teslim otomatik kabul EDİLEMEZ → burada görünmeli
    for h in kayitlar:
        if h["tur"] == "kapanis" and h["durum"] != "onaylandi":
            out.append({"tur": "kapanis", "id": h["id"], "tarih": h["is_gunu"], "cep": h["cep"], "ad": C.get(h["cep"], {}).get("ad"),
                        "nakit": _tl_sayi(h["tutar"]), "kart": _tl_sayi(int(h["veri"].get("kart", 0))), "eski_sistem": _eski_sistem_mi(h)})
        kilitli = h["tur"] == "teslim" and _kilitli_teslim(h, kilit, anlar)
        if h["tur"] == "teslim" and h["durum"] != "onaylandi" and (OTOMATIK_KABUL_GUN > 0 or kilitli):
            out.append({"tur": "teslim", "id": h["id"], "tarih": h["is_gunu"], "kaynak": h["kaynak"], "hedef": h["hedef"],
                        "ad": f"{C.get(h['kaynak'], {}).get('ad')} → {C.get(h['hedef'], {}).get('ad')}",
                        "hedef_kisa": C.get(h["hedef"], {}).get("kisa"), "tutar": _tl_sayi(h["tutar"]), "eski_sistem": _eski_sistem_mi(h)})
    # Sahip (2026-10-20): kasa farkının TEK EVİ "Açık farklar" — Bekleyen işler'e fark satırı DÜŞMEZ (aynı fark 3 yerde görünüyordu);
    # Kasam'daki kırmızı "Açık farklar" kartı uyarır, çözüm orada. (fl parametresi geriye uyum için duruyor)
    out.extend(_eksik_kapanislar(kayitlar, C, bas, ilk))
    out.sort(key=lambda x: x["tarih"])
    return out


def _kapanis_fark_oku(cur, gunler: List[str]) -> Dict[tuple, Optional[float]]:
    """K-3 (sim 25 Eki · Opus A): onay bekleyen kapanış günlerinin KASA FARKI (patron uyarıyı / açığı görmeden onaylıyordu).
    Hesap Satış'ın PUBLIC kapısından (kasa_mutabakat — tek hesap, tekrar yazılmaz); Satış kapalıysa boş (yumuşak bağ)."""
    fark: Dict[tuple, Optional[float]] = {}
    gunler = sorted(set(gunler))
    if not gunler:
        return fark
    try:
        from evvel_yeni_moduller import acik as _modul_acik
        if not _modul_acik("satis"):
            return fark
        from evvel_yeni_satis_api import kasa_mutabakat
    except Exception as e:  # noqa: BLE001
        log.warning("kapanış kasa farkı: Satış kapısı yok: %s", str(e)[:150])
        return fark
    for g in gunler:   # Fable: bir günün hesabı patlarsa öteki günler boş kalmasın
        try:
            with savepoint(cur, "sp_kap_kasa_fark"):
                for sid, m in (kasa_mutabakat(cur, g) or {}).items():
                    fark[(g, str(sid))] = m.get("fark")
        except Exception as e:  # noqa: BLE001 — bilgi alanı; onay listesini asla düşürmez
            log.warning("kapanış kasa farkı okunamadı (%s): %s", g, str(e)[:150])
    return fark


def _kapanis_kasa_farki(isler: List[dict], fark: Dict[tuple, Optional[float]], C: dict) -> List[dict]:
    for x in isler:
        if x.get("tur") == "kapanis":
            x["sube_id"] = str((C.get(x.get("cep")) or {}).get("sube_id") or "") or None
            x["kasa_fark"] = fark.get((x["tarih"], str(x["sube_id"])))
    return isler


def ilk_kayit_gunleri(kayitlar: List[dict]) -> Dict[str, str]:
    """B18: cep → defterdeki İLK kaydın günü (TÜM dönem kayıtlarıyla çağrılmalı — dönem süzgeçli liste eski şubeyi 'yeni' sanar)."""
    ilk: Dict[str, str] = {}
    for h in kayitlar:
        for cp in (h.get("cep"), h.get("kaynak"), h.get("hedef")):
            if cp and (cp not in ilk or h["is_gunu"] < ilk[cp]):
                ilk[cp] = h["is_gunu"]
    return ilk


def kapanissiz_gunler(kayitlar: List[dict], C: dict, bas: str, son: str, ilk: Optional[dict] = None) -> dict:
    """PUBLIC — TEK KURAL (tekrar denetimi C-T1-16: Gelir, Kasa, Panel ayrı hesaplıyordu): [bas, son] aralığında kapanış kaydı
    OLMAYAN aktif şube günleri {cep_id: [gün…]}. Kapanış = Kasa'daki 'kapanis' kaydı (yeni panel kapanışı da buraya yazar)."""
    var = {(h["cep"], h["is_gunu"]) for h in kayitlar if h["tur"] == "kapanis"}
    subeler = [c for c in C.values() if c["tur"] == "sube" and c.get("aktif", True)]
    out = {c["id"]: [] for c in subeler}
    if not bas or not son or bas > son:
        return out
    # B18 (Fable 22 Eki): şubenin İLK kasa kaydından önce gün sayılmaz — yeni açılan şube ilk gün "21 gün kapanış yok" almaz.
    # Hiç kaydı olmayan şube henüz açılmamış sayılır (veri girişi istemez; ilk açılış kaydıyla sayım kendiliğinden başlar).
    if ilk is None:
        ilk = ilk_kayit_gunleri(kayitlar)   # çağıran tüm-dönem listesi verdiyse (Gelir) yeterli
    g = date.fromisoformat(bas)
    while g.isoformat() <= son:
        for c in subeler:
            if c["id"] in ilk and g.isoformat() >= ilk[c["id"]] and (c["id"], g.isoformat()) not in var:
                out[c["id"]].append(g.isoformat())
        g += timedelta(days=1)
    return out


def _eksik_kapanislar(kayitlar: List[dict], C: dict, donem_bas: Optional[date] = None, ilk: Optional[dict] = None) -> List[dict]:
    """Sahip (2026-10-16): "Girilmemiş ciro uyarı versin; o günün girişi şubeden yeniden istensin."
    Dönem başından DÜNE kadar her aktif şube × gün: kapanış YOKSA → 'eksik_kapanis';
    kapanış yalnız Evo'nun tahmini taslağıysa (şube kapanış yapmamış) → 'evo_kapanis'."""
    if not kayitlar and donem_bas is None:
        return []
    # Dalga 1 denetimi B4: Gelir ile AYNI başlangıç — Kasa'nın dönem başlangıcı (en eski kayıt değil; kayıt yoksa da iş üretir)
    bas = donem_bas.isoformat() if donem_bas else min(h["is_gunu"] for h in kayitlar)
    dun = (_bugun() - timedelta(days=1)).isoformat()
    var = {}
    for h in kayitlar:
        if h["tur"] == "kapanis":
            var[(h["cep"], h["is_gunu"])] = h
    out = []
    subeler = [c for c in C.values() if c["tur"] == "sube" and c.get("aktif", True)]
    for cid, gunler in kapanissiz_gunler(kayitlar, C, bas, dun, ilk).items():
        if gunler:   # E2E #18: şube × gün ayrı satır 113 satıra çıkıyordu → şube başına TEK satır; 'Kapanışı gir' en eski günü açar
            out.append({"tur": "eksik_kapanis", "id": f"eksik:{cid}:{gunler[0]}", "tarih": gunler[0], "cep": cid, "ad": C[cid]["kisa"],
                        "gun_sayisi": len(gunler), "gunler": gunler[:31]})
    g = date.fromisoformat(bas)
    while g.isoformat() <= dun:
        gi = g.isoformat()
        for c in subeler:
            h = var.get((c["id"], gi))
            if h and h["veri"].get("eski_kaynak") == "evo_taslak" and not h["veri"].get("evo_kabul"):
                out.append({"tur": "evo_kapanis", "id": h["id"], "tarih": gi, "cep": c["id"], "ad": c["kisa"],
                            "nakit": _tl_sayi(h["tutar"]), "kart": _tl_sayi(int(h["veri"].get("kart", 0)))})
        g += timedelta(days=1)
    # Sahip/Fable (2026-10-16): "POS 0 girilmiş ama satış var" — kart satışı kapanışa yazılmamış olabilir (TEK kural, T1-15)
    supheli = pos_sifir_supheli(kayitlar)
    for h in kayitlar:
        if h["id"] in supheli:
            c = C.get(h["cep"]) or {}
            out.append({"tur": "pos_sifir", "id": h["id"], "tarih": h["is_gunu"], "cep": h["cep"], "ad": c.get("kisa"),
                        "nakit": _tl_sayi(h["tutar"])})
    return out


def _yukle(cur, tum_donemler: bool = False):
    """Varsayılan: yalnız GEÇERLİ DÖNEMİN kayıtları (önceki dönem silinmez, hesaba girmez).
    tum_donemler=True: arşiv dahil (POS devri, eski ay mutabakatı)."""
    cep_list = _cepler(cur)
    C = {c["id"]: c for c in cep_list}
    kayit, iptaller = _ham(cur)
    if tum_donemler:
        return cep_list, C, kayit, iptaller
    bas = _baslangic(cur).isoformat()
    return cep_list, C, [h for h in kayit if h["is_gunu"] >= bas], iptaller


# ─────────────────────────── KORUMALAR ───────────────────────────
def _sayim_kilidi(ol: List[dict]) -> Dict[str, str]:
    """cep → son sayım günü. O gün ve öncesi o cep için KİLİTLİ."""
    k: Dict[str, str] = {}
    for o in ol:
        if o["olay"] == "sayim":
            k[o["cep"]] = max(k.get(o["cep"], ""), o["gun"])
    return k


GUN_TOPLAMI_TURLERI = {"kapanis", "acilis"}   # tek anlık hareket değil, günün TOPLAMI → saatli sayım istisnası UYGULANMAZ
# Fable D (24 Eki): saatli istisna yalnız NAKİT ceplerde — bankanın "sayımı" ekstre bakiyesi, paranın bankaya giriş anı kayıt anı değil
# (sabah ekstrede görünen EFT öğleden sonra aynı güne girilirse çift sayardı). Bankalar / geçiş hesapları gün kilidinde kalır.
NAKIT_CEP_TURLERI = {"ev", "sube"}


def _sayim_anlari(ol: List[dict]) -> Dict[str, tuple]:
    """cep → (gün, kayıt anı) — cebin EN SON sayımı (sahip 24 Eki: kilit gün + SAAT). Liste sırasına güvenilmez (Codex)."""
    a: Dict[str, tuple] = {}
    for o in ol:
        if o["olay"] == "sayim":
            k = (o["gun"], str(o.get("s") or ""))
            if k > a.get(o["cep"], ("", "")):
                a[o["cep"]] = k
    return a


def _sayimdan_sonra(cep: str, gun: str, an, anlar: Dict[str, tuple]) -> bool:
    """Bu olay (gün, kayıt anı) cebin son sayımından KESİN sonra mı? Eksik/eşit an 'sonra' sayılmaz (Codex)."""
    a = anlar.get(cep)
    return bool(a and an and a[1] and gun == a[0] and str(an) > a[1])


def _kilit_denetle(etkiler: List[tuple], kilit: Dict[str, str], C: dict, sayim_icin: Optional[str] = None, kor: bool = False,
                   yeni_gun: Optional[str] = None) -> None:
    """etkiler: [(cep, gün)] — sayılmış bir cebi sayım günü ve öncesinde etkileyen değişiklik reddedilir.
    yeni_gun (sahip 24 Eki "sayım yapılıp hemen aktarım yapabiliriz, olağan; akşamında tekrar teslim olacak"): ŞU AN yazılan YENİ olay,
    sayım GÜNÜ bugünse serbest — kayıt anı her zaman sayımdan sonradır; sayımın farkı saklı 'beklenen'le sabit kalır. Geçmiş gün kilitli."""
    for cep, gun in etkiler:
        if cep in (ACIK, YOLDA) or cep not in kilit:
            continue
        if sayim_icin == cep and gun >= kilit[cep]:
            continue    # aynı/sonraki gün yeni sayım serbest
        if yeni_gun and gun == kilit[cep] == yeni_gun and C.get(cep, {}).get("tur") in NAKIT_CEP_TURLERI:
            continue    # sayımdan SONRA bugüne yazılan yeni kayıt (aktarım, akşam teslimi, gider…) — yalnız NAKİT cep (Fable D)
        if gun <= kilit[cep] and kor:   # Codex P1 (21 Eki): panel personeline sayım tarihi / 'Farkı çöz' SIZMAZ (kasa derinliği)
            raise HTTPException(409, "Kayıt yapılamadı — merkeze haber verin")
        if gun <= kilit[cep]:
            raise HTTPException(409, f"{C[cep]['ad']} {kilit[cep][8:10]}.{kilit[cep][5:7]} günü sayıldı — bu işlem sayım kilidi nedeniyle kaydedilemiyor. "
                                     f"Sayım öncesini veya kilitli geçmiş günleri değiştiremezsiniz; fark varsa 'Farkı çöz'ü kullanın.")


def _eksi_denetle(ol: List[dict], cepler: set, bas_gun: str, C: dict) -> None:
    """Verilen ceplerin bas_gun'den itibaren HİÇBİR gün sonunda eksiye düşmediğini doğrular. YALNIZ merkez yazımları —
    şube paneli (kor) bu kapıdan geçmez (B29, Fable 22 Eki): açık günde satış nakdi kapanışa kadar deftere girmez."""
    if not cepler:
        return
    bal = {c: 0 for c in cepler}
    gunler: Dict[str, Dict[str, int]] = {}
    for o in ol:
        for e in _etki(o, C):
            if e["cep"] in bal:
                bal[e["cep"]] += e["d"]
        if o["gun"] >= bas_gun:
            gunler[o["gun"]] = dict(bal)
    for g in sorted(gunler):
        for c, v in gunler[g].items():
            if v < 0:
                # F3.2 (sim 25 Eki): açık günde (kapanış yok) asıl neden satış nakdinin henüz girmemesi — yanlış ipucu verme
                kapanissiz = C.get(c, {}).get("tur") == "sube" and not any(o["olay"] == "kapanis" and o.get("cep") == c and o["gun"] == g for o in ol)
                if kapanissiz:
                    raise HTTPException(400, f"{C[c]['ad']} {g[8:10]}.{g[5:7]}.{g[:4]} kapanışı henüz girilmedi — o günün satış nakdi kapanışta girer, "
                                             f"şu an defterde {_tl(v)} kalıyor. Teslimi kapanıştan sonra gir ya da şube panelinden ara teslim yaptır.")
                raise HTTPException(400, f"{C[c]['ad']} {g[8:10]}.{g[5:7]}.{g[:4]} günü sonunda eksiye düşüyor ({_tl(v)}). "
                                         f"O gün o cepte bu kadar para yok — açılış bakiyesi ya da bir giriş eksik olabilir.")


# ─────────────────────────── UÇLAR: OKUMA ───────────────────────────
def _gun_coz(gun: Optional[str]) -> str:
    g = (gun or _bugun().isoformat())[:10]
    try:
        date.fromisoformat(g)
    except ValueError:
        raise HTTPException(400, "gun YYYY-AA-GG olmalı")
    return g


@router.get("/durum")
def durum(gun: Optional[str] = None, hepsi: bool = False):
    """Tek ekranın bütün verisi: seçilen gün AKŞAMI para nerede + o günün hareketleri
    + güne bağlı olmayan bekleyen işler. Ekranın bütün rakamları buradan gelir."""
    _hazirla()
    senkron = _otomatik_senkron()
    with db() as (conn, cur):
        cep_list, C, kayit_tum, iptaller = _yukle(cur, tum_donemler=True)   # Fable: tek okuma — hem dönem hem ilk-kayıt (B18)
        _db = _baslangic(cur).isoformat()
        kayit = [h for h in kayit_tum if h["is_gunu"] >= _db]
        bas = _baslangic(cur)
        oranlar = _oranlar(cur)
        # 🧩 Bekleyen işler: her modül kendi satırlarını çekirdeğin kayıt defterine bırakır (kart, depo, toptancı, kapanış…).
        #    Kasa onları TANIMAZ; modül kapanırsa satırları da kalkar. Biri okunamazsa diğerleri yine gelir.
        kart_isleri = bekleyen_isler(cur, {"kayit": kayit, "C": C})
        from evvel_yeni_tanim_api import subeler as _sb_hepsi
        pasif_sube = {str(x["id"]) for x in _sb_hepsi(cur, hepsi=True) if not x["aktif"]}   # B13
        ilk_gun = ilk_kayit_gunleri(kayit_tum)   # B18 (Fable): şubenin ilk kaydı TÜM dönemden
        kap_fark = _kapanis_fark_oku(cur, [h["is_gunu"] for h in kayit if h["tur"] == "kapanis" and h["durum"] != "onaylandi"])   # K-3
    bugun = _bugun().isoformat()
    g = _gun_coz(gun)
    ref = bugun if hepsi else g
    ol_tum = _olaylar(kayit)
    ol = ol_tum if hepsi else [o for o in ol_tum if o["gun"] <= g]
    D = _bakiye(ol, C)
    onceki = None if hepsi else _bakiye([o for o in ol_tum if o["gun"] < g], C)
    fl = _farklar(ol, C)
    gunun = kayit if hepsi else [h for h in kayit if h["is_gunu"] == g]
    gunun_ol = ol_tum if hepsi else [o for o in ol_tum if o["gun"] == g]
    kpi = {
        "satis_nakdi": _tl_sayi(sum(o["tutar"] for o in gunun_ol if o["olay"] == "kapanis")),
        "kart": _tl_sayi(sum(int(o["veri"].get("kart", 0)) for o in gunun_ol if o["olay"] == "kapanis")),
        "dis_giris": _tl_sayi(sum(o["tutar"] for o in gunun_ol if o["olay"] == "dis")),
        "teslim": _tl_sayi(sum(o["tutar"] for o in gunun_ol if o["olay"] == "teslim_cikis")),
        "kiradan_destek": _tl_sayi(sum(int(p["tutar"]) for o in gunun_ol if o["olay"] == "odeme"
                                       for p in o["veri"].get("parcalar", []) if p["cep"] in KIRA_CEPLERI)
                                   + sum(o["tutar"] for o in gunun_ol if o["olay"] == "tasima"
                                         and o.get("kaynak") in KIRA_CEPLERI and o.get("hedef") not in KIRA_CEPLERI)),
        "bankaya_giren": _tl_sayi(sum(e["d"] for o in gunun_ol for e in _etki(o, C) if e["d"] > 0 and C.get(e["cep"], {}).get("tur") == "banka")),
        # Kayıtsız elden harcama da ödemedir (Codex): bir kez sayılır, cebi tekrar düşmez.
        # Yalnız NAKİT/HAVALE parçaları — kartla ödenen kısım kasadan çıkmadı (kart borcu oldu)
        "odenen": _tl_sayi(sum(int(p["tutar"]) for o in gunun_ol if o["olay"] == "odeme" for p in o["veri"].get("parcalar", []))
                           + sum(int(o["veri"].get("f", 0)) for o in gunun_ol if o["olay"] == "cozum" and o["veri"].get("sebep") == "harcandi")),
    }
    cep_durumlari = [_cep_durum(c, ol, D, ref, fl, C) for c in cep_list]
    for cd in cep_durumlari:
        # Fethi'nin evi kaldırıldı (para geçiş hesabına gider) — boşsa ekranda görünmez; geçmiş kayıtları durur
        # sahip: "patronun evinden düşmüş görünmüyor" → bu dönem hareketi olduysa görünür (çıkış izi okunsun)
        cd["gizli"] = bool(cd["id"] == "ev:fethi" and abs(D["b"].get("ev:fethi", 0)) < 1
                           and not any("ev:fethi" in (o.get("cep"), o.get("kaynak"), o.get("hedef")) for o in ol))
        # B13: PASİF şubenin cebi boşsa ve bu dönem hareketi yoksa görünmez ("listelerde çıkmaz" sözü); parası varsa görünür (kaybolmaz)
        if str((C.get(cd["id"]) or {}).get("sube_id") or "") in pasif_sube and abs(D["b"].get(cd["id"], 0)) < 1 \
                and not any(cd["id"] in (o.get("cep"), o.get("kaynak"), o.get("hedef")) for o in ol):
            cd["gizli"] = True
    pos_list = _pos_durumu(ol, C, oranlar, ref)
    for cd in cep_durumlari:
        if cd["tur"] != "banka":
            continue
        cd["kira"] = cd["id"] in KIRA_CEPLERI
        for x in pos_list:
            if x["banka_cep"] == cd["id"] and x["bekleyen_brut"] > 0.004:
                m = f"{'POS' if x['kanal'] == 'pos' else 'Online'} {_tl(_kurus(x['bekleyen_brut']))} bankaya gelecek" + (f" · {x['gun_sayisi']} gündür" if x["gun_sayisi"] else "")
                (cd["kirmizi"] if x["gun_sayisi"] >= 5 else cd["sari"]).append(m)
        cd["seviye"] = "kirmizi" if cd["kirmizi"] else "sari" if cd["sari"] else cd["seviye"]
    alimlar = [o for o in gunun_ol if o["olay"] == "teslim_alim" and o["gun"] != o["is_gunu"]] if not hepsi else []
    gunun_iptal = iptaller if hepsi else [i for i in iptaller if i["kayit_zamani"].date().isoformat() == g]
    return {
        "gun": g, "hepsi": hepsi, "baslangic": bas.isoformat(), "bugun": bugun, "senkron": senkron,
        "ozet": _ozet(D, fl),
        "onceki_toplam": None if onceki is None else _tl_sayi(onceki["toplam"]),
        # B6 (sim 25 Eki + Codex B): manşet TOPLAM KASA kira dahil → değişimi de kira dahil; işletme değişimi AYRI adla (sessiz anlam değişimi yok)
        "degisim_toplam": None if onceki is None else _tl_sayi(D["hepsi"] - onceki["hepsi"]),
        "degisim_isletme": None if onceki is None else _tl_sayi(D["toplam"] - onceki["toplam"]),
        "acik_fark_simdi": sum(1 for x in (fl if hepsi or g >= bugun else _farklar(ol_tum, C)) if not x["coz"]),   # menü rozeti seçili günden bağımsız (F3.2)
        "cepler": cep_durumlari,
        "seviye_sayim": {"kirmizi": sum(1 for c in cep_durumlari if c["seviye"] == "kirmizi"),
                         "sari": sum(1 for c in cep_durumlari if c["seviye"] == "sari")},
        "kpi": kpi,
        "pos": pos_list,
        "pos_bekleyen_brut": _tl_sayi(sum(_kurus(x["bekleyen_brut"]) for x in pos_list)),
        "hareketler": [_hareket_dto(h, C, ol_tum) for h in gunun],
        "gec_alimlar": [{"id": o["id"], "teslim_gunu": o["is_gunu"], "ad": f"{C.get(o['kaynak'], {}).get('ad')} → {C.get(o['hedef'], {}).get('ad')}",
                         "alinan": _tl_sayi(int(o["veri"].get("alinan", o["tutar"])))} for o in alimlar],
        "iptaller": [{"id": i["id"], "hedef_id": i["veri"].get("hedef_id"), "sebep": i["veri"].get("sebep"), "kaydeden": i.get("kaydeden"),
                      **_iptal_hedef(i.get("_hedef"), C)} for i in gunun_iptal],
        "isler": _kapanis_kasa_farki(_isler(kayit, C, _farklar(ol_tum, C), bas, ilk_gun), kap_fark, C) + kart_isleri,
        "dis_turleri": [{"kod": k, "ad": v[0], "geri_odenecek": v[2]} for k, v in DIS_TURLERI.items()],
        "anlik_bakiye": {cid: _tl_sayi(v) for cid, v in _bakiye(ol_tum, C)["b"].items() if cid in C},
        "acilis_girilen": sorted({h["cep"] for h in kayit if h["tur"] == "acilis" and h["is_gunu"] == bas.isoformat()}),
        "hareket_sayisi": len(kayit),
    }


@router.get("/cep/{cep_id:path}")
def cep_detay(cep_id: str, gun: Optional[str] = None, hepsi: bool = False):
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur)
    if cep_id not in C:
        raise HTTPException(404, "Cep bulunamadı")
    g = _gun_coz(gun)
    ol_tum = _olaylar(kayit)
    ol = ol_tum if hepsi else [o for o in ol_tum if o["gun"] <= g]
    D = _bakiye(ol, C)
    fl = _farklar(ol, C)
    iz = _cep_iz(cep_id, ol, C)
    fark_ids = {x["id"] for x in fl}
    return {
        "cep": _cep_durum(C[cep_id], ol, D, _bugun().isoformat() if hepsi else g, fl, C),
        "iz": [{**r, "d": _tl_sayi(r["d"]), "bakiye": _tl_sayi(r["bakiye"]), "fark": r["hareket_id"] in fark_ids}
               for r in reversed(iz["tum"])],
        "farklar": [{**x, "f": _tl_sayi(x["f"]), "kalan": _tl_sayi(x["kalan"])} for x in fl if x["cep"] == cep_id or x["sube_cep"] == cep_id],
    }


@router.get("/teslimler")
def teslimler():
    """📦 TESLİM ONAYLARI sekmesi (sahip: "teslim onayları için ayrı bir sekme yap").
    Bekleyenler (en eski üstte, patron patron) + bu dönemde alınanlar (sayılan, fark, kim, ne zaman)."""
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur)
    bugun = _bugun().isoformat()
    ad = lambda cid: C.get(cid, {}).get("ad", cid)  # noqa: E731
    bek, alin = [], []
    for h in kayit:
        if h["tur"] != "teslim":
            continue
        satir = {"id": h["id"], "tarih": h["is_gunu"], "kaynak": h["kaynak"], "kaynak_ad": ad(h["kaynak"]),
                 "hedef": h["hedef"], "hedef_ad": ad(h["hedef"]), "hedef_kisa": C.get(h["hedef"], {}).get("kisa"),
                 "tutar": _tl_sayi(h["tutar"]), "eski_sistem": _eski_sistem_mi(h), "kaydeden": h.get("kaydeden"),
                 "yas_gun": _gun_fark(h["is_gunu"], bugun), "not": h["veri"].get("not"), "teslim_eden": h["veri"].get("teslim_eden")}
        if h["durum"] != "onaylandi":
            bek.append(satir)
        else:
            al = int(h["veri"].get("alinan", h["tutar"]))
            og = h["veri"].get("onay_gunu") or h["is_gunu"]
            alin.append({**satir, "alinan": _tl_sayi(al), "fark": _tl_sayi(h["tutar"] - al),
                         "onay_gunu": og, "onaylayan": h.get("onaylayan"), "otomatik": bool(h["veri"].get("otomatik")),
                         "duzeltilebilir": _gun_fark(og, bugun) <= DUZELTME_SURESI_GUN})
    bek.sort(key=lambda x: x["tarih"])
    alin.sort(key=lambda x: (x["onay_gunu"], x["tarih"]), reverse=True)
    patron = {}
    for x in bek:
        p_ = patron.setdefault(x["hedef"], {"hedef": x["hedef"], "ad": x["hedef_ad"], "adet": 0, "tutar": 0.0})
        p_["adet"] += 1
        p_["tutar"] = round(p_["tutar"] + x["tutar"], 2)
    return {"bekleyen": bek, "alinan": alin, "patron_ozet": list(patron.values()),
            "bekleyen_toplam": round(sum(x["tutar"] for x in bek), 2),
            "farkli_alinan": sum(1 for x in alin if x["fark"]),
            "otomatik_kabul_gun": OTOMATIK_KABUL_GUN, "duzeltme_suresi_gun": DUZELTME_SURESI_GUN}


@router.get("/banka-mutabakat")
def banka_mutabakat(ay: Optional[str] = None):
    """🧾 AYLIK BANKA MUTABAKATI (sahip: "her ay ekstreyi senin mantığınla kontrol eder,
    programdan karşılaştırmasını yaparız"). Her banka için: ay başı bakiye + girişler
    (türüne göre) − çıkışlar = programa göre ay sonu; ekstrenin ay sonu bakiyesi 'sayım'
    olarak girilir → fark açık farka düşer (mevcut kural). Ayın satırları ekstreyle tek
    tek karşılaştırılabilsin diye Excel düzeninde döner."""
    _hazirla()
    bugun = _bugun()
    a_ = (ay or bugun.strftime("%Y-%m"))[:7]
    try:
        ay_bas = date.fromisoformat(a_ + "-01")
    except ValueError:
        raise HTTPException(400, "ay YYYY-AA olmalı")
    sonraki = date(ay_bas.year + (ay_bas.month == 12), 1 if ay_bas.month == 12 else ay_bas.month + 1, 1)
    ay_son = date.fromordinal(sonraki.toordinal() - 1)
    kesit = min(ay_son, bugun).isoformat()       # ay bitmediyse bugüne kadar
    with db() as (conn, cur):
        _kilit(cur)
        _pos_otomatik(cur)                     # vadesi gelen POS mutabakattan önce yazılır
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
        donem_bas = _baslangic(cur).isoformat()
    ol = _olaylar(kayit)
    # Codex C4: yeni dönem açılışı (ör. 1 Kasım "Yeni başlangıç") önceki dönemin bakiyesini ZATEN taşır →
    # ay hangi dönemdeyse YALNIZ o dönemin olayları (yoksa Ekim hareketleri + Kasım açılışı üst üste biner)
    ol = [o for o in ol if o["gun"] >= donem_bas] if ay_bas.isoformat() >= donem_bas else [o for o in ol if o["gun"] < donem_bas]
    once = [o for o in ol if o["gun"] < ay_bas.isoformat()]
    icinde = [o for o in ol if ay_bas.isoformat() <= o["gun"] <= kesit]
    Bo = _bakiye(once, C)["b"]
    Bs = _bakiye(once + icinde, C)["b"]
    # Codex: "programa göre ay sonu" ekstre düzeltmesinden ÖNCE olmalı (sayım/çözüm hariç)
    Bp = _bakiye(once + [o for o in icinde if o["olay"] not in ("sayim", "cozum")], C)["b"]
    TUR_ADI = {"pos_yatis": "POS / online", "tasima": "Yatırma / transfer", "dis": "Dış giriş (EFT, kira…)",
               "odeme": "Ödemeler", "acilis": "Açılış", "sayim": "Ekstre farkı", "cozum": "Fark çözümü"}
    out = []
    for c in cep_list:
        if c["tur"] not in ("banka", "hesap"):
            continue
        cid = c["id"]
        satirlar, giris, cikis = [], {}, {}
        for o in [x for x in icinde if x["olay"] not in ("sayim", "cozum")]:
            for e in _etki(o, C):
                if e["cep"] != cid:
                    continue
                ad = TUR_ADI.get(o["olay"], o["olay"])
                (giris if e["d"] > 0 else cikis)[ad] = (giris if e["d"] > 0 else cikis).get(ad, 0) + abs(e["d"])
                satirlar.append({"gun": o["gun"], "tur": o["olay"], "etiket": e["etiket"], "d": _tl_sayi(e["d"]),
                                 "otomatik": bool(o["veri"].get("otomatik")), **_iz_kim(o, C)})
        sayimlar = [o for o in icinde if o["olay"] == "sayim" and o["cep"] == cid]
        son = sayimlar[-1] if sayimlar else None
        fl = [x for x in _farklar(ol, C) if x["cep"] == cid and ay_bas.isoformat() <= x["tarih"] <= kesit]
        out.append({"cep": cid, "ad": c["ad"], "tur": c["tur"], "kira": cid in KIRA_CEPLERI,
                    "ay_basi": _tl_sayi(Bo.get(cid, 0)), "program_ay_sonu": _tl_sayi(Bp.get(cid, 0)),
                    "duzeltme_sonrasi": _tl_sayi(Bs.get(cid, 0)),
                    "giris": [{"ad": k, "tutar": _tl_sayi(v)} for k, v in giris.items()],
                    "cikis": [{"ad": k, "tutar": _tl_sayi(v)} for k, v in cikis.items()],
                    "satir_sayisi": len(satirlar), "satirlar": satirlar,
                    "ekstreler": [{"gun": x["gun"], "bakiye": _tl_sayi(int(x["veri"].get("sayilan", 0))),
                                   "fark": _tl_sayi(int(x["veri"].get("beklenen", 0)) - int(x["veri"].get("sayilan", 0)))} for x in sayimlar],
                    "ekstre": None if not son else {"gun": son["gun"], "bakiye": _tl_sayi(int(son["veri"].get("sayilan", 0))),
                                                     "program": _tl_sayi(int(son["veri"].get("beklenen", 0))),
                                                     "fark": _tl_sayi(int(son["veri"].get("beklenen", 0)) - int(son["veri"].get("sayilan", 0)))},
                    "acik_farklar": [{**x, "f": _tl_sayi(x["f"]), "kalan": _tl_sayi(x["kalan"])} for x in fl if not x["coz"]]})
    return {"ay": a_, "ay_basi": ay_bas.isoformat(), "ay_sonu": ay_son.isoformat(), "kesit": kesit,
            "ay_bitti": ay_son < bugun, "bankalar": out}


@router.get("/acik-defter")
def acik_defter():
    """Açık farklar defteri — sahip: 'açıkları toplayarak gün gün toplam açık tutmalıyım'."""
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur)
        ol = _olaylar(kayit)
        fl = _farklar(ol, C)
        _not_ekle(cur, [x for x in fl if not x["coz"]], C)
    satir, kum_kayip, kum_harc = [], 0, 0
    for d in sorted({o["gun"] for o in ol}):
        yeni = sum(x["f"] for x in fl if x["tarih"] == d)
        cz = [o for o in ol if o["olay"] == "cozum" and o["gun"] == d]
        geri = sum(int(o["veri"].get("f", 0)) for o in cz if o["veri"].get("sebep") in ("bulundu", "subede"))   # Codex: defter gerçekten değişti
        kab = sum(abs(int(o["veri"].get("f", 0))) for o in cz if o["veri"].get("sebep") in ("kabul", "ekstre_dogru", "kartla"))   # Codex: yönler birbirini silmesin
        bas_ = sum(abs(int(o["veri"].get("f", 0))) for o in cz if o["veri"].get("sebep") == "baslangic")
        kay = sum(int(o["veri"].get("f", 0)) for o in cz if o["veri"].get("sebep") == "kayip")
        har = sum(int(o["veri"].get("f", 0)) for o in cz if o["veri"].get("sebep") == "harcandi")
        kum_kayip += kay
        kum_harc += har
        son = _bakiye([o for o in ol if o["gun"] <= d], C)["acik"]
        if not (yeni or geri or kay or har or son or kab or bas_ or cz):
            continue
        satir.append({"gun": d, "yeni": _tl_sayi(yeni), "geri_donen": _tl_sayi(geri), "kayba_yazilan": _tl_sayi(kay),
                      "kabul_edilen": _tl_sayi(kab), "baslangic_esitleme": _tl_sayi(bas_),
                      "harcamaya_yazilan": _tl_sayi(har), "gun_sonu_acik": _tl_sayi(son),
                      "toplam_kayip": _tl_sayi(kum_kayip), "toplam_harcanan": _tl_sayi(kum_harc)})
    D = _bakiye(ol, C)
    oz = _ozet(D, fl)
    return {"acik": oz["acik"], "acik_eksik": oz["acik_eksik"], "acik_fazla": oz["acik_fazla"],
            "kayip": oz["kayip"], "harcanan": oz["harcanan"],
            "farklar": [{**x, "f": _tl_sayi(x["f"]), "kalan": _tl_sayi(x["kalan"])} for x in fl], "gun_gun": satir}


def _banka_mi(cep: Optional[str], C: Optional[dict]) -> bool:
    """Cep banka mı? Pasifleştirilmiş cep C'de yoktur → kimlik öneki (banka:) — Codex (21 Eki)."""
    return (((C or {}).get(cep or "") or {}).get("tur") == "banka") or str(cep or "").startswith("banka:")


def _ilk_sayim_mi(x: dict, ol: List[dict]) -> bool:
    """Bu fark, cebin bu dönemdeki İLK sayımı mı? (elle girilen ilk sayım da 'başlangıç' ile kapanabilsin — 21 Eki: Zafer 290 ·
    Alsancak 4.250 eski defter farkı 'elden harcandı' diye kapanmış, zarar gibi görünüyordu)"""
    if x["tur"] != "sayim":
        return False
    ilk = next((o for o in ol if o["olay"] == "sayim" and o["cep"] == x["cep"]), None)   # ol gün + kayıt sırasıyla sıralı
    return bool(ilk) and ilk["id"] == x["id"]


def _sebep_secenekleri(x: dict, ol: Optional[List[dict]] = None, C: Optional[dict] = None) -> List[str]:
    """Fark sahibinin seçebileceği sebepler. Fable + Codex (21 Eki): banka cebinde 'elden harcandı / kayıp' yok (ekstre farkı
    para kaybı değildir); cebin ilk sayımında 'başlangıç' seçilebilir. Sıra: önerilen önce (fazlada 'kabul')."""
    banka = _banka_mi(x["cep"], C)
    ilk = ["baslangic"] if (ol is not None and _ilk_sayim_mi(x, ol)) else []
    if x["f"] > 0:
        kartla = ["kartla"] if (x["tur"] == "sayim" and str(x["cep"]).startswith("sube:")) else []
        return (["ekstre_dogru", "bulundu"] if banka else ["bulundu"] + kartla + (["subede"] if x["tur"] == "teslim" else []) + ["harcandi", "kayip"]) + ilk
    return ["kabul", "bulundu"] + ilk


def _sebep_etkisi(s: str, x: dict, C: dict) -> str:
    """Seçeneğin deftere etkisi — ekranda seçim yapılırken yazılır (Fable B: 'defter doğru' farkı ertesi gün yeniden doğuruyordu)."""
    t = _tl(abs(int(x.get("kalan", x["f"]))))
    fazla = x["f"] < 0
    if s == "bulundu":
        return (f"Defter {t} AZALIR (sayım yanlıştı, para yok). Para hâlâ çekmecedeyse yarınki sayımda AYNI fark yine çıkar — o zaman 'Fazla para kabul edildi' seç."
                if fazla else f"Defter {t} ARTAR (para bulundu). Para gerçekten yoksa yarınki sayımda aynı eksik yine çıkar.")
    if s == "kabul":
        return f"Defter sayımda kalır: {t} fazla para deftere girmiş olur. Fark bir daha çıkmaz."
    if s == "harcandi":
        return f"Defter sayımda kalır; {t} 'kayıtsız harcama' toplamına yazılır."
    if s == "kayip":
        return f"Defter sayımda kalır; {t} 'kayıp' toplamına yazılır (zarar)."
    if s == "subede":
        return f"{t} şubenin dükkân nakdine geri konur ({(C.get(x.get('sube_cep') or '') or {}).get('ad', 'şube')})."
    if s == "baslangic":
        return f"Defter sayımda kalır; {t} eski defterden kalan AÇILIŞ farkıdır — zarar ya da harcama sayılmaz."
    if s == "kartla":
        return (f"⚠ Önce POS gün sonu raporu / slip ile DOĞRULA (personel notu tek başına kanıt değil). O günün kapanışında NAKİT "
                f"AZALIR (girdiğin tutar kadar; boşsa {t}); kart / POS toplamına DOKUNULMAZ — kart zaten çekildi, POS cihazı toplamı doğru. "
                "Aynı satış iki kez yazıldığı için ciro da bu kadar düşer. Kayıp sayılmaz. Tutar farktan azsa kalan açık kalır.")
    if s == "ekstre_dogru":
        return f"Defter ekstreye eşitlenir ({t} masraf / komisyon / girilmemiş kayıt). Kayıp sayılmaz, fark bir daha çıkmaz."
    return ""


@router.get("/fark/{fark_id}")
def fark_detay(fark_id: str):
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur)
        ol = _olaylar(kayit)
        x = next((z for z in _farklar(ol, C) if z["id"] == fark_id), None)
        if x:
            _not_ekle(cur, [x], C)
    if not x:
        raise HTTPException(404, "Fark bulunamadı")
    return {**x, "f": _tl_sayi(x["f"]), "kalan": _tl_sayi(x["kalan"]), "cep_ad": C.get(x["cep"], {}).get("ad"),
            "sube_cep_ad": C.get(x["sube_cep"], {}).get("ad") if x["sube_cep"] else None,
            "bugun": _bugun().isoformat(),
            "onerilen": ("kabul" if x["f"] < 0 else "ekstre_dogru" if _banka_mi(x["cep"], C) else None),   # döngüsüz yol
            "sebep_secenekleri": [{"kod": s, "ad": ("Sayım hatası, defter doğru" if x["f"] < 0 and s == "bulundu" else SEBEPLER[s]),
                                   "etki": _sebep_etkisi(s, x, C)}
                                  for s in _sebep_secenekleri(x, ol, C)]}


# ─────────────────────────── UÇLAR: YAZMA ───────────────────────────
class Parca(BaseModel):
    cep: str
    tutar: TrTutar


class HareketBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    tur: str
    is_gunu: Optional[str] = None
    cep: Optional[str] = None
    kaynak: Optional[str] = None
    hedef: Optional[str] = None
    tutar: Optional[TrTutar] = None
    kart: Optional[TrTutar] = None
    alt: Optional[str] = None
    kimden: Optional[str] = None
    not_: Optional[str] = Field(None, alias="not")
    aciklama: Optional[str] = None
    kimin: Optional[str] = None
    parcalar: Optional[List[Parca]] = None
    sayilan: Optional[TrTutar] = None
    fark_id: Optional[str] = None
    sebep: Optional[str] = None
    sorumlu: Optional[str] = None
    teslim_eden: Optional[str] = None
    online: Optional[TrTutar] = None
    bag: Optional[dict] = None          # 🧩 tak-çıkar: bu kaydı hangi modülün neyine bağlar (ör. {"modul":"mulk","id":..,"ay":..}) — Kasa yorumlamaz
    istek_id: Optional[str] = None      # formun tek kimliği — tekrar gönderilirse İKİNCİ KEZ yazılmaz


def _yaz(cur, tur, gun, kaydeden, cep=None, kaynak=None, hedef=None, tutar=0, durum=None, veri=None, kaynak_ref=None):
    hid = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO para_izi_hareket (id, tur, is_gunu, kaydeden, cep, kaynak, hedef, tutar, durum, veri, kaynak_ref, kayit_zamani)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s, clock_timestamp())
        ON CONFLICT (kaynak_ref) DO NOTHING RETURNING id
    """, (hid, tur, gun, (kaydeden or "")[:60] or None, cep, kaynak, hedef, int(tutar), durum,
          json.dumps(veri or {}, ensure_ascii=False), kaynak_ref))
    r = cur.fetchone()
    return dict(r)["id"] if r else None


def _sahte(tur, gun, **kw) -> dict:
    """Doğrulama için henüz yazılmamış kaydın olay hâli."""
    r = {"id": "__yeni__", "tur": tur, "is_gunu": gun, "_sira": "9999", "cep": None, "kaynak": None, "hedef": None,
         "tutar": 0, "durum": None, "veri": {}, "kaydeden": None, "kaynak_ref": None, "onay_zamani": None}
    r.update(kw)
    return r


def kasa_hazirla() -> None:
    """PUBLIC: Kasa tablolarını (kendi kısa işleminde) hazırlar — kasa_yaz çağrılmadan ÖNCE, çağıranın işlemi dışında."""
    _hazirla()


def kasa_yaz(cur, body: "HareketBody", kim: str, kaynak_ref: Optional[str] = None, kor: bool = False) -> dict:
    """PUBLIC — Kasa'nın TEK yazma kapısı (merkez ucu + yeni şube paneli). Çağıranın işleminde çalışır: modül kilidi,
    sayım kilidi, eksi denetimi burada. kaynak_ref verilirse (ör. kapanis:{şube}:{gün}) aynı kayıt ikinci kez yazılmaz.
    Önce kasa_hazirla() çağrılmış olmalı."""
    t = body.tur
    evo_yerine = None
    if t not in {"acilis", "kapanis", "dis", "teslim", "tasima", "odeme", "sayim", "cozum", "pos_yatis"}:
        raise HTTPException(400, "Geçersiz tür")
    bugun = _bugun()
    gun = (body.is_gunu or bugun.isoformat())[:10]
    try:
        gd = date.fromisoformat(gun)
    except ValueError:
        raise HTTPException(400, "Gün YYYY-AA-GG olmalı")
    if gd > bugun:
        raise HTTPException(400, "Gelecek tarihli kayıt girilemez")
    _kilit(cur)
    bas = _baslangic(cur)
    if gd < bas and t != "acilis" and kor:
        raise HTTPException(400, "Kayıt yapılamadı — merkeze haber verin")   # Codex: tarih personele sızmasın
    if gd < bas and t != "acilis":
        raise HTTPException(400, f"Bu dönem {bas.strftime('%d.%m.%Y')} tarihinde başladı; öncesine kayıt girilemez")
    ref = kaynak_ref or (f"hareket:{body.istek_id[:64]}" if body.istek_id else None)
    if ref:   # Codex: tekrar gönderim — doğrulamadan ÖNCE, kilit altında
        cur.execute("SELECT 1 FROM para_izi_hareket WHERE kaynak_ref = %s OR kaynak_ref LIKE %s LIMIT 1", (ref, ref + "#%"))
        if cur.fetchone():
            return {"ok": True, "id": None, "idler": [], "tekrar": True, "mesaj": "Bu kayıt zaten yazılmıştı (ikinci kez yazılmadı)"}
    cep_list, C, kayit, _ = _yukle(cur)
    ol = _olaylar(kayit)
    kilit = _sayim_kilidi(ol)

    def cep_var(cid, turler=None):
        if not cid or cid not in C or (turler and C[cid]["tur"] not in turler):
            raise HTTPException(400, "Cep bulunamadı ya da bu işlem için uygun değil")

    tut = _kurus(body.tutar) if body.tutar is not None else 0
    yeni = None
    gec_kilitli = False
    if t == "acilis":
        cep_var(body.cep)
        if tut < 0:
            raise HTTPException(400, "Açılış bakiyesi eksi olamaz")
        if any(h["tur"] == "acilis" and h["cep"] == body.cep and h["is_gunu"] == bas.isoformat() for h in kayit):
            raise HTTPException(409, "Bu cebin açılış bakiyesi zaten girilmiş. Düzeltmek için önce eskisini iptal et.")
        gun = bas.isoformat()
        yeni = _sahte(t, gun, cep=body.cep, tutar=tut)
    elif t == "kapanis":
        cep_var(body.cep, {"sube"})
        kart = _kurus(body.kart or 0)          # elle kapanışta 'kart' = POS
        onl = _kurus(body.online or 0)
        if tut < 0 or kart < 0 or onl < 0 or (tut == 0 and kart == 0 and onl == 0):
            raise HTTPException(400, "Nakit, kart ya da online tutarı gir")
        mevcut = next((h for h in kayit if h["tur"] == "kapanis" and h["cep"] == body.cep and h["is_gunu"] == gun), None)
        if mevcut:
            # Sahip (2026-10-16): Evo'nun TAHMİNİ (şube kapanış yapmamış) gerçek kapanışla DEĞİŞTİRİLİR;
            # eskisi silinmez, iptal kaydıyla devre dışı kalır. Gerçek kapanış varsa 409.
            if mevcut["veri"].get("eski_kaynak") != "evo_taslak":
                raise HTTPException(409, "Bu şubenin bu güne ait kapanışı zaten var")
            evo_yerine = mevcut
            kayit = [h for h in kayit if h["id"] != mevcut["id"]]
        yeni = _sahte(t, gun, cep=body.cep, tutar=tut, durum="bekliyor", veri={"kart": kart + onl, "pos": kart, "online": onl})
        gun_ici_sayim = any(o["olay"] == "sayim" and o.get("cep") == body.cep and o["gun"] == gun
                            and o["veri"].get("kaynak") != "acilis_sayimi" for o in ol)
        # K10 (Fable #2) korunur: aynı GÜN İÇİNDE sayılmış çekmeceye kapanış 409 — geç kapanış yalnız günün TAMAMI sayımdan önce bittiyse
        # (gün < son sayım günü, ya da o günün sayımı ertesi sabahın açılış sayımı)
        if not kor and not mevcut and body.cep in kilit and gun <= kilit[body.cep] and not gun_ici_sayim:
            # F3.2 (sim 25 Eki · L4b Codex): kapanışı HİÇ girilmemiş gün sonradan sayıldıysa "Kapanışı gir" 409 veriyordu (iş bitmiyordu).
            # Panelin geç kapanış deseni (panel_kapanis_yaz) AYNEN: defter nakdi 0 (sayım bozulmaz, çift sayım yok) · ciro BEYANI saklı
            # (Gelir/Satış kapanis_kanallari'ndan okur) · POS korunur · fazla sayım farkı merkez kararına kalır (otomatik çözüm YOK).
            yeni = _sahte(t, gun, cep=body.cep, tutar=0, durum="onaylandi",
                          veri={"kart": kart + onl, "pos": kart, "online": onl, "eski_kaynak": "merkez", "sayimdan_sonra": True,
                                "sonradan_goruldu": True,   # merkez kendisi girdi → "panel kapanışı sonradan değişti" işi doğmasın
                                "panel_sonradan": [{"nakit": tut, "kart": kart + onl, "pos": kart, "online": onl, "zaman": _simdi_iso()}]})
            gec_kilitli = True
    elif t == "dis":
        cep_var(body.cep)
        alt = body.alt if body.alt in DIS_TURLERI else None
        if not alt:
            raise HTTPException(400, "Giriş türü seç")
        if tut <= 0:
            raise HTTPException(400, "Tutar gir")
        if alt in ("destek", "borc", "kredi") and not (body.kimden or "").strip():
            raise HTTPException(400, "Kimden geldiğini yaz")
        veri_ = {"alt": alt, "kimden": (body.kimden or "").strip()[:80], "not": (body.not_ or "").strip()[:200]}
        if isinstance(body.bag, dict):
            veri_["bag"] = {str(k)[:20]: (str(v)[:80] if v is not None else None) for k, v in list(body.bag.items())[:6]}
        yeni = _sahte(t, gun, cep=body.cep, tutar=tut, veri=veri_)
    elif t == "teslim":
        cep_var(body.kaynak, {"sube"})
        cep_var(body.hedef, {"ev", "hesap"})
        if tut <= 0:
            raise HTTPException(400, "Tutar gir")
        yeni = _sahte(t, gun, kaynak=body.kaynak, hedef=body.hedef, tutar=tut, durum="bekliyor",
                      veri={"teslim_eden": (body.teslim_eden or "").strip()[:60], "not": (body.not_ or "").strip()[:200] or None})   # ara teslim açıklaması
    elif t == "tasima":
        # Sahip: "Onur'un ve Fatma'nın evindeki para toplanıp Fethi'nin hesabına gitti" →
        # BİRDEN ÇOK KAYNAK tek hedefe, tek transaction (ya hepsi ya hiçbiri).
        kaynaklar = ([{"cep": p.cep, "tutar": _kurus(p.tutar)} for p in body.parcalar if p.tutar and p.tutar > 0]
                     if body.parcalar else [{"cep": body.kaynak, "tutar": tut}])
        cep_var(body.hedef)
        if not kaynaklar:
            raise HTTPException(400, "En az bir kaynak ekle")
        if len({k["cep"] for k in kaynaklar}) != len(kaynaklar):
            raise HTTPException(400, "Aynı cep iki kez seçilemez")
        yeniler = []
        for k in kaynaklar:
            cep_var(k["cep"])
            if k["cep"] == body.hedef:
                raise HTTPException(400, "Nereden ve nereye aynı olamaz")
            if C[k["cep"]]["tur"] == "sube" and C[body.hedef]["tur"] == "ev":
                raise HTTPException(400, "Şubeden patrona para TESLİM ile geçer. '+ Teslim'i kullan.")
            if k["tutar"] <= 0:
                raise HTTPException(400, "Tutar gir")
            yeniler.append(_sahte(t, gun, kaynak=k["cep"], hedef=body.hedef, tutar=k["tutar"],
                                  veri={"toplu": len(kaynaklar) > 1}))
        yeni = yeniler[0]
    elif t == "odeme":
        ac = (body.aciklama or "").strip()
        if not ac:
            raise HTTPException(400, "Ne ödendiğini yaz")
        ps = [{"cep": p.cep, "tutar": _kurus(p.tutar)} for p in (body.parcalar or []) if p.tutar and p.tutar > 0]
        if not ps:
            raise HTTPException(400, "En az bir kaynak ekle")
        if len({p["cep"] for p in ps}) != len(ps):
            raise HTTPException(400, "Aynı cep iki kez seçilemez")
        for p in ps:
            cep_var(p["cep"])
        top = sum(p["tutar"] for p in ps)
        if top != tut:
            raise HTTPException(400, f"Kaynaklar ({_tl(top)}) ödemeye ({_tl(tut)}) eşit olmalı")
        yeni = _sahte(t, gun, tutar=top, veri={"aciklama": ac[:120], "kimin": (body.kimin or "Ortak")[:40], "parcalar": ps})
    elif t == "pos_yatis":
        # 💳 POS/online parası bankaya YATTI (net). Brüt karşılığı: verilmezse şubenin
        # komisyon oranıyla TAHMİN edilir (etiketli) — fark otomatik "komisyon" sayılmaz.
        cep_var(body.cep, {"banka"})
        sube_cep = body.kaynak if body.kaynak in C and C[body.kaynak]["tur"] == "sube" else None
        if not sube_cep:
            sid = C[body.cep].get("sube_id")
            sube_cep = ("sube:" + sid) if sid and ("sube:" + sid) in C else None
        if not sube_cep:
            raise HTTPException(400, "POS yatışı hangi şubenin satışı? Şube seç.")
        if tut <= 0:
            raise HTTPException(400, "Yatan tutarı gir")
        kanal = body.alt if body.alt in ("pos", "online") else "online"
        if kanal == "pos":
            raise HTTPException(400, "POS ertesi gün kendiliğinden yatar — elle girilmez. Fark varsa ekstre bakiyesiyle yakalanır.")
        if body.kart is not None and body.kart > 0:
            brut, tahmini = _kurus(body.kart), False
        else:
            oran = (_oranlar(cur).get(C[sube_cep].get("sube_id")) or (0, 0))[0 if kanal == "pos" else 1]
            brut, tahmini = (round(tut / (1 - oran / 100)) if 0 <= oran < 100 else tut), True
        yeni = _sahte(t, gun, cep=body.cep, tutar=tut,
                      veri={"kanal": kanal, "sube_cep": sube_cep, "brut": brut, "brut_tahmini": tahmini,
                            "not": (body.not_ or "").strip()[:200]})
    elif t == "sayim":
        cep_var(body.cep)
        if C[body.cep]["tur"] == "banka":
            _pos_otomatik(cur)
            cep_list, C, kayit, _ = _yukle(cur)
            ol = _olaylar(kayit)
            kilit = _sayim_kilidi(ol)
        if body.sayilan is None or body.sayilan < 0:
            raise HTTPException(400, "Sayılan tutarı gir")
        beklenen = _bakiye([o for o in ol if o["gun"] <= gun], C)["b"].get(body.cep, 0)
        say = _kurus(body.sayilan)
        yeni = _sahte(t, gun, cep=body.cep, tutar=say, veri={"beklenen": beklenen, "sayilan": say})
    elif t == "cozum":
        x = next((z for z in _farklar(ol, C) if z["id"] == body.fark_id), None)
        if not x:
            raise HTTPException(404, "Fark bulunamadı")
        if x["coz"]:
            raise HTTPException(409, "Bu fark zaten kapanmış")
        if body.sebep not in _sebep_secenekleri(x, ol, C):
            raise HTTPException(400, "Bu fark için geçersiz sebep")
        if body.sebep in ("kayip", "harcandi", "bulundu", "ekstre_dogru", "kartla") and not (body.not_ or "").strip():
            raise HTTPException(400, "Bu sebepte kısa açıklama zorunlu (ne oldu / nerede bulundu?)")
        if gun < x["tarih"]:
            raise HTTPException(400, "Fark, oluştuğu günden önce kapatılamaz")
        cf = x["kalan"]   # kısmi kapanmış farkta kalan
        kanal = None
        if body.sebep == "kartla":
            # ÇİFT KAYIT (sahip 21 Eki): kart zaten çekildi → o günün kapanış NAKDİ −t (POS'a dokunulmaz); çözüm cebe +t AYNI GÜN
            # (çekmecede net 0, sayım bozulmaz) → Gelir / Satış ciroyu TEK kanal kuralından doğru görür
            kt = _kurus(body.tutar) if body.tutar is not None else cf
            if kt <= 0 or kt > cf:
                raise HTTPException(400, f"Tutar 0'dan büyük ve kalan farktan ({_tl(cf)}) küçük ya da eşit olmalı")
            kap = [h for h in kayit if h["tur"] == "kapanis" and h["cep"] == x["cep"] and h["is_gunu"] == x["tarih"]
                   and (h["veri"] or {}).get("eski_kaynak") != "evo_taslak"]
            kap.sort(key=lambda h: (h.get("durum") != "onaylandi", h.get("_sira") or ""))   # onaylı önce
            if not kap:
                raise HTTPException(409, f"{date.fromisoformat(x['tarih']).strftime('%d.%m.%Y')} günü bu şubenin kapanışı yok — düzeltilemez")
            if (kap[0]["veri"] or {}).get("sayimdan_sonra"):
                raise HTTPException(409, "Bu günün kapanışı sayımdan SONRA geldi ve deftere yazılmadı — bu fark ondan doğmaz; "
                                         "ciro beyanı için kapanışı merkezden düzelt")
            if kapanis_kanallari(kap[0])[0] < kt:
                raise HTTPException(409, f"O günün kapanış nakdi {_tl(kapanis_kanallari(kap[0])[0])} — daha büyük tutar karta aktarılamaz")
            kanal = (kap[0], kt)
            cf, gun = kt, x["tarih"]
        # Codex (21 Eki): defteri DEĞİŞTİREN çözüm, o cebin daha sonraki bir sayımının ÖNCESİNE yazılırsa o sayımın dengesi bozulur
        degisen = {"bulundu": x["cep"], "subede": x.get("sube_cep")}.get(body.sebep)   # kartla: net 0 (kapanış −t + çözüm +t aynı gün)
        if degisen in kilit and gun < kilit[degisen]:
            _kg = date.fromisoformat(kilit[degisen]).strftime("%d.%m.%Y")
            raise HTTPException(409, f"{(C.get(degisen) or {}).get('ad', degisen)} {_kg} günü yeniden sayıldı; defteri değiştiren çözüm o günden önceye "
                                     f"yazılamaz — tarihi {_kg} ya da sonrası seç")
        yeni = _sahte(t, gun, tutar=abs(cf),
                      veri={"fark_id": x["id"], "fark_ad": x["ad"], "f": cf, "sebep": body.sebep, "cep": x["cep"],
                            "sube_cep": x["sube_cep"], "sorumlu": (body.sorumlu or "")[:40], "not": (body.not_ or "").strip()[:200]})

    # ── ortak korumalar: sayım kilidi + eksiye düşme ──
    if t != "tasima":
        yeniler = [yeni]
    for i, y in enumerate(yeniler):
        y["id"] = f"__yeni{i}__"
    yeni_ol = _olaylar(yeniler)
    etkiler = [(e["cep"], o["gun"]) for o in yeni_ol for e in _etki(o, C)]
    if t != "cozum" and not gec_kilitli:   # fark çözümü sayımın kendi kapanış yoludur — kilide takılmaz; geç kapanış deftere 0 yazar (F3.2)
        # sahip 24 Eki: sayım günü BUGÜN ise sayımdan sonra yazılan yeni kayıt serbest (panelde iş günü, merkezde takvim günü — Codex)
        # Fable #2 incelemesi (24 Eki): KAPANIŞ günün TOPLAM satış nakdidir (tek an değil) — gün içi sayımdan önceki satış nakdi sayılan
        # paranın içinde zaten var → sayımdan sonra da kilitli kalır (çift sayım); saat istisnası yalnız ANLIK hareketlere
        _kilit_denetle(etkiler, kilit, C, sayim_icin=body.cep if t == "sayim" else None, kor=kor,
                       yeni_gun=None if t in GUN_TOPLAMI_TURLERI else (_is_gunu_panel().isoformat() if kor else _bugun().isoformat()))
        if evo_yerine:   # Evo tahmininin kalkması da o cebi değiştirir → sayılmış güne dokunamaz (saat istisnası YOK: tahmin sayımdan önceydi)
            _kilit_denetle([(evo_yerine["cep"], evo_yerine["is_gunu"])], kilit, C, kor=kor)
    cikan = {e["cep"] for o in yeni_ol for e in _etki(o, C) if e["d"] < 0 and e["cep"] in C}
    if not kor:   # B29 (Fable 22 Eki): panel yazımı BEYAN — gider/avansla TEK kural (sahip 20 Eki: eksiye düşse de yazılır, merkez
        #            Kasa'da görür). Doğruluğu akşam kör sayım + alanın "aldım" onayı kurar; açık günde satış nakdi henüz yokken
        #            öğlen ara teslimi ve kapanıştaki teslim (bütün kapanış!) reddediliyordu.
        _eksi_denetle(_olaylar(kayit + yeniler), cikan, gun, C)

    if evo_yerine:
        _yaz(cur, "iptal", _bugun().isoformat(), kim,
             veri={"hedef_id": evo_yerine["id"], "sebep": "Evo tahmini — şubenin gerçek kapanışı girildi"})
        for y in yeniler:
            y["veri"] = {**y["veri"], "evo_yerine": True, "evo_nakit": evo_yerine["tutar"], "evo_kart": int(evo_yerine["veri"].get("kart", 0))}
    idler = [_yaz(cur, t, y["is_gunu"], kim, cep=y["cep"], kaynak=y["kaynak"], hedef=y["hedef"], tutar=y["tutar"], durum=y["durum"],
                  veri=y["veri"], kaynak_ref=(ref if i == 0 else f"{ref}#{i}") if ref else None) for i, y in enumerate(yeniler)]
    if ref and not idler[0]:
        return {"ok": True, "id": None, "idler": [], "tekrar": True, "mesaj": "Bu kayıt zaten yazılmıştı (ikinci kez yazılmadı)"}
    if t == "cozum" and kanal:
        _kanal_duzelt(cur, kanal[0], kanal[1], kim, idler[0])
    return {"ok": True, "id": idler[0], "idler": idler}


def _kanal_duzelt(cur, h: dict, t: int, kim: str, cozum_id: str) -> None:
    """ÇİFT KAYIT düzeltmesi — 'kartla ödenmiş, nakit olarak da yazılmış' çözümüyle AYNI işlemde: o günün kapanış NAKDİ −t.
    Sahip (21 Eki): kart ZATEN çekildi → POS cihazı toplamı doğru; POS'u artırmak kartta sahte açık doğururdu. POS / otomatik yatış
    DEĞİŞMEZ. Kapanışın OKUNDUĞU alan değişir (geç kapanışta beyan · Fable) → Gelir / Satış ciroyu TEK kanal kuralından doğru görür."""
    v = dict(h["veri"] or {})
    iz = {"tur": "cift_nakit", "tutar": t, "cozum_id": cozum_id, "kim": kim, "zaman": _simdi_iso()}
    if v.get("sayimdan_sonra") and v.get("panel_sonradan"):
        son = dict(v["panel_sonradan"][-1])
        son["nakit"] = int(son.get("nakit", 0)) - t
        v["panel_sonradan"] = v["panel_sonradan"][:-1] + [son]
        yeni_tutar = int(h["tutar"])   # defter 0 kalır (sayımdan sonra gelen kapanış)
    else:
        yeni_tutar = int(h["tutar"]) - t
        if v.get("panel_sonradan"):   # Codex P2: saklı panel beyanı da NET esasta kalsın (sahte 'sonradan değişti' doğmasın)
            son = dict(v["panel_sonradan"][-1])
            son["nakit"] = int(son.get("nakit", 0)) - t
            v["panel_sonradan"] = v["panel_sonradan"][:-1] + [son]
    v.setdefault("kanal_duzeltme", []).append(iz)
    cur.execute("UPDATE para_izi_hareket SET tutar=%s, veri=%s::jsonb WHERE id=%s", (yeni_tutar, json.dumps(v, ensure_ascii=False), h["id"]))


@router.post("/hareket")
def hareket_ekle(body: HareketBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Tek yazma kapısı. Tek transaction + modül kilidi: ya tamamı yazılır ya hiçbiri."""
    _hazirla()
    with db() as (conn, cur):
        return kasa_yaz(cur, body, _aktor(cur, x_evvel_oturum))


class OnayBody(BaseModel):
    alinan: Optional[TrTutar] = None


@router.post("/hareket/{hid}/onay")
def onayla(hid: str, body: OnayBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Kapanış onayı (merkez karşılaştırıp onaylar) ya da teslim 'aldım' (sayılan tutarla, BUGÜN)."""
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cep_list, C, kayit, _ = _yukle(cur)
        r = next((h for h in kayit if h["id"] == hid), None)
        if not r:
            raise HTTPException(404, "Kayıt bulunamadı ya da iptal edilmiş")
        if r["durum"] == "onaylandi":
            raise HTTPException(409, "Zaten onaylanmış")
        veri = dict(r["veri"])
        if r["tur"] == "teslim":
            if body.alinan is None:
                raise HTTPException(400, "Saydığın tutarı yaz")
            al = _kurus(body.alinan)
            if al < 0:
                raise HTTPException(400, "Sayılan tutar eksi olamaz")
            bugun = r["is_gunu"] if _geriye_donuk(r) else max(_bugun().isoformat(), r["is_gunu"])
            _ol = _olaylar(kayit)
            kilit = _sayim_kilidi(_ol)
            ks = kilit.get(r["hedef"])
            # sahip 24 Eki ("akşamında tekrar teslim olacak"): teslim sayımdan SONRA yola çıktıysa para sayıma girmedi → bugün 'aldım'
            sayim_sonrasi = bool(ks and bugun == ks and not _geriye_donuk(r) and _sayimdan_sonra(r["hedef"], ks, r.get("_sira"), _sayim_anlari(_ol)))
            if ks and bugun <= ks and not _geriye_donuk(r) and not sayim_sonrasi:
                # B75 (Fable 22 Eki): ev teslimden SONRA sayıldı → 'aldım' reddedilmez, para sayımdan SONRAKİ gün eve girer
                # (sayım günü ve öncesi bozulmaz; sayım parayı içerdiyse fazla zaten Kasa › Açık farklar'da — tek karar evi)
                ertesi = date.fromordinal(date.fromisoformat(ks).toordinal() + 1).isoformat()
                if ertesi > _bugun().isoformat():
                    raise HTTPException(409, f"{C[r['hedef']]['ad']} bugün sayıldı — 'Aldım'ı yarın gir (bugünkü sayım bozulmasın)")
                bugun = ertesi
            if ks and ks >= r["is_gunu"] and not _geriye_donuk(r) and not sayim_sonrasi:
                veri["kilit_sonrasi"] = ks   # Fable: ev teslimden sonra sayıldıysa iz her durumda
            veri.update(alinan=al, onay_gunu=bugun)
            _kilit_denetle([(r["hedef"], bugun)], kilit, C, yeni_gun=bugun if sayim_sonrasi else None)
        elif r["tur"] != "kapanis":
            raise HTTPException(400, "Bu kayıt onay gerektirmez")
        # Codex: NOW() işlem başı — kilitte bekleyen onay sayımdan ÖNCE görünmesin → gerçek an
        cur.execute("""UPDATE para_izi_hareket SET durum='onaylandi', onay_zamani=clock_timestamp(), onaylayan=%s, veri=%s::jsonb
                        WHERE id=%s AND COALESCE(durum,'') <> 'onaylandi'""", (kim, json.dumps(veri, ensure_ascii=False), hid))
    return {"ok": True}


class IptalBody(BaseModel):
    sebep: str


@router.post("/hareket/{hid}/iptal")
def iptal(hid: str, body: IptalBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Kayıt SİLİNMEZ — 'iptal' kaydı yazılır; bakiyeler kayıt yokmuş gibi yeniden hesaplanır.
    Sayılmış bir cebi etkiliyorsa ya da bir cebi geçmişte eksiye düşürecekse REDDEDİLİR."""
    if not (body.sebep or "").strip():
        raise HTTPException(400, "İptal sebebi zorunlu")
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cep_list, C, kayit, _ = _yukle(cur)
        h = next((x for x in kayit if x["id"] == hid), None)
        if not h:
            raise HTTPException(404, "Kayıt bulunamadı ya da zaten iptal")
        if any(x["tur"] == "cozum" and x["veri"].get("fark_id") == hid for x in kayit):
            raise HTTPException(409, "Bu kaydın farkı kapatılmış; önce fark kapanışını iptal et")
        ol_eski = _olaylar([h])
        _ol = _olaylar([x for x in kayit if x["id"] != hid]) if h["tur"] == "sayim" else _olaylar(kayit)
        kilit, anlar = _sayim_kilidi(_ol), _sayim_anlari(_ol)
        kartla = h["tur"] == "cozum" and (h["veri"] or {}).get("sebep") == "kartla"
        if h["tur"] != "sayim" and not kartla:   # kartla: kapanış −t + çözüm +t aynı gün, net 0 — geri alınınca da net 0 (Fable)
            # sahip 24 Eki + Codex: etkinin KENDİ anı (teslim çıkışı kayıt anı, alımı onay anı) sayımdan sonraysa o etki sayıma girmedi → serbest
            _kilit_denetle([(e["cep"], o["gun"]) for o in ol_eski for e in _etki(o, C)
                            if not _sayimdan_sonra(e["cep"], o["gun"], o.get("s"), anlar)], kilit, C)
        else:
            # Codex (24 Eki): aynı gün iki sayımda ikisi de iptal edilemiyordu — yalnız KESİN sonraki sayım engel (sondan geri alınır)
            sonraki = [x for x in kayit if x["tur"] == "sayim" and x["cep"] == h["cep"] and x["id"] != hid
                       and (x["is_gunu"], x.get("_sira") or "") > (h["is_gunu"], h.get("_sira") or "")]
            if sonraki:
                raise HTTPException(409, "Bu cebin daha sonra (ya da aynı gün) başka sayımı var; önce onu iptal et")
        azalan = {e["cep"] for o in ol_eski for e in _etki(o, C) if e["d"] > 0 and e["cep"] in C}
        kalan_kayit = [x for x in kayit if x["id"] != hid]
        if kartla:   # Fable R: kapanış nakdinin +t geri konuşu da denetime girsin (yoksa meşru iptal yanlış 'eksi'ye düşer)
            kalan_kayit = [{**x, "tutar": int(x["tutar"]) + sum(int(z.get("tutar", 0)) for z in ((x["veri"] or {}).get("kanal_duzeltme") or [])
                                                                 if z.get("cozum_id") == hid and not z.get("iptal"))}
                           if x["tur"] == "kapanis" else x for x in kalan_kayit]
        try:
            _eksi_denetle(_olaylar(kalan_kayit), azalan, h["is_gunu"], C)
        except HTTPException as e:
            if h["tur"] in ("kapanis", "dis", "teslim", "tasima"):   # B60: hangi sırayla iptal edileceğini söyle
                raise HTTPException(e.status_code, f"{e.detail} Bu kayıttan beslenen çıkışlar var (ör. o günün ara teslimi / teslimi) — "
                                                   f"önce onları iptal et, sonra bunu.")
            raise
        _yaz(cur, "iptal", _bugun().isoformat(), kim, veri={"hedef_id": hid, "sebep": body.sebep.strip()[:200]})
        if kartla:   # kapanış nakdi geri konur (iz: kanal_duzeltme satırı 'iptal')
            for kp in kayit:
                kd = (kp["veri"] or {}).get("kanal_duzeltme") or []
                if kp["tur"] == "kapanis" and any(z.get("cozum_id") == hid and not z.get("iptal") for z in kd):
                    t_ = sum(int(z.get("tutar", 0)) for z in kd if z.get("cozum_id") == hid and not z.get("iptal"))
                    v2 = dict(kp["veri"])
                    v2["kanal_duzeltme"] = [{**z, "iptal": kim} if z.get("cozum_id") == hid else z for z in kd]
                    if v2.get("panel_sonradan"):   # beyan da geri (net esas)
                        sn = dict(v2["panel_sonradan"][-1])
                        sn["nakit"] = int(sn.get("nakit", 0)) + t_
                        v2["panel_sonradan"] = v2["panel_sonradan"][:-1] + [sn]
                    cur.execute("UPDATE para_izi_hareket SET tutar = tutar + %s, veri=%s::jsonb WHERE id=%s",
                                (t_, json.dumps(v2, ensure_ascii=False), kp["id"]))
    return {"ok": True}


# ─────────────────────────── ESKİ SİSTEMDEN TEK YÖNLÜ AKTARIM ───────────────────────────
def _patron_bul(ad: str) -> Optional[str]:
    """kasa_teslim.teslim_alan_ad serbest metin — Onur/Fethi/Fatma adını içeriyorsa eşle."""
    a = (ad or "").replace("İ", "i").replace("I", "ı").lower()
    # Sahip (2026-10-16): "Fethi evden Fethi hesaba taşı — bankalara geçiş hesabı" → Fethi'ye teslim GEÇİŞ HESABINA düşer
    for ad_, cid in TESLIM_HEDEFLERI.items():
        if ad_.lower() in a:
            return cid
    return None


@router.post("/aktar")
def eski_sistemden_aktar(kuru: bool = True, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        from evvel_yeni_cekirdek import eski_panel_zinciri_acik, tablo_var
        if not (eski_panel_zinciri_acik() and tablo_var(cur, "ciro", "ciro_taslak", "kasa_teslim")):   # A3 (köprü taraması 23 Eki)
            raise HTTPException(410, "Eski sistem kapandı — aktarılacak eski kayıt yok (yeni panel doğrudan Kasa'ya yazar)")
        kim = "eski sistem aktarımı · " + _aktor(cur, x_evvel_oturum)
        return _aktar(cur, kuru, kim)


_SON_SENKRON = {"zaman": None, "sonuc": None}


def _otomatik_senkron() -> dict:
    """🌉 ESKİYLE YAN YANA (sahip): şube paneli hâlâ eski tablolara yazıyor. Durum her
    okunduğunda — en sık 10 dakikada bir — yeni kapanış/teslimler kendiliğinden çekilir.
    Kendi transaction'ı; patlarsa ekran ETKİLENMEZ, hata ekrana yazılır (sessiz değil)."""
    import time as _t
    simdi = _t.time()
    z = _SON_SENKRON["zaman"]
    if z is None or simdi - z >= SENKRON_ARALIK_SN:
        _SON_SENKRON["zaman"] = simdi
        try:
            with db() as (conn, cur):
                _kilit(cur)
                oz = {"kapanis": 0, "teslim": 0, "eslesmeyen_teslim": 0, "kilitli": 0}
                hatalar, kopru = [], "kapali"
                # B14 (Fable 22 Eki): ESKİ köprü yalnız eski panel zinciri açıkken ve tablolar varken, KENDİ savepoint'inde —
                # patlarsa yeni panel işleri yine koşar (kesim günü bu blok + _aktar silinir; yeni adımlara dokunulmaz)
                from evvel_yeni_cekirdek import eski_panel_zinciri_acik, tablo_var
                if eski_panel_zinciri_acik() and tablo_var(cur, "ciro", "ciro_taslak", "kasa_teslim"):
                    kopru = "acik"
                    try:
                        with savepoint(cur, "sp_pi_kopru"):
                            oz.update({k: v for k, v in (_aktar(cur, False, "otomatik köprü (eski sistem)").get("ozet") or {}).items() if k in oz})
                    except Exception as e:  # noqa: BLE001
                        log.warning("evvel-yeni eski köprü: %s", str(e)[:200])
                        hatalar.append("eski köprü: " + str(e)[:120])
                for ad, fn in (("otomatik_kabul", _otomatik_kabul), ("pos_otomatik", _pos_otomatik)):
                    try:
                        with savepoint(cur, f"sp_pi_{ad}"):
                            oz[ad] = fn(cur)
                    except Exception as e:  # noqa: BLE001
                        log.warning("evvel-yeni %s: %s", ad, str(e)[:200])
                        hatalar.append(f"{ad}: {str(e)[:120]}")
                try:
                    with savepoint(cur, "sp_pi_ps_oto"):
                        oz["panel_sayim"] = (_panel_sayimlari(cur, False).get("ozet") or {}).get("sayim", 0)
                except Exception as e:  # noqa: BLE001 — sayım aktarımı patlarsa senkronun gerisi yaşar
                    log.warning("evvel-yeni panel sayım: %s", str(e)[:200])
                    hatalar.append("panel sayım: " + str(e)[:120])
            _SON_SENKRON["sonuc"] = {"tamam": True, "kopru": kopru, "hatalar": hatalar, **oz}
        except Exception as e:  # noqa: BLE001
            log.warning("evvel-yeni kasa otomatik senkron: %s", str(e)[:200])
            _SON_SENKRON["sonuc"] = {"tamam": False, "hata": str(e)[:160]}
    from datetime import datetime, timezone
    zz = _SON_SENKRON["zaman"]
    return {**(_SON_SENKRON["sonuc"] or {}),
            "zaman": datetime.fromtimestamp(zz, timezone.utc).isoformat() if zz else None}


def _kilitli_teslim(h: dict, kilit: Dict[str, str], anlar: Optional[Dict[str, tuple]] = None) -> bool:
    """TEK kural: teslimin hedef cebi teslim günü ya da sonrasında SAYILMIŞ → otomatik kabul edilemez, merkez 'aldım' der.
    Sahip 24 Eki: teslim sayım GÜNÜ, sayımdan SONRA kaydedildiyse para sayıma girmedi → kilitli değil."""
    if anlar and _sayimdan_sonra(h["hedef"], h["is_gunu"], h.get("_sira"), anlar):
        return False
    return h["hedef"] in kilit and h["is_gunu"] <= kilit[h["hedef"]]


def _otomatik_kabul(cur) -> int:
    """Teslim gününden en az OTOMATIK_KABUL_GUN geçmiş, hâlâ 'aldım' denmemiş teslimleri
    teslim edilen tutarla KABUL eder (para teslim günü eve girmiş sayılır). Patronun evi o
    günden sonra sayıldıysa (sayım kilidi) dokunmaz — orada bekler, ekranda görünür."""
    cep_list, C, kayit, _ = _yukle(cur)
    _ol = _olaylar(kayit)
    kilit, anlar = _sayim_kilidi(_ol), _sayim_anlari(_ol)
    sinir = date.fromordinal(_bugun().toordinal() - OTOMATIK_KABUL_GUN).isoformat()
    n = 0
    for h in kayit:
        if h["tur"] != "teslim" or h["durum"] == "onaylandi" or h["is_gunu"] > sinir:
            continue
        if _kilitli_teslim(h, kilit, anlar):
            continue
        veri = dict(h["veri"])
        veri.update(alinan=h["tutar"], onay_gunu=h["is_gunu"], otomatik=True)
        cur.execute("""UPDATE para_izi_hareket SET durum='onaylandi', onay_zamani=clock_timestamp(),
                              onaylayan='otomatik kabul (itiraz yok)', veri=%s::jsonb
                        WHERE id=%s AND COALESCE(durum,'') <> 'onaylandi'""", (json.dumps(veri, ensure_ascii=False), h["id"]))
        n += cur.rowcount
    return n


def _pos_otomatik(cur) -> int:
    """Kapanış günü + POS_YATIS_GUN geçmiş her kapanışın POS'unu şube bankasına 'beklenen net'
    olarak yazar (kaynak_ref 'pos_oto:<kapanış>' → bir kez). Banka o gün ve sonrası sayıldıysa
    (sayım kilidi) yazmaz. Kapanış İPTAL edilmişse otomatik yatış da iptal edilir."""
    # Codex: 31 Ekim POS'u 1 Kasım'da yatar → kaynak kapanış ÖNCEKİ dönemde olabilir.
    cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
    bas = _baslangic(cur).isoformat()
    kilit = _sayim_kilidi(_olaylar([h for h in kayit if h["is_gunu"] >= bas]))
    oranlar = _oranlar(cur)
    if not oranlar:
        log.warning("evvel-yeni kasa POS otomatik: şube komisyon oranları okunamadı — yatış yazılmadı")
        return 0
    bugun = _bugun()
    var = {h.get("kaynak_ref"): h for h in kayit if (h.get("kaynak_ref") or "").startswith("pos_oto:")}
    cur.execute("SELECT kaynak_ref FROM para_izi_hareket WHERE kaynak_ref LIKE 'pos_oto:%%'")
    her_zaman = {dict(x)["kaynak_ref"] for x in cur.fetchall() or []}
    gecerli_kapanis = {h["id"] for h in kayit if h["tur"] == "kapanis"}
    n = 0
    for h in kayit:
        if h["tur"] != "kapanis":
            continue
        v = h["veri"]
        if "pos" not in v:          # Codex: POS/online ayrılmamış kart toplamı otomatiğe ALINMAZ
            continue
        pos = kapanis_kanallari(h)[1]   # Fable (21 Eki): TEK kanal kuralı — sayımdan sonra gelen kapanışta beyan (bekleyen ile aynı)
        yatis = date.fromordinal(date.fromisoformat(h["is_gunu"]).toordinal() + POS_YATIS_GUN)
        g = yatis.isoformat()
        if yatis > bugun or g < bas:
            continue
        sube = C.get(h["cep"], {})
        sid = str(sube.get("sube_id"))
        banka = "banka:" + sid
        ref = "pos_oto:" + h["id"]
        if banka not in C or sid not in oranlar:
            continue
        oran = oranlar[sid][0]
        net = pos - komisyon(pos, oran)   # TEK komisyon kuralı (T1-12)
        kilitli = banka in kilit and g <= kilit[banka]
        if ref in var:
            # Kapanış sonradan düzeltildiyse otomatik yatış da düzelir (kilitli değilse)
            mevcut = var[ref]
            if int(mevcut["veri"].get("brut", 0)) != pos and not kilitli:
                v2 = dict(mevcut["veri"])
                v2.setdefault("duzeltmeler", []).append({"eski_brut": int(v2.get("brut", 0)), "eski_net": mevcut["tutar"]})
                v2.update(brut=pos, oran=oran)
                cur.execute("UPDATE para_izi_hareket SET tutar=%s, veri=%s::jsonb WHERE id=%s",
                            (net if pos > 0 else 0, json.dumps(v2, ensure_ascii=False), mevcut["id"]))
            continue
        if pos <= 0 or ref in her_zaman or kilitli:
            continue
        _yaz(cur, "pos_yatis", g, "otomatik (POS ertesi gün)", cep=banka, tutar=net,
             veri={"kanal": "pos", "sube_cep": h["cep"], "brut": pos, "brut_tahmini": False, "otomatik": True,
                   "kapanis_id": h["id"], "oran": oran}, kaynak_ref=ref)
        n += 1
    # Kapanışı iptal edilenin otomatik yatışı da iptal (iz kalır) — banka sayılmışsa DOKUNMA
    for ref, h in var.items():
        if h["veri"].get("kapanis_id") not in gecerli_kapanis and not (h["cep"] in kilit and h["is_gunu"] <= kilit[h["cep"]]):
            _yaz(cur, "iptal", bugun.isoformat(), "otomatik (POS ertesi gün)",
                 veri={"hedef_id": h["id"], "sebep": "Kaynak kapanış iptal edildi"})
    return n


class DuzeltBody(BaseModel):
    alinan: TrTutar


@router.post("/hareket/{hid}/teslim-duzelt")
def teslim_duzelt(hid: str, body: DuzeltBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Kabul edilmiş (otomatik ya da tek dokunuşla) teslimde "aslında farklıydı" düzeltmesi —
    7 gün içinde. Fark açık farka düşer; teslim edilen tutar değişmez."""
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cep_list, C, kayit, _ = _yukle(cur)
        h = next((x for x in kayit if x["id"] == hid and x["tur"] == "teslim"), None)
        if not h or h["durum"] != "onaylandi":
            raise HTTPException(404, "Kabul edilmiş teslim bulunamadı")
        og = h["veri"].get("onay_gunu") or h["is_gunu"]
        if _gun_fark(og, _bugun().isoformat()) > DUZELTME_SURESI_GUN:
            raise HTTPException(409, f"{DUZELTME_SURESI_GUN} günlük düzeltme süresi geçti — farkı evdeki sayımla yakala")
        if any(x["tur"] == "cozum" and x["veri"].get("fark_id") == hid for x in kayit):
            raise HTTPException(409, "Bu teslimin farkı zaten kapatılmış")
        al = _kurus(body.alinan)
        if al < 0:
            raise HTTPException(400, "Sayılan tutar eksi olamaz")
        _ol = _olaylar(kayit)   # Codex: hedefte ÖZGÜN alım olayının anı (onay) sayımdan sonraysa düzeltme sayımı bozmaz
        _an = h["onay_zamani"].isoformat() if hasattr(h.get("onay_zamani"), "isoformat") else None
        if not _sayimdan_sonra(h["hedef"], og, _an, _sayim_anlari(_ol)):
            _kilit_denetle([(h["hedef"], og)], _sayim_kilidi(_ol), C)
        veri = dict(h["veri"])
        veri.setdefault("duzeltmeler", []).append({"eski": int(veri.get("alinan", h["tutar"])), "yeni": al, "kim": kim})
        veri["alinan"] = al
        # E2E #1: alınan AZALINCA hedef cep (patron evi) o günden sonra eksiye düşmesin (para zaten harcanmış olabilir).
        # Fable: yönlü — artış (1.000 değil 1.200 saydım) bakiyeyi iyileştirir, eski bir eksik yüzünden reddedilmez.
        if al < int(veri["duzeltmeler"][-1]["eski"]):
            _eksi_denetle(_olaylar([{**x, "veri": veri} if x["id"] == hid else x for x in kayit]), {h["hedef"]}, og, C)
        cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(veri, ensure_ascii=False), hid))
    return {"ok": True}


class TopluOnayBody(BaseModel):
    idler: List[str]


class EvoKabulBody(BaseModel):
    cep: str


@router.post("/evo-kabul")
def evo_kabul(b: EvoKabulBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Sahip/Fable (2026-10-16): "30 Evo tahmini tek tek çözülemez" → şubenin Evo tahmini günlerini TOPLU kabul.
    Rakam değişmez, kayıt silinmez; yalnız 'kabul edildi' işareti + iz (kim/ne zaman). Bekleyen işlerden düşer."""
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        _, C, kayit, _ = _yukle(cur)
        n = 0
        for h in kayit:
            v = h["veri"]
            if h["tur"] == "kapanis" and h["cep"] == b.cep and v.get("eski_kaynak") == "evo_taslak" and not v.get("evo_kabul"):
                v2 = {**v, "evo_kabul": True, "duzeltmeler": list(v.get("duzeltmeler") or []) +
                      [{"kim": kim, "zaman": _bugun().isoformat(), "degisen": {"evo": ["tahmin", "kabul edildi"]}}]}
                cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(v2, ensure_ascii=False), h["id"]))
                n += 1
    return {"ok": True, "adet": n, "mesaj": f"{n} günün Evo rakamı kabul edildi"}


class PosSifirBody(BaseModel):
    id: str


@router.post("/pos-sifir-kabul")
def pos_sifir_kabul(b: PosSifirBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """'O gün gerçekten POS yoktu' — uyarıyı kapat (iz kalır)."""
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        _, C, kayit, _ = _yukle(cur)
        h = next((x for x in kayit if x["id"] == b.id and x["tur"] == "kapanis"), None)
        if not h:
            raise HTTPException(404, "Kapanış bulunamadı")
        v2 = {**h["veri"], "pos_sifir_kabul": True, "duzeltmeler": list(h["veri"].get("duzeltmeler") or []) +
              [{"kim": kim, "zaman": _bugun().isoformat(), "degisen": {"pos": ["0 uyarısı", "gerçekten POS yok"]}}]}
        cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(v2, ensure_ascii=False), h["id"]))
    return {"ok": True, "mesaj": "Uyarı kapandı"}


@router.post("/onay-toplu")
def toplu_onay(body: TopluOnayBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Yalnız KAPANIŞ onayı toplu yapılır (teslim 'aldım' her zaman tek tek, sayılan tutarla)."""
    idler = [str(i) for i in (body.idler or [])][:500]
    if not idler:
        raise HTTPException(400, "Onaylanacak kayıt yok")
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("""UPDATE para_izi_hareket h SET durum='onaylandi', onay_zamani=NOW(), onaylayan=%s
                        WHERE h.id = ANY(%s) AND h.tur='kapanis' AND COALESCE(h.durum,'') <> 'onaylandi'
                          AND NOT EXISTS (SELECT 1 FROM para_izi_hareket i WHERE i.tur='iptal' AND i.veri->>'hedef_id' = h.id)""",
                    (kim, idler))   # E2E #14: iptal edilmiş kapanış onaylanmaz
        n = cur.rowcount
    return {"ok": True, "onaylanan": n}


class DonemBody(BaseModel):
    gun: str
    kuru: bool = True


@router.post("/donem")
def yeni_donem(body: DonemBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """🔄 YENİ BAŞLANGIÇ (sahip: "1 Kasım'da sıfırlayıp devam"). Hiçbir kayıt SİLİNMEZ:
    önceki dönem arşivde kalır, hesaplara girmez. Her cep yeni başlangıç sabahı sayılıp
    açılış bakiyesiyle başlar. Varsayılan KURU: önceki dönemin kapanış bakiyelerini
    (yalnız bilgi) gösterir, değiştirmez."""
    try:
        g = date.fromisoformat(body.gun[:10])
    except ValueError:
        raise HTTPException(400, "Gün YYYY-AA-GG olmalı")
    if g > _bugun():
        raise HTTPException(400, "Yeni başlangıç ileri bir tarihe kurulamaz — o sabah kurulur")
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        bas = _baslangic(cur)
        if g <= bas:
            raise HTTPException(400, f"Yeni başlangıç geçerli dönemin başından ({bas.isoformat()}) sonra olmalı")
        cep_list, C, kayit, _ = _yukle(cur)
        ol = [o for o in _olaylar(kayit) if o["gun"] < g.isoformat()]
        D = _bakiye(ol, C)
        devir = [{"cep": c["id"], "ad": c["ad"], "defterde": _tl_sayi(D["b"].get(c["id"], 0))} for c in cep_list]
        bekleyen = len(_isler(kayit, C, _farklar(_olaylar(kayit), C), _baslangic(cur), ilk_kayit_gunleri(_yukle(cur, tum_donemler=True)[2])))
        if not body.kuru:
            kim = _aktor(cur, x_evvel_oturum)
            cur.execute("""INSERT INTO para_izi_ayar (anahtar, deger, degistiren) VALUES ('baslangic', %s, %s)
                           ON CONFLICT (anahtar) DO UPDATE SET deger=EXCLUDED.deger, degistiren=EXCLUDED.degistiren, zaman=NOW()""",
                        (g.isoformat(), kim))
            cur.execute("""INSERT INTO para_izi_ayar (anahtar, deger, degistiren) VALUES (%s, %s, %s)
                           ON CONFLICT (anahtar) DO NOTHING""", ("donem_gecmisi:" + g.isoformat(), bas.isoformat(), kim))
    return {"kuru": body.kuru, "eski_baslangic": bas.isoformat(), "yeni_baslangic": g.isoformat(),
            "onceki_donem_sonu": devir, "acik_yolda": _tl_sayi(D["yolda"]), "acik_fark": _tl_sayi(D["acik"]),
            "bekleyen_is": bekleyen}


def _aktar(cur, kuru: bool, kim: str) -> dict:
    """1 Ekim'den bu yana şube kapanışlarını ve kasa teslimlerini Para İzi'ne aktarır.
    ESKİ TABLOLARA DOKUNMAZ (yalnız SELECT). kaynak_ref benzersiz → kaç kez çalışırsa
    çalışsın çift kayıt doğmaz. Varsayılan KURU: yazmadan ne olacağını söyler.

    · Kapanış = şube + gün başına TEK kayıt. Eski sistemin işlenmiş cirosu (ciro tablosu)
      varsa o → 'onaylandı'; yoksa şube panelinin bekleyen taslağı → 'onay bekliyor'.
      Nakit kasaya, pos+online yalnız bilgi ('kart', nakde girmez).
    · Teslim: alıcı adı Onur/Fethi/Fatma içeriyorsa → 'onay bekliyor' (eski sistemde sayım
      bilgisi yok; patron saydığı tutarla 'aldım' der). Eşleşmeyen → ALINMAZ, listelenir.
    · Dış kaynak: eski sistem paranın KİMDE olduğunu tutmadığı için otomatik alınmaz.
    · Sayılmış (kilitli) güne düşen eski kayıt alınmaz, listelenir.
    """
    if True:   # (gövde eskiden kendi transaction'ındaydı; artık çağıranın transaction'ında)
        bas = _baslangic(cur)
        cep_list, C, kayit, _ = _yukle(cur)
        kilit = _sayim_kilidi(_olaylar(kayit))
        sube_cep = {c["sube_id"]: c["id"] for c in cep_list if c["tur"] == "sube"}
        var = {h.get("kaynak_ref") for h in kayit if h.get("kaynak_ref")}
        rapor = {"kapanis": [], "teslim": [], "eslesmeyen_teslim": [], "kilitli": [], "dis_kaynak": [], "atlanan": 0}

        gunluk = {}
        cur.execute("""SELECT sube_id, tarih, SUM(nakit) AS nakit, SUM(pos) AS pos, SUM(online) AS online
                         FROM ciro WHERE tarih >= %s AND COALESCE(durum,'aktif')='aktif'
                        GROUP BY sube_id, tarih""", (bas,))
        for r in cur.fetchall() or []:
            r = dict(r)
            gunluk[(str(r["sube_id"]), r["tarih"])] = (r["nakit"] or 0, (r["pos"] or 0, r["online"] or 0), "onaylandi", "ciro")
        cur.execute("""SELECT DISTINCT ON (sube_id, tarih) sube_id, tarih, nakit, pos, online, gonderen_ad FROM ciro_taslak
                        WHERE tarih >= %s AND durum = 'bekliyor' ORDER BY sube_id, tarih, olusturma DESC""", (bas,))
        for r in cur.fetchall() or []:
            r = dict(r)
            # Sahip (2026-10-16): Evo'nun ürettiği taslak = şube KAPANIŞ YAPMAMIŞ; ayrı işaretlenir
            evo = "evo" in str(r.get("gonderen_ad") or "").lower()
            if evo and (str(r["sube_id"]), r["tarih"]) not in gunluk:
                # Sahip (2026-10-16): "Evo'yu kaldır" → Evo YENİ VERİ KAYNAĞI DEĞİL. Daha önce gelenler
                # sarı "Evo tahmini" etiketiyle kalır ("Gerçeğini gir" ile değişir); yenisi ALINMAZ —
                # o gün "Kapanış YOK" uyarısı olur ve şubeden istenir.
                rapor.setdefault("evo_alinmadi", []).append({"gun": r["tarih"].isoformat(), "sube_id": str(r["sube_id"])})
                continue
            gunluk.setdefault((str(r["sube_id"]), r["tarih"]),
                              (r["nakit"] or 0, (r["pos"] or 0, r["online"] or 0), "bekliyor", "evo_taslak" if evo else "taslak"))
        for (sid, gun_), (n, k, durum_, kaynak_) in sorted(gunluk.items(), key=lambda x: (x[0][1], x[0][0])):
            g = gun_.isoformat()
            ref = f"kapanis:{sid}:{g}"
            cid = sube_cep.get(sid)
            # Önceden aktarılmış kapanışta POS/online ayrımı yoksa tamamla (Codex: ayrı izlenmeli)
            if not kuru:
                for h in kayit:
                    if h["tur"] == "kapanis" and h["cep"] == cid and h["is_gunu"] == g and (
                            "pos" not in h["veri"] or (kaynak_ == "evo_taslak" and h["veri"].get("eski_kaynak") == "taslak")):
                        v2 = dict(h["veri"])
                        v2.setdefault("pos", _kurus(k[0]))
                        v2.setdefault("online", _kurus(k[1]))
                        if kaynak_ == "evo_taslak" and h.get("kaynak_ref") == ref:
                            v2["eski_kaynak"] = "evo_taslak"
                        cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(v2, ensure_ascii=False), h["id"]))
            if ref in var or not cid or any(h["tur"] == "kapanis" and h["cep"] == cid and h["is_gunu"] == g for h in kayit):
                rapor["atlanan"] += 1
                continue
            nakit, pos_, onl_ = _kurus(n), _kurus(k[0]), _kurus(k[1])
            kart = pos_ + onl_
            satir = {"gun": g, "sube": C[cid]["kisa"], "nakit": _tl_sayi(nakit), "kart": _tl_sayi(kart), "durum": durum_, "kaynak": kaynak_}
            if cid in kilit and g <= kilit[cid]:
                rapor["kilitli"].append(satir)
                continue
            rapor["kapanis"].append(satir)
            if not kuru:
                _yaz(cur, "kapanis", g, kim, cep=cid, tutar=nakit, durum=durum_,
                     veri={"kart": kart, "pos": pos_, "online": onl_, "eski_kaynak": kaynak_}, kaynak_ref=ref)

        try:
            with savepoint(cur, "sp_pi_teslim"):
                cur.execute("""SELECT id, sube_id, tarih, tutar, teslim_alan_ad, teslim_eden_ad FROM kasa_teslim
                                WHERE tarih >= %s AND COALESCE(durum,'aktif')='aktif' ORDER BY tarih, olusturma""", (bas,))
                teslimler = [dict(r) for r in cur.fetchall() or []]
        except Exception:  # noqa: BLE001 — durum kolonu olmayan kurulum
            cur.execute("""SELECT id, sube_id, tarih, tutar, teslim_alan_ad, teslim_eden_ad FROM kasa_teslim
                            WHERE tarih >= %s ORDER BY tarih, olusturma""", (bas,))
            teslimler = [dict(r) for r in cur.fetchall() or []]
        yetim = _yetim_teslimler(cur, {"kasa_teslim:" + str(x["id"]) for x in teslimler}, bas)   # C-T1-05: panel yoluyla AYNI koruma
        for r in teslimler:
            ref = "kasa_teslim:" + str(r["id"])
            kaynak = sube_cep.get(str(r["sube_id"]))
            hedef = _patron_bul(r.get("teslim_alan_ad"))
            if ref in var:
                rapor["atlanan"] += 1
                continue
            if kaynak and hedef and (kaynak, hedef, r["tarih"].isoformat(), _kurus(r["tutar"])) in yetim:
                yetim.discard((kaynak, hedef, r["tarih"].isoformat(), _kurus(r["tutar"])))
                rapor["atlanan"] += 1   # geri alınıp iptal edilemeyen teslimin yeniden kapanış kopyası — çift çıkış olmaz
                continue
            g = r["tarih"].isoformat()
            satir = {"gun": g, "sube": C[kaynak]["kisa"] if kaynak else r["sube_id"],
                     "alan": r.get("teslim_alan_ad"), "tutar": _tl_sayi(_kurus(r["tutar"]))}
            if not kaynak or not hedef:
                rapor["eslesmeyen_teslim"].append(satir)
                continue
            if kaynak in kilit and g <= kilit[kaynak]:
                rapor["kilitli"].append(satir)
                continue
            rapor["teslim"].append({**satir, "patron": C[hedef]["kisa"]})
            if not kuru:
                _yaz(cur, "teslim", g, kim, kaynak=kaynak, hedef=hedef, tutar=_kurus(r["tutar"]),
                     durum="bekliyor", veri={"eski_alan_ad": r.get("teslim_alan_ad"), "teslim_eden": r.get("teslim_eden_ad")}, kaynak_ref=ref)

        # 👤 Teslimi yapan personel (sahip: "tıklayınca teslim şubesi ve teslimi yapan personel
        # görünmeli") — önceden aktarılmış kayıtlarda eksikse eski kaynaktan tamamlanır.
        if not kuru:
            ad_harita = {"kasa_teslim:" + str(r["id"]): r.get("teslim_eden_ad") for r in teslimler if r.get("teslim_eden_ad")}
            for h in kayit:
                ref_ = h.get("kaynak_ref") or ""
                if h["tur"] == "teslim" and ref_ in ad_harita and not h["veri"].get("teslim_eden"):
                    v2 = dict(h["veri"])
                    v2["teslim_eden"] = ad_harita[ref_]
                    cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(v2, ensure_ascii=False), h["id"]))

        from evvel_yeni_cekirdek import yeni_donem
        if not yeni_donem(cur):   # 1 Kasım'dan sonra anlık gider yeni panelden (dukkan_gideri_yaz) — eski köprü çalışmaz
            rapor["dukkan_gideri"] = _dukkan_giderleri_aktar(cur, C, kayit, kilit, bas, kuru, kim)

        try:
            with savepoint(cur, "sp_pi_dis"):
                cur.execute("""SELECT tarih, tutar, aciklama FROM kasa_hareketleri
                                WHERE islem_turu='DIS_KAYNAK' AND COALESCE(durum,'aktif')='aktif' AND tarih >= %s
                                ORDER BY tarih""", (bas,))
                rapor["dis_kaynak"] = [{"gun": str(dict(r)["tarih"])[:10], "tutar": float(dict(r)["tutar"] or 0),
                                        "aciklama": dict(r).get("aciklama")} for r in cur.fetchall() or []]
        except Exception as e:  # noqa: BLE001
            rapor["dis_kaynak_hata"] = str(e)[:120]

    rapor["kuru"] = kuru
    rapor["ozet"] = {"kapanis": len(rapor["kapanis"]), "kapanis_onayli": sum(1 for k in rapor["kapanis"] if k["durum"] == "onaylandi"),
                     "teslim": len(rapor["teslim"]), "eslesmeyen_teslim": len(rapor["eslesmeyen_teslim"]),
                     "kilitli": len(rapor["kilitli"]), "dis_kaynak_elle": len(rapor["dis_kaynak"]),
                     "dukkan_gideri": (rapor.get("dukkan_gideri") or {}).get("yeni", 0),   # Codex P1: 1 Kasım'dan sonra köprü yok → KeyError
                     "zaten_aktarilmis": rapor["atlanan"]}
    return rapor


def _giren_adlari(cur, idler: set) -> Dict[str, str]:
    """Panel girişini yapan personelin adı (eski personel / panel kullanıcısı). Okunamazsa boş."""
    out: Dict[str, str] = {}
    if not idler:
        return out
    for q in ("SELECT id::text AS id, ad_soyad AS ad FROM personel WHERE id::text = ANY(%s)",
              "SELECT id::text AS id, ad FROM sube_panel_kullanici WHERE id::text = ANY(%s)"):
        try:
            with savepoint(cur, "sp_pi_giren"):
                cur.execute(q, (list(idler),))
                for x in cur.fetchall() or []:
                    out.setdefault(dict(x)["id"], dict(x)["ad"])
        except Exception:  # noqa: BLE001
            pass
    return out


def _cekmece_satirlari(kayit: list, kaynaklar: tuple, bas_gun: str, son_gun: Optional[str]):
    """Şube çekmecesinden çıkan 'odeme' hareketleri (kaynak ∈ kaynaklar, gün bas..son) → (hareket, veri, cep). Dükkân giderleri ve
    çekmece çıkışları AYNI süzgeçten (Fable Dalga 3 T2)."""
    for h in kayit:
        v = h["veri"]
        if h["tur"] != "odeme" or v.get("kaynak") not in kaynaklar or h["is_gunu"] < bas_gun or (son_gun and h["is_gunu"] > son_gun):
            continue
        yield h, v, (v.get("parcalar") or [{}])[0].get("cep") or ""


def _kayit_ve_cepler(cur, bas_gun: str, kayit: Optional[list], C: Optional[dict]):
    """Verilen kayıt/cep sözlüğünü kullan; yoksa yükle — dönem içi yeterliyse YALNIZ dönem (Fable H1/H2: tam defter iki kez yükleniyordu)."""
    if kayit is not None and C is not None:
        return kayit, C
    _, C_, kayit_, _ = _yukle(cur, tum_donemler=bas_gun < _baslangic(cur).isoformat())
    return (kayit if kayit is not None else kayit_), (C if C is not None else C_)


def dukkan_giderleri(cur, bas_gun: str, son_gun: Optional[str] = None, kayit: Optional[list] = None,
                     C: Optional[dict] = None) -> List[dict]:
    """PUBLIC servis (Fiş kontrolü + Gider raporu): şube PANELİNDEN girilmiş dükkân giderleri (avans hariç), iptaller düşülmüş.
    Her satır: ref (kaynak_ref), id, tarih, cep, sube_id, şube kısa adı, tutar (TL), kr (kuruş), açıklama, giren, fiş bilgisi.
    Gider raporu aynı süzgeci kendisi yazıyordu (Kaçırılan #1) — tek okuyucu burası."""
    kayit, C = _kayit_ve_cepler(cur, bas_gun, kayit, C)
    out = []
    for h, v, cep in _cekmece_satirlari(kayit, ("dukkan_gideri",), bas_gun, son_gun):
        cep = cep or None
        out.append({"ref": h.get("kaynak_ref"), "id": h["id"], "tarih": h["is_gunu"], "cep": cep, "sube": C.get(cep, {}).get("kisa"),
                    "sube_id": (cep or "").replace("sube:", "", 1), "kr": int(h["tutar"]), "tutar": _tl_sayi(h["tutar"]), "aciklama": v.get("aciklama"), "giren": v.get("giren"), "giren_id": v.get("giren_id"),
                    "fis_gonderildi": v.get("fis_gonderildi")})
    return out


def cep_kisa_adlari(cur, gun: str) -> Dict[str, str]:
    """PUBLIC — cep kimliği → kısa ad (ör. 'ev:onur' → 'Onur'); Satış ara teslim satırı cep kimliği basmasın."""
    _k, C = _kayit_ve_cepler(cur, gun, None, None)
    return {cid: c.get("kisa") or c.get("ad") or cid for cid, c in C.items()}


def cift_kayit_duzeltmeleri(cur, gun: str, kayit: Optional[list] = None, C: Optional[dict] = None) -> Dict[str, float]:
    """PUBLIC (Satış mutabakatı): o gün şube kapanışlarına uygulanan 'kartla ödenmiş — nakit olarak da yazılmış' düzeltmeleri
    {sube_id: TL}. Satış nakdi panel olayından okur; düzeltme yalnız Kasa'da → sağlamada düşülür (Fable + Codex 21 Eki).
    kayit/C verilirse defter yeniden yüklenmez (Faz 2 ay görünümü — Opus Y7)."""
    kayit, C = _kayit_ve_cepler(cur, gun, kayit, C)
    out: Dict[str, float] = {}
    for h in kayit:
        if h["tur"] != "kapanis" or h["is_gunu"] != gun or not str(h.get("cep") or "").startswith("sube:"):
            continue
        t_ = sum(int(z.get("tutar", 0)) for z in ((h["veri"] or {}).get("kanal_duzeltme") or []) if not z.get("iptal"))
        if t_:
            sid = h["cep"][len("sube:"):]
            out[sid] = round(out.get(sid, 0) + _tl_sayi(t_), 2)
    return out


def merkez_teslimleri(cur, gun: str, kayit: Optional[list] = None, C: Optional[dict] = None) -> List[dict]:
    """PUBLIC (Satış mutabakatı): o gün merkezin Kasa'dan (Kasam › + Teslim) şube dükkân nakdinden aldığı teslimler, iptaller düşülmüş.
    Panelin kendi teslimleri ('panel:' kök) ve eski köprü ('kasa_teslim:') panel olayından / eski tablodan zaten okunur → hariç (çift sayım yok).
    S-B4 (sim 23 Eki): bu teslim sağlamada düşülmüyordu → Kasa temizken Satış kontrolü 'KASA AÇIĞI' gösteriyordu.
    'zaman' = kayıt anı (Faz 2 vardiyaya böler — Opus Y3). kayit/C verilirse defter yeniden yüklenmez (Y7)."""
    kayit, C = _kayit_ve_cepler(cur, gun, kayit, C)
    out = []
    for h in kayit:
        ref = str(h.get("kaynak_ref") or "")
        if (h["tur"] != "teslim" or h["is_gunu"] != gun or not str(h.get("kaynak") or "").startswith("sube:")
                or ref.startswith(("panel:", "kasa_teslim:"))):
            continue
        v = h["veri"] or {}
        out.append({"sube_id": h["kaynak"][len("sube:"):], "tutar": _tl_sayi(int(h["tutar"])), "alan": h.get("hedef"),
                    "alan_ad": C.get(h.get("hedef") or "", {}).get("kisa") or h.get("hedef"),
                    "eden": v.get("teslim_eden") or None, "not": "merkez Kasa'dan" + (f" · {v['not']}" if v.get("not") else ""),
                    "zaman": h.get("kayit_zamani")})
    return out


def cekmece_cikislari(cur, gun: str, kayit: Optional[list] = None, C: Optional[dict] = None) -> List[dict]:
    """PUBLIC (Satış mutabakatı): o gün şube ÇEKMECESİNDEN çıkan nakit — anlık gider + elden avans, iptaller düşülmüş.
    Tek gerçek Kasa: merkez burada iptal ederse mutabakat da görür (Fable O-5; önce panel olayından okunuyordu).
    Her satır: sube_id, tutar (₺), ad (ekranda), tur ('gider' | 'avans'), kim (giren), zaman (kayıt anı), panel (panelden mi —
    değilse kayıt anı olay anı değildir; Faz 2 bölmez — Opus Y6). kayit/C verilirse defter yeniden yüklenmez (Y7)."""
    kayit, _C = _kayit_ve_cepler(cur, gun, kayit, C)
    out = []
    # Codex (21 Eki): yalnız panel gideri / elden avans okunuyordu → Kasa ekranından ya da köprüden girilen şube ödemesi sağlamada
    # eksik kalıyordu. Artık şube cebinden çıkan HER ödeme parçası (Kasa defteriyle aynı kapsam — tek gerçek)
    for h in kayit:
        v = h["veri"]
        if h["tur"] != "odeme" or h["is_gunu"] != gun:
            continue
        for p in v.get("parcalar") or []:
            cep = p.get("cep") or ""
            if not cep.startswith("sube:") or not int(p.get("tutar") or 0):
                continue
            avans = v.get("kaynak") == "sube_avansi"
            ad = (f"Avans · {(v.get('konu') or {}).get('personel_ad') or ''}".strip(" ·") if avans
                  else " · ".join(x for x in [v.get("kategori"), v.get("aciklama")] if x) or "Ödeme")
            if v.get("kaynak") not in ("dukkan_gideri", "sube_avansi"):
                ad += " (Kasa'dan)"   # Fable R: panel dışı ödeme — sahip çift kaydı görebilsin
            out.append({"sube_id": cep[len("sube:"):], "tutar": _tl_sayi(int(p["tutar"])), "ad": ad, "tur": "avans" if avans else "gider",
                        "kim": v.get("giren") or h.get("kaydeden"),   # Fable B5: elden avansta 'giren' yok → kaydeden (panelde veren)
                        "zaman": h.get("kayit_zamani"),   # Faz 2 (sahip 24 Eki): Satış devir defteri çıkışı vardiyaya böler
                        "panel": v.get("kaynak") in ("dukkan_gideri", "sube_avansi")})
    return out


def _sube_cekmece_odeme(cur, *, sube_id: str, gun: str, tutar: int, veri: dict, kim: str, kaynak_ref: str) -> dict:
    """Şube çekmecesinden çıkan nakit (anlık gider · elden avans) — ORTAK yazım: Kasa kilidi, sayılmış güne yazılmaz, eksiye düşse
    de yazılır (sahip 20 Eki; merkez Kasa'da görür). Dönüş {id|None (tekrar), eksi}."""
    _hazirla()
    if tutar <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")
    cep = "sube:" + str(sube_id)
    _kilit(cur)   # Kasa'nın tek yazma kilidi (kasa_yaz ile aynı sıra)
    cep_list, C, kayit, _ = _yukle(cur)
    if cep not in C:
        raise HTTPException(400, "Şube kasası bulunamadı")
    kilit = _sayim_kilidi(_olaylar(kayit))
    if cep in kilit and gun <= kilit[cep]:
        raise HTTPException(409, "Bu günün kasası sayıldı — girilemez, merkeze haber ver")
    v = {**veri, "kimin": C[cep]["kisa"], "parcalar": [{"cep": cep, "tutar": int(tutar)}]}
    hid = _yaz(cur, "odeme", gun, kim, tutar=int(tutar), veri=v, kaynak_ref=kaynak_ref)
    D = _bakiye(_olaylar(_yukle(cur)[2]), C)
    return {"id": hid, "eksi": D["b"].get(cep, 0) < 0}


def dukkan_gideri_yaz(cur, *, sube_id: str, gun: str, tutar: int, aciklama: str, kim: str, kaynak_ref: str,
                      giren_id: Optional[str] = None, giren: Optional[str] = None, kategori: Optional[str] = None,
                      fis: Optional[bool] = None) -> dict:
    """PUBLIC — şube çekmecesinden ödenen küçük gider (anlık gider) TEK yazıcısı. Kasa 'odeme' (kaynak 'dukkan_gideri') — Gider, Fiş
    kontrol, kör sayım, Satış mutabakatı bunu okur. Sahip (20 Eki): onay YOK (kayıt kesin). Kuruş."""
    ac = " ".join(str(aciklama or "").split())
    if len(ac) < 3:
        raise HTTPException(400, "Açıklama zorunlu — neye ödendiğini yaz")
    veri = {"aciklama": ac[:120], "kaynak": "dukkan_gideri"}
    if giren_id:
        veri.update(giren_id=str(giren_id), giren=giren)
    if kategori:
        veri["kategori"] = str(kategori).strip()[:40]
    if fis is not None:
        veri["fis_gonderildi"] = bool(fis)
    return _sube_cekmece_odeme(cur, sube_id=sube_id, gun=gun, tutar=tutar, veri=veri, kim=kim, kaynak_ref=kaynak_ref)


def sube_avansi_yaz(cur, *, sube_id: str, gun: str, tutar: int, personel_id: str, personel_ad: Optional[str], ait_ay: str,
                    kim: str, kaynak_ref: str) -> dict:
    """PUBLIC — şubeden ELDEN verilen avans (Avans modülü, panel 'teslim ettim'). Kasa 'odeme' konu personel · kalem Avans ·
    kaynak 'sube_avansi' · gider DEĞİL — Maaş bunu 'Avans (şube)' olarak mahsup eder (eski köprüyle AYNI biçim). Kuruş."""
    veri = {"konu": {"tip": "personel", "ad": "Personel", "personel_id": str(personel_id), "personel_ad": personel_ad, "kalem": "Avans"},
            "ait_ay": str(ait_ay)[:7], "gider": False, "kaynak": "sube_avansi", "aciklama": f"Avans (şubeden elden) · {personel_ad or ''}"[:120]}
    return _sube_cekmece_odeme(cur, sube_id=sube_id, gun=gun, tutar=tutar, veri=veri, kim=kim, kaynak_ref=kaynak_ref)


def _dukkan_giderleri_aktar(cur, C, kayit, kilit, bas, kuru, kim, sube_id=None) -> dict:
    """🧾 Şubenin ÇEKMECEDEN yaptığı nakit harcamalar (eski anlik_giderler, ödeme yöntemi
    nakit; 'aktif' + 'onay_bekliyor' — para çekmeceden fiilen çıktı) → dükkân nakdinden
    'ödeme' (kimin: o şube). Bunlar girmezse kapanış kör sayımı her akşam sahte EKSİK verir.
    Kaynak iptal edilirse karşılığı iptal; sayılmış (kilitli) güne yeni yazılmaz → listelenir."""
    sonuc = {"yeni": 0, "kilitli": [], "iptal": 0}
    try:
        with savepoint(cur, "sp_pi_dukkan_gider"):
            q = """SELECT id, tarih, tutar, sube, kategori, aciklama, durum, kaynak_tablo, kaynak_id, personel_id FROM anlik_giderler
                    WHERE tarih >= %s AND sube IS NOT NULL
                      AND LOWER(COALESCE(NULLIF(TRIM(odeme_yontemi), ''), 'nakit')) = 'nakit'"""
            prm = [bas]
            if sube_id:
                q += " AND sube = %s"
                prm.append(sube_id)
            cur.execute(q, prm)
            kaynak = [dict(r) for r in cur.fetchall() or []]
    except Exception as e:  # noqa: BLE001
        sonuc["hata"] = str(e)[:120]
        return sonuc
    giren_ad = _giren_adlari(cur, {str(r.get("personel_id")) for r in kaynak if r.get("personel_id")})
    cur.execute("SELECT kaynak_ref FROM para_izi_hareket WHERE kaynak_ref LIKE 'anlik_gider:%%'")
    her_zaman = {dict(x)["kaynak_ref"] for x in cur.fetchall() or []}
    # Sahip+Codex (2026-10-16): şubenin ELDEN AVANSI dükkân gideri değil, o personelin AVANSI (maaştan mahsup)
    avanslar = {}
    av_id = [str(r["kaynak_id"]) for r in kaynak if (r.get("kaynak_tablo") or "") == "personel_avans" and r.get("kaynak_id")]
    if av_id:
        try:
            with savepoint(cur, "sp_pi_avans_es"):
                cur.execute("""SELECT a.id::text AS id, a.personel_id::text AS pid, a.donem_yil, a.donem_ay, p.ad_soyad
                                 FROM personel_avans a LEFT JOIN personel p ON p.id = a.personel_id WHERE a.id::text = ANY(%s)""", (av_id,))
                avanslar = {dict(x)["id"]: dict(x) for x in cur.fetchall() or []}
        except Exception:  # noqa: BLE001
            avanslar = {}

    def _avans_veri(r):
        a = avanslar.get(str(r.get("kaynak_id") or "")) if (r.get("kaynak_tablo") or "") == "personel_avans" else None
        if not a:
            return None
        ay = f"{int(a['donem_yil']):04d}-{int(a['donem_ay']):02d}" if a.get("donem_yil") and a.get("donem_ay") else None
        return {"konu": {"tip": "personel", "ad": "Personel", "personel_id": a["pid"], "personel_ad": a.get("ad_soyad"), "kalem": "Avans"},
                "ait_ay": ay, "gider": False, "kaynak": "sube_avansi", "aciklama": f"Avans (şubeden elden) · {a.get('ad_soyad') or ''}"[:120]}
    if not kuru:   # daha önce "dükkân gideri" diye aktarılmış avansları düzelt (iz: veri.duzeltmeler)
        gecerli = {h.get("kaynak_ref"): h for h in kayit if (h.get("kaynak_ref") or "").startswith("anlik_gider:")}
        for r in kaynak:
            av = _avans_veri(r)
            h = gecerli.get("anlik_gider:" + str(r["id"]))
            if av and h and h["veri"].get("kaynak") == "dukkan_gideri":
                v2 = {**h["veri"], **av, "duzeltmeler": list(h["veri"].get("duzeltmeler") or []) +
                      [{"kim": "otomatik", "zaman": _bugun().isoformat(), "degisen": {"tur": ["dükkân gideri", "personel avansı"]}}]}
                cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(v2, ensure_ascii=False), h["id"]))
    gecerli = {h.get("kaynak_ref"): h for h in kayit if (h.get("kaynak_ref") or "").startswith("anlik_gider:")}
    canli = set()
    for r in kaynak:
        ref = "anlik_gider:" + str(r["id"])
        cep = "sube:" + str(r["sube"])
        if r["durum"] not in ("aktif", "onay_bekliyor") or cep not in C:
            continue
        canli.add(ref)
        if ref in her_zaman:
            continue
        g = r["tarih"].isoformat() if hasattr(r["tarih"], "isoformat") else str(r["tarih"])[:10]
        t = _kurus(r["tutar"] or 0)
        if t <= 0:
            continue
        if cep in kilit and g <= kilit[cep]:
            sonuc["kilitli"].append({"gun": g, "sube": C[cep]["kisa"], "tutar": _tl_sayi(t), "aciklama": r.get("aciklama")})
            continue
        sonuc["yeni"] += 1
        if not kuru:
            ac = " · ".join(x for x in [(r.get("kategori") or "").strip(), (r.get("aciklama") or "").strip()] if x) or "Dükkân gideri"
            veri = {"aciklama": ac[:120], "kimin": C[cep]["kisa"], "parcalar": [{"cep": cep, "tutar": t}], "kaynak": "dukkan_gideri"}
            if r.get("personel_id"):   # sahip (2026-10-17): fiş kontrolü "girişi yapan personel" ile — eski sistem kalkınca da bilinsin
                veri.update(giren_id=str(r["personel_id"]), giren=giren_ad.get(str(r["personel_id"])))
            av = _avans_veri(r)
            if av:
                veri.update(av)
            _yaz(cur, "odeme", g, kim, tutar=t, veri=veri, kaynak_ref=ref)
    if not kuru:
        for ref, h in gecerli.items():
            pc = (h["veri"].get("parcalar") or [{}])[0].get("cep")
            if ref not in canli and not (pc in kilit and h["is_gunu"] <= kilit[pc]) and (not sube_id or pc == "sube:" + str(sube_id)):
                _yaz(cur, "iptal", _bugun().isoformat(), kim, veri={"hedef_id": h["id"], "sebep": "Eski sistemde dükkân gideri iptal edildi"})
                sonuc["iptal"] += 1
    return sonuc


# ─────────────────────── PANEL SAYIMLARI → KASA (sahip 2026-10-16) ───────────────────────
# "Kasa teslim ve sabahta kasa açılış giriliyor ya" → panelde ZATEN sayım var:
#   · SABAH AÇILIŞ: kasiyer çekmeceyi sayar (sube_operasyon_event ACILIS.kasa_sayim)
#     = bir önceki günün SONU → sayım, tarihi (gün − 1)
#   · AKŞAM KAPANIŞ kör sayımı: sayılan − gün sonu teslim = çekmecede kalan → sayım, tarihi gün
# Sahip: "yarından itibaren başlasın" → PANEL_SAYIM_BASLANGIC'tan (ayar ile değişir) önceki sayımlar
# ALINMAZ (Ekim'de teslim tarih kayması + Evo tahmini sahte fark üretirdi).
# Her dükkânın İLK sayımı = BAŞLANGIÇ SAYIMI: defter sayıma eşitlenir, eski fark kendiliğinden
# "başlangıç farkı" diye kapanır (iz kalır). Sonraki her tutmayan sayım → AÇIK FARK.
# İdempotent: kaynak_ref ile bir kez. Her 10 dakikada otomatik senkronla çalışır.
PANEL_SAYIM_BASLANGIC = date(2026, 10, 17)

SEBEPLER.setdefault("baslangic", "Başlangıç sayımı — eski defter farkı")


def _panel_sayim_baslangic(cur) -> date:
    try:
        with savepoint(cur, "sp_pi_ps_bas"):
            cur.execute("SELECT deger FROM para_izi_ayar WHERE anahtar='panel_sayim_baslangic'")
            r = cur.fetchone()
            if r:
                return date.fromisoformat(dict(r)["deger"])
    except Exception:  # noqa: BLE001
        pass
    return PANEL_SAYIM_BASLANGIC


def _panel_sayimlari(cur, kuru: bool, kim: str = "şube paneli (sayım)") -> dict:
    bas = max(_baslangic(cur), _panel_sayim_baslangic(cur))
    rapor = {"baslangic": bas.isoformat(), "sayim": [], "atlanan": []}
    if _bugun() < bas:
        rapor["ozet"] = {"sayim": 0, "farkli": 0, "not": f"{bas.isoformat()} sabahından itibaren başlayacak"}
        return rapor
    cep_list, C, kayit, _ = _yukle(cur)
    olaylar = []
    try:   # ESKİ panel olayları (kesimde kalkar) — tablo yoksa / okunamazsa YENİ panel sayımları yine işlenir (C-T3-04: erken dönüş vardı)
        with savepoint(cur, "sp_pi_panel_sayim"):
            cur.execute("""SELECT sube_id::text AS sube_id, tarih, tip, kasa_sayim, COALESCE(teslim,0) AS teslim, devir, cevap_ts
                             FROM sube_operasyon_event
                            WHERE tarih >= %s AND tarih <= %s AND durum = 'tamamlandi' AND tip IN ('ACILIS','KAPANIS')
                              AND kasa_sayim IS NOT NULL
                            ORDER BY tarih, cevap_ts NULLS LAST""", (bas, _bugun()))
            olaylar = [dict(r) for r in cur.fetchall() or []]
    except Exception as e:  # noqa: BLE001
        rapor["eski_hata"] = str(e)[:200]
    # 🧾 YENİ ŞUBE PANELİ açılışları (ey_sube_olay, kaynak_tablo='panel') — eski olayla aynı biçime çevrilir; aynı şube+gün
    # ikisinde de varsa ref ('sayim_acilis:{şube}:{gün}') aynı olduğundan bir kez yazılır (Codex: açılış nakdi Kasa'ya ulaşsın)
    try:
        with savepoint(cur, "sp_pi_panel_sayim_yeni"):
            from evvel_yeni_olay import panel_olaylari   # F#12
            for o in panel_olaylari(cur, bas=bas, son=_bugun(), turler={"acilis"}):
                v = o["v"]
                if v.get("kasa_sayim") is None:
                    continue
                g = o["is_gunu"] if hasattr(o["is_gunu"], "isoformat") else date.fromisoformat(str(o["is_gunu"])[:10])
                olaylar.append({"sube_id": str(o["sube_id"]), "tarih": g, "tip": "ACILIS", "kasa_sayim": Decimal(int(v["kasa_sayim"])) / 100,
                                "teslim": 0, "devir": None, "cevap_ts": o["olay_zamani"]})
    except Exception as e:  # noqa: BLE001
        log.warning("yeni panel açılış sayımları okunamadı: %s", str(e)[:200])
    cur.execute("SELECT kaynak_ref FROM para_izi_hareket WHERE kaynak_ref LIKE 'sayim_%%'")
    refler = {dict(x)["kaynak_ref"] for x in cur.fetchall() or []}
    sim = list(kayit)
    sube_cep = {c["sube_id"]: c["id"] for c in cep_list if c["tur"] == "sube"}
    # başlangıç sayımı yapılmış dükkânlar (panel sayımı ref'i olan)
    baslamis = {sube_cep.get(r.split(":")[1]) for r in refler if r.startswith(("sayim_kapanis:", "sayim_acilis:", "sayim_baslangic:"))}
    sirali = []
    for e in olaylar:
        g = e["tarih"]
        if e["tip"] == "KAPANIS":
            # Fable+Codex (2026-10-16): akşam kör sayımı teslimden önce mi sonra mı belirsiz → Kasa'ya SAYIM yazılmaz;
            # Satış kontrolünde SAĞLAMA olarak görünür. Kasa'yı sabah sayımı denetler (dün bırakılan = bu sabah sayılan).
            continue
        else:
            sirali.append((((g - timedelta(days=1)).isoformat(), 1, str(e["cevap_ts"])), e, (g - timedelta(days=1)).isoformat(), "sabah açılış sayımı"))
    sirali.sort(key=lambda x: x[0])
    elle_kilit = _sayim_kilidi(_olaylar([h for h in kayit if not (h.get("kaynak_ref") or "").startswith("sayim_")]))
    for _, e, gun, ad in sirali:
        cep = sube_cep.get(e["sube_id"])
        if not cep:
            continue
        if e["tarih"] >= _bugun():
            # Fable (d): sabah sayımı gün−1'e yazılır ve o günü KİLİTLER → aynı günün geç kayıtları (ertesi sabah gönderilen
            # kapanış, dükkân gideri, ara teslim) kilide takılmasın diye BİR GÜN beklenir; yarın yazılır.
            continue
        ref = f"sayim_acilis:{e['sube_id']}:{e['tarih'].isoformat()}"
        if ref in refler:
            continue
        sayilan = max(0, _kurus(e["kasa_sayim"]))
        if cep in elle_kilit and gun < elle_kilit[cep]:
            rapor["atlanan"].append({"sube": C[cep]["kisa"], "neden": f"{gun} {ad}: sonrasında elle sayım var"})
            continue
        ilk = cep not in baslamis
        beklenen = _bakiye([o for o in _olaylar(sim) if o["gun"] <= gun], C)["b"].get(cep, 0)
        veri = {"beklenen": beklenen, "sayilan": sayilan, "kaynak": "acilis_sayimi"}
        if ilk:
            veri["baslangic"] = True
        rapor["sayim"].append({"sube": C[cep]["kisa"], "gun": gun, "ne": ("BAŞLANGIÇ · " if ilk else "") + ad,
                               "beklenen": _tl_sayi(beklenen), "sayilan": _tl_sayi(sayilan), "fark": _tl_sayi(beklenen - sayilan)})
        y = _sahte("sayim", gun, cep=cep, tutar=sayilan, veri=veri, kaynak_ref=ref)
        y["id"] = "__s_" + ref
        y["_sira"] = "9" + str(len(sim)).zfill(6)
        sim.append(y)
        refler.add(ref)
        baslamis.add(cep)
        if not kuru:
            sid = _yaz(cur, "sayim", gun, "sabah açılış sayımı",
                       cep=cep, tutar=sayilan, veri=veri, kaynak_ref=ref)
            f = beklenen - sayilan
            if ilk and sid and f:
                # Başlangıç farkı Ekim'in kayıt kaymasından — açık fark listesini doldurmasın, izli kapansın
                _yaz(cur, "cozum", gun, "otomatik (başlangıç sayımı)", tutar=abs(f),
                     veri={"fark_id": sid, "fark_ad": C[cep]["ad"] + " sayımı", "f": f, "sebep": "baslangic", "cep": cep,
                           "sube_cep": None, "sorumlu": "", "not": "Panel sayımı başlangıcı — defter sayıma eşitlendi"})
    rapor["ozet"] = {"sayim": len(rapor["sayim"]), "farkli": sum(1 for x in rapor["sayim"] if x["fark"]), "atlanan": len(rapor["atlanan"])}
    return rapor


@router.post("/panel-sayim")
def panel_sayim_aktar(kuru: bool = True, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Paneldeki sabah açılış + akşam kör sayımlarını Kasa'ya SAYIM olarak alır. kuru=true: yalnız göster."""
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        r = _panel_sayimlari(cur, kuru, (_aktor(cur, x_evvel_oturum) or "") + " · panel sayımı" if not kuru else "")
        if kuru:
            conn.rollback()
    return {"kuru": kuru, **r}


def panel_kapanis_sayim(cur, sube_id, gun, kasa_sayim, gun_sonu_teslim=0) -> None:
    """DEVRE DIŞI (2026-10-16, Fable+Codex+sahip): akşam kör sayımı Kasa'ya SAYIM olarak yazılmaz — sağlama olarak
    Satış kontrolünde görünür; Kasa'yı SABAH sayımı denetler (_panel_sayimlari). Panel çağrısı zararsız no-op."""
    return None



# ─────────────────────────── ŞUBE PANELİNDEN DOĞRUDAN YAZIM ───────────────────────────
# Sahip (2026-10-15): "Köprü mantığı eskiye devamı zorunlu kılar; panelin verisi DİREKT
# buraya gelsin, sonra orada boşa çıkan her şeyi silmek istiyorum."
# Şube panelinin kapanış/teslim yazdığı her noktadan, AYNI transaction içinde ve
# SAVEPOINT altında çağrılır. Hata ASLA paneli durdurmaz (yutulur, loglanır) — kaçan
# kayıt otomatik köprüde (aynı kaynak_ref) yakalanır. Kaynak kimlikleri köprüyle
# AYNIDIR → ikisi aynı kaydı iki kez yazamaz.
def _try_kilit(cur) -> bool:
    cur.execute("SELECT pg_try_advisory_xact_lock(%s) AS ok", (KASA_KILIT,))
    return bool(dict(cur.fetchone() or {}).get("ok"))


def _tablo_var(cur) -> bool:
    return __import__("evvel_yeni_cekirdek").tablo_var(cur, "para_izi_hareket")   # çekirdek (F#14)


def panel_kapanis_yaz(cur, sube_id, gun, nakit, kart, kim: Optional[str] = None, pos=None, online=None) -> None:
    """Panel kapanışı (X raporu) → Para İzi kapanış beyanı. Onaylanmamışsa şube
    düzeltince tutar güncellenir (beyan); onaylanmışsa tutar DEĞİŞMEZ, not düşülür."""
    try:
        with savepoint(cur, "sp_pi_panel_kapanis"):
            if not _tablo_var(cur) or not _try_kilit(cur):
                return
            g = gun.isoformat() if hasattr(gun, "isoformat") else str(gun)[:10]
            if g < _baslangic(cur).isoformat():
                return
            cep = "sube:" + str(sube_id)
            cur.execute("SELECT 1 FROM para_izi_cep WHERE id=%s", (cep,))
            if not cur.fetchone():
                return
            n, k = _kurus(round(float(nakit or 0), 2)), _kurus(round(float(kart or 0), 2))   # panel float gönderir
            ayrim = {} if pos is None else {"pos": _kurus(round(float(pos or 0), 2)), "online": _kurus(round(float(online or 0), 2))}
            ref = f"kapanis:{sube_id}:{g}"
            iptal_edilen = "SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal'"
            cur.execute(f"""SELECT id, durum, tutar, veri, kaynak_ref FROM para_izi_hareket
                             WHERE tur='kapanis' AND cep=%s AND is_gunu=%s AND id NOT IN ({iptal_edilen})
                             ORDER BY kayit_zamani LIMIT 1""", (cep, g))
            r = cur.fetchone()
            cur.execute(f"""SELECT MAX(is_gunu) AS s FROM para_izi_hareket WHERE tur='sayim' AND cep=%s
                             AND id NOT IN ({iptal_edilen})""", (cep,))
            son_sayim = dict(cur.fetchone() or {}).get("s")
            sayimli = son_sayim is not None and str(son_sayim)[:10] >= g   # C-T1-03: kasa_yaz ile AYNI sayım kilidi
            if not r:
                if sayimli:   # Codex (21 Eki): sayılmış güne nakit yazmak o sayımı bozar → tutar 0, panel tutarı notta, merkez karar verir
                    _yaz(cur, "kapanis", g, "şube paneli" + (f" · {kim}" if kim else ""), cep=cep, tutar=0, durum="onaylandi",
                         veri={"kart": k, "eski_kaynak": "panel", **ayrim, "sayimdan_sonra": True,
                               "panel_sonradan": [{"nakit": n, "kart": k, **ayrim, "zaman": _simdi_iso()}]},
                         kaynak_ref=ref)
                    return
                _yaz(cur, "kapanis", g, "şube paneli" + (f" · {kim}" if kim else ""), cep=cep, tutar=n,
                     durum="bekliyor", veri={"kart": k, "eski_kaynak": "panel", **ayrim}, kaynak_ref=ref)
                return
            r = dict(r)
            veri = __import__("evvel_yeni_cekirdek").json_ac(r["veri"], {})
            ayni_ayrim = not ayrim or (int(veri.get("pos", -1)) == ayrim["pos"] and int(veri.get("online", -1)) == ayrim["online"])
            # Fable B (21 Eki): 'kartla' çift kayıt düzeltmesi yapılmış kapanışta panel ORİJİNAL nakdi yeniden gönderir → düzeltme düşülür
            # (yoksa düzeltme sessizce geri döner ya da sahte 'sonradan değişti' doğar)
            n = n - sum(int(z.get("tutar", 0)) for z in (veri.get("kanal_duzeltme") or []) if not z.get("iptal"))
            yeni_s = {"nakit": n, "kart": k, **ayrim}
            son_s = (veri.get("panel_sonradan") or [{}])[-1]
            kasada_ayni = r["tutar"] == n and int(veri.get("kart", 0)) == k and ayni_ayrim and not veri.get("sayimdan_sonra")   # C-T1-04
            guncellenebilir = r["durum"] != "onaylandi" and not sayimli and not veri.get("sayimdan_sonra")
            if kasada_ayni:
                if veri.get("panel_sonradan") and {a: son_s.get(a) for a in yeni_s} != yeni_s:
                    # Codex: panel Kasa'daki tutara GERİ döndü → eski 'sonradan' bildirimi kapansın
                    veri["panel_sonradan"].append({**yeni_s, "zaman": _simdi_iso()})
                    cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(veri, ensure_ascii=False), r["id"]))
                return
            if not guncellenebilir and {a: son_s.get(a) for a in yeni_s} == yeni_s:
                return   # Fable S: aynı beyan yeniden geldi — not çoğalmasın, Gördüm bozulmasın (güncellenebilir kayıtta bu kıyas YAPILMAZ — Codex)
            if guncellenebilir:
                veri["kart"] = k
                veri.update(ayrim)
                cur.execute("UPDATE para_izi_hareket SET tutar=%s, veri=%s::jsonb WHERE id=%s",
                            (n, json.dumps(veri, ensure_ascii=False), r["id"]))
            else:
                veri.setdefault("panel_sonradan", []).append({**yeni_s, "zaman": _simdi_iso()})
                veri.pop("sonradan_goruldu", None)   # yeni değişiklik → merkez yeniden görsün (Bekleyen işler)
                cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s",
                            (json.dumps(veri, ensure_ascii=False), r["id"]))
                log.warning("evvel-yeni kasa: %s kapanış panelde değişti %s %s — tutar değişmedi, not düştü",
                            "sayımlı" if sayimli else "onaylı", cep, g)
    except Exception as e:  # noqa: BLE001 — panel ASLA durmaz
        log.warning("evvel-yeni kasa panel kapanış yazılamadı: %s", str(e)[:200])


def _yetim_teslimler(cur, canli: set, bas) -> set:
    """TEK KURAL (C-T1-05: yalnız panel_teslim_esle'de vardı, gece _aktar'da yoktu): panelde geri alınmış ama (sayım yüzünden)
    iptal EDİLEMEMİŞ etkin teslim → {(kaynak, hedef, gün, tutar)}. Aynı anahtarlı YENİ kasa_teslim ikinci kez yazılmaz (çift çıkış)."""
    cur.execute("""SELECT kaynak_ref, kaynak, hedef, tutar, is_gunu FROM para_izi_hareket
                    WHERE tur='teslim' AND kaynak_ref LIKE 'kasa_teslim:%%' AND is_gunu >= %s
                      AND id NOT IN (SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal')""", (bas,))
    out = set()
    for h in [dict(x) for x in cur.fetchall() or []]:
        if h["kaynak_ref"] in canli:
            continue
        g = h["is_gunu"].isoformat() if hasattr(h["is_gunu"], "isoformat") else str(h["is_gunu"])
        out.add((h["kaynak"], h["hedef"], g, int(h["tutar"])))
    return out


def panel_teslim_esle(cur) -> None:
    """kasa_teslim (panel/PIN'li teslim) → Para İzi teslimi ('onay bekliyor').
    Panelde silinen (kapanış geri al) ve henüz 'aldım' denmemiş teslim → otomatik İPTAL."""
    try:
        with savepoint(cur, "sp_pi_panel_teslim"):
            if not _tablo_var(cur) or not _try_kilit(cur):
                return
            bas = _baslangic(cur)
            cur.execute("SELECT id, sube_id FROM para_izi_cep WHERE tur='sube'")
            sube_cep = {str(dict(x)["sube_id"]): dict(x)["id"] for x in cur.fetchall() or []}
            try:
                with savepoint(cur, "sp_pi_panel_t2"):
                    cur.execute("""SELECT id, sube_id, tarih, tutar, teslim_alan_ad, teslim_eden_ad FROM kasa_teslim
                                    WHERE tarih >= %s AND COALESCE(durum,'aktif')='aktif'""", (bas,))
                    kaynak = [dict(x) for x in cur.fetchall() or []]
            except Exception:  # noqa: BLE001
                cur.execute("SELECT id, sube_id, tarih, tutar, teslim_alan_ad, teslim_eden_ad FROM kasa_teslim WHERE tarih >= %s", (bas,))
                kaynak = [dict(x) for x in cur.fetchall() or []]
            canli = {"kasa_teslim:" + str(x["id"]) for x in kaynak}
            cur.execute("""SELECT id, kaynak_ref, durum, onaylayan, kaynak, hedef, tutar, is_gunu FROM para_izi_hareket
                            WHERE tur='teslim' AND kaynak_ref LIKE 'kasa_teslim:%%' AND is_gunu >= %s
                              AND id NOT IN (SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal')""", (bas,))
            var = {dict(x)["kaynak_ref"]: dict(x) for x in cur.fetchall() or []}
            cur.execute("SELECT kaynak_ref FROM para_izi_hareket WHERE kaynak_ref LIKE 'kasa_teslim:%%'")
            her_zaman = {dict(x)["kaynak_ref"] for x in cur.fetchall() or []}
            # Codex 2. tur: panelde geri alınmış ama sayım yüzünden iptal EDİLEMEYEN teslim (yetim) varken, yeniden kapanışın
            # ürettiği AYNI teslim (aynı dükkân, alan, gün, tutar) ikinci kez yazılmaz → çift çıkış olmaz.
            yetim = _yetim_teslimler(cur, canli, bas)   # TEK kural (gece _aktar da aynısını kullanır)
            for x in kaynak:
                ref = "kasa_teslim:" + str(x["id"])
                cep, hedef = sube_cep.get(str(x["sube_id"])), _patron_bul(x.get("teslim_alan_ad"))
                if ref in her_zaman or not cep or not hedef:
                    continue
                anahtar = (cep, hedef, x["tarih"].isoformat(), _kurus(x["tutar"]))
                if anahtar in yetim:
                    yetim.discard(anahtar)
                    continue
                _yaz(cur, "teslim", x["tarih"].isoformat(), "şube paneli", kaynak=cep, hedef=hedef, tutar=_kurus(x["tutar"]),
                     durum="bekliyor", veri={"eski_alan_ad": x.get("teslim_alan_ad"), "teslim_eden": x.get("teslim_eden_ad")}, kaynak_ref=ref)
            # Codex (2026-10-17): teslim artık AYNI GÜN otomatik kabul ediliyor → kapanış geri alınınca KENDİLİĞİNDEN kabul edilmiş
            # teslim de iptal edilmeli (yoksa yeniden kapanış ikinci teslim üretir = çift). Elle "aldım" denmiş ya da alanın
            # cebi o günden sonra SAYILMIŞSA dokunulmaz (sayım bozulmasın) — log'a yazılır.
            kilit = None
            for ref, h in var.items():
                if ref in canli:
                    continue
                oto = h["durum"] == "onaylandi" and str(h.get("onaylayan") or "").startswith("otomatik kabul")
                if h["durum"] == "onaylandi" and not oto:
                    continue
                if oto:
                    if kilit is None:
                        kilit = _sayim_kilidi(_olaylar(_yukle(cur)[2]))
                    g = h["is_gunu"].isoformat() if hasattr(h["is_gunu"], "isoformat") else str(h["is_gunu"])
                    if any(cp in kilit and g <= kilit[cp] for cp in (h.get("hedef"), h.get("kaynak"))):
                        log.warning("panel teslimi geri alındı ama %s o günden sonra sayılmış — iptal edilmedi: %s", h.get("hedef"), ref)
                        continue
                _yaz(cur, "iptal", _bugun().isoformat(), "şube paneli",
                     veri={"hedef_id": h["id"], "sebep": "Şube panelinde geri alındı (kapanış geri al)"})
    except Exception as e:  # noqa: BLE001 — panel ASLA durmaz
        log.warning("evvel-yeni kasa panel teslim eşlenemedi: %s", str(e)[:200])



# ─────────────── 🛟 KAPANIŞ KAYBOLMASIN — reddedilen / uyarılı panel kapanışları ───────────────
def _kapanis_deneme_isleri(cur, C: dict) -> List[dict]:
    """sube_operasyon.operasyon_deneme: son 7 gün
      · RED: kapanış gönderilmiş ama reddedilmiş ve olay hâlâ tamamlanmamış → sebep + "geç kapanış olarak işle"
      · UYARILI: kapanış kaydedildi ama mühürsüz / X raporu yok / devir eksik → merkez "gördüm" diyene kadar."""
    if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "operasyon_deneme"):
        return []
    _yeni = __import__("evvel_yeni_cekirdek").yeni_donem(cur)   # A4: yeni dönemde eski 'red' satırı (geç kapanış yazıcısı) üretilmez;
    #                                                          uyarılı (mühürsüz) satırlar 7 gün daha görünür — merkez 'gördüm' diyebilsin (Fable)
    # Codex P2: okuma sırasında BAŞKA modülün (eski sistem) tablosuna ALTER yok — kolon yoksa 'görülmedi' sayılır (şema kilidi beklemesin)
    _g = "d.goruldu" if __import__("evvel_yeni_cekirdek").kolon_var(cur, "operasyon_deneme", "goruldu") else "FALSE AS goruldu"
    cur.execute(f"""SELECT d.id, d.sube_id, d.event_id, d.tip, d.is_gunu, d.sonuc, d.sebep, d.uyarilar, d.zaman, {_g},
                          e.durum AS ev_durum
                     FROM operasyon_deneme d LEFT JOIN sube_operasyon_event e ON e.id = d.event_id
                    WHERE d.zaman >= NOW() - INTERVAL '7 days' AND d.tip = 'KAPANIS'
                    ORDER BY d.zaman DESC""")
    sube_ad = {c["sube_id"]: c["kisa"] for c in C.values() if c.get("tur") == "sube"}
    out, goruldu_ev = [], set()
    for r in [dict(x) for x in cur.fetchall() or []]:
        if r["event_id"] in goruldu_ev:
            continue   # olay başına yalnız EN SON deneme
        goruldu_ev.add(r["event_id"])
        gun = r["is_gunu"].isoformat() if r.get("is_gunu") else r["zaman"].date().isoformat()
        ad = sube_ad.get(r["sube_id"], r["sube_id"])
        if r["sonuc"] in ("red", "hata", "gonderildi") and r.get("ev_durum") != "tamamlandi" and not _yeni:
            out.append({"tur": "kapanis_red", "id": r["id"], "tarih": gun, "ad": ad, "sebep": r.get("sebep") or "sonuç alınamadı",
                        "saat": _tr_zaman(r["zaman"])})
        elif r["sonuc"] == "ok_uyarili" and not r.get("goruldu"):
            out.append({"tur": "kapanis_uyarili", "id": r["id"], "tarih": gun, "ad": ad, "uyarilar": r.get("uyarilar") or [],
                        "saat": _tr_zaman(r["zaman"])})
    return out


from evvel_yeni_cekirdek import tr_tarih_saat as _tr_zaman   # Dalga 4 (F#4): saat biçimi TEK yerde — çekirdek


class DenemeBody(BaseModel):
    deneme_id: str


@router.post("/gec-kapanis")
def gec_kapanis(body: DenemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Merkez: reddedilmiş panel kapanışını (kaydedilen ham veriyle) GEÇ KAPANIŞ olarak işler — önceki iş gününe bağlanır,
    "geç kapanış" + varsa "mühürsüz" uyarısıyla. Yalnız Evvel Yeni oturumuyla (merkez) çağrılır."""
    import sube_operasyon as so
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        if __import__("evvel_yeni_cekirdek").yeni_donem(cur):   # A4: 1 Kasım'dan sonra eski tabloya kapanış YAZILMAZ (Kasa'ya ulaşmazdı)
            raise HTTPException(410, "Eski panelin reddedilen kapanışı 1 Kasım'dan sonra işlenemez — kapanışı Kasam › + Kapanış'tan gir")
        cur.execute("SELECT sube_id, event_id, govde, tip FROM operasyon_deneme WHERE id=%s", (body.deneme_id,))
        r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Deneme bulunamadı")
    r = dict(r)
    if r["tip"] != "KAPANIS":
        raise HTTPException(400, "Yalnız kapanış denemesi işlenebilir")
    govde = __import__("evvel_yeni_cekirdek").json_ac(r["govde"], {})
    try:
        tb = so.OperasyonTamamla(**{k: v for k, v in govde.items() if k in so.OperasyonTamamla.model_fields})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Kayıtlı kapanış verisi okunamadı: {str(e)[:150]}")
    jeton = so._GEC_YONETICI.set(kim or "merkez")
    try:
        sonuc = so.operasyon_tamamla_rota(r["sube_id"], r["event_id"], tb)
    finally:
        so._GEC_YONETICI.reset(jeton)
    return {"ok": True, "mesaj": "Geç kapanış işlendi" + (" — uyarılar: " + " · ".join(sonuc.get("uyarilar") or []) if (sonuc or {}).get("uyarilar") else ""),
            "sonuc": sonuc}


@router.post("/kapanis-uyari-gordum")
def kapanis_uyari_gordum(body: DenemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    with db() as (conn, cur):
        if not __import__("evvel_yeni_cekirdek").kolon_var(cur, "operasyon_deneme", "goruldu"):
            raise HTTPException(409, "Eski kapanış denemesi tablosunda 'görüldü' alanı yok — eski sistem kayıtları işaretlenemez")
        cur.execute("UPDATE operasyon_deneme SET goruldu=TRUE WHERE id=%s RETURNING id", (body.deneme_id,))
        if not cur.fetchone():
            raise HTTPException(404, "Bulunamadı")
    return {"ok": True}


# 🧩 Kasa'nın kendi bekleyen işi: reddedilen / uyarılı panel kapanışları (Zafer 16 Ekim dersi)
bekleyen_is_kaydet("kapanis", lambda cur, b: _kapanis_deneme_isleri(cur, b["C"]))


def _simdi_iso() -> str:
    return __import__("evvel_yeni_cekirdek").simdi_tr().isoformat(timespec="seconds")


def _kapanis_sonradan_isleri(cur, b: dict) -> List[dict]:
    """Codex (21 Eki): panelde kapanış SONRADAN değişti ama gün sayılmış / onaylanmış olduğu için Kasa tutarı değişmedi (yalnız not)
    → merkez görsün, farkı Kasa'da izli düzeltsin (taşıma / fark). 'Gördüm' deyince düşer; yeni değişiklik olursa yeniden gelir."""
    C = b["C"]
    cur.execute("""SELECT id, cep, is_gunu, tutar, veri FROM para_izi_hareket
                    WHERE tur='kapanis' AND veri ? 'panel_sonradan' AND NOT (veri ? 'sonradan_goruldu')
                      AND id NOT IN (SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal')
                      AND is_gunu >= %s""", (_baslangic(cur),))
    out = []
    for r in [dict(x) for x in cur.fetchall() or []]:
        v = __import__("evvel_yeni_cekirdek").json_ac(r["veri"], {})
        son = (v.get("panel_sonradan") or [{}])[-1]
        if not son.get("zaman"):
            continue   # Fable S: 21 Eki öncesi birikmiş notlar Bekleyen işler'i şişirmesin (yalnız yeni değişiklikler)
        kayitli_nakit = int(r["tutar"]) if not v.get("sayimdan_sonra") else 0   # Codex P2: panel_sonradan.nakit ZATEN düzeltme düşülmüş saklanır (tek esas)
        fark = int(son.get("nakit", 0)) - kayitli_nakit
        kart_fark = int(son.get("kart", 0)) - int(v.get("kart", 0) or 0) if not v.get("sayimdan_sonra") else 0
        ayrim_fark = (not v.get("sayimdan_sonra") and any(a in son and int(son[a] or 0) != int(v.get(a, 0) or 0) for a in ("pos", "online")))
        if not fark and not kart_fark and not ayrim_fark and not v.get("sayimdan_sonra"):
            continue
        out.append({"genel": True, "grup": "kasa", "tur": "kapanis_sonradan", "id": f"ks:{r['id']}", "tarih": str(r["is_gunu"])[:10],
                    "etiket": "🧾 Panel kapanışı sonradan değişti", "ad": (C.get(r["cep"]) or {}).get("kisa", r["cep"]),
                    "alt": ((f"Gün sayıldıktan SONRA geldi: panel nakdi {_tl(int(son.get('nakit', 0)))} deftere yazılmadı (ciro raporlarda görünür) — "
                             "para çekmecede kaldıysa Kasa'da izli düzelt") if v.get("sayimdan_sonra") else
                            (f"Kasa'da nakit {_tl(kayitli_nakit)} · panelde {_tl(int(son.get('nakit', 0)))}"
                             + (f" ({'+' if fark > 0 else ''}{_tl(fark)})" if fark else "")
                             + (f" · kart {_tl(int(v.get('kart', 0) or 0))} → {_tl(int(son.get('kart', 0)))}" if kart_fark else "")
                             + (f" · POS {_tl(int(v.get('pos', 0) or 0))} → {_tl(int(son.get('pos', 0) or 0))}, online {_tl(int(v.get('online', 0) or 0))} → {_tl(int(son.get('online', 0) or 0))}" if ayrim_fark else "")
                             + " — Kasa kendiliğinden değiştirmedi (gün sayılmış / onaylı); gerekiyorsa izli düzelt")),
                    "gordum": {"yol": "/evvel-yeni/kasa/kapanis-sonradan-gordum", "govde": {"id": r["id"]}}})
    return out


bekleyen_is_kaydet("kapanis_sonradan", _kapanis_sonradan_isleri)


class SonradanBody(BaseModel):
    id: str


@router.post("/kapanis-sonradan-gordum")
def kapanis_sonradan_gordum(body: SonradanBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        if not hareket_veri_ekle(cur, body.id, {"sonradan_goruldu": kim or "merkez"}, tur="kapanis"):
            raise HTTPException(404, "Kapanış bulunamadı")
    return {"ok": True}


# ── AÇIK KAPILAR (sök-tak): başka modüller iç '_' fonksiyonu değil BU adları kullanır — içerik aynı, kapı tek ──
# kasa_hazirla zaten PUBLIC (yukarıda) — tekrar ad tanımlanmaz
kasa_kayitlari = _yukle
pos_oranlari = _oranlar
kasa_baslangic = _baslangic


# ─────────── PUBLIC kapılar (tekrar denetimi C-T2-01/12: Ödeme Kasa'nın 11 özel fonksiyonunu ithal edip tabloya doğrudan yazıyordu) ───────────
olay_listesi = _olaylar          # kayıt → olay (bakiye etkisi) listesi
hareket_fisi = _hareket_dto      # ekranda tek hareket fişi


def bakiyeler(kayit: list, C: dict) -> Dict[str, int]:
    """PUBLIC: {cep_id: kuruş} — kasa_kayitlari() çıktısından anlık cep bakiyeleri (Ödeme formunun kaynak seçimi)."""
    return _bakiye(_olaylar(kayit), C)["b"]


def hareket_kaydet(cur, *, tur: str, gun: str, tutar: int, veri: dict, kim: str, kaynak_ref: Optional[str],
                   para_cepleri: set, kayit: Optional[list] = None, C: Optional[dict] = None) -> Optional[str]:
    """PUBLIC — Kasa'ya hareket yazmanın KORUMALI yolu (Ödeme formu): sayım kilidi + eksiye düşme denetimi + kaynak_ref tekrarı.
    Çağıran Kasa kilidini (çekirdek kilit) almış olmalı. Dönüş: hareket id ya da None (aynı kaynak_ref ile zaten yazılmış)."""
    if kayit is None or C is None:
        _, C, kayit, _ = _yukle(cur)
    yeni = _sahte(tur, gun, tutar=tutar, veri=veri)
    etkiler = [(e["cep"], o["gun"]) for o in _olaylar([yeni]) for e in _etki(o, C)]
    _kilit_denetle(etkiler, _sayim_kilidi(_olaylar(kayit)), C)
    _eksi_denetle(_olaylar(kayit + [yeni]), set(para_cepleri), gun, C)
    return _yaz(cur, tur, gun, kim, tutar=tutar, veri=veri, kaynak_ref=kaynak_ref)


def hareket_veri_degistir(cur, hid: str, veri: dict, tur: Optional[str] = None) -> bool:
    """PUBLIC — hareketin VERİ alanını değiştir (para oynamaz: kimin, ay, açıklama, patron…). İz çağıranın veri['duzeltmeler']'inde."""
    q = "UPDATE para_izi_hareket SET veri = %s::jsonb WHERE id = %s" + (" AND tur = %s" if tur else "") + " RETURNING id"
    cur.execute(q, (json.dumps(veri, ensure_ascii=False), hid) + ((tur,) if tur else ()))
    return cur.fetchone() is not None


def hareket_veri_ekle(cur, hid: str, ek: dict, tur: Optional[str] = None) -> bool:
    """PUBLIC — hareketin verisine alan EKLE / üzerine yaz (veri || ek). Para oynamaz."""
    q = "UPDATE para_izi_hareket SET veri = COALESCE(veri,'{}'::jsonb) || %s::jsonb WHERE id = %s" + (" AND tur = %s" if tur else "") + " RETURNING id"
    cur.execute(q, (json.dumps(ek, ensure_ascii=False), hid) + ((tur,) if tur else ()))
    return cur.fetchone() is not None


def kaynak_refleri(cur, onek: str) -> list:
    """PUBLIC — 'onek' ile başlayan kaynak_ref'li hareketler: [{kaynak_ref, iptal}] (iptal = bir 'iptal' hareketi onu hedefliyor).
    Fatura (kart ekstresi) 'bu satır yazıldı mı / iptal mi' sorusunu tabloya SQL atmadan buradan sorar (C-T2-08)."""
    cur.execute("""SELECT kaynak_ref, id IN (SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal' AND veri ? 'hedef_id') AS iptal
                     FROM para_izi_hareket WHERE kaynak_ref LIKE %s""", (onek.replace("%", r"\%").replace("_", r"\_") + "%",))
    return [dict(r) for r in cur.fetchall() or []]
