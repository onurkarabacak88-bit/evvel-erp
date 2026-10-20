"""🏠 EVVEL YENİ · KİRA HESABI (ev kiraları + işletmelerin kira hesabına borcu) — 2026-10-17, İŞLETMEYE ÖZEL tak-çıkar modül.

Sahip: "İşlerimiz düşük olduğu için bu paradan sürekli alıyoruz. Hem kiraları takip etmek hem de buradan işletmelerin
BORÇLANMALARINI görmek için 'Fatma kira hesabı' diye bir alan kurduk. Basit ama işlevsel kur." · "Kasım'da sıfır olarak başlasın."
Codex + Fable kurgusu:
  · Tek "kira kalemi" (ev adı, kiracı, ödeme günü, artış ayı, başlangıç/bitiş ayı) + aydan geçerli tutar (zam geçmişi bozmaz).
  · Tahsilat = Kasa'nın KENDİ dış girişi (alt=kira, Fatma'nın kira hesabına) + bağ {modul: mulk, id, ay}. Modül para defteri tutmaz.
  · İşletmelerin borcu = Kasa kayıtlarından TÜRETİLİR (yeni para kaydı yok → çift sayım yok), BORC_BAS'tan (1 Kasım) itibaren:
      + kira hesabından işletme adına ödeme (Ödeme formu, kira hesabı parçası; şube = ödemenin şubesi, yoksa Ortak)
      + kira hesabından işletme cebine aktarım (Taşı/Yatır; şube = hedef bankanın şubesi)
      − işletme cebinden kira hesabına aktarım (geri ödeme)
      Kira hesabından ŞAHSİ (patron) harcama borç sayılmaz.
Tak-çıkar: Kasa'nın PUBLIC `defter_ozeti`, `donem_baslangici`, `hareket_ekle` uçlarını kullanır; Kasa bu modülü tanımaz.
"""

import logging
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import aktor as _aktor, ay_kaydir, bekleyen_is_kaydet, bugun as _bugun, kurus as _kurus, tl_sayi as _tl_sayi

router = APIRouter(prefix="/api/evvel-yeni/mulk", tags=["evvel-yeni-mulk"])
log = logging.getLogger(__name__)
KIRA_CEP = "banka:fatma_kira"
BORC_BAS = "2026-11-01"      # sahip: "Kasım'da sıfır olarak başlasın"
_HAZIR = False


