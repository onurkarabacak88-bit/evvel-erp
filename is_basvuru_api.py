"""İş Başvurusu API — CV toplama, listeleme, durum güncelleme, IK skor motoru."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
import uuid, io
from datetime import datetime
from database import db
from tr_saat import dt_now_tr

router = APIRouter(prefix="/api/is-basvurusu", tags=["is-basvurusu"])


# ── Modeller ─────────────────────────────────────────────────────────────────

class BasvuruGonder(BaseModel):
    ad_soyad: str
    telefon: str
    dogum_yili: Optional[int] = None
    ilce: Optional[str] = None
    # Adım 1
    yasam_durumu: Optional[str] = None      # aile | yurt | arkadas | tek
    egitim_durumu: Optional[str] = None     # lise | universite | mezun | calisiyor | diger
    universite_bol: Optional[str] = None
    en_erken_saat: Optional[str] = None     # 07:00 | 08:00 | 09:00 | 10:00 | ogle
    ulasim: Optional[str] = None            # yurume | toplu | arac | bisiklet
    # Adım 2
    pozisyon: Optional[str] = None
    calisma_tercihi: Optional[str] = None   # tam | yari | esnek
    musait_gunler: Optional[List[str]] = None
    baslangic: Optional[str] = None         # hemen | 2hafta | 1ay
    ek_not: Optional[str] = None
    # Adım 3
    kahve_deneyim: Optional[str] = None
    nerede_calistim: Optional[str] = None    # kurumsal | yerel_bagimsiz | sektor_disi | hic_calismadim
    is_ogrenilen: Optional[str] = None       # musteri_iletisim | hiz_tempo | duzen_temizlik | takim | tek_sorumluluk | cok_ogrenmedim
    isten_en_iyi: Optional[str] = None       # musteri_insan | tempolu_ortam | ogrenme | ekip | para_bagimsizlik
    isten_en_zor: Optional[str] = None       # uzun_saatler | zor_musteriler | dusuk_ucret | yonetim_sorun | monoton
    # Eski serbest metin alanları — geriye dönük uyumluluk için tutuldu
    onceki_is: Optional[str] = None
    onceki_is_ogrenilen: Optional[str] = None
    onceki_is_iyi_zor: Optional[str] = None
    # Adım 4 — behavioral (temizlik + esneklik)
    makine_sonrasi: Optional[str] = None    # hemen_siler | vardiya_sonu | kime_duserse | pek_dusunmem
    yogun_duzen: Optional[str] = None       # araliklarda | rush_bitti | oldugu_gibi | fark_etmez
    gun_planlama: Optional[str] = None      # esnek_akis | plan_degisir | saatler_belli | onceden_netlesin
    arkadaslar_tanim: Optional[str] = None  # her_an_hazir | sakin_olculu | kendi_isine | haklarini_bilen
    # Adım 5 — behavioral (iletişim + mesai)
    sosyal_yaklasim: Optional[str] = None   # dogal_isinirim | zaman_lazim | karsi_baslasın | pek_rahat_degil
    musteri_bagli: Optional[str] = None     # adini_ogrenip | selam_sorar | hizlica_hazirlar | hepsi_ayni
    sabah_hazirlik: Optional[str] = None    # kahve_icer | zor_gelir | izin_dusunur | duruma_gore
    yorucu_an: Optional[str] = None         # beklenmedik | isler_uzayinca | plan_disi | gunun_sonu
    # Adım 6
    neden_bu_is: Optional[str] = None
    tempo_tercihi: Optional[str] = None     # hizli | sakin | ikisi
    # Adım 7
    tanitim: Optional[str] = None
    referans_ad: Optional[str] = None
    referans_tel: Optional[str] = None
    kaynak_sube: Optional[str] = None

class DurumGuncelle(BaseModel):
    durum: str  # bekliyor | gorusme | olumlu | olumsuz | arsiv


# ── IK Değerlendirme Motoru ──────────────────────────────────────────────────

def _hesapla_skor(row: dict) -> dict:
    """
    5 boyut × 20 puan = 100 puan toplam.
    Her boyut 10'dan başlar, cevaplara göre artar/azalır, 0-20 arasında kalır.

    Boyutlar:
      sabah    — Sabah uyumu & devam güvenilirliği
      duzen    — Temizlik & standart farkındalığı
      enerji   — Müşteri iletişimi & pozitif enerji
      esneklik — Vardiya esnekliği & mesai toleransı
      gecmis   — Deneyim & motivasyon
    """
    s = {'sabah': 10, 'duzen': 10, 'enerji': 10, 'esneklik': 10, 'gecmis': 10}
    sinyaller = []

    # ── 1. Sabah Uyumu ──────────────────────────────────────────────────────
    en_erken = row.get('en_erken_saat')
    if   en_erken == '07:00': s['sabah'] += 6; sinyaller.append({'tip':'olumlu','mesaj':'🌅 07:00\'de işe gelebiliyor'})
    elif en_erken == '08:00': s['sabah'] += 4
    elif en_erken == '09:00': s['sabah'] += 2
    elif en_erken == '10:00': s['sabah'] -= 2
    elif en_erken == 'ogle':  s['sabah'] -= 6; sinyaller.append({'tip':'dikkat','mesaj':'⚠️ Sabah vardiyasına uygun değil'})

    yasam = row.get('yasam_durumu')
    if   yasam == 'aile':    s['sabah'] += 3
    elif yasam == 'yurt':    s['sabah'] += 2
    elif yasam == 'tek':     s['sabah'] -= 2; sinyaller.append({'tip':'dikkat','mesaj':'Tek yaşıyor — sabah güvenilirliği düşük olabilir'})

    sabah_h = row.get('sabah_hazirlik')
    if   sabah_h == 'kahve_icer':    s['sabah'] += 5; sinyaller.append({'tip':'olumlu','mesaj':'💪 Sabah direnci güçlü'})
    elif sabah_h == 'zor_gelir':     s['sabah'] += 1
    elif sabah_h == 'izin_dusunur':  s['sabah'] -= 6; sinyaller.append({'tip':'dikkat','mesaj':'🚩 Devamsızlık riski yüksek'})
    elif sabah_h == 'duruma_gore':   s['sabah'] -= 3

    egitim = row.get('egitim_durumu')
    if   egitim == 'lise':       s['sabah'] += 2  # okul saatleri var, erken kalkmaya alışık
    elif egitim == 'universite': s['sabah'] += 1
    elif egitim == 'tek':        s['sabah'] -= 1

    # ── 2. Düzen & Standart ─────────────────────────────────────────────────
    makine = row.get('makine_sonrasi')
    if   makine == 'hemen_siler':   s['duzen'] += 8; sinyaller.append({'tip':'olumlu','mesaj':'🧹 Temizlik refleksi mükemmel'})
    elif makine == 'vardiya_sonu':  s['duzen'] += 2
    elif makine == 'kime_duserse':  s['duzen'] -= 3
    elif makine == 'pek_dusunmem':  s['duzen'] -= 7; sinyaller.append({'tip':'dikkat','mesaj':'⚠️ Temizlik farkındalığı düşük'})

    yogun = row.get('yogun_duzen')
    if   yogun == 'araliklarda':  s['duzen'] += 6; sinyaller.append({'tip':'olumlu','mesaj':'✨ Yoğunlukta bile düzenini koruyor'})
    elif yogun == 'rush_bitti':   s['duzen'] += 2
    elif yogun == 'oldugu_gibi':  s['duzen'] -= 2
    elif yogun == 'fark_etmez':   s['duzen'] -= 5; sinyaller.append({'tip':'dikkat','mesaj':'Yoğunlukta düzen tamamen bozuluyor'})

    # ── 3. Enerji & İletişim ────────────────────────────────────────────────
    sosyal = row.get('sosyal_yaklasim')
    if   sosyal == 'dogal_isinirim':   s['enerji'] += 8; sinyaller.append({'tip':'olumlu','mesaj':'⚡ Doğal sosyal enerji güçlü'})
    elif sosyal == 'zaman_lazim':      s['enerji'] += 2
    elif sosyal == 'karsi_baslasın':   s['enerji'] -= 3
    elif sosyal == 'pek_rahat_degil':  s['enerji'] -= 7; sinyaller.append({'tip':'dikkat','mesaj':'⚠️ Müşteri iletişimi zayıf olabilir'})

    musteri = row.get('musteri_bagli')
    if   musteri == 'adini_ogrenip':     s['enerji'] += 7; sinyaller.append({'tip':'olumlu','mesaj':'🌟 Müşteri bağı kuruyor — satış yeteneği var'})
    elif musteri == 'selam_sorar':       s['enerji'] += 3
    elif musteri == 'hizlica_hazirlar':  s['enerji'] -= 1
    elif musteri == 'hepsi_ayni':        s['enerji'] -= 5; sinyaller.append({'tip':'dikkat','mesaj':'Müşteri deneyimine ilgisiz'})

    tempo = row.get('tempo_tercihi')
    if   tempo == 'hizli':  s['enerji'] += 3
    elif tempo == 'ikisi':  s['enerji'] += 2
    elif tempo == 'sakin':  s['enerji'] -= 1

    # ── 4. Vardiya Esnekliği ────────────────────────────────────────────────
    gun_plan = row.get('gun_planlama')
    if   gun_plan == 'esnek_akis':        s['esneklik'] += 7; sinyaller.append({'tip':'olumlu','mesaj':'🔄 Vardiya esnekliği yüksek'})
    elif gun_plan == 'plan_degisir':      s['esneklik'] += 4
    elif gun_plan == 'saatler_belli':     s['esneklik'] -= 3
    elif gun_plan == 'onceden_netlesin':  s['esneklik'] -= 7; sinyaller.append({'tip':'dikkat','mesaj':'🚩 Katı saat beklentisi — gece kapanışa uygun değil'})

    arkadaslar = row.get('arkadaslar_tanim')
    if   arkadaslar == 'her_an_hazir':     s['esneklik'] += 7; sinyaller.append({'tip':'olumlu','mesaj':'💫 Güvenilir, her an hazır profili'})
    elif arkadaslar == 'sakin_olculu':     s['esneklik'] += 2
    elif arkadaslar == 'kendi_isine':      s['esneklik'] -= 2
    elif arkadaslar == 'haklarini_bilen':  s['esneklik'] -= 8; sinyaller.append({'tip':'dikkat','mesaj':'🚩 Mesai hassasiyeti yüksek — gece kapanış riski'})

    yorucu = row.get('yorucu_an')
    if   yorucu == 'beklenmedik':     s['esneklik'] += 2
    elif yorucu == 'isler_uzayinca':  s['esneklik'] -= 4; sinyaller.append({'tip':'dikkat','mesaj':'Uzayan mesaiye direnç var'})
    elif yorucu == 'plan_disi':       s['esneklik'] -= 5; sinyaller.append({'tip':'dikkat','mesaj':'Ekstra yüke kapalı görünüyor'})
    elif yorucu == 'gunun_sonu':      s['esneklik'] += 1

    # ── 5. Deneyim & Motivasyon ─────────────────────────────────────────────
    kahve = row.get('kahve_deneyim')
    if   kahve == 'var_uzun':       s['gecmis'] += 8; sinyaller.append({'tip':'olumlu','mesaj':'☕ 3+ yıl kahve deneyimi'})
    elif kahve == 'var_2yil':       s['gecmis'] += 6
    elif kahve == 'var_1yil':       s['gecmis'] += 4
    elif kahve == 'kismi':          s['gecmis'] += 2
    elif kahve == 'yok_ogreneyim':  s['gecmis'] += 0  # nötr

    neden = row.get('neden_bu_is')
    if   neden == 'barista':      s['gecmis'] += 5; sinyaller.append({'tip':'olumlu','mesaj':'🎯 Barista olmak istiyor — motivasyon güçlü'})
    elif neden == 'insan':        s['gecmis'] += 4
    elif neden == 'deneyim':      s['gecmis'] += 3
    elif neden == 'tam_zamanli':  s['gecmis'] += 2
    elif neden == 'part_time':    s['gecmis'] += 1

    # ── 5b. Nerede Çalıştı → gecmis + çapraz ──────────────────────────────
    nerede = row.get('nerede_calistim')
    if nerede == 'kurumsal':
        s['gecmis'] += 4; s['duzen'] += 3
        sinyaller.append({'tip':'olumlu','mesaj':'🏢 Kurumsal deneyim — standartlara alışık'})
    elif nerede == 'yerel_bagimsiz':
        s['gecmis'] += 3; s['enerji'] += 2
        sinyaller.append({'tip':'olumlu','mesaj':'☕ Yerel işletme — bireysel müşteri ilişkisine alışık'})
    elif nerede == 'sektor_disi':
        s['gecmis'] += 1
        sinyaller.append({'tip':'dikkat','mesaj':'🔄 F&B dışı deneyim — sektör adaptasyonu gerekebilir'})
    # hic_calismadim → 0 bonus, sinyalsiz

    # ── 5c. O işte ne öğrendi → gecmis + çapraz ───────────────────────────
    ogrenilen = row.get('is_ogrenilen')
    if ogrenilen == 'musteri_iletisim':
        s['gecmis'] += 2; s['enerji'] += 3
        sinyaller.append({'tip':'olumlu','mesaj':'💬 Öğrendikleri müşteri iletişimini destekliyor'})
    elif ogrenilen == 'hiz_tempo':
        s['gecmis'] += 2; s['esneklik'] += 2
        sinyaller.append({'tip':'olumlu','mesaj':'⚡ Tempolu çalışma alışkanlığı kazanmış'})
    elif ogrenilen == 'duzen_temizlik':
        s['gecmis'] += 2; s['duzen'] += 4
        sinyaller.append({'tip':'olumlu','mesaj':'🧹 Düzen ve temizliği bilinçli öğrenmiş — güçlü sinyal'})
    elif ogrenilen == 'takim':
        s['gecmis'] += 2; s['enerji'] += 2
    elif ogrenilen == 'tek_sorumluluk':
        s['gecmis'] += 2; s['esneklik'] += 1
    elif ogrenilen == 'cok_ogrenmedim':
        s['gecmis'] -= 3
        sinyaller.append({'tip':'dikkat','mesaj':'⚠️ Önceki deneyimden verim alamamış'})

    # ── 5d. En iyi neydi → çapraz teyit ────────────────────────────────────
    en_iyi = row.get('isten_en_iyi')
    if en_iyi == 'musteri_insan':
        s['enerji'] += 3
        sinyaller.append({'tip':'olumlu','mesaj':'👥 Müşteri sevgisi iş deneyimiyle teyit edildi'})
    elif en_iyi == 'tempolu_ortam':
        s['esneklik'] += 3; s['sabah'] += 1
        sinyaller.append({'tip':'olumlu','mesaj':'🏃 Yoğun tempo seviyor — sabah/mesai uyumu yüksek'})
    elif en_iyi == 'ogrenme':
        s['gecmis'] += 2
    elif en_iyi == 'ekip':
        s['enerji'] += 1
    elif en_iyi == 'para_bagimsizlik':
        pass  # nötr, gerçekçi motivasyon

    # ── 5e. En zor neydi → risk sinyalleri ─────────────────────────────────
    en_zor = row.get('isten_en_zor')
    if en_zor == 'uzun_saatler':
        s['esneklik'] -= 5
        sinyaller.append({'tip':'dikkat','mesaj':'🚩 Uzun saatler zor gelmiş — gece kapanış/mesai riski'})
    elif en_zor == 'zor_musteriler':
        s['enerji'] -= 3
        sinyaller.append({'tip':'dikkat','mesaj':'😤 Zor müşterilerle başa çıkmakta zorlanmış'})
    elif en_zor == 'dusuk_ucret':
        pass  # yaygın, nötr
    elif en_zor == 'yonetim_sorun':
        s['esneklik'] -= 2
        sinyaller.append({'tip':'dikkat','mesaj':'🚧 Yönetimle geçinme geçmişi — takım uyumu izlenecek'})
    elif en_zor == 'monoton':
        s['esneklik'] += 1  # yoğun ortam arayışında → bizim için iyi

    # ── Clamp & Toplam ──────────────────────────────────────────────────────
    for k in s:
        s[k] = max(0, min(20, s[k]))

    toplam = sum(s.values())
    dikkat_sayisi = len([x for x in sinyaller if x['tip'] == 'dikkat'])
    olumlu_sayisi = len([x for x in sinyaller if x['tip'] == 'olumlu'])

    if   toplam >= 85: genel = 'guclu';  genel_label = '🌟 Güçlü Aday'
    elif toplam >= 68: genel = 'iyi';    genel_label = '👍 İyi Aday'
    elif toplam >= 50: genel = 'orta';   genel_label = '🤔 Orta Aday'
    else:              genel = 'zayif';  genel_label = '⚠️ Dikkatli Ol'

    return {
        'toplam': toplam,
        'boyutlar': {
            'sabah':    {'puan': s['sabah'],    'label': '🌅 Sabah Uyumu'},
            'duzen':    {'puan': s['duzen'],    'label': '🧹 Düzen & Standart'},
            'enerji':   {'puan': s['enerji'],   'label': '⚡ Enerji & İletişim'},
            'esneklik': {'puan': s['esneklik'], 'label': '🔄 Vardiya Esnekliği'},
            'gecmis':   {'puan': s['gecmis'],   'label': '📈 Deneyim & Motivasyon'},
        },
        'genel':         genel,
        'genel_label':   genel_label,
        'sinyaller':     sinyaller,
        'dikkat_sayisi': dikkat_sayisi,
        'olumlu_sayisi': olumlu_sayisi,
    }


# ── DB yardımcıları ──────────────────────────────────────────────────────────

def _ensure_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS is_basvuru (
            id TEXT PRIMARY KEY,
            ad_soyad TEXT NOT NULL,
            telefon TEXT NOT NULL,
            dogum_yili INTEGER,
            ilce TEXT,
            yasam_durumu TEXT,
            egitim_durumu TEXT,
            universite_bol TEXT,
            en_erken_saat TEXT,
            ulasim TEXT,
            pozisyon TEXT,
            tercih_subeler JSONB DEFAULT '[]',
            calisma_tercihi TEXT,
            musait_gunler JSONB DEFAULT '[]',
            baslangic TEXT,
            ek_not TEXT,
            kahve_deneyim TEXT,
            onceki_is TEXT,
            onceki_is_ogrenilen TEXT,
            onceki_is_iyi_zor TEXT,
            makine_sonrasi TEXT,
            yogun_duzen TEXT,
            gun_planlama TEXT,
            arkadaslar_tanim TEXT,
            sosyal_yaklasim TEXT,
            musteri_bagli TEXT,
            sabah_hazirlik TEXT,
            yorucu_an TEXT,
            neden_bu_is TEXT,
            tempo_tercihi TEXT,
            tanitim TEXT,
            referans_ad TEXT,
            referans_tel TEXT,
            kaynak_sube TEXT,
            durum TEXT NOT NULL DEFAULT 'bekliyor',
            olusturma_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            guncelleme_ts TIMESTAMPTZ
        )
    """)
    # Migration: eski tablolara eksik kolonları ekle
    for kolon, tip in [
        ("yasam_durumu","TEXT"), ("egitim_durumu","TEXT"), ("universite_bol","TEXT"),
        ("en_erken_saat","TEXT"), ("ulasim","TEXT"), ("ek_not","TEXT"),
        ("onceki_is_ogrenilen","TEXT"), ("onceki_is_iyi_zor","TEXT"),
        ("makine_sonrasi","TEXT"), ("yogun_duzen","TEXT"),
        ("gun_planlama","TEXT"), ("arkadaslar_tanim","TEXT"),
        ("sosyal_yaklasim","TEXT"), ("musteri_bagli","TEXT"),
        ("sabah_hazirlik","TEXT"), ("yorucu_an","TEXT"),
        ("neden_bu_is","TEXT"), ("tempo_tercihi","TEXT"),
        # Yeni yapısal adım 3 alanları
        ("nerede_calistim","TEXT"), ("is_ogrenilen","TEXT"),
        ("isten_en_iyi","TEXT"),    ("isten_en_zor","TEXT"),
    ]:
        try:
            cur.execute(f"ALTER TABLE is_basvuru ADD COLUMN IF NOT EXISTS {kolon} {tip}")
        except Exception:
            pass


