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
import math
import uuid
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from database import db, savepoint

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
OTOMATIK_KABUL_GUN = 1
DUZELTME_SURESI_GUN = 7
ACIK = "__acik"                          # açık fark kovası (cep değil)
YOLDA = "__yolda"                        # teslim edildi, "aldım" bekleniyor (cep değil)
KILIT_ANAHTARI = 7_012_026               # pg_advisory_xact_lock — modülün tek yazma kilidi
MAKS_KURUS = 10 ** 12                    # 10 milyar ₺ — saçma girişe karşı sınır

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
}


def _bugun() -> date:
    try:
        from tr_saat import bugun_tr
        return bugun_tr()
    except Exception:  # noqa: BLE001
        return date.today()


def _tr_baslik(s: str) -> str:
    """'KÖYCEĞİZ' → 'Köyceğiz' (Türkçe I/İ kuralıyla; str.title() bozar)."""
    def kucuk(x):
        return x.replace("I", "ı").replace("İ", "i").lower()
    return " ".join((w[:1] + kucuk(w[1:])) if w else w for w in s.split(" "))


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


def _kilit(cur) -> None:
    cur.execute("SELECT pg_advisory_xact_lock(%s)", (KILIT_ANAHTARI,))


def _aktor(cur, jeton: Optional[str]) -> str:
    """Kaydı yapan — oturum jetonundan (istemciden gelen isim yazılmaz)."""
    try:
        from admin_oturum import jeton_coz
        gecerli, _, kid = jeton_coz(jeton or "")
        if not gecerli:
            return "oturumsuz"
        if kid:
            with savepoint(cur, "sp_pi_aktor"):
                cur.execute("SELECT ad FROM kullanici WHERE id=%s", (kid,))
                r = cur.fetchone()
                if r and dict(r).get("ad"):
                    return str(dict(r)["ad"])[:60]
        return "yönetim (ortak giriş)"
    except Exception:  # noqa: BLE001
        return "bilinmiyor"


# ─────────────────────────── OKUMA ───────────────────────────
def _cepler(cur) -> List[dict]:
    cur.execute("SELECT id, ad, kisa, tur, sube_id, sira FROM para_izi_cep WHERE aktif ORDER BY sira, ad")
    return [dict(r) for r in cur.fetchall() or []]


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
    return [r for r in rows if r["tur"] != "iptal" and r["id"] not in iptal_edilen], iptaller


def _olaylar(kayitlar: List[dict]) -> List[dict]:
    """Kayıtları tarihli OLAYLARA açar. Teslim iki olaydır: çıkış (teslim günü) ve
    alım ('aldım' günü). Sıra: gün, sonra kayıt anı."""
    out = []
    for r in kayitlar:
        if r["tur"] == "teslim":
            out.append({**r, "olay": "teslim_cikis", "gun": r["is_gunu"], "s": r["_sira"]})
            if r["durum"] == "onaylandi":
                g = r["veri"].get("onay_gunu") or r["is_gunu"]
                s = r["onay_zamani"].isoformat() if hasattr(r.get("onay_zamani"), "isoformat") else r["_sira"]
                out.append({**r, "olay": "teslim_alim", "gun": g, "s": s})
        else:
            out.append({**r, "olay": r["tur"], "gun": r["is_gunu"], "s": r["_sira"]})
    out.sort(key=lambda o: (o["gun"], o["s"], o["id"], o["olay"]))
    return out


# ─────────────────────────── MOTOR ───────────────────────────
def _etki(o: dict, C: dict) -> List[dict]:
    """Bir olayın ceplere etkisi (kuruş). Tek doğru yer — ekran tekrar etmez."""
    t, v = o["olay"], o["veri"]
    ad = lambda cid: C.get(cid, {}).get("ad", cid)  # noqa: E731
    kisa = lambda cid: C.get(cid, {}).get("kisa", cid)  # noqa: E731
    if t == "acilis":
        return [{"cep": o["cep"], "d": o["tutar"], "etiket": "Açılış bakiyesi (" + o["gun"] + ")", "kaynak": "Açılış"}]
    if t == "kapanis":
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
        if sb == "bulundu":
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
    coz = {o["veri"].get("fark_id"): o for o in ol if o["olay"] == "cozum"}
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
    for x in out:
        c = coz.get(x["id"])
        x["coz"] = None if not c else {"sebep": c["veri"].get("sebep"), "sebep_ad": SEBEPLER.get(c["veri"].get("sebep"), ""),
                                        "sorumlu": c["veri"].get("sorumlu"), "not": c["veri"].get("not"), "tarih": c["gun"],
                                        "kaydeden": c.get("kaydeden")}
    return out


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
                    v = o["veri"]
                    t = int(v.get(kanal, 0)) if (kanal in v) else (int(v.get("kart", 0)) if kanal == "pos" else 0)
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
                        "oran": float(oran or 0), "beklenen_net": _tl_sayi(round(bekleyen * (1 - float(oran or 0) / 100))),
                        "en_eski_gun": en_eski, "gun_sayisi": _gun_fark(en_eski, ref) if en_eski else 0})
    return out


def _oranlar(cur) -> Dict[str, tuple]:
    try:
        with savepoint(cur, "sp_pi_oran"):
            cur.execute("SELECT id, pos_oran, online_oran FROM ey_sube")
            return {str(dict(r)["id"]): (float(dict(r)["pos_oran"] or 0), float(dict(r)["online_oran"] or 0)) for r in cur.fetchall() or []}
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
        alan = None
        if t == "teslim_alim":
            alan = (kisa(o["hedef"]) or "") + (" · otomatik" if v.get("otomatik") else (" · " + o["onaylayan"] if o.get("onaylayan") else ""))
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


