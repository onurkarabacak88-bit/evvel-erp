import os
import psycopg2
import psycopg2.extras
from contextlib import contextmanager

DATABASE_URL = os.environ.get("DATABASE_URL", "")

def get_conn():
    conn = psycopg2.connect(DATABASE_URL, sslmode="require" if "railway" in DATABASE_URL else "disable")
    conn.autocommit = False
    return conn

@contextmanager
def db():
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_db():
    with db() as (conn, cur):
        cur.execute("""

        -- 1. ŞUBELER
        CREATE TABLE IF NOT EXISTS subeler (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            ad TEXT NOT NULL UNIQUE,
            aktif BOOLEAN DEFAULT TRUE,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO subeler (id, ad) VALUES
            ('sube-tema','TEMA'),('sube-zafer','ZAFER'),
            ('sube-alsancak','ALSANCAK'),('sube-koycegiz','KOYCEGIZ')
        ON CONFLICT DO NOTHING;

        -- 2. MERKEZ KASA HAREKETLERİ
        CREATE TABLE IF NOT EXISTS kasa_hareketleri (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            tarih DATE NOT NULL DEFAULT CURRENT_DATE,
            islem_turu TEXT NOT NULL,
            tutar NUMERIC(14,2) NOT NULL,
            aciklama TEXT,
            kaynak_tablo TEXT,
            kaynak_id TEXT,
            durum TEXT DEFAULT 'aktif' CHECK(durum IN ('aktif','iptal')),
            iptal_nedeni TEXT,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 3. CİRO
        CREATE TABLE IF NOT EXISTS ciro (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            tarih DATE NOT NULL,
            sube_id TEXT REFERENCES subeler(id),
            nakit NUMERIC(14,2) DEFAULT 0,
            pos NUMERIC(14,2) DEFAULT 0,
            online NUMERIC(14,2) DEFAULT 0,
            toplam NUMERIC(14,2) GENERATED ALWAYS AS (nakit+pos+online) STORED,
            aciklama TEXT,
            durum TEXT DEFAULT 'aktif',
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 4. KARTLAR
        CREATE TABLE IF NOT EXISTS kartlar (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            kart_adi TEXT NOT NULL UNIQUE,
            banka TEXT NOT NULL,
            limit_tutar NUMERIC(14,2) DEFAULT 0,
            kesim_gunu INTEGER NOT NULL,
            son_odeme_gunu INTEGER NOT NULL,
            faiz_orani NUMERIC(5,2) DEFAULT 0,
            aktif BOOLEAN DEFAULT TRUE,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 5. KART HAREKETLERİ
        -- ❗ HARCAMA kasayı ETKİLEMEZ — sadece kart borcu artar
        -- ❗ ODEME kasadan düşer
        CREATE TABLE IF NOT EXISTS kart_hareketleri (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            kart_id TEXT NOT NULL REFERENCES kartlar(id),
            tarih DATE NOT NULL,
            islem_turu TEXT NOT NULL CHECK(islem_turu IN ('HARCAMA','ODEME')),
            tutar NUMERIC(14,2) NOT NULL,
            taksit_sayisi INTEGER DEFAULT 1,
            aciklama TEXT,
            durum TEXT DEFAULT 'aktif' CHECK(durum IN ('aktif','iptal')),
            iptal_nedeni TEXT,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 6. ÖDEME PLANI (onay bekleyen ödemeler)
        CREATE TABLE IF NOT EXISTS odeme_plani (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            kart_id TEXT REFERENCES kartlar(id),
            tarih DATE NOT NULL,
            odenecek_tutar NUMERIC(14,2) NOT NULL,
            asgari_tutar NUMERIC(14,2),
            faiz_tutari NUMERIC(14,2) DEFAULT 0,
            durum TEXT DEFAULT 'bekliyor' CHECK(durum IN ('bekliyor','onaylandi','odendi','gecikti','iptal')),
            odeme_tarihi DATE,
            aciklama TEXT,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 7. BORÇ ENVANTERİ
        CREATE TABLE IF NOT EXISTS borc_envanteri (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            kurum TEXT NOT NULL,
            borc_turu TEXT DEFAULT 'Kredi',
            toplam_borc NUMERIC(14,2),
            aylik_taksit NUMERIC(14,2) NOT NULL,
            kalan_vade INTEGER,
            toplam_vade INTEGER,
            baslangic_tarihi DATE,
            odeme_gunu INTEGER DEFAULT 1,
            aktif BOOLEAN DEFAULT TRUE,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 8. SABİT GİDERLER (kira, abonelik vs)
        CREATE TABLE IF NOT EXISTS sabit_giderler (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            gider_adi TEXT NOT NULL,
            kategori TEXT NOT NULL,
            tutar NUMERIC(14,2) NOT NULL,
            periyot TEXT DEFAULT 'aylik' CHECK(periyot IN ('aylik','yillik','haftalik')),
            odeme_gunu INTEGER DEFAULT 1,
            baslangic_tarihi DATE,
            bitis_tarihi DATE,
            sube_id TEXT REFERENCES subeler(id),
            aktif BOOLEAN DEFAULT TRUE,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 9. PERSONEL
        CREATE TABLE IF NOT EXISTS personel (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            ad_soyad TEXT NOT NULL,
            gorev TEXT,
            calisma_turu TEXT DEFAULT 'surekli' CHECK(calisma_turu IN ('surekli','part_time')),
            maas NUMERIC(14,2) DEFAULT 0,
            saatlik_ucret NUMERIC(10,2) DEFAULT 0,
            yemek_ucreti NUMERIC(10,2) DEFAULT 0,
            yol_ucreti NUMERIC(10,2) DEFAULT 0,
            odeme_gunu INTEGER DEFAULT 28,
            baslangic_tarihi DATE,
            cikis_tarihi DATE,
            sube_id TEXT REFERENCES subeler(id),
            aktif BOOLEAN DEFAULT TRUE,
            notlar TEXT,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 10. PERSONEL ÇALIŞMA SAATLERİ (part-time)
        CREATE TABLE IF NOT EXISTS calisma_saatleri (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            personel_id TEXT NOT NULL REFERENCES personel(id),
            tarih DATE NOT NULL,
            normal_saat NUMERIC(5,2) DEFAULT 0,
            mesai_saat NUMERIC(5,2) DEFAULT 0,
            mesai_carpani NUMERIC(4,2) DEFAULT 1.5,
            aciklama TEXT,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 11. VADELİ ALIMLAR
        CREATE TABLE IF NOT EXISTS vadeli_alimlar (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            aciklama TEXT NOT NULL,
            tutar NUMERIC(14,2) NOT NULL,
            vade_tarihi DATE NOT NULL,
            tedarikci TEXT,
            hatirlatma_yapildi BOOLEAN DEFAULT FALSE,
            durum TEXT DEFAULT 'bekliyor' CHECK(durum IN ('bekliyor','odendi','iptal')),
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 12. DÖNEM YÖNETİMİ
        CREATE TABLE IF NOT EXISTS donemler (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            yil INTEGER NOT NULL,
            ay INTEGER NOT NULL,
            durum TEXT DEFAULT 'acik' CHECK(durum IN ('acik','kapali')),
            kapanma_tarihi TIMESTAMPTZ,
            UNIQUE(yil, ay)
        );

        -- 13. KASA MUTABAKATI
        CREATE TABLE IF NOT EXISTS kasa_mutabakat (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            tarih DATE NOT NULL,
            sistem_bakiye NUMERIC(14,2),
            gercek_bakiye NUMERIC(14,2),
            fark NUMERIC(14,2) GENERATED ALWAYS AS (gercek_bakiye - sistem_bakiye) STORED,
            aciklama TEXT,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 14. ONAY KUYRUğU
        CREATE TABLE IF NOT EXISTS onay_kuyrugu (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            islem_turu TEXT NOT NULL,
            kaynak_tablo TEXT NOT NULL,
            kaynak_id TEXT NOT NULL,
            aciklama TEXT,
            tutar NUMERIC(14,2),
            tarih DATE,
            durum TEXT DEFAULT 'bekliyor' CHECK(durum IN ('bekliyor','onaylandi','reddedildi')),
            onay_tarihi TIMESTAMPTZ,
            olusturma TIMESTAMPTZ DEFAULT NOW()
        );

        -- 15. AUDIT LOG (ters kayıt için)
        CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
            tablo TEXT NOT NULL,
            kayit_id TEXT NOT NULL,
            islem TEXT NOT NULL,
            eski_deger JSONB,
            yeni_deger JSONB,
            tarih TIMESTAMPTZ DEFAULT NOW()
        );

        -- İNDEKSLER
        CREATE INDEX IF NOT EXISTS idx_kasa_tarih ON kasa_hareketleri(tarih);
        CREATE INDEX IF NOT EXISTS idx_ciro_tarih ON ciro(tarih);
        CREATE INDEX IF NOT EXISTS idx_kart_har_kart ON kart_hareketleri(kart_id);
        CREATE INDEX IF NOT EXISTS idx_odeme_tarih ON odeme_plani(tarih);
        CREATE INDEX IF NOT EXISTS idx_onay_durum ON onay_kuyrugu(durum);

        """)
    print("✓ EVVEL ERP — Veritabanı hazır (19 modül)")
