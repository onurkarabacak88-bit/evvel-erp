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

import os, re, json, logging, urllib.request, urllib.error
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


# ── Ciro: /kapanis-takip ile birebir aynı mantık ─────────────────────────────

def _x_rapor_ciro(kap: dict) -> dict:
    """
    sube_operasyon_event satırından X raporu nakit/pos/online.
    Önce meta.x_rapor, yoksa snap_nakit/snap_pos/snap_online.
    Kapanış Takip sayfasıyla aynı fonksiyon.
    """
    meta = {}
    try:
        m = kap.get("meta")
        if isinstance(m, str):
            meta = json.loads(m)
        elif isinstance(m, dict):
            meta = m
    except Exception:
        pass
    xr = meta.get("x_rapor") if isinstance(meta.get("x_rapor"), dict) else {}
    out = {}
    for key, snap_key in (("nakit","snap_nakit"),("pos","snap_pos"),("online","snap_online")):
        val = None
        if isinstance(xr, dict) and key in xr and xr.get(key) is not None:
            val = float(xr.get(key) or 0)
        elif kap.get(snap_key) is not None:
            val = float(kap.get(snap_key) or 0)
        out[key] = val
    return out

def _sube_ciro_gun(cur, tarih: date) -> dict:
    """
    Tek gün şube bazlı ciro + kapanış yapan kişi + saat.
    /kapanis-takip ile birebir:
    1. sube_operasyon_event KAPANIS tamamlandi → X raporu + personel + saat
    2. ciro aktif
    3. ciro_taslak
    Döner: {sube_id: {tutar, personel, saat}}
    """
    # 1. Kapanış event — kapanis-takip ile birebir aynı sorgu
    # Önce o günü, yoksa ertesi günü dene (gece 02:00'e kadar önceki iş günü)
    cur.execute("""
        SELECT DISTINCT ON (e.sube_id)
               e.sube_id::text,
               e.snap_nakit, e.snap_pos, e.snap_online, e.meta,
               COALESCE(e.personel_ad, '') AS personel_ad,
               (e.cevap_ts AT TIME ZONE 'Europe/Istanbul') AS kapanis_ts
        FROM sube_operasyon_event e
        WHERE e.tip = 'KAPANIS' AND e.durum = 'tamamlandi'
          AND e.tarih = %s
        ORDER BY e.sube_id, e.cevap_ts DESC NULLS LAST, e.id DESC
    """, (tarih,))
    rows = list(cur.fetchall() or [])
    # Eksik şubeler için ertesi günü de kontrol et
    bulunan = {str(r["sube_id"]) for r in rows}
    cur.execute("""
        SELECT DISTINCT ON (e.sube_id)
               e.sube_id::text,
               e.snap_nakit, e.snap_pos, e.snap_online, e.meta,
               COALESCE(e.personel_ad, '') AS personel_ad,
               (e.cevap_ts AT TIME ZONE 'Europe/Istanbul') AS kapanis_ts
        FROM sube_operasyon_event e
        WHERE e.tip = 'KAPANIS' AND e.durum = 'tamamlandi'
          AND e.tarih = %s
          -- FIX WA1 (2026-07-06): ertesi-gün event YALNIZ gece penceresinde (TR saat<2) kabul —
          -- 00:00-02:00 kapanış önceki iş gününe aittir; ertesi gün öğlen/akşam yapılan NORMAL
          -- kapanış düne sızmasın (geç mühür sızıntısı kuralı whatsapp özetinde uygulanmıyordu).
          AND EXTRACT(HOUR FROM (e.cevap_ts AT TIME ZONE 'Europe/Istanbul')) < 2
        ORDER BY e.sube_id, e.cevap_ts DESC NULLS LAST, e.id DESC
    """, (tarih + timedelta(days=1),))
    for r in (cur.fetchall() or []):
        if str(r["sube_id"]) not in bulunan:
            rows.append(r)
    sonuc = {}
    for r in rows:
        sid = str(r["sube_id"])
        xr  = _x_rapor_ciro(dict(r))
        ts  = r["kapanis_ts"]
        saat_str  = ts.strftime("%H:%M") if ts else ""
        personel  = str(r["personel_ad"] or "").strip()
        # Kapanış event var — personel + saat kaydedilir
        # Ama tutar için: x_rapor > 0 ise onu kullan, değilse ciro tablosuna bırak
        if xr.get("nakit") is not None:
            t = float(xr["nakit"] or 0) + float(xr["pos"] or 0) + float(xr["online"] or 0)
            if t > 0:
                sonuc[sid] = {"tutar": t, "personel": personel, "saat": saat_str}
            else:
                # tutar 0 geldi — personel/saati sakla, tutar ciro tablosundan gelecek
                sonuc[sid] = {"tutar": 0, "personel": personel, "saat": saat_str, "_tutar_eksik": True}
        else:
            sonuc[sid] = {"tutar": 0, "personel": personel, "saat": saat_str, "_tutar_eksik": True}

    # 2. Onaylı ciro — kapanış yoksa veya kapanışta tutar eksikse
    cur.execute("""
        SELECT sube_id::text, COALESCE(SUM(toplam),0) AS tutar
        FROM ciro WHERE tarih=%s AND durum='aktif' GROUP BY sube_id
    """, (tarih,))
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        tutar = float(r["tutar"] or 0)
        if sid not in sonuc:
            sonuc[sid] = {"tutar": tutar, "personel": "", "saat": ""}
        elif sonuc[sid].get("_tutar_eksik") and tutar > 0:
            # Kapanış event var (personel/saat biliniyor) ama tutar eksikti
            sonuc[sid]["tutar"] = tutar
            sonuc[sid].pop("_tutar_eksik", None)

    # 3. Taslak — hâlâ eksikse
    cur.execute("""
        SELECT DISTINCT ON (t.sube_id) t.sube_id::text,
               COALESCE(t.nakit,0)+COALESCE(t.pos,0)+COALESCE(t.online,0) AS tutar
        FROM ciro_taslak t
        WHERE t.tarih=%s AND t.durum IN ('bekliyor','onaylandi')
        ORDER BY t.sube_id, CASE t.durum WHEN 'onaylandi' THEN 0 ELSE 1 END, t.olusturma DESC
    """, (tarih,))
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        tutar = float(r["tutar"] or 0)
        if sid not in sonuc:
            sonuc[sid] = {"tutar": tutar, "personel": "", "saat": ""}
        elif sonuc[sid].get("_tutar_eksik") and tutar > 0:
            sonuc[sid]["tutar"] = tutar
            sonuc[sid].pop("_tutar_eksik", None)

    return sonuc

