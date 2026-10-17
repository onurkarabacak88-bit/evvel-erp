"""🧾 EVVEL YENİ · ANLIK GİDER FİŞ KONTROLÜ (2026-10-17) — tak-çıkar modül (sayfası Gider altında).

Sahip: "Fiş kontrol olsun; fiş olmazsa personelle beraber girişi yapan yazsın; ayrı bir sekmede bulunsun. Hem yeniye hem
eskiye yazsın, eski kalkınca kargaşa kalmasın. PANELDEN girişlerde fiş kontrol olması yeterli; BİZİM girişlerimizde gerek yok."
  · Liste = Kasa'nın PUBLIC `dukkan_giderleri` servisi (yalnız şube panelinden gelen dükkân giderleri; avans hariç).
    Merkezin Ödeme formundan girdikleri bu listeye hiç girmez.
  · Durum: bekliyor · geldi · gelmedi · muaf. Kayıt Evvel Yeni'nin KENDİ tablosunda (ey_fis_kontrol) + eski anlik_giderler'e
    aynı işaret (eski ekranlar da görsün). Eski sistem kalkınca yalnız EY tablosu kalır — hiçbir şey bozulmaz.
  · Fiş "gelmedi" → satır girişi yapan personelin adıyla görünür; sayfada personel başına özet.
  · İş yükü yok: Bekleyen işler'e düşmez, onay istemez; yalnız bu sekmede durur.
KÖPRÜ (eski sistem kalkınca SİL — KESIM_LISTESI): `_eski_bilgi` eski satırların personel adını ve eski fiş işaretini okur;
`_eskiye_yaz` eski tabloya işaret basar. İkisi de savepoint'li ve hatada sessizce atlanır.
"""

import logging
from datetime import date, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun

router = APIRouter(prefix="/api/evvel-yeni/fis", tags=["evvel-yeni-fis"])
log = logging.getLogger(__name__)
DURUMLAR = ("geldi", "gelmedi", "muaf")
_HAZIR = False


def _hazirla():
    global _HAZIR
    if _HAZIR:
        return
    with db() as (conn, cur):
        cur.execute("""CREATE TABLE IF NOT EXISTS ey_fis_kontrol (
            ref TEXT PRIMARY KEY, durum TEXT NOT NULL, notu TEXT, kim TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            giren TEXT, sube TEXT, tarih DATE, tutar NUMERIC(14,2), aciklama TEXT)""")
    _HAZIR = True


def _eski_bilgi(cur, refler: List[str]) -> Dict[str, dict]:
    """KÖPRÜ: eski anlik_giderler'den personel adı + eski fiş işareti (panelin 'fiş gönderildi' bilgisi dahil)."""
    idler = [r.split(":", 1)[1] for r in refler if r and r.startswith("anlik_gider:")]
    if not idler:
        return {}
    try:
        with savepoint(cur, "sp_ey_fis_eski"):
            cur.execute("""SELECT g.id::text AS id, COALESCE(p.ad_soyad, u.ad) AS giren,
                                  COALESCE(g.fis_gonderildi, FALSE) AS gonderildi,
                                  NULLIF(TRIM(g.fis_kontrol_durumu), '') AS durum, g.fis_kontrol_notu AS notu
                             FROM anlik_giderler g
                             LEFT JOIN personel p ON p.id::text = g.personel_id::text
                             LEFT JOIN sube_panel_kullanici u ON u.id::text = g.personel_id::text
                            WHERE g.id::text = ANY(%s)""", (idler,))
            return {"anlik_gider:" + dict(x)["id"]: dict(x) for x in cur.fetchall() or []}
    except Exception as e:  # noqa: BLE001
        log.info("fiş kontrol: eski bilgi okunamadı (eski sistem kalkmış olabilir): %s", str(e)[:120])
        return {}


def _eskiye_yaz(cur, ref: str, durum: str, notu: Optional[str]) -> bool:
    """KÖPRÜ: aynı işareti eski tabloya da bas (eski ekranlar aynı şeyi görsün)."""
    if not ref.startswith("anlik_gider:"):
        return False
    try:
        with savepoint(cur, "sp_ey_fis_eskiye"):
            cur.execute("""UPDATE anlik_giderler SET fis_kontrol_durumu=%s, fis_kontrol_tarihi=NOW(), fis_kontrol_notu=%s
                            WHERE id::text=%s""", (durum, notu, ref.split(":", 1)[1]))
            return cur.rowcount > 0
    except Exception as e:  # noqa: BLE001
        log.info("fiş kontrol: eskiye yazılamadı: %s", str(e)[:120])
        return False


