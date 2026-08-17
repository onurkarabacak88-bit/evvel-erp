import json
import logging
import os
import psycopg2
import psycopg2.extras
import psycopg2.pool
from contextlib import contextmanager
from typing import Optional
import threading

# Yerel geliştirme: kökte .env → Railway'deki DATABASE_URL (production'da Railway zaten env verir)
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


def _normalize_postgres_dsn(url: str) -> str:
    """Railway / bazı paneller postgres:// verir; libpq/psycopg2 için postgresql:// tercih edilir."""
    u = (url or "").strip()
    if u.startswith("postgres://"):
        return "postgresql://" + u[len("postgres://") :]
    return u


def _resolve_database_url() -> str:
    raw = (os.environ.get("DATABASE_URL") or "").strip()
    if not raw:
        raise RuntimeError(
            "DATABASE_URL tanımlı değil. Railway: Postgres veya uygulama servisinizde "
            '"Variables" → DATABASE_URL değerini kopyalayın.\n'
            "  • Yerel: proje köküne .env dosyası oluşturup DATABASE_URL=... satırı ekleyin "
            "(python-dotenv ile okunur).\n"
            "  • PowerShell: $env:DATABASE_URL='postgresql://...'\n"
            "Yerel PostgreSQL kurmanız gerekmez; bağlantı doğrudan Railway veritabanına gider."
        )
    return _normalize_postgres_dsn(raw)


# ── CONNECTION POOL ────────────────────────────────────────────
# min=2: her zaman 2 hazır bağlantı
# max=15: Railway Postgres hobby planı 25 max_connections — 15 güvenli üst sınır
_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                dsn = _resolve_database_url()
                _pg_ct = int(os.environ.get("PG_CONNECT_TIMEOUT", "15") or "15")
                # 🔌 HAVUZ BOYUTU (2026-08-08, canlı: "sayfa açıldığında veriler
                # hemen gelmiyor, tekrar dene deyince geliyor" → PoolError).
                # v2 paneli açılışta ~13 uç çağırıyor; buna gece işleri, şube
                # panelleri ve QR ekranları eklenince maxconn=15 yetmiyordu.
                # Çevre değişkeniyle ayarlanabilir (PG_MAX_CONN).
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    minconn=2,
                    maxconn=int(os.environ.get("PG_MAX_CONN", "32") or "32"),
                    dsn=dsn,
                    cursor_factory=psycopg2.extras.RealDictCursor,
                    connect_timeout=max(3, min(_pg_ct, 120)),
                )
    return _pool


@contextmanager
def db():
    """
    PostgreSQL bağlantı context manager — pool'dan alır, işlem sonrası iade eder.
    Kullanım:
        with db() as (conn, cur):
            cur.execute(...)
    Başarılı çıkışta commit, hata durumunda rollback yapar.
    """
    pool = _get_pool()
    conn = pool.getconn()
    # cursor_factory pool seviyesinde ayarlanmış değil, bağlantıda set et
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    cur = conn.cursor()
    try:
        # CURRENT_DATE / NOW() / CURRENT_TIMESTAMP — İstanbul iş günü ile hizalı
        try:
            cur.execute("SET TIME ZONE 'Europe/Istanbul'")
        except Exception:
            logging.getLogger(__name__).warning(
                "SET TIME ZONE Europe/Istanbul uygulanamadı; SQL tarihleri sunucu diliminde kalabilir.",
                exc_info=True,
            )
        # Uzun süren tek sorgu tüm worker'ı kilitlemesin (proxy 502 öncesi)
        try:
            _st_ms = int(os.environ.get("PG_STATEMENT_TIMEOUT_MS", "55000") or "55000")
            if _st_ms > 0:
                cur.execute("SET statement_timeout = %s", (_st_ms,))
        except Exception:
            pass
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        pool.putconn(conn)


