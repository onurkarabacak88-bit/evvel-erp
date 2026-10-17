"""🏦 EVVEL YENİ · KREDİLER (2026-10-17) — tak-çıkar modül (sektor: genel).

Sahip: "Krediler içinde kredi takvimi yapsak" (kira takvimi gibi) · "Tek yerden ödeme: ödemeyi yapınca direk düşecek".
  · Kredi tanımı: ad, tür, aylık taksit, ödeme günü, ilk taksit ayı, taksit sayısı (Evvel Yeni'nin KENDİ tablosu ey_kredi).
    İlk kurulumda eski borc_envanteri'nden BİR KEZ kopyalanır (tablo boşsa) — sonra eskiye bakılmaz.
  · Borç = her ay taksit (takvimde beklenen). Ödeme = Ödeme modülünde "Kredi taksiti" + hangi kredi (konu.kredi_id).
  · Takvim: kredi × 12 ay: beklenen · ödenen · durum (ödendi / kısmi / gecikti / yaklaşıyor / gelecek / önce = Evvel Yeni öncesi, kayıt yok).
KÖPRÜ (eski sistem kalkınca SİL — KESIM_LISTESI): `_eski_odenen` eski odeme_plani'nde ödenmiş taksitleri sayar (geçiş
süresince ödemeler hâlâ eski "Öde" ile yapılıyor; yoksa takvim yanlış 'gecikti' der). `_ilk_kopya` bir kerelik tanım kopyası.
Tak-çıkar: Ödeme'nin PUBLIC `odeme_listesi`ni, Kasa'nın PUBLIC `donem_baslangici`nı kullanır; kimse bu modülü import etmez.
"""

import logging
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import aktor as _aktor, ay_kaydir, bugun as _bugun, kurus as _kurus, tl_sayi as _tl_sayi

router = APIRouter(prefix="/api/evvel-yeni/kredi", tags=["evvel-yeni-kredi"])
log = logging.getLogger(__name__)
_HAZIR = False


