"""
Evvel ERP — WhatsApp Günlük Özet Bildirimi
Green API üzerinden ortaklar grubuna gece 00:30'da gönderilir.

Veri kaynakları (CFO Panel ile birebir):
  Cirolar    → kapanis_kayit (öncelikli) → ciro aktif → ciro_taslak bekliyor
  Kasa       → kasa_hareketleri WHERE kasa_etkisi=TRUE (finans_core.kasa_bakiyesi ile aynı)
  Bu ay ciro → ciro WHERE durum='aktif' (motors.py finans_ozet_motoru ile aynı)
  Anlık gider→ kasa_hareketleri WHERE islem_turu='ANLIK_GIDER' (panel ile aynı)
  Ödemeler   → odeme_plani (odenecek_tutar, tarih, durum)
  Kasa teslim→ kasa_teslim
  Toptancı   → operasyon_defter WHERE etiket='URUN_SEVK'

Ortam değişkenleri:
    WA_INSTANCE_ID   — Green API instance ID
    WA_TOKEN         — Green API API token
    WA_GROUP_ID      — Grup chat ID (@g.us ile biten)
"""

import os, json, logging, urllib.request, urllib.error
from datetime import date, timedelta
from database import db

logger = logging.getLogger(__name__)


# ── Yardımcı ─────────────────────────────────────────────────────────────────

def _fmt(val) -> str:
    try:
        return f"{int(float(val or 0)):,}".replace(",", ".") + " ₺"
    except Exception:
        return "— ₺"

def _trend(simdiki, onceki) -> str:
    try:
        s, o = float(simdiki or 0), float(onceki or 0)
        if o == 0: return ""
        pct = round((s - o) / o * 100)
        return f"▲ +{pct}%" if pct > 0 else (f"▼ {pct}%" if pct < 0 else "→ 0%")
    except Exception:
        return ""


# ── Ciro: kapanış takip öncelikli ────────────────────────────────────────────

def _kapanis_ciro_map(cur, tarih_bas: date, tarih_son: date) -> dict:
    """
    kapanis_kayit'ten şube+gün bazlı ciro.
    Gece kapanışlar tarih veya tarih+1'e yazılabilir (is_gunu_tr mantığı).
    """
    cur.execute("""
        SELECT sube_id, tarih,
               COALESCE(nakit,0) + COALESCE(pos,0) + COALESCE(online,0) AS tutar
        FROM kapanis_kayit
        WHERE tarih >= %s AND tarih <= %s AND durum != 'iptal'
    """, (tarih_bas, tarih_son + timedelta(days=1)))
    return {(str(r["sube_id"]), str(r["tarih"])): float(r["tutar"] or 0)
            for r in (cur.fetchall() or [])}

def _sube_ciro_gun(cur, tarih: date) -> dict:
    """
    Tek gün için şube bazlı ciro.
    Öncelik: kapanis_kayit → ciro aktif → ciro_taslak
    """
    # 1. Kapanış (tarih veya tarih+1)
    cur.execute("""
        SELECT sube_id,
               COALESCE(nakit,0)+COALESCE(pos,0)+COALESCE(online,0) AS tutar
        FROM kapanis_kayit
        WHERE tarih IN (%s,%s) AND durum != 'iptal'
    """, (tarih, tarih + timedelta(days=1)))
    sonuc = {str(r["sube_id"]): float(r["tutar"] or 0) for r in (cur.fetchall() or [])}

    # 2. Onaylı ciro
    cur.execute("""
        SELECT sube_id, COALESCE(SUM(toplam),0) AS tutar
        FROM ciro WHERE tarih=%s AND durum='aktif' GROUP BY sube_id
    """, (tarih,))
    for r in (cur.fetchall() or []):
        if str(r["sube_id"]) not in sonuc:
            sonuc[str(r["sube_id"])] = float(r["tutar"] or 0)

    # 3. Taslak
    cur.execute("""
        SELECT sube_id,
               COALESCE(SUM(COALESCE(nakit,0)+COALESCE(pos,0)+COALESCE(online,0)),0) AS tutar
        FROM ciro_taslak WHERE tarih=%s AND durum='bekliyor' GROUP BY sube_id
    """, (tarih,))
    for r in (cur.fetchall() or []):
        if str(r["sube_id"]) not in sonuc:
            sonuc[str(r["sube_id"])] = float(r["tutar"] or 0)

    return sonuc

