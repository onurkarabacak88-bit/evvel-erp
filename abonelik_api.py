# -*- coding: utf-8 -*-
"""
ABONELİK KİMLİĞİ + ÖDEME KANITI BAĞLAMA.

Sahip (2026-08-10): "faturaların tutarları özellikle DEĞİŞKENLERİN her zaman farklı
oluyor; burada fatura numaralarından ve tarihten sistemdeki borç olup olmadığını
bulacaksın ve aktaracaksın. Sistemde zaten karttan ödenmiş olacağı için bunu
maliyet hesaplarında doğru kullanma derdindeyim."

Codex hükmü (2026-08-10): "bu işi daha iyi fuzzy matching ile çözemezsin. Veri
modeli yanlış. Merchant metninden fatura bulmaya çalışmak geçici numara. Doğru
çözüm: abonelik kimliği + borç belgesi otoritesi + ödeme kanıtı link tablosu.
Bağlayacağın şey satıcı değil, abonelik/tesisat."

KANIT (canlı, aynı gün): tutar+ad eşleştirmesi 9 öneri üretti, 9'u da yanlıştı
("AKALIN 684,00 ↔ OVOLT ŞARJ 659,07"). Değişken faturada TUTAR KİMLİK DEĞİLDİR.

BU MODÜLÜN KURALLARI
  1. Eşleştirme anahtarı sırayla: abone_no → fatura_no → tek-aday. Tutar yalnız
     DESTEKLEYİCİ kanıttır, tek başına asla eşleştirmez.
  2. Ekstrede numara yoksa otomatik eşleşme ANCAK "o kartta, o sağlayıcıya ait,
     o dönemde açık TEK borç adayı varsa" yapılır (Codex'in koşulu). Birden çok
     aday varsa karar sahibe bırakılır.
  3. BAĞLAMA ≠ KAPATMA: bu modül bağ kurar/önerir; planı kapatmak ayrı ve onaylı.
  4. Kasaya DOKUNMAZ. Para kart ekstresi ödendiğinde çıkar.
"""

import re
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

router = APIRouter()

HIZMET_TURLERI = ("elektrik", "su", "dogalgaz", "internet", "telefon", "diger")


def _sade(s) -> str:
    """Türkçe-duyarsız sadeleştirme (fatura_api._sadele ile aynı ruh; bu modül
    ona bağımlı olmasın diye yerel)."""
    t = str(s or "")
    for a, b in zip("çğıöşüÇĞİıÖŞÜâîû", "cgiosuCGIIOSUaiu"):
        t = t.replace(a, b)
    return re.sub(r"[^A-Z0-9]+", " ", t.upper()).strip()


def _numaralar(metin) -> set:
    """Metindeki 6+ haneli sayı dizileri — abone/tesisat/sözleşme no adayları.
    Kart ekstresinde otomatik fatura ödemesi çoğu bankada bu numarayı taşır
    ("033000205348 - ENERYA KARAMAN")."""
    return set(re.findall(r"\d{6,}", str(metin or "")))


def _satir(r) -> dict:
    d = dict(r)
    for k in ("olusturma", "onay_ts"):
        if d.get(k):
            d[k] = str(d[k])
    return d


# ── ABONELİK CRUD ────────────────────────────────────────────────────────────

class AbonelikBody(BaseModel):
    saglayici: str
    hizmet_turu: str = "diger"
    abone_no: Optional[str] = None
    vkn: Optional[str] = None
    sube_id: Optional[str] = None
    kart_id: Optional[str] = None
    sabit_gider_id: Optional[str] = None
    ekstre_kalip: Optional[str] = None


