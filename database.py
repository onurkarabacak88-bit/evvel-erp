import logging
import os
import psycopg2
import psycopg2.extras
import psycopg2.pool
from contextlib import contextmanager
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
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    minconn=2,
                    maxconn=15,
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
                    CHECK (durum IN ('bekliyor','tamamlandi','gecikti','iptal')),
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
            EXCEPTION WHEN others THEN NULL;
            END $$;
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
        # Migration: islem_turu CHECK constraint — eski hali silip yenile.
        # Eski production DB'lerde 'FAIZ' kabul etmeyen versiyon olabilir;
        # bu yüzden DROP + CREATE ile her seferinde güncel hale getiriyoruz.
        cur.execute("""
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.constraint_column_usage
                    WHERE table_name = 'kart_hareketleri'
                    AND constraint_name = 'kart_hareketleri_islem_turu_check'
                ) THEN
                    ALTER TABLE kart_hareketleri
                    DROP CONSTRAINT kart_hareketleri_islem_turu_check;
                END IF;
                ALTER TABLE kart_hareketleri
                ADD CONSTRAINT kart_hareketleri_islem_turu_check
                CHECK (islem_turu IN ('HARCAMA', 'ODEME', 'FAIZ'));
            EXCEPTION WHEN others THEN NULL;
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
            CREATE INDEX IF NOT EXISTS idx_odeme_plani_kaynak
            ON odeme_plani (kaynak_tablo, kaynak_id, durum)
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
                odeme_gunu      INT NOT NULL DEFAULT 28,
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
            EXCEPTION WHEN others THEN NULL;
            END $$;
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
                ('bitki_cayi', 'Bitki Çayları', '🌿', 90)
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
                    ('sarf','Pipet','pipet',10),('sarf','POS Kağıdı','pos_kagidi',20),('sarf','Kalem','kalem',30),('sarf','Filtre Kağıdı','filtre_kagidi',40),('sarf','14oz Bardak','14oz_bardak',50),('sarf','8oz Bardak','8oz_bardak',60),('sarf','Plastik Bardak','plastik_bardak',70),('sarf','Dido Trio','dido_trio',80),('sarf','Oreo','oreo',90),('sarf','Kese Kağıdı','kese_kagidi',100),('sarf','Streç Film','strec_film',110),('sarf','Baskılı Peçete','baskili_pecete',120),('sarf','Baskılı Şeker','baskili_seker',130),('sarf','Bardak Çantası','bardak_cantasi',140),('sarf','Islak Mendil','islak_mendil',150),('sarf','Cam Bezi','cam_bezi',160),('sarf','Zımba Teli','zimba_teli',170),('sarf','Ahşap Karıştırıcı','ahsap_karistirici',180),
                    ('bitki_cayi','Papatya','papatya',10),('bitki_cayi','Kış Çayı','kis_cayi',20),('bitki_cayi','Yeşil Çay','yesil_cay',30),('bitki_cayi','Melisa','melisa',40),('bitki_cayi','Ihlamur','ihlamur',50)
            ) AS v(kod, ad, norm_ad, sira)
            JOIN siparis_kategori k ON k.kod = v.kod
            ON CONFLICT (kategori_id, norm_ad) DO NOTHING
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
                AND kh.ref_type = 'CIRO'
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

        # 2) Personel kısıtları — kişi başına 1 satır
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_kisit (
                personel_id              TEXT PRIMARY KEY REFERENCES personel(id) ON DELETE CASCADE,
                max_gunluk_saat          NUMERIC(4,2) NOT NULL DEFAULT 9,
                max_haftalik_saat        NUMERIC(5,2) NOT NULL DEFAULT 45,
                izinli_subeler           TEXT[] NOT NULL DEFAULT '{}',
                                         -- boş = tüm aktif şubeler
                yasak_subeler            TEXT[] NOT NULL DEFAULT '{}',
                calisilabilir_saat_min   TIME,
                calisilabilir_saat_max   TIME,
                min_gecis_dk             INT NOT NULL DEFAULT 60,
                                         -- şube değişiminde min süre
                guncelleme               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (max_gunluk_saat > 0 AND max_haftalik_saat > 0 AND min_gecis_dk >= 0)
            )
        """)

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
                max_gunluk_saat   NUMERIC(4,2) NOT NULL DEFAULT 9,
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
