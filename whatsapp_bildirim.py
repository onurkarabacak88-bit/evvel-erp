"""
Evvel ERP — WhatsApp Günlük Özet Bildirimi
Green API üzerinden ortaklar grubuna gece 00:15'te gönderilir.

Ortam değişkenleri (.env):
    WA_INSTANCE_ID   — Green API instance ID (örn: 1101XXXXXX)
    WA_TOKEN         — Green API API token
    WA_GROUP_ID      — Grup chat ID (örn: 905XXXXXXXXX-1234567890@g.us)

Green API ücretsiz: https://green-api.com  (100 msg/gün yeterli)
"""

import os
import json
import logging
import urllib.request
import urllib.error
from datetime import date, timedelta
from database import db

logger = logging.getLogger(__name__)


# ── Yardımcı ──────────────────────────────────────────────────────────────────

def _fmt(val) -> str:
    """Sayıyı Türkçe formatlı stringe çevir: 12500 → '12.500 ₺'"""
    try:
        return f"{int(float(val or 0)):,}".replace(",", ".") + " ₺"
    except Exception:
        return "— ₺"


def _trend(simdiki, onceki) -> str:
    """Yüzde değişim oku: ▲ +12% veya ▼ -8% veya —"""
    try:
        s = float(simdiki or 0)
        o = float(onceki or 0)
        if o == 0:
            return ""
        pct = round((s - o) / o * 100)
        if pct > 0:
            return f"▲ +{pct}%"
        elif pct < 0:
            return f"▼ {pct}%"
        return "→ 0%"
    except Exception:
        return ""


# ── Veri Toplama ──────────────────────────────────────────────────────────────

def _sube_ciro_tarih(cur, tarih: date) -> dict:
    """
    Bir tarihin şube bazlı ciro toplamları.
    Öncelik sırası (onay durumundan bağımsız — kapanış takip esası):
      1. kapanis_kayit — şubenin kapanışta girdiği nakit+pos+online (en güvenilir)
      2. ciro — onaylı ciro (aktif)
      3. ciro_taslak — onay bekleyen taslak
    """
    sonuc = {}

    # 1. Kapanış kayıtları — iptal olmayanlar, onay bekliyor olsa da alınır
    cur.execute("""
        SELECT sube_id,
               COALESCE(nakit, 0) + COALESCE(pos, 0) + COALESCE(online, 0) AS tutar
        FROM kapanis_kayit
        WHERE tarih = %s AND durum != 'iptal'
    """, (tarih,))
    for r in (cur.fetchall() or []):
        sonuc[str(r["sube_id"])] = float(r["tutar"] or 0)

    # 2. Onaylı ciro — kapanış kaydı yoksa
    cur.execute("""
        SELECT sube_id, COALESCE(SUM(toplam), 0) AS tutar
        FROM ciro
        WHERE tarih = %s AND durum = 'aktif'
        GROUP BY sube_id
    """, (tarih,))
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        if sid not in sonuc:
            sonuc[sid] = float(r["tutar"] or 0)

    # 3. Taslak — ikisi de yoksa
    cur.execute("""
        SELECT sube_id,
               COALESCE(SUM(COALESCE(nakit,0)+COALESCE(pos,0)+COALESCE(online,0)), 0) AS tutar
        FROM ciro_taslak
        WHERE tarih = %s AND durum = 'bekliyor'
        GROUP BY sube_id
    """, (tarih,))
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        if sid not in sonuc:
            sonuc[sid] = float(r["tutar"] or 0)

    return sonuc  # {sube_id: tutar}


def _ciro_verileri(cur, tarih: date) -> dict:
    """O günün şube bazlı ciroları + dünle karşılaştırma."""
    dun = tarih - timedelta(days=1)

    # Aktif şubeler
    cur.execute("SELECT id, ad FROM subeler WHERE aktif = TRUE ORDER BY ad")
    subeler_liste = cur.fetchall() or []

    bugun_map = _sube_ciro_tarih(cur, tarih)
    dun_map   = _sube_ciro_tarih(cur, dun)

    subeler = []
    toplam_bugun = 0
    toplam_dun = 0

    for row in subeler_liste:
        sid = str(row["id"])
        ciro = bugun_map.get(sid, 0)
        d    = dun_map.get(sid, 0)
        toplam_bugun += ciro
        toplam_dun   += d
        subeler.append({
            "ad":      row["ad"],
            "ciro":    ciro,
            "dun":     d,
            "trend":   _trend(ciro, d),
            "girilmis": ciro > 0,
        })

    return {
        "subeler": subeler,
        "toplam": toplam_bugun,
        "toplam_trend": _trend(toplam_bugun, toplam_dun),
    }


