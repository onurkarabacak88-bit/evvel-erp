# -*- coding: utf-8 -*-
"""
AVANS SERVİSİ — personel avansının TEK MERKEZİ ("mini bordro-finans köprüsü").

İLKE (kullanıcı + GPT ortak kararı, 2026-07-04):
  Avans ayrı bir borç modülü DEĞİL; maaşın erken ödenmiş, izli ve onaylı parçasıdır.

MİMARİ SINIRLAR (sert kural):
  - Kasa izini (PERSONEL_AVANS) SADECE bu servis yazar.
  - maas_service avansı yalnızca MAHSUP KALEMİ olarak OKUR (donem_odenen_avans /
    devir hesapları) — maaş motorunun kasa hareketi üretme yetkisi YOKTUR.
  - main.py'ye avans endpoint'i yazılmaz; hepsi bu modülün router'ında.

KURALLAR:
  - TAVAN = min(bu ay bugüne kadar hakediş × %50, beklenen aylık net × %30, sabit limit)
            − bu dönemki aktif avanslar (bekleyenler dahil).
  - Durum makinesi: talep → onaylandi(elden) → teslim_edildi → odendi
                    talep → odendi (havale: onay anı = ödeme anı, kasa izi o an)
                    talep/onaylandi → reddedildi | iptal  (para çıkmadıysa serbest)
    ÖDENDİ/TESLİM SONRASI İPTAL YOK → ters_kayit (ters kasa izi + düzeltme hareketi).
  - ELDEN teslim: kasa izi teslim anında yazılır (para fiilen çıkar) + şube günlük
    kapanış hesabına anlik_giderler satırı düşülür (kapanış farkı yemez) + personelin
    QR "aldım" onayı beklenir (çift imza). Onay gelmese de para çıktı = mahsuba girer.
  - Dönem ataması: içinde bulunulan çalışma ayı; o ayın maaş kaydı onaylandı/ödendiyse
    avans SONRAKİ döneme yazılır (dönem kilidi).
  - Append-only: personel_avans satırı silinmez; her geçiş personel_avans_events'e yazılır.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from tr_saat import bugun_tr
from kasa_service import insert_kasa_hareketi, audit
import maas_service as _maas

logger = logging.getLogger("avans_service")
router = APIRouter(tags=["avans"])

# ── SABİTLER (kullanıcı+GPT kararı) ────────────────────────────
AVANS_HAKEDIS_ORAN = 0.50   # bugüne kadar hakedişin %50'si
AVANS_NET_ORAN = 0.30       # beklenen aylık netin %30'u (örn. 30.000 maaş → 9.000 üst)
AVANS_SABIT_TAVAN = 20000.0 # mutlak üst sınır (panelden ayarlanabilir hale getirilebilir)

_AKTIF_DURUMLAR = ("talep", "onaylandi", "teslim_edildi", "odendi")  # tavana sayılan
_PARALI_DURUMLAR = ("teslim_edildi", "odendi")  # kasa izi yazılmış = mahsuba giren


# ── TABLO GARANTİSİ (idempotent, process-cache) ────────────────
_TABLO_OK = False


def _tablolar_garantile(cur) -> None:
    global _TABLO_OK
    if _TABLO_OK:
        return
    cur.execute("""
        CREATE TABLE IF NOT EXISTS personel_avans (
            id            TEXT PRIMARY KEY,
            personel_id   TEXT NOT NULL,
            tutar         NUMERIC(14,2) NOT NULL,
            durum         TEXT NOT NULL DEFAULT 'talep',
            odeme_yontemi TEXT,
            sube_id       TEXT,
            donem_yil     INT NOT NULL,
            donem_ay      INT NOT NULL,
            talep_ts      TIMESTAMPTZ DEFAULT NOW(),
            onay_ts       TIMESTAMPTZ,
            teslim_ts     TIMESTAMPTZ,
            odeme_ts      TIMESTAMPTZ,
            onaylayan     TEXT,
            not_aciklama  TEXT,
            anlik_gider_id TEXT,
            ters_ref      TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS personel_avans_events (
            id       TEXT PRIMARY KEY,
            avans_id TEXT NOT NULL,
            ts       TIMESTAMPTZ DEFAULT NOW(),
            event    TEXT NOT NULL,
            detay    TEXT
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS ix_pavans_pid_donem ON personel_avans(personel_id, donem_yil, donem_ay)")
    cur.execute("CREATE INDEX IF NOT EXISTS ix_pavans_durum ON personel_avans(durum)")
    # Bordro mahsup snapshot kolonları (maas_service yazar, burada garanti edilir)
    cur.execute("ALTER TABLE personel_aylik ADD COLUMN IF NOT EXISTS avans_mahsup NUMERIC(14,2) DEFAULT 0")
    cur.execute("ALTER TABLE personel_aylik ADD COLUMN IF NOT EXISTS mahsup_devir NUMERIC(14,2) DEFAULT 0")
    _TABLO_OK = True


def _event(cur, avans_id: str, event: str, detay: Optional[dict] = None) -> None:
    cur.execute(
        "INSERT INTO personel_avans_events (id, avans_id, event, detay) VALUES (%s,%s,%s,%s)",
        (str(uuid.uuid4()), avans_id, event, json.dumps(detay or {}, ensure_ascii=False, default=str)),
    )


# ── OKUMA API'Sİ (maas_service buradan OKUR — tek yön) ─────────

def donem_odenen_avans(cur, personel_id: str, yil: int, ay: int) -> float:
    """Dönemin MAHSUBA GİREN avans toplamı: para fiilen çıkmış olanlar
    (teslim_edildi + odendi). Ters kayıtlar durumdan düştüğü için otomatik hariç."""
    _tablolar_garantile(cur)
    cur.execute(
        """SELECT COALESCE(SUM(tutar),0) AS t FROM personel_avans
           WHERE personel_id=%s AND donem_yil=%s AND donem_ay=%s AND durum IN %s""",
        (str(personel_id), yil, ay, _PARALI_DURUMLAR),
    )
    return float((cur.fetchone() or {}).get("t") or 0)


def onceki_devir(cur, personel_id: str, yil: int, ay: int) -> float:
    """Bir önceki dönemin bordro kaydında sonraki aya devretmiş mahsup bakiyesi."""
    o_yil = yil - 1 if ay == 1 else yil
    o_ay = 12 if ay == 1 else ay - 1
    cur.execute(
        "SELECT COALESCE(mahsup_devir,0) AS d FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
        (str(personel_id), o_yil, o_ay),
    )
    return float((cur.fetchone() or {}).get("d") or 0)


# ── DÖNEM + TAVAN ──────────────────────────────────────────────

def _donem_sec(cur, personel_id: str) -> tuple:
    """Avansın mahsup dönemi: içinde bulunulan ay; o ayın maaş kaydı kilitliyse
    (onaylandı/ödendi) SONRAKİ ay (kullanıcı kararı: 'maaş onaylandıktan sonra
    o döneme avans kilitlenir, sonraki döneme yazar')."""
    bugun = bugun_tr()
    yil, ay = bugun.year, bugun.month
    cur.execute(
        "SELECT durum FROM personel_aylik WHERE personel_id=%s AND yil=%s AND ay=%s",
        (str(personel_id), yil, ay),
    )
    r = cur.fetchone()
    if r and r.get("durum") == "onaylandi":
        return (yil + 1, 1) if ay == 12 else (yil, ay + 1)
    # ödenmiş dönem kontrolü (plan odendi) — kilit guard'ıyla aynı eksen
    cur.execute(
        """SELECT 1 FROM odeme_plani
           WHERE kaynak_tablo='personel' AND kaynak_id=%s AND durum='odendi'
             AND referans_ay = %s::date LIMIT 1""",
        (str(personel_id), str(_maas.maas_odeme_tarihi(yil, ay))),
    )
    if cur.fetchone():
        return (yil + 1, 1) if ay == 12 else (yil, ay + 1)
    return yil, ay


def _beklenen_net(cur, p: dict, yil: int, ay: int, vt: Optional[dict]) -> float:
    # 🔴 ÜCRET, DÖNEMİN TARİHİNDEN ÇÖZÜLÜR (2026-09-06, Adım 5'in atlanan ayağı).
    # Burada `personel` kartının BUGÜNKÜ değerleri okunuyordu. Motor Adım 5'te
    # zaman çizgisine bağlanmıştı ama avans tavanı bağlanmamıştı → bugün yapılan
    # bir zam GEÇMİŞ AYIN avans tavanını da büyütüyordu.
    # Canlı örnek: MERVE KARABACAK Ağustos'ta 32.000 kazanıyordu; kartı 6 Eylül'de
    # 35.000 oldu → Ağustos tavanı 35.000 üzerinden hesaplanırdı.
    # Çizgide satır yoksa çözücü zaten karta düşer → davranış korunur.
    _p = dict(p)
    try:
        with savepoint(cur, "avans_ucret_coz"):
            import bordro_ucret as _bu
            _bas = p.get("baslangic_tarihi")
            _t = date(yil, ay, 1)
            if _bas and _bas > _t:
                _t = _bas
            _sz = _bu.sozlesme_coz(cur, p["id"], _t, dict(p))
            _p["maas"] = _sz["kalem"]["TABAN"]["tutar"]
            _p["yemek_ucreti"] = _sz["kalem"]["YEMEK"]["tutar"]
            _p["yol_ucreti"] = _sz["kalem"]["YOL"]["tutar"]
            _p["saatlik_ucret"] = _sz["kalem"]["SAATLIK"]["tutar"]
    except Exception as e:  # noqa: BLE001 — tavan, ücret çözücü kırıldı diye çökmesin
        logger.warning("avans tavani ucret cozucu calismadi (%s): %s", p.get("ad_soyad"), e)
    p = _p
    if (p.get("calisma_turu") or "surekli") == "surekli":
        return float(p.get("maas") or 0) + float(p.get("yemek_ucreti") or 0) + float(p.get("yol_ucreti") or 0)
    # 🔴 FIX (Fable denetimi P2, 2026-09-06): part-time beklenen net YALNIZ
    # planlanan vardiya saatinden türüyordu. Vardiya planı olmayan part-time'da
    # (elle-saat yolu tam da bunlar için var) saat 0 → beklenen 0 → tavan
    # adaylarına girmiyor → tavan mutlak sınıra, 20.000 ₺'ye ÇIKIYORDU. Oysa
    # 30.000 maaşlı sürekli personel 9.000 alabiliyor. Kapı ters çalışıyordu.
    # Saat kaynağı sırası: vardiya planı → bordro kaydındaki saat ('elle' dahil).
    # ⚠️ BURASI "AY SONUNDA BEKLENEN" nettir, "bugüne kadarki hakediş" değil.
    # Bu yüzden GELECEK vardiya saati de sayılır — hakediş tarafında (net_hakediş)
    # gelecek saat 2026-09-06'da bilinçli olarak dışarıda bırakıldı.
    saat = (float((vt or {}).get("toplam_planlanan_saat") or 0)
            + float((vt or {}).get("toplam_planlanan_saat_gelecek") or 0))
    if saat <= 0:
        try:
            cur.execute(
                "SELECT calisma_saati FROM personel_aylik "
                " WHERE personel_id=%s AND yil=%s AND ay=%s", (str(p["id"]), yil, ay))
            saat = float((cur.fetchone() or {}).get("calisma_saati") or 0)
        except Exception as e:  # noqa: BLE001 — tavan hesabı bordro okunamadı diye çökmesin
            logger.warning("beklenen_net bordro saati okunamadi (%s): %s", p.get("ad_soyad"), e)
    return saat * float(p.get("saatlik_ucret") or 0)


def _tavan_hesapla(cur, p: dict) -> Dict[str, Any]:
    """min(hakediş×%50, beklenen net×%30, sabit limit) − dönemin aktif avansları."""
    bugun = bugun_tr()
    yil, ay = bugun.year, bugun.month
    vt = _maas.vardiya_takip_hesap(p["id"], yil, ay)
    hakedis = float((vt or {}).get("net_hakediş") or 0)
    beklenen = _beklenen_net(cur, p, yil, ay, vt)
    adaylar = [AVANS_SABIT_TAVAN]
    if hakedis > 0:
        adaylar.append(hakedis * AVANS_HAKEDIS_ORAN)
    if beklenen > 0:
        adaylar.append(beklenen * AVANS_NET_ORAN)
    # 🔴 FIX (Fable denetimi P2, 2026-09-06): ikisi de 0 iken adaylar YALNIZ mutlak
    # sınırdan ibaret kalıyor ve tavan 20.000 ₺ çıkıyordu — yani hakedişi hiç
    # ölçülememiş kişiye EN YÜKSEK tavan veriliyordu. Doğrusu: ölçü yoksa kapı
    # KAPALI. Sıfır tavan "hakediş oluşmadan avans açılamaz" demektir.
    tavan = 0.0 if (hakedis <= 0 and beklenen <= 0) else round(min(adaylar), 2)
    d_yil, d_ay = _donem_sec(cur, p["id"])
    cur.execute(
        """SELECT COALESCE(SUM(tutar),0) AS t FROM personel_avans
           WHERE personel_id=%s AND donem_yil=%s AND donem_ay=%s AND durum IN %s""",
        (str(p["id"]), d_yil, d_ay, _AKTIF_DURUMLAR),
    )
    kullanilan = float((cur.fetchone() or {}).get("t") or 0)
    return {
        "tavan": tavan,
        "kullanilan": kullanilan,
        "kullanilabilir": round(max(0.0, tavan - kullanilan), 2),
        "hakedis_bugune": round(hakedis, 2),
        "beklenen_net": round(beklenen, 2),
        "donem_yil": d_yil,
        "donem_ay": d_ay,
    }


def _avans_getir(cur, avans_id: str) -> dict:
    cur.execute("SELECT * FROM personel_avans WHERE id=%s FOR UPDATE", (avans_id,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Avans kaydı bulunamadı")
    return dict(r)


def _row(r: dict) -> dict:
    return {
        "id": r["id"], "personel_id": r["personel_id"], "tutar": float(r["tutar"] or 0),
        "durum": r["durum"], "odeme_yontemi": r.get("odeme_yontemi"),
        "sube_id": r.get("sube_id"), "donem": f"{r['donem_yil']}-{int(r['donem_ay']):02d}",
        "talep_ts": str(r.get("talep_ts") or "")[:16], "onay_ts": str(r.get("onay_ts") or "")[:16],
        "teslim_ts": str(r.get("teslim_ts") or "")[:16], "odeme_ts": str(r.get("odeme_ts") or "")[:16],
        "not_aciklama": r.get("not_aciklama"),
    }


# ── UÇLAR ──────────────────────────────────────────────────────

class AvansTalepModel(BaseModel):
    personel_id: str
    tutar: float
    not_aciklama: Optional[str] = None


@router.get("/api/avans/personel-ozet")
def avans_personel_ozet(personel_id: str):
    """QR personel ekranı: tavan + kullanılabilir + geçmiş + 'aldım' onayı bekleyenler."""
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        cur.execute("SELECT * FROM personel WHERE id=%s", (personel_id,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Personel bulunamadı")
        limit = _tavan_hesapla(cur, dict(p))
        cur.execute(
            """SELECT * FROM personel_avans WHERE personel_id=%s
               ORDER BY talep_ts DESC LIMIT 10""",
            (personel_id,),
        )
        gecmis = [_row(dict(r)) for r in cur.fetchall()]
        bekleyen_onay = [g for g in gecmis if g["durum"] == "teslim_edildi"]
        acik_talep = [g for g in gecmis if g["durum"] in ("talep", "onaylandi")]
    return {"limit": limit, "gecmis": gecmis,
            "aldim_onayi_bekleyen": bekleyen_onay, "acik_talep": acik_talep}


@router.post("/api/avans/talep")
def avans_talep(body: AvansTalepModel):
    try:
        t = float(body.tutar)
    except (TypeError, ValueError):
        raise HTTPException(400, "Geçerli bir tutar girin")
    if t <= 0:
        raise HTTPException(400, "Tutar 0'dan büyük olmalı")
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        # FIX AV2 (2026-07-06): personel bazlı yarış kilidi — eşzamanlı iki talep ikisi de
        # "bekleyen yok" görüp tavanın toplamda aşılmasına yol açabiliyordu. Transaction-scoped
        # advisory lock istekleri sıraya sokar; ikincisi aşağıdaki bekleyen-talep kontrolüne takılır.
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"avans_talep:{body.personel_id}",))
        cur.execute("SELECT * FROM personel WHERE id=%s AND aktif=TRUE", (body.personel_id,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Aktif personel bulunamadı")
        cur.execute(
            "SELECT 1 FROM personel_avans WHERE personel_id=%s AND durum IN ('talep','onaylandi') LIMIT 1",
            (body.personel_id,),
        )
        if cur.fetchone():
            raise HTTPException(400, "Bekleyen bir avans talebin zaten var — sonuçlanmadan yenisi açılamaz")
        limit = _tavan_hesapla(cur, dict(p))
        if t > limit["kullanilabilir"] + 0.005:
            raise HTTPException(400,
                f"Talep tavanı aşıyor. Kullanılabilir avans: {limit['kullanilabilir']:,.0f} ₺ "
                f"(bu ay hakedişinin %{int(AVANS_HAKEDIS_ORAN*100)}'i ve beklenen netin "
                f"%{int(AVANS_NET_ORAN*100)}'u ile sınırlı)")
        aid = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO personel_avans
               (id, personel_id, tutar, durum, donem_yil, donem_ay, not_aciklama)
               VALUES (%s,%s,%s,'talep',%s,%s,%s)""",
            (aid, body.personel_id, t, limit["donem_yil"], limit["donem_ay"], body.not_aciklama),
        )
        _event(cur, aid, "TALEP", {"tutar": t, "tavan": limit})
        audit(cur, "personel_avans", aid, "TALEP", yeni={"tutar": t, "personel": p["ad_soyad"]})
    # DUYU OMURGASI (2026-07-06): KİMLİKSİZ olay — şube scope + tutar (kural #15; retention
    # bağlamı F3'te ŞUBE seviyesinde okunacak). Hata-yutar.
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz("avans", "finans.sube.avans_talebi", aid,
                      entity_scope="sube", entity_id=str(p.get("sube_id") or "") or None,
                      signal_name="Avans talebi", payload={"tutar": t})
    except Exception:  # noqa: BLE001
        pass
    return {"success": True, "id": aid, "donem": f"{limit['donem_yil']}-{limit['donem_ay']:02d}"}


class AvansOnayModel(BaseModel):
    yontem: str                      # 'havale' | 'elden'
    sube_id: Optional[str] = None    # elden ise zorunlu
    onaylayan: Optional[str] = None


@router.get("/api/avans/bekleyenler")
def avans_bekleyenler():
    """Sahip: onay bekleyen talepler + teslim/personel-onayı bekleyenler."""
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        cur.execute(
            """SELECT pa.*, p.ad_soyad, s.ad AS sube_ad
               FROM personel_avans pa
               JOIN personel p ON p.id::text = pa.personel_id
               LEFT JOIN subeler s ON s.id::text = pa.sube_id
               WHERE pa.durum IN ('talep','onaylandi','teslim_edildi')
               ORDER BY pa.talep_ts ASC"""
        )
        rows = []
        for r in cur.fetchall():
            d = _row(dict(r))
            d["ad_soyad"] = r["ad_soyad"]
            d["sube_ad"] = r.get("sube_ad")
            rows.append(d)
    return {"bekleyenler": rows, "adet": len(rows)}


@router.post("/api/avans/{aid}/onayla")
def avans_onayla(aid: str, body: AvansOnayModel):
    yontem = (body.yontem or "").strip().lower()
    if yontem not in ("havale", "elden"):
        raise HTTPException(400, "Yöntem 'havale' veya 'elden' olmalı")
    if yontem == "elden" and not body.sube_id:
        raise HTTPException(400, "Elden ödemede şube seçimi zorunlu (hangi kasadan verilecek)")
    bugun = bugun_tr()
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        r = _avans_getir(cur, aid)
        if r["durum"] != "talep":
            raise HTTPException(400, f"Bu kayıt '{r['durum']}' durumda — sadece bekleyen talep onaylanır")
        cur.execute("SELECT * FROM personel WHERE id=%s AND aktif=TRUE", (r["personel_id"],))
        p_onay = cur.fetchone()
        if not p_onay:
            raise HTTPException(400, "Personel pasif — avans onaylanamaz (talebi reddedin)")
        ad = (dict(p_onay).get("ad_soyad") or "Personel").strip() or "Personel"
        # FIX AV2 (2026-07-06): onayda tavan RE-CHECK — talep anı ile onay anı arasında hakediş/
        # dönem değişmiş olabilir. 'talep' durumu _AKTIF_DURUMLAR'da olduğundan kullanilan bu
        # talebin tutarını AYNI dönemde zaten içerir → aynı dönemde kural "kullanilan > tavan";
        # dönem değiştiyse (ay atladı) bu talep yeni dönem toplamında yoktur → tutar eklenerek bakılır.
        _lim = _tavan_hesapla(cur, dict(p_onay))
        _ayni_donem = (int(_lim["donem_yil"]), int(_lim["donem_ay"])) == (int(r["donem_yil"]), int(r["donem_ay"]))
        _toplam = _lim["kullanilan"] if _ayni_donem else _lim["kullanilan"] + float(r["tutar"])
        if _toplam > _lim["tavan"] + 0.005:
            raise HTTPException(400,
                f"Onay anında tavan aşılıyor: dönem toplamı {_toplam:,.0f} ₺ > tavan {_lim['tavan']:,.0f} ₺. "
                f"Hakediş/dönem talep sonrası değişti — talebi reddedip güncel tavanla yeniden açtırın.")
        # 🔴 MAHSUP DÖNEMİ ONAY ANINDA YENİDEN SEÇİLİR (Fable denetimi P1, 2026-09-06).
        # Dönem TALEP anında yazılıyor, onayda bir daha bakılmıyordu. Talep ile onay
        # arasında o dönemin bordrosu onaylanırsa (ya da ödenirse) avans hiçbir yerde
        # mahsup edilmiyordu: hedef dönemin neti dondurulmuş olduğu için düşülmüyor,
        # sonraki dönem ise `donem_odenen_avans(yil,ay)` filtresiyle eski dönemdeki
        # avansı GÖRMÜYOR. Para çıkıyor, maaştan hiç düşmüyor.
        # `_tavan_hesapla` zaten `_donem_sec`'i çağırıp GÜNCEL dönemi buluyordu
        # (_lim["donem_yil"]/["donem_ay"]) — tek eksik onu satıra YAZMAKTI.
        _d_yil, _d_ay = int(_lim["donem_yil"]), int(_lim["donem_ay"])
        _donem_kaydi = (_d_yil, _d_ay) != (int(r["donem_yil"]), int(r["donem_ay"]))
        if _donem_kaydi:
            _event(cur, aid, "DONEM_KAYDI", {
                "eski": f"{r['donem_yil']}-{int(r['donem_ay']):02d}",
                "yeni": f"{_d_yil}-{_d_ay:02d}",
                "neden": "talep ile onay arasında hedef dönemin bordrosu kilitlendi"})
        if yontem == "havale":
            # Onay = ödeme anı: kasa izi ŞİMDİ yazılır ("kasa izi = tek gerçek")
            insert_kasa_hareketi(cur, str(bugun), "PERSONEL_AVANS", -abs(float(r["tutar"])),
                f"Personel Avans (havale): {ad} — {_d_yil}-{_d_ay:02d} dönemi mahsup",
                "personel_avans", aid, ref_type="PERSONEL_AVANS")
            cur.execute(
                """UPDATE personel_avans SET durum='odendi', odeme_yontemi='havale',
                       donem_yil=%s, donem_ay=%s,
                       onay_ts=NOW(), odeme_ts=NOW(), onaylayan=%s WHERE id=%s""",
                (_d_yil, _d_ay, body.onaylayan, aid),
            )
            _event(cur, aid, "ONAY_HAVALE_ODENDI",
                   {"onaylayan": body.onaylayan, "donem": f"{_d_yil}-{_d_ay:02d}"})
        else:
            cur.execute(
                """UPDATE personel_avans SET durum='onaylandi', odeme_yontemi='elden',
                       sube_id=%s, donem_yil=%s, donem_ay=%s,
                       onay_ts=NOW(), onaylayan=%s WHERE id=%s""",
                (body.sube_id, _d_yil, _d_ay, body.onaylayan, aid),
            )
            _event(cur, aid, "ONAY_ELDEN", {"sube_id": body.sube_id, "onaylayan": body.onaylayan,
                                            "donem": f"{_d_yil}-{_d_ay:02d}"})
        # Hedef dönemin bordrosunu TAZELE — mahsup oraya işlensin. Onaylı/ödenmiş
        # kaydı senkron zaten atlar; taslaksa net avans düşülmüş haliyle yeniden yazılır.
        try:
            with savepoint(cur, "avans_donem_senk"):
                _maas.aylik_vardiya_senkronize(cur, dict(p_onay), _d_yil, _d_ay)
        except Exception as e:  # noqa: BLE001 — avans onayı bordro senkronu yüzünden düşmesin
            logger.warning("avans sonrasi bordro senkronu (%s %s-%s): %s",
                           r["personel_id"], _d_yil, _d_ay, e)
        audit(cur, "personel_avans", aid, "ONAY", yeni={"yontem": yontem})
    # DUYU OMURGASI (2026-07-06): kimliksiz para-çıkışı/onay olayı — hata-yutar
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz("avans",
                      "finans.sube.avans_cikisi" if yontem == "havale" else "finans.sube.avans_onayi",
                      f"{aid}:onay",
                      entity_scope="sube", entity_id=str(body.sube_id or "") or None,
                      signal_name="Avans " + ("ödendi (havale)" if yontem == "havale" else "onaylandı (elden)"),
                      payload={"tutar": float(r["tutar"]), "yontem": yontem})
    except Exception:  # noqa: BLE001
        pass
    return {"success": True, "durum": "odendi" if yontem == "havale" else "onaylandi"}


class AvansRedModel(BaseModel):
    neden: Optional[str] = None


@router.post("/api/avans/{aid}/reddet")
def avans_reddet(aid: str, body: AvansRedModel = AvansRedModel()):
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        r = _avans_getir(cur, aid)
        if r["durum"] not in ("talep", "onaylandi"):
            raise HTTPException(400, "Para çıkmış kayıt reddedilemez — ters kayıt kullanın")
        cur.execute("UPDATE personel_avans SET durum='reddedildi', not_aciklama=COALESCE(%s, not_aciklama) WHERE id=%s",
                    (body.neden, aid))
        _event(cur, aid, "REDDEDILDI", {"neden": body.neden})
        audit(cur, "personel_avans", aid, "REDDEDILDI")
    return {"success": True}


@router.get("/api/avans/teslim-bekleyen")
def avans_teslim_bekleyen(sube_id: str):
    """Şubede ELDEN teslim edilecek onaylı avanslar (kapanış sorumlusu/QR görür)."""
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        cur.execute(
            """SELECT pa.*, p.ad_soyad FROM personel_avans pa
               JOIN personel p ON p.id::text = pa.personel_id
               WHERE pa.durum='onaylandi' AND pa.odeme_yontemi='elden' AND pa.sube_id=%s
               ORDER BY pa.onay_ts ASC""",
            (str(sube_id),),
        )
        rows = []
        for r in cur.fetchall():
            d = _row(dict(r))
            d["ad_soyad"] = r["ad_soyad"]
            rows.append(d)
    return {"bekleyenler": rows, "adet": len(rows)}


class AvansTeslimModel(BaseModel):
    teslim_eden_personel_id: Optional[str] = None


@router.post("/api/avans/{aid}/teslim-et")
def avans_teslim_et(aid: str, body: AvansTeslimModel = AvansTeslimModel()):
    """ELDEN teslim: para şube kasasından fiilen çıkar → kasa izi + şube günlük
    kapanış hesabına anlik_giderler satırı (kapanış farkı yemez). Personelin
    QR 'aldım' onayı beklenir (çift imza) — gelmese de para çıktı, mahsuba girer."""
    bugun = bugun_tr()
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        r = _avans_getir(cur, aid)
        if not (r["durum"] == "onaylandi" and (r.get("odeme_yontemi") == "elden")):
            raise HTTPException(400, "Sadece elden-onaylı avans teslim edilebilir")
        cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (r["personel_id"],))
        ad = (cur.fetchone() or {}).get("ad_soyad") or "Personel"
        tutar = abs(float(r["tutar"]))
        # 1) Merkez kasa izi (tek gerçek)
        insert_kasa_hareketi(cur, str(bugun), "PERSONEL_AVANS", -tutar,
            f"Personel Avans (elden): {ad} — {r['donem_yil']}-{int(r['donem_ay']):02d} dönemi mahsup",
            "personel_avans", aid, ref_type="PERSONEL_AVANS")
        # 2) Şube günlük kapanış bileşeni — kasa fark formülü anlik_giderler'den okur.
        #    NOT: Bu satır İKİNCİ bir kasa yazımı DEĞİLDİR (anlık gider ucu çağrılmıyor);
        #    sadece şube gün-sonu nakit denkliği için bileşen kaydıdır.
        gid = "avans_" + aid
        cur.execute(
            """INSERT INTO anlik_giderler
               (id, tarih, kategori, tutar, aciklama, sube, odeme_yontemi, kaynak_id, kaynak_tablo)
               VALUES (%s,%s,'Personel Avans',%s,%s,%s,'nakit',%s,'personel_avans')
               ON CONFLICT (id) DO NOTHING""",
            (gid, str(bugun), tutar, f"Avans (elden): {ad}", r["sube_id"], aid),
        )
        cur.execute(
            "UPDATE personel_avans SET durum='teslim_edildi', teslim_ts=NOW(), anlik_gider_id=%s WHERE id=%s",
            (gid, aid),
        )
        _event(cur, aid, "TESLIM_EDILDI", {"teslim_eden": body.teslim_eden_personel_id, "sube": r["sube_id"]})
        audit(cur, "personel_avans", aid, "TESLIM", yeni={"tutar": tutar})
        # 3) Kapanış zaten yapıldıysa fark uyarısını tazele (hata-yutar; ana akışı bozmaz)
        try:
            # FIX KP3 (2026-07-05): eskiden yeniden_hesapla(cur, sube_id, bugun, "KAPANIS") YANLIŞ
            # İMZAYDI (fn uyari_id bekler) → TypeError → sessizce yutuluyordu, recalc HİÇ çalışmadı.
            # Tek tetikleme noktası: sube+gün → o günün kapanış fark uyarısını bulur ve tazeler.
            from kasa_fark_recalc import sube_gun_kapanis_recalc
            sube_gun_kapanis_recalc(cur, r["sube_id"], bugun)
        except Exception as e:
            logger.warning("avans teslim sonrasi kasa fark recalc atlandi: %s", e)
    # DUYU OMURGASI (2026-07-06): elden teslim = fiili para çıkışı olayı (kimliksiz)
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz("avans", "finans.sube.avans_cikisi", f"{aid}:teslim",
                      entity_scope="sube", entity_id=str(r.get("sube_id") or "") or None,
                      signal_name="Avans teslim edildi (elden)",
                      payload={"tutar": tutar, "yontem": "elden"})
    except Exception:  # noqa: BLE001
        pass
    return {"success": True, "durum": "teslim_edildi"}


class AvansPersonelOnayModel(BaseModel):
    personel_id: str


@router.post("/api/avans/{aid}/personel-onay")
def avans_personel_onay(aid: str, body: AvansPersonelOnayModel):
    """Çift imzanın ikinci yarısı: personel QR ekranından 'aldım' der → odendi."""
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        r = _avans_getir(cur, aid)
        if r["durum"] != "teslim_edildi":
            raise HTTPException(400, "Bu kayıt teslim onayı beklemiyor")
        if str(r["personel_id"]) != str(body.personel_id):
            raise HTTPException(403, "Bu avans sana ait değil")
        cur.execute("UPDATE personel_avans SET durum='odendi', odeme_ts=NOW() WHERE id=%s", (aid,))
        _event(cur, aid, "PERSONEL_ALDIM_ONAYI", {})
        audit(cur, "personel_avans", aid, "PERSONEL_ONAY")
    return {"success": True, "durum": "odendi"}


@router.get("/api/avans/ozet")
def avans_ozet():
    """CFO masaüstü paneli için avans farkındalık özeti: bekleyen talep + teslim bekleyen
    + bu takvim ayı fiilen ödenen avans (kasa çıkışı). Salt-okur, hata-yutar tasarım."""
    bugun = bugun_tr()
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        cur.execute(
            """SELECT
                   COUNT(*) FILTER (WHERE durum='talep')                     AS bekleyen_adet,
                   COALESCE(SUM(tutar) FILTER (WHERE durum='talep'),0)        AS bekleyen_tutar,
                   COUNT(*) FILTER (WHERE durum IN ('onaylandi','teslim_edildi')) AS teslim_bekleyen_adet,
                   COALESCE(SUM(tutar) FILTER (WHERE durum IN ('onaylandi','teslim_edildi')),0) AS teslim_bekleyen_tutar,
                   COUNT(*) FILTER (WHERE durum IN ('teslim_edildi','odendi')
                       AND COALESCE(odeme_ts, teslim_ts) >= %s)              AS bu_ay_adet,
                   COALESCE(SUM(tutar) FILTER (WHERE durum IN ('teslim_edildi','odendi')
                       AND COALESCE(odeme_ts, teslim_ts) >= %s),0)          AS bu_ay_odenen
               FROM personel_avans""",
            (date(bugun.year, bugun.month, 1), date(bugun.year, bugun.month, 1)),
        )
        r = dict(cur.fetchone() or {})
    return {
        "bekleyen_adet": int(r.get("bekleyen_adet") or 0),
        "bekleyen_tutar": float(r.get("bekleyen_tutar") or 0),
        "teslim_bekleyen_adet": int(r.get("teslim_bekleyen_adet") or 0),
        "teslim_bekleyen_tutar": float(r.get("teslim_bekleyen_tutar") or 0),
        "bu_ay_adet": int(r.get("bu_ay_adet") or 0),
        "bu_ay_odenen": float(r.get("bu_ay_odenen") or 0),
    }


class AvansIptalModel(BaseModel):
    neden: Optional[str] = None


@router.post("/api/avans/{aid}/iptal")
def avans_iptal(aid: str, body: AvansIptalModel = AvansIptalModel()):
    """Para ÇIKMADAN geri çekme (talep veya elden-onaylı ama henüz teslim edilmemiş).
    Para çıkmış (teslim_edildi/odendi) kayıt için ters-kayıt gerekir. Reddet'ten farkı:
    iptal personel/sahip tarafından 'vazgeçildi' anlamı taşır, reddet sahip retidir."""
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        r = _avans_getir(cur, aid)
        if r["durum"] not in ("talep", "onaylandi"):
            raise HTTPException(400, "Para çıkmış avans iptal edilemez — ters kayıt kullanın")
        cur.execute(
            "UPDATE personel_avans SET durum='iptal', not_aciklama=COALESCE(%s, not_aciklama) WHERE id=%s",
            (body.neden, aid),
        )
        _event(cur, aid, "IPTAL", {"neden": body.neden})
        audit(cur, "personel_avans", aid, "IPTAL")
    return {"success": True, "durum": "iptal"}


class AvansTersModel(BaseModel):
    neden: str
    onaylayan: Optional[str] = None


@router.post("/api/avans/{aid}/ters-kayit")
def avans_ters_kayit(aid: str, body: AvansTersModel):
    """Ödendi/teslim sonrası düzeltme: kayıt SİLİNMEZ — ters kasa izi (+tutar) yazılır,
    durum 'ters_kayit' olur (mahsuptan otomatik düşer), muhasebe izi kapanır."""
    if not (body.neden or "").strip():
        raise HTTPException(400, "Ters kayıt için neden zorunlu")
    bugun = bugun_tr()
    with db() as (conn, cur):
        _tablolar_garantile(cur)
        r = _avans_getir(cur, aid)
        if r["durum"] not in _PARALI_DURUMLAR:
            raise HTTPException(400, "Para çıkmamış kayıt için iptal/reddet kullanın")
        cur.execute("SELECT ad_soyad FROM personel WHERE id=%s", (r["personel_id"],))
        ad = (cur.fetchone() or {}).get("ad_soyad") or "Personel"
        ters_id = str(uuid.uuid4())
        insert_kasa_hareketi(cur, str(bugun), "PERSONEL_AVANS", abs(float(r["tutar"])),
            f"Personel Avans TERS KAYIT: {ad} — {body.neden}",
            "personel_avans", aid, ref_id=ters_id, ref_type="PERSONEL_AVANS_TERS")
        # elden ise şube kapanış bileşenini de iptal et
        if r.get("anlik_gider_id"):
            cur.execute("UPDATE anlik_giderler SET durum='iptal' WHERE id=%s", (r["anlik_gider_id"],))
        cur.execute(
            "UPDATE personel_avans SET durum='ters_kayit', ters_ref=%s, not_aciklama=%s WHERE id=%s",
            (ters_id, body.neden, aid),
        )
        _event(cur, aid, "TERS_KAYIT", {"neden": body.neden, "onaylayan": body.onaylayan, "ters_ref": ters_id})
        audit(cur, "personel_avans", aid, "TERS_KAYIT", yeni={"neden": body.neden})
        # FIX AV1 (2026-07-06): ters kayıt avansı mahsup havuzundan düşürür ama dönemin BEKLEYEN
        # maaş planı o mahsupla (düşük tutarlı) üretilmişse eski kalıyordu → personele eksik
        # ödeme planı. Kanonik senkron plan+kaydı yeniden eşitler (onaylı kayıt kendi guard'ıyla
        # EZİLMEZ; plan yazımı yine TEK yazıcıdan — maas_service). Hata-yutar: senkron başarısız
        # olsa da ters kayıt geçerli kalır (panel açılış mutabakatı da ayrıca yakalar).
        try:
            import maas_service as _ms
            cur.execute("SELECT * FROM personel WHERE id=%s", (r["personel_id"],))
            _pk = cur.fetchone()
            if _pk:
                _ms.aylik_vardiya_senkronize(cur, dict(_pk), int(r["donem_yil"]), int(r["donem_ay"]))
        except Exception as _e:
            logger.warning("avans ters-kayit sonrasi maas plan senkronu atlandi: %s", _e)
    # DUYU OMURGASI (2026-07-06): kimliksiz ters-kayıt olayı — hata-yutar
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz("avans", "finans.sube.avans_ters_kayit", f"{aid}:ters",
                      entity_scope="sube", entity_id=str(r.get("sube_id") or "") or None,
                      signal_name="Avans ters kayıt",
                      payload={"tutar": abs(float(r["tutar"]))})
    except Exception:  # noqa: BLE001
        pass
    return {"success": True, "durum": "ters_kayit"}