def _hazirla():
    global _HAZIR
    if _HAZIR:
        return
    with db() as (conn, cur):
        cur.execute("SET LOCAL lock_timeout = '3s'")
        cur.execute("SELECT pg_advisory_xact_lock(7012031)")   # Fable: çok işçide ilk kopya bir kez
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_kredi (
            id TEXT PRIMARY KEY, ad TEXT NOT NULL, tur TEXT, aylik_taksit BIGINT NOT NULL, odeme_gunu INT NOT NULL,
            ilk_ay TEXT NOT NULL, taksit_sayisi INT, aktif BOOLEAN NOT NULL DEFAULT TRUE, eski_id TEXT,
            kim TEXT, olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS ey_kredi_eski_id ON ey_kredi(eski_id) WHERE eski_id IS NOT NULL")
        cur.execute("SELECT COUNT(*) AS n FROM ey_kredi")
        if int(dict(cur.fetchone())["n"]) == 0:
            _ilk_kopya(cur)
    _HAZIR = True


def _ilk_kopya(cur) -> None:
    """KÖPRÜ (bir kez): eski borc_envanteri'ndeki AKTİF krediler → ey_kredi. Kalan taksit sayısı eski kalan_vade'den."""
    try:
        with savepoint(cur, "sp_ey_kredi_kopya"):
            cur.execute("""SELECT id::text AS id, kurum, borc_turu, aylik_taksit, odeme_gunu, ilk_taksit_tarihi, baslangic_tarihi,
                                  toplam_vade, aktif FROM borc_envanteri WHERE COALESCE(aktif, TRUE) = TRUE""")
            for r in cur.fetchall() or []:
                r = dict(r)
                ilk = r.get("ilk_taksit_tarihi")
                if not ilk and r.get("baslangic_tarihi"):   # Codex: eski hesap — ilk taksit başlangıçtan BİR AY sonra
                    b0 = r["baslangic_tarihi"]
                    ilk = date(b0.year + (b0.month == 12), b0.month % 12 + 1, 1)
                if not r.get("aylik_taksit") or not ilk:
                    continue
                cur.execute("""INSERT INTO ey_kredi (id, ad, tur, aylik_taksit, odeme_gunu, ilk_ay, taksit_sayisi, eski_id, kim)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'eski sistemden kopya') ON CONFLICT DO NOTHING""",
                            (str(uuid.uuid4()), (r["kurum"] or "Kredi").strip(), r.get("borc_turu"), _kurus(round(float(r["aylik_taksit"]), 2)),
                             int(r.get("odeme_gunu") or ilk.day), str(ilk)[:7], int(r["toplam_vade"]) if r.get("toplam_vade") else None, r["id"]))
    except Exception as e:  # noqa: BLE001
        log.warning("krediler: eski tanımlar kopyalanamadı: %s", str(e)[:150])


def _eski_odenen(cur) -> dict:
    """KÖPRÜ: eski sistemde ödenmiş taksitler {(eski_kredi_id, 'YYYY-AA'): kuruş}."""
    out = {}
    try:
        with savepoint(cur, "sp_ey_kredi_eski"):
            cur.execute("""SELECT kaynak_id::text AS kid, TO_CHAR(COALESCE(referans_ay, tarih), 'YYYY-MM') AS ay,
                                  SUM(COALESCE(odenen_tutar, odenecek_tutar)) AS t
                             FROM odeme_plani WHERE kaynak_tablo='borc_envanteri' AND durum='odendi' GROUP BY 1, 2""")
            for r in cur.fetchall() or []:
                r = dict(r)
                out[(r["kid"], r["ay"])] = out.get((r["kid"], r["ay"]), 0) + _kurus(round(float(r["t"] or 0), 2))
    except Exception:  # noqa: BLE001 — eski sistem kalkmış olabilir
        pass
    return out


def _krediler(cur, hepsi: bool = False) -> list:
    cur.execute("SELECT * FROM ey_kredi" + ("" if hepsi else " WHERE aktif") + " ORDER BY odeme_gunu, ad")
    return [dict(r) for r in cur.fetchall() or []]


def _yeni_odenen(cur) -> dict:
    """Ödeme modülünün PUBLIC özetinden (tek okuma): {(kredi_id, 'YYYY-AA'): kuruş} — ait olduğu ay (takvimden seçilen)."""
    import evvel_yeni_odeme_api as odeme
    out = {}
    for x in odeme.konu_odemeleri(cur, "kredi"):
        if not x.get("kredi_id"):
            continue
        k = (x["kredi_id"], (x.get("donem") or x.get("ait_ay") or x["tarih"])[:7])
        out[k] = out.get(k, 0) + int(x["toplam"])
    return out


def _gun(y: int, m: int, d: int) -> date:
    """Ayın gerçek son gününe kırpılmış tarih (31 → Şubat 28/29)."""
    import calendar
    return date(y, m, min(int(d or 1), calendar.monthrange(y, m)[1]))


@router.get("/liste")
def liste():
    """Ödeme formu için: aktif krediler (ad, taksit)."""
    _hazirla()
    with db() as (conn, cur):
        return {"krediler": [{"id": k["id"], "ad": k["ad"], "taksit": _tl_sayi(k["aylik_taksit"]), "odeme_gunu": k["odeme_gunu"]}
                             for k in _krediler(cur)]}


@router.get("/takvim")
def takvim(yil: Optional[int] = None):
    _hazirla()
    bugun = _bugun()
    yil = yil or bugun.year
    import evvel_yeni_kasa_api as kasa
    with db() as (conn, cur):
        kr = _krediler(cur)
        eski = _eski_odenen(cur)
        bas = kasa.donem_baslangici(cur).isoformat()[:7]
        yeni = _yeni_odenen(cur)
    aylar = [f"{yil}-{m:02d}" for m in range(1, 13)]
    out = []
    for k in kr:
        son_ay = ay_kaydir(k["ilk_ay"], k["taksit_sayisi"] - 1) if k.get("taksit_sayisi") else None
        satir = []
        for a in aylar:
            aktif_ay = a >= k["ilk_ay"] and (son_ay is None or a <= son_ay)
            bek = int(k["aylik_taksit"]) if aktif_ay else 0
            # Fable+Codex: aynı taksit iki sistemde de girilmişse TOPLANMAZ — yeni kayıt varsa eski sayılmaz; ikisi de varsa işaret
            od_y = yeni.get((k["id"], a), 0)
            od_e = eski.get((k.get("eski_id"), a), 0) if k.get("eski_id") else 0
            od = od_y if od_y > 0 else od_e
            iki_yerde = od_y > 0 and od_e > 0
            vade = _gun(int(a[:4]), int(a[5:7]), k["odeme_gunu"])
            if not aktif_ay:
                durum = "yok"
            elif od >= bek - 100:
                durum = "odendi"
            elif od > 0:
                durum = "kismi"
            elif a < bas:
                durum = "once"          # Evvel Yeni öncesi, kayıt yok — 'gecikti' denmez
            elif vade < bugun:
                durum = "gecikti"
            elif (vade - bugun).days <= 7:
                durum = "yaklasiyor"
            else:
                durum = "gelecek"
            satir.append({"ay": a, "beklenen": _tl_sayi(bek), "odenen": _tl_sayi(od), "kalan": _tl_sayi(max(0, bek - od)),
                          "durum": durum, "vade": vade.isoformat(), "iki_yerde": iki_yerde})
        out.append({"id": k["id"], "ad": k["ad"], "tur": k.get("tur"), "taksit": _tl_sayi(k["aylik_taksit"]), "odeme_gunu": k["odeme_gunu"],
                    "ilk_ay": k["ilk_ay"], "son_ay": son_ay, "aylar": satir,
                    "yil_beklenen": _tl_sayi(sum(int(round(x["beklenen"] * 100)) for x in satir)),
                    "yil_odenen": _tl_sayi(sum(int(round(x["odenen"] * 100)) for x in satir))})
    ay_top = [{"ay": a, "beklenen": round(sum(k["aylar"][i]["beklenen"] for k in out), 2),
               "odenen": round(sum(k["aylar"][i]["odenen"] for k in out), 2)} for i, a in enumerate(aylar)]
    return {"yil": yil, "bugun": bugun.isoformat(), "baslangic": bas, "krediler": out, "ay_toplam": ay_top}


class KrediBody(BaseModel):
    ad: str
    tur: Optional[str] = None
    aylik_taksit: Decimal
    odeme_gunu: int
    ilk_ay: str
    taksit_sayisi: Optional[int] = None
    aktif: bool = True


def _dogrula(b: KrediBody):
    if not b.ad.strip():
        raise HTTPException(400, "Kredinin adını yaz")
    if not 1 <= int(b.odeme_gunu) <= 31:
        raise HTTPException(400, "Ödeme günü 1–31")
    try:
        date.fromisoformat(b.ilk_ay[:7] + "-01")
    except ValueError:
        raise HTTPException(400, "İlk taksit ayı YYYY-AA")
    if b.taksit_sayisi is not None and not 1 <= b.taksit_sayisi <= 600:
        raise HTTPException(400, "Taksit sayısı 1–600")
    t = _kurus(b.aylik_taksit)
    if t <= 0:
        raise HTTPException(400, "Aylık taksit gir")
    return t


@router.post("")
def kredi_ekle(b: KrediBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    t = _dogrula(b)
    with db() as (conn, cur):
        kid = str(uuid.uuid4())
        cur.execute("""INSERT INTO ey_kredi (id, ad, tur, aylik_taksit, odeme_gunu, ilk_ay, taksit_sayisi, aktif, kim)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (kid, b.ad.strip()[:120], b.tur, t, int(b.odeme_gunu), b.ilk_ay[:7], b.taksit_sayisi, b.aktif, _aktor(cur, x_evvel_oturum)))
    return {"ok": True, "id": kid, "mesaj": "Kredi eklendi"}


@router.post("/{kid}")
def kredi_duzelt(kid: str, b: KrediBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    t = _dogrula(b)
    with db() as (conn, cur):
        cur.execute("""UPDATE ey_kredi SET ad=%s, tur=%s, aylik_taksit=%s, odeme_gunu=%s, ilk_ay=%s, taksit_sayisi=%s, aktif=%s, kim=%s
                       WHERE id=%s""", (b.ad.strip()[:120], b.tur, t, int(b.odeme_gunu), b.ilk_ay[:7], b.taksit_sayisi, b.aktif,
                                        _aktor(cur, x_evvel_oturum), kid))
        if not cur.rowcount:
            raise HTTPException(404, "Kredi bulunamadı")
    return {"ok": True, "mesaj": "Kredi güncellendi" if b.aktif else "Kredi kapatıldı (takvimden kalktı)"}