def _ciro_verileri(cur, tarih: date) -> dict:
    cur.execute("SELECT id, ad FROM subeler WHERE aktif=TRUE ORDER BY ad")
    subeler_liste = cur.fetchall() or []
    bugun_map = _sube_ciro_gun(cur, tarih)
    dun_map   = _sube_ciro_gun(cur, tarih - timedelta(days=1))

    subeler, toplam_bugun, toplam_dun = [], 0, 0
    for row in subeler_liste:
        sid = str(row["id"])
        ciro = bugun_map.get(sid, 0)
        d    = dun_map.get(sid, 0)
        toplam_bugun += ciro
        toplam_dun   += d
        subeler.append({"ad": row["ad"], "ciro": ciro, "dun": d,
                        "trend": _trend(ciro, d), "girilmis": ciro > 0})
    return {"subeler": subeler, "toplam": toplam_bugun,
            "toplam_trend": _trend(toplam_bugun, toplam_dun)}


# ── Bu ay ciro — CFO Panel ile aynı kaynak (ciro.durum='aktif') ──────────────

def _bu_ay_ciro(cur, tarih: date) -> float:
    """
    motors.py finans_ozet_motoru ile birebir aynı sorgu:
    ciro WHERE durum='aktif' AND bu ay
    """
    cur.execute("""
        SELECT COALESCE(SUM(toplam), 0) AS ciro
        FROM ciro
        WHERE durum = 'aktif'
          AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
    """, (tarih,))
    return float((cur.fetchone() or {}).get("ciro") or 0)


# ── Kasa — finans_core.kasa_bakiyesi ile aynı ────────────────────────────────

def _kasa_verileri(cur, tarih: date) -> dict:
    """
    finans_core.kasa_bakiyesi: SUM(tutar) WHERE kasa_etkisi=TRUE
    Giren/çıkan: o günün kasa hareketleri (islem_turu bazlı)
    """
    cur.execute("""
        SELECT COALESCE(SUM(tutar),0) AS bakiye
        FROM kasa_hareketleri WHERE kasa_etkisi=TRUE
    """)
    kasa = float((cur.fetchone() or {}).get("bakiye") or 0)

    # Bugün kasa'ya giren (ciro + dış kaynak)
    cur.execute("""
        SELECT COALESCE(SUM(tutar),0) AS toplam
        FROM kasa_hareketleri
        WHERE kasa_etkisi=TRUE AND tutar>0
          AND tarih = %s
    """, (tarih,))
    giren = float((cur.fetchone() or {}).get("toplam") or 0)

    # Bugün kasa'dan çıkan
    cur.execute("""
        SELECT COALESCE(SUM(ABS(tutar)),0) AS toplam
        FROM kasa_hareketleri
        WHERE kasa_etkisi=TRUE AND tutar<0
          AND tarih = %s
    """, (tarih,))
    cikan = float((cur.fetchone() or {}).get("toplam") or 0)

    return {"kasa": kasa, "giren": giren, "cikan": cikan}


# ── Anlık gider — panel ile aynı kaynak ──────────────────────────────────────

def _anlik_giderler(cur, tarih: date) -> list:
    """
    Panel: kasa_hareketleri WHERE islem_turu='ANLIK_GIDER' bu ay.
    Mesaj için: o günün anlık giderleri, onay durumundan bağımsız
    (şube panelinden girilmiş, kasa_hareketleri'ne düşmemiş olabilir).
    """
    cur.execute("""
        SELECT aciklama, kategori, COALESCE(tutar,0) AS tutar
        FROM anlik_giderler
        WHERE tarih = %s
          AND (durum IS NULL OR durum NOT IN ('iptal','red'))
        ORDER BY olusturma DESC
        LIMIT 20
    """, (tarih,))
    return [dict(r) for r in (cur.fetchall() or [])]


# ── Yarın ödemeler ───────────────────────────────────────────────────────────

def _yarin_odemeler(cur, tarih: date) -> list:
    yarin = tarih + timedelta(days=1)
    cur.execute("""
        SELECT aciklama, odenecek_tutar AS tutar, kaynak_tablo
        FROM odeme_plani
        WHERE tarih = %s AND durum IN ('bekliyor','onay_bekliyor')
        ORDER BY odenecek_tutar DESC
        LIMIT 10
    """, (yarin,))
    return [dict(r) for r in (cur.fetchall() or [])]


