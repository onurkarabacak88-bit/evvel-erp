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

import logging
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from evvel_yeni_cekirdek import TrTutar   # para alanı: Türkçe tutar kuralı (TEK yer)

from database import db
# Kasa'nın YALNIZ PUBLIC kapıları (tekrar denetimi C-T2-01: önce 11 özel fonksiyon ithal ediliyordu)
from evvel_yeni_kasa_api import (bakiyeler as _bakiyeler, hareket_fisi as _hareket_dto, hareket_kaydet, hareket_veri_degistir,
                                 hareket_veri_ekle,
                                 kasa_baslangic as _baslangic, kasa_hazirla as _hazirla, kasa_kayitlari as _yukle, olay_listesi as _olaylar)
from evvel_yeni_cekirdek import (aktor as _aktor, bugun as _bugun, kilit as _kilit, kurus as _kurus, tl as _tl,
                                 tl_sayi as _tl_sayi)

router = APIRouter(prefix="/api/evvel-yeni/odeme", tags=["evvel-yeni-odeme"])
log = logging.getLogger(__name__)

KONULAR = {
    "toptanci": {"ad": "Toptancı", "gider": False},
    "kira": {"ad": "Kira", "gider": False},   # gider TAHAKKUKTAN (Kira takvimi); ödeme yalnız kirayı kapatır
    "fatura": {"ad": "Fatura / abonelik", "gider": True},
    "personel": {"ad": "Personel", "gider": False},   # gider Maaşlar'ın hak edişinden (çalışma ayına) yazılır
    "anlik": {"ad": "Anlık gider", "gider": True},
    "kredi": {"ad": "Kredi / borç taksiti", "gider": False},
    "kart_borcu": {"ad": "Kart borcu", "gider": False},
    # Sahip (2026-10-17, envanter 18): vergi muhasebecide hesaplanır; burada yalnız ÖDEME — şube/ortak, tür, ait ay (gider sayılmaz)
    "vergi": {"ad": "Vergi", "gider": False},
    "sgk": {"ad": "SGK", "gider": False},      # sahip: "SGK ödemesi ayrı, vergi ayrı" — ikisi de tek yoldan
    "diger": {"ad": "Diğer", "gider": True},
}
FATURA_TURLERI = ["Elektrik", "Su", "Doğalgaz", "İnternet / telefon", "Diğer abonelik"]
VERGI_TURLERI = ["KDV", "Muhtasar / stopaj", "Gelir / kurumlar vergisi", "Diğer vergi"]
# Sahip (2026-10-17): "SGK da vergi de ödemelerden TEK düşümle; her alan bu alana yönlendirsin" → SGK/vergi personel kaleminden çıktı (Vergi konusu)
PERSONEL_KALEMLERI = ["Maaş", "Avans", "Yemek ücreti", "Prim"]
from evvel_yeni_kasa_api import PATRONLAR as _P
PATRONLAR = list(_P)   # sahip: "hangi patronun harcaması olduğuna karar verelim" — TEK liste Kasa'da (C-T1-34)


def _listeler(cur) -> dict:
    """Toptancı / personel / kart — Evvel Yeni'nin KENDİ tanımlarından (Tanımlar bölümü). Eski tablolara bağlı DEĞİL."""
    from evvel_yeni_tanim_api import secim_listeleri
    return secim_listeleri(cur)


@router.get("/listeler")
def listeler():
    """Formun bütün açılır listeleri + ceplerin anlık bakiyesi (nakit/havale kaynağı seçimi için)."""
    _hazirla()
    with db() as (conn, cur):
        cep_list, C, kayit, _ = _yukle(cur)
        L = _listeler(cur)
        from evvel_yeni_tanim_api import subeler as _sb_hepsi
        pasif = {str(x["id"]) for x in _sb_hepsi(cur, hepsi=True) if not x["aktif"]}   # B13: pasif şube seçilemez
        from evvel_yeni_kasa_api import alinan_borclar
        acik_borclar = [x for x in alinan_borclar(cur) if x["alt"] == "borc" and not x["kapandi"]]   # D-1: geri ödenecek kişisel borçlar
    B = _bakiyeler(kayit, C)
    hepsi = [{"id": c["sube_id"], "ad": c["kisa"]} for c in cep_list if c["tur"] == "sube"]
    subeler = [s for s in hepsi if str(s["id"]) not in pasif]
    sube_ad = {s["id"]: s["ad"] for s in hepsi}   # eski kayıtlarda pasif şubenin adı yine okunur
    for p in L["personel"]:
        p["sube_ad"] = sube_ad.get(p.get("sube_id"))
    return {
        "konular": [{"kod": k, **v} for k, v in KONULAR.items()],
        "fatura_turleri": FATURA_TURLERI, "personel_kalemleri": PERSONEL_KALEMLERI, "vergi_turleri": VERGI_TURLERI,
        "subeler": subeler, "sube_adlari": sube_ad, **L, "alinan_borclar": acik_borclar,
        "nakit_cepler": [{"id": c["id"], "ad": c["ad"], "bakiye": _tl_sayi(B.get(c["id"], 0))} for c in cep_list if c["tur"] == "ev"],
        # Sahip (2026-10-15): "dükkân nakdinden ödenirse panelden girilir" → dükkân çekmecesi bu formda YOK (çift giriş biter)
        "banka_cepler": [{"id": c["id"], "ad": c["ad"], "bakiye": _tl_sayi(B.get(c["id"], 0))} for c in cep_list if c["tur"] in ("banka", "hesap")
                         and not (str(c.get("sube_id") or "") in pasif and abs(B.get(c["id"], 0)) < 1)],   # B13: boş pasif şube bankası
    }



