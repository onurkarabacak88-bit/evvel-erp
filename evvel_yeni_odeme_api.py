"""🧾 EVVEL YENİ · ÖDEME / GİDER GİRİŞİ (2026-10-15).

Sahip: "Seçmeli ödeme gir yapılmalı: ödeme nakit mi, havale mi, kart mı?" · "Anlık gider
olmalı; kira girerken açılır pencerede şubelerin isimlerini seçmeliyiz; toptancıda kayıtlı
toptancı seçilmeli." · "Personelde personelden isimleri seçmeliyiz; yemek ücreti mesela."

TEK FORM, TEK KAYIT, OTOMATİK ETKİ:
  1) NE İÇİN (konu): toptancı · kira · fatura · personel · anlık gider · kredi/borç
     taksiti · kart borcu · diğer — hepsi LİSTEDEN seçilir (eski sistemden YALNIZ OKUNUR:
     tedarikciler, personel, kartlar).
  2) NASIL ÖDENDİ (parçalar): nakit (hangi cep) · havale (hangi banka/hesap) · kart
     (hangi kart). Birden çok parça olabilir.
  3) Etkiler sistem tarafından türetilir:
       · Nakit/havale parçası → Kasa'dan düşer (mevcut 'odeme' kaydı, tüm korumalarla).
       · Kart parçası → Kasa'ya DOKUNMAZ; o kartın borcunu artırır (Kartlar bölümü okuyacak).
       · Gider mi? kira · fatura · personel · anlık gider · diğer(şube/ortak) → EVET,
         kimin = seçilen şube / personelin şubesi / Ortak. Toptancı ödemesi gider DEĞİL
         (mal gideri sevkiyattan gelir; bu ödeme toptancı borcunu kapatır). Kredi taksiti
         ve kart borcu ödemesi gider DEĞİL (patron katmanı / çift sayım yasağı).
"""

from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from decimal import Decimal

from database import db, savepoint
from evvel_yeni_kasa_api import (_aktor, _hareket_dto, _bakiye, _baslangic, _bugun, _eksi_denetle, _etki, _hazirla, _kilit,
                                 _kilit_denetle, _kurus, _olaylar, _sahte, _sayim_kilidi, _tl, _tl_sayi, _yaz, _yukle)

router = APIRouter(prefix="/api/evvel-yeni/odeme", tags=["evvel-yeni-odeme"])

KONULAR = {
    "toptanci": {"ad": "Toptancı", "gider": False},
    "kira": {"ad": "Kira", "gider": True},
    "fatura": {"ad": "Fatura / abonelik", "gider": True},
    "personel": {"ad": "Personel", "gider": True},
    "anlik": {"ad": "Anlık gider", "gider": True},
    "kredi": {"ad": "Kredi / borç taksiti", "gider": False},
    "kart_borcu": {"ad": "Kart borcu", "gider": False},
    "diger": {"ad": "Diğer", "gider": True},
}
FATURA_TURLERI = ["Elektrik", "Su", "Doğalgaz", "İnternet / telefon", "Diğer abonelik"]
PERSONEL_KALEMLERI = ["Maaş", "Avans", "Yemek ücreti", "Prim", "SGK / vergi"]


def _listeler(cur) -> dict:
    out = {"toptancilar": [], "personel": [], "kartlar": []}
    for ad, sql in (
        ("toptancilar", "SELECT id, ad, kategori FROM tedarikciler WHERE COALESCE(aktif, TRUE) ORDER BY ad"),
        ("personel", "SELECT id, ad_soyad AS ad, sube_id, gorev, yemek_ucreti FROM personel WHERE COALESCE(aktif, TRUE) ORDER BY ad_soyad"),
        ("kartlar", "SELECT id, kart_adi AS ad, banka FROM kartlar WHERE COALESCE(aktif, TRUE) ORDER BY kart_adi"),
    ):
        try:
            with savepoint(cur, "sp_ey_liste_" + ad):
                cur.execute(sql)
                out[ad] = [{k: (float(v) if isinstance(v, Decimal) else v) for k, v in dict(r).items()} for r in cur.fetchall() or []]
        except Exception:  # noqa: BLE001 — liste okunamazsa form yine açılır, alan boş kalır
            out[ad] = []
    return out


