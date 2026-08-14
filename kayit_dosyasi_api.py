"""
KAYIT DOSYASI — "her kaydın izi ve belgesi" tek kapısı (İz & Belge doktrini, Dalga 1).

SAHİP TALİMATI (2026-08-14): "Ziraat penceresi yol haritan olsun; her kayıtta iz ve
belge olsun." Ziraat vakasında ekstre planı 'bekliyor' dururken kartta iki ödeme
kaydı vardı — kimse ikisini bir araya getiremiyordu. Bu uç o birleştirmeyi HER kayıt
tipi için yapar: "bu kaydın parası nereden çıktı, belgesi nerede?"

═══ DOKTRİN (Codex hükümleri — uyulması zorunlu) ═══
1. İZ = YALNIZ KESİN BAĞ. Tutar/tarih benzerliğine bakan FUZZY motor BURADA YOK.
   Dedektif (odeme_plani_api.gecikmis-iz-tarama) ayrı bir iştir ve ÖNERİ üretir;
   burada yalnız kimlik bağı (kaynak_tablo+kaynak_id / plan bağı / kart penceresi)
   kabul edilir. Bağ yoksa iz BOŞ döner + `aday_var_olabilir=true` bayrağı kalkar
   → ekran "kesin iz yok, dedektif tarayabilir" diyebilir. Uydurma iz YASAK.
2. HER İZ SATIRINDA NEDEN: `kanit` rozeti (KAYNAK_BAGI | PLAN_BAGI | KART_PENCERESI)
   + okunur tek cümle. Sahip neye baktığını bilmeden hüküm vermesin.
3. DEDUPE: aynı hareket iki yoldan (doğrudan kaynak bağı + plan bağı) gelebilir;
   hareket kimliğiyle teke indirilir. Yoksa 1 ödeme 2 kez ödenmiş görünür.
4. YALNIZ AKTİF: iptal/ters kayıtlar sızmaz (COALESCE(durum,'aktif')='aktif').
5. (kaynak_tablo, kaynak_id) İKİLİSİ ZORUNLU — tek id ile çözme yok (aynı uuid
   farklı tablolarda anlamlıdır; tek id "hangi defter?" sorusunu cevaplamaz).
6. KISMİ ÖDEME: ikili "ödendi mi" bayrağı değil, `odenen`/`kalan` kırılımı.

İZOLASYON: salt-okur (hiçbir tabloya yazmaz), tip başına hata-yutar. Bir tipin
adaptörü patlarsa uç DÜŞMEZ; o bölüm `{"hata": True}` ile döner — HATA ≠ BOŞ
("belge yok" ile "belge okunamadı" farklı şeylerdir, ikisi aynı görünmemeli).
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from database import db
from finans_core import kesim_tarihi_hesapla

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["kayit-dosyasi"])

# Desteklenen kayıt tipleri — 'degisken' AYRI TİP DEĞİL, sabit_giderler alt-tipi
# (tablo aynı, yalnız sabit_giderler.tip='degisken'); ayrı adaptör açmak mükerrer olurdu.
TIPLER = ("vadeli_alimlar", "borc_envanteri", "sabit_giderler", "cari_odeme",
          "personel", "kartlar")

KANIT_NEDEN = {
    "KAYNAK_BAGI": "bu hareket kaydın kimliğiyle doğrudan bağlı",
    "PLAN_BAGI": "ödeme planı üzerinden bu kayda bağlı",
    "KART_PENCERESI": "bu ekstre döneminde karta yapılan ödeme",
}


def _tl(v) -> str:
    """TR para biçimi — ekranda okunur tek satır."""
    try:
        return f"{float(v or 0):,.2f} ₺".replace(",", "_").replace(".", ",").replace("_", ".")
    except Exception:  # noqa: BLE001
        return "— ₺"


def _kolon_toleransli(cur, sql: str, params) -> Optional[List[Dict[str, Any]]]:
    """Sorguyu SAVEPOINT içinde çalıştır — lazy-migration kolonlarına dayanıklı.

    Dönüş: satırlar | None (= beklenen kolon HENÜZ YOK, 'veri yok' demek doğru).
    🔴 HATA ≠ BOŞ (Codex K3): başka HER hata YÜKSELİR ki çağıran `*_hata=True`
    işaretlesin — gerçek okuma hatası "belge yok" diye görünmesin.
    ⚠️ psycopg2: hatalı sorgu işlemi ABORT eder → SAVEPOINT şart, yoksa aynı
    bağlantıdaki sonraki sorgular da patlar.
    """
    from psycopg2 import errors as _pg_err
    cur.execute("SAVEPOINT sp_kd")
    try:
        cur.execute(sql, params)
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute("RELEASE SAVEPOINT sp_kd")
        return satirlar
    except _pg_err.UndefinedColumn:
        cur.execute("ROLLBACK TO SAVEPOINT sp_kd")
        cur.execute("RELEASE SAVEPOINT sp_kd")
        return None
    except Exception:  # noqa: BLE001 — gerçek hata: temizle ama SUSMA
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_kd")
            cur.execute("RELEASE SAVEPOINT sp_kd")
        except Exception:  # noqa: BLE001
            pass
        raise


def _iz_satiri(kaynak: str, hid, tarih, tutar, aciklama, kanit: str) -> Dict[str, Any]:
    """Tek iz düğümü. `_id` DEDUPE anahtarı (yanıtta kalır, FE görmezden gelir)."""
    return {
        "_id": f"{kaynak}:{hid}",
        "ad": f"{_tl(abs(float(tutar or 0)))} ödendi",
        "detay": f"{(aciklama or '').strip()[:60] or kaynak} · {KANIT_NEDEN.get(kanit, '')}",
        "zaman": str(tarih)[:10],
        "kanit": kanit,
        "kanal": kaynak,
        "tutar": abs(float(tutar or 0)),
    }


def _plan_idleri(cur, tablo: str, kid: str) -> List[str]:
    """Bu kaydın ödeme planı satırları — plan bağı izinin köprüsü."""
    cur.execute(
        """SELECT id::text AS id FROM odeme_plani
            WHERE kaynak_tablo=%s AND kaynak_id::text=%s""", (tablo, str(kid)))
    return [r["id"] for r in (cur.fetchall() or [])]


def _kasa_kaynak_iz(cur, tablolar, kid: str, kanit: str) -> List[Dict[str, Any]]:
    """kasa_hareketleri'nde kaynak bağıyla duran PARA ÇIKIŞLARI (tutar<0)."""
    cur.execute(
        """SELECT id::text AS id, tarih, tutar, aciklama
             FROM kasa_hareketleri
            WHERE kaynak_tablo = ANY(%s) AND kaynak_id::text = %s
              AND COALESCE(durum,'aktif')='aktif' AND kasa_etkisi = TRUE
              AND tutar < 0
            ORDER BY tarih DESC""", (list(tablolar), str(kid)))
    return [_iz_satiri("kasa", r["id"], r["tarih"], r["tutar"], r["aciklama"], kanit)
            for r in (cur.fetchall() or [])]