def _konu_kimlik(k) -> tuple:
    """BENZER KAYIT kıyası için konunun KİMLİĞİ: tür + kimlik alanları (ad / açıklama hariç — Tanımlar'da ad değişince kalkan kaçmasın)."""
    k = k or {}
    return tuple(sorted((a, str(v)) for a, v in k.items() if a.endswith("_id") or a in ("tip", "kalem", "fatura_turu", "vergi_turu", "donem", "borc_ref")))

class Parca(BaseModel):
    yontem: str                  # nakit | havale | kart
    cep: Optional[str] = None    # nakit/havale
    kart_id: Optional[str] = None
    tutar: TrTutar


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
    patron: Optional[str] = None          # kimin='patron' ise: Onur | Fethi | Fatma
    kredi_id: Optional[str] = None        # konu=kredi: hangi kredi (Krediler modülü — takvimde 'ödendi')
    kredi_ad: Optional[str] = None
    borc_ref: Optional[str] = None        # konu=kredi: ALINAN BORÇ geri ödemesi — Kasa dış girişinin id'si (F3.9 D-1)
    vergi_turu: Optional[str] = None      # konu=vergi: KDV · stopaj · gelir/kurumlar · SGK · diğer
    aciklama: Optional[str] = None
    parcalar: List[Parca]
    istek_id: Optional[str] = None        # formun tek kimliği — bağlantı kopup tekrar gönderilirse İKİNCİ KEZ yazılmaz
    tekrar_onay: bool = False             # "aynı gün, aynı cep, aynı tutar zaten var" uyarısına rağmen kaydet