def _row_to_dict(r):
    import json as _j
    d = dict(r)
    for k in ("tercih_subeler", "musait_gunler"):
        if isinstance(d.get(k), str):
            try:
                d[k] = _j.loads(d[k])
            except Exception:
                d[k] = []
    # IK değerlendirme skorunu ekle
    d['skor'] = _hesapla_skor(d)
    return d


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("")
def basvuru_gonder(body: BasvuruGonder):
    """Mobil formdan gelen başvuruyu kaydet."""
    if not body.ad_soyad.strip():
        raise HTTPException(400, "Ad soyad zorunlu.")
    if not body.telefon.strip():
        raise HTTPException(400, "Telefon zorunlu.")

    bid = str(uuid.uuid4())
    import json as _j
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("""
            INSERT INTO is_basvuru (
                id, ad_soyad, telefon, dogum_yili, ilce,
                yasam_durumu, egitim_durumu, universite_bol, en_erken_saat, ulasim,
                pozisyon, tercih_subeler, calisma_tercihi, musait_gunler, baslangic, ek_not,
                kahve_deneyim, onceki_is, onceki_is_ogrenilen, onceki_is_iyi_zor,
                nerede_calistim, is_ogrenilen, isten_en_iyi, isten_en_zor,
                makine_sonrasi, yogun_duzen, gun_planlama, arkadaslar_tanim,
                sosyal_yaklasim, musteri_bagli, sabah_hazirlik, yorucu_an,
                neden_bu_is, tempo_tercihi,
                tanitim, referans_ad, referans_tel, kaynak_sube,
                durum, olusturma_ts
            ) VALUES (
                %s,%s,%s,%s,%s,
                %s,%s,%s,%s,%s,
                %s,%s::jsonb,%s,%s::jsonb,%s,%s,
                %s,%s,%s,%s,
                %s,%s,%s,%s,
                %s,%s,%s,%s,
                %s,%s,%s,%s,
                %s,%s,
                %s,%s,%s,%s,
                'bekliyor',%s
            )
        """, (
            bid,
            body.ad_soyad.strip(), body.telefon.strip(), body.dogum_yili,
            (body.ilce or "").strip() or None,
            body.yasam_durumu, body.egitim_durumu,
            (body.universite_bol or "").strip() or None,
            body.en_erken_saat, body.ulasim,
            body.pozisyon or 'barista',
            _j.dumps(body.tercih_subeler or [], ensure_ascii=False),
            body.calisma_tercihi,
            _j.dumps(body.musait_gunler or [], ensure_ascii=False),
            body.baslangic,
            (body.ek_not or "").strip() or None,
            body.kahve_deneyim,
            (body.onceki_is or "").strip() or None,
            (body.onceki_is_ogrenilen or "").strip() or None,
            (body.onceki_is_iyi_zor or "").strip() or None,
            body.nerede_calistim, body.is_ogrenilen,
            body.isten_en_iyi, body.isten_en_zor,
            body.makine_sonrasi, body.yogun_duzen,
            body.gun_planlama, body.arkadaslar_tanim,
            body.sosyal_yaklasim, body.musteri_bagli,
            body.sabah_hazirlik, body.yorucu_an,
            body.neden_bu_is, body.tempo_tercihi,
            (body.tanitim or "").strip() or None,
            (body.referans_ad or "").strip() or None,
            (body.referans_tel or "").strip() or None,
            (body.kaynak_sube or "").strip() or None,
            dt_now_tr(),
        ))
        conn.commit()
    return {"success": True, "id": bid}