def _sube_nakit_gun(cur, tarih: date) -> dict:
    """
    Tek gün şube bazlı NAKİT tutarı — Merkez onayından BAĞIMSIZ (taslak dahil).
    Öncelik: 1. KAPANIS x_rapor nakit  2. ciro.nakit (aktif)  3. ciro_taslak.nakit (bekliyor/onaylandi)
    Döner: {sube_id: nakit_tutar}
    """
    sonuc = {}
    cur.execute("""
        SELECT DISTINCT ON (e.sube_id)
               e.sube_id::text, e.snap_nakit, e.snap_pos, e.snap_online, e.meta
        FROM sube_operasyon_event e
        WHERE e.tip = 'KAPANIS' AND e.durum = 'tamamlandi'
          -- FIX WA1 (2026-07-06): bugün her saat; ertesi gün YALNIZ gece penceresi (TR saat<2)
          AND (e.tarih = %s
               OR (e.tarih = %s AND EXTRACT(HOUR FROM (e.cevap_ts AT TIME ZONE 'Europe/Istanbul')) < 2))
        ORDER BY e.sube_id, e.cevap_ts DESC NULLS LAST, e.id DESC
    """, (tarih, tarih + timedelta(days=1)))
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        xr = _x_rapor_ciro(dict(r))
        if xr.get("nakit") is not None and float(xr["nakit"] or 0) > 0:
            sonuc[sid] = float(xr["nakit"] or 0)

    cur.execute("""
        SELECT sube_id::text, COALESCE(SUM(nakit),0) AS nakit
        FROM ciro WHERE tarih=%s AND durum='aktif' GROUP BY sube_id
    """, (tarih,))
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        if sid not in sonuc:
            sonuc[sid] = float(r["nakit"] or 0)

    cur.execute("""
        SELECT DISTINCT ON (t.sube_id) t.sube_id::text, COALESCE(t.nakit,0) AS nakit
        FROM ciro_taslak t
        WHERE t.tarih=%s AND t.durum IN ('bekliyor','onaylandi')
        ORDER BY t.sube_id, CASE t.durum WHEN 'onaylandi' THEN 0 ELSE 1 END, t.olusturma DESC
    """, (tarih,))
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        if sid not in sonuc:
            sonuc[sid] = float(r["nakit"] or 0)

    return sonuc


def _ciro_verileri(cur, tarih: date) -> dict:
    cur.execute("SELECT id, ad FROM subeler WHERE aktif=TRUE ORDER BY ad")
    subeler_liste = cur.fetchall() or []
    bugun_map = _sube_ciro_gun(cur, tarih)
    dun_map   = _sube_ciro_gun(cur, tarih - timedelta(days=1))

    subeler, toplam_bugun, toplam_dun = [], 0, 0
    for row in subeler_liste:
        sid   = str(row["id"])
        bg    = bugun_map.get(sid, {})
        ciro  = bg.get("tutar", 0) if isinstance(bg, dict) else float(bg or 0)
        dg    = dun_map.get(sid, {})
        d     = dg.get("tutar", 0) if isinstance(dg, dict) else float(dg or 0)
        toplam_bugun += ciro
        toplam_dun   += d
        subeler.append({
            "sid":      sid,
            "ad":       row["ad"],
            "ciro":     ciro,
            "dun":      d,
            "trend":    _trend(ciro, d),
            "girilmis": ciro > 0,
            "personel": bg.get("personel", "") if isinstance(bg, dict) else "",
            "saat":     bg.get("saat", "") if isinstance(bg, dict) else "",
        })
    return {"subeler": subeler, "toplam": toplam_bugun,
            "toplam_trend": _trend(toplam_bugun, toplam_dun)}


# ── Bu ay ciro — motors.py finans_ozet_motoru ile aynı ──────────────────────

def _bu_ay_ciro(cur, tarih: date) -> float:
    """
    finans_ozet_motoru: ciro WHERE durum='aktif' AND bu ay.
    Bu değer CFO Panel'deki 'Bu Ay Ciro' ile birebir aynı.
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
    Kasa bakiyesi + bugünün ciro tutarı + çıkan.
    Dış kaynak (kira gelirleri vb.) ayrı kanal — mesaja dahil edilmiyor.
    """
    # Anlık kasa bakiyesi
    cur.execute("""
        SELECT COALESCE(SUM(tutar),0) AS bakiye
        FROM kasa_hareketleri WHERE kasa_etkisi=TRUE AND durum='aktif'
    """)
    kasa = float((cur.fetchone() or {}).get("bakiye") or 0)

    # Bugün yapılan toplam NAKİT iş — Merkez onayından bağımsız (taslak dahil),
    # kaç şubeden geldiyse hepsinin nakit toplamı
    bugun_ciro = sum(_sube_nakit_gun(cur, tarih).values())

    # Bugün kasa'dan çıkan
    cur.execute("""
        SELECT COALESCE(SUM(ABS(tutar)),0) AS toplam
        FROM kasa_hareketleri
        WHERE kasa_etkisi=TRUE AND durum='aktif' AND tutar<0
          AND tarih = %s
    """, (tarih,))
    cikan = float((cur.fetchone() or {}).get("toplam") or 0)

    # Dün nakit (trend için)
    dun = tarih - timedelta(days=1)
    dun_ciro = sum(_sube_nakit_gun(cur, dun).values())

    return {"kasa": kasa, "bugun_ciro": bugun_ciro, "cikan": cikan,
            "ciro_trend": _trend(bugun_ciro, dun_ciro)}


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


