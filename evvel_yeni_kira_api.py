"""🏠 EVVEL YENİ · KİRALAR (2026-10-16).

Sahip: "Sistemden kiraları al; şube eklendiğinde kira ekleme alanı da kur; ödemelerde sadece kira seçilince
otomatik gelsin; ay ay ödenen kiraların listesi yıllıkta ay ay tutulsun — takvim mantığı!" ·
"Kira artış periyotları takvimde ayı farklı renk olsun."

  · ey_sube_kira: şube × "hangi aydan geçerli" × aylık tutar (artış = yeni satır; eski aylar bozulmaz).
  · ey_sube.kira_artis_ayi (1–12) · ey_sube.kira_odeme_gunu (1–31).
  · İlk tanım eski sistemin sabit giderlerinden (kategori Kira, AKTİF satır) — yalnız boş şubelere.
  · Ödenen: Evvel Yeni ödeme formu (konu=kira, ait_ay) + eski sistemde ödenmiş kira planları (Ekim öncesi).
"""

from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_kasa_api import kasa_hazirla as _hazirla, kasa_kayitlari as _yukle
from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun, kurus as _kurus, tl_sayi as _tl_sayi

router = APIRouter(prefix="/api/evvel-yeni/kira", tags=["evvel-yeni-kira"])
_HAZIR = False