def _kart_kaynak_iz(cur, kid: str, kanit: str, tablolar=None) -> List[Dict[str, Any]]:
    """kart_hareketleri HARCAMA — kaynak bağıyla.

    ⚠️ İKİ-ETİKET TUZAĞI (fatura_api.py:4206-4215 canlı dersi): aynı sabit gider
    kart tarafında bazen 'sabit_giderler', bazen 'fatura_giderleri' etiketiyle
    yazılıyor; kaynak_id ise AYNI. Tablo adını ŞART KOŞAN sorgu 4 internet +
    1 elektrik faturasını "hiç ödenmemiş" gösteriyordu. Kimlik şart, etiket değil.
    """
    if tablolar:
        cur.execute(
            """SELECT id::text AS id, tarih, tutar, aciklama FROM kart_hareketleri
                WHERE kaynak_tablo = ANY(%s) AND kaynak_id::text = %s
                  AND islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
                ORDER BY tarih DESC""", (list(tablolar), str(kid)))
    else:
        cur.execute(
            """SELECT id::text AS id, tarih, tutar, aciklama FROM kart_hareketleri
                WHERE kaynak_id::text = %s
                  AND islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
                ORDER BY tarih DESC""", (str(kid),))
    return [_iz_satiri("kart", r["id"], r["tarih"], r["tutar"], r["aciklama"], kanit)
            for r in (cur.fetchall() or [])]