# ── Vardiya personeli ────────────────────────────────────────────────────────

def _vardiya_personel(cur, tarih: date) -> dict:
    """
    O günün kapanış + yarının açılış personeli şube bazlı.

    Kapanış: tarih günü KAPANIS tamamlandi event → personel_ad + saat
    Yarın açılış: kapanis_kayit.sabahci_personel_id + aksamci_personel_id
                  (vardiya devir formunda girilen sabah personeli = yarın açacak kişi)
                  Yoksa tarih+1 ACILIS event (sabah erken girilmişse)

    Döner: {sube_id: {kapanis: "Ad", kapanis_saat: "23:47",
                       yarin_acilis: ["Ad1", "Ad2"]}}
    """
    # Kapanış event (bugün)
    cur.execute("""
        SELECT DISTINCT ON (e.sube_id)
               e.sube_id::text,
               COALESCE(e.personel_ad,'') AS personel_ad,
               (e.cevap_ts AT TIME ZONE 'Europe/Istanbul') AS ts
        FROM sube_operasyon_event e
        WHERE e.tip = 'KAPANIS' AND e.durum = 'tamamlandi'
          -- FIX WA1 (2026-07-06): bugün her saat; ertesi gün YALNIZ gece penceresi (TR saat<2)
          AND (e.tarih = %s
               OR (e.tarih = %s AND EXTRACT(HOUR FROM (e.cevap_ts AT TIME ZONE 'Europe/Istanbul')) < 2))
        ORDER BY e.sube_id, e.cevap_ts DESC NULLS LAST, e.id DESC
    """, (tarih, tarih + timedelta(days=1)))
    kapanis_map = {}
    for r in (cur.fetchall() or []):
        ts = r["ts"]
        kapanis_map[str(r["sube_id"])] = {
            "ad":   str(r["personel_ad"] or ""),
            "saat": ts.strftime("%H:%M") if ts else "",
        }

    # Yarın açılışçılar: vardiya_v2.gun_planini_getir ile aynı sorgu
    # slot.tip IN ('acilis','normal') — sabah vardiyasındaki herkesi al
    # haftanin_gunu: Python weekday()+1 → 1=Pzt..7=Paz
    yarin = tarih + timedelta(days=1)
    yarin_haftanin_gunu = yarin.weekday() + 1
    cur.execute("""
        SELECT vs.sube_id::text,
               COALESCE(NULLIF(TRIM(p.ad_soyad),''), va.personel_id::text) AS personel_ad,
               vs.tip AS slot_tip,
               vs.baslangic_saat
        FROM vardiya_atama va
        JOIN vardiya_slot vs ON vs.id = va.slot_id
        JOIN personel p ON p.id = va.personel_id
        WHERE va.tarih = %s
          AND va.durum IN ('planli','onayli')
          AND vs.aktif = TRUE
          AND %s = ANY(vs.aktif_gunler)
          AND vs.baslangic_saat < '14:00'
        ORDER BY vs.sube_id, vs.baslangic_saat, vs.sira NULLS LAST
    """, (yarin, yarin_haftanin_gunu))
    yarin_map = {}
    for r in (cur.fetchall() or []):
        sid = str(r["sube_id"])
        ad  = str(r["personel_ad"] or "").strip()
        if ad:
            yarin_map.setdefault(sid, [])
            if ad not in yarin_map[sid]:
                yarin_map[sid].append(ad)

    # Birleştir
    sonuc = {}
    tum = set(kapanis_map) | set(yarin_map)
    for sid in tum:
        kap = kapanis_map.get(sid, {})
        sonuc[sid] = {
            "kapanis":      kap.get("ad", ""),
            "kapanis_saat": kap.get("saat", ""),
            "yarin_acilis": yarin_map.get(sid, []),
        }
    return sonuc


# ── Dış kaynak (kira gelirleri) ──────────────────────────────────────────────

def _dis_kaynak_verileri(cur, tarih: date) -> dict:
    """
    Kira gelirleri ve diğer dış kaynaklar.
    Bugün gelen + bu ay toplam.
    Kaynak: kasa_hareketleri WHERE islem_turu='DIS_KAYNAK'
    """
    # Bugün gelen dış kaynak
    cur.execute("""
        SELECT COALESCE(SUM(tutar),0) AS toplam,
               COUNT(*) AS adet
        FROM kasa_hareketleri
        WHERE islem_turu = 'DIS_KAYNAK'
          AND kasa_etkisi = TRUE AND durum = 'aktif'
          AND tarih = %s
    """, (tarih,))
    row = cur.fetchone() or {}
    bugun = float(row.get("toplam") or 0)
    bugun_adet = int(row.get("adet") or 0)

    # Bu ay toplam dış kaynak
    cur.execute("""
        SELECT COALESCE(SUM(tutar),0) AS toplam
        FROM kasa_hareketleri
        WHERE islem_turu = 'DIS_KAYNAK'
          AND kasa_etkisi = TRUE AND durum = 'aktif'
          AND DATE_TRUNC('month', tarih) = DATE_TRUNC('month', %s::date)
    """, (tarih,))
    ay_toplam = float((cur.fetchone() or {}).get("toplam") or 0)

    return {"bugun": bugun, "bugun_adet": bugun_adet, "ay_toplam": ay_toplam}


