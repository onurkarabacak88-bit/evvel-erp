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
        # Migration: kredi ödemesiz dönem (kampanya) — ay sayısı, baslangic_tarihi sonrası taksit planı üretilmez
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='borc_envanteri' AND column_name='odemesiz_ay')
                THEN
                    ALTER TABLE borc_envanteri ADD COLUMN odemesiz_ay INT NOT NULL DEFAULT 0;
                END IF;
            END $$;
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

        # ── VARDİYA PLANLAMA ───────────────────────────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya (
                id           TEXT PRIMARY KEY,
                tarih        DATE NOT NULL,
                personel_id  TEXT NOT NULL REFERENCES personel(id),
                sube_id      TEXT NOT NULL REFERENCES subeler(id),
                tip          TEXT NOT NULL
                    CHECK (tip IN ('ACILIS','ARA','KAPANIS')),
                bas_saat     TIME NOT NULL,
                bit_saat     TIME NOT NULL,
                olusturma    TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_vardiya_tarih ON vardiya (tarih)
        """)

        # ── VARDİYA: İZİN, PERSONEL KISIT, ŞUBE CONFIG, BAĞLANTI ──
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_izin (
                id              TEXT PRIMARY KEY,
                personel_id     TEXT NOT NULL REFERENCES personel(id),
                baslangic_tarih DATE NOT NULL,
                bitis_tarih     DATE NOT NULL,
                tip             TEXT NOT NULL DEFAULT 'izin',
                aciklama        TEXT,
                durum           TEXT NOT NULL DEFAULT 'bekliyor',
                olusturma       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_kisit (
                id                  TEXT PRIMARY KEY,
                personel_id         TEXT NOT NULL REFERENCES personel(id) UNIQUE,
                acilis_yapabilir    BOOLEAN NOT NULL DEFAULT TRUE,
                ara_yapabilir       BOOLEAN NOT NULL DEFAULT TRUE,
                kapanis_yapabilir   BOOLEAN NOT NULL DEFAULT TRUE,
                sadece_tip          TEXT,
                sube_degistirebilir BOOLEAN NOT NULL DEFAULT TRUE,
                kapanis_bit_saat    TEXT,
                guncelleme          TIMESTAMP DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_gunluk_kisit (
                id              TEXT PRIMARY KEY,
                personel_id     TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                hafta_gunu      SMALLINT NOT NULL CHECK (hafta_gunu >= 0 AND hafta_gunu <= 6),
                calisabilir     BOOLEAN NOT NULL DEFAULT TRUE,
                sadece_tip      TEXT,
                min_baslangic   TEXT,
                max_cikis       TEXT,
                max_saat        NUMERIC(5,2),
                calisamaz       BOOLEAN NOT NULL DEFAULT FALSE,
                izinli_tipler   TEXT,
                guncelleme      TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (personel_id, hafta_gunu)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_personel_gunluk_kisit_pid
            ON personel_gunluk_kisit (personel_id)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_tercih (
                id           TEXT PRIMARY KEY,
                personel_id  TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE,
                tercih_tip   TEXT NOT NULL CHECK (tercih_tip IN ('ACILIS','ARA','KAPANIS')),
                oncelik      SMALLINT NOT NULL DEFAULT 1,
                guncelleme   TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (personel_id, tercih_tip)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_personel_tercih_pid ON personel_tercih (personel_id)
        """)
        # Vardiya ön seçim: yalnızca vardiyaya_dahil=TRUE olanlar otomatik planda
        cur.execute("""
            CREATE TABLE IF NOT EXISTS personel_config (
                personel_id     TEXT PRIMARY KEY REFERENCES personel(id) ON DELETE CASCADE,
                vardiyaya_dahil BOOLEAN NOT NULL DEFAULT TRUE,
                guncelleme      TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_config (
                id                   TEXT PRIMARY KEY,
                sube_id              TEXT NOT NULL REFERENCES subeler(id) UNIQUE,
                min_kapanis          INT NOT NULL DEFAULT 1,
                tek_kapanis_izinli   BOOLEAN NOT NULL DEFAULT TRUE,
                tek_acilis_izinli    BOOLEAN NOT NULL DEFAULT TRUE,
                kaydirma_acik        BOOLEAN NOT NULL DEFAULT TRUE,
                sadece_tam_kayabilir BOOLEAN NOT NULL DEFAULT FALSE,
                hafta_sonu_min_kap   INT NOT NULL DEFAULT 1,
                tam_part_zorunlu     BOOLEAN NOT NULL DEFAULT FALSE,
                kapanis_dusurulemez  BOOLEAN NOT NULL DEFAULT FALSE,
                acilis_bas_saat      TEXT,
                acilis_bit_saat      TEXT,
                ara_bas_saat         TEXT,
                ara_bit_saat         TEXT,
                kapanis_bas_saat     TEXT,
                kapanis_bit_saat     TEXT,
                guncelleme           TIMESTAMP DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sube_baglanti (
                id          TEXT PRIMARY KEY,
                kaynak_id   TEXT NOT NULL REFERENCES subeler(id),
                hedef_id    TEXT NOT NULL REFERENCES subeler(id),
                aktif       BOOLEAN NOT NULL DEFAULT TRUE,
                olusturma   TIMESTAMP DEFAULT NOW(),
                UNIQUE(kaynak_id, hedef_id)
            )
        """)
        # Eski kurulumlar: yeni kolonlar
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='kapanis_bit_saat') THEN
                    ALTER TABLE personel_kisit ADD COLUMN kapanis_bit_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='calisan_rol') THEN
                    ALTER TABLE personel_kisit ADD COLUMN calisan_rol TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='hafta_max_gun') THEN
                    ALTER TABLE personel_kisit ADD COLUMN hafta_max_gun INT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='gunluk_max_saat') THEN
                    ALTER TABLE personel_kisit ADD COLUMN gunluk_max_saat NUMERIC(5,2);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='haftalik_max_saat') THEN
                    ALTER TABLE personel_kisit ADD COLUMN haftalik_max_saat NUMERIC(6,2);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='min_baslangic_saat') THEN
                    ALTER TABLE personel_kisit ADD COLUMN min_baslangic_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='max_cikis_saat') THEN
                    ALTER TABLE personel_kisit ADD COLUMN max_cikis_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='izinli_sube_ids') THEN
                    ALTER TABLE personel_kisit ADD COLUMN izinli_sube_ids TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_kisit' AND column_name='calisma_profili') THEN
                    ALTER TABLE personel_kisit ADD COLUMN calisma_profili TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_gunluk_kisit' AND column_name='calisabilir') THEN
                    ALTER TABLE personel_gunluk_kisit ADD COLUMN calisabilir BOOLEAN NOT NULL DEFAULT TRUE;
                    UPDATE personel_gunluk_kisit SET calisabilir = NOT COALESCE(calisamaz, FALSE);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_gunluk_kisit' AND column_name='sadece_tip') THEN
                    ALTER TABLE personel_gunluk_kisit ADD COLUMN sadece_tip TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_gunluk_kisit' AND column_name='min_baslangic') THEN
                    ALTER TABLE personel_gunluk_kisit ADD COLUMN min_baslangic TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_gunluk_kisit' AND column_name='max_cikis') THEN
                    ALTER TABLE personel_gunluk_kisit ADD COLUMN max_cikis TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='personel_gunluk_kisit' AND column_name='max_saat') THEN
                    ALTER TABLE personel_gunluk_kisit ADD COLUMN max_saat NUMERIC(5,2);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='tek_acilis_izinli') THEN
                    ALTER TABLE sube_config ADD COLUMN tek_acilis_izinli BOOLEAN NOT NULL DEFAULT TRUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='tam_part_zorunlu') THEN
                    ALTER TABLE sube_config ADD COLUMN tam_part_zorunlu BOOLEAN NOT NULL DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='kapanis_dusurulemez') THEN
                    ALTER TABLE sube_config ADD COLUMN kapanis_dusurulemez BOOLEAN NOT NULL DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='acilis_bas_saat') THEN
                    ALTER TABLE sube_config ADD COLUMN acilis_bas_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='acilis_bit_saat') THEN
                    ALTER TABLE sube_config ADD COLUMN acilis_bit_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='ara_bas_saat') THEN
                    ALTER TABLE sube_config ADD COLUMN ara_bas_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='ara_bit_saat') THEN
                    ALTER TABLE sube_config ADD COLUMN ara_bit_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='kapanis_bas_saat') THEN
                    ALTER TABLE sube_config ADD COLUMN kapanis_bas_saat TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='sube_config' AND column_name='kapanis_bit_saat') THEN
                    ALTER TABLE sube_config ADD COLUMN kapanis_bit_saat TEXT;
                END IF;
            END $$;
        """)

        # ── VARDİYA HAFTALIK (Tulipi tarzı tablo) ───────────────
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_hafta_hucre (
                id                TEXT PRIMARY KEY,
                hafta_baslangic   DATE NOT NULL,
                tarih             DATE NOT NULL,
                personel_id       TEXT NOT NULL REFERENCES personel(id),
                icerik            TEXT NOT NULL DEFAULT '',
                olusturma         TIMESTAMP NOT NULL DEFAULT NOW(),
                guncelleme        TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (hafta_baslangic, personel_id, tarih)
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_vardiya_hafta_hucre
            ON vardiya_hafta_hucre (hafta_baslangic)
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_hafta_satir (
                hafta_baslangic DATE NOT NULL,
                personel_id     TEXT NOT NULL REFERENCES personel(id),
                kapanis_sayisi  TEXT,
                alacak_saat     TEXT,
                PRIMARY KEY (hafta_baslangic, personel_id)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS vardiya_hafta_meta (
                hafta_baslangic DATE PRIMARY KEY,
                baslik          TEXT,
                not_metni       TEXT,
                guncelleme      TIMESTAMP NOT NULL DEFAULT NOW()
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