def _plan_bagi_iz(cur, tablo: str, kid: str) -> List[Dict[str, Any]]:
    """Plan üzerinden ödenmiş para: kasa/kart kaydı kaynak_tablo='odeme_plani'
    ve kaynak_id=plan id taşır (odeme_yap tek yazıcısının deseni)."""
    pidler = _plan_idleri(cur, tablo, kid)
    if not pidler:
        return []
    satir: List[Dict[str, Any]] = []
    cur.execute(
        """SELECT id::text AS id, tarih, tutar, aciklama FROM kasa_hareketleri
            WHERE kaynak_tablo='odeme_plani' AND kaynak_id::text = ANY(%s)
              AND COALESCE(durum,'aktif')='aktif' AND kasa_etkisi = TRUE AND tutar < 0
            ORDER BY tarih DESC""", (pidler,))
    satir += [_iz_satiri("kasa", r["id"], r["tarih"], r["tutar"], r["aciklama"], "PLAN_BAGI")
              for r in (cur.fetchall() or [])]
    cur.execute(
        """SELECT id::text AS id, tarih, tutar, aciklama FROM kart_hareketleri
            WHERE kaynak_tablo='odeme_plani' AND kaynak_id::text = ANY(%s)
              AND islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
            ORDER BY tarih DESC""", (pidler,))
    satir += [_iz_satiri("kart", r["id"], r["tarih"], r["tutar"], r["aciklama"], "PLAN_BAGI")
              for r in (cur.fetchall() or [])]
    return satir