# ── Yarın ödemeler ───────────────────────────────────────────────────────────

def _yarin_odemeler(cur, tarih: date) -> list:
    """
    Yarın vadesi gelen ödemeler — motors.py yaklasan_odemeler ile aynı defansif filtre.
    Zaten kasadan ödenmiş planlar gösterilmez.
    """
    yarin = tarih + timedelta(days=1)

    # 1. odeme_plani kaydı olanlar
    cur.execute("""
        SELECT op.aciklama, op.odenecek_tutar AS tutar, op.kaynak_tablo
        FROM odeme_plani op
        WHERE op.durum IN ('bekliyor','onay_bekliyor')
          AND op.tarih = %s
        ORDER BY op.odenecek_tutar DESC
        LIMIT 10
    """, (yarin,))
    liste = [dict(r) for r in (cur.fetchall() or [])]

    # 2. sabit_giderler degisken tipi — motors.py ile aynı mantık
    # odeme_gunu <= yarin.day + 3 (panel ile aynı pencere)
    import calendar as _cal
    # FIX WA2 (2026-07-06): ay sonu sarması — BETWEEN yarin_gun AND yarin_gun+3, gün numarası ayı
    # aşınca (29/30/31 → 32...) ayın 1-3'ünde ödenen değişken giderleri pencereden düşürüyordu.
    # Gerçek sonraki 4 takvim gününün gün-numaralarını üret (sarma-doğru).
    gun_pencere = sorted({(yarin + timedelta(days=i)).day for i in range(4)})
    cur.execute("""
        SELECT id, gider_adi, odeme_gunu, tutar
        FROM sabit_giderler
        WHERE aktif = TRUE AND tip = 'degisken'
          AND odeme_gunu = ANY(%s)
    """, (gun_pencere,))
    for g in (cur.fetchall() or []):
        # Bu ay zaten ödendi mi?
        cur.execute("""
            SELECT 1 FROM kasa_hareketleri
            WHERE kaynak_id = %s AND kaynak_tablo = 'sabit_giderler'
              AND islem_turu = 'FATURA_ODEMESI' AND kasa_etkisi = TRUE AND durum = 'aktif'
              AND EXTRACT(YEAR FROM tarih) = %s AND EXTRACT(MONTH FROM tarih) = %s
        """, (str(g['id']), yarin.year, yarin.month))
        if cur.fetchone():
            continue
        liste.append({
            'aciklama': g['gider_adi'],
            'tutar': float(g['tutar'] or 0),
            'kaynak_tablo': 'sabit_giderler',
        })

    return sorted(liste, key=lambda x: float(x.get('tutar') or 0), reverse=True)[:10]


# ── Tutarı girilmemiş faturalar (unutma yakalayıcısı) ────────────────────────

def _girilmemis_faturalar(cur, tarih: date) -> list:
    """Değişken giderler: ödeme günü geldi/geçti ama bu ay ne ödeme izi ne plan var —
    yani bu ayın fatura tutarı HİÇ girilmemiş. Gece özetinde ayrı bölüm
    (kullanıcı 2026-07-04: 'girmeyi unutmayacak bir sistem kurmalıyız')."""
    cur.execute("""
        SELECT id, gider_adi, odeme_gunu, tutar
        FROM sabit_giderler
        WHERE aktif = TRUE AND tip = 'degisken' AND COALESCE(odeme_gunu, 1) <= %s
    """, (tarih.day,))
    liste = []
    for g in (cur.fetchall() or []):
        cur.execute("""
            SELECT 1 FROM kasa_hareketleri
            WHERE kaynak_id = %s AND kaynak_tablo = 'sabit_giderler'
              AND islem_turu = 'FATURA_ODEMESI' AND kasa_etkisi = TRUE AND durum = 'aktif'
              AND EXTRACT(YEAR FROM tarih) = %s AND EXTRACT(MONTH FROM tarih) = %s
        """, (str(g['id']), tarih.year, tarih.month))
        if cur.fetchone():
            continue  # bu ay nakit ödendi
        cur.execute("""
            SELECT 1 FROM kart_hareketleri
            WHERE kaynak_id = %s AND kaynak_tablo = 'fatura_giderleri'
              AND islem_turu = 'HARCAMA' AND durum = 'aktif'
              AND EXTRACT(YEAR FROM tarih) = %s AND EXTRACT(MONTH FROM tarih) = %s
        """, (str(g['id']), tarih.year, tarih.month))
        if cur.fetchone():
            continue  # bu ay kartla ödendi
        cur.execute("""
            SELECT 1 FROM odeme_plani
            WHERE kaynak_tablo='sabit_giderler' AND kaynak_id=%s
              AND durum != 'iptal'
              AND referans_ay = DATE_TRUNC('month', %s::date)
        """, (str(g['id']), str(tarih)))
        if cur.fetchone():
            continue  # tutar girilmiş, vade takibinde
        gecikme = tarih.day - int(g['odeme_gunu'] or 1)
        liste.append({'ad': g['gider_adi'], 'gecikme': gecikme,
                      'tahmini': float(g['tutar'] or 0)})
    return sorted(liste, key=lambda x: -x['gecikme'])


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