def _cep_durum(c: dict, ol: List[dict], D: dict, ref: str, fl: List[dict], C: dict) -> dict:
    cid = c["id"]
    iz = _cep_iz(cid, ol, C)
    bal = D["b"].get(cid, 0)
    bos = bal == 0
    kir, sar = [], []
    if bal < 0:
        kir.append(f"Eksi bakiye {_tl(bal)} — açılış bakiyesi ya da bir giriş eksik")
    for x in fl:
        if not x["coz"] and (x["cep"] == cid or x["sube_cep"] == cid):
            kir.append(f"{_tl(abs(x['f']))} {'eksik' if x['f'] > 0 else 'fazla'} · açık fark ({'teslim' if x['tur'] == 'teslim' else 'sayım'}, {x['tarih']})")
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
        if g >= SAYIM_UYARI_GUN:
            sar.append(f"{_tl(bal)} {g} gündür evde bekliyor — gerçekten evde mi? (değilse 'Sayım' gir)")
    if c["tur"] == "hesap" and bal > 0:
        ilk = next((r for r in iz["seg"] if r["d"] > 0), None)
        g = _gun_fark(ilk["tarih"], ref) if ilk else 0
        (kir if g >= 3 else sar).append(f"{_tl(bal)} {g} gündür hesapta bekliyor")
    gelen: Dict[str, int] = {}
    for r in iz["seg"]:
        if r["d"] > 0:
            gelen[r["kaynak"] or "?"] = gelen.get(r["kaynak"] or "?", 0) + r["d"]
    cikan = sum(-r["d"] for r in iz["seg"] if r["d"] < 0)
    kisa_cep = {x["kisa"]: x["id"] for x in C.values()}
    son_sayim = max((o["gun"] for o in ol if o["olay"] == "sayim" and o["cep"] == cid), default=None)
    seviye = "kirmizi" if kir else "sari" if sar else "gri" if bos else "yesil"
    return {"id": cid, "ad": c["ad"], "kisa": c["kisa"], "tur": c["tur"], "bakiye": _tl_sayi(bal),
            "seviye": seviye, "kirmizi": kir, "sari": sar,
            "gelen": [{"kaynak": k, "tutar": _tl_sayi(v), "cep": kisa_cep.get(k)} for k, v in gelen.items()],
            "gelen_toplam": _tl_sayi(sum(gelen.values())), "cikan": _tl_sayi(cikan), "son_teslim": son_teslim,
            "son_sayim": son_sayim,
            "bosaldi": None if not iz["bosaldi"] or not bos else {"tarih": iz["bosaldi"]["tarih"], "etiket": iz["bosaldi"]["etiket"]}}


def _tl_sayi(k: int) -> float:
    return round(k / 100.0, 2)


def _tl(k: int) -> str:
    tam, kurus = divmod(abs(int(k)), 100)
    s = f"{tam:,}".replace(",", ".") + (f",{kurus:02d}" if kurus else "")
    return ("−" if k < 0 else "") + s + " ₺"


def _kurus(x) -> int:
    """Tutarı KURUŞA çevirir: Decimal ile, en fazla 2 ondalık, sonlu, sınırlı."""
    try:
        d = Decimal(str(x))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(400, "Tutar sayı olmalı")
    if not d.is_finite() or (isinstance(x, float) and not math.isfinite(x)):
        raise HTTPException(400, "Tutar geçersiz")
    if d != d.quantize(Decimal("0.01")):
        raise HTTPException(400, "Tutar en fazla 2 ondalık (kuruş) olabilir")
    k = int(d * 100)
    if abs(k) > MAKS_KURUS:
        raise HTTPException(400, "Tutar çok büyük")
    return k


def _hareket_dto(r: dict, C: dict, ol: List[dict]) -> dict:
    v = r["veri"]
    d = {"id": r["id"], "tur": r["tur"], "tarih": r["is_gunu"], "kaydeden": r.get("kaydeden"), "durum": r.get("durum"),
         "cep": r.get("cep"), "kaynak": r.get("kaynak"), "hedef": r.get("hedef"), "tutar": _tl_sayi(r["tutar"]),
         "eski_sistem": bool(r.get("kaynak_ref")) and not str(r.get("kaynak_ref")).startswith("odeme_formu:")}
    if r["tur"] == "kapanis":
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
                 onaylayan=r.get("onaylayan"))
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
    o["acik_eksik"] = _tl_sayi(sum(x["f"] for x in acik if x["f"] > 0))
    o["acik_fazla"] = _tl_sayi(-sum(x["f"] for x in acik if x["f"] < 0))
    o["acik_fark_sayisi"] = len(acik)
    return o


def _isler(kayitlar: List[dict], C: dict, fl: List[dict]) -> List[dict]:
    """Bekleyen işler — GÜNE BAĞLI DEĞİL, en eski üstte (sahip: 'onayları gözden kaçırırız')."""
    out = []
    for h in kayitlar:
        if h["tur"] == "kapanis" and h["durum"] != "onaylandi":
            out.append({"tur": "kapanis", "id": h["id"], "tarih": h["is_gunu"], "cep": h["cep"], "ad": C.get(h["cep"], {}).get("ad"),
                        "nakit": _tl_sayi(h["tutar"]), "kart": _tl_sayi(int(h["veri"].get("kart", 0))), "eski_sistem": bool(h.get("kaynak_ref"))})
        if h["tur"] == "teslim" and h["durum"] != "onaylandi":
            out.append({"tur": "teslim", "id": h["id"], "tarih": h["is_gunu"], "kaynak": h["kaynak"], "hedef": h["hedef"],
                        "ad": f"{C.get(h['kaynak'], {}).get('ad')} → {C.get(h['hedef'], {}).get('ad')}",
                        "hedef_kisa": C.get(h["hedef"], {}).get("kisa"), "tutar": _tl_sayi(h["tutar"]), "eski_sistem": bool(h.get("kaynak_ref"))})
    for x in fl:
        if not x["coz"]:
            out.append({"tur": "fark", "id": x["id"], "tarih": x["tarih"], "ad": x["ad"], "f": _tl_sayi(x["f"])})
    out.extend(_eksik_kapanislar(kayitlar, C))
    out.sort(key=lambda x: x["tarih"])
    return out