@router.get("/listeler")
def listeler():
    """Formun bütün açılır listeleri + ceplerin anlık bakiyesi (nakit/havale kaynağı seçimi için)."""
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur)
        L = _listeler(cur)
    B = _bakiye(_olaylar(kayit), C)["b"]
    subeler = [{"id": c["sube_id"], "ad": c["kisa"]} for c in cep_list if c["tur"] == "sube"]
    sube_ad = {s["id"]: s["ad"] for s in subeler}
    for p in L["personel"]:
        p["sube_ad"] = sube_ad.get(p.get("sube_id"))
    return {
        "konular": [{"kod": k, **v} for k, v in KONULAR.items()],
        "fatura_turleri": FATURA_TURLERI, "personel_kalemleri": PERSONEL_KALEMLERI,
        "subeler": subeler, **L,
        "nakit_cepler": [{"id": c["id"], "ad": c["ad"], "bakiye": _tl_sayi(B.get(c["id"], 0))} for c in cep_list if c["tur"] == "ev"],
        # Sahip (2026-10-15): "dükkân nakdinden ödenirse panelden girilir" → dükkân çekmecesi bu formda YOK (çift giriş biter)
        "banka_cepler": [{"id": c["id"], "ad": c["ad"], "bakiye": _tl_sayi(B.get(c["id"], 0))} for c in cep_list if c["tur"] in ("banka", "hesap")],
    }


class Parca(BaseModel):
    yontem: str                  # nakit | havale | kart
    cep: Optional[str] = None    # nakit/havale
    kart_id: Optional[str] = None
    tutar: Decimal


class OdemeBody(BaseModel):
    konu: str
    tarih: Optional[str] = None
    ait_ay: Optional[str] = None          # YYYY-AA (kira/fatura/personel için; gider o aya yazılır)
    toptanci_id: Optional[str] = None
    sube_id: Optional[str] = None
    fatura_turu: Optional[str] = None
    personel_id: Optional[str] = None
    personel_kalemi: Optional[str] = None
    kimin: Optional[str] = None           # diğer/anlık: şube id | 'ortak' | 'patron'
    aciklama: Optional[str] = None
    parcalar: List[Parca]
    istek_id: Optional[str] = None        # formun tek kimliği — bağlantı kopup tekrar gönderilirse İKİNCİ KEZ yazılmaz
    tekrar_onay: bool = False             # "aynı gün, aynı cep, aynı tutar zaten var" uyarısına rağmen kaydet