def _tedarik_zinciri_ozet(cur, tarih: date) -> dict:
    """Tedarik zinciri denetim sinyalleri (gece özetinin '🔗 TEDARİK ZİNCİRİ' bölümü):
    zam alarmları + tedarikçi güvenilirlik (N kabul farkı) + şube paterni + bekleyen
    teslimler. KÜÇÜK-N DİSİPLİNİ: tedarikçi/şube ancak >=2 olayda 'riskli' işaretlenir
    (tek olaydan suçlama yok). Tüm sorgular korumalı — tablo yoksa boş döner."""
    out = {"zam": [], "tedarikci_riski": [], "sube_paterni": [], "bekleyen": []}
    # 1) Zam alarmları (son 7 gün, görülmemiş)
    try:
        cur.execute("SELECT to_regclass('public.fiyat_zam_alarmi') AS t")
        if (cur.fetchone() or {}).get("t"):
            cur.execute("""
                SELECT kalem_adi, tedarikci, artis_yuzde
                FROM fiyat_zam_alarmi
                WHERE olusturma >= NOW() - INTERVAL '7 days' AND goruldu = FALSE
                ORDER BY artis_yuzde DESC LIMIT 6
            """)
            for r in cur.fetchall() or []:
                d = dict(r)
                out["zam"].append({
                    "kalem": d.get("kalem_adi") or "—",
                    "tedarikci": d.get("tedarikci") or "—",
                    "yuzde": float(d.get("artis_yuzde") or 0),
                })
    except Exception:
        pass
    # 2+3) Kabul farkı (son 30 gün) → tedarikçi güvenilirlik + şube paterni
    try:
        cur.execute("""
            SELECT sb.ad AS sube_adi,
                   COALESCE(u.detay_json->>'tedarikci_ad','—') AS tedarikci
            FROM sube_operasyon_uyari u
            LEFT JOIN subeler sb ON sb.id = u.sube_id
            WHERE u.tip = 'TOPTANCI_KABUL_FARKI'
              AND u.tarih >= CURRENT_DATE - INTERVAL '30 days'
        """)
        ted_say: dict = {}
        ted_sube: dict = {}  # tedarikçi -> farklı şube kümesi (çok-şube paterni)
        sub_say: dict = {}
        for r in cur.fetchall() or []:
            d = dict(r)
            ted = str(d.get("tedarikci") or "—").strip() or "—"
            sub = str(d.get("sube_adi") or "—").strip() or "—"
            ted_say[ted] = ted_say.get(ted, 0) + 1
            ted_sube.setdefault(ted, set()).add(sub)
            sub_say[sub] = sub_say.get(sub, 0) + 1
        out["tedarikci_riski"] = [
            {"ad": k, "sayi": v, "sube_sayisi": len(ted_sube.get(k, set())),
             "cok_sube": len(ted_sube.get(k, set())) >= 2}
            for k, v in sorted(ted_say.items(), key=lambda x: -x[1])
            if v >= 2 and k != "—"
        ][:5]
        out["sube_paterni"] = [
            {"sube": k, "sayi": v} for k, v in sorted(sub_say.items(), key=lambda x: -x[1])
            if v >= 2 and k != "—"
        ][:5]
    except Exception:
        pass
    # 4) Bekleyen teslimler (gönderildi ama 3+ gündür teslim alınmadı)
    try:
        cur.execute("""
            SELECT COALESCE(ts.tedarikci_ad,'—') AS tedarikci, sb.ad AS sube_adi,
                   EXTRACT(DAY FROM (NOW() - ts.olusturma))::int AS gun
            FROM toptanci_siparis ts LEFT JOIN subeler sb ON sb.id = ts.sube_id
            WHERE ts.durum = 'gonderildi' AND ts.olusturma < NOW() - INTERVAL '3 days'
            ORDER BY ts.olusturma LIMIT 6
        """)
        for r in cur.fetchall() or []:
            d = dict(r)
            out["bekleyen"].append({
                "tedarikci": d.get("tedarikci") or "—",
                "sube": d.get("sube_adi") or "—",
                "gun": int(d.get("gun") or 0),
            })
    except Exception:
        pass
    return out


# ── Akıllı Denetim — AI yorumu (Claude) ─────────────────────────────────────

def _akilli_denetim_ozetleri(cur, tarih: date) -> list:
    """Tüm şubeler için Akıllı Denetim zekâ özetini toplar (sadece anomali olanlar)."""
    cur.execute("SELECT id::text, ad FROM subeler WHERE aktif=TRUE ORDER BY ad")
    subeler = cur.fetchall() or []

    cur.execute("""
        SELECT sube_id::text, boyut, tani, fark_n1_n2, guven_skoru, detay_json
        FROM truth_motor_kararlar
        WHERE tarih=%s::date
        ORDER BY olusturma DESC
    """, (tarih,))
    kararlar = cur.fetchall() or []

    sube_kararlari: dict = {}
    seen = set()
    for k in kararlar:
        anahtar = (k["sube_id"], k["boyut"])
        if anahtar in seen:
            continue
        seen.add(anahtar)
        sube_kararlari.setdefault(k["sube_id"], []).append(dict(k))

    try:
        import truth_motor as _tm
    except Exception:
        return []

    ozetler = []
    for s in subeler:
        sid = s["id"]
        kayitlar = sube_kararlari.get(sid, [])
        if not kayitlar:
            continue
        try:
            zeka = _tm.zeka_ozet_from_rows(kayitlar)
        except Exception:
            continue
        if zeka.get("alarm") == "normal" and not zeka.get("evo_eksik_boyutlar"):
            continue
        ozetler.append({
            "sube":  s["ad"],
            "alarm": zeka.get("alarm"),
            "ozet":  zeka.get("ozet", ""),
            "yorum": zeka.get("yorum_metni", ""),
        })
    return ozetler