@router.post("")
def odeme_gir(body: OdemeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    _hazirla()
    with db() as (conn, cur):
        return odeme_yaz(cur, body, _aktor(cur, x_evvel_oturum))


def odeme_yaz(cur, body: OdemeBody, kim: str) -> dict:
    """PUBLIC — Ödeme formunun yazma çekirdeği, ÇAĞIRANIN işleminde (Kasa kilidini kendisi alır). Route ve Avans havalesi
    (talep kilidi + para + talep durumu TEK işlem — Fable O-1) bunu çağırır; ikinci yazıcı yok. Önce kasa_hazirla() çağrılmış olmalı."""
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
    _kilit(cur)
    if body.istek_id:   # Codex T1-28: TEKRAR önce — başarılı ödemenin tekrarı "yetersiz bakiye / benzer kayıt" hatası almasın
        from evvel_yeni_kasa_api import kaynak_refleri
        _ref = f"odeme_formu:{body.istek_id[:64]}"
        if any(r["kaynak_ref"] == _ref and not r["iptal"] for r in kaynak_refleri(cur, _ref)):
            return {"ok": True, "id": None, "tekrar": True, "mesaj": "Bu ödeme zaten kaydedilmişti (ikinci kez yazılmadı)"}
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
    elif body.konu == "anlik" and body.kimin == "patron":
        if not (body.aciklama or "").strip():
            raise HTTPException(400, "Anlık gider için ne alındığını yaz")
        kimin = "patron"
        etiket = f"Anlık · şahsi{(' · ' + body.patron) if body.patron in PATRONLAR else ''} · {body.aciklama.strip()[:60]}"
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
        if body.personel_kalemi == "SGK / vergi":
            raise HTTPException(400, "SGK Ödeme → 'SGK', vergi Ödeme → 'Vergi' konusundan girilir (tek yol)")
        if body.personel_kalemi not in PERSONEL_KALEMLERI:
            raise HTTPException(400, "Ödeme kalemini seç (maaş, avans, yemek ücreti…)")
        kimin = p.get("sube_id") if p.get("sube_id") in subeler else "ortak"
        konu.update(personel_id=p["id"], personel_ad=p["ad"], kalem=body.personel_kalemi)
        etiket = f"{body.personel_kalemi} · {p['ad']}"
    elif body.konu in ("vergi", "sgk"):
        if body.konu == "vergi" and body.vergi_turu not in VERGI_TURLERI:
            raise HTTPException(400, "Vergi türünü seç")
        if body.kimin not in list(subeler) + ["ortak"]:
            raise HTTPException(400, "Hangi şubenin (ya da Ortak)")
        kimin = body.kimin
        konu.update(sube_id=kimin if kimin in subeler else None)
        if body.konu == "vergi":
            konu["vergi_turu"] = body.vergi_turu
        etiket = (f"Vergi · {body.vergi_turu}" if body.konu == "vergi" else "SGK") + f" · {subeler[kimin]['kisa'] if kimin in subeler else 'Ortak'}"
    elif body.konu == "kredi" and body.borc_ref:
        # F3.9 D-1 (sim 26 Eki · Opus + Codex): yeni konu yok — "Kredi / borç taksiti" içinde alınan borç; liste Kasa'nın PUBLIC kapısından
        # (Krediler kapalıyken de bağlı yazılır). Gider değil (kredi konusu). Kalandan fazlası reddedilir (aşağıda, toplam belli olunca).
        kimin = "patron"
        from evvel_yeni_kasa_api import alinan_borclar
        borc = next((x for x in alinan_borclar(cur) if x["id"] == str(body.borc_ref) and x["alt"] == "borc"), None)
        if not borc:
            raise HTTPException(400, "Alınan borç bulunamadı (iptal edilmiş olabilir) — listeden seç")
        konu.update(borc_ref=borc["id"], borc_ad=f'{borc.get("kimden") or "?"} · {_tl(int(round(borc["tutar"] * 100)))}')
        etiket = f'Borç geri ödeme · {borc.get("kimden") or "?"}'
    elif body.konu in ("kredi", "kart_borcu"):
        kimin = "patron"
        kl = _kredi_listesi(cur) if body.konu == "kredi" else None
        if kl is not None:   # B67 (Fable 22 Eki): Krediler açıkken taksit bir KREDİYE bağlanmadan yazılmaz (takvim 'gecikti' → çift ödeme)
            if not kl:
                raise HTTPException(400, "Tanımlı kredi yok — önce Krediler › + Kredi ekle. Krediye bağlı olmayan borç: Diğer › Patron şahsi")
            k = next((x for x in kl if x["id"] == str(body.kredi_id or "")), None)
            if not k:
                raise HTTPException(400, "Hangi kredinin taksiti? Krediyi seç")
            konu.update(kredi_id=k["id"], kredi_ad=k["ad"])   # ad sunucudan (istemcinin yazdığı değil)
            etiket = f"Kredi taksiti · {k['ad']}"
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
    # Codex (2026-10-17): kredi taksiti / kart borcu da HANGİ AYIN borcunu kapattığını taşır (Eylül taksiti Ekim'de ödenirse Eylül kapanır)
    AYLI = ("kira", "fatura", "personel", "kredi", "kart_borcu", "vergi", "sgk")
    ait_ay = (body.ait_ay or gun[:7])[:7] if body.konu in AYLI else gun[:7]
    if body.konu in ("kredi", "kart_borcu") and body.ait_ay:
        konu["donem"] = ait_ay      # açıkça seçilen dönem (takvimden 'öde'); yoksa takvim ödeme gününe göre yerleştirir
    if body.konu in AYLI:
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
    if konu.get("borc_ref"):   # D-1: kalandan fazla geri ödeme yok (iki borca birden de yok — her ödeme tek borca)
        if str(gun) < str(borc["tarih"]):
            raise HTTPException(400, f'Bu borç {borc["tarih"]} günü alındı — ondan önceki bir güne geri ödeme girilemez')
        kalan = int(round((borc.get("kalan") or 0) * 100))
        if toplam > kalan:
            raise HTTPException(400, f"Bu borcun kalanı {_tl(kalan)} — daha fazlası ödenemez (fazlası başka borçsa ayrı gir)")

    veri = {"aciklama": etiket[:120], "kimin": (subeler[kimin]["kisa"] if kimin in subeler else {"ortak": "Ortak", "patron": "Patron"}.get(kimin, "Ortak")),
            "kimin_kod": kimin, "parcalar": [{"cep": x["cep"], "tutar": x["tutar"]} for x in nakit_parca],
            "yontemler": [x["yontem"] for x in nakit_parca] + ["kart"] * len(kart_parca),
            "kart_parcalar": kart_parca, "konu": konu, "gider": gider_mi, "ait_ay": ait_ay,
            "toplam": toplam, "kaynak": "odeme_formu", "not": (body.aciklama or "").strip()[:200]}
    if kimin == "patron" and body.patron in PATRONLAR:
        veri["patron"] = body.patron
    if not body.tekrar_onay:
        for h in kayit:
            if h["tur"] != "odeme" or h["is_gunu"] != gun:
                continue
            if _konu_kimlik(h["veri"].get("konu")) != _konu_kimlik(konu):
                continue   # E2E #13: farklı konu (ör. kart borcu ↔ toptancı) aynı tutarda olabilir — mükerrer değil
            eski = {(p["cep"], int(p["tutar"])) for p in h["veri"].get("parcalar", [])}
            if any((x["cep"], x["tutar"]) in eski for x in nakit_parca):
                raise HTTPException(409, f"BENZER KAYIT: aynı gün, aynı yerden, aynı tutarda bir ödeme zaten var — "
                                         f"\"{h['veri'].get('aciklama') or 'Ödeme'}\". Aynı harcamayı iki kez girmiyorsan yine de kaydedebilirsin.")
    if body.konu == "personel" and body.personel_kalemi in ("Maaş", "Yemek ücreti") and not body.tekrar_onay:
        try:
            from evvel_yeni_maas_api import hesapla as _maas_hesapla
            ms = next(iter(_maas_hesapla(cur, ait_ay, sadece=str(body.personel_id))), None)
        except Exception:  # noqa: BLE001
            ms = None
        if ms is not None:
            sinir = _kurus(ms["oneri"].get(body.personel_kalemi, 0))
            if toplam > sinir + 100:
                raise HTTPException(409, f"KALANI AŞIYOR: {ms['ad']} · {ait_ay} için kalan {body.personel_kalemi.lower()} "
                                         f"{_tl(sinir)} — girilen {_tl(toplam)}. Doğruysa yine de kaydedebilirsin.")
    ref = f"odeme_formu:{body.istek_id[:64]}" if body.istek_id else None
    hid = hareket_kaydet(cur, tur="odeme", gun=gun, tutar=toplam, veri=veri, kim=kim, kaynak_ref=ref,
                         para_cepleri={x["cep"] for x in nakit_parca}, kayit=kayit, C=C)   # Kasa'nın korumalı yolu
    if ref and not hid:
        return {"ok": True, "id": None, "tekrar": True, "mesaj": "Bu ödeme zaten kaydedilmişti (ikinci kez yazılmadı)"}
    return {"ok": True, "id": hid, "gider": gider_mi, "kimin": veri["kimin"], "toplam": _tl_sayi(toplam),
            "mesaj": f"{etiket} · {_tl(toplam)}" + (" · gider olarak yazıldı" if gider_mi else " · gider değil")}


def _kredi_listesi(cur) -> Optional[list]:
    """Krediler modülü kapalıysa None (tak-çıkar: kredi taksiti bağsız yazılır), açıksa aktif krediler."""
    from evvel_yeni_moduller import acik as _acik
    if not _acik("kredi"):
        return None
    from evvel_yeni_kredi_api import kredi_listesi
    return kredi_listesi(cur)


class DuzeltBody(BaseModel):
    kredi_id: Optional[str] = None    # B67: krediye bağlanmamış kredi taksitini sonradan bağla (para oynamaz)
    borc_ref: Optional[str] = None    # D-1: eski ödemeyi ALINAN BORCA bağla (para oynamaz, iz kalır)
    kimin: Optional[str] = None       # şube id | 'ortak' | 'patron'
    ait_ay: Optional[str] = None      # YYYY-AA (kira/fatura/personel)
    aciklama: Optional[str] = None


@router.post("/{hid}/duzelt")
def odeme_duzelt(hid: str, body: DuzeltBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """GİDER TARAFINI düzelt — kimin gideri, hangi ay, açıklama. PARA OYNAMAZ (cepler, tutar, yöntem aynı kalır;
    sayılmış cebe dokunmadığı için sayım kilidi gerekmez). Para tarafı yanlışsa: iptal + yeniden gir.
    İz silinmez: her düzeltme veri.duzeltmeler'e kim/ne zaman/eski→yeni olarak eklenir."""
    _hazirla()
    with db() as (conn, cur):
        _kilit(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cep_list, C, kayit, _ = _yukle(cur, tum_donemler=True)
        h = next((x for x in kayit if x["id"] == hid and x["tur"] == "odeme"), None)
        if not h:
            raise HTTPException(404, "Ödeme bulunamadı ya da iptal edilmiş")
        v = dict(h["veri"])
        if v.get("kaynak") != "odeme_formu":
            raise HTTPException(400, "Bu kayıt Ödeme formundan girilmemiş — şube panelden düzeltilir")
        tip = (v.get("konu") or {}).get("tip")
        subeler = {c["sube_id"]: c for c in cep_list if c["tur"] == "sube"}
        eski_kid = (v.get("konu") or {}).get("kredi_id")   # Fable: değişiklikten ÖNCE okunur (yoksa kıyas hep "aynı")
        eski_bref = (v.get("konu") or {}).get("borc_ref")
        eski = {"kimin": v.get("kimin"), "ait_ay": v.get("ait_ay"), "aciklama": v.get("aciklama"), "kredi": (v.get("konu") or {}).get("kredi_ad"),
                "borc": (v.get("konu") or {}).get("borc_ad")}
        if body.borc_ref and tip in ("kredi", "diger"):
            # D-1 (Opus + Codex): 1 Kasım öncesi "Diğer" / bağsız kredi konusuyla ödenmiş borç geri ödemesi sonradan bağlanır —
            # PARA OYNAMAZ, iz kalır. Borç geri ödemesi gider değildir → konu kredi, gider False. Kalandan fazlası bağlanamaz.
            from evvel_yeni_kasa_api import alinan_borclar
            borc = next((x for x in alinan_borclar(cur) if x["id"] == str(body.borc_ref) and x["alt"] == "borc"), None)
            if not borc:
                raise HTTPException(400, "Alınan borç bulunamadı")
            if str(h["is_gunu"]) < str(borc["tarih"]):   # borç alınmadan önceki ödeme o borcun geri ödemesi olamaz
                raise HTTPException(400, f'Bu ödeme {h["is_gunu"]} günü yapılmış, borç {borc["tarih"]} günü alındı — bağlanamaz')
            if (v.get("konu") or {}).get("borc_ref") != borc["id"] and int(v.get("toplam", h["tutar"]) or 0) > int(round((borc["kalan"] or 0) * 100)):
                raise HTTPException(400, f'Bu borcun kalanı {_tl(int(round((borc["kalan"] or 0) * 100)))} — bu ödeme daha büyük')
            v["konu"] = {**{a: b for a, b in (v.get("konu") or {}).items() if a not in ("kredi_id", "kredi_ad")},   # Codex P1: bağlar birbirini dışlar
                         "tip": "kredi", "borc_ref": borc["id"], "borc_ad": f'{borc.get("kimden") or "?"} · {_tl(int(round(borc["tutar"] * 100)))}'}
            v["gider"] = False
            v["kimin_kod"], v["kimin"] = "patron", "Patron"
            body.kimin = None   # borç geri ödemesinde "kimin gideri" sorusu yok — formdan gelen şube seçimi kimin/gider'i geri çevirmesin
        if body.kredi_id and tip == "kredi":   # B67: hangi kredinin taksiti (sonradan bağla / değiştir)
            k = next((x for x in (_kredi_listesi(cur) or []) if x["id"] == str(body.kredi_id)), None)
            if not k:
                raise HTTPException(400, "Kredi bulunamadı")
            v["konu"] = {**{a: b for a, b in (v.get("konu") or {}).items() if a not in ("borc_ref", "borc_ad")},
                         "kredi_id": k["id"], "kredi_ad": k["ad"]}   # Codex P1: bağlar birbirini dışlar (çift mahsup yok)
        if body.kimin is not None and body.kimin != v.get("kimin_kod") and tip in ("vergi", "sgk"):   # Fable: vergi şubesi düzeltilebilsin (gider değil)
            if body.kimin not in list(subeler) + ["ortak"]:
                raise HTTPException(400, "Geçerli bir şube seç ya da Ortak")
            v["kimin_kod"] = body.kimin
            v["kimin"] = subeler[body.kimin]["kisa"] if body.kimin in subeler else "Ortak"
            v["konu"] = {**(v.get("konu") or {}), "sube_id": body.kimin if body.kimin in subeler else None}   # Codex: eski şube kalmasın
        elif body.kimin is not None and body.kimin != v.get("kimin_kod"):
            if not KONULAR.get(tip, {}).get("gider"):
                raise HTTPException(400, "Bu ödeme gider değil (toptancı / kredi / kart borcu) — kimin sorusu yok")
            izin = list(subeler) + (["ortak", "patron"] if tip in ("diger", "personel") else [])
            if body.kimin not in izin:
                raise HTTPException(400, "Geçerli bir şube seç" + (" ya da Ortak / Patron şahsi" if tip in ("diger", "personel") else ""))
            v["kimin_kod"] = body.kimin
            v["kimin"] = subeler[body.kimin]["kisa"] if body.kimin in subeler else {"ortak": "Ortak", "patron": "Patron"}[body.kimin]
            v["gider"] = body.kimin != "patron"
        if body.ait_ay is not None and body.ait_ay[:7] != v.get("ait_ay"):
            if tip not in ("kira", "fatura", "personel", "vergi", "sgk", "kredi", "kart_borcu"):
                raise HTTPException(400, "Bu ödemenin ayı ödeme gününden gelir; gün yanlışsa iptal edip yeniden gir")
            try:
                date.fromisoformat(body.ait_ay[:7] + "-01")
            except ValueError:
                raise HTTPException(400, "Ay YYYY-AA olmalı")
            v["ait_ay"] = body.ait_ay[:7]
            if tip in ("kredi", "kart_borcu"):   # Fable P1: takvimler önce 'donem'i okur — ay düzeltmesi takvime de yansısın
                v["konu"] = {**(v.get("konu") or {}), "donem": v["ait_ay"]}
        if body.aciklama is not None and body.aciklama.strip() and body.aciklama.strip()[:120] != v.get("aciklama"):
            v["aciklama"] = body.aciklama.strip()[:120]
        yeni = {"kimin": v.get("kimin"), "ait_ay": v.get("ait_ay"), "aciklama": v.get("aciklama"), "kredi": (v.get("konu") or {}).get("kredi_ad"),
                "borc": (v.get("konu") or {}).get("borc_ad")}
        kid_degisti = eski_kid != (v.get("konu") or {}).get("kredi_id")   # Fable P3: aynı adlı iki kredi — kıyas kimlikle
        bref_degisti = eski_bref != (v.get("konu") or {}).get("borc_ref")   # Codex P2: aynı kişiden aynı tutarda iki borç — kıyas kimlikle
        if yeni == eski and not kid_degisti and not bref_degisti:
            return {"ok": True, "mesaj": "Değişiklik yok"}
        degisen = {k: [eski[k], yeni[k]] for k in eski if eski[k] != yeni[k]} or (
            {"borc": [f'{eski["borc"]} ({eski_bref})', f'{yeni["borc"]} ({(v.get("konu") or {}).get("borc_ref")})']} if bref_degisti
            else {"kredi": [f'{eski["kredi"]} ({eski_kid})', f'{yeni["kredi"]} ({(v.get("konu") or {}).get("kredi_id")})']})
        v["duzeltmeler"] = list(v.get("duzeltmeler") or []) + [{"kim": kim, "zaman": _bugun().isoformat(), "degisen": degisen}]
        hareket_veri_degistir(cur, hid, v)   # Kasa'nın kapısı (C-T2-12)
    return {"ok": True, "mesaj": "Düzeltildi · " + " · ".join(f"{k}: {a or '—'} → {b or '—'}" for k, (a, b) in degisen.items())}


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
                    "fis": _hareket_dto(h, C, ol), "kimin_kod": v.get("kimin_kod"), "konu_tip": (v.get("konu") or {}).get("tip"),
                    "duzeltilebilir": v.get("kaynak") == "odeme_formu", "duzeltmeler": v.get("duzeltmeler") or [],
                    "patron": v.get("patron"), "kredi_id": (v.get("konu") or {}).get("kredi_id"),
                    "borc_ref": (v.get("konu") or {}).get("borc_ref"), "borc_ad": (v.get("konu") or {}).get("borc_ad"),
                    "kart_id": (v.get("konu") or {}).get("kart_id")})
    out.sort(key=lambda x: x["tarih"], reverse=True)
    return {"ay": a_, "odemeler": out, "toplam": round(sum(x["toplam"] for x in out), 2),
            "nakit_toplam": round(sum(n["tutar"] for x in out for n in x["nakit"]), 2),
            "kart_toplam": round(sum(k["tutar"] for x in out for k in x["kart"]), 2)}


# ── PERSONEL ÜCRETİ — tanım Tanımlar'ın (TEK yazıcı `ucret_yaz`); Ödeme formu yalnız onu çağırır (tekrar denetimi C-T1-01). ──


@router.get("/personel-durum")
def personel_durum(personel_id: str, ay: str):
    """Maaşlar'daki o ayın satırı: hak ediş, avans mahsubu, ödenen, kalan + kalem önerisi (form tutarı bununla dolar)."""
    from evvel_yeni_maas_api import hesapla
    _hazirla()
    with db() as (conn, cur):
        r = next(iter(hesapla(cur, ay[:7], sadece=personel_id)), None)
    if not r:
        return {"ay": ay[:7], "bulunamadi": True, "kalemler": {}, "toplam": 0, "onerilen": {},
                "ucret": {"maas": 0, "yemek": 0, "kaynak": "tanimsiz", "gecerli_ay": None}}
    return {"ay": r["ay"], "kalemler": r["odeme_kalemleri"], "toplam": round(sum(r["odeme_kalemleri"].values()), 2),
            "hak_edis": r["hak_edis"], "avans_mahsup": r["avans_mahsup"], "odenen": r["odenen"], "kalan": r["kalan"],
            "kaynak": r["kaynak"], "onay": r["onay"], "uyari": r.get("uyari") or [],
            "onerilen": r["oneri"], "ucret": {"maas": next((k["tutar"] for k in r["kalemler"] if k["kod"] == "taban"), 0),
                                               "yemek": r.get("yemek_hak", 0), "kaynak": r["kaynak"], "gecerli_ay": None}}


class UcretBody(BaseModel):
    personel_id: str
    ay: str                 # YYYY-AA — bu aydan itibaren geçerli
    maas: TrTutar
    yemek: TrTutar


@router.post("/personel-ucret")
def personel_ucret(body: UcretBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Maaş / yemek tanımı — o aydan İTİBAREN geçerli. Eski aylar etkilenmez; saatlik ücret + yol önceki tanımdan taşınır."""
    try:
        date.fromisoformat(body.ay[:7] + "-01")
    except ValueError:
        raise HTTPException(400, "Ay YYYY-AA olmalı")
    m, y = _kurus(body.maas), _kurus(body.yemek)
    if m < 0 or y < 0:
        raise HTTPException(400, "Tutar eksi olamaz")
    with db() as (conn, cur):
        from evvel_yeni_tanim_api import ucret_yaz
        kim = _aktor(cur, x_evvel_oturum)
        ucret_yaz(cur, personel_id=str(body.personel_id), ay=body.ay[:7], kim=kim, maas=m, yemek=y)   # saatlik / yol TAŞINIR
    return {"ok": True, "mesaj": f"Ücret tanımı kaydedildi · {body.ay[:7]} ayından itibaren · maaş {_tl(m)} · yemek {_tl(y)}"}


@router.get("/patron")
def patron_harcamalari(ay: Optional[str] = None):
    """👤 PATRON HARCAMALARI (sahip 2026-10-16: "patron harcamaları için ayrı sekme"). Şubenin gideri DEĞİL;
    hepsi tek yerde: şahsi harcama (ödeme formu, kimin=Patron) · dükkândan şahsi (Gider'de çekiş diye ayrılan
    dükkân giderleri) · kredi / borç taksiti · kart borcu ödemesi. YALNIZ OKUR."""
    a_ = (ay or _bugun().strftime("%Y-%m"))[:7]
    liste = odeme_listesi(a_)["odemeler"]
    gruplar = {"sahsi": [], "cekis": [], "kredi": [], "kart_borcu": []}
    for x in liste:
        tip = x.get("konu_tip")
        if tip == "kredi":
            g = "kredi"
        elif tip == "kart_borcu":
            g = "kart_borcu"
        elif x.get("kimin_kod") == "patron":
            g = "sahsi"
        else:
            continue
        gruplar[g].append({"id": x["id"], "kaynak": "odeme", "patron": x.get("patron"), "tarih": x["tarih"], "aciklama": x["aciklama"], "tutar": x["toplam"],
                           "nasil": " + ".join([f"{n['ad']} {_tl(int(round(n['tutar'] * 100)))}" for n in x["nakit"]] + [f"💳 {k['ad']} {_tl(int(round(k['tutar'] * 100)))}" for k in x["kart"]]),
                           "kaydeden": x.get("kaydeden"), "fis": x.get("fis")})
    try:
        from evvel_yeni_gider_api import gider_ozet
        for c in gider_ozet(a_).get("cekisler") or []:
            kim = c.get("kim") if c.get("kim") in PATRONLAR else None
            gruplar["cekis"].append({"id": c.get("kaynak_ref") or c.get("id"), "kaynak": "cekis", "patron": kim, "tarih": c.get("gun"),
                                     "aciklama": c.get("aciklama"), "tutar": c.get("tutar"), "nasil": f"{c.get('sube') or ''} dükkân nakdi",
                                     "kaydeden": None, "fis": None})
    except Exception as e:  # noqa: BLE001
        log.warning("patron harcamaları: çekişler okunamadı: %s", str(e)[:150])
    AD = {"sahsi": "Şahsi harcama", "cekis": "Dükkândan şahsi (çekiş)", "kredi": "Kredi / borç taksiti", "kart_borcu": "Kart borcu ödemesi"}
    out = []
    for k, xs in gruplar.items():
        xs.sort(key=lambda z: z["tarih"] or "", reverse=True)
        out.append({"kod": k, "ad": AD[k], "kalemler": xs, "toplam": round(sum(z["tutar"] or 0 for z in xs), 2)})
    kisi = {}
    for g_ in out:
        if g_["kod"] in ("sahsi", "cekis"):
            for z in g_["kalemler"]:
                k_ = z.get("patron") or "seçilmedi"
                kisi[k_] = round(kisi.get(k_, 0) + (z["tutar"] or 0), 2)
    return {"ay": a_, "gruplar": out, "toplam": round(sum(g["toplam"] for g in out), 2), "patronlar": PATRONLAR,
            "patron_toplam": [{"ad": k, "toplam": v} for k, v in sorted(kisi.items(), key=lambda z: (z[0] == "seçilmedi", z[0]))],
            "not": "Şubenin gideri değil — Şube kazancına girmez. Kart borcu ödemesi kartla yapılan harcamanın borcunu kapatır."}


class PatronAtaBody(BaseModel):
    id: str
    kaynak: str                   # 'odeme' (ödeme formu kaydı) | 'cekis' (dükkân giderinden ayrılan)
    patron: Optional[str] = None  # Onur | Fethi | Fatma
    geri_al: bool = False         # yalnız 'cekis': şube giderine geri al


@router.post("/patron-ata")
def patron_ata(body: PatronAtaBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Patron harcamasının KİMİN olduğu (Onur / Fethi / Fatma) — ya da dükkândan ayrılanı şube giderine geri alma."""
    if not body.geri_al and body.patron not in PATRONLAR:
        raise HTTPException(400, "Patron seç: " + " / ".join(PATRONLAR))
    _hazirla()
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
        if body.kaynak == "cekis":
            from evvel_yeni_gider_api import sinif_yaz   # sınıf tablosu Gider'in — kendi kapısından
            sinif_yaz(cur, body.id, "gider" if body.geri_al else "cekis", None if body.geri_al else body.patron, kim)
        elif body.kaynak == "odeme":
            if not hareket_veri_ekle(cur, body.id, {"patron": body.patron}, tur="odeme"):   # Kasa'nın kapısı (C-T2-12)
                raise HTTPException(404, "Kayıt bulunamadı")
        else:
            raise HTTPException(400, "kaynak: odeme | cekis")
    return {"ok": True, "mesaj": "Şube giderine geri alındı" if body.geri_al else f"{body.patron}'un harcaması olarak işaretlendi"}


def konu_odemeleri(cur, konu_tip: str, kayit: Optional[list] = None, C: Optional[dict] = None) -> list:
    """PUBLIC servis — bir KONUDAKİ bütün ödemeler tek okumada (iptaller düşülmüş). Kredi · Kart · Kira · Maaş · Toptancı bunu okur
    (tekrar denetimi "Kaçırılan #1": her biri Kasa kayıtlarını kendi süzgeciyle tarıyordu; Kira'nın iki okuyucusu 'ay'ı farklı alıyordu).
    Her satır: id, tarih, ait_ay, ay (ait_ay yoksa ödeme gününün ayı — TEK kural), donem, toplam (kuruş), konu (sözlük), kalem, kaynak,
    aciklama, kim, kartla, nereden (C verilirse cep adlarıyla), kredi_id, kart_id, sube_id, personel_id, toptanci_id."""
    if kayit is None:
        _, C_, kayit, _ = _yukle(cur, tum_donemler=True)
        C = C if C is not None else C_
    out = []
    for h in kayit:
        if h["tur"] != "odeme":
            continue
        v = h["veri"]
        k = v.get("konu") or {}
        if k.get("tip") != konu_tip:
            continue
        nereden = None
        if C is not None:   # NEREDEN ödendi: hangi kasa/banka cebi, hangi kart (sahip: "neyin nerede olduğunu bulabilelim")
            nereden = ([{"ad": (C.get(p["cep"]) or {}).get("ad") or p["cep"], "tur": "kasa", "tutar": _tl_sayi(int(p["tutar"]))}
                        for p in (v.get("parcalar") or [])]
                       + [{"ad": p.get("kart_ad") or "kart", "tur": "kart", "tutar": _tl_sayi(int(p["tutar"]))}
                          for p in (v.get("kart_parcalar") or [])])
        out.append({"id": h["id"], "tarih": h["is_gunu"], "ait_ay": v.get("ait_ay"), "ay": (v.get("ait_ay") or h["is_gunu"])[:7],
                    "donem": k.get("donem"), "toplam": int(v.get("toplam", h["tutar"])), "konu": k, "kalem": k.get("kalem"),
                    "kaynak": v.get("kaynak"), "aciklama": v.get("aciklama"), "kim": h.get("kaydeden"), "kartla": bool(v.get("kart_parcalar")),
                    "nereden": nereden, "kredi_id": k.get("kredi_id"), "kart_id": k.get("kart_id"), "sube_id": k.get("sube_id"),
                    "personel_id": k.get("personel_id"), "toptanci_id": k.get("toptanci_id"),
                    "zaman": h.get("kayit_zamani")})   # B54: aynı gün teyit/ödeme sırası (kart takvimi)
    return out


def kart_harcamalari(cur, kart_id: str) -> list:
    """PUBLIC servis (Faturaları dağıt — 'benzer kayıt var mı'): bir kartla yapılmış bütün ödeme parçaları, tek okuma.
    Her satır: tarih, tutar (kuruş), aciklama."""
    _, _, kayit, _ = _yukle(cur, tum_donemler=True)
    out = []
    for h in kayit:
        if h["tur"] != "odeme":
            continue
        for p in h["veri"].get("kart_parcalar") or []:
            if str(p.get("kart_id")) == str(kart_id):
                out.append({"tarih": h["is_gunu"], "tutar": int(p["tutar"]), "aciklama": h["veri"].get("aciklama")})
    return out