def stok_yolda_sevk_kaynak_col_exists(cur) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'stok_yolda'
          AND column_name = 'sevk_kaynak_depo_sube_id'
        LIMIT 1
        """
    )
    return cur.fetchone() is not None


def ensure_stok_yolda_columns(cur) -> None:
    """
    stok_yolda.sevk_kaynak_depo_sube_id — ayrı çağrılabilir migrasyon.
    init_db tek transaction içinde sonradan hata olursa kolon eklenmemiş kalabilir.
    """
    if stok_yolda_sevk_kaynak_col_exists(cur):
        return
    try:
        cur.execute(
            """
            ALTER TABLE stok_yolda
                ADD COLUMN sevk_kaynak_depo_sube_id TEXT
                REFERENCES subeler(id) ON DELETE SET NULL
            """
        )
    except Exception as exc:
        if "already exists" not in str(exc).lower():
            raise


def ensure_dusum_modu(cur) -> None:
    """siparis_urun.dusum_modu + sube_kullanimda_urun — ayrı, kendi
    transaction'ında çalışabilen migrasyon. init_db tek transaction içinde
    geç bir hatayla geri sarılırsa bu kolon eklenmemiş kalmasın diye startup'ta
    da bağımsız çağrılır."""
    cur.execute("""
        ALTER TABLE siparis_urun
        ADD COLUMN IF NOT EXISTS dusum_modu TEXT NOT NULL DEFAULT 'acilinca'
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sube_kullanimda_urun (
            id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            sube_id            TEXT NOT NULL,
            urun_id            TEXT,
            kalem_kodu         TEXT,
            urun_ad            TEXT,
            adet               INT  NOT NULL DEFAULT 1,
            durum              TEXT NOT NULL DEFAULT 'kullanimda',
            acan_personel_id   TEXT,
            acan_personel_ad   TEXT,
            ac_ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            biten_personel_id  TEXT,
            biten_personel_ad  TEXT,
            bitti_ts           TIMESTAMPTZ
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_kullanimda_sube_durum
        ON sube_kullanimda_urun (sube_id, durum, ac_ts DESC)
    """)
    # Tek seferlik seed — hiç 'bitince' yoksa uygula (manuel değişiklikleri ezmez)
    cur.execute("SELECT 1 FROM siparis_urun WHERE dusum_modu = 'bitince' LIMIT 1")
    if cur.fetchone() is None:
        cur.execute("""
            UPDATE siparis_urun su
            SET dusum_modu = 'bitince', guncelleme = NOW()
            FROM siparis_kategori sk
            WHERE su.kategori_id = sk.id
              AND (
                  sk.kod = 'bitki_cayi'
                  OR (sk.kod = 'temizlik' AND su.norm_ad NOT IN ('z_pecete', 'cop_poseti'))
              )
        """)
        cur.execute("""
            UPDATE siparis_urun su
            SET dusum_modu = 'bitince', guncelleme = NOW()
            FROM siparis_kategori sk
            WHERE su.kategori_id = sk.id
              AND sk.kod = 'sarf'
              AND su.norm_ad IN (
                  'filtre_kagidi','strec_film','islak_mendil','kese_kagidi',
                  'bardak_cantasi','ahsap_karistirici','cam_bezi','zimba_teli'
              )
        """)


def ensure_kart_kategori_columns(cur) -> None:
    """Faz K-A: kart_hareketleri.harcama_tipi (şahsi/işletme) + kartlar.sahip.
    Bağımsız migration — init_db tek transaction'ı geç bir hatayla geri sarılırsa
    bu kolonlar yine de eklensin diye startup'ta ayrıca çağrılır."""
    cur.execute(
        "ALTER TABLE kart_hareketleri ADD COLUMN IF NOT EXISTS harcama_tipi TEXT NOT NULL DEFAULT 'belirsiz'"
    )
    cur.execute(
        "ALTER TABLE kart_hareketleri ADD COLUMN IF NOT EXISTS kategori TEXT"
    )
    cur.execute(
        "ALTER TABLE kartlar ADD COLUMN IF NOT EXISTS sahip TEXT NOT NULL DEFAULT 'İşletme'"
    )
    cur.execute(
        "ALTER TABLE kartlar ADD COLUMN IF NOT EXISTS ortak_limit_grup TEXT"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_kart_hareketleri_tip "
        "ON kart_hareketleri (kart_id, harcama_tipi, durum)"
    )


def ensure_isletmeci(cur) -> None:
    """İŞLETMECİ TANIMI (sahip, 2026-08-10: "şahsi harcamalar Onur/Fethi/Fatma olarak
    ayrışmalı ama isim isim EKLEME — işletmeci tanımlarını kurmalıyız, kasa teslimdeki
    desen gibi").

    DESEN = kasa_teslim_alici: tanım tablosu + CRUD + harekette hem id hem AD taşınır.
    Ad'ın da taşınması bilinçlidir ("kar tanesi"): kişi kaydı sonradan düzeltilse/pasife
    çekilse bile geçmiş hareket kimin olduğunu söylemeye devam eder.

    İSİMLER KODA GÖMÜLMEZ — tohum mevcut kartların `sahip` alanından türer, sonrası
    ekrandan yönetilir. 'İşletme' bir kişi değildir, tohuma alınmaz.
    """
    cur.execute("""
        CREATE TABLE IF NOT EXISTS isletmeci (
            id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            ad         TEXT NOT NULL,
            ad_anahtar TEXT,
            unvan      TEXT,
            aktif      BOOLEAN NOT NULL DEFAULT TRUE,
            olusturma  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("ALTER TABLE isletmeci ADD COLUMN IF NOT EXISTS ad_anahtar TEXT")

    # ⚠️ TÜRKÇE-İ TUZAĞI (canlıda yakalandı, 2026-08-10): ilk sürüm UNIQUE'i
    # lower(ad) üzerine kurmuştu ve tohum İKİ "Fethi Karabacak" üretti. Sebep
    # GÖRÜNMEZ: Garanti kartının adında 'i' + U+0307 (COMBINING DOT ABOVE) var,
    # yani "Fethi̇" ≠ "Fethi" — ekranda aynı görünür, lower() eşitlemez.
    # Kimlik artık NORMALİZE anahtar üzerinden kurulur: NFKD → kombine işaretleri
    # at → TR harfleri sadeleştir → küçült → boşlukları tekille.
    # Sıra ÖNEMLİ: önce Türkçe harfler ASCII'ye çevrilir (yoksa 'ı' son adımda
    # tamamen silinirdi), sonra NFKD ayrıştırıp ASCII-DIŞI her şeyi atarız —
    # görünmez kombine noktalar (U+0307) böyle temizlenir.
    # ⚠️ normalize(... NFKD) ve [[:ascii:]] PostgreSQL SÜRÜMÜNE bağlıdır; canlıda
    # migration bu yüzden SESSİZCE düştü (startup try/except hatayı yutuyor, kolon
    # hiç eklenmedi). Sürümden bağımsız yol: translate ile hem Türkçe harfleri
    # ASCII'ye çevir hem de görünmez birleşen (combining) işaretleri sil.
    cur.execute("""
        CREATE OR REPLACE FUNCTION isletmeci_ad_anahtar(p TEXT) RETURNS TEXT AS $$
          SELECT btrim(regexp_replace(
                   lower(translate(
                     translate(COALESCE(p,''),
                               'çğıöşüÇĞİıÖŞÜâîûÂÎÛ',
                               'cgiosuCGIIOSUaiuAIU'),
                     chr(768)||chr(769)||chr(770)||chr(771)||chr(772)||chr(774)||
                     chr(775)||chr(776)||chr(779)||chr(780)||chr(807)||chr(808),
                     '')),
                   '[[:space:]]+', ' ', 'g'))
        $$ LANGUAGE SQL IMMUTABLE
    """)
    cur.execute("UPDATE isletmeci SET ad_anahtar = isletmeci_ad_anahtar(ad) WHERE ad_anahtar IS NULL OR ad_anahtar = ''")

    # ── MÜKERRER BİRLEŞTİRME: aynı normalize ad = aynı kişi ───────────────────
    # En eski kayıt kanonik; diğerlerinin kartları/hareketleri ona taşınır ve
    # kendileri pasife alınır (silinmez — geçmiş kaybolmaz).
    cur.execute("""
        WITH kanonik AS (
            SELECT ad_anahtar, MIN((olusturma, id)::text) AS ilk
              FROM isletmeci WHERE aktif=TRUE GROUP BY ad_anahtar HAVING COUNT(*) > 1
        ), esle AS (
            SELECT y.id AS yedek_id,
                   (SELECT x.id FROM isletmeci x
                     WHERE x.ad_anahtar = y.ad_anahtar AND x.aktif=TRUE
                     ORDER BY x.olusturma, x.id LIMIT 1) AS ana_id
              FROM isletmeci y JOIN kanonik k ON k.ad_anahtar = y.ad_anahtar
             WHERE y.aktif=TRUE AND (y.olusturma, y.id)::text > k.ilk
        )
        UPDATE kartlar c SET sahip_isletmeci_id = e.ana_id
          FROM esle e WHERE c.sahip_isletmeci_id = e.yedek_id
    """)
    cur.execute("""
        WITH kanonik AS (
            SELECT ad_anahtar, MIN((olusturma, id)::text) AS ilk
              FROM isletmeci WHERE aktif=TRUE GROUP BY ad_anahtar HAVING COUNT(*) > 1
        ), esle AS (
            SELECT y.id AS yedek_id,
                   (SELECT x.id FROM isletmeci x
                     WHERE x.ad_anahtar = y.ad_anahtar AND x.aktif=TRUE
                     ORDER BY x.olusturma, x.id LIMIT 1) AS ana_id
              FROM isletmeci y JOIN kanonik k ON k.ad_anahtar = y.ad_anahtar
             WHERE y.aktif=TRUE AND (y.olusturma, y.id)::text > k.ilk
        )
        UPDATE kart_hareketleri h SET sahsi_isletmeci_id = e.ana_id
          FROM esle e WHERE h.sahsi_isletmeci_id = e.yedek_id
    """)
    cur.execute("""
        WITH kanonik AS (
            SELECT ad_anahtar, MIN((olusturma, id)::text) AS ilk
              FROM isletmeci WHERE aktif=TRUE GROUP BY ad_anahtar HAVING COUNT(*) > 1
        )
        UPDATE isletmeci y SET aktif=FALSE
          FROM kanonik k
         WHERE y.ad_anahtar = k.ad_anahtar AND y.aktif=TRUE
           AND (y.olusturma, y.id)::text > k.ilk
    """)

    # MASKELİ ad kişi değildir — ilk tohum Ziraat kartının "F**** K********"
    # sahip alanından sahte bir kişi üretmişti. Pasife çekilir (silinmez).
    cur.execute("UPDATE isletmeci SET aktif=FALSE WHERE ad LIKE '%*%' AND aktif=TRUE")

    # ── ŞAHSİ HARCAMA → KİŞİ HAFIZASI ────────────────────────────────────────
    # Sahip (2026-08-10): "kartların direkt atama mantığında kurgulama — aynı kartı
    # bazen 3 kişinin şahsi harcamasına uygulanabilir."
    # DOĞRU: kart hamili ≠ harcamayı yapan. Kişi, SATICI örüntüsünden öğrenilir
    # (kart_satici_kural deseninin ikizi): sahip bir kez "TRENDYOL → Fatma" derse
    # sonraki TRENDYOL satırları ÖNERİLİR — otomatik yazılmaz, öneri kalır.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sahsi_kisi_kural (
            anahtar      TEXT PRIMARY KEY,
            isletmeci_id TEXT NOT NULL REFERENCES isletmeci(id),
            adet         INT NOT NULL DEFAULT 1,
            guncelleme   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    cur.execute("DROP INDEX IF EXISTS uq_isletmeci_ad")
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_isletmeci_ad_anahtar
        ON isletmeci (ad_anahtar) WHERE aktif = TRUE
    """)
    # Kart → sahibi olan kişi (metin `sahip` alanı KORUNUR; bu onun kanonik karşılığı)
    cur.execute("ALTER TABLE kartlar ADD COLUMN IF NOT EXISTS sahip_isletmeci_id TEXT REFERENCES isletmeci(id)")
    # Şahsi harcama → KİMİN şahsi harcaması
    cur.execute("ALTER TABLE kart_hareketleri ADD COLUMN IF NOT EXISTS sahsi_isletmeci_id TEXT REFERENCES isletmeci(id)")
    cur.execute("ALTER TABLE kart_hareketleri ADD COLUMN IF NOT EXISTS sahsi_isletmeci_ad TEXT")
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_kart_hareketleri_sahsi_kisi
        ON kart_hareketleri (sahsi_isletmeci_id, harcama_tipi)
    """)

    # ── TOHUM: mevcut kart sahiplerinden kişi üret ────────────────────────────
    # Yalnız BİR KEZ anlamlıdır; UNIQUE index tekrarları yutar. 'İşletme' hariç.
    # MASKELİ ad tohuma ALINMAZ: Ziraat kartının sahip alanı "F**** K********"
    # şeklinde maskeli geliyordu ve sahte bir kişi üretmişti. '*' içeren ad kişi
    # değildir — o kartın sahibini sahip ekrandan seçer.
    cur.execute("""
        INSERT INTO isletmeci (ad, ad_anahtar, unvan)
        SELECT DISTINCT ON (isletmeci_ad_anahtar(sahip))
               btrim(sahip), isletmeci_ad_anahtar(sahip), 'ortak'
          FROM kartlar
         WHERE COALESCE(btrim(sahip),'') NOT IN ('', 'İşletme', 'Isletme', 'işletme')
           AND sahip NOT LIKE '%*%'
           AND isletmeci_ad_anahtar(sahip) <> ''
        ON CONFLICT (ad_anahtar) WHERE aktif = TRUE DO NOTHING
    """)
    # Kartları kanonik kişiye bağla — NORMALİZE anahtar üzerinden (ad'ın kendisiyle
    # değil: "Fethi̇" ≠ "Fethi" tuzağı burada da vururdu).
    cur.execute("""
        UPDATE kartlar k SET sahip_isletmeci_id = i.id
          FROM isletmeci i
         WHERE k.sahip_isletmeci_id IS NULL
           AND i.aktif = TRUE
           AND isletmeci_ad_anahtar(k.sahip) = i.ad_anahtar
           AND COALESCE(btrim(k.sahip),'') <> ''
    """)


def ensure_abonelik(cur) -> None:
    """ABONELİK KİMLİĞİ — otomatik talimatlı faturanın eşleştirme anahtarı.

    Sahip (2026-08-10): "faturaların tutarları özellikle DEĞİŞKENLERİN her zaman
    farklı oluyor; burada fatura numaralarından ve tarihten sistemdeki borç olup
    olmadığını bulacaksın."

    Codex hükmü (2026-08-10): "bu işi daha iyi fuzzy matching ile çözemezsin, veri
    modeli yanlış. Bağlayacağın şey satıcı değil, ABONELİK/TESİSAT. Aynı ENERYA
    altında birden fazla abonelik olabilir; merchant adı bunu ayırmaz."

    Kanıtı canlıdan: tutar+ad eşleştirmesi 9 öneri üretti, 9'u da yanlıştı
    (AKALIN 684,00 ↔ OVOLT ŞARJ 659,07). Değişken faturada tutar kimlik değildir.

    Bu tablo bir HİZMET SÖZLEŞMESİ kaydıdır: hangi sağlayıcının, hangi tesisatı,
    hangi şubede, hangi kartla ödeniyor ve kart ekstresinde hangi metinle görünüyor.
    Eşleştirme buradan kurulur; tutar yalnız destekleyici kanıttır.
    """
    cur.execute("""
        CREATE TABLE IF NOT EXISTS abonelik (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            saglayici     TEXT NOT NULL,              -- ENERYA, MEPAŞ, KONYA SU...
            hizmet_turu   TEXT NOT NULL DEFAULT 'diger',  -- elektrik|su|dogalgaz|internet|telefon|diger
            abone_no      TEXT,                        -- abone / tesisat / sözleşme no
            vkn           TEXT,
            sube_id       TEXT REFERENCES subeler(id),
            kart_id       TEXT,                        -- otomatik talimatın bağlı olduğu kart
            sabit_gider_id TEXT,                       -- karşılık gelen sabit gider tanımı
            ekstre_kalip  TEXT,                        -- ekstrede görünen metin parçası (opsiyonel)
            aktif         BOOLEAN NOT NULL DEFAULT TRUE,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_abonelik_kart ON abonelik (kart_id, aktif)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_abonelik_sube ON abonelik (sube_id, aktif)")
    # Aynı sağlayıcıda aynı abone no iki kez tanımlanmasın (abone_no boşsa serbest)
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_abonelik_abone_no
        ON abonelik (lower(saglayici), abone_no) WHERE abone_no IS NOT NULL AND aktif
    """)

    # ── ÖDEME KANITI LİNK TABLOSU ─────────────────────────────────────────────
    # Codex: "ayrı bir link tablosu tut: kart_hareket_id -> belge/plan/fatura id,
    # match_basis, confidence, approved_by. Mevcut tabloları kırmadan geçersin."
    #
    # NEDEN AYRI TABLO: kart hareketi bir ÖDEME KANITIDIR, borcun kendisi değil.
    # Bağı hareketin veya planın içine yazmak iki tarafı da kirletir; ayrı katman
    # hem geri alınabilir hem denetlenebilir kılar (BAĞLAMA ≠ KAPATMA).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_odeme_baglanti (
            id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kart_hareket_id  TEXT NOT NULL,
            hedef_tablo      TEXT NOT NULL,       -- odeme_plani | tedarikci_fatura | sabit_giderler
            hedef_id         TEXT NOT NULL,
            abonelik_id      TEXT REFERENCES abonelik(id),
            eslesme_temeli   TEXT NOT NULL,       -- abone_no | fatura_no | tek_aday | elle
            guven            INT NOT NULL DEFAULT 0,
            onaylayan        TEXT,                -- NULL = yalnız öneri, henüz onaylanmadı
            onay_ts          TIMESTAMPTZ,
            not_aciklama     TEXT,
            olusturma        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    # ⚠️ ÇİFT KAPATMA FRENİ (Codex denetimi 2026-08-10 — gerçek açık):
    # İlk sürüm tekilliği (kart_hareket_id, hedef_tablo, hedef_id) üzerine
    # kurmuştu. Bu, AYNI ekstre satırının İKİ FARKLI borca bağlanmasını
    # engellemiyordu — bir otomatik ödeme satırı iki ayrı ayın hatırlatmasını
    # kapatabilirdi (sessiz veri bozulması). Bir para çıkışı EN FAZLA BİR borcu
    # kapatır: tekillik artık kart_hareket_id üzerinde.
    cur.execute("DROP INDEX IF EXISTS uq_kart_odeme_baglanti")
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_kart_odeme_baglanti_hareket
        ON kart_odeme_baglanti (kart_hareket_id)
    """)
    # Bir borç da iki ayrı ödemeyle "kapandı" sayılmamalı.
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_kart_odeme_baglanti_hedef
        ON kart_odeme_baglanti (hedef_tablo, hedef_id)
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_kart_odeme_baglanti_hedef
        ON kart_odeme_baglanti (hedef_tablo, hedef_id)
    """)


def ensure_odeme_plani_odeme_yontemi(cur) -> None:
    """Ödeme planına ÖDEME YÖNTEMİ (sahip, 2026-08-10: "ödeme türüne KART olarak
    işlemesi lazım").

    Plan kapanınca "ödendi" yazıyordu ama NASIL ödendiği kayıtlı değildi. Kart
    ekstresinden kapanan bir borcun nakitle kapanandan ayrılması şart: nakit
    kasadan çıkar, kart borcu ise sonra ödenir. Ayrım olmadan kasa mutabakatı
    kartla kapanan borcu "kasa izi yok" diye şüpheli sayar.
    """
    cur.execute("ALTER TABLE odeme_plani ADD COLUMN IF NOT EXISTS odeme_yontemi TEXT")
    cur.execute("ALTER TABLE odeme_plani ADD COLUMN IF NOT EXISTS odeme_kart_id TEXT")
    cur.execute("ALTER TABLE odeme_plani ADD COLUMN IF NOT EXISTS odeme_kart_hareket_id TEXT")


def ensure_gider_kanonik(cur) -> None:
    """KANONİK GİDER KATMANI — P&L'in TEK otoritesi (sahip kararı 2026-08-10).

    Sahip: "Codex önerisinin uygulanmasını istiyorum ve diğer çalışma prensibi
    tamamen ortadan kalksın, ama diğer uçlara gönderdiği verileri yeni oluşturacak
    sistemden beslensin."

    Codex hükmü: "Aynı harcama için tek 'maliyet satırı' olacak. Diğerleri onun
    etrafındaki durum tabloları olacak. Bugünkü ekstre_import -> anlik_giderler
    davranışı yanlış; ödeme kanıtını maliyet kaydına çeviriyor."

    ⭐ YENİ İLKE — GİDER = PARA ÇIKIŞI, TEK YERDEN:
        NAKİT çıkışı → anlik_giderler
        KART  çıkışı → kart_hareketleri
    Bir harcama ikisinden yalnız BİRİNDE sayılır. Kartla yapılan anlık gider
    kaydı zaten kart_hareketleri'ne de yazılıyordu; artık kart tarafı otoritedir
    ve anlık gider kopyası sayılmaz. Ekstre içe aktarmanın ürettiği
    (kaynak_tablo='ekstre_import') gider satırları da böylece KENDİLİĞİNDEN
    düşer — kart hareketi o parayı zaten sayıyor.

    ÇİFT SAYIM ARTIK YAPISAL OLARAK İMKÂNSIZ: bir kaydın hangi kanaldan
    sayılacağını ödeme yöntemi belirler, eşleştirme tahminine gerek kalmaz.

    VERİ KAYBI YOK: hiçbir satır silinmez. Bu bir GÖRÜNÜM (view); ham tablolar
    olduğu gibi durur, geçmiş denetlenebilir kalır.
    """
    cur.execute("""
        CREATE OR REPLACE VIEW gider_kanonik AS
        -- A) NAKİT (ve kart olmayan) giderler → anlık gider defterinden
        SELECT
            'nakit'::text                        AS kanal,
            g.id::text                           AS id,
            g.tarih::date                        AS tarih,
            ABS(g.tutar)::numeric                AS tutar,
            COALESCE(g.kategori,'Diğer')::text   AS kategori,
            COALESCE(g.aciklama,'')::text        AS aciklama,
            -- ⚠️ KİMLİK NORMALİZASYONU (2026-08-10): ekstre içe aktarma eski
            -- kayıtlara sube='MERKEZ' (AD) yazmıştı, oysa subeler.id='sube-merkez'.
            -- Ham hâlde LEFT JOIN subeler tutmuyor ve gider "?" şubesinde
            -- toplanıyordu (canlıda 161.260 ₺). Ad→kimlik burada çevrilir.
            CASE WHEN upper(btrim(COALESCE(g.sube,''))) = 'MERKEZ'
                 THEN 'sube-merkez' ELSE g.sube END::text AS sube_id,
            COALESCE(g.odeme_yontemi,'nakit')::text AS odeme_yontemi,
            NULL::text                           AS kart_id,
            (g.kaynak_tablo IS NOT NULL)         AS belge_bagli,
            COALESCE(g.kaynak_tablo,'')::text    AS kaynak_tablo
        FROM anlik_giderler g
        WHERE COALESCE(g.durum,'aktif') = 'aktif'
          AND COALESCE(g.odeme_yontemi,'nakit') <> 'kart'
          -- ⚠️ ÖDEME ≠ GİDER, NAKİT TARAFINDA DA (2026-08-10 ölçümü).
          -- Kart kanalında bu filtre vardı, nakit kanalında YOKTU. Canlıda tek
          -- günde (26.07) 641.476 ₺ "EKSİ HESAP" kapatma gider sayılıyordu:
          -- "fethi garanti eksi hesap" 238.976 · "fethi yapı kredi eksi hesap"
          -- 207.500 · "yapı kredi onur eksi hesap" 126.000 · +69.000.
          -- "Eksi hesap" = kredili mevduat (KMH) borcunun kapatılması → bilanço
          -- hareketi, gider DEĞİL. Aynı mantık cari borç ödemesi için de geçerli.
          AND translate(upper(COALESCE(g.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%CARI BORC ODEMESI%'
          AND translate(upper(COALESCE(g.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%BORC KAPATMA%'
          AND translate(upper(COALESCE(g.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%CARIYE ODEME%'
          AND translate(upper(COALESCE(g.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%EKSI HESAP%'
          -- Kredi anaparası gider değildir (taksit/kapatma = bilanço hareketi).
          -- Yalnız FAİZ giderdir; o borc_envanteri/BORC_TAKSIT hattında yönetilir.
          AND translate(upper(COALESCE(g.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%KREDI KAPATMA%'
          AND translate(upper(COALESCE(g.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%KREDI ODEME%'

        UNION ALL

        -- B) KART giderleri → kart defterinden (tek otorite).
        --    Şahsi harcama gider DEĞİLDİR (işletme matrahına girmez).
        --    Taksitli alımda bugünün gideri o ayın taksididir; alımın tamamı
        --    değil (finans_core._TAKSIT_BORC_PAYI ile aynı doktrin).
        SELECT
            'kart'::text,
            -- Taksitli alımda her taksit AYRI satırdır; id'ye taksit sırası eklenir
            -- (aynı id birden çok satır üretemez, tekillik korunur).
            CASE WHEN COALESCE(h.taksit_sayisi,1) > 1
                 THEN h.id::text || '#' || (tk.i + 1)::text
                 ELSE h.id::text END,
            -- ⚠️ TAKSİT PERİYODİZASYONU (Codex denetimi 2026-08-10 — GERÇEK HATA):
            -- İlk sürüm taksidi aylara YAYMIYORDU; alım gününde tek satır yazıp
            -- tutar/taksit koyuyordu. 12 taksitli 120.000 ₺'lik alımın P&L'de
            -- yalnız 10.000 ₺'si görünüyor, kalan 110.000 ₺ HİÇ görünmüyordu.
            -- Artık her taksit kendi ayına düşer (alım ayı + i).
            (COALESCE(h.baslangic_tarihi, h.tarih) + (tk.i || ' month')::interval)::date,
            CASE
                WHEN COALESCE(h.taksit_sayisi,1) > 1
                    THEN ABS(h.tutar) / h.taksit_sayisi
                ELSE ABS(h.tutar)
            END::numeric,
            -- KATEGORİ: abonelik eşleşiyorsa HİZMET TÜRÜ kategoridir. Canlıda
            -- 63.791,50 ₺'lik elektrik/su/doğalgaz/internet gideri kategorisiz
            -- ("Diğer") birikiyordu → "elektriğe ne ödüyorum?" sorusu cevapsızdı.
            COALESCE(
                CASE ab.hizmet_turu
                    WHEN 'elektrik' THEN 'ELEKTRİK'
                    WHEN 'su'       THEN 'SU'
                    WHEN 'dogalgaz' THEN 'DOĞALGAZ'
                    WHEN 'internet' THEN 'İNTERNET'
                    WHEN 'telefon'  THEN 'TELEFON'
                END,
                NULLIF(h.kategori,''),
                'Diğer')::text,
            COALESCE(h.aciklama,'')::text,
            -- ŞUBE: kart hareketinde şube alanı yok (kartlar merkezî). AMA otomatik
            -- talimatlı fatura ekstrede ABONE NUMARASINI taşır ve abonelik kaydı o
            -- numaranın hangi şubeye ait olduğunu bilir. Böylece "GAZZE ELEKTRİK
            -- 20.977 ₺" merkeze değil TEMA şubesine yazılır — şube kârlılığı
            -- gerçeğe yaklaşır. Eşleşme yoksa eski davranış (MERKEZ) korunur;
            -- NULL bırakmak şubeli raporlarda gideri sessizce yok ederdi.
            COALESCE(ab.sube_id, 'sube-merkez')::text,
            'kart'::text,
            h.kart_id::text,
            EXISTS (SELECT 1 FROM kart_odeme_baglanti b WHERE b.kart_hareket_id = h.id),
            'kart_hareketleri'::text
        FROM kart_hareketleri h
        -- Taksit sayısı kadar satır üret (tek çekimde 1 satır). Gelecek taksitler
        -- HENÜZ GİDER DEĞİLDİR — ekstreye girmemişlerdir; aşağıdaki WHERE onları eler.
        CROSS JOIN LATERAL generate_series(0, GREATEST(COALESCE(h.taksit_sayisi,1),1) - 1) AS tk(i)
        -- Abone numarası ekstre metninde geçiyorsa aboneliği (ve şubesini) bul.
        -- En uzun numara önce: kısa bir numara başka bir numaranın içinde
        -- geçebilir, uzun eşleşme daha spesifiktir.
        LEFT JOIN LATERAL (
            SELECT a.sube_id, a.hizmet_turu
            FROM abonelik a
            WHERE a.aktif
              AND COALESCE(a.abone_no,'') <> ''
              -- ⚠️ RAKAM SINIRI (Codex denetimi 2026-08-10): ham `position()`
              -- kısa bir abone numarasını daha uzun bir numaranın İÇİNDE
              -- eşleştiriyordu (01026495 ⊂ 010264953...). Numaranın iki yanında
              -- rakam OLMAMALI — aksi halde yanlış şube/kategori damgalanır.
              AND COALESCE(h.aciklama,'') ~ ('(^|[^0-9])' || a.abone_no || '([^0-9]|$)')
            ORDER BY length(a.abone_no) DESC
            LIMIT 1
        ) ab ON TRUE
        WHERE h.islem_turu = 'HARCAMA'
          AND COALESCE(h.durum,'aktif') = 'aktif'
          AND COALESCE(h.harcama_tipi,'belirsiz') <> 'sahsi'
          -- ⚠️ ÖDEME ≠ GİDER: tedarikçiye yapılan cari borç ödemesi para çıkışıdır
          -- ama gider DEĞİLDİR (gider malın alındığı anda doğdu). Bu satırlar
          -- anlık gider tarafında zaten 'borc_kapatma' kovasına ayrılıyordu
          -- (fatura_api._BORC_KAPATMA_KALIP); kart tarafında da aynı kural
          -- uygulanmazsa 173.303 ₺ geri sızar. Türkçe-I tuzağına düşmemek için
          -- karşılaştırma aksansız tabanda ("ÖDEMESİ".upper() = "ÖDEMESI").
          AND translate(upper(COALESCE(h.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%CARI BORC ODEMESI%'
          AND translate(upper(COALESCE(h.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%BORC KAPATMA%'
          AND translate(upper(COALESCE(h.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%CARIYE ODEME%'
          AND translate(upper(COALESCE(h.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%EKSI HESAP%'
          -- Kredi anaparası gider değildir (taksit/kapatma = bilanço hareketi).
          -- Yalnız FAİZ giderdir; o borc_envanteri/BORC_TAKSIT hattında yönetilir.
          AND translate(upper(COALESCE(h.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%KREDI KAPATMA%'
          AND translate(upper(COALESCE(h.aciklama,'')),
                        'ÇĞıİÖŞÜÂÎÛ', 'CGIIOSUAIU') NOT LIKE '%KREDI ODEME%'
          -- Gelecek taksit gider değildir (henüz ekstreye girmedi) —
          -- finans_core._TAKSIT_BORC_PAYI ile aynı doktrin.
          AND (COALESCE(h.baslangic_tarihi, h.tarih) + (tk.i || ' month')::interval)::date
              <= CURRENT_DATE

        UNION ALL

        -- C) KASADAN ÇIKAN DİĞER GİDERLER (2026-08-10 kapsam denetimi).
        -- Ölçüm: maaş 409.822 ₺ ve kira/sabit gider 251.783 ₺ kasadan çıkıyordu
        -- ama kanonik katman yalnız anlik_giderler + kart_hareketleri okuduğu için
        -- P&L'de HİÇ GÖRÜNMÜYORDU — 661.605 ₺'lik gider kayıptı.
        -- Alınanlar: maaş, sabit gider (kira/aidat), fatura ödemesi, vadeli alım.
        -- ALINMAYANLAR ve nedenleri:
        --   ANLIK_GIDER    → (A) kanalında zaten var, çift olur
        --   KART_ODEME     → kart borcunun kapatılması; harcama (B)'de sayıldı
        --   BORC_TAKSIT    → kredi taksidi; anapara gider değil, faiz ayrı ele alınır
        --   ACILIS_DEVRI   → açılış bakiyesi, gider değil
        --   CIRO / DIS_KAYNAK / KASA_* → giriş veya düzeltme
        SELECT
            'kasa'::text,
            kh2.id::text,
            kh2.tarih::date,
            ABS(kh2.tutar)::numeric,
            CASE kh2.islem_turu
                WHEN 'PERSONEL_MAAS'  THEN 'PERSONEL'
                WHEN 'SABIT_GIDER'    THEN 'SABİT GİDER'
                WHEN 'FATURA_ODEMESI' THEN 'FATURA'
                WHEN 'VADELI_ODEME'   THEN 'TEDARİKÇİ'
                ELSE 'Diğer'
            END::text,
            COALESCE(kh2.aciklama,'')::text,
            COALESCE(kh2.sube_id, 'sube-merkez')::text,
            'nakit'::text,
            NULL::text,
            TRUE,
            'kasa_hareketleri'::text
        FROM kasa_hareketleri kh2
        WHERE kh2.islem_turu IN ('PERSONEL_MAAS','SABIT_GIDER','FATURA_ODEMESI','VADELI_ODEME')
          AND COALESCE(kh2.durum,'aktif') = 'aktif'
          AND COALESCE(kh2.kasa_etkisi, TRUE) = TRUE
          AND kh2.tutar < 0
    """)


def ensure_kart_satici_kural(cur) -> None:
    """Şahsi/dükkan SATICI HAFIZASI: bir harcamayı sınıflandırınca o satıcı (örn.
    METRO) hatırlanır → sonraki aynı satıcı otomatik aynı tip önerilir. Bağımsız migration."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_satici_kural (
            anahtar      TEXT PRIMARY KEY,
            harcama_tipi TEXT NOT NULL,
            adet         INT NOT NULL DEFAULT 1,
            guncelleme   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)


def ensure_kart_devir_islem_turu(cur) -> None:
    """kart_hareketleri.islem_turu CHECK kısıtına 'DEVIR' ekler (açılış/devreden borç).
    Bağımsız migration — init_db tek transaction olduğundan burada GARANTİ uygulanır.
    Eski CHECK 'DEVIR' içermiyorsa düşürüp DEVIR'li haliyle yeniden kurar."""
    cur.execute("""
        DO $$
        DECLARE r RECORD;
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_schema='public' AND table_name='kart_hareketleri') THEN
                FOR r IN
                    SELECT c.conname FROM pg_constraint c
                    JOIN pg_class t ON c.conrelid=t.oid
                    WHERE t.relname='kart_hareketleri' AND c.contype='c'
                      AND pg_get_constraintdef(c.oid) ILIKE '%islem_turu%'
                      AND pg_get_constraintdef(c.oid) NOT ILIKE '%DEVIR%'
                LOOP
                    EXECUTE format('ALTER TABLE kart_hareketleri DROP CONSTRAINT IF EXISTS %I', r.conname);
                END LOOP;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint c JOIN pg_class t ON c.conrelid=t.oid
                    WHERE t.relname='kart_hareketleri' AND c.contype='c'
                      AND pg_get_constraintdef(c.oid) ILIKE '%islem_turu%'
                ) THEN
                    ALTER TABLE kart_hareketleri
                        ADD CONSTRAINT kart_hareketleri_islem_turu_check
                        CHECK (islem_turu IN ('HARCAMA','ODEME','FAIZ','DEVIR'));
                END IF;
            END IF;
        END $$;
    """)


def ensure_kart_ekstre_donem(cur) -> None:
    """Faz KX: her ay yüklenen banka ekstresinin SNAPSHOT'ı — borç/asgari/faiz takibi
    ve aylık mekanizmanın omurgası. Bağımsız migration (startup'ta güvenli)."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_ekstre_donem (
            id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kart_id          TEXT NOT NULL,
            donem            DATE NOT NULL,
            kesim_tarihi     DATE,
            son_odeme_tarihi DATE,
            donem_borcu      NUMERIC(14,2),
            asgari_tutar     NUMERIC(14,2),
            onceki_borc      NUMERIC(14,2),
            donem_harcama    NUMERIC(14,2),
            donem_odeme      NUMERIC(14,2),
            donem_faizi      NUMERIC(14,2) DEFAULT 0,
            kalan_taksit     NUMERIC(14,2),
            kullanilabilir_limit NUMERIC(14,2),
            kalan_taksit_tutari NUMERIC(14,2),
            kaynak           TEXT DEFAULT 'ekstre',
            olusturma        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    # Eski ortamlarda kolon yoksa ekle (bankanın gerçek "kullanılabilir limit"i —
    # gelecek taksit anaparasını da düştüğü için limit−borç'tan farklı/küçük).
    cur.execute(
        "ALTER TABLE kart_ekstre_donem "
        "ADD COLUMN IF NOT EXISTS kullanilabilir_limit NUMERIC(14,2)"
    )
    # Kalan toplam taksit tutarı (gelecek taksit yükü — Worldcard doğrudan basar).
    cur.execute(
        "ALTER TABLE kart_ekstre_donem "
        "ADD COLUMN IF NOT EXISTS kalan_taksit_tutari NUMERIC(14,2)"
    )
    cur.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_kart_ekstre_donem "
        "ON kart_ekstre_donem (kart_id, donem)"
    )


def ensure_kart_gercek_modeli(cur) -> None:
    """🆕 KART GERÇEK MODELİ — yeni tablolar (YOL HARİTASI ADIM 2/12, 2026-08-17).

    NEDEN: 17 Ağustos denetimi altı hata sınıfı buldu ve hepsinin kökü aynıydı —
    belge gerçeği, ekstre gerçeği, defter gerçeği, taksit gerçeği ve düzeltme
    gerçeği İKİ tabloya (kart_hareketleri + kart_ekstre_donem) sıkışmış, sonra
    beş ayrı yerde farklı hesaplanıyordu. Okuyucu hataları bu çöküşün semptomu.

    ⚠️ BU ADIM SAF EKLEMEDİR: hiçbir uç bu tablolara yazmaz, hiçbir ekran okumaz.
    Sistem bu adımdan sonra da bugünkü davranışını aynen sürdürür. Tabloların
    doldurulması ADIM 3 (geçmişi taşı), kullanılması ADIM 6-7'dir.

    TASARIM İLKELERİ (Fable + Codex ortak):
      · Kimlik İÇERİĞE değil SIRAYA bağlanır — aynı gün üç özdeş satır ÜÇ kayıttır.
      · Okuma DEĞİŞMEZ, sürümlenir — okuyucu düzelince yeni sürüm kabul edilir,
        eski kayıtlar fark motoruyla düzeltilir (bugün ON CONFLICT DO NOTHING
        yüzünden yanlış satır kalıcı).
      · Açılış devri ≠ Mutabakat düzeltmesi — ikisi ayrı tablo, ayrı yetki.
      · Mutabakat farkı SİLİNMEZ, kaydedilir; import hatası devre emilemez.
    """
    # ── 1) BELGE — PDF aslı, içerik anahtarlı (aynı PDF iki kez = tek belge) ──
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_belge (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            sha256        TEXT NOT NULL UNIQUE,        -- doğal anahtar: içeriğin kendisi
            dosya_adi     TEXT,
            boyut         INT,
            pdf           BYTEA NOT NULL,
            yukleyen      TEXT,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    # ── 2) OKUMA SÜRÜMÜ — bir belgenin bir okuyucu sürümüyle çıkarılmış hâli ──
    #    Okuyucu düzelince YENİ sürüm doğar; eskisi tarih olarak durur.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_okuma_surumu (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            belge_id        TEXT NOT NULL REFERENCES kart_belge(id) ON DELETE CASCADE,
            okuyucu_surumu  TEXT NOT NULL,             -- ör. 'worldcard/2026-08-17'
            banka_format    TEXT,
            baslik          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- son4·kesim·borç·önceki…
            capa_durumu     TEXT NOT NULL DEFAULT 'bilinmiyor',  -- gecti|kaldi|bilinmiyor
            capa_detay      JSONB,                     -- hangi denklem, ne kadar fark
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (belge_id, okuyucu_surumu)
        )
    """)

    # ── 3) EKSTRE SATIRI — okumadaki her satır; KİMLİK = (sürüm, sıra) ────────
    #    🔑 Bugünkü "aynı gün 3 özdeş satır → 1 kayıt" kusurunun panzehiri:
    #    kimlik içerikten değil SIRA NUMARASINDAN gelir.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_ekstre_satiri (
            id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            surum_id       TEXT NOT NULL REFERENCES kart_okuma_surumu(id) ON DELETE CASCADE,
            sira_no        INT  NOT NULL,
            tarih          DATE,
            aciklama       TEXT,
            tutar          NUMERIC(14,2),
            mali_sinif     TEXT,                        -- harcama|odeme|faiz|iade|puan
            taksit_no      INT,                         -- bankanın beyanı: n
            taksit_adedi   INT,                         -- bankanın beyanı: m
            taksit_toplam  NUMERIC(14,2),
            ham            JSONB,                       -- okunan ham veri (iz)
            UNIQUE (surum_id, sira_no)
        )
    """)

    # ── 4) EKSTRE DÖNEMİ — (kart, kesim) tekil; hangi sürüm geçerli onu tutar ─
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_donem (
            id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kart_id           TEXT NOT NULL REFERENCES kartlar(id),
            kesim_tarihi      DATE NOT NULL,
            son_odeme_tarihi  DATE,
            kabul_surum_id    TEXT REFERENCES kart_okuma_surumu(id),
            durum             TEXT NOT NULL DEFAULT 'acik',  -- acik|kabul|bekliyor
            olusturma         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kart_id, kesim_tarihi)
        )
    """)

    # ── 5) KABUL — hangi sürümün ne zaman/kim tarafından kabul edildiği (olay) ─
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_kabul (
            id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            donem_id    TEXT NOT NULL REFERENCES kart_donem(id) ON DELETE CASCADE,
            surum_id    TEXT NOT NULL REFERENCES kart_okuma_surumu(id),
            karar_veren TEXT NOT NULL DEFAULT 'sahip',
            gerekce     TEXT,
            fark_ozeti  JSONB,                        -- önceki kabulle fark (ne gitti/geldi)
            olusturma   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    # ── 6) TAKSİT PLANI + 7) TAKSİT DİLİMİ — banka beyanı satır satır ─────────
    #    Bugün taksit sırası TAKVİMDEN TAHMİN ediliyor (25.414 ₺ şişme vakası).
    #    Hedefte sıra bankadan gelir ve her dilim kendi satırında yaşar.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_taksit_plani (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kart_id         TEXT NOT NULL REFERENCES kartlar(id),
            aciklama        TEXT,
            toplam_tutar    NUMERIC(14,2) NOT NULL,
            taksit_adedi    INT NOT NULL,
            ilk_donem       DATE,                      -- ilk taksidin ekstre dönemi
            durum           TEXT NOT NULL DEFAULT 'aktif',  -- aktif|iptal|inceleme
            kaynak_satir_id TEXT REFERENCES kart_ekstre_satiri(id),
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_taksit_dilimi (
            id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            plan_id      TEXT NOT NULL REFERENCES kart_taksit_plani(id) ON DELETE CASCADE,
            taksit_no    INT NOT NULL,
            donem        DATE NOT NULL,                -- hangi ekstre kesiminde
            tutar        NUMERIC(14,2) NOT NULL,
            durum        TEXT NOT NULL DEFAULT 'beklenen',  -- beklenen|gerceklesti|iptal
            satir_id     TEXT REFERENCES kart_ekstre_satiri(id),  -- gerçekleştiği satır
            UNIQUE (plan_id, taksit_no)
        )
    """)

    # ── 8) AÇILIŞ DEVRİ — karta BİR KEZ; sistem başlangıç bakiyesi ───────────
    #    Bugünkü tek mutable devir_<kart> satırından ayrılıyor.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_acilis_devri (
            id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kart_id      TEXT NOT NULL REFERENCES kartlar(id),
            gecerlilik   DATE NOT NULL,
            tutar        NUMERIC(14,2) NOT NULL,
            dayanak      TEXT NOT NULL,                -- hangi ekstre/beyan
            karar_veren  TEXT NOT NULL DEFAULT 'sahip',
            olusturma    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kart_id, gecerlilik)
        )
    """)

    # ── 9) MUTABAKAT DÜZELTMESİ — fark SİLİNMEZ, gerekçeyle kaydedilir ───────
    #    KURAL: yükleme/import bu tabloya YAZAMAZ. Yalnız sahip, ayrı akıştan.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_mutabakat_duzeltmesi (
            id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kart_id      TEXT NOT NULL REFERENCES kartlar(id),
            donem_id     TEXT REFERENCES kart_donem(id),
            sapma_tutar  NUMERIC(14,2) NOT NULL,
            neden_kodu   TEXT NOT NULL,                -- eksik_gecmis|okuma_hatasi|banka_farki
            gerekce      TEXT NOT NULL,
            kanit        TEXT,
            karar_veren  TEXT NOT NULL DEFAULT 'sahip',
            olusturma    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    # ── 10) DEFTER KAYDI — borcu değiştiren olay; kaynağı TEKİL ──────────────
    #    🔑 UNIQUE(kaynak_tur, kaynak_id): bir ekstre satırından EN FAZLA bir
    #    defter kaydı doğar → çift yazım yapısal olarak imkânsız. Bugünkü
    #    içerik-hash'li ON CONFLICT DO NOTHING deseninin yerini alır.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_defter_kaydi (
            id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            kart_id      TEXT NOT NULL REFERENCES kartlar(id),
            tarih        DATE NOT NULL,
            islem_turu   TEXT NOT NULL,                -- HARCAMA|ODEME|FAIZ|DEVIR|DUZELTME
            tutar        NUMERIC(14,2) NOT NULL,
            aciklama     TEXT,
            harcama_tipi TEXT,                          -- isletme|sahsi|belirsiz
            kaynak_tur   TEXT NOT NULL,                 -- ekstre_satiri|acilis|duzeltme|elle
            kaynak_id    TEXT,
            iptal_eden   TEXT REFERENCES kart_defter_kaydi(id),  -- ters kayıt (append-only)
            olusturma    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kaynak_tur, kaynak_id)
        )
    """)

    # ── 11) ÖDEME DAĞITIMI — "bu ödeme hangi ekstreye sayıldı" (bugün cevapsız) ─
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kart_odeme_dagitimi (
            id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            odeme_id   TEXT NOT NULL REFERENCES kart_defter_kaydi(id) ON DELETE CASCADE,
            donem_id   TEXT NOT NULL REFERENCES kart_donem(id),
            tutar      NUMERIC(14,2) NOT NULL,
            olusturma  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (odeme_id, donem_id)
        )
    """)

    # ── Erişim indeksleri ────────────────────────────────────────────────────
    for sql in (
        "CREATE INDEX IF NOT EXISTS idx_kart_donem_kart ON kart_donem (kart_id, kesim_tarihi DESC)",
        "CREATE INDEX IF NOT EXISTS idx_kart_satir_surum ON kart_ekstre_satiri (surum_id, sira_no)",
        "CREATE INDEX IF NOT EXISTS idx_kart_defter_kart ON kart_defter_kaydi (kart_id, tarih DESC)",
        "CREATE INDEX IF NOT EXISTS idx_kart_dilim_donem ON kart_taksit_dilimi (donem, durum)",
        "CREATE INDEX IF NOT EXISTS idx_kart_surum_belge ON kart_okuma_surumu (belge_id)",
    ):
        cur.execute(sql)


def ensure_rapor_kapanis(cur) -> None:
    """Aylık rapor kapanış mührü tablosu (NRF dönem kapanışı). init_db tek
    transaction içinde geç hatayla geri sarılırsa kaybolmasın diye startup'ta
    bağımsız da çağrılır."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS rapor_kapanis (
            donem          TEXT PRIMARY KEY,            -- 'YYYY-MM'
            ozet_json      JSONB NOT NULL,
            muhurleyen_id  TEXT,
            muhurleyen_ad  TEXT,
            muhur_ts       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            hash           TEXT
        )
    """)


def ensure_operasyon_event_durum_latent(cur) -> None:
    """sube_operasyon_event.durum CHECK kısıtına 'latent' ekler.

    Latent kontrol modeli (açılışta/devirde planlanan, panel aktivitesinde
    canlanan KONTROL eventleri) durum='latent' kullanıyor; ama tablonun
    orijinal CHECK kısıtı yalnızca bekliyor/tamamlandi/gecikti/iptal kabul
    ediyordu. Bu yüzden açılış sonrası KONTROL insert'i 500 veriyor ve panel
    refresh'i takılıyordu. init_db tek transaction olduğundan bu migrasyon
    startup'ta kendi transaction'ında da bağımsız çağrılır."""
    cur.execute(
        "ALTER TABLE sube_operasyon_event "
        "DROP CONSTRAINT IF EXISTS sube_operasyon_event_durum_check"
    )
    cur.execute(
        "ALTER TABLE sube_operasyon_event "
        "ADD CONSTRAINT sube_operasyon_event_durum_check "
        "CHECK (durum IN ('latent','bekliyor','tamamlandi','gecikti','iptal'))"
    )


def stok_yolda_insert_row(
    cur,
    *,
    yid: str,
    siparis_talep_id: str,
    sube_id: str,
    kalem_kodu: str,
    kalem_adi: str,
    sevk_adet: int,
    kaynak_depo: Optional[str],
) -> None:
    """stok_yolda satırı — kolon yoksa migrasyon dener, yine yoksa kolonsuz INSERT."""
    ensure_stok_yolda_columns(cur)
    if stok_yolda_sevk_kaynak_col_exists(cur):
        cur.execute(
            """
            INSERT INTO stok_yolda
                (id, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, durum,
                 sevk_kaynak_depo_sube_id)
            VALUES (%s, %s, %s, %s, %s, %s, 'yolda', %s)
            """,
            (yid, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, kaynak_depo),
        )
    else:
        cur.execute(
            """
            INSERT INTO stok_yolda
                (id, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, durum)
            VALUES (%s, %s, %s, %s, %s, %s, 'yolda')
            """,
            (yid, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet),
        )


def init_db():
    """
    Veritabanı tablolarını oluşturur. Sunucu başlarken bir kez çalışır.
    Mevcut tablolara dokunmaz (IF NOT EXISTS).
    """
    with db() as (conn, cur):
        # pgcrypto — gen_random_uuid() için gerekli
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")

        # ── ŞUBELER ────────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS subeler (
                id          TEXT PRIMARY KEY,
                ad          TEXT NOT NULL,
                adres       TEXT,
                aktif       BOOLEAN NOT NULL DEFAULT TRUE,
                pos_oran    NUMERIC(5,2) NOT NULL DEFAULT 0,
                online_oran NUMERIC(5,2) NOT NULL DEFAULT 0,
                vardiya_yazilsin BOOLEAN NOT NULL DEFAULT TRUE,
                acilis_sadece_part BOOLEAN NOT NULL DEFAULT FALSE,
                kapanis_sadece_part BOOLEAN NOT NULL DEFAULT FALSE,
                acilis_saati TEXT,
                kapanis_saati TEXT,
                yogun_saat_baslangic TEXT,
                yogun_saat_bitis TEXT,
                ortusme_gerekli BOOLEAN NOT NULL DEFAULT FALSE,
                min_personel SMALLINT NOT NULL DEFAULT 1,
                yogun_saat_ek_personel SMALLINT NOT NULL DEFAULT 0,
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        # Migration: pos/online oran kolonları
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='pos_oran')
                THEN ALTER TABLE subeler ADD COLUMN pos_oran NUMERIC(5,2) NOT NULL DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='online_oran')
                THEN ALTER TABLE subeler ADD COLUMN online_oran NUMERIC(5,2) NOT NULL DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='vardiya_yazilsin')
                THEN ALTER TABLE subeler ADD COLUMN vardiya_yazilsin BOOLEAN NOT NULL DEFAULT TRUE; END IF;
                -- Vergi tipi: sirket (Ltd/A.Ş. → kurumlar %25 düz) | sahis (gelir vergisi artan dilim)
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='vergi_tipi')
                THEN ALTER TABLE subeler ADD COLUMN vergi_tipi TEXT NOT NULL DEFAULT 'sirket';
                     -- İlk kurulum: Zafer + Köyceğiz şahıs (kullanıcı kararı 2026-06-23, farklı kişiler)
                     UPDATE subeler SET vergi_tipi='sahis' WHERE id IN ('sube-zafer','sube-koycegiz');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='acilis_saati')
                THEN ALTER TABLE subeler ADD COLUMN acilis_saati TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='kapanis_saati')
                THEN ALTER TABLE subeler ADD COLUMN kapanis_saati TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='yogun_saat_baslangic')
                THEN ALTER TABLE subeler ADD COLUMN yogun_saat_baslangic TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='yogun_saat_bitis')
                THEN ALTER TABLE subeler ADD COLUMN yogun_saat_bitis TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='ortusme_gerekli')
                THEN ALTER TABLE subeler ADD COLUMN ortusme_gerekli BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                -- Deterministik KAPANIŞ SORUMLUSU (GPT+kullanıcı tasarımı 2026-06-22):
                -- "şubeyi kim kapatacak" ad-hoc değil, kasa zincirinden türer. Açılışta
                -- = sabahçı (açan); kasa devrinde = devralan. Otomatik çıkış BU ALANI
                -- DEĞİŞTİRMEZ (TEMA kilitlenmesinin kökü). Gün başında açılış sıfırlar.
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='aktif_kapanis_sorumlusu_personel_id')
                THEN ALTER TABLE subeler ADD COLUMN aktif_kapanis_sorumlusu_personel_id TEXT;
                     ALTER TABLE subeler ADD COLUMN aktif_kapanis_sorumlusu_tarih DATE; END IF;
                -- Kapanış hatırlatma WhatsApp izi (gün başına 1 kez gönderilir)
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='kapanis_hatirlatma_tarih')
                THEN ALTER TABLE subeler ADD COLUMN kapanis_hatirlatma_tarih DATE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='vardiya_yazilsin')
                THEN ALTER TABLE subeler ADD COLUMN vardiya_yazilsin BOOLEAN NOT NULL DEFAULT TRUE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='min_personel')
                THEN ALTER TABLE subeler ADD COLUMN min_personel SMALLINT NOT NULL DEFAULT 1; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='yogun_saat_ek_personel')
                THEN ALTER TABLE subeler ADD COLUMN yogun_saat_ek_personel SMALLINT NOT NULL DEFAULT 0; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='acilis_sadece_part')
                THEN ALTER TABLE subeler ADD COLUMN acilis_sadece_part BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='kapanis_sadece_part')
                THEN ALTER TABLE subeler ADD COLUMN kapanis_sadece_part BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                -- Sezonluk kapatma (Köyceğiz/Alsancak gibi sezon dışı kapanan şube):
                -- TRUE ise canlı operasyon görünümünde + atama dropdown'larında gizlenir.
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='sezon_kapali')
                THEN ALTER TABLE subeler ADD COLUMN sezon_kapali BOOLEAN NOT NULL DEFAULT FALSE; END IF;
            END $$;
        """)

        # Varsayılan merkez şube
        cur.execute("""
            INSERT INTO subeler (id, ad)
            VALUES ('sube-merkez', 'MERKEZ')
            ON CONFLICT (id) DO NOTHING
        """)

        # ── ŞUBE AÇILIŞ (manuel onay — saat geçti ≠ açıldı) ─────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_acilis (
                id              TEXT PRIMARY KEY,
                sube_id         TEXT NOT NULL REFERENCES subeler(id),
                tarih           DATE NOT NULL,
                acilis_saati    TEXT NOT NULL,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW(),
                personel_id     TEXT,
                durum           TEXT NOT NULL DEFAULT 'acildi',
                aciklama        TEXT,
                CONSTRAINT chk_sube_acilis_durum CHECK (durum IN ('acildi', 'iptal'))
            )
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_sube_acilis_bir_gun_acik
            ON sube_acilis (sube_id, tarih)
            WHERE durum = 'acildi'
        """)

        # ── ŞUBE OPERASYON OLAYLARI (zaman + davranış) ──────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_operasyon_event (
                id                 TEXT PRIMARY KEY,
                sube_id            TEXT NOT NULL REFERENCES subeler(id),
                tarih              DATE NOT NULL,
                tip                TEXT NOT NULL
                    CHECK (tip IN ('ACILIS','KONTROL','CIKIS','KAPANIS')),
                sira_no            INT NOT NULL DEFAULT 0,
                sistem_slot_ts     TIMESTAMP NOT NULL,
                son_teslim_ts      TIMESTAMP NOT NULL,
                cevap_ts           TIMESTAMP,
                durum              TEXT NOT NULL DEFAULT 'bekliyor'
                    CHECK (durum IN ('latent','bekliyor','tamamlandi','gecikti','iptal')),
                personel_saat      TEXT,
                kasa_sayim         NUMERIC(14,2),
                teslim             NUMERIC(14,2),
                devir              NUMERIC(14,2),
                snap_nakit         NUMERIC(14,2),
                snap_pos           NUMERIC(14,2),
                snap_online        NUMERIC(14,2),
                x_raporu_onay      BOOLEAN NOT NULL DEFAULT FALSE,
                ciro_gonderim_onay BOOLEAN NOT NULL DEFAULT FALSE,
                meta               TEXT,
                olusturma          TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (sube_id, tarih, tip, sira_no)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_operasyon_sube_tarih
            ON sube_operasyon_event (sube_id, tarih)
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_event'
                      AND column_name = 'alarm_sayisi'
                ) THEN
                    ALTER TABLE sube_operasyon_event
                    ADD COLUMN alarm_sayisi INT NOT NULL DEFAULT 0;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_event'
                      AND column_name = 'personel_id'
                ) THEN
                    ALTER TABLE sube_operasyon_event ADD COLUMN personel_id TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_event'
                      AND column_name = 'personel_ad'
                ) THEN
                    ALTER TABLE sube_operasyon_event ADD COLUMN personel_ad TEXT;
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        # ── Operasyon uyarıları (merkez/ops; açılış kasa farkı vb.) ─
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_operasyon_uyari (
                id           TEXT PRIMARY KEY,
                sube_id      TEXT NOT NULL REFERENCES subeler(id),
                tarih        DATE NOT NULL DEFAULT CURRENT_DATE,
                tip          TEXT NOT NULL,
                seviye       TEXT NOT NULL DEFAULT 'normal'
                    CHECK (seviye IN ('normal','uyari','kritik')),
                beklenen_tl  NUMERIC(14,2),
                gercek_tl    NUMERIC(14,2),
                fark_tl      NUMERIC(14,2),
                mesaj        TEXT,
                okundu       BOOLEAN NOT NULL DEFAULT FALSE,
                olusturma    TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_op_uyari_sube_tarih
            ON sube_operasyon_uyari (sube_id, tarih)
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_uyari'
                      AND column_name = 'acilis_personel_id'
                ) THEN
                    ALTER TABLE sube_operasyon_uyari ADD COLUMN acilis_personel_id TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_uyari'
                      AND column_name = 'acilis_personel_ad'
                ) THEN
                    ALTER TABLE sube_operasyon_uyari ADD COLUMN acilis_personel_ad TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_uyari'
                      AND column_name = 'kapanis_personel_id'
                ) THEN
                    ALTER TABLE sube_operasyon_uyari ADD COLUMN kapanis_personel_id TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_uyari'
                      AND column_name = 'kapanis_personel_ad'
                ) THEN
                    ALTER TABLE sube_operasyon_uyari ADD COLUMN kapanis_personel_ad TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_uyari'
                      AND column_name = 'detay_json'
                ) THEN
                    ALTER TABLE sube_operasyon_uyari ADD COLUMN detay_json JSONB;
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        # ── ÇÖZÜM (düzeltilen tutar) alanları — AYRI bağımsız blok ──
        # Önceki blokların hata atıp swallow ettiği durumda da çalışsın diye ayrı.
        # Her ALTER kendi DO bloğunda; biri patlasa diğeri etkilenmez.
        for _kolon, _tip in [
            ("cozum_duzeltilen_tl", "NUMERIC(14,2)"),
            ("cozum_notu", "TEXT"),
            ("cozum_ts", "TIMESTAMPTZ"),
            ("cozum_personel_id", "TEXT"),
            ("cozum_personel_ad", "TEXT"),
        ]:
            try:
                cur.execute(
                    f"ALTER TABLE sube_operasyon_uyari ADD COLUMN IF NOT EXISTS {_kolon} {_tip}"
                )
            except Exception:
                pass

        # ── KASA FARK KAYNAK DÜZELTME (Source Correction Audit) ──
        # Her uyumsuzluk düzeltmesi (ciro/açılış/gider/devir/gerçek_açık) burada loglanır.
        # SOX-uyumlu audit trail: eski_deger + yeni_deger + sebep + kim + zaman.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kasa_fark_kaynak_duzeltme (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                uyari_id        TEXT NOT NULL REFERENCES sube_operasyon_uyari(id) ON DELETE CASCADE,
                sube_id         TEXT NOT NULL,
                tarih           DATE NOT NULL,
                tip             TEXT NOT NULL,
                sebep           TEXT NOT NULL CHECK (sebep IN (
                    'ciro_yanlis','acilis_yanlis','gider_eksik','ciro_fazla',
                    'devir_yanlis','gercek_acik'
                )),
                hedef_tablo     TEXT,
                hedef_id        TEXT,
                eski_deger_json JSONB,
                yeni_deger_json JSONB,
                eski_fark_tl    NUMERIC(14,2),
                yeni_fark_tl    NUMERIC(14,2),
                notu            TEXT,
                personel_id     TEXT,
                personel_ad     TEXT,
                onay_durumu_eski TEXT,
                onay_durumu_yeni TEXT,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kfkd_uyari ON kasa_fark_kaynak_duzeltme(uyari_id)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kfkd_sube_tarih ON kasa_fark_kaynak_duzeltme(sube_id, tarih DESC)
        """)

        # ── KASA BASKINI (CFO blind cash count) ──
        # CFO her şubeye habersiz "şu an kasanı say" emri verir; şube kör sayım yapar
        # (beklenen tutar gizli), sonra sistem fark çıkarır. Müdür kademesi olmadığı için
        # bu özellik direkt CFO → personel kontrol kanalıdır (NRF Loss Prevention pattern).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kasa_baskini (
                id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id           TEXT NOT NULL,
                baslatan_cfo_id   TEXT,
                baslatan_cfo_ad   TEXT,
                baslatma_ts       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                son_tarih_ts      TIMESTAMPTZ,
                beklenen_tutar    NUMERIC(14,2),
                sayilan_tutar     NUMERIC(14,2),
                fark              NUMERIC(14,2),
                sayim_personel_id TEXT,
                sayim_personel_ad TEXT,
                sayim_pin_dogru   BOOLEAN,
                sayim_ts          TIMESTAMPTZ,
                durum             TEXT NOT NULL DEFAULT 'aktif'
                                  CHECK (durum IN ('aktif','tamamlandi','sure_doldu','iptal')),
                snapshot_json     JSONB,
                notu              TEXT,
                olusturma         TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kasa_baskini_sube_durum
            ON kasa_baskini(sube_id, durum, baslatma_ts DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kasa_baskini_aktif
            ON kasa_baskini(sube_id) WHERE durum = 'aktif'
        """)

        # ── TRUTH ESTABLISHMENT MOTOR (Cascading 5-dim × 3-source triangulation) ──
        # Bağımsız modül — env var EVVEL_TRUTH_MOTOR_ENABLED ile global aç/kapat.
        # Her şube için ayrı aktiflik ayarı (truth_motor_ayar). Karar log'u append-only.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS truth_motor_ayar (
                sube_id      TEXT PRIMARY KEY,
                aktif        BOOLEAN NOT NULL DEFAULT FALSE,
                mod          TEXT NOT NULL DEFAULT 'read_only'
                             CHECK (mod IN ('read_only','apply')),
                son_calisma  TIMESTAMPTZ,
                notu         TEXT,
                guncelleme   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS truth_motor_kararlar (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id         TEXT NOT NULL,
                tarih           DATE NOT NULL,
                boyut           TEXT NOT NULL,
                                -- 'kasa' | 'bardak_plastik' | 'bardak_karton' |
                                -- 'redbull_soda' | 'pasta'
                n1_aksam        NUMERIC(14,2),
                n2_sabah        NUMERIC(14,2),
                n3_evo          NUMERIC(14,2),
                n3_evo_ikram    NUMERIC(14,2),
                fark_n1_n2      NUMERIC(14,2),
                evo_destek      TEXT,
                                -- 'n1' | 'n2' | 'notr' | 'yok'
                tani            TEXT NOT NULL,
                                -- 'UYUMLU' | 'IKRAM_UNUTULDU' | 'SWEETHEARTING_SINYAL' |
                                -- 'SABAH_HATALI' | 'AKSAM_HATALI' | 'COZULMEDI' |
                                -- 'SISTEMIK_HATA' | 'YETERSIZ_VERI'
                guven_skoru     NUMERIC(5,2),
                                -- 0-100, üçgenleme gücü
                detay_json      JSONB,
                aksiyon_alindi  BOOLEAN NOT NULL DEFAULT FALSE,
                aksiyon_ts      TIMESTAMPTZ,
                aksiyon_personel TEXT,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_truth_kararlar_sube_tarih
            ON truth_motor_kararlar(sube_id, tarih DESC, boyut)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_truth_kararlar_tani
            ON truth_motor_kararlar(tani, olusturma DESC) WHERE tani != 'UYUMLU'
        """)

        # ── AKILLI DENETİM İZ (Takip Workflow) ──
        # Bir karar üzerinde yapılan eylem zinciri. Her anomali → görev oluşturulabilir.
        # Bekliyor → İnceleme → Çözüldü/Soruşturma/İptal.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS akilli_denetim_iz (
                id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                karar_id     TEXT NOT NULL REFERENCES truth_motor_kararlar(id) ON DELETE CASCADE,
                durum        TEXT NOT NULL DEFAULT 'bekliyor'
                             CHECK (durum IN ('bekliyor','inceleme','cozuldu','sorusturma','iptal')),
                oncelik      TEXT NOT NULL DEFAULT 'orta'
                             CHECK (oncelik IN ('dusuk','orta','yuksek','kritik')),
                atanan_id    TEXT,
                atanan_ad    TEXT,
                acan_id      TEXT,
                acan_ad      TEXT,
                cozum_notu   TEXT,
                cozum_ts     TIMESTAMPTZ,
                olusturma    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                guncelleme   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_akilli_iz_durum
            ON akilli_denetim_iz(durum, oncelik DESC, olusturma DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_akilli_iz_karar ON akilli_denetim_iz(karar_id)
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_fire_haftalik (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                hafta_baslangic DATE NOT NULL,
                hafta_bitis     DATE NOT NULL,
                kalemler        JSONB NOT NULL DEFAULT '{}'::jsonb,
                toplam_fire     INT  NOT NULL DEFAULT 0,
                toplam_teorik   INT  NOT NULL DEFAULT 0,
                fire_oran       NUMERIC(6,2) NOT NULL DEFAULT 0,
                guncelleme      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (sube_id, hafta_baslangic)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_fire_haftalik_sube
            ON sube_fire_haftalik (sube_id, hafta_baslangic DESC)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_fire_bildirim (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                tarih           DATE NOT NULL DEFAULT CURRENT_DATE,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                personel_id     TEXT,
                personel_ad     TEXT,
                sebep_kodu      TEXT NOT NULL,
                sebep_label     TEXT NOT NULL,
                aciklama        TEXT NOT NULL,
                kalemler        JSONB NOT NULL DEFAULT '[]'::jsonb,
                toplam_adet     INT NOT NULL DEFAULT 0,
                defter_id       TEXT,
                goruldu         BOOLEAN NOT NULL DEFAULT FALSE,
                goruldu_ts      TIMESTAMPTZ,
                fis_no          TEXT,
                iade_zaman      TIMESTAMPTZ,
                iade_musteri_ad TEXT,
                iade_musteri_telefon TEXT
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_fire_bildirim_sube_tarih
            ON sube_fire_bildirim (sube_id, tarih DESC, olusturma DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_fire_bildirim_tarih
            ON sube_fire_bildirim (tarih DESC, olusturma DESC)
        """)
        for _fk, _ft in (
            ("fis_no", "TEXT"),
            ("iade_zaman", "TIMESTAMPTZ"),
            ("iade_musteri_ad", "TEXT"),
            ("iade_musteri_telefon", "TEXT"),
        ):
            cur.execute(
                f"""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_fire_bildirim'
                          AND column_name = '{_fk}'
                    ) THEN
                        ALTER TABLE sube_fire_bildirim ADD COLUMN {_fk} {_ft};
                    END IF;
                END $$;
                """
            )
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_operasyon_ozet (
                id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id           TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                tarih             DATE NOT NULL DEFAULT CURRENT_DATE,
                acilis_gercek_ts  TIMESTAMPTZ,
                kontrol_gecikme_dk INT NOT NULL DEFAULT 0,
                vardiya_devri_durum TEXT,
                satis_tahmini_toplam INT NOT NULL DEFAULT 0,
                satis_tahmini_kalemler JSONB NOT NULL DEFAULT '{}'::jsonb,
                olusturma         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                guncelleme        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (sube_id, tarih)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_operasyon_ozet_sube_tarih
            ON sube_operasyon_ozet (sube_id, tarih)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_operasyon_ozet_tarih
            ON sube_operasyon_ozet (tarih, sube_id)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS merkez_stok_kart (
                kalem_kodu      TEXT PRIMARY KEY,
                kalem_adi       TEXT NOT NULL,
                siparis_adet    INT NOT NULL DEFAULT 0,
                sevk_adet       INT NOT NULL DEFAULT 0,
                kullanilan_adet INT NOT NULL DEFAULT 0,
                kalan_adet      INT NOT NULL DEFAULT 0,
                guncelleme      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS merkez_stok_sevk (
                id                TEXT PRIMARY KEY,
                sube_id           TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                kalem_kodu        TEXT NOT NULL,
                adet              INT NOT NULL CHECK (adet > 0),
                siparis_talep_id  TEXT,
                tarih             DATE NOT NULL DEFAULT CURRENT_DATE,
                olusturma         TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_merkez_stok_sevk_tarih
            ON merkez_stok_sevk (tarih DESC, sube_id, kalem_kodu)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_merkez_stok_sevk_siparis
            ON merkez_stok_sevk (siparis_talep_id)
        """)

        # ── Operasyon defteri (append-only; silme yok) ───────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS operasyon_defter (
                id           TEXT PRIMARY KEY,
                sube_id      TEXT NOT NULL REFERENCES subeler(id),
                tarih        DATE NOT NULL DEFAULT CURRENT_DATE,
                olay_ts      TIMESTAMP NOT NULL DEFAULT NOW(),
                etiket       TEXT NOT NULL,
                aciklama     TEXT,
                ref_event_id TEXT,
                olusturma    TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_operasyon_defter_sube_ts
            ON operasyon_defter (sube_id, olay_ts DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_operasyon_defter_ref_event
            ON operasyon_defter (ref_event_id)
            WHERE ref_event_id IS NOT NULL
        """)

        # ── ŞUBE PANEL KULLANICI (PIN — vardiya devri vb.) ───────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_panel_kullanici (
                id          TEXT PRIMARY KEY,
                sube_id     TEXT NOT NULL REFERENCES subeler(id),
                ad          TEXT NOT NULL,
                pin_salt    TEXT NOT NULL,
                pin_hash    TEXT NOT NULL,
                aktif       BOOLEAN NOT NULL DEFAULT TRUE,
                yonetici    BOOLEAN NOT NULL DEFAULT FALSE,
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_panel_kul_sube
            ON sube_panel_kullanici (sube_id, aktif)
        """)

        # Ürün Aç TASLAK — yarım kalmış (PIN onaylanmamış) seçimlerin sunucu kopyası
        # Şube panelinde kullanıcı kalem seçer ama PIN vermeden çıkar/yenilerse,
        # form bir sonraki açılışta buradan yüklenir → veri kaybı önlenir.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS urun_ac_taslak (
                sube_id        TEXT PRIMARY KEY REFERENCES subeler(id) ON DELETE CASCADE,
                kalemler_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
                not_aciklama   TEXT,
                personel_id    TEXT,
                guncelleme     TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

        # Günlük kasa kilidi: sabah PIN ile açılır (satır = o gün için açılmış).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_kasa_gun_acma (
                sube_id              TEXT NOT NULL REFERENCES subeler(id),
                tarih                DATE NOT NULL DEFAULT CURRENT_DATE,
                panel_kullanici_id   TEXT NOT NULL REFERENCES sube_panel_kullanici(id),
                olusturma            TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (sube_id, tarih)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_kasa_gun_acma_tarih
            ON sube_kasa_gun_acma (tarih)
        """)

        # Resmi vardiya devri (sabahçı → akşamcı): her şubede bu devir çift kişi.
        # Genel gün sonu / operasyon kapanışı tek kişi olabilir — bu tablo yalnızca devre aittir.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kapanis_kayit (
                id                    TEXT PRIMARY KEY,
                sube_id               TEXT NOT NULL REFERENCES subeler(id),
                tarih                 DATE NOT NULL,
                olay                  TEXT NOT NULL DEFAULT 'vardiya_sabah_aksam_devri',
                nakit                 NUMERIC(14,2) NOT NULL DEFAULT 0,
                pos                   NUMERIC(14,2) NOT NULL DEFAULT 0,
                online                NUMERIC(14,2) NOT NULL DEFAULT 0,
                teslim                NUMERIC(14,2) NOT NULL,
                devir                 NUMERIC(14,2) NOT NULL DEFAULT 0,
                kapanisci_id          TEXT NOT NULL REFERENCES sube_panel_kullanici(id),
                kapanisci_onay_ts     TIMESTAMP NOT NULL,
                acilisci_id           TEXT REFERENCES sube_panel_kullanici(id),
                acilisci_onay_ts      TIMESTAMP,
                durum                 TEXT NOT NULL
                    CHECK (durum IN ('acilis_bekliyor','tamamlandi','iptal')),
                operasyon_event_id    TEXT,
                x_raporu_onay         BOOLEAN NOT NULL DEFAULT FALSE,
                ciro_gonderim_onay    BOOLEAN NOT NULL DEFAULT FALSE,
                olusturma             TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (sube_id, tarih)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kapanis_kayit_sube_tarih
            ON kapanis_kayit (sube_id, tarih)
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name='kapanis_kayit'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='kapanis_kayit' AND column_name='olay'
                ) THEN
                    ALTER TABLE kapanis_kayit
                    ADD COLUMN olay TEXT NOT NULL DEFAULT 'vardiya_sabah_aksam_devri';
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        import hashlib as _hmod

        # Demo kullanıcı PIN'leri env'den okunur; üretimde bu kayıtlar oluşturulmaz.
        _demo_pin_sabah = (os.environ.get("DEMO_PIN_SABAH") or "").strip()
        _demo_pin_aksam = (os.environ.get("DEMO_PIN_AKSAM") or "").strip()
        _evvel_env = (os.environ.get("EVVEL_ENV") or os.environ.get("RAILWAY_ENVIRONMENT") or "").lower()
        _is_prod = _evvel_env in ("production", "prod", "staging")

        if _demo_pin_sabah and _demo_pin_aksam and not _is_prod:
            _s_a, _s_k = "spA1", "spK9"
            h_a = _hmod.sha256(f"{_s_a}:{_demo_pin_sabah}".encode()).hexdigest()
            h_k = _hmod.sha256(f"{_s_k}:{_demo_pin_aksam}".encode()).hexdigest()
            cur.execute(
                """
                INSERT INTO sube_panel_kullanici (id, sube_id, ad, pin_salt, pin_hash, aktif)
                VALUES
                    ('spk-sabah-demo', 'sube-merkez', 'Sabahçı Demo', %s, %s, TRUE),
                    ('spk-aksam-demo', 'sube-merkez', 'Akşamçı Demo', %s, %s, TRUE)
                ON CONFLICT (id) DO NOTHING
                """,
                (_s_a, h_a, _s_k, h_k),
            )

        # ── X RAPORU OCR (fiş görüntüsü + model çıktısı) ─────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS x_rapor_kayit (
                id              TEXT PRIMARY KEY,
                sube_id         TEXT NOT NULL REFERENCES subeler(id),
                tarih           DATE NOT NULL,
                personel_id     TEXT,
                dosya_yolu      TEXT NOT NULL,
                mime_type       TEXT,
                ham_cevap       TEXT,
                nakit           NUMERIC(14,2),
                pos             NUMERIC(14,2),
                online          NUMERIC(14,2),
                toplam_ocr      NUMERIC(14,2),
                kasa_snapshot   NUMERIC(14,2),
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

        # NOT: Eski VARDİYA v1 tabloları (sube_vardiya_ihtiyac,
        # sube_vardiya_alternatif_kural, sube_izin_kural) v2'ye geçişte
        # kaldırıldı — finans_migration_log['vardiya_v1_drop_v1'] DROP eder.

        # ── KASA HAREKETLERİ ───────────────────────────────────
        # Tüm nakit giriş/çıkışlarının ana defteri.
        # tutar: pozitif = giriş, negatif = çıkış
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kasa_hareketleri (
                id              TEXT PRIMARY KEY,
                tarih           DATE NOT NULL,
                islem_turu      TEXT NOT NULL,
                tutar           NUMERIC(14,2) NOT NULL,
                aciklama        TEXT,
                kaynak_tablo    TEXT,
                kaynak_id       TEXT,
                ref_id          TEXT,
                ref_type        TEXT,
                idempotency_key TEXT UNIQUE,
                durum           TEXT NOT NULL DEFAULT 'aktif',
                kasa_etkisi     BOOLEAN NOT NULL DEFAULT true,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

        # Mevcut DB'de constraint yoksa ekle (migration — yeni kurulumda zaten var)
        cur.execute("""
            DO $$
            BEGIN
                -- Eski unique_ref constraint'i kaldır — backend kontrol ediyor
                IF EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'unique_ref'
                ) THEN
                    ALTER TABLE kasa_hareketleri
                    DROP CONSTRAINT unique_ref;
                END IF;
                -- Yeni: geriye uyumlu idempotency anahtarı (NULL olabilir)
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='kasa_hareketleri' AND column_name='idempotency_key'
                ) THEN
                    ALTER TABLE kasa_hareketleri ADD COLUMN idempotency_key TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'uq_kasa_hareketleri_idempotency'
                ) THEN
                    ALTER TABLE kasa_hareketleri
                    ADD CONSTRAINT uq_kasa_hareketleri_idempotency UNIQUE (idempotency_key);
                END IF;
            END $$;
        """)

        # ── BANKA YATIRIMLARI (yalnızca CFO takip; kasa hareketine yazılmaz) ──
        cur.execute("""
            CREATE TABLE IF NOT EXISTS banka_yatirimlari (
                id          TEXT PRIMARY KEY,
                tarih       DATE NOT NULL,
                tutar       NUMERIC(14,2) NOT NULL,
                yatiran_ad  TEXT NOT NULL,
                aciklama    TEXT,
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_banka_yatirimlari_tarih
            ON banka_yatirimlari (tarih DESC)
        """)

        # Migration: asgari_oran kolonu ekle
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kartlar' AND column_name='asgari_oran')
                THEN ALTER TABLE kartlar ADD COLUMN asgari_oran NUMERIC(5,2) NOT NULL DEFAULT 40; END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        # Migration: gecikme_faiz_orani — asgari altı ödemede uygulanan yıllık oran.
        # 0 ise faiz motoru fallback olarak akdi × 1.3 kullanır (TCMB ortalama ceza farkı).
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kartlar' AND column_name='gecikme_faiz_orani')
                THEN ALTER TABLE kartlar ADD COLUMN gecikme_faiz_orani NUMERIC(5,2) NOT NULL DEFAULT 0; END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        # Migration: kesim tarihi modeli — son_kesim_tarihi + kesim_tolerans
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kartlar' AND column_name='son_kesim_tarihi')
                THEN
                    ALTER TABLE kartlar ADD COLUMN son_kesim_tarihi DATE;
                    ALTER TABLE kartlar ADD COLUMN kesim_tolerans   INT NOT NULL DEFAULT 0;
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        # ── CİRO ───────────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ciro (
                id          TEXT PRIMARY KEY,
                tarih       DATE NOT NULL,
                sube_id     TEXT REFERENCES subeler(id),
                nakit       NUMERIC(14,2) NOT NULL DEFAULT 0,
                pos         NUMERIC(14,2) NOT NULL DEFAULT 0,
                online      NUMERIC(14,2) NOT NULL DEFAULT 0,
                toplam      NUMERIC(14,2) GENERATED ALWAYS AS (nakit + pos + online) STORED,
                aciklama    TEXT,
                durum       TEXT NOT NULL DEFAULT 'aktif',
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        # Ciro tablosunda unique constraint kasıtlı YOK:
        # Aynı gün aynı şubede aynı tutarda 2 ayrı ciro olabilir (sabah/akşam).
        # Duplicate koruması backend'de 5 saniyelik pencere ile yapılıyor.

        # Şube personelinden gelen ciro — önce taslak (onay kuyruğundan ayrı)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ciro_taslak (
                id            TEXT PRIMARY KEY,
                sube_id       TEXT NOT NULL REFERENCES subeler(id),
                tarih         DATE NOT NULL,
                nakit         NUMERIC(14,2) NOT NULL DEFAULT 0,
                pos           NUMERIC(14,2) NOT NULL DEFAULT 0,
                online        NUMERIC(14,2) NOT NULL DEFAULT 0,
                aciklama      TEXT,
                personel_id   TEXT,
                durum         TEXT NOT NULL DEFAULT 'bekliyor',
                olusturma     TIMESTAMP NOT NULL DEFAULT NOW(),
                onay_zamani   TIMESTAMP,
                red_nedeni    TEXT,
                ciro_id       TEXT
            )
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_ciro_taslak_sube_gun_bekliyor
            ON ciro_taslak (sube_id, tarih)
            WHERE durum = 'bekliyor'
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'ciro_taslak'
                      AND column_name = 'gonderen_ad'
                ) THEN
                    ALTER TABLE ciro_taslak ADD COLUMN gonderen_ad TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'ciro_taslak'
                      AND column_name = 'bildirim_saati'
                ) THEN
                    ALTER TABLE ciro_taslak ADD COLUMN bildirim_saati TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'ciro_taslak'
                      AND column_name = 'panel_kullanici_id'
                ) THEN
                    ALTER TABLE ciro_taslak ADD COLUMN panel_kullanici_id TEXT;
                END IF;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'operasyon_defter'
                      AND column_name = 'personel_id'
                ) THEN
                    ALTER TABLE operasyon_defter ADD COLUMN personel_id TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'operasyon_defter'
                      AND column_name = 'personel_ad'
                ) THEN
                    ALTER TABLE operasyon_defter ADD COLUMN personel_ad TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'operasyon_defter'
                      AND column_name = 'bildirim_saati'
                ) THEN
                    ALTER TABLE operasyon_defter ADD COLUMN bildirim_saati TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'operasyon_defter'
                      AND column_name = 'imza_hmac'
                ) THEN
                    ALTER TABLE operasyon_defter ADD COLUMN imza_hmac TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'operasyon_defter'
                      AND column_name = 'defter_onceki_id'
                ) THEN
                    ALTER TABLE operasyon_defter ADD COLUMN defter_onceki_id TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'operasyon_defter'
                      AND column_name = 'defter_zincir_hmac'
                ) THEN
                    ALTER TABLE operasyon_defter ADD COLUMN defter_zincir_hmac TEXT;
                END IF;
            END $$;
        """)

        # Faz 4: panel PIN yanlış deneme / geçici kilit (personel bazlı)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS panel_pin_guvenlik (
                personel_id      TEXT PRIMARY KEY REFERENCES personel(id) ON DELETE CASCADE,
                yanlis_sayaci    INT NOT NULL DEFAULT 0,
                son_yanlis_ts    TIMESTAMPTZ,
                kilit_bitis_ts   TIMESTAMPTZ
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_panel_pin_guvenlik_kilit
            ON panel_pin_guvenlik (kilit_bitis_ts)
            WHERE kilit_bitis_ts IS NOT NULL
        """)

        # Faz 5: güvenlik olayları (PIN kilit/hatalı deneme vb.)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS operasyon_guvenlik_olay (
                id           TEXT PRIMARY KEY,
                olay_ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                tip          TEXT NOT NULL,
                personel_id  TEXT,
                sube_id      TEXT,
                detay        TEXT
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_op_guvenlik_olay_ts
            ON operasyon_guvenlik_olay (olay_ts DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_op_guvenlik_olay_sube_ts
            ON operasyon_guvenlik_olay (sube_id, olay_ts DESC)
            WHERE sube_id IS NOT NULL
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS operasyon_guvenlik_alarm_durum (
                sube_id            TEXT PRIMARY KEY REFERENCES subeler(id) ON DELETE CASCADE,
                durum              TEXT NOT NULL CHECK (durum IN ('okundu','susturuldu')),
                islem_ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                islem_personel_id  TEXT,
                islem_notu         TEXT,
                sustur_bitis_ts    TIMESTAMPTZ
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_op_guv_alarm_durum_sustur
            ON operasyon_guvenlik_alarm_durum (sustur_bitis_ts)
            WHERE sustur_bitis_ts IS NOT NULL
        """)

        # Genel anahtar-değer ayarlar tablosu (evo_web_token vb.)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ayarlar (
                anahtar  TEXT PRIMARY KEY,
                deger    TEXT NOT NULL,
                guncelle TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

        # Faz 4: operasyon_defter yalnız INSERT (UPDATE/DELETE engeli)
        cur.execute("""
            CREATE OR REPLACE FUNCTION operasyon_defter_append_only_fn()
            RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'operasyon_defter append-only: % islemi yasak', TG_OP;
                END IF;
                RETURN NULL;
            END;
            $$ LANGUAGE plpgsql
        """)
        cur.execute("DROP TRIGGER IF EXISTS tr_operasyon_defter_append_only ON operasyon_defter")
        # PG11+: EXECUTE PROCEDURE; PG14+ tercih: EXECUTE FUNCTION (ikisi de geçerli).
        cur.execute("""
            CREATE TRIGGER tr_operasyon_defter_append_only
            BEFORE UPDATE OR DELETE ON operasyon_defter
            FOR EACH ROW EXECUTE FUNCTION operasyon_defter_append_only_fn()
        """)

        # ── KARTLAR ────────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kartlar (
                id              TEXT PRIMARY KEY,
                kart_adi        TEXT NOT NULL UNIQUE,
                banka           TEXT NOT NULL,
                limit_tutar     NUMERIC(14,2) NOT NULL DEFAULT 0,
                kesim_gunu      INT NOT NULL DEFAULT 15,
                son_odeme_gunu  INT NOT NULL DEFAULT 25,
                faiz_orani         NUMERIC(5,2) NOT NULL DEFAULT 0,
                asgari_oran        NUMERIC(5,2) NOT NULL DEFAULT 40,
                gecikme_faiz_orani NUMERIC(5,2) NOT NULL DEFAULT 0,
                aktif           BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

        # ── KART HAREKETLERİ ───────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kart_hareketleri (
                id              TEXT PRIMARY KEY,
                kart_id         TEXT NOT NULL REFERENCES kartlar(id),
                tarih           DATE NOT NULL,
                islem_turu      TEXT NOT NULL DEFAULT 'HARCAMA',
                tutar           NUMERIC(14,2) NOT NULL,
                taksit_sayisi   INT NOT NULL DEFAULT 1,
                faiz_tutari     NUMERIC(14,2) DEFAULT 0,
                ana_para        NUMERIC(14,2) DEFAULT 0,
                aciklama        TEXT,
                durum           TEXT NOT NULL DEFAULT 'aktif',
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        # Migration: kaynak_id kolonu kart_hareketleri'ne ekle — vadeli alım id bağlantısı
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kart_hareketleri' AND column_name='kaynak_id')
                THEN
                    ALTER TABLE kart_hareketleri ADD COLUMN kaynak_id TEXT;
                    ALTER TABLE kart_hareketleri ADD COLUMN kaynak_tablo TEXT;
                END IF;
            END $$;
        """)

        # Migration: faiz kolonları
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kart_hareketleri' AND column_name='faiz_tutari')
                THEN
                    ALTER TABLE kart_hareketleri ADD COLUMN faiz_tutari NUMERIC(14,2) DEFAULT 0;
                    ALTER TABLE kart_hareketleri ADD COLUMN ana_para NUMERIC(14,2) DEFAULT 0;
                END IF;
            END $$;
        """)
        # Migration: taksit başlangıç tarihi — kalan/geçen taksit hesabı için
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kart_hareketleri' AND column_name='baslangic_tarihi')
                THEN
                    ALTER TABLE kart_hareketleri ADD COLUMN baslangic_tarihi DATE;
                END IF;
            END $$;
        """)
        # Migration (Faz K-A): harcama_tipi (şahsi/işletme ayrımı) + kart sahibi
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kart_hareketleri' AND column_name='harcama_tipi')
                THEN
                    ALTER TABLE kart_hareketleri ADD COLUMN harcama_tipi TEXT NOT NULL DEFAULT 'belirsiz';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kartlar' AND column_name='sahip')
                THEN
                    ALTER TABLE kartlar ADD COLUMN sahip TEXT NOT NULL DEFAULT 'İşletme';
                END IF;
            END $$;
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kart_hareketleri_tip
            ON kart_hareketleri (kart_id, harcama_tipi, durum)
        """)
        # Migration: islem_turu CHECK — FAIZ dahil tek tanım (isim farklı eski constraint'leri pg_constraint ile düşürür).
        cur.execute("""
            DO $$
            DECLARE
                r RECORD;
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'kart_hareketleri'
                ) THEN
                    FOR r IN
                        SELECT c.conname
                        FROM pg_constraint c
                        JOIN pg_class t ON c.conrelid = t.oid
                        WHERE t.relname = 'kart_hareketleri'
                          AND c.contype = 'c'
                          AND pg_get_constraintdef(c.oid) ILIKE '%islem_turu%'
                    LOOP
                        EXECUTE format('ALTER TABLE kart_hareketleri DROP CONSTRAINT IF EXISTS %I', r.conname);
                    END LOOP;
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'kart_hareketleri_islem_turu_check'
                    ) THEN
                        ALTER TABLE kart_hareketleri
                            ADD CONSTRAINT kart_hareketleri_islem_turu_check
                            CHECK (islem_turu IN ('HARCAMA', 'ODEME', 'FAIZ', 'DEVIR'));
                    END IF;
                END IF;
            END $$;
        """)

        # ── ÖDEME PLANI ────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS odeme_plani (
                id              TEXT PRIMARY KEY,
                kart_id         TEXT REFERENCES kartlar(id),
                tarih           DATE NOT NULL,
                referans_ay     DATE,
                odenecek_tutar  NUMERIC(14,2) NOT NULL,
                asgari_tutar    NUMERIC(14,2),
                odenen_tutar    NUMERIC(14,2),
                odeme_tarihi    DATE,
                aciklama        TEXT,
                durum           TEXT NOT NULL DEFAULT 'bekliyor'
                    CHECK (durum IN ('bekliyor','onay_bekliyor','odendi','iptal')),
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_odeme_plani_durum_tarih
            ON odeme_plani (durum, tarih)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_odeme_plani_kart_donem_yardim
            ON odeme_plani (kart_id, referans_ay) WHERE kart_id IS NOT NULL
        """)
        # ── 💳 MÜKERRER KART PLANI FRENİ (2026-08-08, sahip: "kök nedeni kapat")
        # Kart planını birçok yer yazıyor ve korumaları farklı anahtarlara
        # bakıyordu → aynı ekstre 2-6 kez plana düştü (22 fazla satır /
        # 2.326.814 ₺; "EN PARA" aynı gün 6 kayıt). Kod tarafında tek yazıcı
        # kuruldu (kasa_service.kart_plani_upsert); bu blok DB EMNİYET AĞIDIR:
        # hangi üreticiden gelirse gelsin aynı (kart_id, referans_ay) için
        # ikinci aktif satır AÇILAMAZ.
        # SAVEPOINT ile sarılı — ihlal varsa index kurulmaz ama migration ölmez
        # (yutulan SQL hatası dersi: hata sessizce yutulmaz, log'a yazılır).
        cur.execute("""
            UPDATE odeme_plani SET referans_ay = DATE_TRUNC('month', tarih)
            WHERE kart_id IS NOT NULL AND referans_ay IS NULL
        """)
        try:
            cur.execute("SAVEPOINT sp_kart_plan_uniq")
            cur.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS ux_odeme_plani_kart_donem
                ON odeme_plani (kart_id, referans_ay)
                WHERE kart_id IS NOT NULL AND referans_ay IS NOT NULL
                  AND kaynak_tablo IS NULL AND durum <> 'iptal'
            """)
            cur.execute("RELEASE SAVEPOINT sp_kart_plan_uniq")
        except Exception as _e_uniq:  # noqa: BLE001
            cur.execute("ROLLBACK TO SAVEPOINT sp_kart_plan_uniq")
            print(f"[MIGRATION WARN] kart plani tekillik indeksi kurulamadi "
                  f"(mevcut mukerrer kayit var): {str(_e_uniq)[:160]}")
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_odeme_plani_kaynak
            ON odeme_plani (kaynak_tablo, kaynak_id, durum)
        """)
        # 🏪 GERİYE DÖNÜK ŞUBE EKİ (2026-08-08, sahip: "her şubenin farklı olduğu")
        # POS DONANIM ÜCRETİ dört şubede ayrı ayrı tanımlı; plan açıklamasında
        # şube yazmayınca ekranda dört ÖZDEŞ satır görünüyor ve mükerrer
        # sanılıyordu. Yeni planlar şube adıyla üretiliyor (motors._sube_eki);
        # bu blok ESKİ satırları da düzeltir. NOT LIKE koşulu idempotent yapar.
        cur.execute("""
            UPDATE odeme_plani op
               SET aciklama = op.aciklama || ' (' || s.ad || ')'
              FROM sabit_giderler sg
              JOIN subeler s ON s.id = sg.sube_id
             WHERE op.kaynak_tablo = 'sabit_giderler'
               AND op.kaynak_id = sg.id
               AND COALESCE(op.durum,'') <> 'iptal'
               AND COALESCE(op.aciklama,'') <> ''
               AND op.aciklama NOT LIKE '%(' || s.ad || ')%'
               AND EXISTS (SELECT 1 FROM sabit_giderler x
                           WHERE x.gider_adi = sg.gider_adi AND x.id <> sg.id)
        """)
        # Migration: production DB'de eski constraint varsa düşür, yenisini ekle
        cur.execute("""
            DO $$
            BEGIN
                -- Eski constraint adlarını temizle (isim farklı olabilir)
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'odeme_plani_durum_check')
                THEN ALTER TABLE odeme_plani DROP CONSTRAINT odeme_plani_durum_check; END IF;
                -- Yeni constraint: onay_bekliyor dahil
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'odeme_plani_durum_check2')
                THEN
                    ALTER TABLE odeme_plani ADD CONSTRAINT odeme_plani_durum_check2
                    CHECK (durum IN ('bekliyor','onay_bekliyor','odendi','iptal'));
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        # Migration: odeme_yontemi kolonu kasa_hareketleri'ne ekle
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='kasa_hareketleri' AND column_name='odeme_yontemi'
                ) THEN
                    ALTER TABLE kasa_hareketleri ADD COLUMN odeme_yontemi TEXT DEFAULT 'nakit';
                END IF;
            END $$;
        """)

        # Migration: mevcut tabloya eksik kolonları ekle
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='odeme_plani' AND column_name='odenen_tutar')
                THEN ALTER TABLE odeme_plani ADD COLUMN odenen_tutar NUMERIC(14,2); END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='odeme_plani' AND column_name='odeme_tarihi')
                THEN ALTER TABLE odeme_plani ADD COLUMN odeme_tarihi DATE; END IF;
                -- kart_id nullable yap (sabit gider, personel ödemeleri için)
                ALTER TABLE odeme_plani ALTER COLUMN kart_id DROP NOT NULL;
                -- kaynak bağlantısı ekle (CFO model)
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='odeme_plani' AND column_name='kaynak_tablo')
                THEN ALTER TABLE odeme_plani ADD COLUMN kaynak_tablo TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='odeme_plani' AND column_name='kaynak_id')
                THEN ALTER TABLE odeme_plani ADD COLUMN kaynak_id TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='odeme_plani' AND column_name='referans_ay')
                THEN ALTER TABLE odeme_plani ADD COLUMN referans_ay DATE; END IF;
                -- İptal kayıtları koruması — durum değiştirilemez
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'chk_iptal_kayit_korunur'
                ) THEN
                    ALTER TABLE kasa_hareketleri
                    ADD CONSTRAINT chk_iptal_kayit_korunur
                    CHECK (islem_turu NOT LIKE '%IPTAL%' OR durum = 'aktif');
                END IF;
                -- kasa_etkisi kolonu (kritik — eksikse INSERT patlar)
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='kasa_hareketleri' AND column_name='kasa_etkisi')
                THEN
                    ALTER TABLE kasa_hareketleri ADD COLUMN kasa_etkisi BOOLEAN NOT NULL DEFAULT true;
                    UPDATE kasa_hareketleri SET kasa_etkisi = false WHERE islem_turu = 'DEVIR';
                END IF;
                -- sabit gider sözleşme alanları (Kira/Abonelik)
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sabit_giderler' AND column_name='sozlesme_sure_ay')
                THEN ALTER TABLE sabit_giderler ADD COLUMN sozlesme_sure_ay INTEGER; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sabit_giderler' AND column_name='kira_artis_periyot')
                THEN ALTER TABLE sabit_giderler ADD COLUMN kira_artis_periyot TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sabit_giderler' AND column_name='kira_artis_tarihi')
                THEN ALTER TABLE sabit_giderler ADD COLUMN kira_artis_tarihi DATE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sabit_giderler' AND column_name='sozlesme_bitis_tarihi')
                THEN ALTER TABLE sabit_giderler ADD COLUMN sozlesme_bitis_tarihi DATE; END IF;
                -- tip: 'sabit' = tutar belli, her ay odeme_plani uretir
                --      'degisken' = tutar sonradan belli, sadece hatirlatma, kasa etkilenmez
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sabit_giderler' AND column_name='tip')
                THEN ALTER TABLE sabit_giderler ADD COLUMN tip TEXT NOT NULL DEFAULT 'sabit'; END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        # Migration: odeme_plani mükerrer engeli (FAZ 0 #2 — çift ödeme riski)
        # Aynı kaynak (personel/kira/borç) + aynı ay için yalnızca 1 AKTİF plan olabilir.
        # İptal kayıtlar serbest (geçmiş silinmez). kart_id'siz kart planları (kaynak_id NULL) etkilenmez.
        # GÜVENLİK: aktif mükerrer varsa index KURULMAZ (CREATE patlamasın) — sadece NOTICE.
        cur.execute("""
            DO $$
            DECLARE
                dup_count INTEGER;
            BEGIN
                SELECT COUNT(*) INTO dup_count FROM (
                    SELECT kaynak_tablo, kaynak_id, referans_ay
                    FROM odeme_plani
                    WHERE durum <> 'iptal' AND kaynak_id IS NOT NULL AND referans_ay IS NOT NULL
                    GROUP BY kaynak_tablo, kaynak_id, referans_ay
                    HAVING COUNT(*) > 1
                ) d;

                IF dup_count = 0 THEN
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_odeme_plani_kaynak_ay_aktif
                    ON odeme_plani (kaynak_tablo, kaynak_id, referans_ay)
                    WHERE durum <> 'iptal' AND kaynak_id IS NOT NULL AND referans_ay IS NOT NULL;
                ELSE
                    RAISE NOTICE 'uq_odeme_plani_kaynak_ay_aktif KURULMADI: % aktif mukerrer grup var', dup_count;
                END IF;
            END $$;
        """)

        # ── ONAY KUYRUĞU ───────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS onay_kuyrugu (
                id              TEXT PRIMARY KEY,
                islem_turu      TEXT NOT NULL,
                kaynak_tablo    TEXT NOT NULL,
                kaynak_id       TEXT NOT NULL,
                aciklama        TEXT,
                tutar           NUMERIC(14,2),
                tarih           DATE,
                durum           TEXT NOT NULL DEFAULT 'bekliyor',
                onay_tarihi     TIMESTAMP,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        # Migration: onay_tarihi kolonu (eski kurulumlarda yok)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='onay_kuyrugu' AND column_name='onay_tarihi')
                THEN ALTER TABLE onay_kuyrugu ADD COLUMN onay_tarihi TIMESTAMP; END IF;
            END $$;
        """)
        # CHECK constraint expand (Stripe Expand-Contract pattern)
        # iptal_revize: kasa fark kaynak düzeltme sonrası revize edilen onaylar
        # reddedildi: gelecekte eklenmesi muhtemel red akışı için (forward-compat)
        try:
            cur.execute("SAVEPOINT sp_ok_check_expand")
            cur.execute("ALTER TABLE onay_kuyrugu DROP CONSTRAINT IF EXISTS onay_kuyrugu_durum_check")
            cur.execute("""
                ALTER TABLE onay_kuyrugu
                ADD CONSTRAINT onay_kuyrugu_durum_check
                CHECK (durum IN ('bekliyor','onaylandi','iptal','iptal_revize','reddedildi'))
            """)
            cur.execute("RELEASE SAVEPOINT sp_ok_check_expand")
        except Exception as _e:
            try: cur.execute("ROLLBACK TO SAVEPOINT sp_ok_check_expand")
            except Exception: pass
            print(f"[MIGRATION WARN] onay_kuyrugu_durum_check: {_e}")

        # ── PERSONEL ───────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel (
                id              TEXT PRIMARY KEY,
                ad_soyad        TEXT NOT NULL,
                gorev           TEXT,
                calisma_turu    TEXT NOT NULL DEFAULT 'surekli',
                maas            NUMERIC(14,2) NOT NULL DEFAULT 0,
                saatlik_ucret   NUMERIC(14,2),
                yemek_ucreti    NUMERIC(14,2) NOT NULL DEFAULT 0,
                yol_ucreti      NUMERIC(14,2) NOT NULL DEFAULT 0,
                odeme_gunu      INT NOT NULL DEFAULT 1,
                baslangic_tarihi DATE,
                cikis_tarihi    DATE,
                sube_id         TEXT REFERENCES subeler(id),
                notlar          TEXT,
                aktif           BOOLEAN NOT NULL DEFAULT TRUE,
                include_in_planning BOOLEAN NOT NULL DEFAULT TRUE,
                vardiya_tipi    TEXT,
                vardiya_max_weekly_hours NUMERIC(6,2),
                panel_pin_salt   TEXT,
                panel_pin_hash   TEXT,
                panel_yonetici   BOOLEAN NOT NULL DEFAULT FALSE,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("ALTER TABLE personel ALTER COLUMN odeme_gunu SET DEFAULT 1")
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='include_in_planning')
                THEN ALTER TABLE personel ADD COLUMN include_in_planning BOOLEAN NOT NULL DEFAULT TRUE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_tipi')
                THEN ALTER TABLE personel ADD COLUMN vardiya_tipi TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_max_weekly_hours')
                THEN ALTER TABLE personel ADD COLUMN vardiya_max_weekly_hours NUMERIC(6,2); END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='panel_pin_salt')
                THEN ALTER TABLE personel ADD COLUMN panel_pin_salt TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='panel_pin_hash')
                THEN ALTER TABLE personel ADD COLUMN panel_pin_hash TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='panel_yonetici')
                THEN ALTER TABLE personel ADD COLUMN panel_yonetici BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='telefon')
                THEN ALTER TABLE personel ADD COLUMN telefon TEXT; END IF;
            END $$;
        """)

        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_kasa_gun_acma'
                      AND column_name = 'personel_id'
                ) THEN
                    ALTER TABLE sube_kasa_gun_acma
                    ADD COLUMN personel_id TEXT REFERENCES personel(id);
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                ALTER TABLE sube_kasa_gun_acma
                    DROP CONSTRAINT IF EXISTS sube_kasa_gun_acma_panel_kullanici_id_fkey;
            EXCEPTION WHEN undefined_object THEN NULL;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                ALTER TABLE sube_kasa_gun_acma
                    ALTER COLUMN panel_kullanici_id DROP NOT NULL;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        cur.execute("""
            UPDATE sube_kasa_gun_acma k SET personel_id = u.personel_id
            FROM sube_panel_kullanici u
            WHERE u.id = k.panel_kullanici_id
              AND k.personel_id IS NULL
              AND u.personel_id IS NOT NULL;
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'kapanis_kayit'
                      AND column_name = 'sabahci_personel_id'
                ) THEN
                    ALTER TABLE kapanis_kayit
                    ADD COLUMN sabahci_personel_id TEXT REFERENCES personel(id);
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'kapanis_kayit'
                      AND column_name = 'aksamci_personel_id'
                ) THEN
                    ALTER TABLE kapanis_kayit
                    ADD COLUMN aksamci_personel_id TEXT REFERENCES personel(id);
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'kapanis_kayit'
                      AND column_name = 'meta'
                ) THEN
                    ALTER TABLE kapanis_kayit ADD COLUMN meta JSONB;
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                ALTER TABLE kapanis_kayit DROP CONSTRAINT IF EXISTS kapanis_kayit_kapanisci_id_fkey;
            EXCEPTION WHEN undefined_object THEN NULL;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                ALTER TABLE kapanis_kayit DROP CONSTRAINT IF EXISTS kapanis_kayit_acilisci_id_fkey;
            EXCEPTION WHEN undefined_object THEN NULL;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                ALTER TABLE kapanis_kayit ALTER COLUMN kapanisci_id DROP NOT NULL;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                ALTER TABLE kapanis_kayit ALTER COLUMN acilisci_id DROP NOT NULL;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        cur.execute("""
            ALTER TABLE kapanis_kayit DROP CONSTRAINT IF EXISTS kapanis_kayit_sube_id_tarih_key
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_kapanis_kayit_sube_tarih_olay
            ON kapanis_kayit (sube_id, tarih, olay)
        """)

        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_panel_kullanici'
                      AND column_name = 'personel_id'
                ) THEN
                    ALTER TABLE sube_panel_kullanici
                    ADD COLUMN personel_id TEXT REFERENCES personel(id);
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sube_panel_kullanici'
                      AND column_name = 'yonetici'
                ) THEN
                    ALTER TABLE sube_panel_kullanici
                    ADD COLUMN yonetici BOOLEAN NOT NULL DEFAULT FALSE;
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        # Şubede hiç yönetici yoksa, en eski aktif panel kullanıcısını yönetici yap (tek seferlik denge).
        cur.execute("""
            UPDATE sube_panel_kullanici u SET yonetici = TRUE
            WHERE u.aktif = TRUE
              AND u.id = (
                  SELECT x.id FROM sube_panel_kullanici x
                  WHERE x.sube_id = u.sube_id AND x.aktif = TRUE
                  ORDER BY x.olusturma ASC NULLS LAST
                  LIMIT 1
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sube_panel_kullanici y
                  WHERE y.sube_id = u.sube_id AND y.yonetici = TRUE AND y.aktif = TRUE
              );
        """)


        # ── SABİT GİDERLER ─────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sabit_giderler (
                id              TEXT PRIMARY KEY,
                gider_adi       TEXT NOT NULL,
                kategori        TEXT NOT NULL DEFAULT 'Diğer',
                tutar           NUMERIC(14,2) NOT NULL,
                periyot         TEXT NOT NULL DEFAULT 'aylik',
                odeme_gunu      INT NOT NULL DEFAULT 1,
                baslangic_tarihi DATE,
                sube_id         TEXT REFERENCES subeler(id),
                aktif           BOOLEAN NOT NULL DEFAULT TRUE,
                odeme_yontemi   TEXT NOT NULL DEFAULT 'nakit',
                kart_id         TEXT,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        # Migration: odeme_yontemi ve kart_id (eski kurulumlarda yok)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sabit_giderler' AND column_name='odeme_yontemi')
                THEN ALTER TABLE sabit_giderler ADD COLUMN odeme_yontemi TEXT NOT NULL DEFAULT 'nakit'; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sabit_giderler' AND column_name='kart_id')
                THEN ALTER TABLE sabit_giderler ADD COLUMN kart_id TEXT; END IF;
            END $$;
        """)
        # Migration: periyot CHECK kısıtını genişlet. Eski şema sadece aylik/yillik/haftalik
        # kabul ediyordu → 3aylik/6aylik 'sabit_giderler_periyot_check' ihlali veriyordu.
        # Maliyet hesabı bu periyotları doğru günlüğe çeviriyor; kısıt da izin vermeli.
        cur.execute("""
            DO $$
            BEGIN
                ALTER TABLE sabit_giderler DROP CONSTRAINT IF EXISTS sabit_giderler_periyot_check;
                ALTER TABLE sabit_giderler ADD CONSTRAINT sabit_giderler_periyot_check
                    CHECK (periyot IN ('gunluk','haftalik','aylik','3aylik','6aylik','yillik','1yil'));
            END $$;
        """)

        # ── VADELİ ALIMLAR ─────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vadeli_alimlar (
                id          TEXT PRIMARY KEY,
                aciklama    TEXT NOT NULL,
                tutar       NUMERIC(14,2) NOT NULL,
                vade_tarihi DATE NOT NULL,
                tedarikci   TEXT,
                durum       TEXT NOT NULL DEFAULT 'bekliyor',
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

        # ── BORÇ ENVANTERİ ─────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS borc_envanteri (
                id               TEXT PRIMARY KEY,
                kurum            TEXT NOT NULL,
                borc_turu        TEXT NOT NULL DEFAULT 'Kredi',
                toplam_borc      NUMERIC(14,2),
                aylik_taksit     NUMERIC(14,2) NOT NULL,
                kalan_vade       INT,
                toplam_vade      INT,
                baslangic_tarihi DATE,
                odeme_gunu       INT NOT NULL DEFAULT 1,
                aktif            BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma        TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

        # ── ANLIK GİDERLER ─────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS anlik_giderler (
                id          TEXT PRIMARY KEY,
                tarih       DATE NOT NULL,
                kategori    TEXT NOT NULL,
                tutar       NUMERIC(14,2) NOT NULL,
                aciklama    TEXT,
                sube        TEXT,
                durum       TEXT NOT NULL DEFAULT 'aktif',
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

        # Migration: anlik_giderler'e kaynak_id ve kaynak_tablo ekle
        # Her kolon ayrı kontrol — mevcut kolonlar crash'e yol açmaz
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='kaynak_id')
                THEN ALTER TABLE anlik_giderler ADD COLUMN kaynak_id TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='kaynak_tablo')
                THEN ALTER TABLE anlik_giderler ADD COLUMN kaynak_tablo TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='odeme_yontemi')
                THEN ALTER TABLE anlik_giderler ADD COLUMN odeme_yontemi TEXT DEFAULT 'nakit'; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='kart_id')
                THEN ALTER TABLE anlik_giderler ADD COLUMN kart_id TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='tedarikci')
                THEN ALTER TABLE anlik_giderler ADD COLUMN tedarikci TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='personel_id')
                THEN ALTER TABLE anlik_giderler ADD COLUMN personel_id TEXT; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='fis_gonderildi')
                THEN ALTER TABLE anlik_giderler ADD COLUMN fis_gonderildi BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='fis_kontrol_durumu')
                THEN ALTER TABLE anlik_giderler ADD COLUMN fis_kontrol_durumu TEXT NOT NULL DEFAULT 'bekliyor'; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='fis_kontrol_tarihi')
                THEN ALTER TABLE anlik_giderler ADD COLUMN fis_kontrol_tarihi TIMESTAMPTZ; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='fis_kontrol_notu')
                THEN ALTER TABLE anlik_giderler ADD COLUMN fis_kontrol_notu TEXT; END IF;
            END $$;
        """)

        # ── Defensive: anlik_giderler.sube_id alias kolonu ──
        # Bazı eski deploy'lar veya cache'lenmiş PostgreSQL plan'lar 'sube_id' ister.
        # 'sube' kolonunun jenerik aynası (sadece SELECT için, INSERT için trigger).
        cur.execute("""
            DO $$
            BEGIN
                -- 1) Generated column ekle (sadece tablo varsa ve kolon yoksa)
                IF EXISTS (SELECT 1 FROM information_schema.tables
                           WHERE table_schema='public' AND table_name='anlik_giderler')
                   AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name='anlik_giderler' AND column_name='sube_id')
                THEN
                    BEGIN
                        ALTER TABLE anlik_giderler
                        ADD COLUMN sube_id TEXT GENERATED ALWAYS AS (sube) STORED;
                    EXCEPTION WHEN OTHERS THEN
                        -- Generated column desteklenmiyorsa normal kolon + view yap
                        ALTER TABLE anlik_giderler ADD COLUMN sube_id TEXT;
                        UPDATE anlik_giderler SET sube_id = sube WHERE sube_id IS NULL;
                    END;
                END IF;
            END $$;
        """)
        # sube_id geriye-uyumlu trigger: INSERT/UPDATE'lerde sube ↔ sube_id senkronize
        cur.execute("""
            CREATE OR REPLACE FUNCTION anlik_gider_sube_sync_fn()
            RETURNS trigger AS $$
            BEGIN
                -- INSERT veya UPDATE: hangisi doluysa diğerini doldur
                IF NEW.sube IS NULL AND NEW.sube_id IS NOT NULL THEN
                    NEW.sube := NEW.sube_id;
                ELSIF NEW.sube_id IS NULL AND NEW.sube IS NOT NULL THEN
                    NEW.sube_id := NEW.sube;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        """)
        cur.execute("""
            DO $$
            BEGIN
                -- Generated column ise trigger gereksiz (otomatik senkronize); kontrol et
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='anlik_giderler' AND column_name='sube_id'
                      AND COALESCE(is_generated,'NEVER') = 'NEVER'
                ) THEN
                    DROP TRIGGER IF EXISTS tr_anlik_gider_sube_sync ON anlik_giderler;
                    CREATE TRIGGER tr_anlik_gider_sube_sync
                    BEFORE INSERT OR UPDATE ON anlik_giderler
                    FOR EACH ROW EXECUTE FUNCTION anlik_gider_sube_sync_fn();
                END IF;
            END $$;
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='anlik_giderler'
                      AND column_name='fis_kontrol_durumu'
                ) THEN
                    BEGIN
                        ALTER TABLE anlik_giderler
                        ADD CONSTRAINT chk_anlik_gider_fis_kontrol
                        CHECK (fis_kontrol_durumu IN ('bekliyor','geldi','gelmedi','muaf'));
                    EXCEPTION WHEN duplicate_object THEN
                        NULL;
                    END;
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        # ── PERSONEL RİSK SİNYAL ───────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_risk_sinyal (
                id            TEXT PRIMARY KEY,
                personel_id   TEXT NOT NULL,
                sube_id       TEXT,
                tarih         DATE NOT NULL DEFAULT CURRENT_DATE,
                sinyal_turu   TEXT NOT NULL,
                agirlik       INT NOT NULL DEFAULT 0,
                aciklama      TEXT,
                referans_id   TEXT,
                olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_prs_personel_tarih
            ON personel_risk_sinyal (personel_id, tarih DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_prs_sube_tarih
            ON personel_risk_sinyal (sube_id, tarih DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_prs_tur_tarih
            ON personel_risk_sinyal (sinyal_turu, tarih DESC)
        """)

        # ── AKILLI DENETİM — HİPOTEZ GÖZLEM DEFTERİ ─────────────
        # Motorun "insan denetçi gibi öğrenmesi" için ham gözlem tablosu.
        # Her operasyonel olay tipi (geç açılış, geç kapanış, sık iptal,
        # vardiya devamsızlığı) için (KOŞUL, SONUÇ) çiftini HAM kaydeder —
        # eşik uygulamaz, yorum yapmaz, istatistik çıkarmaz. Yeterli veri
        # birikince (≥~25 olay, ~2-3 ay) ayrı bir katman lift/oran analizi
        # yapacak. Şimdilik SADECE veri toplama. (bkz. truth_motor.py
        # hipotez_gozlem_kaydet + project_akilli_denetim_olay_yelpazesi)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS denetim_hipotez_gozlem (
                id             TEXT PRIMARY KEY,
                hipotez_turu   TEXT NOT NULL,          -- 'gec_acilis' | 'gec_kapanis' | ...
                sube_id        TEXT NOT NULL,
                tarih          DATE NOT NULL,
                boyut          TEXT,                   -- kasa/bardak_karton/... (varsa)
                kosul_var      BOOLEAN NOT NULL,       -- olay gerçekleşti mi?
                kosul_siddet   DOUBLE PRECISION,       -- ham büyüklük (örn. gecikme dk) — EŞİK UYGULANMAZ
                sonuc_anomali  BOOLEAN NOT NULL,       -- o gün ilgili anomali çıktı mı?
                sonuc_tani     TEXT,                   -- hangi tanı (varsa)
                personel_id    TEXT,                   -- ilgili personel (varsa)
                detay_json     JSONB DEFAULT '{}'::jsonb,
                referans_id    TEXT UNIQUE,            -- idempotent: tm:hipotez:<tur>:<sube>:<tarih>:<boyut>
                olusturma      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_dhg_tur_sube_tarih
            ON denetim_hipotez_gozlem (hipotez_turu, sube_id, tarih DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_dhg_tur_kosul
            ON denetim_hipotez_gozlem (hipotez_turu, kosul_var, sonuc_anomali)
        """)

        # ── SİPARİŞ DAVRANIŞ PROFİLİ (Katman 3 — türetilmiş kayıt) ──────────
        # "Kayıt katmanı": şube başına sipariş davranışının günlük ham profili.
        # DENETİM/hipotez DEĞİL (o Katman 4 = denetim_hipotez_gozlem); bu sadece
        # türetilmiş, yeniden üretilebilir profil — Prediction Brain'i ve ileride
        # sipariş-davranışı denetimini besler. (bkz. project_tedarik_zinciri +
        # project_akilli_denetim_olay_yelpazesi "Sipariş Davranışı Denetimi" duyusu)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_siparis_davranis_gunluk (
                id              TEXT PRIMARY KEY,
                sube_id         TEXT NOT NULL,
                tarih           DATE NOT NULL,
                pencere_gun     INT NOT NULL DEFAULT 7,
                siparis_sayisi  INT NOT NULL DEFAULT 0,   -- pencere içi sipariş adedi (iptal hariç)
                aktif_gun       INT NOT NULL DEFAULT 0,    -- kaç ayrı günde sipariş verdi
                detay_json      JSONB DEFAULT '{}'::jsonb, -- ileride: stok/satış/kullanım bağlamı
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (sube_id, tarih)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_ssdg_sube_tarih
            ON sube_siparis_davranis_gunluk (sube_id, tarih DESC)
        """)

        # ── PERSONEL TAKİP ─────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_takip (
                personel_id       TEXT PRIMARY KEY,
                takip_baslangic   DATE NOT NULL DEFAULT CURRENT_DATE,
                takip_seviyesi    TEXT NOT NULL DEFAULT 'izlemede'
                    CHECK (takip_seviyesi IN ('izlemede','uyari','kritik')),
                tetikleyen_sinyal TEXT,
                notlar            TEXT,
                guncelleme        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

        # ── KASA TESLİM (alıcı tanımı + hareket) ───────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kasa_teslim_alici (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                ad          TEXT NOT NULL,
                unvan       TEXT,
                sube_id     TEXT REFERENCES subeler(id) ON DELETE CASCADE,
                aktif       BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kasa_teslim_alici_sube
            ON kasa_teslim_alici (sube_id, aktif)
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS kasa_teslim (
                id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id                 TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                tarih                   DATE NOT NULL DEFAULT CURRENT_DATE,
                tutar                   NUMERIC(14,2) NOT NULL CHECK (tutar > 0),
                teslim_eden_personel_id TEXT,
                teslim_eden_ad          TEXT,
                teslim_alan_id          TEXT REFERENCES kasa_teslim_alici(id),
                teslim_alan_ad          TEXT,
                teslim_turu             TEXT NOT NULL DEFAULT 'ara',
                aciklama                TEXT,
                olusturma               TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kasa_teslim_sube_tarih
            ON kasa_teslim (sube_id, tarih DESC, olusturma DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kasa_teslim_tarih
            ON kasa_teslim (tarih DESC, olusturma DESC)
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_merkez_not (
                id           TEXT PRIMARY KEY,
                sube_id      TEXT NOT NULL,
                metin        TEXT NOT NULL,
                personel_id  TEXT,
                personel_ad  TEXT,
                olusturma    TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet'
                ) THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet' AND column_name = 'acilis_gercek_ts'
                    ) THEN
                        ALTER TABLE sube_operasyon_ozet ADD COLUMN acilis_gercek_ts TIMESTAMPTZ;
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet' AND column_name = 'kontrol_gecikme_dk'
                    ) THEN
                        ALTER TABLE sube_operasyon_ozet ADD COLUMN kontrol_gecikme_dk INT NOT NULL DEFAULT 0;
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet' AND column_name = 'vardiya_devri_durum'
                    ) THEN
                        ALTER TABLE sube_operasyon_ozet ADD COLUMN vardiya_devri_durum TEXT;
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet' AND column_name = 'satis_tahmini_toplam'
                    ) THEN
                        ALTER TABLE sube_operasyon_ozet ADD COLUMN satis_tahmini_toplam INT NOT NULL DEFAULT 0;
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet' AND column_name = 'satis_tahmini_kalemler'
                    ) THEN
                        ALTER TABLE sube_operasyon_ozet ADD COLUMN satis_tahmini_kalemler JSONB NOT NULL DEFAULT '{}'::jsonb;
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet' AND column_name = 'olusturma'
                    ) THEN
                        ALTER TABLE sube_operasyon_ozet ADD COLUMN olusturma TIMESTAMPTZ NOT NULL DEFAULT NOW();
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'sube_operasyon_ozet' AND column_name = 'guncelleme'
                    ) THEN
                        ALTER TABLE sube_operasyon_ozet ADD COLUMN guncelleme TIMESTAMPTZ NOT NULL DEFAULT NOW();
                    END IF;
                END IF;
            END $$;
        """)

        # ── MERKEZ → ŞUBE PUSH MESAJI ─────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_merkez_mesaj (
                id                  TEXT PRIMARY KEY,
                sube_id             TEXT NOT NULL,
                mesaj               TEXT NOT NULL,
                oncelik             VARCHAR(20) NOT NULL DEFAULT 'normal',
                okundu              BOOLEAN NOT NULL DEFAULT FALSE,
                okundu_ts           TIMESTAMPTZ,
                okuyan_personel_id  TEXT,
                aktif               BOOLEAN NOT NULL DEFAULT TRUE,
                ttl_saat            INT NOT NULL DEFAULT 72,
                olusturma           TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_merkez_mesaj_sube
            ON sube_merkez_mesaj (sube_id, aktif, okundu)
        """)
        cur.execute("""
            ALTER TABLE sube_merkez_mesaj
            ADD COLUMN IF NOT EXISTS ttl_saat INT NOT NULL DEFAULT 72
        """)

        # ── TEDARİKÇİLER ──────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS tedarikciler (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                ad          TEXT NOT NULL,
                kategori    TEXT,
                telefon     TEXT,
                aciklama    TEXT,
                aktif       BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tedarikciler_ad
            ON tedarikciler (LOWER(TRIM(ad)))
            WHERE aktif = TRUE
        """)

        # ── MERKEZİ SİPARİŞ KATALOĞU (ŞUBE PANELİ) ─────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS siparis_kategori (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                kod         TEXT NOT NULL UNIQUE,
                ad          TEXT NOT NULL,
                emoji       TEXT,
                sira        INT NOT NULL DEFAULT 0,
                aktif       BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                guncelleme  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS siparis_urun (
                id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                kategori_id  TEXT NOT NULL REFERENCES siparis_kategori(id) ON DELETE CASCADE,
                ad           TEXT NOT NULL,
                norm_ad      TEXT NOT NULL,
                sira         INT NOT NULL DEFAULT 0,
                birim_fiyat_tl NUMERIC(12,2),
                aktif        BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                guncelleme   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (kategori_id, norm_ad)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_urun_kategori
            ON siparis_urun (kategori_id, aktif, sira, ad)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS siparis_talep (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                tarih           DATE NOT NULL DEFAULT CURRENT_DATE,
                durum           TEXT NOT NULL DEFAULT 'bekliyor',
                personel_id     TEXT,
                personel_ad     TEXT,
                bildirim_saati  TEXT,
                not_aciklama    TEXT,
                kalemler        JSONB NOT NULL DEFAULT '[]'::jsonb,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_talep_sube_tarih
            ON siparis_talep (sube_id, tarih, olusturma DESC)
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_urun'
                      AND column_name = 'birim_fiyat_tl'
                ) THEN
                    ALTER TABLE siparis_urun ADD COLUMN birim_fiyat_tl NUMERIC(12,2);
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_urun'
                      AND column_name = 'depo_stok_kalem_kodu'
                ) THEN
                    ALTER TABLE siparis_urun ADD COLUMN depo_stok_kalem_kodu TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_urun'
                      AND column_name = 'aciklama'
                ) THEN
                    ALTER TABLE siparis_urun ADD COLUMN aciklama TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_urun'
                      AND column_name = 'dusum_modu'
                ) THEN
                    ALTER TABLE siparis_urun ADD COLUMN dusum_modu TEXT NOT NULL DEFAULT 'acilinca';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'subeler'
                      AND column_name = 'sube_tipi'
                ) THEN
                    ALTER TABLE subeler ADD COLUMN sube_tipi TEXT NOT NULL DEFAULT 'normal';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'hedef_depo_sube_id'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN hedef_depo_sube_id TEXT REFERENCES subeler(id) ON DELETE SET NULL;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'sevkiyat_sube_id'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN sevkiyat_sube_id TEXT REFERENCES subeler(id) ON DELETE SET NULL;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'sevkiyat_durum'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN sevkiyat_durum TEXT NOT NULL DEFAULT 'bekliyor';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'sevkiyat_durumu'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN sevkiyat_durumu TEXT NOT NULL DEFAULT 'bekliyor';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'sevkiyat_notlari'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN sevkiyat_notlari TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'sevkiyat_notu'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN sevkiyat_notu TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'sevkiyat_ts'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN sevkiyat_ts TIMESTAMPTZ;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'sevkiyat_personel_ad'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN sevkiyat_personel_ad TEXT;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'kalem_durumlari'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN kalem_durumlari JSONB NOT NULL DEFAULT '[]'::jsonb;
                END IF;
                -- N2 (merkez kararı): toptancıya yönlendirirken ops'un belirlediği
                -- miktar. N1 (kalemler/kalemler_ozet) ASLA ezilmez — bu AYRI alan.
                -- (bkz. project_tedarik_zinciri: procurement_line / N1≠N2 ayrımı)
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'siparis_talep'
                      AND column_name = 'merkez_karar_kalemleri'
                ) THEN
                    ALTER TABLE siparis_talep ADD COLUMN merkez_karar_kalemleri JSONB;
                END IF;
                -- N4 (şube kabulü): kabul ekranı 'Teslim Al ve Kaydet' bu kolonlara
                -- yazar (kabul_durum: kabul_tam|kabul_uyusmazlik|kabul_kismi, kim/ne
                -- zaman kabul etti); operasyon_merkez + kontrol kulesi okur. Kolonlar
                -- tasarlanmış ama migration eksikti → UndefinedColumn (fix 2026-06-16).
                ALTER TABLE siparis_talep ADD COLUMN IF NOT EXISTS kabul_durum TEXT;
                ALTER TABLE siparis_talep ADD COLUMN IF NOT EXISTS kabul_ts TIMESTAMPTZ;
                ALTER TABLE siparis_talep ADD COLUMN IF NOT EXISTS kabul_personel_id TEXT;
                ALTER TABLE siparis_talep ADD COLUMN IF NOT EXISTS kabul_personel_ad TEXT;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        # ── TOPTANCI SİPARİŞİ (procurement_line) ───────────────────────────
        # Her "toptancıya yolla" aksiyonu = bir tedarikçiye giden bir gönderim.
        # Tek talep birden fazla tedarikçiye bölünebilir (kategori-split) →
        # talep başına N satır. kalemler = O TEDARİKÇİYE giden N2 (merkez kararı).
        # siparis_talep.merkez_karar_kalemleri tüm satırların AGGREGATE'i kalır
        # (eski kabul/karşılaştırma akışı bozulmasın). N1 (kalemler_ozet) hiç
        # ezilmez. (bkz. project_tedarik_zinciri: procurement_line, god-object'i kır)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS toptanci_siparis (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                talep_id        TEXT NOT NULL REFERENCES siparis_talep(id) ON DELETE CASCADE,
                sube_id         TEXT,
                tedarikci_id    TEXT REFERENCES tedarikciler(id),
                tedarikci_ad    TEXT,
                tedarikci_tel   TEXT,
                kalemler        JSONB NOT NULL DEFAULT '[]'::jsonb,
                not_aciklama    TEXT,
                durum           TEXT NOT NULL DEFAULT 'gonderildi',
                wa_gonderim_ts  TIMESTAMPTZ,
                wa_mesaj_id     TEXT,
                wa_chat_id      TEXT,
                wa_durum        TEXT,
                olusturan_ad    TEXT,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                teslim_ts       TIMESTAMPTZ
            )
        """)
        # İZOLE: Merkez (patron/cep) kaynaklı sipariş ayrımı — 'sube' | 'merkez'.
        # Şube panelinde "Merkez Siparişi" rozeti için. Kaldırmak istersek zararsız.
        cur.execute("ALTER TABLE toptanci_siparis ADD COLUMN IF NOT EXISTS kaynak TEXT NOT NULL DEFAULT 'sube'")

        # ── 💸 VADELİ ALIM: ÖDEME TARİHİ (2026-08-09, mali denetim) ──────────
        # Tabloda yalnız `vade_tarihi` vardı; ödendiğinde durum='odendi' oluyor
        # ama NE ZAMAN ödendiği hiçbir yere yazılmıyordu. Cari ekstre bu yüzden
        # vade tarihini ÖDEME tarihi sanıyordu:
        #   · erken ödenen → olduğundan geç görünür
        #   · GELECEK vadeli "ödendi" → ödeme İLERİ TARİHTE görünür ve borçtan
        #     bugünden düşülür (redbull 21.315,57 ₺ · vade 10.08 · para çıkmamış)
        # Geriye dönük dolgu odeme_plani'nden gelir — orada gerçek ödeme tarihi
        # zaten tutuluyordu; iki tablo aynı gerçeği söylemeliydi.
        # ── 🏪 ŞUBE KASASI (2026-08-09, sahip: "her şubenin kasası var banka
        # hesabı var; ödeme çıkışları hangi şubenin kasasından çıktığı belli
        # olsun, merkez kasa bu kasaların toplamı olsun")
        # kasa_hareketleri TEK merkez kasaydı — çıkışın hangi şubeden olduğu
        # hiçbir yerde yoktu. sube_id ekleniyor; NULL = merkez/atanmamış.
        # Geriye dönük dolgu kaynak tablodan gelir (kaynak_tablo + kaynak_id
        # zaten kanonik bağ). ⚠️ anlik_giderler'de kolon adı `sube`, sabit
        # giderlerde `sube_id` — ikisi de ID ya da AD tutabiliyor, o yüzden
        # eşleştirme çift yönlü (id = değer OR ad = değer).
        cur.execute("ALTER TABLE kasa_hareketleri ADD COLUMN IF NOT EXISTS sube_id TEXT")
        cur.execute("""CREATE INDEX IF NOT EXISTS idx_kasa_hareket_sube
                       ON kasa_hareketleri (sube_id, tarih)""")
        for _kt, _tbl, _kol in (("ciro", "ciro", "sube_id"),
                                ("anlik_giderler", "anlik_giderler", "sube"),
                                ("sabit_giderler", "sabit_giderler", "sube_id"),
                                ("borc_envanteri", "borc_envanteri", "sube")):
            # ⚠️ SAVEPOINT ŞART: PostgreSQL'de bir hata transaction'ı ABORT eder;
            # try/except hatayı yutar ama transaction bozuk kalır ve SONRAKİ
            # bütün migration adımları patlar (uygulama hiç açılmaz). Bu ders
            # daha önce de alınmıştı — savepoint'siz "hata-yutar" bir yalandır.
            try:
                cur.execute("SAVEPOINT sp_kasa_sube")
                cur.execute(f"""
                    UPDATE kasa_hareketleri kh
                       SET sube_id = s.id
                      FROM {_tbl} t
                      JOIN subeler s
                        ON s.id::text = t.{_kol}::text
                        OR UPPER(s.ad) = UPPER(t.{_kol}::text)
                     WHERE kh.kaynak_tablo = %s
                       AND kh.kaynak_id::text = t.id::text
                       AND kh.sube_id IS NULL
                """, (_kt,))
                _n = cur.rowcount
                cur.execute("RELEASE SAVEPOINT sp_kasa_sube")
                if _n:
                    logging.getLogger(__name__).info(
                        "kasa_hareketleri.sube_id dolduruldu (%s): %s satir", _kt, _n)
            except Exception as _e:  # noqa: BLE001 — bir kaynak patlarsa ötekiler sürsün
                try:
                    cur.execute("ROLLBACK TO SAVEPOINT sp_kasa_sube")
                    cur.execute("RELEASE SAVEPOINT sp_kasa_sube")
                except Exception:  # noqa: BLE001
                    pass
                logging.getLogger(__name__).warning(
                    "kasa sube_id dolgusu atlandi (%s): %s", _kt, str(_e)[:110])

        cur.execute("ALTER TABLE vadeli_alimlar ADD COLUMN IF NOT EXISTS odeme_tarihi DATE")
        try:
            cur.execute("SAVEPOINT sp_vadeli_ot")   # bkz. yukarıdaki SAVEPOINT notu
            cur.execute("""
                UPDATE vadeli_alimlar v SET odeme_tarihi = p.odeme_tarihi
                  FROM odeme_plani p
                 WHERE p.kaynak_tablo = 'vadeli_alimlar'
                   AND p.kaynak_id::text = v.id::text
                   AND p.odeme_tarihi IS NOT NULL
                   AND v.durum = 'odendi'
                   AND v.odeme_tarihi IS NULL
            """)
            _n = cur.rowcount
            cur.execute("RELEASE SAVEPOINT sp_vadeli_ot")
            if _n:
                logging.getLogger(__name__).info(
                    "vadeli_alimlar.odeme_tarihi geriye donuk dolduruldu: %s satir", _n)
        except Exception as _e:  # noqa: BLE001 — dolgu başarısızsa şema yine kurulur
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_vadeli_ot")
                cur.execute("RELEASE SAVEPOINT sp_vadeli_ot")
            except Exception:  # noqa: BLE001
                pass
            logging.getLogger(__name__).warning(
                "vadeli odeme_tarihi dolgusu atlandi: %s", str(_e)[:120])
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_toptanci_siparis_talep
            ON toptanci_siparis (talep_id)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_toptanci_siparis_sube_durum
            ON toptanci_siparis (sube_id, durum)
        """)
        cur.execute("""
            UPDATE subeler
            SET sube_tipi = CASE
                WHEN id = 'sube-merkez' THEN 'karma'
                WHEN COALESCE(NULLIF(TRIM(sube_tipi), ''), 'normal') = 'sevkiyat' THEN 'depo'
                WHEN COALESCE(NULLIF(TRIM(sube_tipi), ''), 'normal') = 'merkez' THEN 'karma'
                ELSE COALESCE(NULLIF(TRIM(sube_tipi), ''), 'normal')
            END
            WHERE COALESCE(TRIM(sube_tipi), '') IN ('', 'sevkiyat', 'merkez');
        """)
        cur.execute("""
            UPDATE siparis_talep
            SET hedef_depo_sube_id = COALESCE(hedef_depo_sube_id, sevkiyat_sube_id),
                sevkiyat_durumu = COALESCE(NULLIF(TRIM(sevkiyat_durumu), ''), sevkiyat_durum, 'bekliyor'),
                sevkiyat_notu = COALESCE(NULLIF(TRIM(sevkiyat_notu), ''), sevkiyat_notlari),
                sevkiyat_notlari = COALESCE(NULLIF(TRIM(sevkiyat_notlari), ''), sevkiyat_notu),
                sevkiyat_sube_id = COALESCE(sevkiyat_sube_id, hedef_depo_sube_id)
            WHERE TRUE;
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_tipi_aktif
            ON subeler (sube_tipi, aktif)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_talep_sevkiyat
            ON siparis_talep (hedef_depo_sube_id, sevkiyat_durumu, tarih, olusturma DESC)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS siparis_ozel_talep (
                id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id             TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                tarih               DATE NOT NULL DEFAULT CURRENT_DATE,
                urun_adi            TEXT NOT NULL,
                kategori_kod        TEXT NOT NULL,
                adet                INT NOT NULL DEFAULT 1,
                not_aciklama        TEXT,
                personel_id         TEXT,
                personel_ad         TEXT,
                bildirim_saati      TEXT,
                durum               TEXT NOT NULL DEFAULT 'bekliyor',
                onaylayan_not       TEXT,
                olusturulan_urun_id TEXT REFERENCES siparis_urun(id) ON DELETE SET NULL,
                iliskili_talep_id   TEXT,
                olusturma           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                islem_ts            TIMESTAMPTZ
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_ozel_sube_durum
            ON siparis_ozel_talep (sube_id, durum, olusturma DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_ozel_bekleyen
            ON siparis_ozel_talep (durum, olusturma DESC)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS siparis_sevk_eksik (
                id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id               TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                tarih                 DATE NOT NULL DEFAULT CURRENT_DATE,
                tedarikci_id          TEXT REFERENCES tedarikciler(id) ON DELETE SET NULL,
                tedarikci_ad          TEXT,
                teslim_durumu         TEXT NOT NULL DEFAULT 'tam_geldi',
                eksik_kategori        TEXT,
                eksik_aciklama        TEXT,
                siparis_talep_id      TEXT REFERENCES siparis_talep(id) ON DELETE SET NULL,
                siparis_personel_id   TEXT,
                siparis_personel_ad   TEXT,
                bildiren_personel_id  TEXT,
                bildiren_personel_ad  TEXT,
                olusturma             TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_sevk_eksik_sube_tarih
            ON siparis_sevk_eksik (sube_id, tarih, olusturma DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_sevk_eksik_tarih
            ON siparis_sevk_eksik (tarih, olusturma DESC)
        """)
        cur.execute("""
            INSERT INTO siparis_kategori (kod, ad, emoji, sira)
            VALUES
                ('kahve', 'Kahveler', '☕', 10),
                ('sut', 'Sütler', '🥛', 15),
                ('surup', 'Şuruplar', '🍯', 20),
                ('sos', 'Soslar', '🍫', 30),
                ('toz', 'Tozlar', '🥄', 40),
                ('pure', 'Püreler', '🍓', 50),
                ('icecek', 'İçecekler', '🥤', 60),
                ('temizlik', 'Temizlik', '🧼', 70),
                ('sarf', 'Sarf Malzemeler', '📦', 80),
                ('bitki_cayi', 'Bitki Çayları', '🌿', 90),
                ('pasta', 'Pastalar', '🎂', 95)
            ON CONFLICT (kod) DO UPDATE
            SET ad = EXCLUDED.ad, emoji = EXCLUDED.emoji, sira = EXCLUDED.sira
        """)
        cur.execute("""
            INSERT INTO siparis_urun (kategori_id, ad, norm_ad, sira)
            SELECT k.id, v.ad, v.norm_ad, v.sira
            FROM (
                VALUES
                    ('kahve','Espresso','espresso',10),('kahve','Filtre Kahve','filtre_kahve',20),('kahve','Granül Kahve','granul_kahve',30),('kahve','Türk Kahvesi','turk_kahvesi',40),('kahve','Dibek Kahvesi','dibek_kahvesi',50),('kahve','Menengiç Kahvesi','menengic_kahvesi',60),
                    ('sut','Tam Yağlı Süt','tam_yagli_sut',10),('sut','Yarım Yağlı Süt','yarim_yagli_sut',20),('sut','Yağsız Süt','yagsiz_sut',30),('sut','Laktozsuz Süt','laktozsuz_sut',40),('sut','Badem Sütü','badem_sutu',50),('sut','Soya Sütü','soya_sutu',60),('sut','Yulaf Sütü','yulaf_sutu',70),('sut','Hindistan Cevizi Sütü','hindistan_cevizi_sutu',80),('sut','Fındık Sütü','findik_sutu',90),
                    ('surup','Turunç','turunc',10),('surup','Bahçe Nane','bahce_nane',20),('surup','Böğürtlen','bogurtlen',30),('surup','Lime','lime',40),('surup','Çilek','cilek',50),('surup','Yeşil Elma','yesil_elma',60),('surup','Yaban Mersini','yaban_mersini',70),('surup','Ananas','ananas',80),('surup','Kivi','kivi',90),('surup','Cookie','cookie',100),('surup','Frambuaz','frambuaz',110),('surup','Muz','muz',120),('surup','Kavun','kavun',130),('surup','Irish Cream','irish_cream',140),('surup','Toffee Nut','toffee_nut',150),('surup','Vanilya','vanilya',160),('surup','Salted Karamel','salted_karamel',170),('surup','Pumpkin','pumpkin',180),
                    ('sos','Çikolata Sos','cikolata_sos',10),('sos','Beyaz Çikolata Sos','beyaz_cikolata_sos',20),('sos','Karamel Sos','karamel_sos',30),
                    ('toz','Çilek Tozu','cilek_tozu',10),('toz','Muz Tozu','muz_tozu',20),('toz','Orman Meyveli Toz','orman_meyveli_toz',30),('toz','Vanilya Toz','vanilya_toz',40),('toz','Çikolata Toz','cikolata_toz',50),('toz','Sıcak Çikolata','sicak_cikolata',60),('toz','Beyaz Sıcak Çikolata','beyaz_sicak_cikolata',70),('toz','Salep','salep',80),
                    ('pure','Çilek','cilek',10),('pure','Muz','muz',20),('pure','Orman Meyvesi','orman_meyvesi',30),('pure','Frambuaz','frambuaz',40),('pure','Karpuz','karpuz',50),('pure','Mango','mango',60),('pure','Kavun','kavun',70),('pure','Ananas','ananas',80),('pure','Ejder Meyvesi','ejder_meyvesi',90),
                    ('icecek','Redbull','redbull',10),('icecek','Portakal Suyu','portakal_suyu',20),('icecek','Ananas Suyu','ananas_suyu',30),('icecek','Sprite','sprite',40),('icecek','Power Up','power_up',50),('icecek','Limonata','limonata',60),('icecek','Su','su',70),('icecek','Bardak Su','bardak_su',80),('icecek','Sade Maden Suyu','sade_maden_suyu',90),('icecek','Limon Maden Suyu','limon_maden_suyu',100),('icecek','Çilek Maden Suyu','cilek_maden_suyu',110),('icecek','Elma Maden Suyu','elma_maden_suyu',120),
                    ('temizlik','Köpük Sabun','kopuk_sabun',10),('temizlik','Sıvı Sabun','sivi_sabun',20),('temizlik','Yüzey Temizleyici','yuzey_temizleyici',30),('temizlik','Z Peçete','z_pecete',40),('temizlik','Tuvalet Kağıdı','tuvalet_kagidi',50),('temizlik','Oda Parfümü','oda_parfumu',60),('temizlik','Eldiven','eldiven',70),('temizlik','Sarı Güç','sari_guc',80),('temizlik','Porçöz','porcoz',90),('temizlik','Çöp Poşeti','cop_poseti',100),
                    ('sarf','Plastik Bardak','plastik_bardak',5),('sarf','14oz Bardak','14oz_bardak',10),('sarf','8oz Bardak','8oz_bardak',15),('sarf','Pipet','pipet',20),('sarf','POS Kağıdı','pos_kagidi',30),('sarf','Kalem','kalem',40),('sarf','Filtre Kağıdı','filtre_kagidi',50),('sarf','Dido Trio','dido_trio',80),('sarf','Oreo','oreo',90),('sarf','Kese Kağıdı','kese_kagidi',100),('sarf','Streç Film','strec_film',110),('sarf','Baskılı Peçete','baskili_pecete',120),('sarf','Baskılı Şeker','baskili_seker',130),('sarf','Bardak Çantası','bardak_cantasi',140),('sarf','Islak Mendil','islak_mendil',150),('sarf','Cam Bezi','cam_bezi',160),('sarf','Zımba Teli','zimba_teli',170),('sarf','Ahşap Karıştırıcı','ahsap_karistirici',180),
                    ('bitki_cayi','Papatya','papatya',10),('bitki_cayi','Kış Çayı','kis_cayi',20),('bitki_cayi','Yeşil Çay','yesil_cay',30),('bitki_cayi','Melisa','melisa',40),('bitki_cayi','Ihlamur','ihlamur',50),
                    ('pasta','San Sebastian (Porsiyon)','pasta_porsiyon_sade',10),
                    ('pasta','Antep Fıstıklı San Sebastian (Porsiyon)','pasta_porsiyon_antep',20),
                    ('pasta','Çikolatalı San Sebastian (Porsiyon)','pasta_porsiyon_cik',30),
                    ('pasta','Magnolya Çilekli','pasta_mag_cilek',40),
                    ('pasta','Magnolya Lotuslu','pasta_mag_lotus',50),
                    ('pasta','Büyük Tart','pasta_buyuk_tart',60),
                    ('pasta','Küçük Tart','pasta_kucuk_tart',70),
                    ('pasta','Snickers','pasta_snickers',80),
                    ('pasta','Malaga','pasta_malaga',90),
                    ('pasta','Latte Pasta','pasta_latte',100),
                    ('pasta','Muzlu Rulo','pasta_muzlu_rulo',110),
                    ('pasta','Çikolatalı Rulo','pasta_cik_rulo',120),
                    ('pasta','Meyveli Beyaz Çikolatalı Rulo','pasta_meyveli_rulo',130),
                    ('pasta','Browni','pasta_browni',140),
                    ('pasta','Dilim Sade San Sebastian (Adet)','pasta_dilim_ss_sade',150),
                    ('pasta','Cream Puff','pasta_cream_puff',160),
                    ('pasta','Kavala Kurabiye','pasta_kavala',170),
                    ('pasta','Limonlu Cup','pasta_cup_limon',180),
                    ('pasta','Yer Fıstıklı Cup','pasta_cup_yerfistik',190),
                    ('pasta','Çilekli Cup','pasta_cup_cilek',200),
                    ('pasta','Karamelli Cup','pasta_cup_karamel',210),
                    ('pasta','Lotuslu Cup','pasta_cup_lotus',220),
                    ('pasta','Antep Fıstıklı Cup','pasta_cup_antep',230),
                    ('pasta','Hindistan Cevizli Cup','pasta_cup_hindistan',240),
                    ('pasta','Profiterol','pasta_profiterol',250),
                    ('pasta','Kare Cheesecake Çikolatalı','pasta_kare_cik',260),
                    ('pasta','Kare Cheesecake Yer Fıstıklı Karamelli','pasta_kare_yerfistik',270),
                    ('pasta','Kare Cheesecake Karamelli','pasta_kare_karamel',280),
                    ('pasta','Kare Cheesecake Limonlu','pasta_kare_limon',290),
                    ('pasta','Dilim San Sebastian Sade','pasta_dilim_sade',300),
                    ('pasta','Dilim San Sebastian Antep Fıstıklı','pasta_dilim_antep',310),
                    ('pasta','Dilim San Sebastian Çikolatalı','pasta_dilim_cik',320),
                    ('pasta','Dilim San Sebastian Yaban Mersinli','pasta_dilim_yaban',330)
            ) AS v(kod, ad, norm_ad, sira)
            JOIN siparis_kategori k ON k.kod = v.kod
            ON CONFLICT (kategori_id, norm_ad) DO NOTHING
        """)
        # Pasta / süt ürünlerine depo_stok_kalem_kodu bağla (norm_ad = depo anahtarı)
        cur.execute("""
            UPDATE siparis_urun su
            SET depo_stok_kalem_kodu = su.norm_ad
            FROM siparis_kategori sk
            WHERE su.kategori_id = sk.id
              AND sk.kod IN ('pasta', 'sut')
              AND su.depo_stok_kalem_kodu IS NULL
        """)

        # ── DÜŞÜM MODU TEK SEFERLİK SEED (bitince vs açılınca) ─────
        # Yalnızca hiç 'bitince' işaretli ürün yoksa çalışır → sonradan
        # panelden yapılan manuel mod değişikliklerini ezmez.
        cur.execute("SELECT 1 FROM siparis_urun WHERE dusum_modu = 'bitince' LIMIT 1")
        if cur.fetchone() is None:
            # Temizlik (Z Peçete + Çöp Poşeti hariç) + tüm Bitki Çayları → bitince
            cur.execute("""
                UPDATE siparis_urun su
                SET dusum_modu = 'bitince', guncelleme = NOW()
                FROM siparis_kategori sk
                WHERE su.kategori_id = sk.id
                  AND (
                      sk.kod = 'bitki_cayi'
                      OR (sk.kod = 'temizlik' AND su.norm_ad NOT IN ('z_pecete', 'cop_poseti'))
                  )
            """)
            # Sarf'tan seçili ürünler → bitince (norm_ad ile)
            cur.execute("""
                UPDATE siparis_urun su
                SET dusum_modu = 'bitince', guncelleme = NOW()
                FROM siparis_kategori sk
                WHERE su.kategori_id = sk.id
                  AND sk.kod = 'sarf'
                  AND su.norm_ad IN (
                      'filtre_kagidi','strec_film','islak_mendil','kese_kagidi',
                      'bardak_cantasi','ahsap_karistirici','cam_bezi','zimba_teli'
                  )
            """)

        # ── KULLANIMDA ÜRÜN (bitince modu) ─────────────────────
        # 'bitince' modlu ürünler "Ürün Aç"ta depodan DÜŞMEZ; buraya
        # 'kullanimda' kaydı girer. "Bitti" denince URUN_AC yazılır,
        # depo düşülür ve sipariş alarmı o an tetiklenir.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_kullanimda_urun (
                id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id            TEXT NOT NULL,
                urun_id            TEXT,
                kalem_kodu         TEXT,
                urun_ad            TEXT,
                adet               INT  NOT NULL DEFAULT 1,
                durum              TEXT NOT NULL DEFAULT 'kullanimda',
                acan_personel_id   TEXT,
                acan_personel_ad   TEXT,
                ac_ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                biten_personel_id  TEXT,
                biten_personel_ad  TEXT,
                bitti_ts           TIMESTAMPTZ
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_kullanimda_sube_durum
            ON sube_kullanimda_urun (sube_id, durum, ac_ts DESC)
        """)

        # ── PERSONEL AYLIK KAYIT ───────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_aylik (
                id              TEXT PRIMARY KEY,
                personel_id     TEXT NOT NULL REFERENCES personel(id),
                yil             INT NOT NULL,
                ay              INT NOT NULL,
                calisma_saati   NUMERIC(6,2) DEFAULT 0,
                fazla_mesai_saat NUMERIC(6,2) DEFAULT 0,
                bayram_mesai_saat NUMERIC(6,2) DEFAULT 0,
                eksik_gun       NUMERIC(4,1) DEFAULT 0,
                raporlu_gun     NUMERIC(4,1) DEFAULT 0,
                rapor_kesinti   BOOLEAN DEFAULT FALSE,
                manuel_duzeltme NUMERIC(14,2) DEFAULT 0,
                not_aciklama    TEXT,
                hesaplanan_net  NUMERIC(14,2),
                durum           TEXT DEFAULT 'taslak',
                olusturma       TIMESTAMP DEFAULT NOW(),
                UNIQUE(personel_id, yil, ay)
            )
        """)

        # personel_aylik bayram_mesai_saat kolonu migration (varsa atlar)
        try:
            cur.execute("ALTER TABLE personel_aylik ADD COLUMN IF NOT EXISTS bayram_mesai_saat NUMERIC(6,2) DEFAULT 0")
        except Exception:
            pass

        # ── MOTOR ANALİTİK OLAY (append-only, audit'ten ayrı) ───
        cur.execute("""
            CREATE TABLE IF NOT EXISTS motor_analitik_olay (
                id               TEXT PRIMARY KEY,
                olay_tipi        TEXT NOT NULL,
                sube_id          TEXT,
                tutar_yok_bilgi  BOOLEAN NOT NULL DEFAULT FALSE,
                payload_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
                hesap_surumu     TEXT NOT NULL DEFAULT 'basarili',
                kaynak           TEXT,
                olusturma        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_motor_analitik_olay_tip_ts "
            "ON motor_analitik_olay (olay_tipi, olusturma DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_motor_analitik_olay_sube_ts "
            "ON motor_analitik_olay (sube_id, olusturma DESC) "
            "WHERE sube_id IS NOT NULL"
        )

        # ── AUDIT LOG ──────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id          TEXT PRIMARY KEY,
                tablo       TEXT NOT NULL,
                kayit_id    TEXT NOT NULL,
                islem       TEXT NOT NULL,
                eski_deger  TEXT,
                yeni_deger  TEXT,
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

        # Trigger kaldırıldı — backend tek sorumlu
        # Eski trigger'ları temizle — mantık tamamen backend'de
        cur.execute("DROP TRIGGER IF EXISTS trg_ciro_kasa ON ciro")
        cur.execute("DROP FUNCTION IF EXISTS fn_ciro_kasa_garantisi()")
        cur.execute("DROP TRIGGER IF EXISTS trg_ciro_iptal ON ciro")
        cur.execute("DROP FUNCTION IF EXISTS fn_ciro_iptal_garantisi()")

        # ── KASA TUTARLILIK GÖRÜNÜMÜ ───────────────────────────
        # Her ciro kaydı için kasa_hareketleri'nde karşılık var mı?
        # /api/kasa-kontrol ile anomalileri görebilirsin.
        cur.execute("""
            CREATE OR REPLACE VIEW v_kasa_anomali AS
            SELECT
                c.id as ciro_id,
                c.tarih,
                c.toplam as ciro_toplam,
                kh.tutar as kasa_tutar,
                CASE
                    WHEN kh.id IS NULL THEN 'KASA KAYDI YOK'
                    WHEN kh.durum = 'iptal' THEN 'KASA IPTAL'
                    ELSE 'OK'
                END as durum
            FROM ciro c
            LEFT JOIN kasa_hareketleri kh
                ON kh.ref_id = c.id
                AND kh.ref_type IN ('CIRO', 'CIRO_GUNCELLEME')
                AND kh.islem_turu = 'CIRO'
                AND kh.durum = 'aktif'
            WHERE c.durum = 'aktif'
            ORDER BY c.tarih DESC
        """)

        # onay_kuyrugu seviye kolonu
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name='onay_kuyrugu' AND column_name='seviye') THEN
                    ALTER TABLE onay_kuyrugu ADD COLUMN seviye TEXT DEFAULT 'BILGI';
                END IF;
            END
$$;
        """)

        # ── PERFORMANS İNDEXLERİ ───────────────────────────────
        # kasa_hareketleri: en sık sorgulanan kolonlar
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_kasa_har_sube_tarih "
            "ON kasa_hareketleri (tarih DESC) "
            "WHERE durum='aktif' AND kasa_etkisi=TRUE"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_kasa_har_ref "
            "ON kasa_hareketleri (ref_id, ref_type, islem_turu) "
            "WHERE durum='aktif'"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_kasa_har_islem_turu "
            "ON kasa_hareketleri (islem_turu, tarih DESC)"
        )
        # PERF (2026-07-06): çift-ödeme kapıları + iptal KURAL-1 hep (kaynak_id, islem_turu)
        # ile arar; index yoktu → tablo büyüdükçe seq scan. Dedup sorguları artık index'li.
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_kasa_har_kaynak "
            "ON kasa_hareketleri (kaynak_id, islem_turu) "
            "WHERE durum='aktif'"
        )
        # ciro: sube_id + tarih + durum kombinasyonu çok sık kullanılıyor
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_ciro_sube_tarih "
            "ON ciro (sube_id, tarih DESC) "
            "WHERE durum='aktif'"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_ciro_tarih "
            "ON ciro (tarih DESC) "
            "WHERE durum='aktif'"
        )
        # anlik_giderler: sube + tarih + durum
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_anlik_gider_sube_tarih "
            "ON anlik_giderler (sube, tarih DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_anlik_gider_tarih_durum "
            "ON anlik_giderler (tarih DESC, durum)"
        )
        # odeme_plani: bekleyen ödemeleri tarih sırasıyla çekmek için
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_odeme_plani_bekliyor_vade "
            "ON odeme_plani (tarih ASC) "
            "WHERE durum='bekliyor'"
        )

        # ══════════════════════════════════════════════════════════
        # STOK DİSİPLİN MOTORU — Mevcut tablolar genişletildi
        # Yeni tablo sadece gerçekten yeni kavramlar için eklendi.
        # ══════════════════════════════════════════════════════════

        # ── merkez_stok_kart → canlı stok alanları ────────────
        # Duplike tablo (merkez_depo_stok) yerine mevcut tabloya kolon eklendi.
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='merkez_stok_kart' AND column_name='mevcut_adet') THEN
                    ALTER TABLE merkez_stok_kart
                        ADD COLUMN mevcut_adet  INT NOT NULL DEFAULT 0,
                        ADD COLUMN rezerve_adet INT NOT NULL DEFAULT 0,
                        ADD COLUMN min_stok     INT NOT NULL DEFAULT 0;
                END IF;
            END $$;
        """)

        # ── siparis_talep → tahsis alanları ───────────────────
        # Ayrı siparis_tahsis tablosu yerine mevcut kalem_durumlari JSONB
        # kullanılır; sadece tahsis meta kolonları eklendi.
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='siparis_talep' AND column_name='tahsis_yapan_id') THEN
                    ALTER TABLE siparis_talep
                        ADD COLUMN tahsis_yapan_id TEXT,
                        ADD COLUMN tahsis_yapan_ad TEXT,
                        ADD COLUMN tahsis_ts       TIMESTAMPTZ,
                        ADD COLUMN tahsis_durum    TEXT;
                END IF;
            END $$;
        """)

        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='siparis_talep' AND column_name='tahsis_kaynak_depo_sube_id') THEN
                    ALTER TABLE siparis_talep
                        ADD COLUMN tahsis_kaynak_depo_sube_id TEXT;
                END IF;
            END $$;
        """)

        # ── sube_operasyon_uyari → davranış kuralı alanları ───
        # Ayrı sube_davranis_uyari tablosu yerine mevcut uyarı tablosu genişletildi.
        # tip = 'DAVRANIS' olan satırlar disiplin uyarısıdır.
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='siparis_talep' AND column_name='depo_sevkiyat_rapor_metni') THEN
                    ALTER TABLE siparis_talep
                        ADD COLUMN depo_sevkiyat_rapor_metni  TEXT,
                        ADD COLUMN depo_sevkiyat_rapor_ts     TIMESTAMPTZ,
                        ADD COLUMN depo_sevkiyat_rapor_uyari  BOOLEAN NOT NULL DEFAULT FALSE;
                END IF;
            END $$;
        """)

        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='siparis_talep' AND column_name='operasyon_yonlendirme_talimati') THEN
                    ALTER TABLE siparis_talep
                        ADD COLUMN operasyon_yonlendirme_talimati TEXT;
                END IF;
            END $$;
        """)

        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_operasyon_uyari' AND column_name='kural') THEN
                    ALTER TABLE sube_operasyon_uyari
                        ADD COLUMN kural            TEXT,
                        ADD COLUMN puan             INT NOT NULL DEFAULT 0,
                        ADD COLUMN siparis_talep_id TEXT REFERENCES siparis_talep(id) ON DELETE SET NULL,
                        ADD COLUMN kalem_kodu       TEXT,
                        ADD COLUMN detay            JSONB;
                END IF;
            END $$;
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_op_uyari_kural
            ON sube_operasyon_uyari (sube_id, kural, tarih DESC)
            WHERE kural IS NOT NULL
        """)

        # ── YENİ: Şube depo canlı stoku ───────────────────────
        # Gerçekten yeni kavram — mevcut hiçbir tabloda şube depo stoğu yok.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_depo_stok (
                id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id      TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                kalem_kodu   TEXT NOT NULL,
                kalem_adi    TEXT NOT NULL,
                mevcut_adet  INT  NOT NULL DEFAULT 0 CHECK (mevcut_adet >= 0),
                rezerve_adet INT  NOT NULL DEFAULT 0,
                min_stok     INT  NOT NULL DEFAULT 0,
                guncelleme   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (sube_id, kalem_kodu)
            )
        """)
        # Eski kurulumlarda CREATE TABLE daha önce çalıştıysa rezerve_adet eksik olabilir
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_depo_stok' AND column_name='rezerve_adet') THEN
                    ALTER TABLE sube_depo_stok
                        ADD COLUMN rezerve_adet INT NOT NULL DEFAULT 0;
                END IF;
            END $$;
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_depo_stok_sube
            ON sube_depo_stok (sube_id, kalem_kodu)
        """)

        # ── YENİ: Yoldaki stok ────────────────────────────────
        # Gerçekten yeni kavram — sevk edildi ama şube henüz kabul etmedi.
        # merkez_stok_sevk sadece merkez perspektifini tutar, bu transit sürecini tutar.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS stok_yolda (
                id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                siparis_talep_id  TEXT REFERENCES siparis_talep(id) ON DELETE SET NULL,
                sube_id           TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                kalem_kodu        TEXT NOT NULL,
                kalem_adi         TEXT NOT NULL,
                sevk_adet         INT  NOT NULL DEFAULT 0,
                sevk_ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                kabul_ts          TIMESTAMPTZ,
                kabul_adet        INT,
                durum             TEXT NOT NULL DEFAULT 'yolda',
                olusturma         TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_stok_yolda_sube_durum
            ON stok_yolda (sube_id, durum, sevk_ts DESC)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_stok_yolda_talep
            ON stok_yolda (siparis_talep_id)
        """)
        ensure_stok_yolda_columns(cur)

        # ── siparis_talep → otomatik gonderilmedi kapatma ─────
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='siparis_talep' AND column_name='gonderilmedi_ts') THEN
                    ALTER TABLE siparis_talep
                        ADD COLUMN gonderilmedi_ts TIMESTAMPTZ;
                END IF;
            END $$;
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_siparis_talep_gonderilmedi
            ON siparis_talep (durum, tarih)
            WHERE durum = 'bekliyor'
        """)

        # ── YENİ: Şube aylık skor ─────────────────────────────
        # Gerçekten yeni kavram — aylık davranış puanı özeti.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_skor (
                id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id      TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                yil          INT  NOT NULL,
                ay           INT  NOT NULL,
                toplam_puan  INT  NOT NULL DEFAULT 0,
                durum        TEXT NOT NULL DEFAULT 'normal',
                detay        JSONB,
                guncelleme   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (sube_id, yil, ay)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_skor_sube_donem
            ON sube_skor (sube_id, yil DESC, ay DESC)
        """)

        # ══════════════════════════════════════════════════════════════
        # VARDİYA v2 — SLOT BAZLI YENİDEN KURGULAMA
        # ══════════════════════════════════════════════════════════════
        # Eski vardiya tabloları (sube_vardiya_ihtiyac, vardiya_atama_taslak,
        # personel_sube_vardiya_yetki vs.) v1'dir; v2 yanına kurulur, UI
        # geçişi tamamlanınca v1 ayrı migration'da silinir.

        # 1) Slot tanımı — şube bazlı zaman dilimleri (kullanıcı tanımlar)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_slot (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                ad              TEXT NOT NULL,
                tip             TEXT NOT NULL DEFAULT 'normal',
                                -- 'acilis' | 'normal' | 'yogun' | 'kapanis'
                baslangic_saat  TIME NOT NULL,
                bitis_saat      TIME NOT NULL,
                gece_vardiyasi  BOOLEAN NOT NULL DEFAULT FALSE,
                                -- TRUE ise bitiş ertesi gün (örn 22:00→06:00)
                min_personel    INT NOT NULL DEFAULT 1,
                ideal_personel  INT NOT NULL DEFAULT 1,
                aktif_gunler    INT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
                                -- 1=Pzt..7=Paz
                aktif           BOOLEAN NOT NULL DEFAULT TRUE,
                sira            INT NOT NULL DEFAULT 0,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (tip IN ('acilis','normal','yogun','kapanis')),
                CHECK (min_personel >= 0 AND ideal_personel >= min_personel)
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_vardiya_slot_sube_aktif "
            "ON vardiya_slot (sube_id, aktif, sira)"
        )

        # 2a) Vardiya preset (sistem genel — TAM/PART/ARACI/AÇILIŞ/KAPANIŞ)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_preset (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                kod             TEXT NOT NULL UNIQUE,
                ad              TEXT NOT NULL,
                bas_saat        TIME NOT NULL,
                bit_saat        TIME NOT NULL,
                gece_vardiyasi  BOOLEAN NOT NULL DEFAULT FALSE,
                renk            TEXT,
                sira            INT NOT NULL DEFAULT 0,
                aktif           BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        # Sistem vardiya presetleri — tek UPSERT (yeni kurulum + mevcut DB güncellemesi)
        cur.execute("""
            INSERT INTO vardiya_preset (kod, ad, bas_saat, bit_saat, gece_vardiyasi, renk, sira, aktif)
            VALUES
                ('TAM',     'Tam mesai',              '09:00', '18:30', FALSE, '#3b82f6',  1, TRUE),
                ('PART',    'Part (sabah)',           '09:00', '14:30', FALSE, '#22c55e',  2, TRUE),
                ('PART1',   'Part 1 (akşam)',        '18:30', '23:59', FALSE, '#15803d',  3, TRUE),
                ('PART_K',  'Part kaydırma',        '15:30', '19:00', FALSE, '#65a30d',  4, TRUE),
                ('ARACI',   'Aracı',                 '12:00', '21:30', FALSE, '#facc15', 10, TRUE),
                ('ARACI1',  'Aracı 1',               '10:30', '20:00', FALSE, '#eab308', 11, TRUE),
                ('ARACI3',  'Aracı 3',               '12:00', '22:30', FALSE, '#ca8a04', 12, TRUE),
                ('ACILIS',  'Açılış',                '09:00', '18:30', FALSE, '#f97316', 20, TRUE),
                ('KAPANIS', 'Kapanış',               '14:30', '23:59', FALSE, '#a855f7', 21, TRUE),
                ('FULL1',   'Full 1',                '10:30', '23:00', FALSE, '#2563eb', 30, TRUE),
                ('FULL2',   'Full 2',                '11:00', '23:59', FALSE, '#1d4ed8', 31, TRUE)
            ON CONFLICT (kod) DO UPDATE SET
                ad = EXCLUDED.ad,
                bas_saat = EXCLUDED.bas_saat,
                bit_saat = EXCLUDED.bit_saat,
                gece_vardiyasi = EXCLUDED.gece_vardiyasi,
                renk = EXCLUDED.renk,
                sira = EXCLUDED.sira,
                aktif = EXCLUDED.aktif
        """)
        # Eski PART2/PART3 kodları PART_K ile çakışmasın diye kapatılır
        cur.execute("""
            UPDATE vardiya_preset SET aktif = FALSE
            WHERE kod IN ('PART2', 'PART3')
        """)

        # 2) Personel kısıtları — kişi başına 1 satır
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_kisit (
                personel_id              TEXT PRIMARY KEY REFERENCES personel(id) ON DELETE CASCADE,
                max_gunluk_saat          NUMERIC(4,2) NOT NULL DEFAULT 9.5,
                max_haftalik_saat        NUMERIC(5,2) NOT NULL DEFAULT 57,
                izinli_subeler           TEXT[] NOT NULL DEFAULT '{}',
                                         -- boş = tüm aktif şubeler
                yasak_subeler            TEXT[] NOT NULL DEFAULT '{}',
                calisilabilir_saat_min   TIME,
                calisilabilir_saat_max   TIME,
                min_gecis_dk             INT NOT NULL DEFAULT 60,
                                         -- şube değişiminde min süre
                vardiya_preset_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
                                         -- {"hafta_ici":"PART","hafta_sonu":"TAM"} veya
                                         -- {"pzt":"PART","sal":"PART",...,"cmt":"TAM","paz":"TAM"}
                gun_saat_kisitlari_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
                                         -- {"car":[{"yasak_bas":"06:00","yasak_bit":"13:00","neden":"Ders"}]}
                yemek_sube_id            TEXT REFERENCES subeler(id),
                                         -- yemek molasının yapılacağı şube (sabit)
                guncelleme               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (max_gunluk_saat > 0 AND max_haftalik_saat > 0 AND min_gecis_dk >= 0)
            )
        """)
        # Migration: Eski kurulumlarda `personel_kisit` tablosu farklı/eksik sütunlu olabilir
        # (CREATE IF NOT EXISTS mevcut tabloyu güncellemez → UndefinedColumn: max_gunluk_saat).
        cur.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                ) THEN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'max_gunluk_saat'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN max_gunluk_saat NUMERIC(4,2) NOT NULL DEFAULT 9.5;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'max_haftalik_saat'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN max_haftalik_saat NUMERIC(5,2) NOT NULL DEFAULT 57;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'izinli_subeler'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN izinli_subeler TEXT[] NOT NULL DEFAULT '{}';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'yasak_subeler'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN yasak_subeler TEXT[] NOT NULL DEFAULT '{}';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'calisilabilir_saat_min'
                ) THEN
                    ALTER TABLE personel_kisit ADD COLUMN calisilabilir_saat_min TIME;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'calisilabilir_saat_max'
                ) THEN
                    ALTER TABLE personel_kisit ADD COLUMN calisilabilir_saat_max TIME;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'min_gecis_dk'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN min_gecis_dk INT NOT NULL DEFAULT 60;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'guncelleme'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN guncelleme TIMESTAMPTZ NOT NULL DEFAULT NOW();
                END IF;
                -- Eski schema'da ayrı NOT NULL `id` kolonu olabilir; INSERT id vermezse hata.
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'id'
                ) THEN
                    BEGIN
                        UPDATE personel_kisit SET id = gen_random_uuid()
                        WHERE id IS NULL;
                    EXCEPTION WHEN others THEN NULL;
                    END;
                    BEGIN
                        UPDATE personel_kisit SET id = gen_random_uuid()::text
                        WHERE id IS NULL;
                    EXCEPTION WHEN others THEN NULL;
                    END;
                    BEGIN
                        ALTER TABLE personel_kisit ALTER COLUMN id SET DEFAULT gen_random_uuid();
                    EXCEPTION WHEN others THEN NULL;
                    END;
                    BEGIN
                        ALTER TABLE personel_kisit ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
                    EXCEPTION WHEN others THEN NULL;
                    END;
                END IF;
                -- Yeni kolonlar (preset, ders saatleri, yemek şubesi)
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'vardiya_preset_json'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN vardiya_preset_json JSONB NOT NULL DEFAULT '{}'::jsonb;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'gun_saat_kisitlari_json'
                ) THEN
                    ALTER TABLE personel_kisit
                        ADD COLUMN gun_saat_kisitlari_json JSONB NOT NULL DEFAULT '{}'::jsonb;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'personel_kisit'
                      AND column_name = 'yemek_sube_id'
                ) THEN
                    ALTER TABLE personel_kisit ADD COLUMN yemek_sube_id TEXT;
                END IF;
                END IF;
            END $$;
        """)

        # Eski 9 saat varsayılanını çalışma türüne göre 9,5 (sürekli) / 5,5 (part) yap
        try:
            cur.execute("""
                UPDATE personel_kisit pk SET max_gunluk_saat = 5.5
                FROM personel p
                WHERE p.id = pk.personel_id
                  AND LOWER(REPLACE(COALESCE(p.calisma_turu, ''), '-', '_')) IN ('part_time', 'part')
                  AND pk.max_gunluk_saat IN (9, 9.0)
            """)
            cur.execute("""
                UPDATE personel_kisit pk SET max_gunluk_saat = 9.5
                FROM personel p
                WHERE p.id = pk.personel_id
                  AND LOWER(REPLACE(COALESCE(p.calisma_turu, ''), '-', '_')) NOT IN ('part_time', 'part')
                  AND pk.max_gunluk_saat IN (9, 9.0)
            """)
        except Exception:
            pass

        # 3) Personel atama — gün × slot × kişi
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_atama (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                tarih           DATE NOT NULL,
                slot_id         TEXT NOT NULL REFERENCES vardiya_slot(id) ON DELETE CASCADE,
                personel_id     TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                baslangic_saat  TIME NOT NULL,
                bitis_saat      TIME NOT NULL,
                gece_vardiyasi  BOOLEAN NOT NULL DEFAULT FALSE,
                durum           TEXT NOT NULL DEFAULT 'planli',
                                -- 'planli' | 'onayli' | 'iptal'
                override_id     TEXT,
                                -- vardiya_override_log FK; varsa bu atama bir uyarıyı geçti
                aciklama        TEXT,
                olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                kullanici_id    TEXT,
                CHECK (durum IN ('planli','onayli','iptal'))
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_vardiya_atama_tarih "
            "ON vardiya_atama (tarih, durum)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_vardiya_atama_personel "
            "ON vardiya_atama (personel_id, tarih, durum)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_vardiya_atama_slot "
            "ON vardiya_atama (slot_id, tarih, durum)"
        )

        # Migration: vardiya_atama.slot_id FK CASCADE → SET NULL (geçmiş atama koruması)
        # Slot silinince/yeniden üretilince atamalar SİLİNMEZ; sadece slot bağı NULL olur.
        # Atamanın kendi tarih/saat/personel kaydı durur → maaş hesabı bozulmaz.
        cur.execute("""
            DO $$
            DECLARE r record;
            BEGIN
                -- slot_id üzerindeki mevcut FK'(lar)ı (CASCADE dahil) bul ve düşür
                FOR r IN
                    SELECT con.conname
                    FROM pg_constraint con
                    JOIN pg_class c ON c.oid = con.conrelid
                    WHERE c.relname = 'vardiya_atama' AND con.contype = 'f'
                      AND 'slot_id' = ANY (
                          SELECT attname FROM pg_attribute
                          WHERE attrelid = con.conrelid AND attnum = ANY (con.conkey)
                      )
                LOOP
                    EXECUTE format('ALTER TABLE vardiya_atama DROP CONSTRAINT %I', r.conname);
                END LOOP;
                -- slot_id nullable (SET NULL için şart)
                BEGIN
                    ALTER TABLE vardiya_atama ALTER COLUMN slot_id DROP NOT NULL;
                EXCEPTION WHEN others THEN NULL;
                END;
                -- yeni FK: ON DELETE SET NULL
                ALTER TABLE vardiya_atama
                    ADD CONSTRAINT vardiya_atama_slot_id_setnull
                    FOREIGN KEY (slot_id) REFERENCES vardiya_slot(id) ON DELETE SET NULL;
            END $$;
        """)

        # 4) Personel izin — tarih bazlı
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_izin (
                id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                personel_id      TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                baslangic_tarih  DATE NOT NULL,
                bitis_tarih      DATE NOT NULL,
                tip              TEXT NOT NULL DEFAULT 'mazeret',
                                 -- 'yillik' | 'mazeret' | 'rapor' | 'ucretsiz'
                aciklama         TEXT,
                olusturma        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                kullanici_id     TEXT,
                CHECK (tip IN ('yillik','mazeret','rapor','ucretsiz')),
                CHECK (bitis_tarih >= baslangic_tarih)
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_personel_izin_personel "
            "ON personel_izin (personel_id, baslangic_tarih, bitis_tarih)"
        )
        # Yarım gün izin desteği
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_izin' AND column_name='gun_kesri')
                THEN ALTER TABLE personel_izin ADD COLUMN gun_kesri NUMERIC(3,1) NOT NULL DEFAULT 1.0; END IF;
            END $$;
        """)

        # 5) Override log — audit
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_override_log (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                kullanici_id    TEXT,
                ihlal_tipi      TEXT NOT NULL,
                                -- 'saat_asimi' | 'sube_uyumsuz' | 'cakisma'
                                -- 'gecis_yetersiz' | 'izinli_atandi' | 'saat_disinda'
                                -- 'min_personel_eksik' | 'kapanis_eksik'
                personel_id     TEXT,
                atama_id        TEXT,
                tarih           DATE,
                payload_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
                aciklama        TEXT
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_vardiya_override_log_ts "
            "ON vardiya_override_log (ts DESC)"
        )

        # 6) Personel × gün niyeti — izin değil, bilinçli boş (BOS) vs planlanmamış
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_vardiya_gun_niyet (
                personel_id   TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                tarih         DATE NOT NULL,
                kasitli_bos   BOOLEAN NOT NULL DEFAULT TRUE,
                PRIMARY KEY (personel_id, tarih)
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_pvgn_tarih ON personel_vardiya_gun_niyet (tarih)"
        )

        # 7) Gün kilidi — bu tarihte yeni atama (override hariç) engellenir
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_gun_kilit (
                tarih     DATE PRIMARY KEY,
                kilitli   BOOLEAN NOT NULL DEFAULT TRUE,
                aciklama  TEXT,
                ts        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

        # 7b) Şube × gün — planlamada hedef kişi sayısı (slot ayrı; atama sonrası altında/tam/üstünde özeti)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_sube_gun_hedef (
                sube_id          TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                tarih            DATE NOT NULL,
                hedef_personel   INT NOT NULL CHECK (hedef_personel >= 0),
                guncelleme       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (sube_id, tarih)
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_vardiya_sube_gun_hedef_tarih "
            "ON vardiya_sube_gun_hedef (tarih)"
        )

        # 8) Personel × gün özet durumu (Aşama 1/5 — atama/izin/niyet ile güncellenir)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_gun_state (
                personel_id       TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                tarih             DATE NOT NULL,
                durum             TEXT NOT NULL DEFAULT 'PLANLANMADI',
                kasitli_bos       BOOLEAN NOT NULL DEFAULT FALSE,
                atama_sayisi      INT NOT NULL DEFAULT 0,
                toplam_saat       NUMERIC(6,2) NOT NULL DEFAULT 0,
                kalan_saat        NUMERIC(6,2) NOT NULL DEFAULT 0,
                max_gunluk_saat   NUMERIC(4,2) NOT NULL DEFAULT 9.5,
                haftalik_saat     NUMERIC(6,2) NOT NULL DEFAULT 0,
                fazla_gunluk_saat NUMERIC(6,2) NOT NULL DEFAULT 0,
                guncelleme        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (personel_id, tarih),
                CHECK (durum IN ('CALISIYOR','BOS','IZINLI','PLANLANMADI')),
                CHECK (atama_sayisi >= 0)
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_pgs_tarih ON personel_gun_state (tarih DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_pgs_fazla ON personel_gun_state (tarih) "
            "WHERE fazla_gunluk_saat > 0"
        )

        # ══════════════════════════════════════════════════════════════
        # MIGRATION: Eski VARDİYA v1 tablolarını sil (v2'ye geçildi)
        # ══════════════════════════════════════════════════════════════
        # Tek seferlik DROP — finans_migration_log ile guard.
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS finans_migration_log (
                    ad           TEXT PRIMARY KEY,
                    calistirildi TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    detay        JSONB
                )
            """)
            cur.execute(
                "SELECT 1 FROM finans_migration_log WHERE ad = %s",
                ('vardiya_v1_drop_v1',)
            )
            if cur.fetchone() is None:
                v1_tablolar = [
                    'sube_vardiya_ihtiyac',
                    'sube_vardiya_alternatif_kural',
                    'personel_sube_vardiya_yetki',
                    'personel_vardiya_sube_erisim',
                    'vardiya_motor_ayar',
                    'vardiya_atama_taslak',
                ]
                drop_count = 0
                for t in v1_tablolar:
                    try:
                        cur.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
                        drop_count += 1
                    except Exception:
                        pass
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES (%s, %s::jsonb)
                """, ('vardiya_v1_drop_v1', f'{{"drop_edildi": {drop_count}}}'))
                if drop_count > 0:
                    print(f"[MIGRATION] Vardiya v1 tabloları silindi: {drop_count}")
        except Exception as _mig_e:
            print(f"[MIGRATION WARN] vardiya_v1_drop_v1: {_mig_e}")

        # ══════════════════════════════════════════════════════════════
        # MIGRATION: Eski FAIZ kayıtlarına KKDF (%15) + BSMV (%5) ekle
        # ══════════════════════════════════════════════════════════════
        # faiz_hesapla_ve_yaz motoru bu commit'ten önce HAM faiz yazıyordu
        # (KKDF/BSMV yoktu). Şimdi vergi dahil yazıyor. Geçmişte yazılmış
        # ham FAIZ kayıtlarını ×1.20 ile güncelle.
        #
        # Tespit: aciklama içinde "kesim faizi" geçen ama "KKDF+BSMV:"
        # geçmeyen FAIZ kayıtları → eski format (ham). Bunları güncelle.
        # Idempotent: bir kez çalıştırıldıktan sonra "KKDF+BSMV:" işareti
        # eklendiği için ikinci çalıştırmada hiçbir kayıt eşleşmez.
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS finans_migration_log (
                    ad           TEXT PRIMARY KEY,
                    calistirildi TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    detay        JSONB
                )
            """)
            cur.execute(
                "SELECT 1 FROM finans_migration_log WHERE ad = %s",
                ('faiz_kkdf_bsmv_geriye_donuk_v1',)
            )
            if cur.fetchone() is None:
                # Eski formatlı (ham) FAIZ kayıtlarını bul ve güncelle
                cur.execute("""
                    UPDATE kart_hareketleri
                    SET tutar       = ROUND((tutar * 1.20)::numeric, 2),
                        faiz_tutari = ROUND((COALESCE(faiz_tutari, tutar) * 1.20)::numeric, 2),
                        aciklama    = COALESCE(aciklama, '') ||
                                      ' [GERIYE_DONUK_KKDF+BSMV:%' ||
                                      ROUND((tutar * 0.20)::numeric, 2)::text || ']'
                    WHERE durum = 'aktif'
                      AND islem_turu = 'FAIZ'
                      AND aciklama LIKE '%kesim faizi%'
                      AND aciklama NOT LIKE '%KKDF+BSMV%'
                      AND aciklama NOT LIKE '%GERIYE_DONUK%'
                """)
                guncellenen = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES (%s, %s::jsonb)
                """, (
                    'faiz_kkdf_bsmv_geriye_donuk_v1',
                    f'{{"guncellenen_kayit": {guncellenen}, "vergi_carpani": 1.20}}'
                ))
                if guncellenen > 0:
                    print(f"[MIGRATION] Geriye dönük KKDF+BSMV uygulandı: {guncellenen} FAIZ kaydı güncellendi.")
        except Exception as _mig_e:
            # Migration başarısız olursa init_db'yi düşürme — sadece logla
            print(f"[MIGRATION WARN] faiz_kkdf_bsmv_geriye_donuk_v1: {_mig_e}")

        # ─── MIGRATION: depo_stok_duplike_temizlik_v1 ─────────────────────────────
        # sube_depo_stok içinde aynı fiziksel ürün için hem eski text-kodu hem UUID-kodu
        # var. Eski (legacy) text kodları kaldır; mevcut_adet varsa UUID satırına aktar.
        # Ayrıca plastik_bardak→bardak_plastik ve su→su_adet text-text duplikeler temizlenir.
        try:
            cur.execute("""
                SELECT 1 FROM finans_migration_log WHERE ad='depo_stok_duplike_temizlik_v1' LIMIT 1
            """)
            if not cur.fetchone():
                # 1. Eski text kodlarını UUID karşılıklarına taşı (mevcut_adet varsa ekle)
                cur.execute("""
                    WITH legacy AS (
                        SELECT sds.sube_id, sds.kalem_kodu AS eski_kod,
                               sds.mevcut_adet AS eski_adet,
                               su.id            AS yeni_kod
                        FROM sube_depo_stok sds
                        JOIN siparis_urun su
                          ON su.norm_ad = sds.kalem_kodu
                        WHERE sds.kalem_kodu NOT IN (
                            'bardak_kucuk','bardak_buyuk','bardak_plastik','su_adet',
                            'redbull_adet','soda_adet','cookie_adet','pasta_adet',
                            'sut_litre','surup_adet','kahve_paket','karton_bardak',
                            'kapak_adet','pecete_paket','diger_sarf'
                        )
                          AND sds.kalem_kodu !~ '^[0-9a-f]{8}-'
                    )
                    UPDATE sube_depo_stok dst
                    SET mevcut_adet = dst.mevcut_adet + legacy.eski_adet
                    FROM legacy
                    WHERE dst.sube_id  = legacy.sube_id
                      AND dst.kalem_kodu = legacy.yeni_kod
                      AND legacy.eski_adet > 0
                """)
                adet1 = cur.rowcount

                # 2. Eski text-kodlu satırları sil (norm_ad → UUID eşleşmesi varsa)
                cur.execute("""
                    DELETE FROM sube_depo_stok
                    WHERE kalem_kodu NOT IN (
                        'bardak_kucuk','bardak_buyuk','bardak_plastik','su_adet',
                        'redbull_adet','soda_adet','cookie_adet','pasta_adet',
                        'sut_litre','surup_adet','kahve_paket','karton_bardak',
                        'kapak_adet','pecete_paket','diger_sarf'
                    )
                      AND kalem_kodu !~ '^[0-9a-f]{8}-'
                      AND EXISTS (
                          SELECT 1 FROM siparis_urun su WHERE su.norm_ad = kalem_kodu
                      )
                """)
                silinen1 = cur.rowcount

                # 3. Text-text duplikeler: plastik_bardak → bardak_plastik
                cur.execute("""
                    UPDATE sube_depo_stok dst
                    SET mevcut_adet = dst.mevcut_adet +
                        COALESCE((SELECT mevcut_adet FROM sube_depo_stok
                                  WHERE sube_id=dst.sube_id AND kalem_kodu='plastik_bardak'), 0)
                    WHERE dst.kalem_kodu = 'bardak_plastik'
                      AND EXISTS (SELECT 1 FROM sube_depo_stok
                                  WHERE sube_id=dst.sube_id AND kalem_kodu='plastik_bardak')
                """)
                cur.execute("DELETE FROM sube_depo_stok WHERE kalem_kodu='plastik_bardak'")
                silinen2 = cur.rowcount

                # 4. Text-text duplikeler: su → su_adet
                cur.execute("""
                    UPDATE sube_depo_stok dst
                    SET mevcut_adet = dst.mevcut_adet +
                        COALESCE((SELECT mevcut_adet FROM sube_depo_stok
                                  WHERE sube_id=dst.sube_id AND kalem_kodu='su'), 0)
                    WHERE dst.kalem_kodu = 'su_adet'
                      AND EXISTS (SELECT 1 FROM sube_depo_stok
                                  WHERE sube_id=dst.sube_id AND kalem_kodu='su')
                """)
                cur.execute("DELETE FROM sube_depo_stok WHERE kalem_kodu='su'")
                silinen3 = cur.rowcount

                # 5. merkez_stok_kart'tan da eski legacy kodları temizle
                cur.execute("""
                    DELETE FROM merkez_stok_kart
                    WHERE kalem_kodu NOT IN (
                        'bardak_kucuk','bardak_buyuk','bardak_plastik','su_adet',
                        'redbull_adet','soda_adet','cookie_adet','pasta_adet',
                        'sut_litre','surup_adet','kahve_paket','karton_bardak',
                        'kapak_adet','pecete_paket','diger_sarf'
                    )
                      AND kalem_kodu !~ '^[0-9a-f]{8}-'
                      AND EXISTS (
                          SELECT 1 FROM siparis_urun su WHERE su.norm_ad = kalem_kodu
                      )
                """)
                silinen4 = cur.rowcount
                cur.execute("DELETE FROM merkez_stok_kart WHERE kalem_kodu IN ('plastik_bardak','su')")
                silinen5 = cur.rowcount

                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay) VALUES (%s, %s::jsonb)
                """, (
                    'depo_stok_duplike_temizlik_v1',
                    f'{{"stok_aktarim": {adet1}, "eski_kod_silinen": {silinen1}, '
                    f'"plastik_bardak_silinen": {silinen2}, "su_silinen": {silinen3}, '
                    f'"merkez_kart_silinen": {silinen4}, "metin_text_silinen": {silinen5}}}',
                ))
                print(f"[MIGRATION] depo_stok_duplike_temizlik_v1: "
                      f"stok_aktarim={adet1}, eski_kod_silinen={silinen1}, "
                      f"plastik_bardak={silinen2}, su={silinen3}, "
                      f"merkez={silinen4}+{silinen5}")
        except Exception as _mig_e:
            print(f"[MIGRATION WARN] depo_stok_duplike_temizlik_v1: {_mig_e}")

        # ─── MIGRATION: depo_stok_duplike_temizlik_v2 (typo kalem_kodlar) ─────────
        try:
            cur.execute("""
                SELECT 1 FROM finans_migration_log WHERE ad='depo_stok_duplike_temizlik_v2' LIMIT 1
            """)
            if not cur.fetchone():
                _typo_kodlar = ['tu_rk_kahvesi', 'frambuaz_surup']
                cur.execute(
                    "DELETE FROM sube_depo_stok WHERE kalem_kodu = ANY(%s)",
                    (_typo_kodlar,),
                )
                s1 = cur.rowcount
                cur.execute(
                    "DELETE FROM merkez_stok_kart WHERE kalem_kodu = ANY(%s)",
                    (_typo_kodlar,),
                )
                s2 = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay) VALUES (%s, %s::jsonb)
                """, (
                    'depo_stok_duplike_temizlik_v2',
                    json.dumps({"sds_silinen": s1, "msk_silinen": s2, "kodlar": _typo_kodlar}),
                ))
                print(f"[MIGRATION] depo_stok_duplike_temizlik_v2: sds={s1}, msk={s2}")
        except Exception as _mig_e:
            print(f"[MIGRATION WARN] depo_stok_duplike_temizlik_v2: {_mig_e}")

        # ─── MIGRATION: katalog_stok_birebir_v1 ──────────────────────────────────
        # Her aktif siparis_urun × her aktif sube için sube_depo_stok satırı garantile.
        # Var olanları bozmaz (ON CONFLICT DO NOTHING), sadece eksik olanları 0 adet ile ekler.
        try:
            cur.execute("""
                SELECT 1 FROM finans_migration_log WHERE ad='katalog_stok_birebir_v1' LIMIT 1
            """)
            if not cur.fetchone():
                cur.execute("""
                    INSERT INTO sube_depo_stok (id, sube_id, kalem_kodu, kalem_adi, mevcut_adet)
                    SELECT
                        gen_random_uuid()::text,
                        s.id,
                        su.id::text,
                        su.ad,
                        0
                    FROM siparis_urun su
                    CROSS JOIN subeler s
                    WHERE su.aktif = TRUE
                      AND s.aktif  = TRUE
                    ON CONFLICT (sube_id, kalem_kodu) DO NOTHING
                """)
                _eklenen = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay) VALUES (%s, %s::jsonb)
                """, (
                    'katalog_stok_birebir_v1',
                    f'{{"eklenen": {_eklenen}}}',
                ))
                print(f"[MIGRATION] katalog_stok_birebir_v1: {_eklenen} sube_depo_stok satırı eklendi")
        except Exception as _mig_e:
            print(f"[MIGRATION WARN] katalog_stok_birebir_v1: {_mig_e}")

        # ─── MIGRATION: depo_stok_duplike_temizlik_v3 (UUID-havuz çakışmaları) ────
        # katalog_stok_birebir_v1 her siparis_urun için UUID satırı yarattı.
        # Bardak/su/soda gibi "fiziksel havuz" ürünler zaten su_adet/bardak_kucuk
        # gibi text-kodlu satırlarla izleniyor — UUID satırı ikinci bir giriş yapıyor.
        # Bu migration:
        #  1. Havuz ürünlerinin UUID sube_depo_stok satırlarındaki adet varsa havuz
        #     satırına aktarır.
        #  2. UUID satırlarını siler.
        #  3. siparis_urun.depo_stok_kalem_kodu = havuz kodu ile işaretler
        #     (gelecekte _sube_katalog_stok_garantile tekrar UUID satırı eklemesin).
        try:
            cur.execute("""
                SELECT 1 FROM finans_migration_log WHERE ad='depo_stok_duplike_temizlik_v3' LIMIT 1
            """)
            if not cur.fetchone():
                try:
                    from operasyon_stok_motor import _stok_key_from_urun_ad as _v3_sk_fn
                except Exception:
                    _v3_sk_fn = None

                _HAVUZ_V3 = frozenset({
                    "bardak_kucuk", "bardak_buyuk", "bardak_plastik", "su_adet",
                    "redbull_adet", "soda_adet", "cookie_adet", "pasta_adet",
                    "sut_litre", "surup_adet", "kahve_paket", "karton_bardak",
                    "kapak_adet", "pecete_paket", "diger_sarf",
                })

                _v3_silinen = 0
                _v3_merge = 0

                # Flavoring/ingredient kategorileri hariç (ör. Cookie şurubu → cookie_adet ile karıştırılmamalı)
                _V3_ATLANACAK_KAT = frozenset({'surup', 'sos', 'pure', 'toz', 'sut', 'pasta'})

                if _v3_sk_fn is not None:
                    cur.execute("""
                        SELECT su.id, su.ad, su.depo_stok_kalem_kodu,
                               sk.kod AS kategori_kod
                        FROM siparis_urun su
                        LEFT JOIN siparis_kategori sk ON sk.id = su.kategori_id
                    """)
                    _v3_urunler = cur.fetchall()
                    for _v3r in _v3_urunler:
                        _v3_uid  = str(_v3r["id"])
                        _v3_ad   = str(_v3r.get("ad") or "")
                        _v3_kat  = str(_v3r.get("kategori_kod") or "").strip().lower()
                        _v3_ovr  = str(_v3r.get("depo_stok_kalem_kodu") or "").strip()

                        # Şurup/sos/pure/toz/sut/pasta kategorileri atlansın
                        if _v3_kat in _V3_ATLANACAK_KAT:
                            continue
                        # Zaten farklı bir norm_ad koduna bağlıysa atla (birebir takip ediliyor)
                        if _v3_ovr and _v3_ovr != _v3_uid:
                            continue

                        _v3_hk = _v3_sk_fn(_v3_ad)
                        if not _v3_hk or _v3_hk not in _HAVUZ_V3:
                            continue

                        # 1. siparis_urun.depo_stok_kalem_kodu işaretle
                        cur.execute("""
                            UPDATE siparis_urun
                            SET depo_stok_kalem_kodu = %s
                            WHERE id = %s
                              AND (depo_stok_kalem_kodu IS NULL OR depo_stok_kalem_kodu = '')
                        """, (_v3_hk, _v3_uid))

                        # 2. UUID satırındaki adet > 0 ise havuz satırına ekle
                        cur.execute("""
                            UPDATE sube_depo_stok dst
                            SET mevcut_adet = dst.mevcut_adet
                                    + COALESCE((
                                        SELECT mevcut_adet FROM sube_depo_stok
                                        WHERE sube_id = dst.sube_id
                                          AND kalem_kodu = %s
                                          AND mevcut_adet > 0
                                      ), 0),
                                guncelleme  = NOW()
                            WHERE dst.kalem_kodu = %s
                              AND EXISTS (
                                  SELECT 1 FROM sube_depo_stok
                                  WHERE sube_id = dst.sube_id
                                    AND kalem_kodu = %s
                                    AND mevcut_adet > 0
                              )
                        """, (_v3_uid, _v3_hk, _v3_uid))
                        _v3_merge += cur.rowcount

                        # 3. UUID satırlarını sil
                        cur.execute(
                            "DELETE FROM sube_depo_stok WHERE kalem_kodu = %s",
                            (_v3_uid,),
                        )
                        _v3_silinen += cur.rowcount

                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay) VALUES (%s, %s::jsonb)
                """, (
                    'depo_stok_duplike_temizlik_v3',
                    f'{{"silinen": {_v3_silinen}, "merge": {_v3_merge}}}',
                ))
                print(f"[MIGRATION] depo_stok_duplike_temizlik_v3: silinen={_v3_silinen}, merge={_v3_merge}")
        except Exception as _mig_e:
            print(f"[MIGRATION WARN] depo_stok_duplike_temizlik_v3: {_mig_e}")

        # ─── MIGRATION: depo_stok_duplike_temizlik_v4 (kaçan norm_ad satırları) ──
        # v1 yalnızca UUID karşılığı olan norm_ad satırlarını temizledi.
        # Sonradan eklenen ürünler veya v1'in atladığı durumlar için tekrar tarar:
        #   1. norm_ad satırı + UUID satırı AYNI ANDA varsa → adet UUID'ye aktarılır,
        #      norm_ad satırı silinir (gerçek çift satır = çift düşme riski).
        #   2. norm_ad satırı var, UUID satırı YOK → kalem_kodu UUID'ye güncellenir
        #      (orphan satır, kayıp stok riski).
        try:
            cur.execute("SAVEPOINT sp_v4_duplike")
            cur.execute("""
                SELECT 1 FROM finans_migration_log WHERE ad='depo_stok_duplike_temizlik_v4' LIMIT 1
            """)
            if not cur.fetchone():
                # Havuz kodları ve UUID formatındakiler bu migration'ın dışında
                _HAVUZ_KODLAR = (
                    'bardak_kucuk','bardak_buyuk','bardak_plastik','su_adet',
                    'redbull_adet','soda_adet','cookie_adet','pasta_adet',
                    'sut_litre','surup_adet','kahve_paket','karton_bardak',
                    'kapak_adet','pecete_paket','diger_sarf',
                )

                # Tüm norm_ad bazlı satırları bul (UUID değil, havuz kodu değil)
                cur.execute("""
                    SELECT sds.sube_id, sds.kalem_kodu AS norm_kod,
                           sds.mevcut_adet, sds.min_stok, sds.alis_fiyati_tl,
                           su.id AS uuid_kod, su.ad AS urun_ad
                    FROM sube_depo_stok sds
                    JOIN siparis_urun su ON su.norm_ad = sds.kalem_kodu
                    WHERE sds.kalem_kodu != ALL(%s::text[])
                      AND sds.kalem_kodu !~ '^[0-9a-f]{8}-[0-9a-f]{4}-'
                """, (list(_HAVUZ_KODLAR),))
                v4_rows = cur.fetchall()

                v4_merge = 0
                v4_guncelle = 0
                v4_silinen = 0

                for row in v4_rows:
                    sid       = str(row["sube_id"])
                    norm_kod  = str(row["norm_kod"])
                    uuid_kod  = str(row["uuid_kod"])
                    eski_adet = int(row["mevcut_adet"] or 0)

                    # UUID satırı var mı?
                    cur.execute("""
                        SELECT mevcut_adet FROM sube_depo_stok
                        WHERE sube_id=%s AND kalem_kodu=%s
                    """, (sid, uuid_kod))
                    uuid_row = cur.fetchone()

                    if uuid_row is not None:
                        # Durum 1: Çift satır — norm_ad adetini UUID'ye ekle, norm_ad'ı sil
                        if eski_adet > 0:
                            cur.execute("""
                                UPDATE sube_depo_stok
                                SET mevcut_adet = mevcut_adet + %s, guncelleme = NOW()
                                WHERE sube_id=%s AND kalem_kodu=%s
                            """, (eski_adet, sid, uuid_kod))
                            v4_merge += 1
                        cur.execute("""
                            DELETE FROM sube_depo_stok
                            WHERE sube_id=%s AND kalem_kodu=%s
                        """, (sid, norm_kod))
                        v4_silinen += cur.rowcount
                    else:
                        # Durum 2: Orphan satır — kalem_kodu'nu UUID'ye güncelle
                        cur.execute("""
                            UPDATE sube_depo_stok
                            SET kalem_kodu=%s, kalem_adi=%s, guncelleme=NOW()
                            WHERE sube_id=%s AND kalem_kodu=%s
                        """, (uuid_kod, row["urun_ad"], sid, norm_kod))
                        v4_guncelle += cur.rowcount

                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay) VALUES (%s, %s::jsonb)
                """, (
                    'depo_stok_duplike_temizlik_v4',
                    json.dumps({"cift_satir_silinen": v4_silinen,
                                "cift_satir_merge": v4_merge,
                                "orphan_guncellenen": v4_guncelle}),
                ))
                print(f"[MIGRATION] depo_stok_duplike_temizlik_v4: "
                      f"cift_silinen={v4_silinen}, merge={v4_merge}, orphan={v4_guncelle}")
            cur.execute("RELEASE SAVEPOINT sp_v4_duplike")
        except Exception as _mig_e:
            try: cur.execute("ROLLBACK TO SAVEPOINT sp_v4_duplike")
            except Exception: pass
            print(f"[MIGRATION WARN] depo_stok_duplike_temizlik_v4: {_mig_e}")

        # ─── MIGRATION v5: siparis_urun.depo_stok_kalem_kodu = id (explicit UUID ataması) ──
        # depo_stok_kalem_kodu NULL olan tüm aktif ürünlere kendi UUID'lerini ata.
        # Böylece isim bazlı otomatik çözme mantığına hiç düşülmez; her ürün kendi
        # satırını kontrol eder. Havuza bağlanması gerekenler admin panelinden elle ayarlanır.
        cur.execute("SAVEPOINT sp_urun_uuid_blok")
        try:
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='siparis_urun_depo_kalem_kodu_uuid_v5' LIMIT 1
            """)
            if not cur.fetchone():
                cur.execute("""
                    UPDATE siparis_urun
                    SET depo_stok_kalem_kodu = id::text,
                        guncelleme = NOW()
                    WHERE depo_stok_kalem_kodu IS NULL
                      AND aktif = TRUE
                """)
                v5_count = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('siparis_urun_depo_kalem_kodu_uuid_v5', %s::jsonb)
                """, (f'{{"guncellenen_urun": {v5_count}}}',))
                print(f"[MIGRATION] siparis_urun_depo_kalem_kodu_uuid_v5: {v5_count} ürüne UUID atandı")

            # Migration v6: havuz koduna kilitli ürünler de kendi UUID'lerine kavuşur
            # v5 sadece NULL olanları düzeltti; kahve_paket/bardak_kucuk vb. pool koda
            # explicit bağlı ürünler (filtre, dibek, espresso...) hâlâ 71 gösteriyordu.
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='siparis_urun_depo_kalem_kodu_uuid_v6' LIMIT 1
            """)
            if not cur.fetchone():
                _havuz_kodlari = (
                    'kahve_paket','bardak_kucuk','bardak_buyuk','bardak_plastik',
                    'su_adet','redbull_adet','soda_adet','cookie_adet','pasta_adet',
                )
                cur.execute("""
                    UPDATE siparis_urun
                    SET depo_stok_kalem_kodu = id::text,
                        guncelleme = NOW()
                    WHERE depo_stok_kalem_kodu = ANY(%s)
                      AND aktif = TRUE
                """, (_havuz_kodlari,))
                v6_count = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('siparis_urun_depo_kalem_kodu_uuid_v6', %s::jsonb)
                """, (f'{{"guncellenen_urun": {v6_count}}}',))
                print(f"[MIGRATION] siparis_urun_depo_kalem_kodu_uuid_v6: {v6_count} ürün havuz kodundan UUID'ye geçirildi")

            # Migration v6b: artık hiçbir ürünün kullanmadığı pool satırlarını sıfırla
            # (kahve_paket=71 gibi sahipsiz girişler temizlenir)
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='sube_depo_stok_havuz_sifirla_v6b' LIMIT 1
            """)
            if not cur.fetchone():
                _havuz_kodlari = (
                    'kahve_paket','bardak_kucuk','bardak_buyuk','bardak_plastik',
                    'su_adet','redbull_adet','soda_adet','cookie_adet','pasta_adet',
                )
                cur.execute("""
                    UPDATE sube_depo_stok
                    SET mevcut_adet = 0, rezerve_adet = 0, guncelleme = NOW()
                    WHERE kalem_kodu = ANY(%s)
                """, (_havuz_kodlari,))
                v6b_count = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('sube_depo_stok_havuz_sifirla_v6b', %s::jsonb)
                """, (f'{{"sifirlanan_satir": {v6b_count}}}',))
                print(f"[MIGRATION] sube_depo_stok_havuz_sifirla_v6b: {v6b_count} havuz satırı sıfırlandı")

            # Migration v7: havuz satırlarını tamamen sil (sıfır değil DELETE)
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='sube_depo_stok_havuz_delete_v7' LIMIT 1
            """)
            if not cur.fetchone():
                _havuz_kodlari = (
                    'kahve_paket','bardak_kucuk','bardak_buyuk','bardak_plastik',
                    'su_adet','redbull_adet','soda_adet','cookie_adet','pasta_adet',
                    'sut_litre','surup_adet','karton_bardak','kapak_adet',
                    'pecete_paket','diger_sarf',
                )
                cur.execute("""
                    DELETE FROM sube_depo_stok
                    WHERE kalem_kodu = ANY(%s)
                """, (_havuz_kodlari,))
                v7_count = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('sube_depo_stok_havuz_delete_v7', %s::jsonb)
                """, (f'{{"silinen_satir": {v7_count}}}',))
                print(f"[MIGRATION] sube_depo_stok_havuz_delete_v7: {v7_count} havuz satırı tamamen silindi")

            # Migration v8: HER aktif ürün KOŞULSUZ kendi UUID'sine bağlanır (1-to-1 zorlama)
            # v6 sadece havuz kodlu ürünleri düzeltti; ama bir ürün BAŞKA bir ürünün
            # UUID'sine bağlıysa (örn. dibek → filtre.id) ikisi aynı satıra çözümleniyordu;
            # depo ekranı toplamı iki ürünün de karşısına yazıyordu. Bu migration her ürünü
            # kendi UUID'sine sabitleyerek çapraz bağ kalıntılarını siler.
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='siparis_urun_depo_kalem_kodu_uuid_v8' LIMIT 1
            """)
            if not cur.fetchone():
                cur.execute("""
                    UPDATE siparis_urun
                    SET depo_stok_kalem_kodu = id::text,
                        guncelleme = NOW()
                    WHERE aktif = TRUE
                      AND depo_stok_kalem_kodu IS DISTINCT FROM id::text
                """)
                v8_count = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('siparis_urun_depo_kalem_kodu_uuid_v8', %s::jsonb)
                """, (f'{{"guncellenen_urun": {v8_count}}}',))
                print(f"[MIGRATION] siparis_urun_depo_kalem_kodu_uuid_v8: {v8_count} ürün kendi UUID'sine sabitlendi")

            # Migration v8b: çapraz bağ döneminden kalan tüm sube_depo_stok satırlarını sıfırla
            # Artık her ürün kendi UUID'sinde; eski karışık (toplanmış) değerler yanlış.
            # Kullanıcı teslim al'dan gerçek adetleri yeniden girecek.
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='sube_depo_stok_sifirla_v8b' LIMIT 1
            """)
            if not cur.fetchone():
                cur.execute("""
                    UPDATE sube_depo_stok
                    SET mevcut_adet = 0, rezerve_adet = 0, guncelleme = NOW()
                    WHERE mevcut_adet <> 0 OR rezerve_adet <> 0
                """)
                v8b_count = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('sube_depo_stok_sifirla_v8b', %s::jsonb)
                """, (f'{{"sifirlanan_satir": {v8b_count}}}',))
                print(f"[MIGRATION] sube_depo_stok_sifirla_v8b: {v8b_count} stok satırı sıfırlandı")

            # Migration v9: TÜM ürünler (pasif dahil) kendi UUID'sine + doğrulama
            # v8 sadece aktif ürünleri kapsadı. Pasif bir ürün tekrar aktifleştirilirse
            # çapraz bağ geri gelebilirdi. Burada koşulsuz herkesi kendi UUID'sine sabitliyoruz
            # ve sonrasında çakışma (aynı kodu paylaşan ürün) kalmadığını doğrulayıp logluyoruz.
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='siparis_urun_depo_kalem_kodu_uuid_v9' LIMIT 1
            """)
            if not cur.fetchone():
                cur.execute("""
                    UPDATE siparis_urun
                    SET depo_stok_kalem_kodu = id::text,
                        guncelleme = NOW()
                    WHERE depo_stok_kalem_kodu IS DISTINCT FROM id::text
                """)
                v9_count = cur.rowcount
                # Doğrulama: aynı depo_stok_kalem_kodu'yu paylaşan ürün kaldı mı?
                cur.execute("""
                    SELECT COUNT(*) AS dup FROM (
                        SELECT depo_stok_kalem_kodu
                        FROM siparis_urun
                        WHERE depo_stok_kalem_kodu IS NOT NULL
                        GROUP BY depo_stok_kalem_kodu
                        HAVING COUNT(*) > 1
                    ) t
                """)
                _dup_row = cur.fetchone()
                _dup = int((dict(_dup_row).get("dup") if _dup_row else 0) or 0)
                # Doğrulama: kendi UUID'sine bağlı OLMAYAN ürün kaldı mı?
                cur.execute("""
                    SELECT COUNT(*) AS bad FROM siparis_urun
                    WHERE depo_stok_kalem_kodu IS DISTINCT FROM id::text
                """)
                _bad_row = cur.fetchone()
                _bad = int((dict(_bad_row).get("bad") if _bad_row else 0) or 0)
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('siparis_urun_depo_kalem_kodu_uuid_v9', %s::jsonb)
                """, (f'{{"guncellenen_urun": {v9_count}, "kalan_cakisma": {_dup}, "kendine_bagli_olmayan": {_bad}}}',))
                print(f"[MIGRATION] siparis_urun_depo_kalem_kodu_uuid_v9: "
                      f"{v9_count} ürün sabitlendi | kalan_cakisma={_dup} | kendine_bagli_olmayan={_bad}")
                if _dup == 0 and _bad == 0:
                    print("[MIGRATION] ✓ DOĞRULANDI: her ürün kendine ait tekil UUID'ye bağlı, çakışma yok")
                else:
                    print(f"[MIGRATION] ⚠ UYARI: çakışma={_dup}, kendine_bagli_olmayan={_bad} — incelenmeli")

            # Migration v10: temiz test zemini — tüm şube depo stoklarını sıfırla
            # (önceki tekrarlı testlerden biriken değerleri temizle; kullanıcı tek temiz
            #  teslim al ile doğrulayabilsin)
            cur.execute("""
                SELECT 1 FROM finans_migration_log
                WHERE ad='sube_depo_stok_temiz_zemin_v10' LIMIT 1
            """)
            if not cur.fetchone():
                cur.execute("""
                    UPDATE sube_depo_stok
                    SET mevcut_adet = 0, rezerve_adet = 0, guncelleme = NOW()
                    WHERE mevcut_adet <> 0 OR rezerve_adet <> 0
                """)
                v10_count = cur.rowcount
                cur.execute("""
                    INSERT INTO finans_migration_log (ad, detay)
                    VALUES ('sube_depo_stok_temiz_zemin_v10', %s::jsonb)
                """, (f'{{"sifirlanan_satir": {v10_count}}}',))
                print(f"[MIGRATION] sube_depo_stok_temiz_zemin_v10: {v10_count} stok satırı sıfırlandı")
        except Exception as _mig_e:
            try: cur.execute("ROLLBACK TO SAVEPOINT sp_urun_uuid_blok")
            except: pass
            print(f"[MIGRATION WARN] siparis_urun_depo_kalem_kodu_uuid_v5: {_mig_e}")

        # ─── RAPOR CACHE TABLOLARI (raporlama hızlandırma) — savepoint ile safe ──
        # Her CREATE ayrı savepoint'te — biri patlasa diğerleri etkilenmez.
        for _ddl_ad, _ddl in [
            ("rapor_gunluk_sube_ozet", """
                CREATE TABLE IF NOT EXISTS rapor_gunluk_sube_ozet (
                    sube_id         TEXT NOT NULL,
                    tarih           DATE NOT NULL,
                    ciro_nakit      NUMERIC(14,2) NOT NULL DEFAULT 0,
                    ciro_pos        NUMERIC(14,2) NOT NULL DEFAULT 0,
                    ciro_online     NUMERIC(14,2) NOT NULL DEFAULT 0,
                    ciro_toplam     NUMERIC(14,2) NOT NULL DEFAULT 0,
                    ciro_durum      TEXT,
                    fis_sayisi      INTEGER NOT NULL DEFAULT 0,
                    kasa_acilis     NUMERIC(14,2) NOT NULL DEFAULT 0,
                    kasa_kapanis    NUMERIC(14,2) NOT NULL DEFAULT 0,
                    kasa_teslim     NUMERIC(14,2) NOT NULL DEFAULT 0,
                    kasa_devir      NUMERIC(14,2) NOT NULL DEFAULT 0,
                    ara_teslim      NUMERIC(14,2) NOT NULL DEFAULT 0,
                    kasa_fark_tl    NUMERIC(14,2),
                    kasa_fark_durum TEXT,
                    anlik_gider_nakit NUMERIC(14,2) NOT NULL DEFAULT 0,
                    anlik_gider_kart  NUMERIC(14,2) NOT NULL DEFAULT 0,
                    anlik_gider_adet  INTEGER NOT NULL DEFAULT 0,
                    acilis_yapildi    BOOLEAN NOT NULL DEFAULT FALSE,
                    kapanis_yapildi   BOOLEAN NOT NULL DEFAULT FALSE,
                    acilis_personel   TEXT,
                    kapanis_personel  TEXT,
                    guncelleme        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    kaynak            TEXT NOT NULL DEFAULT 'batch',
                    PRIMARY KEY (sube_id, tarih)
                )
            """),
            ("idx_rapor_gunluk_tarih",
                "CREATE INDEX IF NOT EXISTS idx_rapor_gunluk_tarih ON rapor_gunluk_sube_ozet (tarih DESC, sube_id)"),
            ("rapor_gunluk_urun_ozet", """
                CREATE TABLE IF NOT EXISTS rapor_gunluk_urun_ozet (
                    sube_id         TEXT NOT NULL,
                    tarih           DATE NOT NULL,
                    kalem_kodu      TEXT NOT NULL,
                    kalem_adi       TEXT,
                    acilan_adet     INTEGER NOT NULL DEFAULT 0,
                    sevk_adet       INTEGER NOT NULL DEFAULT 0,
                    kullanilan_adet INTEGER NOT NULL DEFAULT 0,
                    kalan_adet      INTEGER NOT NULL DEFAULT 0,
                    guncelleme      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (sube_id, tarih, kalem_kodu)
                )
            """),
            ("idx_rapor_urun_tarih",
                "CREATE INDEX IF NOT EXISTS idx_rapor_urun_tarih ON rapor_gunluk_urun_ozet (tarih DESC, sube_id)"),
            ("rapor_aylik_food_cost", """
                CREATE TABLE IF NOT EXISTS rapor_aylik_food_cost (
                    sube_id         TEXT NOT NULL,
                    year_month      TEXT NOT NULL,
                    toplam_ciro     NUMERIC(14,2) NOT NULL DEFAULT 0,
                    toplam_gider    NUMERIC(14,2) NOT NULL DEFAULT 0,
                    anlik_gider     NUMERIC(14,2) NOT NULL DEFAULT 0,
                    sabit_gider     NUMERIC(14,2) NOT NULL DEFAULT 0,
                    food_cost_pct   NUMERIC(6,2),
                    fis_sayisi      INTEGER NOT NULL DEFAULT 0,
                    ortalama_fis_tutari NUMERIC(14,2),
                    guncelleme      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (sube_id, year_month)
                )
            """),
            ("idx_rapor_aylik_ym",
                "CREATE INDEX IF NOT EXISTS idx_rapor_aylik_ym ON rapor_aylik_food_cost (year_month DESC, sube_id)"),
            ("rapor_batch_log", """
                CREATE TABLE IF NOT EXISTS rapor_batch_log (
                    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                    batch_tipi      TEXT NOT NULL,
                    baslangic_ts    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    bitis_ts        TIMESTAMPTZ,
                    durum           TEXT NOT NULL DEFAULT 'calisiyor',
                    islenen_kayit   INTEGER NOT NULL DEFAULT 0,
                    sure_ms         INTEGER,
                    hata_mesaji     TEXT,
                    detay           JSONB
                )
            """),
            ("idx_rapor_batch_baslangic",
                "CREATE INDEX IF NOT EXISTS idx_rapor_batch_baslangic ON rapor_batch_log (baslangic_ts DESC)"),
        ]:
            try:
                cur.execute(f"SAVEPOINT sp_rc_{_ddl_ad[:30]}")
                cur.execute(_ddl)
                cur.execute(f"RELEASE SAVEPOINT sp_rc_{_ddl_ad[:30]}")
            except Exception as _e:
                try:
                    cur.execute(f"ROLLBACK TO SAVEPOINT sp_rc_{_ddl_ad[:30]}")
                except Exception:
                    pass
                print(f"[MIGRATION WARN] rapor_cache {_ddl_ad}: {_e}")

        # ── FIX: kismi_hazirlandi + stok_yolda → gonderildi / teslim_edildi ───
        # hesapla_yeni_sevkiyat_durumu hatası: "Yola Çıkar" basılmış ama bekleyen_var/
        # kismi_var True olduğu için sevkiyat_durumu='kismi_hazirlandi' kalmış.
        # Güvenlik kriteri: stok_yolda kaydı var → stok fiilen depodan çıktı (araç yola çıktı).
        # SAVEPOINT: migration başarısız olursa sadece bu blok geri alınır, server başlar.
        try:
            cur.execute("SAVEPOINT sp_fix_kismi_hazirlandi")
            # 1) Hâlâ yolda olan veya kabul'ü karışık olan → gonderildi
            cur.execute("""
                UPDATE siparis_talep t
                SET sevkiyat_durumu = 'gonderildi',
                    sevkiyat_durum  = 'gonderildi',
                    durum           = 'gonderildi'
                WHERE t.sevkiyat_durumu = 'kismi_hazirlandi'
                  AND t.durum IN ('hazirlaniyor', 'bekliyor')
                  AND EXISTS (
                      SELECT 1 FROM stok_yolda sy
                      WHERE sy.siparis_talep_id = t.id
                  )
            """)
            fixed1 = cur.rowcount
            # 2) Tüm stok_yolda kalemleri kabul edilmiş ama durum hâlâ hazirlaniyor →
            #    teslim_edildi (stok_yolda en az 1 kayıt, hepsi kabul_edildi veya uzlasildi)
            cur.execute("""
                UPDATE siparis_talep t
                SET sevkiyat_durumu = 'teslim_edildi',
                    sevkiyat_durum  = 'teslim_edildi',
                    durum           = 'teslim_edildi'
                WHERE t.sevkiyat_durumu IN ('kismi_hazirlandi', 'gonderildi')
                  AND t.durum IN ('hazirlaniyor', 'gonderildi')
                  AND EXISTS (
                      SELECT 1 FROM stok_yolda sy
                      WHERE sy.siparis_talep_id = t.id
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM stok_yolda sy
                      WHERE sy.siparis_talep_id = t.id
                        AND sy.durum NOT IN ('kabul_edildi', 'uzlasildi')
                  )
            """)
            fixed2 = cur.rowcount
            cur.execute("RELEASE SAVEPOINT sp_fix_kismi_hazirlandi")
            if fixed1 or fixed2:
                print(f"[MIGRATION] stuck-sevkiyat fix: {fixed1} → gonderildi, {fixed2} → teslim_edildi")
        except Exception as _fix_e:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_fix_kismi_hazirlandi")
            except Exception:
                pass
            print(f"[MIGRATION WARN] kismi_hazirlandi fix: {_fix_e}")

        # Fix: kalem_durumlari içinde «bekliyor» kalan siparişler → «yok» ile kapat
        # Yola Çıkar sonrası dokunulmayan kalemler artık «yok» olarak kaydedilecek;
        # bu migration eski kayıtlardaki bekliyor→yok dönüşümünü uygular.
        try:
            cur.execute("SAVEPOINT sp_fix_bekliyor_kalemler")
            cur.execute("""
                UPDATE siparis_talep t
                SET kalem_durumlari = (
                    SELECT jsonb_agg(
                        CASE
                          WHEN LOWER(COALESCE(kd->>'durum','')) = 'bekliyor'
                          THEN kd || jsonb_build_object('durum','yok','gonderilen_adet',0)
                          ELSE kd
                        END
                    )
                    FROM jsonb_array_elements(COALESCE(t.kalem_durumlari, '[]'::jsonb)) AS kd
                )
                WHERE t.durum = 'gonderildi'
                  AND t.kalem_durumlari IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(t.kalem_durumlari) kd
                      WHERE LOWER(COALESCE(kd->>'durum','')) = 'bekliyor'
                  )
            """)
            fixed3 = cur.rowcount
            cur.execute("RELEASE SAVEPOINT sp_fix_bekliyor_kalemler")
            if fixed3:
                print(f"[MIGRATION] bekliyor→yok fix: {fixed3} sipariş kalem_durumlari güncellendi")
        except Exception as _fix3_e:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_fix_bekliyor_kalemler")
            except Exception:
                pass
            print(f"[MIGRATION WARN] bekliyor→yok fix: {_fix3_e}")

        # ── Fix: Zafer şubesi hatalı Ürün Aç kaydı — Pipet ↔ Plastik Bardak takas ──
        # 2026-05-25 tarihinde Pipet alanına 48 girildi, Plastik Bardak girilmedi.
        # Doğrusu: Pipet=0, Plastik Bardak=48.
        # operasyon_defter append-only olduğu için trigger geçici devre dışı bırakılır.
        try:
            import json as _jfix
            # Zafer şubesinin sube_id'sini bul
            cur.execute("SELECT id FROM subeler WHERE LOWER(ad) LIKE '%zafer%' LIMIT 1")
            _zafer_row = cur.fetchone()
            if _zafer_row:
                _zafer_sid = _zafer_row["id"]
                cur.execute("""
                    SELECT id, aciklama
                    FROM operasyon_defter
                    WHERE sube_id = %s
                      AND etiket = 'URUN_AC'
                      AND tarih >= CURRENT_DATE - INTERVAL '3 days'
                      AND aciklama LIKE '%%pipet%%'
                    ORDER BY olusturma DESC
                    LIMIT 1
                """, (_zafer_sid,))
                _ac_row = cur.fetchone()
                if _ac_row:
                    _rec_id = _ac_row["id"]
                    _aciklama = str(_ac_row["aciklama"] or "")
                    # JSON'u ayır
                    _prefix = ""
                    _raw = _aciklama
                    if _aciklama.startswith("URUN_AC_JSON:"):
                        _prefix = "URUN_AC_JSON:"
                        _raw = _aciklama[len("URUN_AC_JSON:"):]
                    _suffix = ""
                    if " | " in _raw:
                        _parts = _raw.split(" | ", 1)
                        _raw = _parts[0].strip()
                        _suffix = " | " + _parts[1]
                    try:
                        _payload = _jfix.loads(_raw)
                    except Exception:
                        _payload = {}
                    if _payload:
                        _kalemler = _payload.get("kalemler") or []
                        # Sadece gerçekten hatalı kayıt varsa düzelt (idempotens)
                        _pipet_yanlis = any(
                            "pipet" in str(it.get("urun_ad") or "").lower()
                            and int(it.get("adet") or 0) > 0
                            for it in _kalemler
                            if isinstance(it, dict)
                        )
                        if _pipet_yanlis:
                            # Trigger'ı geçici durdur
                            cur.execute(
                                "ALTER TABLE operasyon_defter "
                                "DISABLE TRIGGER tr_operasyon_defter_append_only"
                            )
                            try:
                                _plastik_bulundu = False
                                _yeni_kalemler = []
                                for _it in _kalemler:
                                    if not isinstance(_it, dict):
                                        _yeni_kalemler.append(_it)
                                        continue
                                    _ad = str(_it.get("urun_ad") or "").strip().lower()
                                    if "pipet" in _ad:
                                        _it = dict(_it)
                                        _it["adet"] = 0
                                    elif "plastik" in _ad and "bardak" in _ad:
                                        _it = dict(_it)
                                        _it["adet"] = 48
                                        _plastik_bulundu = True
                                    _yeni_kalemler.append(_it)
                                if not _plastik_bulundu:
                                    _yeni_kalemler.append({"urun_ad": "Plastik Bardak", "adet": 48})
                                _payload["kalemler"] = _yeni_kalemler
                                # delta alanını da düzelt
                                _delta = _payload.get("delta") or {}
                                if isinstance(_delta, dict):
                                    for _dk in list(_delta.keys()):
                                        if "pipet" in str(_dk).lower():
                                            _delta[_dk] = 0
                                    _delta["bardak_plastik"] = 48
                                    _payload["delta"] = _delta
                                _yeni_aciklama = _prefix + _jfix.dumps(
                                    _payload, ensure_ascii=False, separators=(",", ":")
                                ) + _suffix
                                cur.execute(
                                    "UPDATE operasyon_defter SET aciklama = %s WHERE id = %s",
                                    (_yeni_aciklama, _rec_id),
                                )
                                print(f"[MIGRATION] Zafer Ürün Aç düzeltmesi: pipet→0, plastik_bardak→48 (id={_rec_id})")
                            finally:
                                cur.execute(
                                    "ALTER TABLE operasyon_defter "
                                    "ENABLE TRIGGER tr_operasyon_defter_append_only"
                                )
                        else:
                            print("[MIGRATION] Zafer Ürün Aç: pipet değeri zaten 0, düzeltme gerekmedi")
                    else:
                        print("[MIGRATION] Zafer Ürün Aç: JSON parse edilemedi, atlandı")
                else:
                    print("[MIGRATION] Zafer Ürün Aç: son 3 günde pipet içeren kayıt bulunamadı")
            else:
                print("[MIGRATION] Zafer Ürün Aç: Zafer şubesi DB'de bulunamadı")
        except Exception as _fix4_e:
            # Trigger mutlaka tekrar etkinleştir
            try:
                cur.execute(
                    "ALTER TABLE operasyon_defter "
                    "ENABLE TRIGGER tr_operasyon_defter_append_only"
                )
            except Exception:
                pass
            print(f"[MIGRATION WARN] Zafer Ürün Aç düzeltmesi: {_fix4_e}")

        # ── Fix: sarf kategorisinde bardak sıralarını öne al ──
        # Plastik Bardak=5, 14oz Bardak=10, 8oz Bardak=15, Pipet=20
        # Yanlış giriş riskini azaltmak: en sık kullanılan malzeme en üstte.
        try:
            cur.execute("""
                UPDATE siparis_urun su
                SET sira = v.yeni_sira
                FROM (VALUES
                    ('plastik_bardak', 5),
                    ('14oz_bardak',    10),
                    ('8oz_bardak',     15),
                    ('pipet',          20),
                    ('pos_kagidi',     30),
                    ('kalem',          40),
                    ('filtre_kagidi',  50)
                ) AS v(norm_ad, yeni_sira),
                siparis_kategori sk
                WHERE sk.id = su.kategori_id
                  AND sk.kod = 'sarf'
                  AND su.norm_ad = v.norm_ad
                  AND su.sira <> v.yeni_sira
            """)
            if cur.rowcount:
                print(f"[MIGRATION] sarf sira güncellendi: {cur.rowcount} satır")
        except Exception as _fix5_e:
            print(f"[MIGRATION WARN] sarf sira: {_fix5_e}")

        # ── Migration: kartlar.son_dort_hane — PDF ekstre eşleştirme ──
        try:
            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name='kartlar' AND column_name='son_dort_hane'
                    ) THEN
                        ALTER TABLE kartlar ADD COLUMN son_dort_hane TEXT;
                        RAISE NOTICE 'kartlar.son_dort_hane kolonu eklendi';
                    END IF;
                END $$;
            """)
            print("[MIGRATION] kartlar.son_dort_hane kolonu kontrol edildi")
        except Exception as _fix6_e:
            print(f"[MIGRATION WARN] kartlar son_dort_hane: {_fix6_e}")

        # ── EVO PERSONEL CACHE — a_per_id → SATIS_PER (isim) eşleşmesi ──
        # Evo POS'ta personel kendi hesabıyla giriş yaptığında SATIS_PER ismi gelir.
        # Ortak hesap kullanıldığında SATIS_PER boş kalır; bu tablo geçmiş taramasıyla
        # doldurulan bir hafıza görevi görür: bir kez isim geldi mi, sonra da kullanılır.
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evo_personel_cache (
                    personel_id TEXT PRIMARY KEY,
                    ad          TEXT NOT NULL,
                    guncelleme  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            print("[MIGRATION] evo_personel_cache tablosu kontrol edildi")
        except Exception as _epc_e:
            print(f"[MIGRATION WARN] evo_personel_cache: {_epc_e}")

        # ── EVO RAPOR CACHE — son başarılı çekim (ürün satışları / şube analiz) ──
        # Evo (hs_rapor.ashx) anlık çekim başarısız olursa (token süresi, bağlantı
        # vb.) son başarılı sonuç + çekim zamanı burada saklanır, ekranda
        # "son veri çekimi: TT.AA.YYYY SS:DD" olarak gösterilir.
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evo_rapor_cache (
                    anahtar    TEXT NOT NULL,
                    bastar     DATE NOT NULL,
                    bittar     DATE NOT NULL,
                    veri_json  JSONB NOT NULL,
                    cekim_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (anahtar, bastar, bittar)
                )
            """)
            print("[MIGRATION] evo_rapor_cache tablosu kontrol edildi")
        except Exception as _erc_e:
            print(f"[MIGRATION WARN] evo_rapor_cache: {_erc_e}")

        # ── YARIŞMA SİSTEMİ ──────────────────────────────────────────────────
        # CFO her dönem yeni yarışma tanımlar (ürün, grup veya toplam metrik).
        # Şube paneli aktif yarışmayı + sıralamayı personele gösterir.
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS yarisma (
                    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                    baslik          TEXT NOT NULL,
                    aciklama        TEXT,
                    odul            TEXT,
                    metrik          TEXT NOT NULL DEFAULT 'adet'
                                    CHECK (metrik IN ('adet','ciro','fis_sayisi')),
                    filtre_turu     TEXT NOT NULL DEFAULT 'tumu'
                                    CHECK (filtre_turu IN ('tumu','grup','urun_adi')),
                    filtre_deger    TEXT,
                    bastar          DATE NOT NULL,
                    bittar          DATE NOT NULL,
                    aktif           BOOLEAN NOT NULL DEFAULT TRUE,
                    tum_subeler     BOOLEAN NOT NULL DEFAULT TRUE,
                    olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    guncelleme      TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_yarisma_aktif_tarih
                ON yarisma (aktif, bittar DESC)
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS yarisma_skor (
                    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                    yarisma_id      TEXT NOT NULL REFERENCES yarisma(id) ON DELETE CASCADE,
                    personel_id     TEXT NOT NULL,
                    personel_ad     TEXT NOT NULL,
                    sube_id         TEXT,
                    sube_ad         TEXT,
                    deger           NUMERIC(14,2) NOT NULL DEFAULT 0,
                    sira            INT,
                    guncelleme      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (yarisma_id, personel_id)
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_yarisma_skor_yarisma_sira
                ON yarisma_skor (yarisma_id, sira)
            """)
            print("[MIGRATION] yarisma + yarisma_skor tabloları kontrol edildi")
        except Exception as _yar_e:
            print(f"[MIGRATION WARN] yarisma tabloları: {_yar_e}")

        # ── EV TASARIM (kişisel araç) ───────────────────────────
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ev_tasarim_oda (
                    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    isim        TEXT NOT NULL,
                    genislik_m  NUMERIC,
                    uzunluk_m   NUMERIC,
                    yukseklik_m NUMERIC,
                    notlar      TEXT,
                    olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ev_tasarim_gorsel (
                    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    oda_id      UUID NOT NULL REFERENCES ev_tasarim_oda(id) ON DELETE CASCADE,
                    tip         TEXT NOT NULL,
                    veri        BYTEA NOT NULL,
                    mime        TEXT NOT NULL,
                    prompt      TEXT,
                    olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS ev_tasarim_maliyet (
                    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    oda_id      UUID NOT NULL REFERENCES ev_tasarim_oda(id) ON DELETE CASCADE,
                    gorsel_id   UUID REFERENCES ev_tasarim_gorsel(id) ON DELETE CASCADE,
                    icerik      JSONB NOT NULL,
                    olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_ev_tasarim_gorsel_oda
                ON ev_tasarim_gorsel (oda_id, tip)
            """)
            print("[MIGRATION] ev_tasarim tabloları kontrol edildi")
        except Exception as _ev_e:
            print(f"[MIGRATION WARN] ev_tasarim tabloları: {_ev_e}")

        # ── AKILLI DENETİM — AI YORUM ARŞİVİ ────────────────────
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS akilli_denetim_ai_yorum (
                    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    tarih       DATE NOT NULL UNIQUE,
                    ozetler     JSONB,
                    yorum       TEXT NOT NULL,
                    kaynak      TEXT,
                    olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """)
            print("[MIGRATION] akilli_denetim_ai_yorum tablosu kontrol edildi")
        except Exception as _akd_e:
            print(f"[MIGRATION WARN] akilli_denetim_ai_yorum tablosu: {_akd_e}")

        conn.commit()

    # ── GÖREV ÇİZELGESİ — ayrı bağlantıda (aborted tx'den etkilenmesin) ──
    try:
        with db() as (_gc, _gcur):
            ensure_gorev_tablolari(_gcur)
            _gc.commit()
    except Exception as _ge:
        print(f"[MIGRATION WARN] gorev_tablolari: {_ge}")


def ensure_gorev_tablolari(cur) -> None:
    """Görev şablonu + günlük tamamlama tablolarını oluşturur."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gorev_sablonu (
            id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            vardiya_tip TEXT NOT NULL CHECK (vardiya_tip IN ('sabahci','ara_vardiya','kapanis')),
            sira        INT NOT NULL DEFAULT 0,
            alan        TEXT NOT NULL,
            gorev       TEXT NOT NULL,
            siklik      TEXT,
            aktif       BOOLEAN NOT NULL DEFAULT TRUE,
            olusturma   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gorev_tamamlama (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            tarih           DATE NOT NULL,
            sube_id         TEXT NOT NULL REFERENCES subeler(id),
            sablonid        TEXT NOT NULL REFERENCES gorev_sablonu(id),
            tamamlandi      BOOLEAN NOT NULL DEFAULT FALSE,
            personel_id     TEXT,
            tamamlanma_ts   TIMESTAMPTZ,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tarih, sube_id, sablonid)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_gorev_tamamlama_tarih_sube
        ON gorev_tamamlama (tarih, sube_id)
    """)
    # Şube koordinat kolonları (konum doğrulama için)
    cur.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='subeler' AND column_name='lat')
            THEN ALTER TABLE subeler ADD COLUMN lat DOUBLE PRECISION; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='subeler' AND column_name='lng')
            THEN ALTER TABLE subeler ADD COLUMN lng DOUBLE PRECISION; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='subeler' AND column_name='konum_radius_m')
            THEN ALTER TABLE subeler ADD COLUMN konum_radius_m INT NOT NULL DEFAULT 150; END IF;
        END $$;
    """)
    # Personel yoklama kaydı (QR giriş = şubede fiziksel bulunma kanıtı)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS gorev_yoklama (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            tarih           DATE NOT NULL,
            sube_id         TEXT NOT NULL REFERENCES subeler(id),
            personel_id     TEXT NOT NULL,
            vardiya_tip     TEXT NOT NULL,
            giris_ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            konum_mesafe_m  DOUBLE PRECISION,
            konum_onaylandi BOOLEAN NOT NULL DEFAULT FALSE,
            vardiya_disi    BOOLEAN NOT NULL DEFAULT FALSE,
            asil_sube_id    TEXT,
            UNIQUE (tarih, sube_id, personel_id, vardiya_tip)
        )
    """)
    cur.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='gorev_yoklama' AND column_name='vardiya_disi')
            THEN ALTER TABLE gorev_yoklama ADD COLUMN vardiya_disi BOOLEAN NOT NULL DEFAULT FALSE; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='gorev_yoklama' AND column_name='asil_sube_id')
            THEN ALTER TABLE gorev_yoklama ADD COLUMN asil_sube_id TEXT; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='gorev_yoklama' AND column_name='cikis_ts')
            THEN ALTER TABLE gorev_yoklama ADD COLUMN cikis_ts TIMESTAMPTZ; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='gorev_yoklama' AND column_name='cikis_tip')
            THEN ALTER TABLE gorev_yoklama ADD COLUMN cikis_tip TEXT; END IF;
            -- 'kasa_devri' | 'kapalis' | 'manuel'
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='gorev_yoklama' AND column_name='cikis_gun')
            THEN ALTER TABLE gorev_yoklama ADD COLUMN cikis_gun DATE; END IF;
            -- Çıkışın (cikis_ts) GERÇEKLEŞTİĞİ takvim günü — 'tarih' (vardiyanın
            -- atandığı iş günü) ile aynı olmayabilir (örn. gece yarısını geçen
            -- mesai, ertesi gün yapılan kapanış mührü/kasa devri vb.)
            -- Mühür tipi: NULL/'NORMAL' (personel QR) | 'YONETICI_OVERRIDE' (sahip Cep'ten).
            -- Denetimde görsel ayrım için (GPT tasarımı: override normalle aynı görünmesin).
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='gorev_yoklama' AND column_name='muhur_tipi')
            THEN ALTER TABLE gorev_yoklama ADD COLUMN muhur_tipi TEXT; END IF;
        END $$;
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_gorev_yoklama_tarih_sube
        ON gorev_yoklama (tarih, sube_id)
    """)

    # ── YEMEK MOLASI TAKİBİ ────────────────────────────────────────────
    # Şube bazlı yemek molası süresi tanımı
    cur.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='subeler' AND column_name='yemek_mola_limit_dk')
            THEN ALTER TABLE subeler ADD COLUMN yemek_mola_limit_dk INT NOT NULL DEFAULT 60; END IF;
        END $$;
    """)
    # Personel yemek molası kayıtları
    cur.execute("""
        CREATE TABLE IF NOT EXISTS yemek_molasi (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            tarih           DATE NOT NULL,
            sube_id         TEXT NOT NULL REFERENCES subeler(id),
            personel_id     TEXT NOT NULL,
            baslangic_ts    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            bitis_ts        TIMESTAMPTZ,
            sure_dk         NUMERIC(6,1),
            ucret_hakki     BOOLEAN,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tarih, sube_id, personel_id)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_yemek_molasi_tarih_sube
        ON yemek_molasi (tarih, sube_id)
    """)

    # ── PERSONEL AYLIK — gecikme + yemek kolonları ─────────────────────
    cur.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='personel_aylik' AND column_name='gecikme_dk_toplam')
            THEN ALTER TABLE personel_aylik ADD COLUMN gecikme_dk_toplam NUMERIC(8,1) DEFAULT 0; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='personel_aylik' AND column_name='yemek_ucret_gun')
            THEN ALTER TABLE personel_aylik ADD COLUMN yemek_ucret_gun INT DEFAULT 0; END IF;
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='personel_aylik' AND column_name='yemek_ucret_toplam')
            THEN ALTER TABLE personel_aylik ADD COLUMN yemek_ucret_toplam NUMERIC(14,2) DEFAULT 0; END IF;
        END $$;
    """)

    # ── KASA DEVİR ONAYI ──────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kasa_devir_onay (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            sube_id         TEXT NOT NULL,
            tarih           DATE NOT NULL,
            devreden_id     TEXT NOT NULL,
            devreden_ts     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            kabul_eden_id   TEXT,
            kabul_ts        TIMESTAMPTZ,
            durum           TEXT NOT NULL DEFAULT 'bekliyor',
            not_aciklama    TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            devralan_id     TEXT
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_kasa_devir_onay_sube_tarih
        ON kasa_devir_onay (sube_id, tarih)
    """)