def _ai_denetim_yorumu(ozetler: list) -> tuple[str, str]:
    """Akıllı Denetim anomali özetlerini Claude ile kısa, insan dilinde yoruma çevirir.

    Önce ANTHROPIC_API_KEY (Claude) denenir, tanımlı değilse OPENAI_API_KEY
    (gpt-4o-mini) ile denenir. İkisi de yoksa veya anomali yoksa boş string
    döner — motor sonucunu/finansal kararı etkilemez, sadece okunabilirlik katar.

    Returns: (yorum_metni, kaynak) — kaynak "claude" | "openai" | ""
    """
    if not ozetler:
        return "", ""

    detay = "\n\n".join(
        f"Şube: {o['sube']}\nAlarm seviyesi: {o['alarm']}\nÖzet: {o['ozet']}\nDetay:\n{o['yorum']}"
        for o in ozetler
    )
    prompt = (
        "Sen bir kahve zinciri için günlük denetim asistanısın. Aşağıda şubelerin "
        "otomatik denetim motorundan çıkan anomali özetleri var. Bunları CFO'nun "
        "WhatsApp'tan okuyacağı, en fazla 4-5 satır, önceliğe göre sıralanmış, "
        "günlük konuşma dilinde Türkçe bir uyarı metnine çevir. Teknik terim/kısaltma "
        "kullanma, rakamları olduğu gibi koru, motor kararını değiştirme/yorumlama "
        "yapma — sadece daha okunaklı anlat. SADECE metni yaz, başlık/giriş ekleme.\n\n"
        + detay
    )

    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    if anthropic_key:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=anthropic_key)
            resp = client.messages.create(
                model=os.getenv("ANTHROPIC_AKILLI_DENETIM_MODEL", "claude-3-5-haiku-20241022"),
                max_tokens=500,
                messages=[{"role": "user", "content": prompt}],
            )
            metin = "".join(
                b.text for b in resp.content if getattr(b, "type", None) == "text"
            ).strip()
            if metin:
                return metin, "claude"
        except Exception as e:
            logger.warning(f"Akıllı Denetim AI yorum hatası (Claude): {e}")

    openai_key = os.getenv("OPENAI_API_KEY")
    if openai_key:
        try:
            from openai import OpenAI
            client = OpenAI(api_key=openai_key)
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_AKILLI_DENETIM_MODEL", "gpt-4o-mini"),
                messages=[{"role": "user", "content": prompt}],
                max_tokens=500,
            )
            metin = (resp.choices[0].message.content or "").strip()
            if metin:
                return metin, "openai"
        except Exception as e:
            logger.warning(f"Akıllı Denetim AI yorum hatası (OpenAI): {e}")

    return "", ""


def _akilli_denetim_kaydet(tarih: date, ozetler: list, yorum: str, kaynak: str) -> None:
    """Günlük Akıllı Denetim AI yorumunu (veya ham özetini) arşiv tablosuna kaydeder.

    Aynı tarih için tekrar çalıştırılırsa (manuel tetikleme), üzerine yazar (upsert).
    Hata olursa sessizce loglar — WhatsApp mesajını bloklamaz.
    """
    if not ozetler:
        return
    try:
        with db() as (conn, cur):
            cur.execute("""
                INSERT INTO akilli_denetim_ai_yorum (tarih, ozetler, yorum, kaynak)
                VALUES (%s, %s::jsonb, %s, %s)
                ON CONFLICT (tarih) DO UPDATE SET
                    ozetler = EXCLUDED.ozetler,
                    yorum = EXCLUDED.yorum,
                    kaynak = EXCLUDED.kaynak,
                    olusturma = NOW()
            """, (tarih, json.dumps(ozetler, ensure_ascii=False, default=str), yorum, kaynak))
    except Exception as e:
        logger.warning(f"Akıllı Denetim yorum kaydı hatası: {e}")


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
    "acilis": "Açılış", "gun_sonu": "Gün Sonu",
    "diger": "Diğer",
}