# ── Kasa teslimler ───────────────────────────────────────────────────────────

def _kasa_teslimler(cur, tarih: date) -> list:
    cur.execute("""
        SELECT kt.tutar, kt.teslim_eden_ad, kt.teslim_alan_ad,
               kt.teslim_turu, s.ad AS sube_adi
        FROM kasa_teslim kt
        JOIN subeler s ON s.id = kt.sube_id
        WHERE kt.tarih IN (%s, %s)
        ORDER BY kt.olusturma
    """, (tarih, tarih + timedelta(days=1)))
    return [dict(r) for r in (cur.fetchall() or [])]


# ── Toptancı teslimler ───────────────────────────────────────────────────────

def _toptanci_teslimler(cur, tarih: date) -> list:
    cur.execute("""
        SELECT d.sube_id, s.ad AS sube_adi, d.aciklama
        FROM operasyon_defter d
        JOIN subeler s ON s.id = d.sube_id
        WHERE d.etiket = 'URUN_SEVK'
          AND d.tarih IN (%s, %s)
          AND d.aciklama LIKE 'URUN_SEVK_JSON:%%'
        ORDER BY d.olay_ts
    """, (tarih, tarih + timedelta(days=1)))
    rows = cur.fetchall() or []

    teslimler = []
    for r in rows:
        payload = {}
        try:
            json_str = str(r["aciklama"])[len("URUN_SEVK_JSON:"):].split(" | ")[0].strip()
            payload = json.loads(json_str)
        except Exception:
            pass
        kalemler = []
        for k in (payload.get("kalemler") or []):
            ad = str(k.get("urun_ad") or k.get("ad") or "").strip()
            adet = int(k.get("adet") or 0)
            if ad and adet > 0:
                kalemler.append(f"{ad} {adet} adet")
        if not kalemler:
            for k, v in (payload.get("delta") or {}).items():
                try:
                    if int(v) > 0: kalemler.append(f"{k} {v}")
                except Exception:
                    pass
        teslimler.append({
            "sube": r["sube_adi"],
            "tedarikci": str(payload.get("tedarikci") or "").strip() or "—",
            "kalemler": kalemler[:5],
        })
    return teslimler


# ── Mesaj Oluşturma ───────────────────────────────────────────────────────────

_AY = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran",
       "Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"]

_KAYNAK_ETIKET = {
    "sabit_giderler": "Sabit Gider",
    "personel": "Maaş",
    "vadeli_alimlar": "Vadeli",
    "borc_envanteri": "Kredi/Borç",
}

_TESLIM_TUR = {
    "ara": "Ara Teslim", "kapanis": "Kapanış",
    "acilis": "Açılış", "diger": "Diğer",
}