def _eksik_kapanislar(kayitlar: List[dict], C: dict) -> List[dict]:
    """Sahip (2026-10-16): "Girilmemiş ciro uyarı versin; o günün girişi şubeden yeniden istensin."
    Dönem başından DÜNE kadar her aktif şube × gün: kapanış YOKSA → 'eksik_kapanis';
    kapanış yalnız Evo'nun tahmini taslağıysa (şube kapanış yapmamış) → 'evo_kapanis'."""
    if not kayitlar:
        return []
    bas = min(h["is_gunu"] for h in kayitlar)
    dun = (_bugun() - timedelta(days=1)).isoformat()
    var = {}
    for h in kayitlar:
        if h["tur"] == "kapanis":
            var[(h["cep"], h["is_gunu"])] = h
    out = []
    subeler = [c for c in C.values() if c["tur"] == "sube" and c.get("aktif", True)]
    g = date.fromisoformat(bas)
    while g.isoformat() <= dun:
        gi = g.isoformat()
        for c in subeler:
            h = var.get((c["id"], gi))
            if not h:
                out.append({"tur": "eksik_kapanis", "id": f"eksik:{c['id']}:{gi}", "tarih": gi, "cep": c["id"], "ad": c["kisa"]})
            elif h["veri"].get("eski_kaynak") == "evo_taslak":
                out.append({"tur": "evo_kapanis", "id": h["id"], "tarih": gi, "cep": c["id"], "ad": c["kisa"],
                            "nakit": _tl_sayi(h["tutar"]), "kart": _tl_sayi(int(h["veri"].get("kart", 0)))})
        g += timedelta(days=1)
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


def _kilit_denetle(etkiler: List[tuple], kilit: Dict[str, str], C: dict, sayim_icin: Optional[str] = None) -> None:
    """etkiler: [(cep, gün)] — sayılmış bir cebi sayım günü ve öncesinde etkileyen değişiklik reddedilir."""
    for cep, gun in etkiler:
        if cep in (ACIK, YOLDA) or cep not in kilit:
            continue
        if sayim_icin == cep and gun >= kilit[cep]:
            continue    # aynı/sonraki gün yeni sayım serbest
        if gun <= kilit[cep]:
            raise HTTPException(409, f"{C[cep]['ad']} {kilit[cep]} günü sayıldı; o güne ve öncesine değişiklik yapılamaz "
                                     f"(sayım bozulurdu). Fark varsa 'Farkı çöz' ile kapat ya da kaydı sayımdan sonraki bir güne gir.")


def _eksi_denetle(ol: List[dict], cepler: set, bas_gun: str, C: dict) -> None:
    """Verilen ceplerin bas_gun'den itibaren HİÇBİR gün sonunda eksiye düşmediğini doğrular."""
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
                raise HTTPException(400, f"{C[c]['ad']} {g} günü sonunda eksiye düşüyor ({_tl(v)}). "
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
        cep_list, C, kayit, iptaller = _yukle(cur)
        bas = _baslangic(cur)
        oranlar = _oranlar(cur)
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
                                       for p in o["veri"].get("parcalar", []) if p["cep"] in KIRA_CEPLERI)),
        "bankaya_giren": _tl_sayi(sum(e["d"] for o in gunun_ol for e in _etki(o, C) if e["d"] > 0 and C.get(e["cep"], {}).get("tur") == "banka")),
        # Kayıtsız elden harcama da ödemedir (Codex): bir kez sayılır, cebi tekrar düşmez.
        # Yalnız NAKİT/HAVALE parçaları — kartla ödenen kısım kasadan çıkmadı (kart borcu oldu)
        "odenen": _tl_sayi(sum(int(p["tutar"]) for o in gunun_ol if o["olay"] == "odeme" for p in o["veri"].get("parcalar", []))
                           + sum(int(o["veri"].get("f", 0)) for o in gunun_ol if o["olay"] == "cozum" and o["veri"].get("sebep") == "harcandi")),
    }
    cep_durumlari = [_cep_durum(c, ol, D, ref, fl, C) for c in cep_list]
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
    tum_ad = {h["id"]: h for h in kayit}
    return {
        "gun": g, "hepsi": hepsi, "baslangic": bas.isoformat(), "bugun": bugun, "senkron": senkron,
        "ozet": _ozet(D, fl),
        "onceki_toplam": None if onceki is None else _tl_sayi(onceki["toplam"]),
        "degisim": None if onceki is None else _tl_sayi(D["toplam"] - onceki["toplam"]),
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
                      "hedef_tur": (tum_ad.get(i["veri"].get("hedef_id")) or {}).get("tur")} for i in gunun_iptal],
        "isler": _isler(kayit, C, _farklar(ol_tum, C)),
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
        "farklar": [{**x, "f": _tl_sayi(x["f"])} for x in fl if x["cep"] == cep_id or x["sube_cep"] == cep_id],
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
                 "tutar": _tl_sayi(h["tutar"]), "eski_sistem": bool(h.get("kaynak_ref")), "kaydeden": h.get("kaydeden"),
                 "yas_gun": _gun_fark(h["is_gunu"], bugun)}
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
    ol = _olaylar(kayit)
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
                    "acik_farklar": [{**x, "f": _tl_sayi(x["f"])} for x in fl if not x["coz"]]})
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
    satir, kum_kayip, kum_harc = [], 0, 0
    for d in sorted({o["gun"] for o in ol}):
        yeni = sum(x["f"] for x in fl if x["tarih"] == d)
        cz = [o for o in ol if o["olay"] == "cozum" and o["gun"] == d]
        geri = sum(int(o["veri"].get("f", 0)) for o in cz if o["veri"].get("sebep") not in ("kayip", "harcandi"))
        kay = sum(int(o["veri"].get("f", 0)) for o in cz if o["veri"].get("sebep") == "kayip")
        har = sum(int(o["veri"].get("f", 0)) for o in cz if o["veri"].get("sebep") == "harcandi")
        kum_kayip += kay
        kum_harc += har
        son = _bakiye([o for o in ol if o["gun"] <= d], C)["acik"]
        if not (yeni or geri or kay or har or son):
            continue
        satir.append({"gun": d, "yeni": _tl_sayi(yeni), "geri_donen": _tl_sayi(geri), "kayba_yazilan": _tl_sayi(kay),
                      "harcamaya_yazilan": _tl_sayi(har), "gun_sonu_acik": _tl_sayi(son),
                      "toplam_kayip": _tl_sayi(kum_kayip), "toplam_harcanan": _tl_sayi(kum_harc)})
    D = _bakiye(ol, C)
    oz = _ozet(D, fl)
    return {"acik": oz["acik"], "acik_eksik": oz["acik_eksik"], "acik_fazla": oz["acik_fazla"],
            "kayip": oz["kayip"], "harcanan": oz["harcanan"],
            "farklar": [{**x, "f": _tl_sayi(x["f"])} for x in fl], "gun_gun": satir}