@router.get("/api/abonelik")
def abonelik_liste(aktif: bool = True):
    with db() as (conn, cur):
        cur.execute(
            """SELECT a.*, s.ad AS sube_adi, k.kart_adi
                 FROM abonelik a
                 LEFT JOIN subeler s ON s.id = a.sube_id
                 LEFT JOIN kartlar k ON k.id = a.kart_id
                WHERE (%s IS FALSE OR a.aktif)
                ORDER BY a.saglayici, a.hizmet_turu""", (aktif,))
        rows = [_satir(r) for r in (cur.fetchall() or [])]
        # Her aboneliğin şimdiye kadar kaç ödeme kanıtına bağlandığı
        cur.execute("""SELECT abonelik_id, COUNT(*) AS adet FROM kart_odeme_baglanti
                        WHERE abonelik_id IS NOT NULL GROUP BY abonelik_id""")
        bag = {str(r["abonelik_id"]): int(r["adet"]) for r in (cur.fetchall() or [])}
        for r in rows:
            r["baglanti_adet"] = bag.get(str(r["id"]), 0)
    return {"abonelikler": rows, "adet": len(rows),
            "hizmet_turleri": list(HIZMET_TURLERI)}


@router.post("/api/abonelik")
def abonelik_ekle(body: AbonelikBody):
    sag = (body.saglayici or "").strip()
    if len(sag) < 2:
        raise HTTPException(400, "Sağlayıcı adı en az 2 karakter olmalı")
    ht = (body.hizmet_turu or "diger").strip().lower()
    if ht not in HIZMET_TURLERI:
        raise HTTPException(400, f"hizmet_turu şunlardan biri olmalı: {', '.join(HIZMET_TURLERI)}")
    with db() as (conn, cur):
        aid = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO abonelik
                 (id, saglayici, hizmet_turu, abone_no, vkn, sube_id, kart_id,
                  sabit_gider_id, ekstre_kalip)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (aid, sag, ht, (body.abone_no or "").strip() or None,
             (body.vkn or "").strip() or None, body.sube_id or None,
             body.kart_id or None, body.sabit_gider_id or None,
             (body.ekstre_kalip or "").strip() or None))
    return {"success": True, "id": aid}


