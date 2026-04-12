import os
import psycopg2
import psycopg2.extras
import psycopg2.pool
from contextlib import contextmanager
import threading

DATABASE_URL = os.environ.get("DATABASE_URL", "")

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
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    minconn=2,
                    maxconn=15,
                    dsn=DATABASE_URL,
                    cursor_factory=psycopg2.extras.RealDictCursor
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

        # ── ŞUBE PANEL KULLANICI (PIN — vardiya devri vb.) ───────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_panel_kullanici (
                id          TEXT PRIMARY KEY,
                sube_id     TEXT NOT NULL REFERENCES subeler(id),
                ad          TEXT NOT NULL,
                pin_salt    TEXT NOT NULL,
                pin_hash    TEXT NOT NULL,
                aktif       BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma   TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_panel_kul_sube
            ON sube_panel_kullanici (sube_id, aktif)
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

        _s_a, _s_k = "spA1", "spK9"
        h_a = _hmod.sha256(f"{_s_a}:1111".encode()).hexdigest()
        h_k = _hmod.sha256(f"{_s_k}:2222".encode()).hexdigest()
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

        # ── ŞUBE VARDİYA İHTİYAÇLARI ───────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_vardiya_ihtiyac (
                id              TEXT PRIMARY KEY,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                gun_tipi        TEXT NOT NULL DEFAULT 'hergun'
                    CHECK (gun_tipi IN ('hergun','hafta_ici','hafta_sonu','pazartesi','sali','carsamba','persembe','cuma','cumartesi','pazar')),
                rol             TEXT NOT NULL DEFAULT 'genel'
                    CHECK (rol IN ('genel','acilis','kapanis','yogunluk','araci')),
                bas_saat        TEXT NOT NULL,
                bit_saat        TEXT NOT NULL,
                gereken_kisi    SMALLINT NOT NULL DEFAULT 1, -- ideal
                minimum_kisi    SMALLINT NOT NULL DEFAULT 1, -- şube ayakta kalsın diye
                gereken_tur     TEXT NOT NULL DEFAULT 'farketmez'
                    CHECK (gereken_tur IN ('farketmez','tam','part')),
                kritik          BOOLEAN NOT NULL DEFAULT FALSE,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_vardiya_ihtiyac_sube
            ON sube_vardiya_ihtiyac (sube_id, gun_tipi)
        """)

        # Migration: yeni kolonları ekle (eski DB)
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_vardiya_ihtiyac' AND column_name='rol')
                THEN
                    ALTER TABLE sube_vardiya_ihtiyac ADD COLUMN rol TEXT NOT NULL DEFAULT 'genel';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_vardiya_ihtiyac' AND column_name='minimum_kisi')
                THEN
                    ALTER TABLE sube_vardiya_ihtiyac ADD COLUMN minimum_kisi SMALLINT NOT NULL DEFAULT 1;
                END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        # Şube bazlı alternatif kurallar (ideal tutmazsa minimum/alternatif)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_vardiya_alternatif_kural (
                id              TEXT PRIMARY KEY,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                rol             TEXT NOT NULL DEFAULT 'genel'
                    CHECK (rol IN ('genel','acilis','kapanis','yogunluk','araci')),
                gun_tipi        TEXT NOT NULL DEFAULT 'hergun'
                    CHECK (gun_tipi IN ('hergun','hafta_ici','hafta_sonu','pazartesi','sali','carsamba','persembe','cuma','cumartesi','pazar')),
                minimum_kisi    SMALLINT NOT NULL DEFAULT 1,
                ideal_kisi      SMALLINT NOT NULL DEFAULT 1,
                izinli_tam      BOOLEAN NOT NULL DEFAULT TRUE,
                izinli_part     BOOLEAN NOT NULL DEFAULT TRUE,
                mesai_izinli    BOOLEAN NOT NULL DEFAULT FALSE,
                notlar          TEXT,
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_sube_vardiya_alt_kural
            ON sube_vardiya_alternatif_kural (sube_id, rol, gun_tipi)
        """)

        # Şube bazlı otomatik izin kuralı (tek sefer tanımlanır, motor kullanır)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_izin_kural (
                sube_id                  TEXT PRIMARY KEY REFERENCES subeler(id) ON DELETE CASCADE,
                max_izin_pzt             SMALLINT NOT NULL DEFAULT 3,
                max_izin_sal             SMALLINT NOT NULL DEFAULT 3,
                max_izin_car             SMALLINT NOT NULL DEFAULT 3,
                max_izin_per             SMALLINT NOT NULL DEFAULT 2,
                max_izin_cum             SMALLINT NOT NULL DEFAULT 2,
                max_izin_cmt             SMALLINT NOT NULL DEFAULT 1,
                max_izin_paz             SMALLINT NOT NULL DEFAULT 2,
                cumartesi_part_oncelik   BOOLEAN NOT NULL DEFAULT TRUE,
                cumartesi_ikinci_istisna BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma                TIMESTAMP NOT NULL DEFAULT NOW(),
                guncelleme               TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)

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
            END $$;
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

        # ── KARTLAR ────────────────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS kartlar (
                id              TEXT PRIMARY KEY,
                kart_adi        TEXT NOT NULL UNIQUE,
                banka           TEXT NOT NULL,
                limit_tutar     NUMERIC(14,2) NOT NULL DEFAULT 0,
                kesim_gunu      INT NOT NULL DEFAULT 15,
                son_odeme_gunu  INT NOT NULL DEFAULT 25,
                faiz_orani      NUMERIC(5,2) NOT NULL DEFAULT 0,
                asgari_oran     NUMERIC(5,2) NOT NULL DEFAULT 40,
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
        # Migration: islem_turu CHECK constraint — geçersiz tip girişini engeller
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.constraint_column_usage
                    WHERE table_name = 'kart_hareketleri'
                    AND constraint_name = 'kart_hareketleri_islem_turu_check'
                ) THEN
                    ALTER TABLE kart_hareketleri
                    ADD CONSTRAINT kart_hareketleri_islem_turu_check
                    CHECK (islem_turu IN ('HARCAMA', 'ODEME', 'FAIZ'));
                END IF;
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
            END $$;
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_sube_vardiya_yetki (
                id           TEXT PRIMARY KEY,
                personel_id  TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                sube_id      TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                opening      BOOLEAN NOT NULL DEFAULT FALSE,
                closing      BOOLEAN NOT NULL DEFAULT FALSE,
                guncelleme   TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (personel_id, sube_id)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_gun_musaitlik (
                id               TEXT PRIMARY KEY,
                personel_id      TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                hafta_gunu       SMALLINT NOT NULL CHECK (hafta_gunu >= 0 AND hafta_gunu <= 6),
                is_active        BOOLEAN NOT NULL DEFAULT TRUE,
                available_from   TEXT,
                available_to     TEXT,
                guncelleme       TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (personel_id, hafta_gunu)
            )
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'personel_gun_uygunluk'
                ) THEN
                    INSERT INTO personel_gun_musaitlik
                        (id, personel_id, hafta_gunu, is_active, available_from, available_to)
                    SELECT gen_random_uuid()::text, u.personel_id, u.hafta_gunu, u.calisabilir,
                           s.saat_bas, s.saat_bit
                    FROM personel_gun_uygunluk u
                    LEFT JOIN personel_gun_saat_kisit s
                      ON s.personel_id = u.personel_id AND s.hafta_gunu = u.hafta_gunu
                    WHERE NOT EXISTS (
                        SELECT 1 FROM personel_gun_musaitlik m
                        WHERE m.personel_id = u.personel_id AND m.hafta_gunu = u.hafta_gunu
                    );
                    INSERT INTO personel_gun_musaitlik
                        (id, personel_id, hafta_gunu, is_active, available_from, available_to)
                    SELECT gen_random_uuid()::text, s.personel_id, s.hafta_gunu, TRUE,
                           s.saat_bas, s.saat_bit
                    FROM personel_gun_saat_kisit s
                    WHERE NOT EXISTS (
                        SELECT 1 FROM personel_gun_musaitlik m
                        WHERE m.personel_id = s.personel_id AND m.hafta_gunu = s.hafta_gunu
                    );
                    DROP TABLE IF EXISTS personel_gun_saat_kisit;
                    DROP TABLE IF EXISTS personel_gun_uygunluk;
                END IF;
            END $$;
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_hafta_izin (
                id               TEXT PRIMARY KEY,
                personel_id      TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                hafta_baslangic  DATE NOT NULL,
                izin_pzt         BOOLEAN NOT NULL DEFAULT FALSE,
                izin_sal         BOOLEAN NOT NULL DEFAULT FALSE,
                izin_car         BOOLEAN NOT NULL DEFAULT FALSE,
                izin_per         BOOLEAN NOT NULL DEFAULT FALSE,
                izin_cum         BOOLEAN NOT NULL DEFAULT FALSE,
                izin_cmt         BOOLEAN NOT NULL DEFAULT FALSE,
                izin_paz         BOOLEAN NOT NULL DEFAULT FALSE,
                guncelleme       TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (personel_id, hafta_baslangic)
            )
        """)

        # Personelin o gün hangi şubelerde çalışabileceği (kaydırma / çoklu şube)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_vardiya_sube_erisim (
                id              TEXT PRIMARY KEY,
                personel_id     TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                guncelleme      TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (personel_id, sube_id)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_pvs_erisim_personel
            ON personel_vardiya_sube_erisim (personel_id)
        """)

        # Motor: şubeler arası minimum süre (dakika), vb.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_motor_ayar (
                anahtar     TEXT PRIMARY KEY,
                deger_int   INT,
                deger_text  TEXT
            )
        """)
        cur.execute("""
            INSERT INTO vardiya_motor_ayar (anahtar, deger_int)
            SELECT 'subeler_arasi_min_dakika', 90
            WHERE NOT EXISTS (
                SELECT 1 FROM vardiya_motor_ayar WHERE anahtar = 'subeler_arasi_min_dakika'
            )
        """)
        cur.execute("""
            INSERT INTO vardiya_motor_ayar (anahtar, deger_int)
            SELECT 'mesai_ek_limit_saat', 4
            WHERE NOT EXISTS (
                SELECT 1 FROM vardiya_motor_ayar WHERE anahtar = 'mesai_ek_limit_saat'
            )
        """)

        # Haftalık plan taslağı (motor çıktılarını kaydetmek için altyapı)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_atama_taslak (
                id              TEXT PRIMARY KEY,
                hafta_baslangic DATE NOT NULL,
                tarih           DATE NOT NULL,
                sube_id         TEXT NOT NULL REFERENCES subeler(id) ON DELETE CASCADE,
                personel_id     TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                bas_saat        TEXT NOT NULL,
                bit_saat        TEXT NOT NULL,
                rol             TEXT NOT NULL DEFAULT 'aralik'
                    CHECK (rol IN ('acilis','kapanis','aralik')),
                senaryo_id      TEXT,
                kritik          BOOLEAN NOT NULL DEFAULT FALSE,
                izin_ihlali     BOOLEAN NOT NULL DEFAULT FALSE,
                rol_ihlali      BOOLEAN NOT NULL DEFAULT FALSE,
                mesai_ihlali    BOOLEAN NOT NULL DEFAULT FALSE,
                aciklama        TEXT,
                durum           TEXT NOT NULL DEFAULT 'taslak'
                    CHECK (durum IN ('taslak','kilitli','iptal')),
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_vardiya_atama_taslak_hafta
            ON vardiya_atama_taslak (hafta_baslangic, sube_id, tarih)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_vardiya_atama_taslak_personel
            ON vardiya_atama_taslak (hafta_baslangic, personel_id, tarih)
        """)
        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='vardiya_atama_taslak' AND column_name='izin_ihlali')
                THEN ALTER TABLE vardiya_atama_taslak ADD COLUMN izin_ihlali BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='vardiya_atama_taslak' AND column_name='rol_ihlali')
                THEN ALTER TABLE vardiya_atama_taslak ADD COLUMN rol_ihlali BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='vardiya_atama_taslak' AND column_name='mesai_ihlali')
                THEN ALTER TABLE vardiya_atama_taslak ADD COLUMN mesai_ihlali BOOLEAN NOT NULL DEFAULT FALSE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='vardiya_atama_taslak' AND column_name='aciklama')
                THEN ALTER TABLE vardiya_atama_taslak ADD COLUMN aciklama TEXT; END IF;
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)

        cur.execute("""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_kapanis_atanabilir')
                THEN
                    ALTER TABLE personel ADD COLUMN vardiya_kapanis_atanabilir BOOLEAN NOT NULL DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_araci_atanabilir')
                THEN
                    ALTER TABLE personel ADD COLUMN vardiya_araci_atanabilir BOOLEAN NOT NULL DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_gun_icinde_cok_subeye_gidebilir')
                THEN
                    ALTER TABLE personel ADD COLUMN vardiya_gun_icinde_cok_subeye_gidebilir BOOLEAN NOT NULL DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_ana_sube_oncelikli')
                THEN
                    ALTER TABLE personel ADD COLUMN vardiya_ana_sube_oncelikli BOOLEAN NOT NULL DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_ana_sube_id')
                THEN
                    ALTER TABLE personel ADD COLUMN vardiya_ana_sube_id TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel' AND column_name='vardiya_oncelikli_sube_id')
                THEN
                    ALTER TABLE personel ADD COLUMN vardiya_oncelikli_sube_id TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='subeler' AND column_name='acilis_max_kisi')
                THEN
                    ALTER TABLE subeler ADD COLUMN acilis_max_kisi SMALLINT;
                END IF;
            END $$;
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
            END $$;
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