def _sebep_secenekleri(x: dict) -> List[str]:
    if x["f"] > 0:
        return ["bulundu"] + (["subede"] if x["tur"] == "teslim" else []) + ["harcandi", "kayip"]
    return ["bulundu", "kabul"]


@router.get("/fark/{fark_id}")
def fark_detay(fark_id: str):
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur)
    x = next((z for z in _farklar(_olaylar(kayit), C) if z["id"] == fark_id), None)
    if not x:
        raise HTTPException(404, "Fark bulunamadı")
    return {**x, "f": _tl_sayi(x["f"]), "cep_ad": C.get(x["cep"], {}).get("ad"),
            "sube_cep_ad": C.get(x["sube_cep"], {}).get("ad") if x["sube_cep"] else None,
            "sebep_secenekleri": [{"kod": s, "ad": ("Sayım hatası, defter doğru" if x["f"] < 0 and s == "bulundu" else SEBEPLER[s])}
                                  for s in _sebep_secenekleri(x)]}


# ─────────────────────────── UÇLAR: YAZMA ───────────────────────────
class Parca(BaseModel):
    cep: str
    tutar: Decimal


class HareketBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    tur: str
    is_gunu: Optional[str] = None
    cep: Optional[str] = None
    kaynak: Optional[str] = None
    hedef: Optional[str] = None
    tutar: Optional[Decimal] = None
    kart: Optional[Decimal] = None
    alt: Optional[str] = None
    kimden: Optional[str] = None
    not_: Optional[str] = Field(None, alias="not")
    aciklama: Optional[str] = None
    kimin: Optional[str] = None
    parcalar: Optional[List[Parca]] = None
    sayilan: Optional[Decimal] = None
    fark_id: Optional[str] = None
    sebep: Optional[str] = None
    sorumlu: Optional[str] = None
    teslim_eden: Optional[str] = None
    online: Optional[Decimal] = None


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


