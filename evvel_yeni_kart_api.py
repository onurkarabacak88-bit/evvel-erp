"""💳 EVVEL YENİ · KARTLAR (2026-10-16).

Sahip: "kartları kur ama evvelde sürekli hesaplama yapma vs için çok çabalıyordu; ödeme alanından kartların
limitlerinde hareketi arttırması yeterli — daha basit bir mantıkta kursak daha başarılı olacaktır."

SADE MODEL — tek rakam: KULLANILABİLİR LİMİT (bankanın uygulamasında yazan rakam).
  · Çıpa (teyit): bir tarihte bankada yazan kullanılabilir limit. İlk çıpa eski sistemin son ekstre kaydı.
  · Sonrası: Ödeme formunda KARTLA ödenen her parça kullanılabiliri AZALTIR; "Kart borcu" ödemesi ARTIRIR.
  · Teyit: bankadaki rakam girilir → yeni çıpa; sistemin beklediğiyle FARK gösterilir (girilmemiş harcama/ödeme).
  · Son ödeme: kartın son ödeme günü + teyitte girilen ekstre borcu − o tarihten sonra ödenen = KALAN.
  Taksit / faiz / asgari / satır eşleştirme YOK (bilinçli).
"""

import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_kasa_api import _hazirla, _yukle
from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun, kurus as _kurus, tl_sayi as _tl_sayi, bekleyen_is_kaydet

router = APIRouter(prefix="/api/evvel-yeni/kart", tags=["evvel-yeni-kart"])

_HAZIR = False