def _kasa_verileri(cur, tarih: date) -> dict:
    """Güncel kasa bakiyesi (tüm zamanlar SUM) + bugün giren/çıkan."""
    # Anlık kasa = kasa_etkisi=true olan tüm hareketlerin toplamı
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS bakiye
        FROM kasa_hareketleri
        WHERE kasa_etkisi = TRUE
    """)
    row = cur.fetchone()
    kasa = float(row["bakiye"] or 0) if row else 0

    # Bugün giren (pozitif hareketler)
    cur.execute("""
        SELECT COALESCE(SUM(tutar), 0) AS toplam
        FROM kasa_hareketleri
        WHERE DATE(olusturma AT TIME ZONE 'Europe/Istanbul') = %s
          AND tutar > 0
          AND kasa_etkisi = TRUE
    """, (tarih,))
    giren = float((cur.fetchone() or {}).get("toplam") or 0)

    # Bugün çıkan (negatif hareketler)
    cur.execute("""
        SELECT COALESCE(SUM(ABS(tutar)), 0) AS toplam
        FROM kasa_hareketleri
        WHERE DATE(olusturma AT TIME ZONE 'Europe/Istanbul') = %s
          AND tutar < 0
          AND kasa_etkisi = TRUE
    """, (tarih,))
    cikan = float((cur.fetchone() or {}).get("toplam") or 0)

    return {"kasa": kasa, "giren": giren, "cikan": cikan}


def _anlik_giderler(cur, tarih: date) -> list:
    """O günün anlık gider kalemleri."""
    cur.execute("""
        SELECT aciklama, kategori, COALESCE(tutar, 0) AS tutar
        FROM anlik_giderler
        WHERE tarih = %s
          AND (durum IS NULL OR durum NOT IN ('iptal', 'red'))
        ORDER BY olusturma DESC
        LIMIT 20
    """, (tarih,))
    return [dict(r) for r in (cur.fetchall() or [])]


def _yarin_odemeler(cur, tarih: date) -> list:
    """Yarın vadesi gelen ödeme planı kalemleri."""
    yarin = tarih + timedelta(days=1)
    cur.execute("""
        SELECT op.aciklama, op.tutar, op.kaynak_tablo
        FROM odeme_plani op
        WHERE op.planlanan_tarih = %s
          AND op.durum = 'bekliyor'
        ORDER BY op.tutar DESC
        LIMIT 10
    """, (yarin,))
    return [dict(r) for r in (cur.fetchall() or [])]


def _bu_ay_ciro(cur, tarih: date) -> float:
    """
    Bu ayın başından bugüne kümülatif ciro.
    Her şube+gün için: kapanış kaydı → onaylı ciro → taslak (öncelik sırasıyla).
    """
    ay_basi = tarih.replace(day=1)

    # Kapanış kayıtlarından gelen (iptal olmayanlar)
    cur.execute("""
        SELECT sube_id, tarih,
               COALESCE(nakit,0) + COALESCE(pos,0) + COALESCE(online,0) AS tutar
        FROM kapanis_kayit
        WHERE tarih >= %s AND tarih <= %s AND durum != 'iptal'
    """, (ay_basi, tarih))
    kapanis_map = {(str(r["sube_id"]), str(r["tarih"])): float(r["tutar"] or 0)
                   for r in (cur.fetchall() or [])}

    # Onaylı ciro — kapanış kaydı olmayan gün/şube çiftleri için
    cur.execute("""
        SELECT sube_id, tarih::date AS tarih, COALESCE(SUM(toplam), 0) AS tutar
        FROM ciro
        WHERE tarih >= %s AND tarih <= %s AND durum = 'aktif'
        GROUP BY sube_id, tarih::date
    """, (ay_basi, tarih))
    aktif_map = {}
    for r in (cur.fetchall() or []):
        k = (str(r["sube_id"]), str(r["tarih"]))
        if k not in kapanis_map:
            aktif_map[k] = float(r["tutar"] or 0)

    # Taslak — ikisi de yoksa
    cur.execute("""
        SELECT ct.sube_id, ct.tarih::date AS tarih,
               COALESCE(SUM(COALESCE(ct.nakit,0)+COALESCE(ct.pos,0)+COALESCE(ct.online,0)),0) AS tutar
        FROM ciro_taslak ct
        WHERE ct.tarih >= %s AND ct.tarih <= %s AND ct.durum = 'bekliyor'
        GROUP BY ct.sube_id, ct.tarih::date
    """, (ay_basi, tarih))
    taslak_map = {}
    for r in (cur.fetchall() or []):
        k = (str(r["sube_id"]), str(r["tarih"]))
        if k not in kapanis_map and k not in aktif_map:
            taslak_map[k] = float(r["tutar"] or 0)

    toplam = (sum(kapanis_map.values()) +
              sum(aktif_map.values()) +
              sum(taslak_map.values()))
    return toplam


def _toptanci_teslimler(cur, tarih: date) -> list:
    """O gün yapılan ürün teslim alımları (URUN_SEVK kayıtları)."""
    cur.execute("""
        SELECT d.sube_id, s.ad AS sube_adi, d.aciklama
        FROM operasyon_defter d
        JOIN subeler s ON s.id = d.sube_id
        WHERE d.etiket = 'URUN_SEVK'
          AND d.tarih = %s
          AND d.aciklama LIKE 'URUN_SEVK_JSON:%%'
        ORDER BY d.olay_ts
    """, (tarih,))
    rows = cur.fetchall() or []

    teslimler = []
    for r in rows:
        aciklama = str(r["aciklama"] or "")
        payload = {}
        try:
            json_str = aciklama[len("URUN_SEVK_JSON:"):].split(" | ")[0].strip()
            payload = json.loads(json_str)
        except Exception:
            pass

        tedarikci = str(payload.get("tedarikci") or "").strip() or "—"
        kalemler = payload.get("kalemler") or []
        delta = payload.get("delta") or {}

        kalem_metni = []
        for k in (kalemler if isinstance(kalemler, list) else []):
            ad = str(k.get("urun_ad") or k.get("ad") or "").strip()
            adet = int(k.get("adet") or 0)
            if ad and adet > 0:
                kalem_metni.append(f"{ad} {adet} adet")
        if not kalem_metni and isinstance(delta, dict):
            for k, v in delta.items():
                try:
                    adet = int(v or 0)
                    if adet > 0:
                        kalem_metni.append(f"{k} {adet}")
                except Exception:
                    pass

        teslimler.append({
            "sube": r["sube_adi"],
            "tedarikci": tedarikci,
            "kalemler": kalem_metni[:5],  # max 5 kalem
        })

    return teslimler


# ── Mesaj Oluşturma ───────────────────────────────────────────────────────────

def gunluk_ozet_mesaj_olustur(tarih: date | None = None) -> str:
    """
    Verilen tarih için (varsayılan: dün) günlük özet mesajını oluşturur.
    00:15'te çağrılır — tarih = bugün - 1 gün (kapanan günün özeti).
    """
    from tr_saat import bugun_tr
    if tarih is None:
        tarih = bugun_tr() - timedelta(days=1)

    with db() as (conn, cur):
        ciro = _ciro_verileri(cur, tarih)
        kasa = _kasa_verileri(cur, tarih)
        giderler = _anlik_giderler(cur, tarih)
        yarin = _yarin_odemeler(cur, tarih)
        ay_ciro = _bu_ay_ciro(cur, tarih)
        teslimler = _toptanci_teslimler(cur, tarih)

    tarih_str = tarih.strftime("%-d %B").replace(
        "January", "Ocak").replace("February", "Şubat").replace(
        "March", "Mart").replace("April", "Nisan").replace(
        "May", "Mayıs").replace("June", "Haziran").replace(
        "July", "Temmuz").replace("August", "Ağustos").replace(
        "September", "Eylül").replace("October", "Ekim").replace(
        "November", "Kasım").replace("December", "Aralık")

    satirlar = [f"🌙 *Evvel — {tarih_str} Günlük Özet*", ""]

    # ── Cirolar ──
    satirlar.append("*CİROLAR*")
    eksik_subeler = []
    for s in ciro["subeler"]:
        if not s["girilmis"]:
            eksik_subeler.append(s["ad"])
            satirlar.append(f"⚠️ {s['ad']:<12} kapanış girilmedi")
        else:
            trend = f"  {s['trend']}" if s["trend"] else ""
            satirlar.append(f"  {s['ad']:<12} {_fmt(s['ciro'])}{trend}")

    trend_toplam = f"  {ciro['toplam_trend']}" if ciro["toplam_trend"] else ""
    satirlar.append(f"  {'Toplam':<12} *{_fmt(ciro['toplam'])}*{trend_toplam}")
    satirlar.append("")

    # ── Kasa ──
    satirlar.append(f"*KASA: {_fmt(kasa['kasa'])}*")
    satirlar.append(f"  Bugün giren:  +{_fmt(kasa['giren'])}")
    satirlar.append(f"  Bugün çıkan:  -{_fmt(kasa['cikan'])}")
    satirlar.append("")

    # ── Anlık giderler ──
    if giderler:
        satirlar.append("*ANLIK GİDERLER*")
        toplam_gider = 0
        for g in giderler:
            ad = str(g.get("aciklama") or g.get("kategori") or "Gider")[:30]
            tutar = float(g.get("tutar") or 0)
            toplam_gider += tutar
            satirlar.append(f"  • {ad:<28} {_fmt(tutar)}")
        if len(giderler) > 1:
            satirlar.append(f"  {'Toplam':<30} {_fmt(toplam_gider)}")
        satirlar.append("")

    # ── Yarın ödemeler ──
    if yarin:
        satirlar.append("*YARIN ÖDEMELER*")
        toplam_yarin = 0
        kaynak_etiket = {
            "sabit_giderler": "Sabit Gider",
            "personel": "Maaş",
            "vadeli_alimlar": "Vadeli",
            "borc_envanteri": "Kredi/Borç",
        }
        for o in yarin:
            ad = str(o.get("aciklama") or "")[:28]
            tutar = float(o.get("tutar") or 0)
            toplam_yarin += tutar
            kaynak = kaynak_etiket.get(o.get("kaynak_tablo") or "", "")
            etiket = f" ({kaynak})" if kaynak else ""
            satirlar.append(f"  • {ad}{etiket}  {_fmt(tutar)}")
        if len(yarin) > 1:
            satirlar.append(f"  Toplam: *{_fmt(toplam_yarin)}*")
        satirlar.append("")

    # ── Bu ay kümülatif ciro ──
    satirlar.append(f"Bu ay: *{_fmt(ay_ciro)}*")

    # ── Toptancı teslimler ──
    if teslimler:
        satirlar.append("")
        satirlar.append("*BUGÜN TESLİM ALINAN*")
        for t in teslimler:
            kalem_str = ", ".join(t["kalemler"]) if t["kalemler"] else "—"
            satirlar.append(f"  • {t['sube']} — {t['tedarikci']}")
            if t["kalemler"]:
                satirlar.append(f"    {kalem_str}")

    return "\n".join(satirlar)


# ── Green API Gönderim ────────────────────────────────────────────────────────

def whatsapp_gonder(mesaj: str) -> bool:
    """
    Green API üzerinden grup mesajı gönderir.
    Başarıda True, hata durumunda False döner (exception fırlatmaz).
    """
    instance_id = os.getenv("WA_INSTANCE_ID", "").strip()
    token = os.getenv("WA_TOKEN", "").strip()
    group_id = os.getenv("WA_GROUP_ID", "").strip()

    if not all([instance_id, token, group_id]):
        logger.warning("WhatsApp: WA_INSTANCE_ID, WA_TOKEN veya WA_GROUP_ID eksik — mesaj atlanıyor")
        return False

    url = f"https://api.green-api.com/waInstance{instance_id}/sendMessage/{token}"
    payload = json.dumps({"chatId": group_id, "message": mesaj}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            if data.get("idMessage"):
                logger.info(f"WhatsApp: Mesaj gönderildi — {data['idMessage']}")
                return True
            logger.warning(f"WhatsApp: Beklenmedik yanıt — {body[:200]}")
            return False
    except urllib.error.HTTPError as e:
        logger.error(f"WhatsApp HTTP hatası: {e.code} — {e.read().decode()[:200]}")
        return False
    except Exception as e:
        logger.error(f"WhatsApp gönderim hatası: {e}")
        return False


# ── Manuel Test / FastAPI Endpoint için ──────────────────────────────────────

def gunluk_ozet_gonder(tarih: date | None = None) -> dict:
    """Mesajı oluştur ve gönder. Scheduler ve test endpoint'i buradan çağırır."""
    try:
        mesaj = gunluk_ozet_mesaj_olustur(tarih)
        basarili = whatsapp_gonder(mesaj)
        return {"basarili": basarili, "mesaj_onizleme": mesaj[:300] + "..."}
    except Exception as e:
        logger.error(f"WhatsApp günlük özet hatası: {e}")
        return {"basarili": False, "hata": str(e)}