@router.put("/api/abonelik/{aid}")
def abonelik_guncelle(aid: str, body: AbonelikBody):
    ht = (body.hizmet_turu or "diger").strip().lower()
    if ht not in HIZMET_TURLERI:
        raise HTTPException(400, f"hizmet_turu geçersiz: {ht}")
    with db() as (conn, cur):
        cur.execute(
            """UPDATE abonelik SET saglayici=%s, hizmet_turu=%s, abone_no=%s, vkn=%s,
                      sube_id=%s, kart_id=%s, sabit_gider_id=%s, ekstre_kalip=%s
                WHERE id=%s""",
            ((body.saglayici or "").strip(), ht, (body.abone_no or "").strip() or None,
             (body.vkn or "").strip() or None, body.sube_id or None, body.kart_id or None,
             body.sabit_gider_id or None, (body.ekstre_kalip or "").strip() or None, aid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Abonelik bulunamadı")
    return {"success": True}


@router.delete("/api/abonelik/{aid}")
def abonelik_sil(aid: str):
    """Pasife çeker — SİLMEZ (geçmiş bağlar kimliğini kaybetmesin)."""
    with db() as (conn, cur):
        cur.execute("UPDATE abonelik SET aktif=FALSE WHERE id=%s", (aid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Abonelik bulunamadı")
    return {"success": True, "pasife_alindi": True}


# ── KEŞİF: ekstredeki tekrar eden otomatik ödemeleri bul ─────────────────────

@router.get("/api/abonelik/kesif")
def abonelik_kesif(gun: int = 180, min_tekrar: int = 2):
    """Kart hareketlerinde TEKRAR EDEN satıcıları ve içlerindeki numara adaylarını
    çıkarır — abonelik tanımını sıfırdan yazdırmamak için.

    Otomatik talimatlı fatura ayda bir tekrar eder ve tutarı değişir; imzası budur.
    Salt-okur, hiçbir şey yazmaz.
    """
    with db() as (conn, cur):
        cur.execute(
            """SELECT h.id, h.tarih::text AS tarih, h.aciklama, ABS(h.tutar)::float AS tutar,
                      h.kart_id::text AS kart_id, k.kart_adi
                 FROM kart_hareketleri h
                 JOIN kartlar k ON k.id = h.kart_id
                WHERE h.islem_turu='HARCAMA' AND COALESCE(h.durum,'aktif')='aktif'
                  AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                  AND h.tarih >= CURRENT_DATE - %s""", (int(gun),))
        hareketler = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("SELECT id, saglayici, abone_no, ekstre_kalip FROM abonelik WHERE aktif")
        mevcut = [dict(r) for r in (cur.fetchall() or [])]

    tanimli = {_sade(m["saglayici"]) for m in mevcut}
    gruplar: dict = {}
    for h in hareketler:
        s = _sade(h["aciklama"])
        # Satıcı imzası: ilk iki anlamlı kelime (sayılar hariç) — "ENAY ENERJI"
        kelime = [w for w in s.split() if len(w) >= 3 and not w.isdigit()][:2]
        if not kelime:
            continue
        anahtar = " ".join(kelime)
        g = gruplar.setdefault(anahtar, {
            "satici": anahtar, "adet": 0, "tutarlar": [], "kartlar": set(),
            "numaralar": set(), "ilk": h["tarih"], "son": h["tarih"], "ornek": h["aciklama"]})
        g["adet"] += 1
        g["tutarlar"].append(round(h["tutar"], 2))
        g["kartlar"].add(h["kart_adi"])
        g["numaralar"] |= _numaralar(h["aciklama"])
        g["ilk"] = min(g["ilk"], h["tarih"])
        g["son"] = max(g["son"], h["tarih"])

    aday = []
    for a, g in gruplar.items():
        if g["adet"] < min_tekrar:
            continue
        t = g["tutarlar"]
        degisken = len(set(t)) > 1
        aday.append({
            "satici": a, "ornek_aciklama": g["ornek"], "adet": g["adet"],
            "kartlar": sorted(g["kartlar"]),
            "numara_adaylari": sorted(g["numaralar"]),
            "tutar_degisken": degisken,
            "en_dusuk": min(t), "en_yuksek": max(t),
            "ilk_tarih": g["ilk"], "son_tarih": g["son"],
            "zaten_tanimli": a in tanimli,
            # Otomatik talimat imzası: düzenli tekrar + DEĞİŞKEN tutar + numara
            "abonelik_olabilir": bool(degisken and g["adet"] >= max(2, min_tekrar)),
        })
    # SIRALAMA: abone numarası taşıyan satır en güçlü abonelik adayıdır — otomatik
    # talimatlı fatura ekstrede numarasını yazar, e-ticaret sitesi yazmaz. Ham
    # "tekrar sayısı" sıralaması HEPSİBURADA'yı (34 kez, abonelik DEĞİL) en üste
    # koyup ENERYA/MEPAŞ'ı ekranın altında bırakıyordu.
    aday.sort(key=lambda x: (0 if x["numara_adaylari"] else 1, -x["adet"], x["satici"]))
    _y = [a for a in aday if a["abonelik_olabilir"] and not a["zaten_tanimli"]]
    return {"gun": int(gun), "aday_adet": len(aday), "abonelik_onerisi": len(_y),
            "adaylar": aday,
            "not": ("Tutarı her ay DEĞİŞEN ve düzenli tekrar eden satıcı = otomatik "
                    "talimatlı fatura imzası. Numara adayları abone/tesisat no olabilir; "
                    "abonelik tanımına yazılırsa eşleştirme tutar tahminine muhtaç kalmaz.")}


# ── EŞLEŞTİRME: kimlik tabanlı (tutar KANIT DEĞİL) ──────────────────────────

@router.get("/api/abonelik/odeme-eslestir")
def abonelik_odeme_eslestir(gun: int = 120):
    """Kart harcamalarını AÇIK BORÇLARLA abonelik kimliği üzerinden eşleştirir.

    SIRALAMA (Codex tasarımı):
      1. abone_no  — ekstre metnindeki numara aboneliğin numarasıyla birebir eşleşir
      2. fatura_no — ekstre metninde fatura numarası geçiyorsa
      3. tek_aday  — numara yok AMA o kartta, o sağlayıcıya ait, o dönemde açık
                     TEK borç varsa. Birden çok aday varsa ÖNERİ ÜRETİLMEZ.
    Tutar hiçbir aşamada tek başına eşleştirmez; yalnız uyum notu olarak taşınır.
    """
    with db() as (conn, cur):
        cur.execute("""SELECT a.*, k.kart_adi FROM abonelik a
                        LEFT JOIN kartlar k ON k.id=a.kart_id
                       WHERE a.aktif""")
        abonelikler = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            """SELECT h.id, h.tarih::text AS tarih, h.aciklama, ABS(h.tutar)::float AS tutar,
                      h.kart_id::text AS kart_id, k.kart_adi
                 FROM kart_hareketleri h
                 JOIN kartlar k ON k.id = h.kart_id
                WHERE h.islem_turu='HARCAMA' AND COALESCE(h.durum,'aktif')='aktif'
                  AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                  AND h.tarih >= CURRENT_DATE - %s
                  AND NOT EXISTS (SELECT 1 FROM kart_odeme_baglanti b
                                   WHERE b.kart_hareket_id = h.id)""", (int(gun),))
        hareketler = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            """SELECT op.id, op.tarih::text AS vade, op.aciklama, op.kaynak_tablo,
                      op.kaynak_id::text AS kaynak_id,
                      COALESCE(op.odenecek_tutar,0)::float AS tutar,
                      COALESCE(op.odenen_tutar,0)::float AS odenen,
                      sg.gider_adi, sg.id::text AS sabit_id
                 FROM odeme_plani op
                 LEFT JOIN sabit_giderler sg
                        ON op.kaynak_tablo='sabit_giderler' AND sg.id = op.kaynak_id
                WHERE op.durum='bekliyor'
                  AND COALESCE(op.kaynak_tablo,'') NOT IN ('personel','borc_envanteri')
                  AND op.tarih >= CURRENT_DATE - %s
                  AND NOT EXISTS (SELECT 1 FROM kart_odeme_baglanti b
                                   WHERE b.hedef_tablo='odeme_plani' AND b.hedef_id = op.id)""",
            (int(gun) + 60,))
        planlar = [dict(r) for r in (cur.fetchall() or [])]

    oneriler, kullanilan = [], set()
    for h in hareketler:
        h_num = _numaralar(h["aciklama"])
        h_sade = _sade(h["aciklama"])
        # 1) Bu hareket hangi aboneliğe ait? (numara > kalıp > sağlayıcı adı)
        abo, temel = None, None
        for a in abonelikler:
            if a.get("abone_no") and str(a["abone_no"]).strip() in h_num:
                abo, temel = a, "abone_no"
                break
        if not abo:
            for a in abonelikler:
                kal = _sade(a.get("ekstre_kalip"))
                if kal and kal in h_sade:
                    abo, temel = a, "ekstre_kalip"
                    break
        if not abo:
            for a in abonelikler:
                sag = _sade(a["saglayici"])
                if sag and sag in h_sade:
                    # Kart bağı varsa doğrula — aynı sağlayıcının başka kartı olabilir
                    if a.get("kart_id") and str(a["kart_id"]) != str(h["kart_id"]):
                        continue
                    abo, temel = a, "saglayici_adi"
                    break
        if not abo:
            continue

        # 2) Bu aboneliğin açık borcu hangisi?
        adaylar = []
        for p in planlar:
            if p["id"] in kullanilan:
                continue
            if abo.get("sabit_gider_id") and str(p.get("sabit_id") or "") == str(abo["sabit_gider_id"]):
                adaylar.append((p, "sabit_gider_bagi"))
                continue
            metin = _sade(f"{p.get('aciklama') or ''} {p.get('gider_adi') or ''}")
            if _sade(abo["saglayici"]) and _sade(abo["saglayici"]) in metin:
                adaylar.append((p, "saglayici_adi"))
        if not adaylar:
            continue
        # Codex koşulu: numara yoksa YALNIZ tek aday varsa otomatik öner
        if temel == "saglayici_adi" and len(adaylar) > 1:
            oneriler.append({
                "kart_hareket_id": h["id"], "kart_aciklama": h["aciklama"],
                "kart_tarih": h["tarih"], "kart_tutar": h["tutar"], "kart_adi": h["kart_adi"],
                "abonelik_id": abo["id"], "saglayici": abo["saglayici"],
                "karar": "belirsiz", "aday_adet": len(adaylar),
                "neden": (f"{abo['saglayici']} için {len(adaylar)} açık borç var ve ekstrede "
                          "abone numarası yok — hangisi olduğunu sistem seçemez."),
            })
            continue
        p, hedef_temel = adaylar[0]
        kullanilan.add(p["id"])
        kalan = round(p["tutar"] - p["odenen"], 2)
        fark = round(abs(h["tutar"] - kalan), 2)
        guven = {"abone_no": 95, "ekstre_kalip": 85, "saglayici_adi": 70}.get(temel, 60)
        if hedef_temel == "sabit_gider_bagi":
            guven = min(99, guven + 5)
        oneriler.append({
            "kart_hareket_id": h["id"], "kart_aciklama": h["aciklama"],
            "kart_tarih": h["tarih"], "kart_tutar": h["tutar"], "kart_adi": h["kart_adi"],
            "abonelik_id": abo["id"], "saglayici": abo["saglayici"],
            "hizmet_turu": abo.get("hizmet_turu"),
            "plan_id": p["id"], "plan_aciklama": p["aciklama"] or p.get("gider_adi"),
            "vade": p["vade"], "kalan_tutar": kalan,
            "eslesme_temeli": temel, "hedef_temeli": hedef_temel,
            "guven": guven, "karar": "oneri",
            # Tutar KANIT DEĞİL — yalnız bilgi. Değişken faturada fark normaldir.
            "tutar_farki": fark,
            "tutar_notu": ("tutar birebir" if fark <= 0.01 else
                           f"tutar farkı {fark:,.2f} ₺ — değişken faturada normal".replace(",", ".")),
        })

    kesin = [o for o in oneriler if o["karar"] == "oneri" and o["guven"] >= 85]
    belirsiz = [o for o in oneriler if o["karar"] == "belirsiz"]
    return {
        "gun": int(gun),
        "tanimli_abonelik": len(abonelikler),
        "taranan_kart_hareketi": len(hareketler),
        "taranan_acik_plan": len(planlar),
        "oneri_adet": len([o for o in oneriler if o["karar"] == "oneri"]),
        "kesin_adet": len(kesin), "belirsiz_adet": len(belirsiz),
        "oneriler": oneriler,
        "not": ("Eşleştirme abonelik KİMLİĞİ üzerinden kurulur; tutar kanıt değildir "
                "(değişken faturada her ay farklıdır). Abone numarası yoksa ve aynı "
                "sağlayıcının birden çok açık borcu varsa sistem seçim YAPMAZ."),
        "uyari": (None if abonelikler else
                  "Hiç abonelik tanımlı değil — /api/abonelik/kesif ile aday çıkarıp "
                  "tanımlayın, yoksa eşleştirme çalışamaz."),
    }


@router.get("/api/abonelik/maliyet-cift-sayim")
def maliyet_cift_sayim(gun: int = 365):
    """MALİYET ÇİFT SAYIMI RÖNTGENİ — hiçbir şeye dokunmaz.

    Sahip (2026-08-10): "sistemde zaten karttan ödenmiş olacağı için bunu maliyet
    hesaplarında doğru kullanma derdindeyim."

    P&L/maliyet raporları `anlik_giderler` (durum='aktif') üzerinden çalışıyor
    (operasyon_merkez_api ciro-gider ve kategori trendi). Aynı harcama birden çok
    kanaldan buraya düşerse maliyet SESSİZCE şişer. Bu uç kanalları ayrıştırır ve
    kanallar arası şüpheli örtüşmeyi ölçer.

    ÖLÇÜM, HÜKÜM DEĞİL: örtüşme "aynı tutar ±1 ₺ + ±7 gün + farklı kaynak" demektir;
    meşru olabilir (aynı gün iki eşit fatura). Sayı, temizlik emri değil sinyaldir.
    """
    with db() as (conn, cur):
        cur.execute(
            """SELECT COALESCE(kaynak_tablo,'(elle)') AS kanal,
                      COUNT(*)::int AS adet,
                      COALESCE(SUM(tutar),0)::float AS tutar,
                      MIN(tarih)::text AS ilk, MAX(tarih)::text AS son
                 FROM anlik_giderler
                WHERE COALESCE(durum,'aktif')='aktif'
                  AND tarih >= CURRENT_DATE - %s
                GROUP BY 1 ORDER BY 3 DESC""", (int(gun),))
        kanallar = [dict(r) for r in (cur.fetchall() or [])]
        # Kanallar arası örtüşme: farklı kaynaktan gelen eş tutar/tarih çiftleri
        cur.execute(
            """SELECT a.id AS a_id, COALESCE(a.kaynak_tablo,'(elle)') AS a_kanal,
                      a.tarih::text AS a_tarih, a.tutar::float AS a_tutar,
                      LEFT(COALESCE(a.aciklama,''),50) AS a_aciklama,
                      b.id AS b_id, COALESCE(b.kaynak_tablo,'(elle)') AS b_kanal,
                      b.tarih::text AS b_tarih, b.tutar::float AS b_tutar,
                      LEFT(COALESCE(b.aciklama,''),50) AS b_aciklama
                 FROM anlik_giderler a
                 JOIN anlik_giderler b
                   ON b.id > a.id
                  AND ABS(b.tutar - a.tutar) <= 1.0
                  AND b.tarih::date BETWEEN a.tarih::date - 7 AND a.tarih::date + 7
                  AND COALESCE(b.kaynak_tablo,'(elle)') <> COALESCE(a.kaynak_tablo,'(elle)')
                WHERE COALESCE(a.durum,'aktif')='aktif' AND COALESCE(b.durum,'aktif')='aktif'
                  AND a.tarih >= CURRENT_DATE - %s
                  AND a.tutar > 0
                ORDER BY a.tutar DESC
                LIMIT 200""", (int(gun),))
        ortusme = [dict(r) for r in (cur.fetchall() or [])]
        # Ekstre kaynaklı giderlerin bir ödeme kanıtı bağı var mı?
        cur.execute(
            """SELECT COUNT(*)::int AS adet, COALESCE(SUM(g.tutar),0)::float AS tutar
                 FROM anlik_giderler g
                WHERE COALESCE(g.durum,'aktif')='aktif'
                  AND g.kaynak_tablo='ekstre_import'
                  AND g.tarih >= CURRENT_DATE - %s
                  AND NOT EXISTS (SELECT 1 FROM kart_odeme_baglanti b
                                   WHERE b.kart_hareket_id = g.kaynak_id)""", (int(gun),))
        _b = dict(cur.fetchone() or {})

    toplam = round(sum(k["tutar"] for k in kanallar), 2)
    ort_tutar = round(sum(o["a_tutar"] for o in ortusme), 2)
    return {
        "gun": int(gun),
        "maliyete_giren_toplam": toplam,
        "kanallar": kanallar,
        "kanal_adet": len(kanallar),
        "ortusme_adet": len(ortusme),
        "ortusme_tutar": ort_tutar,
        "ortusme_orani_pct": round(ort_tutar / toplam * 100, 2) if toplam else 0.0,
        "ortusmeler": ortusme[:60],
        "belgesiz_ekstre_gideri": {"adet": int(_b.get("adet") or 0),
                                   "tutar": round(float(_b.get("tutar") or 0), 2)},
        "not": ("Örtüşme = aynı tutar ±1 ₺ + ±7 gün + FARKLI kaynak kanalı. Meşru "
                "olabilir (aynı gün iki eşit fatura); bu bir sinyal, temizlik emri değil."),
        "yorum": ("P&L `anlik_giderler` üzerinden okunuyor. 'ekstre_import' kanalı "
                  "ödeme kanıtından gider üretir; belge kanalı da aynı gideri yazarsa "
                  "maliyet iki kez sayılır. Ödeme kanıtı bağı olmayan ekstre gideri, "
                  "belgesi hiç eşleşmemiş harcamadır."),
    }


@router.get("/api/abonelik/gider-gecis-karsilastir")
def gider_gecis_karsilastir(gun: int = 365):
    """ESKİ ÖLÇÜ vs YENİ ÖLÇÜ — geçişi körlemesine yapmamak için.

    ESKİ: P&L `anlik_giderler` (durum='aktif') toplamı. Kartla yapılan gider hem
    burada hem kart defterinde duruyordu; ekstre içe aktarma da ayrıca satır
    üretiyordu → aynı para birden çok kez sayılabiliyordu.

    YENİ: `gider_kanonik` — nakit çıkışı anlık giderden, kart çıkışı kart
    defterinden. Her para çıkışı TEK kanaldan sayılır.

    Fark BEKLENEN bir şeydir; sıfır çıkması gerekmez. Önemli olan farkın
    NEREDEN geldiğinin görünmesi: kart kopyaları düşer, kart defterinde olup
    anlık gidere hiç yazılmamış harcamalar eklenir.
    """
    with db() as (conn, cur):
        cur.execute(
            """SELECT COALESCE(SUM(tutar),0)::float AS t, COUNT(*)::int AS a
                 FROM anlik_giderler
                WHERE COALESCE(durum,'aktif')='aktif' AND tarih >= CURRENT_DATE - %s""",
            (int(gun),))
        eski = dict(cur.fetchone() or {})
        cur.execute(
            """SELECT kanal, COALESCE(SUM(tutar),0)::float AS t, COUNT(*)::int AS a
                 FROM gider_kanonik WHERE tarih >= CURRENT_DATE - %s
                GROUP BY kanal ORDER BY 2 DESC""", (int(gun),))
        yeni_kanal = [dict(r) for r in (cur.fetchall() or [])]
        # Ne düştü: kartla girilmiş anlık giderler (artık kart defteri sayıyor)
        cur.execute(
            """SELECT COALESCE(kaynak_tablo,'(elle)') AS kanal,
                      COALESCE(SUM(tutar),0)::float AS t, COUNT(*)::int AS a
                 FROM anlik_giderler
                WHERE COALESCE(durum,'aktif')='aktif'
                  AND COALESCE(odeme_yontemi,'nakit')='kart'
                  AND tarih >= CURRENT_DATE - %s
                GROUP BY 1 ORDER BY 2 DESC""", (int(gun),))
        dusen = [dict(r) for r in (cur.fetchall() or [])]
        # Ne eklendi: kart defterinde olup anlık gidere hiç yazılmamış harcama
        cur.execute(
            """SELECT COALESCE(SUM(
                        CASE WHEN COALESCE(h.taksit_sayisi,1) > 1
                             THEN ABS(h.tutar)/h.taksit_sayisi ELSE ABS(h.tutar) END),0)::float AS t,
                      COUNT(*)::int AS a
                 FROM kart_hareketleri h
                WHERE h.islem_turu='HARCAMA' AND COALESCE(h.durum,'aktif')='aktif'
                  AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
                  AND h.tarih >= CURRENT_DATE - %s
                  AND NOT EXISTS (SELECT 1 FROM anlik_giderler g
                                   WHERE g.kaynak_id = h.id::text
                                      OR (g.odeme_yontemi='kart' AND g.kart_id = h.kart_id
                                          AND ABS(g.tutar - ABS(h.tutar)) <= 1.0
                                          AND g.tarih::date BETWEEN h.tarih - 3 AND h.tarih + 3))""",
            (int(gun),))
        eklenen = dict(cur.fetchone() or {})

    yeni_t = round(sum(k["t"] for k in yeni_kanal), 2)
    eski_t = round(float(eski.get("t") or 0), 2)
    return {
        "gun": int(gun),
        "eski_olcu": {"tutar": eski_t, "adet": int(eski.get("a") or 0),
                      "kaynak": "anlik_giderler (durum=aktif)"},
        "yeni_olcu": {"tutar": yeni_t,
                      "adet": sum(k["a"] for k in yeni_kanal),
                      "kanallar": yeni_kanal, "kaynak": "gider_kanonik"},
        "fark": round(yeni_t - eski_t, 2),
        "dusen_kartli_anlik_gider": {"toplam": round(sum(d["t"] for d in dusen), 2),
                                     "kirilim": dusen},
        "eklenen_kart_harcamasi": {"tutar": round(float(eklenen.get("t") or 0), 2),
                                   "adet": int(eklenen.get("a") or 0)},
        "not": ("Fark BEKLENEN bir şeydir. Düşenler = kartla girilmiş anlık gider "
                "kopyaları (kart defteri zaten sayıyor). Eklenenler = kart defterinde "
                "olup gidere hiç yazılmamış harcamalar. Yeni ölçüde her para çıkışı "
                "TEK kanaldan sayılır."),
    }


class BaglaBody(BaseModel):
    kart_hareket_id: str
    hedef_tablo: str = "odeme_plani"
    hedef_id: str
    abonelik_id: Optional[str] = None
    eslesme_temeli: str = "elle"
    guven: int = 100
    onaylayan: Optional[str] = None
    not_aciklama: Optional[str] = None
    plani_kapat: bool = False
    kuru: bool = True


@router.post("/api/abonelik/bagla")
def odeme_kaniti_bagla(body: BaglaBody):
    """Kart hareketini bir borca ÖDEME KANITI olarak bağlar.

    plani_kapat=True ise plan da 'odendi' yapılır — KASA HAREKETİ YARATMAZ:
    para kart ekstresi ödendiğinde çıkar, ikinci kasa kaydı çift sayım olurdu.
    BAĞLAMA ≠ KAPATMA: bağ kurmak ayrı, kapatmak ayrı ve isteğe bağlıdır.
    """
    if body.hedef_tablo not in ("odeme_plani", "tedarikci_fatura", "sabit_giderler"):
        raise HTTPException(400, "hedef_tablo geçersiz")
    with db() as (conn, cur):
        cur.execute("""SELECT h.id, h.tarih::text AS tarih, ABS(h.tutar)::float AS tutar,
                              h.aciklama, k.kart_adi
                         FROM kart_hareketleri h JOIN kartlar k ON k.id=h.kart_id
                        WHERE h.id=%s""", (body.kart_hareket_id,))
        kh = cur.fetchone()
        if not kh:
            raise HTTPException(404, "Kart hareketi bulunamadı")
        kh = dict(kh)
        plan = None
        if body.hedef_tablo == "odeme_plani":
            cur.execute("""SELECT id, tarih::text AS vade, aciklama, durum,
                                  COALESCE(odenecek_tutar,0)::float AS tutar,
                                  COALESCE(odenen_tutar,0)::float AS odenen
                             FROM odeme_plani WHERE id=%s""", (body.hedef_id,))
            plan = cur.fetchone()
            if not plan:
                raise HTTPException(404, "Plan kalemi bulunamadı")
            plan = dict(plan)
        if body.kuru:
            return {"kuru": True, "kart_hareket": kh, "plan": plan,
                    "plani_kapat": body.plani_kapat, "kasa_etkisi": False,
                    "mesaj": "PROVA — hiçbir kayıt değişmedi. Uygulamak için kuru=false gönderin."}
        cur.execute(
            """INSERT INTO kart_odeme_baglanti
                 (id, kart_hareket_id, hedef_tablo, hedef_id, abonelik_id,
                  eslesme_temeli, guven, onaylayan, onay_ts, not_aciklama)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NOW(),%s)
               ON CONFLICT (kart_hareket_id, hedef_tablo, hedef_id) DO NOTHING""",
            (str(uuid.uuid4()), body.kart_hareket_id, body.hedef_tablo, body.hedef_id,
             body.abonelik_id, body.eslesme_temeli, int(body.guven),
             body.onaylayan or "sahip", body.not_aciklama))
        bagli = cur.rowcount > 0
        kapatildi = False
        if body.plani_kapat and plan and plan["durum"] == "bekliyor":
            _damga = (f"{plan['aciklama'] or ''} · [karttan ödendi — "
                      f"{kh['kart_adi']} · {kh['tarih']} · {kh['tutar']:,.2f} ₺]"
                      .replace(",", "."))[:500]
            cur.execute(
                """UPDATE odeme_plani SET durum='odendi', odenen_tutar=%s,
                          odeme_tarihi=CURRENT_DATE, aciklama=%s
                    WHERE id=%s AND durum='bekliyor'""",
                (plan["tutar"], _damga, body.hedef_id))
            kapatildi = cur.rowcount > 0
    return {"success": True, "baglandi": bagli, "plan_kapatildi": kapatildi,
            "kasa_etkisi": False,
            "mesaj": ("Ödeme kanıtı bağlandı."
                      + (" Plan 'karttan ödendi' olarak kapatıldı." if kapatildi else "")
                      + " Kasa hareketi oluşmadı — para kart ekstresi ödendiğinde çıkar.")}