@router.post("/hareket")
def hareket_ekle(body: HareketBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Tek yazma kapısı. Tek transaction + modül kilidi: ya tamamı yazılır ya hiçbiri."""
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
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        bas = _baslangic(cur)
        if gd < bas and t != "acilis":
            raise HTTPException(400, f"Bu dönem {bas.strftime('%d.%m.%Y')} tarihinde başladı; öncesine kayıt girilemez")
        kim = _aktor(cur, x_evvel_oturum)
        cep_list, C, kayit, _ = _yukle(cur)
        ol = _olaylar(kayit)
        kilit = _sayim_kilidi(ol)

        def cep_var(cid, turler=None):
            if not cid or cid not in C or (turler and C[cid]["tur"] not in turler):
                raise HTTPException(400, "Cep bulunamadı ya da bu işlem için uygun değil")

        tut = _kurus(body.tutar) if body.tutar is not None else 0
        yeni = None
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
            if tut < 0 or kart < 0 or (tut == 0 and kart == 0):
                raise HTTPException(400, "Nakit ya da kart tutarı gir")
            mevcut = next((h for h in kayit if h["tur"] == "kapanis" and h["cep"] == body.cep and h["is_gunu"] == gun), None)
            if mevcut:
                # Sahip (2026-10-16): Evo'nun TAHMİNİ (şube kapanış yapmamış) gerçek kapanışla DEĞİŞTİRİLİR;
                # eskisi silinmez, iptal kaydıyla devre dışı kalır. Gerçek kapanış varsa 409.
                if mevcut["veri"].get("eski_kaynak") != "evo_taslak":
                    raise HTTPException(409, "Bu şubenin bu güne ait kapanışı zaten var")
                evo_yerine = mevcut
                kayit = [h for h in kayit if h["id"] != mevcut["id"]]
            yeni = _sahte(t, gun, cep=body.cep, tutar=tut, durum="bekliyor", veri={"kart": kart + onl, "pos": kart, "online": onl})
        elif t == "dis":
            cep_var(body.cep)
            alt = body.alt if body.alt in DIS_TURLERI else None
            if not alt:
                raise HTTPException(400, "Giriş türü seç")
            if tut <= 0:
                raise HTTPException(400, "Tutar gir")
            if alt in ("destek", "borc", "kredi") and not (body.kimden or "").strip():
                raise HTTPException(400, "Kimden geldiğini yaz")
            yeni = _sahte(t, gun, cep=body.cep, tutar=tut,
                          veri={"alt": alt, "kimden": (body.kimden or "").strip()[:80], "not": (body.not_ or "").strip()[:200]})
        elif t == "teslim":
            cep_var(body.kaynak, {"sube"})
            cep_var(body.hedef, {"ev"})
            if tut <= 0:
                raise HTTPException(400, "Tutar gir")
            yeni = _sahte(t, gun, kaynak=body.kaynak, hedef=body.hedef, tutar=tut, durum="bekliyor",
                          veri={"teslim_eden": (body.teslim_eden or "").strip()[:60]})
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
            if body.sebep not in _sebep_secenekleri(x):
                raise HTTPException(400, "Bu fark için geçersiz sebep")
            if body.sebep in ("kayip", "harcandi") and not (body.not_ or "").strip():
                raise HTTPException(400, "Kayba ya da harcamaya yazarken açıklama zorunlu")
            if gun < x["tarih"]:
                raise HTTPException(400, "Fark, oluştuğu günden önce kapatılamaz")
            yeni = _sahte(t, gun, tutar=abs(x["f"]),
                          veri={"fark_id": x["id"], "fark_ad": x["ad"], "f": x["f"], "sebep": body.sebep, "cep": x["cep"],
                                "sube_cep": x["sube_cep"], "sorumlu": (body.sorumlu or "")[:40], "not": (body.not_ or "").strip()[:200]})

        # ── ortak korumalar: sayım kilidi + eksiye düşme ──
        if t != "tasima":
            yeniler = [yeni]
        for i, y in enumerate(yeniler):
            y["id"] = f"__yeni{i}__"
        yeni_ol = _olaylar(yeniler)
        etkiler = [(e["cep"], o["gun"]) for o in yeni_ol for e in _etki(o, C)]
        if evo_yerine:   # Evo tahmininin kalkması da o cebi değiştirir → sayılmış güne dokunamaz
            etkiler.append((evo_yerine["cep"], evo_yerine["is_gunu"]))
        if t != "cozum":   # fark çözümü sayımın kendi kapanış yoludur — kilide takılmaz
            _kilit_denetle(etkiler, kilit, C, sayim_icin=body.cep if t == "sayim" else None)
        cikan = {e["cep"] for o in yeni_ol for e in _etki(o, C) if e["d"] < 0 and e["cep"] in C}
        _eksi_denetle(_olaylar(kayit + yeniler), cikan, gun, C)

        if evo_yerine:
            _yaz(cur, "iptal", _bugun().isoformat(), kim,
                 veri={"hedef_id": evo_yerine["id"], "sebep": "Evo tahmini — şubenin gerçek kapanışı girildi"})
            for y in yeniler:
                y["veri"] = {**y["veri"], "evo_yerine": True, "evo_nakit": evo_yerine["tutar"], "evo_kart": int(evo_yerine["veri"].get("kart", 0))}
        idler = [_yaz(cur, t, y["is_gunu"], kim, cep=y["cep"], kaynak=y["kaynak"], hedef=y["hedef"],
                      tutar=y["tutar"], durum=y["durum"], veri=y["veri"]) for y in yeniler]
    return {"ok": True, "id": idler[0], "idler": idler}


class OnayBody(BaseModel):
    alinan: Optional[Decimal] = None


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
            bugun = max(_bugun().isoformat(), r["is_gunu"])
            veri.update(alinan=al, onay_gunu=bugun)
            kilit = _sayim_kilidi(_olaylar(kayit))
            _kilit_denetle([(r["hedef"], bugun)], kilit, C)
        elif r["tur"] != "kapanis":
            raise HTTPException(400, "Bu kayıt onay gerektirmez")
        cur.execute("""UPDATE para_izi_hareket SET durum='onaylandi', onay_zamani=NOW(), onaylayan=%s, veri=%s::jsonb
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
        etkiler = [(e["cep"], o["gun"]) for o in ol_eski for e in _etki(o, C)]
        kilit = _sayim_kilidi(_olaylar([x for x in kayit if x["id"] != hid]) if h["tur"] == "sayim" else _olaylar(kayit))
        if h["tur"] != "sayim":
            _kilit_denetle(etkiler, kilit, C)
        else:
            sonraki = [x for x in kayit if x["tur"] == "sayim" and x["cep"] == h["cep"] and x["is_gunu"] >= h["is_gunu"] and x["id"] != hid]
            if sonraki:
                raise HTTPException(409, "Bu cebin daha sonra (ya da aynı gün) başka sayımı var; önce onu iptal et")
        azalan = {e["cep"] for o in ol_eski for e in _etki(o, C) if e["d"] > 0 and e["cep"] in C}
        _eksi_denetle(_olaylar([x for x in kayit if x["id"] != hid]), azalan, h["is_gunu"], C)
        _yaz(cur, "iptal", _bugun().isoformat(), kim, veri={"hedef_id": hid, "sebep": body.sebep.strip()[:200]})
    return {"ok": True}


# ─────────────────────────── ESKİ SİSTEMDEN TEK YÖNLÜ AKTARIM ───────────────────────────
def _patron_bul(ad: str) -> Optional[str]:
    """kasa_teslim.teslim_alan_ad serbest metin — Onur/Fethi/Fatma adını içeriyorsa eşle."""
    a = (ad or "").replace("İ", "i").replace("I", "ı").lower()
    for anahtar, cid in (("onur", "ev:onur"), ("fethi", "ev:fethi"), ("fatma", "ev:fatma")):
        if anahtar in a:
            return cid
    return None


@router.post("/aktar")
def eski_sistemden_aktar(kuru: bool = True, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
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
                r = _aktar(cur, False, "otomatik köprü (eski sistem)")
                r["ozet"]["otomatik_kabul"] = _otomatik_kabul(cur)
                r["ozet"]["pos_otomatik"] = _pos_otomatik(cur)
                try:
                    with savepoint(cur, "sp_pi_ps_oto"):
                        r["ozet"]["panel_sayim"] = (_panel_sayimlari(cur, False).get("ozet") or {}).get("sayim", 0)
                except Exception as e:  # noqa: BLE001 — sayım aktarımı patlarsa senkronun gerisi yaşar
                    log.warning("evvel-yeni panel sayım: %s", str(e)[:200])
            _SON_SENKRON["sonuc"] = {"tamam": True, "kapanis": r["ozet"]["kapanis"], "teslim": r["ozet"]["teslim"],
                                     "otomatik_kabul": r["ozet"].get("otomatik_kabul", 0),
                                     "pos_otomatik": r["ozet"].get("pos_otomatik", 0),
                                     "eslesmeyen_teslim": r["ozet"]["eslesmeyen_teslim"], "kilitli": r["ozet"]["kilitli"]}
        except Exception as e:  # noqa: BLE001
            log.warning("evvel-yeni kasa otomatik senkron: %s", str(e)[:200])
            _SON_SENKRON["sonuc"] = {"tamam": False, "hata": str(e)[:160]}
    from datetime import datetime, timezone
    zz = _SON_SENKRON["zaman"]
    return {**(_SON_SENKRON["sonuc"] or {}),
            "zaman": datetime.fromtimestamp(zz, timezone.utc).isoformat() if zz else None}


def _otomatik_kabul(cur) -> int:
    """Teslim gününden en az OTOMATIK_KABUL_GUN geçmiş, hâlâ 'aldım' denmemiş teslimleri
    teslim edilen tutarla KABUL eder (para teslim günü eve girmiş sayılır). Patronun evi o
    günden sonra sayıldıysa (sayım kilidi) dokunmaz — orada bekler, ekranda görünür."""
    cep_list, C, kayit, _ = _yukle(cur)
    kilit = _sayim_kilidi(_olaylar(kayit))
    sinir = date.fromordinal(_bugun().toordinal() - OTOMATIK_KABUL_GUN).isoformat()
    n = 0
    for h in kayit:
        if h["tur"] != "teslim" or h["durum"] == "onaylandi" or h["is_gunu"] > sinir:
            continue
        if h["hedef"] in kilit and h["is_gunu"] <= kilit[h["hedef"]]:
            continue
        veri = dict(h["veri"])
        veri.update(alinan=h["tutar"], onay_gunu=h["is_gunu"], otomatik=True)
        cur.execute("""UPDATE para_izi_hareket SET durum='onaylandi', onay_zamani=NOW(),
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
        pos = int(v["pos"])
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
        net = int((Decimal(pos) * (Decimal(100) - Decimal(str(oran))) / Decimal(100)).quantize(Decimal("1"))) if 0 <= oran < 100 else pos
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
    alinan: Decimal


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
        _kilit_denetle([(h["hedef"], og)], _sayim_kilidi(_olaylar(kayit)), C)
        veri = dict(h["veri"])
        veri.setdefault("duzeltmeler", []).append({"eski": int(veri.get("alinan", h["tutar"])), "yeni": al, "kim": kim})
        veri["alinan"] = al
        cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s", (json.dumps(veri, ensure_ascii=False), hid))
    return {"ok": True}


class TopluOnayBody(BaseModel):
    idler: List[str]


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
        cur.execute("""UPDATE para_izi_hareket SET durum='onaylandi', onay_zamani=NOW(), onaylayan=%s
                        WHERE id = ANY(%s) AND tur='kapanis' AND COALESCE(durum,'') <> 'onaylandi'""", (kim, idler))
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
        bekleyen = len(_isler(kayit, C, _farklar(_olaylar(kayit), C)))
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
        for r in teslimler:
            ref = "kasa_teslim:" + str(r["id"])
            kaynak = sube_cep.get(str(r["sube_id"]))
            hedef = _patron_bul(r.get("teslim_alan_ad"))
            if ref in var:
                rapor["atlanan"] += 1
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
                     "dukkan_gideri": rapor["dukkan_gideri"]["yeni"],
                     "zaten_aktarilmis": rapor["atlanan"]}
    return rapor


def _dukkan_giderleri_aktar(cur, C, kayit, kilit, bas, kuru, kim, sube_id=None) -> dict:
    """🧾 Şubenin ÇEKMECEDEN yaptığı nakit harcamalar (eski anlik_giderler, ödeme yöntemi
    nakit; 'aktif' + 'onay_bekliyor' — para çekmeceden fiilen çıktı) → dükkân nakdinden
    'ödeme' (kimin: o şube). Bunlar girmezse kapanış kör sayımı her akşam sahte EKSİK verir.
    Kaynak iptal edilirse karşılığı iptal; sayılmış (kilitli) güne yeni yazılmaz → listelenir."""
    sonuc = {"yeni": 0, "kilitli": [], "iptal": 0}
    try:
        with savepoint(cur, "sp_pi_dukkan_gider"):
            q = """SELECT id, tarih, tutar, sube, kategori, aciklama, durum, kaynak_tablo, kaynak_id FROM anlik_giderler
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
    try:
        with savepoint(cur, "sp_pi_panel_sayim"):
            cur.execute("""SELECT sube_id::text AS sube_id, tarih, tip, kasa_sayim, COALESCE(teslim,0) AS teslim, cevap_ts
                             FROM sube_operasyon_event
                            WHERE tarih >= %s AND tarih <= %s AND durum = 'tamamlandi' AND tip IN ('ACILIS','KAPANIS')
                              AND kasa_sayim IS NOT NULL
                            ORDER BY tarih, cevap_ts NULLS LAST""", (bas, _bugun()))
            olaylar = [dict(r) for r in cur.fetchall() or []]
    except Exception as e:  # noqa: BLE001
        return {**rapor, "hata": str(e)[:200]}
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
            sirali.append(((g.isoformat(), 0, str(e["cevap_ts"])), e, g.isoformat(), "akşam kapanış sayımı"))
        else:
            sirali.append((((g - timedelta(days=1)).isoformat(), 1, str(e["cevap_ts"])), e, (g - timedelta(days=1)).isoformat(), "sabah açılış sayımı"))
    sirali.sort(key=lambda x: x[0])
    elle_kilit = _sayim_kilidi(_olaylar([h for h in kayit if not (h.get("kaynak_ref") or "").startswith("sayim_")]))
    for _, e, gun, ad in sirali:
        cep = sube_cep.get(e["sube_id"])
        if not cep:
            continue
        if e["tip"] == "KAPANIS":
            on = f"sayim_kapanis:{e['sube_id']}:{gun}:"
            ref = on + "1"
            if any(r.startswith(on) for r in refler):
                continue
            sayilan = max(0, _kurus(float(e["kasa_sayim"] or 0) - float(e["teslim"] or 0)))
        else:
            ref = f"sayim_acilis:{e['sube_id']}:{e['tarih'].isoformat()}"
            if ref in refler:
                continue
            sayilan = max(0, _kurus(e["kasa_sayim"]))
        if cep in elle_kilit and gun < elle_kilit[cep]:
            rapor["atlanan"].append({"sube": C[cep]["kisa"], "neden": f"{gun} {ad}: sonrasında elle sayım var"})
            continue
        ilk = cep not in baslamis
        beklenen = _bakiye([o for o in _olaylar(sim) if o["gun"] <= gun], C)["b"].get(cep, 0)
        veri = {"beklenen": beklenen, "sayilan": sayilan, "kaynak": "kapanis_kor_sayim" if e["tip"] == "KAPANIS" else "acilis_sayimi"}
        if e["tip"] == "KAPANIS":
            veri.update(kasa_sayim=_kurus(e["kasa_sayim"]), gun_sonu_teslim=_kurus(e["teslim"] or 0))
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
            sid = _yaz(cur, "sayim", gun, "kapanış kör sayımı" if e["tip"] == "KAPANIS" else "sabah açılış sayımı",
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
    """🔢 KAPANIŞ KÖR SAYIMI → dükkân nakdinin otomatik SAYIMI (sahip: "bağla").
    Çekmecede kalan = sayılan − gün sonu teslim. Defterle tutmazsa AÇIK FARK.
    ⚠️ Dükkânın bu dönemki AÇILIŞ bakiyesi girilmeden çalışmaz: açılışsız sayım her gün
    sahte fark üretir ve sayım kilidi açılışın girilmesini engeller.
    Aynı gün yeniden kapanış (geri al → kapat) → önceki otomatik sayım (çözülmemişse) iptal,
    yenisi yazılır. Panelin transaction'ında, savepoint altında; hata paneli DURDURMAZ."""
    try:
        with savepoint(cur, "sp_pi_kor_sayim"):
            if not _tablo_var(cur) or not _try_kilit(cur):
                return
            g = gun.isoformat() if hasattr(gun, "isoformat") else str(gun)[:10]
            bas = _baslangic(cur)
            if g < max(bas, _panel_sayim_baslangic(cur)).isoformat():
                return
            cep = "sube:" + str(sube_id)
            cep_list, C, kayit, _ = _yukle(cur)
            if cep not in C or not any(h["tur"] == "acilis" and h["cep"] == cep for h in kayit):
                return
            kilit = _sayim_kilidi(_olaylar(kayit))
            _dukkan_giderleri_aktar(cur, C, kayit, kilit, bas, False, "şube paneli (dükkân gideri)", sube_id=sube_id)
            cep_list, C, kayit, _ = _yukle(cur)
            onceki = [h for h in kayit if h["tur"] == "sayim" and h["cep"] == cep and h["is_gunu"] == g
                      and (h.get("kaynak_ref") or "").startswith("sayim_kapanis:")]
            cozulen = {h["veri"].get("fark_id") for h in kayit if h["tur"] == "cozum"}
            for h in onceki:
                if h["id"] in cozulen:
                    return          # o günün farkı zaten kapatılmış — üzerine yazma
                _yaz(cur, "iptal", _bugun().isoformat(), "şube paneli (yeniden kapanış)",
                     veri={"hedef_id": h["id"], "sebep": "Kapanış yeniden yapıldı — yeni kör sayım"})
            cep_list, C, kayit, _ = _yukle(cur)
            beklenen = _bakiye([o for o in _olaylar(kayit) if o["gun"] <= g], C)["b"].get(cep, 0)
            sayilan = _kurus(round(float(kasa_sayim or 0) - float(gun_sonu_teslim or 0), 2))
            cur.execute("SELECT COUNT(*) AS n FROM para_izi_hareket WHERE kaynak_ref LIKE %s", (f"sayim_kapanis:{sube_id}:{g}:%",))
            sira = int(dict(cur.fetchone() or {}).get("n") or 0) + 1
            _yaz(cur, "sayim", g, "kapanış kör sayımı", cep=cep, tutar=max(sayilan, 0),
                 veri={"beklenen": beklenen, "sayilan": max(sayilan, 0), "kaynak": "kapanis_kor_sayim",
                       "kasa_sayim": _kurus(round(float(kasa_sayim or 0), 2)), "gun_sonu_teslim": _kurus(round(float(gun_sonu_teslim or 0), 2))},
                 kaynak_ref=f"sayim_kapanis:{sube_id}:{g}:{sira}")
    except Exception as e:  # noqa: BLE001 — panel ASLA durmaz
        log.warning("evvel-yeni kasa kör sayım yazılamadı: %s", str(e)[:200])


# ─────────────────────────── ŞUBE PANELİNDEN DOĞRUDAN YAZIM ───────────────────────────
# Sahip (2026-10-15): "Köprü mantığı eskiye devamı zorunlu kılar; panelin verisi DİREKT
# buraya gelsin, sonra orada boşa çıkan her şeyi silmek istiyorum."
# Şube panelinin kapanış/teslim yazdığı her noktadan, AYNI transaction içinde ve
# SAVEPOINT altında çağrılır. Hata ASLA paneli durdurmaz (yutulur, loglanır) — kaçan
# kayıt otomatik köprüde (aynı kaynak_ref) yakalanır. Kaynak kimlikleri köprüyle
# AYNIDIR → ikisi aynı kaydı iki kez yazamaz.
def _try_kilit(cur) -> bool:
    cur.execute("SELECT pg_try_advisory_xact_lock(%s) AS ok", (KILIT_ANAHTARI,))
    return bool(dict(cur.fetchone() or {}).get("ok"))


def _tablo_var(cur) -> bool:
    cur.execute("SELECT to_regclass('para_izi_hareket') IS NOT NULL AS var")
    return bool(dict(cur.fetchone() or {}).get("var"))


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
            if not r:
                _yaz(cur, "kapanis", g, "şube paneli" + (f" · {kim}" if kim else ""), cep=cep, tutar=n,
                     durum="bekliyor", veri={"kart": k, "eski_kaynak": "panel", **ayrim}, kaynak_ref=ref)
                return
            r = dict(r)
            veri = r["veri"] if isinstance(r["veri"], dict) else json.loads(r["veri"] or "{}")
            if r["tutar"] == n and int(veri.get("kart", 0)) == k:
                return
            if r["durum"] != "onaylandi":
                veri["kart"] = k
                veri.update(ayrim)
                cur.execute("UPDATE para_izi_hareket SET tutar=%s, veri=%s::jsonb WHERE id=%s",
                            (n, json.dumps(veri, ensure_ascii=False), r["id"]))
            else:
                veri.setdefault("panel_sonradan", []).append({"nakit": n, "kart": k})
                cur.execute("UPDATE para_izi_hareket SET veri=%s::jsonb WHERE id=%s",
                            (json.dumps(veri, ensure_ascii=False), r["id"]))
                log.warning("evvel-yeni kasa: onaylı kapanış panelde değişti %s %s", cep, g)
    except Exception as e:  # noqa: BLE001 — panel ASLA durmaz
        log.warning("evvel-yeni kasa panel kapanış yazılamadı: %s", str(e)[:200])


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
            cur.execute("""SELECT id, kaynak_ref, durum FROM para_izi_hareket
                            WHERE tur='teslim' AND kaynak_ref LIKE 'kasa_teslim:%%' AND is_gunu >= %s
                              AND id NOT IN (SELECT veri->>'hedef_id' FROM para_izi_hareket WHERE tur='iptal')""", (bas,))
            var = {dict(x)["kaynak_ref"]: dict(x) for x in cur.fetchall() or []}
            cur.execute("SELECT kaynak_ref FROM para_izi_hareket WHERE kaynak_ref LIKE 'kasa_teslim:%%'")
            her_zaman = {dict(x)["kaynak_ref"] for x in cur.fetchall() or []}
            for x in kaynak:
                ref = "kasa_teslim:" + str(x["id"])
                cep, hedef = sube_cep.get(str(x["sube_id"])), _patron_bul(x.get("teslim_alan_ad"))
                if ref in her_zaman or not cep or not hedef:
                    continue
                _yaz(cur, "teslim", x["tarih"].isoformat(), "şube paneli", kaynak=cep, hedef=hedef, tutar=_kurus(x["tutar"]),
                     durum="bekliyor", veri={"eski_alan_ad": x.get("teslim_alan_ad"), "teslim_eden": x.get("teslim_eden_ad")}, kaynak_ref=ref)
            for ref, h in var.items():
                if ref not in canli and h["durum"] != "onaylandi":
                    _yaz(cur, "iptal", _bugun().isoformat(), "şube paneli",
                         veri={"hedef_id": h["id"], "sebep": "Şube panelinde geri alındı (kapanış geri al)"})
    except Exception as e:  # noqa: BLE001 — panel ASLA durmaz
        log.warning("evvel-yeni kasa panel teslim eşlenemedi: %s", str(e)[:200])
