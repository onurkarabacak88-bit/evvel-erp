import os
import psycopg2
import psycopg2.extras
from contextlib import contextmanager

DATABASE_URL = os.environ.get("DATABASE_URL", "")


@contextmanager
def db():
    """
    PostgreSQL bağlantı context manager.
    Kullanım:
        with db() as (conn, cur):
            cur.execute(...)
    Başarılı çıkışta commit, hata durumunda rollback yapar.
    """
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    cur = conn.cursor()
    try:
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


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
            END $$;
        """)

        # Varsayılan merkez şube
        cur.execute("""
            INSERT INTO subeler (id, ad)
            VALUES ('sube-merkez', 'MERKEZ')
            ON CONFLICT (id) DO NOTHING
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
                durum           TEXT NOT NULL DEFAULT 'bekliyor',
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
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
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
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
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
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
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
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