def _hazirla():
    global _HAZIR
    if _HAZIR:
        return
    with db() as (conn, cur):
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_mulk (
            id TEXT PRIMARY KEY, ad TEXT NOT NULL, kiraci TEXT, odeme_gunu INT NOT NULL DEFAULT 1, artis_ayi INT,
            baslangic_ay TEXT NOT NULL, bitis_ay TEXT, aktif BOOLEAN NOT NULL DEFAULT TRUE, not_ TEXT, kim TEXT,
            olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_mulk_karar (
            hareket_id TEXT PRIMARY KEY, karar TEXT NOT NULL, kim TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_mulk_kira (
            mulk_id TEXT NOT NULL, gecerli_ay TEXT NOT NULL, tutar BIGINT NOT NULL, PRIMARY KEY (mulk_id, gecerli_ay))""")
    _HAZIR = True


def _gun(y: int, m: int, d: int) -> date:
    import calendar
    return date(y, m, min(int(d or 1), calendar.monthrange(y, m)[1]))


def _kalemler(cur, hepsi: bool = True) -> list:
    cur.execute("SELECT * FROM ey_mulk" + ("" if hepsi else " WHERE aktif") + " ORDER BY aktif DESC, ad")
    ks = [dict(r) for r in cur.fetchall() or []]
    cur.execute("SELECT mulk_id, gecerli_ay, tutar FROM ey_mulk_kira ORDER BY gecerli_ay")
    gec = {}
    for r in cur.fetchall() or []:
        gec.setdefault(dict(r)["mulk_id"], []).append((dict(r)["gecerli_ay"], int(dict(r)["tutar"])))
    for k in ks:
        k["gecmis"] = gec.get(k["id"], [])
    return ks


def _tutar(k: dict, ay: str) -> int:
    t = 0
    for g, v in k["gecmis"]:
        if g <= ay:
            t = v
    return t


def _gelenler(defter: dict) -> dict:
    """Kasa dış girişlerinden (alt=kira, bağ modul=mulk): {(mulk_id, ay): kuruş}."""
    out = {}
    for h in defter["kayitlar"]:
        if h["tur"] != "dis" or (h["veri"] or {}).get("alt") != "kira":
            continue
        bag = (h["veri"] or {}).get("bag") or {}
        if bag.get("modul") != "mulk" or not bag.get("id"):
            continue
        k = (bag["id"], (bag.get("ay") or h["is_gunu"])[:7])
        out[k] = out.get(k, 0) + int(h["tutar"])
    return out


def _takvim(cur, yil: int) -> dict:
    import evvel_yeni_kasa_api as kasa
    bugun = _bugun()
    ks = _kalemler(cur)
    defter = kasa.defter_ozeti(cur)
    donem_ay = kasa.donem_baslangici(cur).strftime("%Y-%m")
    gelen = _gelenler(defter)
    aylar = [f"{yil}-{m:02d}" for m in range(1, 13)]
    out = []
    for k in ks:
        satir = []
        for a in aylar:
            aktif_ay = a >= k["baslangic_ay"] and (not k.get("bitis_ay") or a <= k["bitis_ay"])
            bek = _tutar(k, a) if aktif_ay else 0
            g = gelen.get((k["id"], a), 0)
            vade = _gun(int(a[:4]), int(a[5:7]), k["odeme_gunu"])
            if not aktif_ay or bek == 0:
                durum = "yok" if g == 0 else "odendi"
            else:   # TEK kural (çekirdek takvim_durumu — C-T1-11)
                from evvel_yeni_cekirdek import takvim_durumu
                durum = takvim_durumu(bek, g, vade, bugun, once=a < donem_ay)
            satir.append({"ay": a, "beklenen": _tl_sayi(bek), "odenen": _tl_sayi(g), "kalan": _tl_sayi(max(0, bek - g)),
                          "durum": durum, "vade": vade.isoformat(), "artis_ayi": bool(k.get("artis_ayi")) and int(a[5:7]) == k["artis_ayi"]})
        out.append({"id": k["id"], "ad": k["ad"], "kiraci": k.get("kiraci"), "odeme_gunu": k["odeme_gunu"], "artis_ayi": k.get("artis_ayi"),
                    "baslangic_ay": k["baslangic_ay"], "bitis_ay": k.get("bitis_ay"), "aktif": k["aktif"], "not": k.get("not_"),
                    "kira": _tl_sayi(_tutar(k, bugun.strftime("%Y-%m"))), "aylar": satir,
                    "yil_beklenen": round(sum(x["beklenen"] for x in satir), 2), "yil_gelen": round(sum(x["odenen"] for x in satir), 2)})
    return {"yil": yil, "bugun": bugun.isoformat(), "evler": out}


@router.get("/takvim")
def takvim(yil: Optional[int] = None):
    _hazirla()
    with db() as (conn, cur):
        return _takvim(cur, yil or _bugun().year)


@router.get("/borc")
def borc(yil: Optional[int] = None):
    """İşletmelerin kira hesabına borcu — şube × ay: alınan / geri ödenen / kapanış borcu (BORC_BAS'tan itibaren, devirli)."""
    _hazirla()
    with db() as (conn, cur):
        return _borc(cur, yil or _bugun().year)


def _borc(cur, yil: int) -> dict:
    import evvel_yeni_kasa_api as kasa
    defter = kasa.defter_ozeti(cur)
    cur.execute("SELECT hareket_id, karar FROM ey_mulk_karar")
    karar = {dict(r)["hareket_id"]: dict(r)["karar"] for r in cur.fetchall() or []}
    C = defter["cepler"]
    sor, kararli = [], []   # sahip (2026-10-17): kira hesabı ↔ ev / Fethi hesabı aktarımı "şahsi mi borç mu" diye SORULSUN
    kiralar = {c for c, x in C.items() if x["kira"]} | {KIRA_CEP}
    sube_ad = {x["sube_id"]: x["kisa"] or x["ad"] for x in C.values() if x["tur"] == "sube" and x.get("sube_id")}
    hareket, sahsi = [], 0
    for h in defter["kayitlar"]:
        if h["is_gunu"] < BORC_BAS:
            continue
        v = h["veri"] or {}
        if h["tur"] == "odeme":
            kira_parca = sum(int(p["tutar"]) for p in v.get("parcalar", []) if p.get("cep") in kiralar)
            if not kira_parca:
                continue
            tip = (v.get("konu") or {}).get("tip")
            if v.get("kimin_kod") == "patron" and tip in ("anlik", "diger"):
                sahsi += kira_parca      # patronun ŞAHSİ harcaması işletme borcu değil (kredi/kart borcu 'patron' kodlansa da işletmenin)
                continue
            kisa_sube = {ad_: sid for sid, ad_ in sube_ad.items()}
            s = v.get("kimin_kod") if v.get("kimin_kod") in sube_ad else kisa_sube.get(v.get("kimin"), "ortak")   # Fable: Kasa formu yalnız kısa ad yazar
            hareket.append({"gun": h["is_gunu"], "sube": s, "alinan": kira_parca, "geri": 0, "aciklama": v.get("aciklama") or "Ödeme", "id": h["id"]})
        elif h["tur"] == "tasima" and (h.get("kaynak") in kiralar) != (h.get("hedef") in kiralar):
            karsi = h.get("hedef") if h.get("kaynak") in kiralar else h.get("kaynak")
            if (C.get(karsi) or {}).get("tur") in ("ev", "hesap"):
                k_ = karar.get(h["id"])
                yon = "cikis" if h.get("kaynak") in kiralar else "giris"
                satir_ = {"id": h["id"], "gun": h["is_gunu"], "tutar": _tl_sayi(h["tutar"]), "yon": yon,
                          "karsi": (C.get(karsi) or {}).get("ad", karsi), "karar": k_}
                if k_ is None:
                    sor.append(satir_)
                    continue
                kararli.append(satir_)   # Codex: verilen karar görünsün, değiştirilebilsin
                if k_ == "sahsi":
                    sahsi += h["tutar"] if yon == "cikis" else 0
                    continue
                # k_ == "borc" → Ortak işletme borcu (çıkış artırır, giriş = geri ödeme azaltır)
            if h.get("kaynak") in kiralar:
                hc = C.get(h.get("hedef")) or {}
                s = hc.get("sube_id") if hc.get("sube_id") in sube_ad else "ortak"
                hareket.append({"gun": h["is_gunu"], "sube": s, "alinan": h["tutar"], "geri": 0, "aciklama": f"Aktarım → {hc.get('ad', h.get('hedef'))}", "id": h["id"]})
            else:
                kc = C.get(h.get("kaynak")) or {}
                s = kc.get("sube_id") if kc.get("sube_id") in sube_ad else "ortak"
                hareket.append({"gun": h["is_gunu"], "sube": s, "alinan": 0, "geri": h["tutar"], "aciklama": f"Geri ödeme ← {kc.get('ad', h.get('kaynak'))}", "id": h["id"]})
    aylar = [f"{yil}-{m:02d}" for m in range(1, 13)]
    subeler = sorted({x["sube"] for x in hareket} | set(sube_ad), key=lambda s: (s == "ortak", sube_ad.get(s, "Ortak")))
    out = []
    for s in subeler:
        devir = sum(x["alinan"] - x["geri"] for x in hareket if x["sube"] == s and x["gun"][:7] < aylar[0])
        satir, b = [], devir
        for a in aylar:
            al = sum(x["alinan"] for x in hareket if x["sube"] == s and x["gun"][:7] == a)
            ge = sum(x["geri"] for x in hareket if x["sube"] == s and x["gun"][:7] == a)
            b += al - ge
            satir.append({"ay": a, "alinan": _tl_sayi(al), "geri": _tl_sayi(ge), "borc": _tl_sayi(b), "baslamadi": a < BORC_BAS[:7]})
        out.append({"sube": s, "ad": sube_ad.get(s, "Ortak (şubesiz)"), "devir": _tl_sayi(devir), "aylar": satir, "borc": _tl_sayi(b)})
    return {"yil": yil, "baslangic": BORC_BAS, "subeler": out, "toplam_borc": round(sum(x["borc"] for x in out), 2), "karar_bekleyen": sor, "kararli": sorted(kararli, key=lambda x: x["gun"], reverse=True),
            "sahsi": _tl_sayi(sahsi), "hareketler": [{**x, "alinan": _tl_sayi(x["alinan"]), "geri": _tl_sayi(x["geri"])}
                                                     for x in sorted(hareket, key=lambda x: x["gun"], reverse=True)[:200]]}


class KalemBody(BaseModel):
    ad: str
    kiraci: Optional[str] = None
    tutar: Decimal
    gecerli_ay: Optional[str] = None     # bu tutar hangi aydan geçerli (zam)
    odeme_gunu: int = 1
    artis_ayi: Optional[int] = None
    baslangic_ay: Optional[str] = None
    bitis_ay: Optional[str] = None
    aktif: bool = True
    not_: Optional[str] = None


def _ay_dogrula(a: Optional[str], ad: str) -> Optional[str]:
    if not a:
        return None
    try:
        date.fromisoformat(a[:7] + "-01")
    except ValueError:
        raise HTTPException(400, f"{ad} YYYY-AA olmalı")
    return a[:7]


@router.post("")
def kalem_kaydet(b: KalemBody, mid: Optional[str] = None, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Yeni ev (mid yok) ya da düzeltme (mid). Tutar 'gecerli_ay'dan itibaren geçerli — geçmiş aylar bozulmaz."""
    _hazirla()
    if not b.ad.strip():
        raise HTTPException(400, "Evin adını yaz")
    if not 1 <= int(b.odeme_gunu) <= 31:
        raise HTTPException(400, "Ödeme günü 1–31")
    if b.artis_ayi is not None and not 1 <= int(b.artis_ayi) <= 12:
        raise HTTPException(400, "Artış ayı 1–12")
    t = _kurus(b.tutar)
    if t <= 0:
        raise HTTPException(400, "Aylık kirayı gir")
    bugun_ay = _bugun().strftime("%Y-%m")
    bas = _ay_dogrula(b.baslangic_ay, "Başlangıç ayı") or bugun_ay
    bit = _ay_dogrula(b.bitis_ay, "Bitiş ayı")
    if not b.aktif and not bit:
        bit = bugun_ay          # Codex: "kiralama bitti" → bu aydan sonra kira beklenmez, uyarı üretmez
    gec = _ay_dogrula(b.gecerli_ay, "Geçerli ay") or bas
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        if mid:
            cur.execute("""UPDATE ey_mulk SET ad=%s, kiraci=%s, odeme_gunu=%s, artis_ayi=%s, baslangic_ay=%s, bitis_ay=%s, aktif=%s, not_=%s, kim=%s
                           WHERE id=%s""", (b.ad.strip()[:120], (b.kiraci or "").strip()[:120] or None, int(b.odeme_gunu), b.artis_ayi, bas, bit,
                                            b.aktif, (b.not_ or "").strip()[:300] or None, kim, mid))
            if not cur.rowcount:
                raise HTTPException(404, "Ev bulunamadı")
        else:
            mid = str(uuid.uuid4())
            cur.execute("""INSERT INTO ey_mulk (id, ad, kiraci, odeme_gunu, artis_ayi, baslangic_ay, bitis_ay, aktif, not_, kim)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (mid, b.ad.strip()[:120], (b.kiraci or "").strip()[:120] or None, int(b.odeme_gunu), b.artis_ayi, bas, bit, b.aktif,
                         (b.not_ or "").strip()[:300] or None, kim))
        # Fable: düzeltmede tutar DEĞİŞMEDİYSE yeni zam satırı açılmaz (kiracı adı düzeltmek geçmişi kirletmesin)
        cur.execute("SELECT gecerli_ay, tutar FROM ey_mulk_kira WHERE mulk_id=%s AND gecerli_ay <= %s ORDER BY gecerli_ay DESC LIMIT 1", (mid, gec))
        onceki = cur.fetchone()
        if not onceki or int(dict(onceki)["tutar"]) != t:
            cur.execute("""INSERT INTO ey_mulk_kira (mulk_id, gecerli_ay, tutar) VALUES (%s,%s,%s)
                           ON CONFLICT (mulk_id, gecerli_ay) DO UPDATE SET tutar=EXCLUDED.tutar""", (mid, gec, t))
    return {"ok": True, "id": mid, "mesaj": "Kaydedildi"}


class TahsilatBody(BaseModel):
    mulk_id: str
    ay: str
    tutar: Decimal
    tarih: Optional[str] = None
    istek_id: Optional[str] = None


@router.post("/tahsilat")
def tahsilat(b: TahsilatBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """'Kira geldi' → Kasa'nın KENDİ dış girişi (alt=kira) Fatma'nın kira hesabına + bağ (modul=mulk, ev, ay)."""
    _hazirla()
    ay = _ay_dogrula(b.ay, "Ay")
    with db() as (conn, cur):
        cur.execute("SELECT ad, kiraci FROM ey_mulk WHERE id=%s", (b.mulk_id,))
        k = cur.fetchone()
    if not k:
        raise HTTPException(404, "Ev bulunamadı")
    k = dict(k)
    import evvel_yeni_kasa_api as kasa
    r = kasa.hareket_ekle(kasa.HareketBody(tur="dis", is_gunu=(b.tarih or _bugun().isoformat())[:10], cep=KIRA_CEP, tutar=b.tutar, alt="kira",
                                           kimden=(k.get("kiraci") or k["ad"])[:80], not_=f"{k['ad']} · {ay} kirası",
                                           bag={"modul": "mulk", "id": b.mulk_id, "ay": ay}, istek_id=b.istek_id), x_evvel_oturum)
    return {"ok": True, "tekrar": bool(r.get("tekrar")), "mesaj": r.get("mesaj") or f"{k['ad']} · {ay} kirası Fatma'nın kira hesabına girdi"}


def _gecikenler(cur) -> list:
    """Ödeme günü geçmiş, eksik kalan kira — son 3 ay (yıl sınırını aşar: Ocak'ta Kasım/Aralık da gelir)."""
    bugun = _bugun()
    son3 = {ay_kaydir(bugun.strftime("%Y-%m"), -i) for i in range(3)}
    evler = {}
    for yil in sorted({int(a[:4]) for a in son3}):
        for e in _takvim(cur, yil)["evler"]:
            evler.setdefault(e["id"], {**e, "gec": []})
            evler[e["id"]]["gec"] += [a for a in e["aylar"] if a["ay"] in son3 and a["durum"] == "gecikti" and a["kalan"] > 0]
    return [e for e in evler.values() if e["gec"]]


def _bekleyen(cur, baglam: dict) -> list:
    """Bekleyen işler (Kira hesabı alt sekmesi): ödeme günü geçmiş, gelmemiş kira — ev başına tek satır."""
    _hazirla()
    out = []
    try:
        with savepoint(cur, "sp_ey_mulk_borc"):   # Codex: SQL hatası ortak işlemi bozmasın
            kb = _borc(cur, _bugun().year)["karar_bekleyen"]
    except Exception as e:  # noqa: BLE001 — Codex: sessizce kaybolmasın
        log.warning("kira hesabı borcu okunamadı: %s", str(e)[:150])
        return [{"tur": "mulk_hata", "genel": True, "grup": "kira", "id": "mulk_hata", "tarih": _bugun().isoformat(),
                 "etiket": "⚠ Kira hesabı okunamadı", "ad": "İşletmelerin borcu hesaplanamadı", "alt": "sayfayı açıp tekrar dene",
                 "sayfa": "mulk_borc", "dugme": "İşletmelerin borcu"}]
    if kb:
        out.append({"tur": "mulk_karar", "genel": True, "grup": "kira", "id": "mulk_karar", "tarih": kb[0]["gun"],
                    "etiket": "🏠 Şahsi mi borç mu?", "ad": f"{len(kb)} aktarım kira hesabı ↔ ev / hesap",
                    "alt": "işletme borcu mu, şahsi mi — karar ver", "sayfa": "mulk_borc", "dugme": "İşletmelerin borcu"})
    for e in _gecikenler(cur):
        top = sum(a["kalan"] for a in e["gec"])
        out.append({"tur": "mulk_kira", "genel": True, "grup": "kira", "id": f"mulk:{e['id']}", "tarih": e["gec"][0]["vade"],
                    "etiket": "🏠 Kira gelmedi", "ad": f"{e['ad']}{(' · ' + e['kiraci']) if e.get('kiraci') else ''}",
                    "alt": f"{len(e['gec'])} ay · {top:,.0f} ₺ — geldiyse Kira hesabı → 'Kira geldi'".replace(",", "."),
                    "sayfa": "mulk_takvim", "dugme": "Ev kiraları"})
    return out


class KararBody(BaseModel):
    hareket_id: str
    karar: str          # sahsi | borc | (boş = kararı geri al)


@router.post("/karar")
def karar_ver(b: KararBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Kira hesabı ↔ ev / Fethi hesabı aktarımı: ŞAHSİ (borç değil) mi, İŞLETME BORCU mu (sahip karar verir)."""
    _hazirla()
    with db() as (conn, cur):
        if b.karar in ("sahsi", "borc"):
            cur.execute("""INSERT INTO ey_mulk_karar (hareket_id, karar, kim) VALUES (%s,%s,%s)
                           ON CONFLICT (hareket_id) DO UPDATE SET karar=EXCLUDED.karar, kim=EXCLUDED.kim, zaman=NOW()""",
                        (b.hareket_id, b.karar, _aktor(cur, x_evvel_oturum)))
        else:
            cur.execute("DELETE FROM ey_mulk_karar WHERE hareket_id=%s", (b.hareket_id,))
    return {"ok": True, "mesaj": {"sahsi": "Şahsi — borca katılmadı", "borc": "İşletme borcu olarak sayıldı"}.get(b.karar, "Karar geri alındı")}


@router.get("/uyarilar")
def uyarilar():
    _hazirla()
    bugun = _bugun()
    with db() as (conn, cur):
        gec = _gecikenler(cur)
        evler = _kalemler(cur)
    simdi, sonraki = bugun.month, bugun.month % 12 + 1
    return {"geciken": [{"id": e["id"], "ad": e["ad"], "kiraci": e.get("kiraci"), "ay": a["ay"], "kalan": a["kalan"]} for e in gec for a in e["gec"]],
            "artis": [{"id": k["id"], "ad": k["ad"], "artis_ayi": k["artis_ayi"]} for k in evler
                      if k["aktif"] and k.get("artis_ayi") in (simdi, sonraki)]}


@router.get("/baglanmamis")
def baglanmamis():
    """Kasa'ya daha önce (bu modül dışında) girilmiş, hiçbir eve bağlanmamış kira girişleri — 'Kira geldi' yerine BAĞLANIR (Codex)."""
    import evvel_yeni_kasa_api as kasa
    with db() as (conn, cur):
        d = kasa.defter_ozeti(cur)
    return {"girisler": [{"id": h["id"], "gun": h["is_gunu"], "tutar": _tl_sayi(h["tutar"]), "kimden": (h["veri"] or {}).get("kimden"),
                          "not": (h["veri"] or {}).get("not")}
                         for h in d["kayitlar"] if h["tur"] == "dis" and (h["veri"] or {}).get("alt") == "kira" and not (h["veri"] or {}).get("bag")][-60:]}


class BaglaBody(BaseModel):
    hareket_id: str
    mulk_id: str
    ay: str


@router.post("/bagla")
def bagla(b: BaglaBody):
    _hazirla()
    ay = _ay_dogrula(b.ay, "Ay")
    import evvel_yeni_kasa_api as kasa
    with db() as (conn, cur):
        cur.execute("SELECT 1 FROM ey_mulk WHERE id=%s", (b.mulk_id,))
        if not cur.fetchone():
            raise HTTPException(404, "Ev bulunamadı")
        if not kasa.dis_giris_bagla(cur, b.hareket_id, {"modul": "mulk", "id": b.mulk_id, "ay": ay}, "kira"):
            raise HTTPException(409, "Bu giriş bulunamadı ya da zaten bir eve bağlı")
    return {"ok": True, "mesaj": "Giriş eve bağlandı (para değişmedi)"}


bekleyen_is_kaydet("mulk_kira", _bekleyen)