def _dedupe(izler: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Aynı hareket iki yoldan gelebilir (kaynak bağı + plan bağı) → teke indir.
    ÖNCELİK: KAYNAK_BAGI (daha doğrudan kanıt) plan bağını ezer."""
    oncelik = {"KAYNAK_BAGI": 0, "KART_PENCERESI": 1, "PLAN_BAGI": 2}
    en_iyi: Dict[str, Dict[str, Any]] = {}
    for iz in izler:
        k = iz["_id"]
        if k not in en_iyi or oncelik.get(iz["kanit"], 9) < oncelik.get(en_iyi[k]["kanit"], 9):
            en_iyi[k] = iz
    return sorted(en_iyi.values(), key=lambda x: str(x.get("zaman") or ""), reverse=True)


def _belge_dedupe(belgeler: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """🔴 ÇİFT BELGE (Codex K4): tip adaptörü ve `_yuklenen_belgeler` AYNI
    tedarikci_fatura satırını iki yoldan getirebiliyor (ör. sabit gider faturası
    hem kaynak bağıyla hem yükleme kaydıyla) → belge listede iki kez görünüyordu.
    Kimlik = belgenin `url`'indeki dosya id'si (yoksa tür+ad). Adaptör-atlama
    listesinden sağlam: hangi yoldan gelirse gelsin aynı dosya teke iner.
    İLK gelen kazanır — tip adaptörü daha anlamlı rozet/detay taşır."""
    gorulen, cikti = set(), []
    for b in belgeler:
        anahtar = b.get("url") or f"{b.get('tur')}|{b.get('ad')}"
        if anahtar in gorulen:
            continue
        gorulen.add(anahtar)
        cikti.append(b)
    return cikti


def _yuklenen_belgeler(cur, tablo: str, kid: str) -> List[Dict[str, Any]]:
    """Bu kayda ELLE İLİŞTİRİLMİŞ belgeler (Belgeler sekmesindeki yükleme deseni).
    Depo: mevcut tedarikci_fatura tablosu — yeni belge deposu AÇILMADI."""
    # 🔴 HATA ≠ BOŞ (Codex K3): eskiden HER istisna yutulup [] dönüyordu → gerçek
    # okuma hatası "belge yok" görünüyor, `belge_hata` hiç kalkmıyordu. Artık
    # YALNIZ "kolon henüz yok" (ilk deploy öncesi, migration çalışmadan) yutulur;
    # başka her hata YÜKSELİR ve çağıran belge_hata=True işaretler.
    # ⚠️ psycopg2: hatalı sorgu işlemi ABORT eder → SAVEPOINT şart, yoksa aynı
    # bağlantıdaki sonraki sorgular da patlar.
    satirlar = _kolon_toleransli(cur, """
        SELECT id::text AS id, tedarikci_ad, fatura_no, fatura_tarih,
               toplam_tutar, durum, kaynak_tip
          FROM tedarikci_fatura
         WHERE kaynak_tablo=%s AND kaynak_id::text=%s
         ORDER BY olusturma DESC""", (tablo, str(kid)))
    if satirlar is None:
        return []          # kaynak_tablo/kaynak_id kolonları henüz yok — "yok" DOĞRU
    cikti = []
    for r in satirlar:
        cikti.append({
            "tur": "BELGE",
            "ad": f"{r.get('tedarikci_ad') or 'Yüklenen belge'}"
                  + (f" — {r['fatura_no']}" if r.get("fatura_no") else ""),
            "detay": " · ".join(x for x in [
                str(r.get("fatura_tarih") or "")[:10] or None,
                _tl(r["toplam_tutar"]) if r.get("toplam_tutar") else None,
                f"durum: {r.get('durum') or '—'}",
            ] if x),
            "rozet": "YÜKLENDİ",
            "url": f"/api/fatura/{r['id']}/foto",
        })
    return cikti


# ═══════════════════ TİP ADAPTÖRLERİ ═══════════════════
def _iz_vadeli_alimlar(cur, kid):
    return (_kasa_kaynak_iz(cur, ["vadeli_alimlar"], kid, "KAYNAK_BAGI")
            + _kart_kaynak_iz(cur, kid, "KAYNAK_BAGI", ["vadeli_alimlar"])
            + _plan_bagi_iz(cur, "vadeli_alimlar", kid))


def _belge_vadeli_alimlar(cur, kid):
    """Faturayı kuyruğa bağlayan iki alan: kuyruk_vadeli_id (fatura_api.py:764)
    ve ödenmiş faturalarda odeme_iz_tablo/odeme_iz_id (736-744)."""
    # 🔵 İKİ BAĞ YOLU (Codex K2): kuyruk_vadeli_id normal yol; ama ÖDEME FATURADAN
    # ÖNCE geldiyse kuyruk_vadeli_id='(odenmis)' damgalanıp gerçek bağ
    # odeme_iz_tablo/odeme_iz_id'ye yazılıyor (fatura_api.py:736-744). Yalnız
    # ilkini okumak o faturaları "belgesiz" gösteriyordu.
    sql = """SELECT id::text AS id, tedarikci_ad, fatura_no, fatura_tarih,
                    toplam_tutar, durum
               FROM tedarikci_fatura
              WHERE kuyruk_vadeli_id = %s
                 OR (odeme_iz_tablo = 'vadeli_alimlar' AND odeme_iz_id::text = %s)
              ORDER BY olusturma DESC"""
    satirlar = _kolon_toleransli(cur, sql, (str(kid), str(kid)))
    if satirlar is None:
        # odeme_iz_* kolonları henüz eklenmemiş (lazy migration) → yalnız klasik bağ.
        satirlar = _kolon_toleransli(cur, """
            SELECT id::text AS id, tedarikci_ad, fatura_no, fatura_tarih,
                   toplam_tutar, durum
              FROM tedarikci_fatura
             WHERE kuyruk_vadeli_id = %s
             ORDER BY olusturma DESC""", (str(kid),)) or []
    return [{
        "tur": "FATURA",
        "ad": f"{r['tedarikci_ad'] or 'Tedarikçi faturası'}"
              + (f" — {r['fatura_no']}" if r.get("fatura_no") else ""),
        "detay": " · ".join(x for x in [
            str(r.get("fatura_tarih") or "")[:10] or None,
            _tl(r["toplam_tutar"]) if r.get("toplam_tutar") else None] if x),
        "rozet": "KUYRUĞA BAĞLI",
        "url": f"/api/fatura/{r['id']}/foto",
    } for r in satirlar]


def _iz_borc_envanteri(cur, kid):
    """main.py:9713-9720 borc_gecmis deseniyle AYNI kaynak (kasa kaynak bağı)."""
    return (_kasa_kaynak_iz(cur, ["borc_envanteri"], kid, "KAYNAK_BAGI")
            + _plan_bagi_iz(cur, "borc_envanteri", kid))


def _belge_borc_envanteri(cur, kid):
    """DÜRÜST BOŞ: kredi sözleşmesi bu sisteme arşivlenmiyor. Uydurma belge yok."""
    return []


def _iz_sabit_giderler(cur, kid):
    # ⚠️ İKİ ETİKET: kasa tarafında iki tablo adı da geçebiliyor (main.py:8353-8368).
    return (_kasa_kaynak_iz(cur, ["sabit_giderler", "fatura_giderleri"], kid, "KAYNAK_BAGI")
            + _kart_kaynak_iz(cur, kid, "KAYNAK_BAGI")   # kart: etiket şart değil, kimlik şart
            + _plan_bagi_iz(cur, "sabit_giderler", kid))


def _belge_sabit_giderler(cur, kid):
    """fatura_api.py:3013-3028 dayanak damgası: sabit gider faturası belge kaydı
    üzerinden ödenir. Fatura kaydı varsa göster; yoksa dürüst boş."""
    cur.execute(
        """SELECT id::text AS id, tedarikci_ad, fatura_no, fatura_tarih, toplam_tutar
             FROM tedarikci_fatura
            WHERE kaynak_tablo IN ('sabit_giderler','fatura_giderleri')
              AND kaynak_id::text=%s
            ORDER BY olusturma DESC""", (str(kid),))
    return [{
        "tur": "FATURA", "ad": r["tedarikci_ad"] or "Sabit gider faturası",
        "detay": f"{str(r.get('fatura_tarih') or '')[:10]} · {_tl(r['toplam_tutar'])}",
        "rozet": "BELGE", "url": f"/api/fatura/{r['id']}/foto",
    } for r in (cur.fetchall() or [])]


def _iz_cari_odeme(cur, kid):
    """cari_odeme.plan_id → odeme_plani (fatura_api.py:6696-6710): ödeme kaydı
    kendi planını taşır, para o plandan çıkar."""
    cur.execute("SELECT plan_id::text AS pid FROM cari_odeme WHERE id::text=%s", (str(kid),))
    r = cur.fetchone()
    izler = _kasa_kaynak_iz(cur, ["cari_odeme"], kid, "KAYNAK_BAGI")
    if r and r.get("pid"):
        pid = r["pid"]
        cur.execute(
            """SELECT id::text AS id, tarih, tutar, aciklama FROM kasa_hareketleri
                WHERE kaynak_tablo='odeme_plani' AND kaynak_id::text=%s
                  AND COALESCE(durum,'aktif')='aktif' AND kasa_etkisi=TRUE AND tutar<0""",
            (pid,))
        izler += [_iz_satiri("kasa", x["id"], x["tarih"], x["tutar"], x["aciklama"], "PLAN_BAGI")
                  for x in (cur.fetchall() or [])]
    return izler


def _belge_cari_odeme(cur, kid):
    """cari_odeme_tahsis (fatura_api.py:6566-6578): bu ödemenin HANGİ faturayı ne
    kadar kapattığı — append-only KESİN FIFO bağı, tahmin değil."""
    cur.execute(
        """SELECT t.fatura_id::text AS fid, t.fatura_no, t.fatura_tarih, t.kapatilan,
                  t.otomatik
             FROM cari_odeme_tahsis t
            WHERE t.odeme_id::text=%s
            ORDER BY t.olusturma""", (str(kid),))
    return [{
        "tur": "FATURA",
        "ad": f"Fatura {r.get('fatura_no') or (str(r.get('fid') or '')[:8])}",
        "detay": f"{str(r.get('fatura_tarih') or '')[:10]} · kapatılan {_tl(r['kapatilan'])}",
        "rozet": "OTOMATİK" if r.get("otomatik") else "ELLE",
        **({"url": f"/api/fatura/{r['fid']}/foto"} if r.get("fid") else {}),
    } for r in (cur.fetchall() or [])]


def _iz_personel(cur, kid):
    """Maaş ödemeleri: kasa kaynak_tablo='personel' (maas_service tek yazıcısı)."""
    return (_kasa_kaynak_iz(cur, ["personel"], kid, "KAYNAK_BAGI")
            + _plan_bagi_iz(cur, "personel", kid))


def _belge_personel(cur, kid):
    """BORDRO = personel_aylik kaydının KENDİSİ (Codex: hesaplanmış özet değil,
    birincil kayıt → dayanak sayılır). Gerçek dosya yok, sistem kaydı var."""
    cur.execute(
        """SELECT yil, ay, durum, COALESCE(hesaplanan_net,0)::float AS net
             FROM personel_aylik WHERE personel_id::text=%s
            ORDER BY yil DESC, ay DESC LIMIT 12""", (str(kid),))
    return [{
        "tur": "BORDRO", "ad": f"{r['yil']}-{int(r['ay']):02d} bordrosu",
        "detay": f"net {_tl(r['net'])} · durum: {r.get('durum') or '—'}",
        "rozet": "SİSTEM KAYDI",
    } for r in (cur.fetchall() or [])]


def _iz_kartlar(cur, kid):
    """Kart ekstresi ödemeleri — [kesim, sonraki_kesim) PENCERESİ.

    Pencere tanımı kasa_service kart planı yazıcısı ve finansal_duyu
    FIN_KART_ODEME_GIRILMEMIS ile BİREBİR AYNI. Farklı pencere kullanmak
    "biri ödendi der, diğeri ödenmedi" çelişkisini doğurur (Ziraat vakası).
    Bu mantık GenelModulu.jsx'te FE'de duruyordu → backend'e indirildi.
    """
    cur.execute("SELECT kesim_gunu FROM kartlar WHERE id::text=%s", (str(kid),))
    k = cur.fetchone()
    if not k:
        return []
    cur.execute(
        """SELECT kesim_tarihi FROM kart_ekstre_donem
            WHERE kart_id::text=%s AND kesim_tarihi IS NOT NULL
            ORDER BY donem DESC LIMIT 1""", (str(kid),))
    ked = cur.fetchone()
    if not ked or not isinstance(ked["kesim_tarihi"], date):
        return []          # ekstre yoksa pencere kurulamaz → hüküm verme
    kt = ked["kesim_tarihi"]
    sy, sa = (kt.year + 1, 1) if kt.month == 12 else (kt.year, kt.month + 1)
    sonraki = kesim_tarihi_hesapla(sy, sa, int(k["kesim_gunu"] or 1))
    cur.execute(
        """SELECT id::text AS id, tarih, tutar, aciklama FROM kart_hareketleri
            WHERE kart_id::text=%s AND islem_turu='ODEME'
              AND COALESCE(durum,'aktif')='aktif'
              AND tarih >= %s::date AND tarih < %s::date
            ORDER BY tarih DESC""", (str(kid), kt, sonraki))
    return [_iz_satiri("kart", r["id"], r["tarih"], r["tutar"], r["aciklama"], "KART_PENCERESI")
            for r in (cur.fetchall() or [])]


def _belge_kartlar(cur, kid):
    """Dönem ekstresi (main.py:4029 ekstre-arsiv verisinin kaynağı)."""
    cur.execute(
        """SELECT donem::text AS donem, kesim_tarihi, son_odeme_tarihi,
                  COALESCE(donem_borcu,0)::float AS borc,
                  COALESCE(asgari_tutar,0)::float AS asgari, kaynak
             FROM kart_ekstre_donem WHERE kart_id::text=%s
            ORDER BY donem DESC LIMIT 6""", (str(kid),))
    return [{
        "tur": "EKSTRE", "ad": f"{str(r['donem'])[:7]} dönemi ekstresi",
        "detay": f"kesim {str(r['kesim_tarihi'])[:10]} · borç {_tl(r['borc'])} "
                 f"· asgari {_tl(r['asgari'])}",
        "rozet": "BANKA" if r.get("kaynak") == "import" else "HESAP",
    } for r in (cur.fetchall() or [])]


_IZ = {
    "vadeli_alimlar": _iz_vadeli_alimlar, "borc_envanteri": _iz_borc_envanteri,
    "sabit_giderler": _iz_sabit_giderler, "cari_odeme": _iz_cari_odeme,
    "personel": _iz_personel, "kartlar": _iz_kartlar,
}
_BELGE = {
    "vadeli_alimlar": _belge_vadeli_alimlar, "borc_envanteri": _belge_borc_envanteri,
    "sabit_giderler": _belge_sabit_giderler, "cari_odeme": _belge_cari_odeme,
    "personel": _belge_personel, "kartlar": _belge_kartlar,
}


def _tutar_kirilimi(cur, tablo: str, kid: str, odenen: float) -> Dict[str, Any]:
    """odenen/kalan — ikili 'ödendi' bayrağı DEĞİL (kısmi ödeme gerçektir)."""
    borclu = None
    try:
        if tablo == "vadeli_alimlar":
            cur.execute("SELECT COALESCE(tutar,0)::float AS t FROM vadeli_alimlar WHERE id::text=%s", (kid,))
        elif tablo == "borc_envanteri":
            cur.execute("SELECT COALESCE(toplam_borc,0)::float AS t FROM borc_envanteri WHERE id::text=%s", (kid,))
        elif tablo == "cari_odeme":
            cur.execute("SELECT COALESCE(tutar,0)::float AS t FROM cari_odeme WHERE id::text=%s", (kid,))
        else:
            cur.execute(
                """SELECT COALESCE(SUM(odenecek_tutar),0)::float AS t FROM odeme_plani
                    WHERE kaynak_tablo=%s AND kaynak_id::text=%s AND durum<>'iptal'""",
                (tablo, kid))
        r = cur.fetchone()
        borclu = float(r["t"]) if r and r.get("t") is not None else None
    except Exception:  # noqa: BLE001
        borclu = None
    return {
        "odenen": round(odenen, 2),
        "kalan": (round(max(0.0, borclu - odenen), 2) if borclu is not None else None),
        "borclu": (round(borclu, 2) if borclu is not None else None),
    }


@router.get("/kayit-dosyasi")
def kayit_dosyasi(kaynak_tablo: str, kaynak_id: str):
    """📂 Bir kaydın İZİ ve BELGESİ — tek kapı, salt-okur, öneri-only.

    (kaynak_tablo, kaynak_id) İKİLİSİ zorunlu: aynı uuid farklı defterlerde
    anlamlı olabilir, tek id "hangi defter?" sorusunu cevaplamaz.
    """
    tablo = (kaynak_tablo or "").strip()
    kid = (kaynak_id or "").strip()
    if not tablo or not kid:
        raise HTTPException(400, "kaynak_tablo ve kaynak_id birlikte zorunlu.")
    if tablo not in TIPLER:
        raise HTTPException(400, f"Desteklenmeyen kayıt tipi: {tablo}")

    iz: List[Dict[str, Any]] = []
    belgeler: List[Dict[str, Any]] = []
    iz_hata = belge_hata = False
    with db() as (conn, cur):
        # TİP BAŞINA HATA-YUTAR: bir bölümün hatası ucu düşürmez, ama HATA≠BOŞ →
        # bayrakla döner ki ekran "iz yok" ile "iz okunamadı"yı karıştırmasın.
        try:
            iz = _dedupe(_IZ[tablo](cur, kid))
        except Exception as e:  # noqa: BLE001
            logger.warning("kayit-dosyasi iz hatası %s/%s: %s", tablo, kid, e)
            iz, iz_hata = [], True
        try:
            belgeler = _belge_dedupe(
                list(_BELGE[tablo](cur, kid)) + _yuklenen_belgeler(cur, tablo, kid))
        except Exception as e:  # noqa: BLE001
            logger.warning("kayit-dosyasi belge hatası %s/%s: %s", tablo, kid, e)
            belgeler, belge_hata = [], True
        kirilim = _tutar_kirilimi(cur, tablo, kid, sum(x["tutar"] for x in iz))

    return {
        "kaynak_tablo": tablo, "kaynak_id": kid,
        "iz": iz, "iz_hata": iz_hata,
        "belgeler": belgeler, "belge_hata": belge_hata,
        # Kesin bağ yok ama fuzzy dedektif ÖNERİ üretebilir — ekran bunu söyleyebilsin.
        # (Dedektif motoru burada KURULMAZ; ayrı uç, ayrı sorumluluk.)
        "aday_var_olabilir": (not iz) and (not iz_hata),
        **kirilim,
        "not": "Yalnız KESİN bağlar (kimlik/plan/kart penceresi) gösterilir. "
               "Tutar-tarih benzerliğine dayanan öneriler bu uçta YOKTUR — "
               "onlar dedektif taramasının işidir ve ayrı onay ister.",
    }