def _eksik_ciro_oneri_ozet(cur) -> list:
    """Onay bekleyen Evo oto-denetim ciro önerileri — şube bazlı (gün + toplam)."""
    try:
        cur.execute("""
            SELECT s.ad AS sube, COUNT(*) AS gun,
                   COALESCE(SUM(t.nakit + t.pos + t.online), 0)::float AS toplam
            FROM ciro_taslak t JOIN subeler s ON s.id = t.sube_id
            WHERE t.durum='bekliyor' AND t.gonderen_ad='Evo Oto-Denetim'
            GROUP BY s.ad ORDER BY gun DESC, toplam DESC
        """)
        return [dict(r) for r in cur.fetchall()]
    except Exception:
        return []


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
        dis_kaynak  = _dis_kaynak_verileri(cur, tarih)
        kt_liste    = _kasa_teslimler(cur, tarih)
        toptanci    = _toptanci_teslimler(cur, tarih)
        vardiya     = _vardiya_personel(cur, tarih)
        tedarik_zinciri = _tedarik_zinciri_ozet(cur, tarih)
        denetim_ozetleri = _akilli_denetim_ozetleri(cur, tarih)
        eksik_ciro_oneri = _eksik_ciro_oneri_ozet(cur)
        girilmemis  = _girilmemis_faturalar(cur, tarih)

    tarih_str = f"{tarih.day} {_AY[tarih.month - 1]}"
    s = [f"🌙 *Evvel — {tarih_str} Günlük Özet*", ""]

    # Cirolar
    s.append("*CİROLAR*")
    for sub in ciro["subeler"]:
        sid = sub.get("sid", "")
        vd  = vardiya.get(sid, {})
        kapanis_p = vd.get("kapanis", "")
        kapanis_s = vd.get("kapanis_saat", "")

        if not sub["girilmis"]:
            s.append(f"⚠️ {sub['ad']} — kapanış girilmedi")
        else:
            trend = f"  {sub['trend']}" if sub["trend"] else ""
            s.append(f"  {sub['ad']:<14} *{_fmt(sub['ciro'])}*{trend}")
            # Kapanış personeli + saat
            if kapanis_p:
                saat_ek = f" · {kapanis_s}" if kapanis_s else ""
                s.append(f"    └ Kapanış: {kapanis_p}{saat_ek}")
    trend_t = f"  {ciro['toplam_trend']}" if ciro["toplam_trend"] else ""
    s.append(f"  {'Toplam':<14} *{_fmt(ciro['toplam'])}*{trend_t}")
    s.append("")

    # Kasa
    ciro_trend_str = f"  {kasa['ciro_trend']}" if kasa.get("ciro_trend") else ""
    s.append(f"*KASA: {_fmt(kasa['kasa'])}*")
    s.append(f"  Bugün nakit:  +{_fmt(kasa['bugun_ciro'])}{ciro_trend_str}")
    s.append(f"  Bugün çıkan:  -{_fmt(kasa['cikan'])}")
    s.append("")

    # Eksik ciro — Evo oto-denetim önerileri (kapanış/açılış girilmemiş günler)
    if eksik_ciro_oneri:
        top_gun = sum(int(e["gun"]) for e in eksik_ciro_oneri)
        s.append(f"*⚠️ EKSİK CİRO — {top_gun} gün onay bekliyor*")
        for e in eksik_ciro_oneri:
            s.append(f"  {e['sube']:<14} {int(e['gun'])} gün · {_fmt(e['toplam'])}")
        s.append("  → Evo'dan önerildi; merkez ciro onay kuyruğundan onaylayın")
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

    # Yarın ödemeler — her zaman göster
    yarin_tarih_str = f"{(tarih + timedelta(days=1)).day} {_AY[(tarih + timedelta(days=1)).month - 1]}"
    s.append(f"*{yarin_tarih_str} ÖDEMELERİ*")
    if yarin:
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
    else:
        s.append("  Ödeme yok ✓")

    # 🧾 Tutarı girilmemiş faturalar — unutma yakalayıcısı (kullanıcı 2026-07-04)
    if girilmemis:
        s.append("")
        s.append(f"*🧾 TUTARI GİRİLMEMİŞ FATURALAR ({len(girilmemis)})*")
        for f in girilmemis[:10]:
            gec = f" · {f['gecikme']}g gecikti" if f['gecikme'] > 0 else ""
            tah = f" (≈{_fmt(f['tahmini'])})" if f['tahmini'] else ""
            s.append(f"  • {str(f['ad'])[:28]}{tah}{gec}")
        s.append("  → CFO panelde '🧾 Tutarı Gir' ile işleyin")

    # Yarın açılışçılar — ayrı bölüm
    yarin_satirlar = []
    for sub in ciro["subeler"]:
        sid = sub.get("sid", "")
        vd  = vardiya.get(sid, {})
        yarin_ac = vd.get("yarin_acilis", [])
        if yarin_ac:
            yarin_satirlar.append(f"  {sub['ad']}: {', '.join(yarin_ac)}")
    yarin_tarih_bas = f"{(tarih + timedelta(days=1)).day} {_AY[(tarih + timedelta(days=1)).month - 1]}"
    s.append("")
    s.append(f"*{yarin_tarih_bas} AÇILIŞLARI*")
    if yarin_satirlar:
        s.extend(yarin_satirlar)
    else:
        s.append("  Açılış bilgisi henüz girilmedi")

    # Bu ay ciro
    ay_adi = _AY[tarih.month - 1]
    s.append("")
    s.append(f"{ay_adi} ayı cirosu: *{_fmt(ay_ciro)}*")

    # Dış kaynak (kira gelirleri)
    if dis_kaynak["ay_toplam"] > 0 or dis_kaynak["bugun"] > 0:
        s.append("")
        s.append("*KİRA GELİRLERİ*")
        s.append(f"  Bu ay toplam:  {_fmt(dis_kaynak['ay_toplam'])}")
        if dis_kaynak["bugun"] > 0:
            s.append(f"  Bugün gelen:   {_fmt(dis_kaynak['bugun'])}")

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

    # 🔗 Tedarik zinciri denetim sinyalleri (zam + tedarikçi riski + şube paterni + bekleyen)
    if tedarik_zinciri and any(tedarik_zinciri.get(k) for k in ("zam", "tedarikci_riski", "sube_paterni", "bekleyen")):
        s.append("")
        s.append("*🔗 TEDARİK ZİNCİRİ*")
        for z in tedarik_zinciri.get("zam", []):
            s.append(f"  🔺 {z['kalem']} ({z['tedarikci']}) %{z['yuzde']:.0f} zam")
        for t in tedarik_zinciri.get("tedarikci_riski", []):
            if t.get("cok_sube"):
                s.append(f"  🚚 {t['ad']}: {t['sube_sayisi']} şubede {t['sayi']} fark → tedarikçi paterni (şube masum)")
            else:
                s.append(f"  ⚠ {t['ad']}: 30 günde {t['sayi']} kabul farkı (tek şube — belirsiz)")
        for sp in tedarik_zinciri.get("sube_paterni", []):
            s.append(f"  🏪 {sp['sube']}: 30 günde {sp['sayi']} teslim farkı")
        for b in tedarik_zinciri.get("bekleyen", []):
            s.append(f"  ⏳ {b['tedarikci']} → {b['sube']}: {b['gun']} gündür bekliyor")

    # Akıllı Denetim — AI yorumu (varsa)
    ai_yorum, ai_kaynak = _ai_denetim_yorumu(denetim_ozetleri)
    if ai_yorum:
        s.append("")
        s.append("*🔍 AKILLI DENETİM*")
        s.append(ai_yorum)
        _akilli_denetim_kaydet(tarih, denetim_ozetleri, ai_yorum, ai_kaynak)
    elif denetim_ozetleri:
        # AI yorum yoksa (key tanımsız vb.) ham özetleri göster
        s.append("")
        s.append("*🔍 AKILLI DENETİM*")
        ham_satirlar = []
        for o in denetim_ozetleri:
            emoji = {"kritik": "🔴", "yuksek": "🟠", "orta": "🟡"}.get(o["alarm"], "⚪")
            satir = f"  {emoji} {o['sube']}: {o['ozet']}"
            s.append(satir)
            ham_satirlar.append(satir)
        _akilli_denetim_kaydet(tarih, denetim_ozetleri, "\n".join(ham_satirlar), "")

    return "\n".join(s)