def gunluk_ozet_mesaj_olustur(tarih: date | None = None) -> str:
    from tr_saat import bugun_tr
    if tarih is None:
        tarih = bugun_tr() - timedelta(days=1)

    with db() as (conn, cur):
        ciro        = _ciro_verileri(cur, tarih)
        kasa        = _kasa_verileri(cur, tarih)
        giderler    = _anlik_giderler(cur, tarih)
        yarin       = _yarin_odemeler(cur, tarih)
        ay_ciro     = _bu_ay_ciro(cur, tarih)
        kt_liste    = _kasa_teslimler(cur, tarih)
        toptanci    = _toptanci_teslimler(cur, tarih)

    tarih_str = f"{tarih.day} {_AY[tarih.month - 1]}"
    s = [f"🌙 *Evvel — {tarih_str} Günlük Özet*", ""]

    # Cirolar
    s.append("*CİROLAR*")
    for sub in ciro["subeler"]:
        if not sub["girilmis"]:
            s.append(f"⚠️ {sub['ad']:<14} kapanış girilmedi")
        else:
            trend = f"  {sub['trend']}" if sub["trend"] else ""
            s.append(f"  {sub['ad']:<14} {_fmt(sub['ciro'])}{trend}")
    trend_t = f"  {ciro['toplam_trend']}" if ciro["toplam_trend"] else ""
    s.append(f"  {'Toplam':<14} *{_fmt(ciro['toplam'])}*{trend_t}")
    s.append("")

    # Kasa
    s.append(f"*KASA: {_fmt(kasa['kasa'])}*")
    s.append(f"  Bugün giren:  +{_fmt(kasa['giren'])}")
    s.append(f"  Bugün çıkan:  -{_fmt(kasa['cikan'])}")
    s.append("")

    # Anlık giderler
    if giderler:
        s.append("*ANLIK GİDERLER*")
        toplam_g = 0
        for g in giderler:
            ad = str(g.get("aciklama") or g.get("kategori") or "Gider")[:30]
            t  = float(g.get("tutar") or 0)
            toplam_g += t
            s.append(f"  • {ad:<30} {_fmt(t)}")
        if len(giderler) > 1:
            s.append(f"  {'Toplam':<32} {_fmt(toplam_g)}")
        s.append("")

    # Yarın ödemeler
    if yarin:
        s.append("*YARIN ÖDEMELER*")
        toplam_y = 0
        for o in yarin:
            ad    = str(o.get("aciklama") or "")[:28]
            t     = float(o.get("tutar") or 0)
            toplam_y += t
            etiket = _KAYNAK_ETIKET.get(o.get("kaynak_tablo") or "", "")
            ek = f" ({etiket})" if etiket else ""
            s.append(f"  • {ad}{ek}  {_fmt(t)}")
        if len(yarin) > 1:
            s.append(f"  Toplam: *{_fmt(toplam_y)}*")
        s.append("")

    # Bu ay ciro
    s.append(f"Bu ay: *{_fmt(ay_ciro)}*")

    # Kasa teslimler
    if kt_liste:
        s.append("")
        s.append("*KASA TESLİMLER*")
        toplam_kt = 0
        for t in kt_liste:
            tutar  = float(t.get("tutar") or 0)
            toplam_kt += tutar
            tur    = _TESLIM_TUR.get(t.get("teslim_turu") or "", t.get("teslim_turu") or "")
            eden   = str(t.get("teslim_eden_ad") or "").strip() or "—"
            alan   = str(t.get("teslim_alan_ad") or "").strip() or "—"
            sube   = str(t.get("sube_adi") or "").strip()
            s.append(f"  • {sube} — {tur}: {_fmt(tutar)}")
            s.append(f"    {eden} → {alan}")
        if len(kt_liste) > 1:
            s.append(f"  Toplam: *{_fmt(toplam_kt)}*")

    # Toptancı teslimler
    if toptanci:
        s.append("")
        s.append("*BUGÜN TESLİM ALINAN*")
        for t in toptanci:
            s.append(f"  • {t['sube']} — {t['tedarikci']}")
            if t["kalemler"]:
                s.append(f"    {', '.join(t['kalemler'])}")

    return "\n".join(s)


# ── Green API Gönderim ────────────────────────────────────────────────────────

def whatsapp_gonder(mesaj: str) -> bool:
    instance_id = os.getenv("WA_INSTANCE_ID", "").strip()
    token       = os.getenv("WA_TOKEN", "").strip()
    group_id    = os.getenv("WA_GROUP_ID", "").strip()

    if not all([instance_id, token, group_id]):
        logger.warning("WhatsApp: ortam değişkenleri eksik — atlanıyor")
        return False

    url     = f"https://api.green-api.com/waInstance{instance_id}/sendMessage/{token}"
    payload = json.dumps({"chatId": group_id, "message": mesaj}).encode("utf-8")
    req     = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("idMessage"):
                logger.info(f"WhatsApp: gönderildi — {data['idMessage']}")
                return True
            logger.warning(f"WhatsApp: beklenmedik yanıt — {str(data)[:200]}")
            return False
    except urllib.error.HTTPError as e:
        logger.error(f"WhatsApp HTTP hatası: {e.code}")
        return False
    except Exception as e:
        logger.error(f"WhatsApp hatası: {e}")
        return False


def gunluk_ozet_gonder(tarih: date | None = None) -> dict:
    try:
        mesaj    = gunluk_ozet_mesaj_olustur(tarih)
        basarili = whatsapp_gonder(mesaj)
        return {"basarili": basarili, "mesaj_onizleme": mesaj[:400] + "..."}
    except Exception as e:
        logger.error(f"WhatsApp günlük özet hatası: {e}")
        return {"basarili": False, "hata": str(e)}