def kira_hazirla(cur) -> None:
    global _HAZIR
    if _HAZIR:
        return
    from evvel_yeni_tanim_api import tanim_hazirla
    tanim_hazirla(cur)
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_sube_kira (
        sube_id TEXT NOT NULL, gecerli_ay TEXT NOT NULL, tutar BIGINT NOT NULL,
        degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (sube_id, gecerli_ay))""")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS kira_artis_ayi INT")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS kira_odeme_gunu INT")
    cur.execute("ALTER TABLE ey_sube ADD COLUMN IF NOT EXISTS kira_yok BOOLEAN NOT NULL DEFAULT FALSE")   # mülk bizim
    try:
        with savepoint(cur, "sp_ey_kira_es"):
            cur.execute("""SELECT sube_id::text AS sid, tutar, odeme_gunu, baslangic_tarihi FROM sabit_giderler
                            WHERE aktif AND sube_id IS NOT NULL AND (kategori ILIKE '%%kira%%' OR gider_adi ILIKE '%%kira%%')""")
            for r in cur.fetchall() or []:
                r = dict(r)
                cur.execute("SELECT 1 FROM ey_sube_kira WHERE sube_id=%s", (r["sid"],))
                if cur.fetchone():
                    continue
                ay = (r["baslangic_tarihi"] or date(2026, 1, 1)).strftime("%Y-%m")
                cur.execute("INSERT INTO ey_sube_kira (sube_id, gecerli_ay, tutar, degistiren) VALUES (%s,%s,%s,'eski sistem kopyası') ON CONFLICT DO NOTHING",
                            (r["sid"], ay, _kurus(r["tutar"])))
                cur.execute("UPDATE ey_sube SET kira_odeme_gunu = COALESCE(kira_odeme_gunu, %s) WHERE id=%s", (r["odeme_gunu"], r["sid"]))
    except Exception:  # noqa: BLE001
        pass
    _HAZIR = True


def kira_tutari(cur, sube_id: str, ay: str) -> Optional[int]:
    """O ay geçerli aylık kira (kuruş) — o aya kadar girilmiş EN SON tanım."""
    kira_hazirla(cur)
    cur.execute("SELECT tutar FROM ey_sube_kira WHERE sube_id=%s AND gecerli_ay <= %s ORDER BY gecerli_ay DESC LIMIT 1", (sube_id, ay[:7]))
    r = cur.fetchone()
    return int(dict(r)["tutar"]) if r else None


def kira_tanimlari(cur) -> dict:
    """{sube_id: {"kira": tl (bugün geçerli), "artis_ayi", "odeme_gunu", "gecmis": [...]}} — Tanımlar listesi için."""
    kira_hazirla(cur)
    ay = _bugun().strftime("%Y-%m")
    cur.execute("SELECT id, kira_artis_ayi, kira_odeme_gunu, kira_yok FROM ey_sube")
    out = {dict(r)["id"]: {"artis_ayi": dict(r)["kira_artis_ayi"], "odeme_gunu": dict(r)["kira_odeme_gunu"], "kira": None, "gecmis": [],
                           "kira_yok": bool(dict(r)["kira_yok"])}
           for r in cur.fetchall() or []}
    cur.execute("SELECT sube_id, gecerli_ay, tutar FROM ey_sube_kira ORDER BY gecerli_ay")
    for r in cur.fetchall() or []:
        r = dict(r)
        o = out.setdefault(r["sube_id"], {"artis_ayi": None, "odeme_gunu": None, "kira": None, "gecmis": [], "kira_yok": False})
        o["gecmis"].append({"ay": r["gecerli_ay"], "tutar": _tl_sayi(int(r["tutar"]))})
        if r["gecerli_ay"] <= ay:
            o["kira"] = _tl_sayi(int(r["tutar"]))
    return out


def kira_yaz(cur, sube_id: str, kim: str, tutar=None, gecerli_ay=None, artis_ayi=None, odeme_gunu=None, kira_yok=None) -> None:
    kira_hazirla(cur)
    if kira_yok is not None:
        cur.execute("UPDATE ey_sube SET kira_yok=%s WHERE id=%s", (bool(kira_yok), sube_id))
    for g, ad in ((artis_ayi, "Artış ayı 1–12"), (odeme_gunu, "Kira ödeme günü 1–31")):
        if g is not None and not 1 <= int(g) <= (12 if ad.startswith("Artış") else 31):
            raise HTTPException(400, f"{ad} olmalı")
    if tutar is not None:
        ay = (gecerli_ay or _bugun().strftime("%Y-%m"))[:7]
        try:
            date.fromisoformat(ay + "-01")
        except ValueError:
            raise HTTPException(400, "Kira hangi aydan geçerli: YYYY-AA")
        cur.execute("""INSERT INTO ey_sube_kira (sube_id, gecerli_ay, tutar, degistiren) VALUES (%s,%s,%s,%s)
                       ON CONFLICT (sube_id, gecerli_ay) DO UPDATE SET tutar=EXCLUDED.tutar, degistiren=EXCLUDED.degistiren, zaman=NOW()""",
                    (sube_id, ay, _kurus(tutar), kim))
    if artis_ayi is not None or odeme_gunu is not None:
        cur.execute("UPDATE ey_sube SET kira_artis_ayi=COALESCE(%s,kira_artis_ayi), kira_odeme_gunu=COALESCE(%s,kira_odeme_gunu) WHERE id=%s",
                    (artis_ayi, odeme_gunu, sube_id))


def _eski_odenenler(cur) -> dict:
    """Eski sistemde ödenmiş kiralar: {(sube_id, 'YYYY-MM'): kuruş}. Plan + elden (çift sayım elenir)."""
    out = {}
    try:
        with savepoint(cur, "sp_ey_kira_eski"):
            cur.execute("""
                SELECT sg.sube_id::text AS sid, TO_CHAR(COALESCE(op.referans_ay, op.tarih), 'YYYY-MM') AS ay,
                       SUM(COALESCE(op.odenen_tutar, op.odenecek_tutar)) AS t
                  FROM odeme_plani op JOIN sabit_giderler sg ON sg.id = op.kaynak_id
                 WHERE op.durum='odendi' AND op.kaynak_tablo='sabit_giderler'
                   AND (sg.kategori ILIKE '%%kira%%' OR sg.gider_adi ILIKE '%%kira%%') AND sg.sube_id IS NOT NULL
                 GROUP BY 1, 2
                UNION ALL
                SELECT sg.sube_id::text, TO_CHAR(kh.tarih, 'YYYY-MM'), SUM(ABS(kh.tutar))
                  FROM kasa_hareketleri kh JOIN sabit_giderler sg ON sg.id = kh.kaynak_id
                 WHERE kh.islem_turu='SABIT_GIDER' AND kh.kasa_etkisi = true AND kh.durum='aktif' AND kh.kaynak_tablo='sabit_giderler'
                   AND (sg.kategori ILIKE '%%kira%%' OR sg.gider_adi ILIKE '%%kira%%') AND sg.sube_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM odeme_plani op2 WHERE op2.kaynak_tablo='sabit_giderler' AND op2.kaynak_id=kh.kaynak_id
                                     AND op2.durum='odendi' AND op2.referans_ay = DATE_TRUNC('month', kh.tarih))
                 GROUP BY 1, 2""")
            for r in cur.fetchall() or []:
                r = dict(r)
                k = (r["sid"], r["ay"])
                out[k] = out.get(k, 0) + _kurus(r["t"] or 0)
    except Exception:  # noqa: BLE001
        pass
    return out


@router.get("/tutar")
def kira_tutar(sube_id: str, ay: str):
    """Ödeme formu: kira + şube + ait ay seçilince o ayın kirası ve ne kadarı ödendi."""
    _hazirla()
    with db() as (conn, cur):
        t = kira_tutari(cur, sube_id, ay)
        _, _, kayit, _ = _yukle(cur, tum_donemler=True)
        eski = _eski_odenenler(cur).get((sube_id, ay[:7]), 0)
    yeni = sum(int(h["veri"].get("toplam", h["tutar"])) for h in kayit if h["tur"] == "odeme"
               and (h["veri"].get("konu") or {}).get("tip") == "kira" and (h["veri"].get("konu") or {}).get("sube_id") == sube_id
               and (h["veri"].get("ait_ay") or "")[:7] == ay[:7])
    from evvel_yeni_kopru import gecis_odenen
    odenen, iki_yerde = gecis_odenen(yeni, eski)   # C-T1-08: toplanmaz — Kart/Kredi ile aynı kural
    return {"sube_id": sube_id, "ay": ay[:7], "kira": _tl_sayi(t) if t is not None else None, "odenen": _tl_sayi(odenen), "iki_yerde": iki_yerde,
            "kalan": _tl_sayi(max(0, t - odenen)) if t is not None else None, "tanimli": t is not None}


@router.get("/takvim")
def kira_takvimi(yil: Optional[int] = None):
    """Şube × 12 ay: beklenen kira, ödenen, durum; artış ayı ve gerçekleşen artış işaretli."""
    _hazirla()
    bugun = _bugun()
    yil = yil or bugun.year
    with db() as (conn, cur):
        out = kira_aylari(cur, yil, bugun)
    return {"yil": yil, "bugun": bugun.isoformat(), "subeler": out}


def kira_aylari(cur, yil: int, bugun: date) -> list:
    """Şube × 12 ay kira durumu (takvim ekranı + Kasa'nın 'yaklaşan ödemeler' kutusu aynı hesabı kullanır)."""
    kira_hazirla(cur)
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    subeler = _ey_subeler(cur)
    tan = kira_tanimlari(cur)
    _, _, kayit, _ = _yukle(cur, tum_donemler=True)
    eski = _eski_odenenler(cur)
    import evvel_yeni_kasa_api as _kasa
    bas_ay = _kasa.donem_baslangici(cur).strftime("%Y-%m")   # sahip: "geçmiş aylar ödenmişti" — Evvel Yeni öncesi 'gecikti' DENMEZ
    yeni = {}
    for h in kayit:
        if h["tur"] != "odeme":
            continue
        v = h["veri"]
        k = v.get("konu") or {}
        if k.get("tip") != "kira" or not k.get("sube_id"):
            continue
        key = (k["sube_id"], (v.get("ait_ay") or h["is_gunu"])[:7])
        yeni.setdefault(key, []).append({"id": h["id"], "tarih": h["is_gunu"], "tutar": _tl_sayi(int(v.get("toplam", h["tutar"]))),
                                         "kr": int(v.get("toplam", h["tutar"])),
                                         "aciklama": v.get("aciklama")})
    out = []
    for s in subeler:
        sid = s["id"]
        t = tan.get(sid) or {"gecmis": [], "artis_ayi": None, "odeme_gunu": None, "kira": None, "kira_yok": False}
        aylar = []
        onceki = None
        for m in range(1, 13):
            ay = f"{yil}-{m:02d}"
            gec = [g for g in t["gecmis"] if g["ay"] <= ay]
            bek = gec[-1]["tutar"] if gec else None
            yn = yeni.get((sid, ay), [])
            from evvel_yeni_kopru import gecis_odenen
            od_k, iki_yerde = gecis_odenen(sum(x["kr"] for x in yn), eski.get((sid, ay), 0))   # C-T1-08: toplanmaz
            od = _tl_sayi(od_k)
            vade_gunu = min(t["odeme_gunu"] or 1, 28)
            vade = date(yil, m, vade_gunu)
            if t.get("kira_yok"):
                bek, durum = None, "mulk"
            elif bek is None:
                durum = "tanimsiz" if od == 0 else "odendi"
            elif od >= bek - 1:
                durum = "odendi"
            elif od > 0:
                durum = "kismi"
            elif ay < bas_ay:
                durum = "once"          # Evvel Yeni öncesi, eski sistemde kaydı eksik — borç sayılmaz
            elif vade < bugun:
                durum = "gecikti"
            elif (vade - bugun).days <= 7:
                durum = "yaklasiyor"
            else:
                durum = "gelecek"
            aylar.append({"ay": ay, "beklenen": bek, "odenen": od, "kalan": round(max(0, (bek or 0) - od), 2), "durum": durum, "iki_yerde": iki_yerde,
                          "artis_ayi": t["artis_ayi"] == m, "artis": bool(onceki is not None and bek is not None and bek != onceki),
                          "onceki_tutar": onceki if (onceki is not None and bek is not None and bek != onceki) else None,
                          "yeni_kayitlar": yn, "eski_sistem": _tl_sayi(eski.get((sid, ay), 0)), "vade": vade.isoformat()})
            onceki = bek if bek is not None else onceki
        out.append({"sube_id": sid, "ad": s["ad"], "kira": t["kira"], "artis_ayi": t["artis_ayi"], "odeme_gunu": t["odeme_gunu"],
                    "kira_yok": bool(t.get("kira_yok")),
                    "aylar": aylar, "yil_beklenen": round(sum(a["beklenen"] or 0 for a in aylar), 2),
                    "yil_odenen": round(sum(a["odenen"] for a in aylar), 2)})
    return out


class KiraBody(BaseModel):
    tutar: Optional[Decimal] = None
    gecerli_ay: Optional[str] = None
    artis_ayi: Optional[int] = None
    odeme_gunu: Optional[int] = None


@router.post("/{sube_id}")
def kira_tanimla(sube_id: str, body: KiraBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        kira_hazirla(cur)
        cur.execute("SELECT 1 FROM ey_sube WHERE id=%s", (sube_id,))
        if not cur.fetchone():
            raise HTTPException(404, "Şube bulunamadı")
        kira_yaz(cur, sube_id, _aktor(cur, x_evvel_oturum), body.tutar, body.gecerli_ay, body.artis_ayi, body.odeme_gunu)
    return {"ok": True, "mesaj": "Kira kaydedildi"}



def kira_tahakkuk(cur, ay: str) -> dict:
    """GİDER için: {sube_id: kuruş | None (tanımsız) | 'yok' (mülk bizim)} — o ayın tanımlı kirası."""
    kira_hazirla(cur)
    cur.execute("SELECT id, kira_yok FROM ey_sube")
    out = {}
    for r in cur.fetchall() or []:
        r = dict(r)
        out[r["id"]] = "yok" if r["kira_yok"] else kira_tutari(cur, r["id"], ay)
    return out