# ── Green API Gönderim ────────────────────────────────────────────────────────

def wa_chatid_normalize(telefon: str) -> str:
    """
    TR telefon numarasını Green API bireysel chatId formatına çevirir:
    '<ülke kodu><numara>@c.us'. Boş/geçersiz ise '' döner.
      0532 123 45 67  -> 905321234567@c.us
      532 123 45 67   -> 905321234567@c.us
      90 532 ...      -> 905321234567@c.us
      +90 532 ...     -> 905321234567@c.us
    """
    digits = re.sub(r"\D", "", str(telefon or ""))
    if not digits:
        return ""
    # Türkiye varsayılanı: başta 0 varsa at, 10 haneli (5XXXXXXXXX) ise 90 ekle.
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = "90" + digits[1:]
    elif len(digits) == 10 and digits.startswith("5"):
        digits = "90" + digits
    if len(digits) < 11:
        return ""
    return digits + "@c.us"


def _wa_send(chat_id: str, mesaj: str) -> dict:
    """
    Green API'ye tek bir mesaj gönderir. Düşük seviye çekirdek.
    Dönüş: {"basarili": bool, "mesaj_id": str|None, "hata": str|None}
    """
    instance_id = os.getenv("WA_INSTANCE_ID", "").strip()
    token       = os.getenv("WA_TOKEN", "").strip()
    chat_id     = (chat_id or "").strip()

    if not all([instance_id, token, chat_id]):
        logger.warning("WhatsApp: ortam değişkenleri veya chatId eksik — atlanıyor")
        return {"basarili": False, "mesaj_id": None, "hata": "config_eksik"}

    url     = f"https://api.green-api.com/waInstance{instance_id}/sendMessage/{token}"
    payload = json.dumps({"chatId": chat_id, "message": mesaj}).encode("utf-8")
    req     = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            mid = data.get("idMessage")
            if mid:
                logger.info(f"WhatsApp: gönderildi — {mid}")
                return {"basarili": True, "mesaj_id": str(mid), "hata": None}
            logger.warning(f"WhatsApp: beklenmedik yanıt — {str(data)[:200]}")
            return {"basarili": False, "mesaj_id": None, "hata": "beklenmedik_yanit"}
    except urllib.error.HTTPError as e:
        logger.error(f"WhatsApp HTTP hatası: {e.code}")
        return {"basarili": False, "mesaj_id": None, "hata": f"http_{e.code}"}
    except Exception as e:
        logger.error(f"WhatsApp hatası: {e}")
        return {"basarili": False, "mesaj_id": None, "hata": str(e)[:120]}


def wa_instance_durum() -> dict:
    """Green API instance'ının yetki/bağlantı durumunu SALT-OKUR (mesaj göndermez).
    'authorized' = WhatsApp bağlı; 'notAuthorized'/'starting'/'yetkisiz' = telefon
    bağlantısı kopmuş → gönderimler sessizce başarısız olur. Tanı amaçlı.
    Dönüş: {config_var, state, hata}.
    """
    instance_id = os.getenv("WA_INSTANCE_ID", "").strip()
    token       = os.getenv("WA_TOKEN", "").strip()
    if not instance_id or not token:
        return {"config_var": False, "state": None, "hata": "config_eksik"}
    url = f"https://api.green-api.com/waInstance{instance_id}/getStateInstance/{token}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return {"config_var": True, "state": data.get("stateInstance"), "hata": None}
    except urllib.error.HTTPError as e:
        return {"config_var": True, "state": None, "hata": f"http_{e.code}"}
    except Exception as e:
        return {"config_var": True, "state": None, "hata": str(e)[:120]}


def whatsapp_gonder(mesaj: str) -> bool:
    """Sabit ortaklar grubuna mesaj gönderir (gece özeti vb.)."""
    group_id = os.getenv("WA_GROUP_ID", "").strip()
    if not group_id:
        logger.warning("WhatsApp: WA_GROUP_ID eksik — atlanıyor")
        return False
    return _wa_send(group_id, mesaj).get("basarili", False)


def whatsapp_gonder_numara(telefon: str, mesaj: str) -> dict:
    """
    Belirli bir telefon numarasına (tedarikçi vb.) mesaj gönderir.
    Dönüş: {"basarili": bool, "mesaj_id": str|None, "chat_id": str, "hata": str|None}
    """
    chat_id = wa_chatid_normalize(telefon)
    if not chat_id:
        return {"basarili": False, "mesaj_id": None, "chat_id": "", "hata": "gecersiz_numara"}
    sonuc = _wa_send(chat_id, mesaj)
    sonuc["chat_id"] = chat_id
    return sonuc


def gunluk_ozet_gonder(tarih: date | None = None) -> dict:
    try:
        mesaj    = gunluk_ozet_mesaj_olustur(tarih)
        basarili = whatsapp_gonder(mesaj)
        return {"basarili": basarili, "mesaj_onizleme": mesaj[:400] + "..."}
    except Exception as e:
        logger.error(f"WhatsApp günlük özet hatası: {e}")
        return {"basarili": False, "hata": str(e)}