@router.get("")
def basvuru_listele(
    durum: Optional[str] = Query(None),
    limit: int = Query(200, le=500),
):
    with db() as (conn, cur):
        _ensure_table(cur)
        if durum:
            cur.execute("SELECT * FROM is_basvuru WHERE durum=%s ORDER BY olusturma_ts DESC LIMIT %s", (durum, limit))
        else:
            cur.execute("SELECT * FROM is_basvuru ORDER BY olusturma_ts DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
    return [_row_to_dict(r) for r in rows]


@router.get("/ozet")
def basvuru_ozet():
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("SELECT durum, COUNT(*) as adet FROM is_basvuru GROUP BY durum")
        rows = cur.fetchall()
    return {r["durum"]: r["adet"] for r in rows}


@router.get("/qr/indir")
def basvuru_qr():
    """İş başvurusu QR kodunu PNG olarak döndür."""
    try:
        import qrcode
        from fastapi.responses import StreamingResponse
        url = "https://evvel-erp-production.up.railway.app/is-basvurusu"
        qr = qrcode.QRCode(version=2, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return StreamingResponse(
            buf, media_type="image/png",
            headers={"Content-Disposition": 'attachment; filename="evvel_is_basvurusu_qr.png"'},
        )
    except ImportError:
        raise HTTPException(500, "qrcode kütüphanesi yüklü değil.")


@router.get("/{bid}")
def basvuru_detay(bid: str):
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("SELECT * FROM is_basvuru WHERE id=%s", (bid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Başvuru bulunamadı.")
    return _row_to_dict(row)


@router.patch("/{bid}/durum")
def basvuru_durum_guncelle(bid: str, body: DurumGuncelle):
    gecerli = {"bekliyor", "gorusme", "olumlu", "olumsuz", "arsiv"}
    if body.durum not in gecerli:
        raise HTTPException(400, f"Geçersiz durum: {gecerli}")
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute(
            "UPDATE is_basvuru SET durum=%s, guncelleme_ts=%s WHERE id=%s",
            (body.durum, dt_now_tr(), bid)
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Başvuru bulunamadı.")
        conn.commit()
    return {"success": True}


@router.delete("/{bid}")
def basvuru_sil(bid: str):
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("DELETE FROM is_basvuru WHERE id=%s", (bid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Başvuru bulunamadı.")
        conn.commit()
    return {"success": True}