def kart_hazirla(cur) -> None:
    """Kart alanları + teyit defteri; ilk çıpa eski sistemin son ekstre kaydından (yalnız BOŞ olanlara)."""
    global _HAZIR
    if _HAZIR:
        return
    from evvel_yeni_tanim_api import tanim_hazirla
    tanim_hazirla(cur)
    for x in ("limit_tutar BIGINT", "kesim_gunu INT", "son_odeme_gunu INT", "limit_grup TEXT"):
        cur.execute(f"ALTER TABLE ey_kart ADD COLUMN IF NOT EXISTS {x}")
    cur.execute("""CREATE TABLE IF NOT EXISTS ey_kart_teyit (
        id TEXT PRIMARY KEY, kart_id TEXT NOT NULL, tarih DATE NOT NULL,
        kullanilabilir BIGINT NOT NULL, ekstre_borc BIGINT, son_odeme DATE,
        sistem_beklenen BIGINT, kaynak TEXT NOT NULL DEFAULT 'elle', not_ TEXT,
        girilen TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    try:
        with savepoint(cur, "sp_ey_kart_es"):
            cur.execute("""UPDATE ey_kart e SET limit_tutar = COALESCE(e.limit_tutar, ROUND(k.limit_tutar*100)::bigint),
                                  kesim_gunu = COALESCE(e.kesim_gunu, k.kesim_gunu), son_odeme_gunu = COALESCE(e.son_odeme_gunu, k.son_odeme_gunu),
                                  limit_grup = COALESCE(e.limit_grup, k.ortak_limit_grup)
                             FROM kartlar k WHERE k.id::text = e.id""")
    except Exception:  # noqa: BLE001
        pass
    try:
        with savepoint(cur, "sp_ey_kart_cipa"):
            cur.execute("""SELECT e.id, e.limit_tutar, d.kesim_tarihi, d.son_odeme_tarihi, d.donem_borcu, d.kullanilabilir_limit
                             FROM ey_kart e
                             JOIN LATERAL (SELECT * FROM kart_ekstre_donem x WHERE x.kart_id = e.id
                                            ORDER BY x.donem DESC, x.olusturma DESC LIMIT 1) d ON TRUE
                            WHERE NOT EXISTS (SELECT 1 FROM ey_kart_teyit t WHERE t.kart_id = e.id)""")
            for r in cur.fetchall() or []:
                r = dict(r)
                borc = _kurus(r["donem_borcu"] or 0)
                if r["kullanilabilir_limit"] is not None:
                    kul, not_ = _kurus(r["kullanilabilir_limit"]), "tahmini başlangıç (eski sistemin son ekstresi) — bankadaki rakamı gir"
                elif r["limit_tutar"]:
                    kul, not_ = int(r["limit_tutar"]) - borc, "eski sistem · TAHMİNİ (limit − ekstre borcu) — bankadan teyit et"
                else:
                    continue
                cur.execute("""INSERT INTO ey_kart_teyit (id, kart_id, tarih, kullanilabilir, ekstre_borc, son_odeme, kaynak, not_, girilen)
                               VALUES (%s,%s,%s,%s,%s,%s,'eski_sistem',%s,'eski sistem kopyası')""",
                            ("kt-" + uuid.uuid4().hex[:12], r["id"], r["kesim_tarihi"] or _bugun(), kul, borc or None,
                             r["son_odeme_tarihi"], not_))
    except Exception:  # noqa: BLE001
        pass
    _HAZIR = True


def _hareketler(kayit) -> dict:
    """Ödeme formundan kart hareketleri: {kart_id: [(gun, kurus_etki, aciklama)]} — harcama eksi, borç ödemesi artı."""
    out = {}
    for h in kayit:
        if h["tur"] != "odeme":
            continue
        v = h["veri"]
        for p in v.get("kart_parcalar") or []:
            out.setdefault(str(p["kart_id"]), []).append({"gun": h["is_gunu"], "tutar": -int(p["tutar"]), "tur": "harcama",
                                                          "aciklama": v.get("aciklama"), "id": h["id"]})
        k = v.get("konu") or {}
        if k.get("kart_id"):
            tut = sum(int(p["tutar"]) for p in v.get("parcalar") or [])
            out.setdefault(str(k["kart_id"]), []).append({"gun": h["is_gunu"], "tutar": tut, "tur": "borc_odeme",
                                                          "aciklama": v.get("aciklama"), "id": h["id"]})
    return out


def _sonraki_son_odeme(kesim_gunu, son_odeme_gunu, bugun: date) -> Optional[date]:
    if not son_odeme_gunu:
        return None
    def gun_yap(y, m, d):
        son = ((date(y, m, 28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)).day
        return date(y, m, min(d, son))
    aday = gun_yap(bugun.year, bugun.month, son_odeme_gunu)
    if aday < bugun:
        y, m = (bugun.year + (bugun.month == 12), bugun.month % 12 + 1)
        aday = gun_yap(y, m, son_odeme_gunu)
    return aday


def kart_durumu(cur, bugun: Optional[date] = None, kayit=None) -> list:
    """Her kart: çıpa + sonraki hareketler → şimdiki kullanılabilir; son ödeme ve kalan."""
    kart_hazirla(cur)
    bugun = bugun or _bugun()
    cur.execute("SELECT * FROM ey_kart WHERE aktif ORDER BY limit_grup NULLS LAST, ad")
    kartlar = [dict(r) for r in cur.fetchall() or []]
    cur.execute("SELECT * FROM ey_kart_teyit ORDER BY tarih DESC, zaman DESC")
    teyitler = {}
    for r in cur.fetchall() or []:
        teyitler.setdefault(dict(r)["kart_id"], []).append(dict(r))
    if kayit is None:
        _, _, kayit, _ = _yukle(cur, tum_donemler=True)
    H = _hareketler(kayit)
    out = []
    for k in kartlar:
        ty = teyitler.get(k["id"], [])
        cipa = ty[0] if ty else None
        hs = sorted(H.get(k["id"], []), key=lambda x: x["gun"])
        sonra = [x for x in hs if cipa and x["gun"] > cipa["tarih"].isoformat()]
        kul = (int(cipa["kullanilabilir"]) + sum(x["tutar"] for x in sonra)) if cipa else None
        limit = int(k["limit_tutar"]) if k.get("limit_tutar") else None
        # son ödeme: çıpanın ekstre borcu − çıpadan sonra yapılan borç ödemeleri
        ekstre_cipa = next((t for t in ty if t.get("ekstre_borc")), None)
        so = None
        if ekstre_cipa:
            odenen = sum(x["tutar"] for x in hs if x["tur"] == "borc_odeme" and x["gun"] > ekstre_cipa["tarih"].isoformat())
            son_tarih = ekstre_cipa.get("son_odeme")
            kaydi = False
            if son_tarih and son_tarih < bugun:
                son_tarih = None   # o ekstrenin son günü geçti — sıradaki son ödeme günü
                kaydi = True
            son_tarih = son_tarih or _sonraki_son_odeme(k.get("kesim_gunu"), k.get("son_odeme_gunu"), bugun)
            kalan = max(0, int(ekstre_cipa["ekstre_borc"]) - odenen)
            so = {"tarih": son_tarih.isoformat() if son_tarih else None, "gun_kaldi": (son_tarih - bugun).days if son_tarih else None,
                  "ekstre": _tl_sayi(int(ekstre_cipa["ekstre_borc"])), "odenen": _tl_sayi(odenen), "kalan": _tl_sayi(kalan),
                  "ekstre_tarihi": ekstre_cipa["tarih"].isoformat(), "eski": ekstre_cipa["kaynak"] == "eski_sistem",
                  # Fable: son günü geçen ekstrenin kalanı sıradaki aya taşınıyordu → yeni ekstre girilene kadar "teyit gerekli"
                  "teyit_gerekli": kaydi}
            if kaydi:
                so["kalan"] = None
        else:
            st = _sonraki_son_odeme(k.get("kesim_gunu"), k.get("son_odeme_gunu"), bugun)
            if st:
                so = {"tarih": st.isoformat(), "gun_kaldi": (st - bugun).days, "ekstre": None, "odenen": None, "kalan": None, "ekstre_tarihi": None}
        out.append({
            "id": k["id"], "ad": k["ad"], "banka": k.get("banka"), "kimin": k.get("kimin"), "limit_grup": k.get("limit_grup"),
            "limit": _tl_sayi(limit) if limit else None, "kesim_gunu": k.get("kesim_gunu"), "son_odeme_gunu": k.get("son_odeme_gunu"),
            "kullanilabilir": _tl_sayi(kul) if kul is not None else None,
            "kullanilan": _tl_sayi(limit - kul) if (limit and kul is not None) else None,
            "cipa": ({"tarih": cipa["tarih"].isoformat(), "kullanilabilir": _tl_sayi(int(cipa["kullanilabilir"])), "kaynak": cipa["kaynak"],
                      "not": cipa.get("not_"), "fark": (_tl_sayi(int(cipa["kullanilabilir"]) - int(cipa["sistem_beklenen"]))
                                                       if cipa.get("sistem_beklenen") is not None else None)} if cipa else None),
            "teyit_gun_once": (bugun - cipa["tarih"]).days if cipa else None,
            "hareketler": [{**x, "tutar": _tl_sayi(x["tutar"])} for x in reversed(sonra)][:40],
            "son_odeme": so,
            "teyitler": [{"id": t["id"], "tarih": t["tarih"].isoformat(), "kullanilabilir": _tl_sayi(int(t["kullanilabilir"])),
                          "ekstre_borc": _tl_sayi(int(t["ekstre_borc"])) if t.get("ekstre_borc") else None, "kaynak": t["kaynak"],
                          "fark": _tl_sayi(int(t["kullanilabilir"]) - int(t["sistem_beklenen"])) if t.get("sistem_beklenen") is not None else None,
                          "girilen": t.get("girilen")} for t in ty[:6]],
            "_cipa_tarih": cipa["tarih"].isoformat() if cipa else None, "_cipa_kul": int(cipa["kullanilabilir"]) if cipa else None,
            "_limit": limit,
        })
    # ORTAK LİMİT (ör. aynı bankanın iki kartı tek limiti paylaşır): grubun en yeni teyidi + TÜM grup kartlarının sonraki hareketleri
    gruplar = {}
    for k in out:
        if k["limit_grup"]:
            gruplar.setdefault(k["limit_grup"], []).append(k)
    for g, ks in gruplar.items():
        if len(ks) < 2:
            continue
        en = max((k for k in ks if k["_cipa_tarih"]), key=lambda k: k["_cipa_tarih"], default=None)
        lim = max((k["_limit"] or 0) for k in ks) or None
        kul = None
        if en:
            kul = en["_cipa_kul"] + sum(x["tutar"] for k in ks for x in H.get(k["id"], []) if x["gun"] > en["_cipa_tarih"])
        for k in ks:
            k["grup"] = {"ad": g, "kartlar": [x["ad"] for x in ks], "limit": _tl_sayi(lim) if lim else None,
                         "kullanilabilir": _tl_sayi(kul) if kul is not None else None,
                         "kullanilan": _tl_sayi(lim - kul) if (lim and kul is not None) else None, "teyit_karti": en["ad"] if en else None}
            k["kullanilabilir"], k["kullanilan"], k["limit"] = k["grup"]["kullanilabilir"], k["grup"]["kullanilan"], k["grup"]["limit"]
    return out


def kart_isleri(cur, kayit) -> list:
    """Bekleyen işler için: son ödemesi ≤7 gün kalan (ve kalanı olan) kartlar + 40 günü geçmiş teyit."""
    out = []
    for k in kart_durumu(cur, kayit=kayit):
        so = k["son_odeme"]
        if so and not so.get("eski") and so["gun_kaldi"] is not None and 0 <= so["gun_kaldi"] <= 7 and (so["kalan"] is None or so["kalan"] > 0):
            out.append({"tur": "kart_son_odeme", "id": f"kso:{k['id']}:{so['tarih']}", "tarih": so["tarih"], "ad": k["ad"],
                        "gun_kaldi": so["gun_kaldi"], "kalan": so["kalan"], "ekstre": so["ekstre"]})
    return out


def _son_gun(y: int, m: int, d: int) -> date:
    son = ((date(y, m, 28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)).day
    return date(y, m, min(int(d), son))


def _eski_plan(cur) -> dict:
    """KÖPRÜ (eski sistem kalkınca SİL — KESIM_LISTESI): eski odeme_plani kart satırları {(kart_id, 'YYYY-AA'): {ekstre, odenen}}.
    Geçiş süresince kart borcu hâlâ eski 'Öde' ile ödeniyor; yoksa takvim yanlış 'gecikti' der."""
    out = {}
    try:
        with savepoint(cur, "sp_ey_kart_eski_plan"):
            cur.execute("""SELECT kart_id::text AS kid, TO_CHAR(COALESCE(referans_ay, tarih), 'YYYY-MM') AS ay,
                                  MAX(odenecek_tutar) AS ekstre,   -- Fable: mükerrer plan satırları toplanmasın
                                  SUM(CASE WHEN durum='odendi' THEN COALESCE(odenen_tutar, odenecek_tutar)
                                           ELSE COALESCE(odenen_tutar, 0) END) AS odenen   -- Codex: kısmi (asgariye ulaşmayan) ödeme de sayılır
                             FROM odeme_plani WHERE kart_id IS NOT NULL AND COALESCE(durum,'') <> 'iptal' GROUP BY 1, 2""")
            for r in cur.fetchall() or []:
                r = dict(r)
                out[(r["kid"], r["ay"])] = {"ekstre": _kurus(round(float(r["ekstre"] or 0), 2)), "odenen": _kurus(round(float(r["odenen"] or 0), 2))}
    except Exception:  # noqa: BLE001
        pass
    return out


@router.get("/takvim")
def kart_takvimi(yil: Optional[int] = None):
    """💳 KART ÖDEME TAKVİMİ (sahip 2026-10-17: "kredi kartı ödemeleri için de kira takvimi gibi") — kart × 12 ay:
    son ödeme günü · ekstre (teyitten; yoksa eski planın tutarı 'eski') · ödenen (Ödeme → Kart borcu; geçişte eski 'Öde' de) · durum."""
    _hazirla()
    bugun = _bugun()
    yil = yil or bugun.year
    import evvel_yeni_kasa_api as kasa
    with db() as (conn, cur):
        kart_hazirla(cur)
        cur.execute("SELECT * FROM ey_kart WHERE aktif ORDER BY limit_grup NULLS LAST, ad")
        kartlar = [dict(r) for r in cur.fetchall() or []]
        # Codex: aynı aya birden çok teyit → EN SON girilen kazanır (sıralı okuma); teyitteki gerçek son ödeme tarihi korunur
        cur.execute("""SELECT kart_id, ekstre_borc, son_odeme FROM ey_kart_teyit
                        WHERE ekstre_borc IS NOT NULL AND son_odeme IS NOT NULL ORDER BY tarih, zaman""")
        teyit = {}
        for r in cur.fetchall() or []:
            r = dict(r)
            teyit[(r["kart_id"], r["son_odeme"].strftime("%Y-%m"))] = (int(r["ekstre_borc"]), r["son_odeme"])
        eski = _eski_plan(cur)
        bas = kasa.donem_baslangici(cur).strftime("%Y-%m")
        import evvel_yeni_odeme_api as odeme   # PUBLIC özet (Kasa'nın iç defterine dokunmadan)
        tum_od = odeme.konu_odemeleri(cur, "kart_borcu")
    out = []
    for k in kartlar:
        odemeler = sorted((x for x in tum_od if str(x.get("kart_id")) == str(k["id"])), key=lambda x: x["tarih"])
        aylar, onceki_son = [], None
        for m in range(1, 13):
            a = f"{yil}-{m:02d}"
            ty = teyit.get((k["id"], a))
            son = ty[1] if ty else (_son_gun(yil, m, k["son_odeme_gunu"]) if k.get("son_odeme_gunu") else None)
            # dönemi AÇIKÇA seçilmiş ödeme (takvimden 'öde') o aya; seçilmemişse (önceki son, bu son] aralığına
            od_yeni = sum(x["toplam"] for x in odemeler if x.get("donem") == a)
            if son:
                alt = onceki_son or (son - timedelta(days=31))
                od_yeni += sum(x["toplam"] for x in odemeler if not x.get("donem") and alt.isoformat() < x["tarih"] <= son.isoformat())
                onceki_son = son
            else:
                od_yeni += sum(x["toplam"] for x in odemeler if not x.get("donem") and x["tarih"][:7] == a)
            e = eski.get((k["id"], a)) or {}
            od_e = int(e.get("odenen") or 0)
            od = od_yeni if od_yeni > 0 else od_e      # iki sistemde de girilmişse TOPLANMAZ
            iki_yerde = od_yeni > 0 and od_e > 0
            ekstre, ekstre_kaynak = (ty[0] if ty else None), "teyit"
            if ekstre is None and e.get("ekstre"):
                ekstre, ekstre_kaynak = int(e["ekstre"]), "eski"
            if ekstre is None:
                ekstre_kaynak = None
            if ekstre is not None and od >= ekstre - 100:
                durum = "odendi"
            elif ekstre is None and od > 0:
                durum = "odeme_var"         # Codex: ekstre bilinmeden 'ödendi' DENMEZ
            elif od > 0:
                durum = "kismi"
            elif a < bas:
                durum = "once"
            elif son and son < bugun:
                durum = "gecikti"
            elif son and (son - bugun).days <= 7:
                durum = "yaklasiyor"
            else:
                durum = "gelecek"
            aylar.append({"ay": a, "son_odeme": son.isoformat() if son else None, "ekstre": _tl_sayi(ekstre) if ekstre is not None else None,
                          "ekstre_kaynak": ekstre_kaynak, "odenen": _tl_sayi(od),
                          "kalan": _tl_sayi(max(0, ekstre - od)) if ekstre is not None else None, "durum": durum, "iki_yerde": iki_yerde})
        out.append({"id": k["id"], "ad": k["ad"], "kimin": k.get("kimin"), "son_odeme_gunu": k.get("son_odeme_gunu"), "aylar": aylar,
                    "yil_odenen": round(sum(x["odenen"] for x in aylar), 2)})
    return {"yil": yil, "bugun": bugun.isoformat(), "baslangic": bas, "kartlar": out}


@router.get("/ozet")
def kart_ozet():
    _hazirla()
    with db() as (conn, cur):
        kartlar = kart_durumu(cur)
    bugun = _bugun()
    for k in kartlar:
        for x in ("_cipa_tarih", "_cipa_kul", "_limit"):
            k.pop(x, None)
    goruldu, tekil = set(), []
    for k in kartlar:   # ortak limitli grup toplamda BİR kez
        anahtar = ("g", k["grup"]["ad"]) if k.get("grup") else ("k", k["id"])
        if anahtar not in goruldu:
            goruldu.add(anahtar)
            tekil.append(k)
    yaklasan = [k for k in kartlar if k["son_odeme"] and not k["son_odeme"].get("eski") and k["son_odeme"]["gun_kaldi"] is not None and 0 <= k["son_odeme"]["gun_kaldi"] <= 7
                and (k["son_odeme"]["kalan"] is None or k["son_odeme"]["kalan"] > 0)]
    return {"bugun": bugun.isoformat(), "kartlar": kartlar,
            "toplam": {"limit": round(sum(k["limit"] or 0 for k in tekil), 2),
                       "kullanilabilir": round(sum(k["kullanilabilir"] or 0 for k in tekil), 2),
                       "son_odeme_kalan": round(sum((k["son_odeme"] or {}).get("kalan") or 0 for k in yaklasan), 2)},
            "yaklasan": [{"id": k["id"], "ad": k["ad"], **k["son_odeme"]} for k in sorted(yaklasan, key=lambda k: k["son_odeme"]["gun_kaldi"])],
            "not": "Kullanılabilir limit = son teyit + sonrasında ödeme formunda kartla ödenenler (−) ve kart borcu ödemeleri (+). "
                   "Bankadaki rakamı girdiğinde fark görünür."}


class TeyitBody(BaseModel):
    kullanilabilir: Decimal
    tarih: Optional[str] = None
    ekstre_borc: Optional[Decimal] = None
    son_odeme: Optional[str] = None
    not_: Optional[str] = None


@router.post("/{kid}/teyit")
def kart_teyit(kid: str, body: TeyitBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Bankanın uygulamasındaki KULLANILABİLİR LİMİT (+ istenirse ekstre borcu ve son ödeme tarihi) → yeni çıpa."""
    bugun = _bugun()
    try:
        tarih = date.fromisoformat((body.tarih or bugun.isoformat())[:10])
        son = date.fromisoformat(body.son_odeme[:10]) if body.son_odeme else None
    except ValueError:
        raise HTTPException(400, "Tarih YYYY-AA-GG olmalı")
    if tarih > bugun:
        raise HTTPException(400, "Gelecek tarihli teyit olmaz")
    _hazirla()
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        d = next((k for k in kart_durumu(cur) if k["id"] == kid), None)
        if not d:
            raise HTTPException(404, "Kart bulunamadı")
        beklenen = None
        if d.get("grup"):
            if tarih == bugun and d["grup"]["kullanilabilir"] is not None:
                beklenen = _kurus(d["grup"]["kullanilabilir"])
        elif d["cipa"] and d["cipa"]["tarih"] <= tarih.isoformat():
            beklenen = _kurus(d["cipa"]["kullanilabilir"]) + sum(_kurus(x["tutar"]) for x in d["hareketler"] if x["gun"] <= tarih.isoformat())
        eb = _kurus(body.ekstre_borc) if body.ekstre_borc is not None else None
        cur.execute("""INSERT INTO ey_kart_teyit (id, kart_id, tarih, kullanilabilir, ekstre_borc, son_odeme, sistem_beklenen, kaynak, not_, girilen)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,'elle',%s,%s)""",
                    ("kt-" + uuid.uuid4().hex[:12], kid, tarih, _kurus(body.kullanilabilir), eb or None, son, beklenen,
                     (body.not_ or "").strip()[:200] or None, kim))
    fark = (_kurus(body.kullanilabilir) - beklenen) if beklenen is not None else None
    if fark is None:
        msg = "Teyit kaydedildi — bundan sonra buradan hesaplanır"
    elif abs(fark) < 100:
        msg = "Teyit kaydedildi — sistemle TUTTU ✓"
    else:
        msg = (f"Teyit kaydedildi — bankada {_tl_sayi(abs(fark)):,.2f} ₺ {'daha AZ' if fark < 0 else 'daha FAZLA'} kullanılabilir: "
               + ("forma girilmemiş kart harcaması olabilir" if fark < 0 else "girilmemiş kart borcu ödemesi / iade olabilir"))
    return {"ok": True, "mesaj": msg, "fark": _tl_sayi(fark) if fark is not None else None}


@router.post("/teyit/{tid}/sil")
def teyit_sil(tid: str):
    """Yanlış girilen teyidi geri al (önceki çıpa geçerli olur)."""
    _hazirla()
    with db() as (conn, cur):
        kart_hazirla(cur)
        cur.execute("DELETE FROM ey_kart_teyit WHERE id=%s AND kaynak='elle' RETURNING id", (tid,))
        if not cur.fetchone():
            raise HTTPException(404, "Teyit bulunamadı")
    return {"ok": True}


# 🧩 Bekleyen işler kayıt defterine (Kasa bu modülü tanımaz; modül kapanınca satırları da kalkar)
bekleyen_is_kaydet("kart", lambda cur, b: kart_isleri(cur, b["kayit"]))