@router.get("/liste")
def liste(gun: int = 45, durum: str = "bekliyor"):
    """Panelden girilen dükkân giderleri + fiş durumu. durum: bekliyor | gelmedi | hepsi."""
    _hazirla()
    import evvel_yeni_kasa_api as kasa
    bas = (_bugun() - timedelta(days=max(1, min(int(gun or 45), 400)))).isoformat()
    with db() as (conn, cur):
        satirlar = kasa.dukkan_giderleri(cur, bas)
        refler = [x["ref"] for x in satirlar if x.get("ref")]
        cur.execute("SELECT ref, durum, notu, kim, zaman FROM ey_fis_kontrol WHERE ref = ANY(%s)", (refler,))
        ey = {dict(r)["ref"]: dict(r) for r in cur.fetchall() or []}
        eski = _eski_bilgi(cur, refler)
    out = []
    for x in satirlar:
        if not x.get("ref"):
            continue
        e, o = ey.get(x["ref"]), eski.get(x["ref"]) or {}
        d = (e or {}).get("durum") or (o.get("durum") if o.get("durum") in DURUMLAR else None) or "bekliyor"
        gec = (_bugun() - date.fromisoformat(x["tarih"])).days
        out.append({**x, "giren": x.get("giren") or o.get("giren") or "—", "durum": d,
                    "notu": (e or {}).get("notu") or o.get("notu"), "isaretleyen": (e or {}).get("kim"),
                    "panel_gonderildi": bool(o.get("gonderildi")), "gecikme_gun": gec})
    tum = out
    if durum in ("bekliyor", "gelmedi"):
        out = [x for x in out if x["durum"] == durum]
    out.sort(key=lambda x: (x["tarih"], x["sube"] or ""), reverse=(durum != "bekliyor"))
    # fişi gelmeyenler — girişi yapan personel başına
    kisi: Dict[str, dict] = {}
    for x in tum:
        if x["durum"] == "gelmedi":
            k = kisi.setdefault(x["giren"], {"giren": x["giren"], "adet": 0, "tutar": 0.0})
            k["adet"] += 1
            k["tutar"] = round(k["tutar"] + x["tutar"], 2)
    return {"satirlar": out, "bekliyor": sum(1 for x in tum if x["durum"] == "bekliyor"),
            "gelmedi": sum(1 for x in tum if x["durum"] == "gelmedi"),
            "kisi_ozet": sorted(kisi.values(), key=lambda k: -k["tutar"]), "gun": gun}


class IsaretBody(BaseModel):
    ref: str
    durum: str
    notu: Optional[str] = None


@router.post("/isaretle")
def isaretle(body: IsaretBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Fiş geldi / gelmedi / muaf — Evvel Yeni'ye + (köprü) eski sisteme. Geri almak için durum 'bekliyor'."""
    _hazirla()
    if body.durum not in DURUMLAR + ("bekliyor",):
        raise HTTPException(400, "Durum: geldi / gelmedi / muaf")
    import evvel_yeni_kasa_api as kasa
    notu = (body.notu or "").strip()[:300] or None
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        x = next((s for s in kasa.dukkan_giderleri(cur, "2000-01-01") if s.get("ref") == body.ref), None)
        if not x:
            raise HTTPException(404, "Gider bulunamadı")
        if body.durum == "bekliyor":
            cur.execute("DELETE FROM ey_fis_kontrol WHERE ref=%s", (body.ref,))
            _eskiye_yaz(cur, body.ref, None, None)
        else:
            giren = x.get("giren") or (_eski_bilgi(cur, [body.ref]).get(body.ref) or {}).get("giren")
            cur.execute("""INSERT INTO ey_fis_kontrol (ref, durum, notu, kim, giren, sube, tarih, tutar, aciklama)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (ref) DO UPDATE SET durum=EXCLUDED.durum, notu=EXCLUDED.notu, kim=EXCLUDED.kim, zaman=NOW(),
                                                           giren=COALESCE(EXCLUDED.giren, ey_fis_kontrol.giren)""",
                        (body.ref, body.durum, notu, kim, giren, x.get("sube"), x["tarih"], x["tutar"], (x.get("aciklama") or "")[:200]))
            _eskiye_yaz(cur, body.ref, body.durum, notu)
    return {"ok": True, "mesaj": {"geldi": "Fiş geldi", "gelmedi": "Fiş gelmedi — girişi yapan adıyla kaydedildi",
                                  "muaf": "Fiş gerekmez", "bekliyor": "Geri alındı"}[body.durum]}