@router.post("")
def odeme_gir(body: OdemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    if body.konu not in KONULAR:
        raise HTTPException(400, "Ne için ödendiğini seç")
    bugun = _bugun()
    gun = (body.tarih or bugun.isoformat())[:10]
    try:
        gd = date.fromisoformat(gun)
    except ValueError:
        raise HTTPException(400, "Tarih YYYY-AA-GG olmalı")
    if gd > bugun:
        raise HTTPException(400, "Gelecek tarihli ödeme girilemez")
    if not body.parcalar:
        raise HTTPException(400, "Nasıl ödendiğini seç (nakit / havale / kart)")
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        bas = _baslangic(cur)
        if gd < bas:
            raise HTTPException(400, f"Bu dönem {bas.strftime('%d.%m.%Y')} tarihinde başladı")
        cep_list, C, kayit, _ = _yukle(cur)
        L = _listeler(cur)
        subeler = {c["sube_id"]: c for c in cep_list if c["tur"] == "sube"}

        # ── KONU ve KİMİN ──
        konu = {"tip": body.konu, "ad": KONULAR[body.konu]["ad"]}
        kimin = None
        etiket = KONULAR[body.konu]["ad"]
        if body.konu == "toptanci":
            t = next((x for x in L["toptancilar"] if str(x["id"]) == str(body.toptanci_id)), None)
            if not t:
                raise HTTPException(400, "Kayıtlı toptancı seç")
            konu.update(toptanci_id=t["id"], toptanci_ad=t["ad"])
            etiket = f"Toptancı · {t['ad']}"
        elif body.konu in ("kira", "fatura", "anlik"):
            if body.sube_id not in subeler:
                raise HTTPException(400, "Şube seç")
            kimin = body.sube_id
            konu["sube_id"] = body.sube_id
            if body.konu == "fatura":
                if body.fatura_turu not in FATURA_TURLERI:
                    raise HTTPException(400, "Fatura türünü seç")
                konu["fatura_turu"] = body.fatura_turu
                etiket = f"{body.fatura_turu} · {subeler[body.sube_id]['kisa']}"
            elif body.konu == "kira":
                etiket = f"Kira · {subeler[body.sube_id]['kisa']}"
            else:
                if not (body.aciklama or "").strip():
                    raise HTTPException(400, "Anlık gider için ne alındığını yaz")
                etiket = f"Anlık gider · {subeler[body.sube_id]['kisa']} · {body.aciklama.strip()[:60]}"
        elif body.konu == "personel":
            p = next((x for x in L["personel"] if str(x["id"]) == str(body.personel_id)), None)
            if not p:
                raise HTTPException(400, "Personel seç")
            if body.personel_kalemi not in PERSONEL_KALEMLERI:
                raise HTTPException(400, "Ödeme kalemini seç (maaş, avans, yemek ücreti…)")
            kimin = p.get("sube_id") if p.get("sube_id") in subeler else "ortak"
            konu.update(personel_id=p["id"], personel_ad=p["ad"], kalem=body.personel_kalemi)
            etiket = f"{body.personel_kalemi} · {p['ad']}"
        elif body.konu in ("kredi", "kart_borcu"):
            kimin = "patron"
            if body.konu == "kart_borcu":
                k = next((x for x in L["kartlar"] if str(x["id"]) == str(body.toptanci_id or body.kimin or "")), None)
                if not k:
                    raise HTTPException(400, "Hangi kartın borcu ödendi? Kartı seç")
                konu.update(kart_id=k["id"], kart_ad=k["ad"])
                etiket = f"Kart borcu · {k['ad']}"
        else:   # diğer
            if body.kimin not in list(subeler) + ["ortak", "patron"]:
                raise HTTPException(400, "Kimin gideri: şube, Ortak ya da Patron şahsi seç")
            if not (body.aciklama or "").strip():
                raise HTTPException(400, "Açıklama yaz")
            kimin = body.kimin
            etiket = f"{body.aciklama.strip()[:60]}"
        ait_ay = (body.ait_ay or gun[:7])[:7] if body.konu in ("kira", "fatura", "personel") else gun[:7]
        if body.konu in ("kira", "fatura", "personel"):
            try:
                date.fromisoformat(ait_ay + "-01")
            except ValueError:
                raise HTTPException(400, "Ait olduğu ay YYYY-AA olmalı")
        gider_mi = KONULAR[body.konu]["gider"] and kimin not in ("patron",)
        if body.aciklama and body.konu not in ("anlik", "diger"):
            etiket += f" · {body.aciklama.strip()[:60]}"

        # ── PARÇALAR ──
        nakit_parca, kart_parca = [], []
        for p in body.parcalar:
            t = _kurus(p.tutar)
            if t < 0:
                raise HTTPException(400, "Tutar eksi olamaz")
            if t == 0:
                raise HTTPException(400, "Tutarı boş bir ödeme satırı var — doldur ya da sil")
            if p.yontem in ("nakit", "havale"):
                tur_izin = ("ev",) if p.yontem == "nakit" else ("banka", "hesap")
                if p.cep in C and C[p.cep]["tur"] == "sube":
                    raise HTTPException(400, "Dükkân nakdinden yapılan harcamayı şube PANELDEN girer. Dükkândaki parayı patron aldıysa "
                                             "önce Kasa'da teslim alın (dükkân → ev), sonra evden ödeyin.")
                if p.cep not in C or C[p.cep]["tur"] not in tur_izin:
                    raise HTTPException(400, f"{'Nakit için cep' if p.yontem == 'nakit' else 'Havale için banka'} seç")
                nakit_parca.append({"cep": p.cep, "tutar": t, "yontem": p.yontem})
            elif p.yontem == "kart":
                k = next((x for x in L["kartlar"] if str(x["id"]) == str(p.kart_id)), None)
                if not k:
                    raise HTTPException(400, "Kart seç")
                kart_parca.append({"kart_id": k["id"], "kart_ad": k["ad"], "tutar": t})
            else:
                raise HTTPException(400, "Ödeme yöntemi: nakit / havale / kart")
        if not nakit_parca and not kart_parca:
            raise HTTPException(400, "Tutar gir")
        if body.konu == "kart_borcu" and kart_parca:
            raise HTTPException(400, "Kart borcu kartla ödenemez — nakit ya da havale seç")
        if len({x["cep"] for x in nakit_parca}) != len(nakit_parca):
            raise HTTPException(400, "Aynı cep iki kez seçilemez")
        toplam = sum(x["tutar"] for x in nakit_parca) + sum(x["tutar"] for x in kart_parca)

        veri = {"aciklama": etiket[:120], "kimin": (subeler[kimin]["kisa"] if kimin in subeler else {"ortak": "Ortak", "patron": "Patron"}.get(kimin, "Ortak")),
                "kimin_kod": kimin, "parcalar": [{"cep": x["cep"], "tutar": x["tutar"]} for x in nakit_parca],
                "yontemler": [x["yontem"] for x in nakit_parca] + ["kart"] * len(kart_parca),
                "kart_parcalar": kart_parca, "konu": konu, "gider": gider_mi, "ait_ay": ait_ay,
                "toplam": toplam, "kaynak": "odeme_formu", "not": (body.aciklama or "").strip()[:200]}
        if not body.tekrar_onay:
            for h in kayit:
                if h["tur"] != "odeme" or h["is_gunu"] != gun:
                    continue
                eski = {(p["cep"], int(p["tutar"])) for p in h["veri"].get("parcalar", [])}
                if any((x["cep"], x["tutar"]) in eski for x in nakit_parca):
                    raise HTTPException(409, f"BENZER KAYIT: aynı gün, aynı yerden, aynı tutarda bir ödeme zaten var — "
                                             f"\"{h['veri'].get('aciklama') or 'Ödeme'}\". Aynı harcamayı iki kez girmiyorsan yine de kaydedebilirsin.")
        yeni = _sahte("odeme", gun, tutar=toplam, veri=veri)
        yeni_ol = _olaylar([yeni])
        etkiler = [(e["cep"], o["gun"]) for o in yeni_ol for e in _etki(o, C)]
        _kilit_denetle(etkiler, _sayim_kilidi(_olaylar(kayit)), C)
        _eksi_denetle(_olaylar(kayit + [yeni]), {x["cep"] for x in nakit_parca}, gun, C)
        ref = f"odeme_formu:{body.istek_id[:64]}" if body.istek_id else None
        hid = _yaz(cur, "odeme", gun, kim, tutar=toplam, veri=veri, kaynak_ref=ref)
        if ref and not hid:
            return {"ok": True, "id": None, "tekrar": True, "mesaj": "Bu ödeme zaten kaydedilmişti (ikinci kez yazılmadı)"}
    return {"ok": True, "id": hid, "gider": gider_mi, "kimin": veri["kimin"], "toplam": _tl_sayi(toplam),
            "mesaj": f"{etiket} · {_tl(toplam)}" + (" · gider olarak yazıldı" if gider_mi else " · gider değil")}


@router.get("/liste")
def odeme_listesi(ay: Optional[str] = None):
    """Ayın ödemeleri — ne için, kimin, nasıl (nakit/havale/kart), gider mi."""
    _hazirla()
    a_ = (ay or _bugun().strftime("%Y-%m"))[:7]
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
    ol = _olaylar(kayit)
    out = []
    for h in kayit:
        if h["tur"] != "odeme" or h["is_gunu"][:7] != a_:
            continue
        v = h["veri"]
        nakit = [{"ad": C.get(p["cep"], {}).get("ad", p["cep"]), "tutar": _tl_sayi(int(p["tutar"]))} for p in v.get("parcalar", [])]
        kart = [{"ad": p.get("kart_ad"), "tutar": _tl_sayi(int(p["tutar"]))} for p in v.get("kart_parcalar", [])]
        out.append({"id": h["id"], "tarih": h["is_gunu"], "aciklama": v.get("aciklama"), "konu": (v.get("konu") or {}).get("ad")
                    or ("Dükkân gideri" if v.get("kaynak") == "dukkan_gideri" else "Ödeme"),
                    "kimin": v.get("kimin"), "gider": v.get("gider"), "ait_ay": v.get("ait_ay"),
                    "nakit": nakit, "kart": kart, "toplam": _tl_sayi(int(v.get("toplam", h["tutar"]))), "kaydeden": h.get("kaydeden"),
                    "fis": _hareket_dto(h, C, ol)})
    out.sort(key=lambda x: x["tarih"], reverse=True)
    return {"ay": a_, "odemeler": out, "toplam": round(sum(x["toplam"] for x in out), 2),
            "nakit_toplam": round(sum(n["tutar"] for x in out for n in x["nakit"]), 2),
            "kart_toplam": round(sum(k["tutar"] for x in out for k in x["kart"]), 2)}


@router.get("/personel-durum")
def personel_durum(personel_id: str, ay: str):
    """Seçilen personele o ay (ait olduğu ay) ne ödendi — kalem kalem. Maaş girerken avansı görsün,
    maaşın KALANINI girsin (avans + tam maaş = çift gider olmasın)."""
    _hazirla()
    with db() as (conn, cur):
        _, _, kayit, _ = _yukle(cur, tum_donemler=True)
    kalem = {}
    for h in kayit:
        v = h["veri"]
        k = v.get("konu") or {}
        if h["tur"] != "odeme" or k.get("tip") != "personel" or str(k.get("personel_id")) != str(personel_id) or v.get("ait_ay") != ay[:7]:
            continue
        kalem[k.get("kalem") or "?"] = kalem.get(k.get("kalem") or "?", 0) + int(v.get("toplam", h["tutar"]))
    return {"ay": ay[:7], "kalemler": {a: _tl_sayi(t) for a, t in kalem.items()}, "toplam": _tl_sayi(sum(kalem.values()))}
