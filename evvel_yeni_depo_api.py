"""📦 EVVEL YENİ · DEPO TAKİBİ (2026-10-17) — sahip + Codex + Fable kurgusu.

Eski Evvel'de aynı stok 7 yerde hesaplanıyordu (bakiye tablosu, defter, merkez stok kartı, teorik bar stoğu...), sayım iz
bırakmıyor, yetmeyen stok sıfıra kırpılıp "bulundu" yazılıyordu (90 günde 509 karşılıksız sevk). Burada:

  · TEK HAREKET DEFTERİ `ey_stok_hareket`: ürün · ADET · kaynak konum → hedef konum · tür · gün · kim. Bakiye = defter toplamı;
    ayrı saklanan bakiye YOK. Düzeltme silmeyle değil iptal/ters kayıtla. `kaynak_ref` UNIQUE → aynı olay iki kez yazılmaz.
  · KONUMLAR: depo:<şube> (her şubenin deposu; Tema = merkez depo + Tema kafe — sahip "2 olsun": Tema'da ürün aç depodan düşer),
    yolda (sevk edildi, kabul bekliyor), dışarı:toptanci / dışarı:tuketim (ürün aç) / dışarı:fire / dışarı:sayim (sayım farkı).
  · KAYNAK: panelin kendi kayıtları KÖPRÜYLE okunur (panel akışına dokunulmaz): Ürün Teslim Al (URUN_SEVK, geri alınan iptal),
    stok_yolda (sevk + kabul), Ürün Aç (URUN_AC/URUN_KULLANIMA_AL, [BİTTİ] hariç), fire bildirimi. 1 Ekim'den itibaren.
  · EKSİ KIRPILMAZ: eksiye düşen kırmızı "kayıt eksik olabilir". Uydurma "bulundu" yok.
  · SAYIM: kör sayım; sayılan − o anki defter = FARK hareketi (çıpa). Sayılmayan ürün 0 sayılmaz. Konumdaki ilk sayım = açılış.
  · Her şey ADET (fiyatlar gibi).
"""

import json
import logging
import time
import uuid
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import aktor as _aktor, bugun as _bugun, bekleyen_is_kaydet

router = APIRouter(prefix="/api/evvel-yeni/depo", tags=["evvel-yeni-depo"])
log = logging.getLogger(__name__)

BASLANGIC = date(2026, 10, 1)
SENKRON_SN = 300
GEC_KABUL_GUN = 2
_HAZIR = False
_SON_SENKRON = {"zaman": 0.0, "sonuc": None}
DISARI = {"dışarı:toptanci": "Toptancı", "dışarı:tuketim": "Ürün aç (tüketim)", "dışarı:fire": "Fire",
          "dışarı:sayim": "Sayım farkı", "dışarı:bilinmeyen": "Kaynağı belirsiz", "dışarı:kayip": "Kayıp (yolda)",
          "dışarı:ikram": "İkram", "dışarı:personel": "Personel kullanımı"}


def depo_hazirla(cur=None) -> None:
    """Depo tabloları + kimlik evreni göçü — KENDİ kısa işleminde (Fable: çağıranın işlemine kilit / lock_timeout taşınmaz;
    işçiler sırayla, önce lock_timeout sonra kilit; _HAZIR yalnız commit'ten sonra). Başarısızsa 503 (sonraki istek yeniden dener)."""
    global _HAZIR
    if _HAZIR:
        return
    try:
        with db() as (_c, k):
            k.execute("SET LOCAL lock_timeout = '3s'")
            k.execute("SELECT pg_advisory_xact_lock(7012061)")
            k.execute("""CREATE TABLE IF NOT EXISTS ey_stok_hareket (
                id TEXT PRIMARY KEY, kaynak_ref TEXT UNIQUE NOT NULL, tur TEXT NOT NULL, urun_id TEXT NOT NULL, urun_ad TEXT,
                adet INT NOT NULL, kaynak TEXT NOT NULL, hedef TEXT NOT NULL, is_gunu DATE NOT NULL, olay_zaman TIMESTAMPTZ,
                kim TEXT, aciklama TEXT, bag TEXT, iptal BOOLEAN NOT NULL DEFAULT FALSE, iptal_sebep TEXT,
                zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
            k.execute("CREATE INDEX IF NOT EXISTS idx_ey_stok_h_urun ON ey_stok_hareket (urun_id, is_gunu)")
            k.execute("""CREATE TABLE IF NOT EXISTS ey_stok_sayim (
                id TEXT PRIMARY KEY, konum TEXT NOT NULL, is_gunu DATE NOT NULL, kim TEXT, acilis BOOLEAN NOT NULL DEFAULT FALSE,
                satirlar JSONB NOT NULL DEFAULT '[]'::jsonb, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
            # Fable (altyapı denetimi): İKİ KİMLİK EVRENİ aynı defterde olmasın → her satır evrenini taşır. Okuyucular 1 Kasım'dan
            # (panel_baslangic) itibaren YALNIZ yeni evreni okur; eski aktarım satırları arşiv olarak kalır (silinmez, karışmaz).
            k.execute("ALTER TABLE ey_stok_hareket ADD COLUMN IF NOT EXISTS yeni BOOLEAN NOT NULL DEFAULT FALSE")
            k.execute("ALTER TABLE ey_stok_sayim ADD COLUMN IF NOT EXISTS yeni BOOLEAN NOT NULL DEFAULT FALSE")
            k.execute("CREATE INDEX IF NOT EXISTS idx_ey_stok_h_kaynak ON ey_stok_hareket (yeni, kaynak, is_gunu)")
            k.execute("CREATE INDEX IF NOT EXISTS idx_ey_stok_h_hedef ON ey_stok_hareket (yeni, hedef, is_gunu)")
            k.execute("CREATE INDEX IF NOT EXISTS idx_ey_stok_h_bag ON ey_stok_hareket (bag)")
            k.execute("SELECT to_regclass('ey_urun') IS NOT NULL AS var")
            if dict(k.fetchone())["var"]:   # yeni katalog kimliğiyle yazılmış satırlar yeni evrene (hareket + sayım başlığı)
                k.execute("""UPDATE ey_stok_hareket SET yeni=TRUE WHERE NOT yeni AND urun_id IN (SELECT id::text FROM ey_urun)""")
                k.execute("""UPDATE ey_stok_sayim s SET yeni=TRUE WHERE NOT yeni AND (
                               id IN (SELECT DISTINCT bag FROM ey_stok_hareket WHERE yeni AND bag IS NOT NULL)
                               OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.satirlar) e JOIN ey_urun u ON u.id::text = e->>'urun_id'))""")
    except Exception:  # noqa: BLE001
        log.warning("depo hazırlanamadı — sonraki istekte yeniden", exc_info=True)
        raise HTTPException(503, "Depo hazırlanıyor — birkaç saniye sonra tekrar dene")
    _HAZIR = True


def evren_yeni(cur) -> bool:
    """PUBLIC: okuma evreni — panel_baslangic (1 Kasım) ve sonrası YENİ katalog (ey_urun), öncesi eski aktarım (geçiş).
    Kural çekirdekte (yeni_donem) — modüller birbirine değil çekirdeğe bağlı."""
    from evvel_yeni_cekirdek import yeni_donem
    return yeni_donem(cur)


def _ey_urun_dogrula(cur, idler) -> dict:
    """Yeni evrene YALNIZ yeni katalog (ey_urun) kimliği yazılır — eski kimlik / kod / ad gelirse 400."""
    from evvel_yeni_urun_api import urun_bilgi
    idler = sorted({str(i) for i in idler if i})
    b = urun_bilgi(cur, idler)
    yok = [i for i in idler if i not in b]
    if yok:
        raise HTTPException(400, f"Ürün yeni katalogda yok ({len(yok)}) — listeyi yenileyin")
    return b


def _simdi_tr():
    """Hareket saati — Türkiye saati (Fable: container UTC; dilimsiz datetime.now() 3 saat erken yazıyordu)."""
    try:
        from tr_saat import dt_now_tr
        return dt_now_tr()
    except Exception:  # noqa: BLE001
        return datetime.now()


def _n(x) -> str:
    return " ".join(str(x or "").replace("İ", "i").replace("I", "ı").lower().split())


def _urun_haritasi(cur):
    """siparis_urun: id / depo kalem kodu / ad → (urun_id, ad). Bulunamayan kod 'kod:<kod>' olarak izlenir (kaybolmaz)."""
    cur.execute("SELECT id::text AS id, ad, depo_stok_kalem_kodu FROM siparis_urun")
    by_kod, by_ad, ad = {}, {}, {}
    for r in cur.fetchall() or []:
        r = dict(r)
        by_kod[r["id"]] = r["id"]
        ad[r["id"]] = r["ad"]
        if r.get("depo_stok_kalem_kodu"):
            by_kod.setdefault(str(r["depo_stok_kalem_kodu"]), r["id"])
        by_ad.setdefault(_n(r["ad"]), r["id"])

    def coz(kod, adi=None):
        kod = str(kod or "").strip()
        if kod in by_kod:
            u = by_kod[kod]
            return u, ad.get(u) or adi
        if adi and _n(adi) in by_ad:
            u = by_ad[_n(adi)]
            return u, ad.get(u)
        return ("kod:" + kod if kod else "ad:" + _n(adi)), (adi or kod)
    return coz


def _depo_sube(cur) -> str:
    """Merkez depo = Tanım'daki şube 'depo' bayrağı (PUBLIC). Eski tablolardan tahmin YOK."""
    from evvel_yeni_tanim_api import depo_sube_id
    return depo_sube_id(cur) or "sube-tema"


def _yaz(cur, rows: List[tuple], yeni: bool = False) -> int:
    n = 0
    for r in rows:
        cur.execute("""INSERT INTO ey_stok_hareket (id, kaynak_ref, tur, urun_id, urun_ad, adet, kaynak, hedef, is_gunu, olay_zaman, kim, aciklama, bag, yeni, zaman)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, clock_timestamp()) ON CONFLICT (kaynak_ref) DO NOTHING""",
                    ("sh-" + uuid.uuid4().hex[:16],) + r + (yeni,))
        n += cur.rowcount
    return n


def _tr_gun(ts) -> date:
    """Codex: DB oturumu zaten İstanbul; +3 saat eklemek 21:00 sonrasını ertesi güne kaydırıyordu."""
    from zoneinfo import ZoneInfo
    try:
        return (ts.astimezone(ZoneInfo("Europe/Istanbul")) if getattr(ts, "tzinfo", None) else ts).date()
    except Exception:  # noqa: BLE001
        return _bugun()


def _yaz_guncel(cur, row: tuple) -> int:
    """Kaynak satırı SONRADAN değişebilen olaylar (sevk/kabul adedi — merkez uzlaşması) için: aynı tabandaki etkin kayıt
    aynı adetse dokunma; farklıysa eskisini İPTAL (iz kalır) edip yenisini yaz. Hiç yoksa tabanla yaz."""
    taban, adet, kaynak, hedef = row[0], row[4], row[5], row[6]
    cur.execute("""SELECT id, adet, kaynak, hedef FROM ey_stok_hareket WHERE (kaynak_ref=%s OR kaynak_ref LIKE %s) AND NOT iptal""", (taban, taban + ":r%"))
    etkin = [dict(x) for x in cur.fetchall() or []]
    if any(e["adet"] == adet and e["kaynak"] == kaynak and e["hedef"] == hedef for e in etkin):
        return 0
    for e in etkin:
        cur.execute("UPDATE ey_stok_hareket SET iptal=TRUE, iptal_sebep='kaynak kayıt değişti (uzlaşma/düzeltme)' WHERE id=%s", (e["id"],))
    cur.execute("SELECT 1 FROM ey_stok_hareket WHERE kaynak_ref=%s", (taban,))
    ref = taban if not cur.fetchone() else f"{taban}:r{uuid.uuid4().hex[:6]}"
    return _yaz(cur, [(ref,) + row[1:]])


def _json_parca(acik: str, on: str) -> dict:
    s = acik or ""
    if not s.startswith(on):
        return {}
    try:
        return json.JSONDecoder().raw_decode(s[len(on):])[0]
    except Exception:  # noqa: BLE001
        return {"_okunamadi": True}   # Codex: eski defter 2000 karakterde kesiyor → sessiz kayıp olmasın, raporda say


SENKRON_KESIM_GUN = 2   # eski panel 1 Kasım'da kapanır; geç düşen son kayıtlar için 2 gün sonra köprü TAMAMEN durur


def senkron(cur) -> dict:
    """Panel kayıtlarını deftere aktar (idempotent). Her kaynak kendi savepoint'inde — biri bozulursa diğerleri yazılır.
    KÖPRÜ (eski sistem → eski evren). panel_baslangic + 2 günden sonra ÇALIŞMAZ (Fable: geçiş günü çift sayım olmasın)."""
    depo_hazirla(cur)
    if evren_yeni(cur):
        from evvel_yeni_cekirdek import panel_baslangic
        if (_bugun() - panel_baslangic(cur)).days >= SENKRON_KESIM_GUN:
            return {"kesildi": True, "not": "Eski sistem köprüsü kapalı (1 Kasım kesimi)"}
    coz = _urun_haritasi(cur)
    depo = _depo_sube(cur)
    rapor = {}

    # 1) GİRİŞ — Ürün Teslim Al (toptancıdan)
    try:
        with savepoint(cur, "sp_dp_giris"):
            cur.execute("""SELECT id, sube_id::text AS sid, tarih, olay_ts, aciklama, ref_event_id, etiket FROM operasyon_defter
                            WHERE etiket IN ('URUN_SEVK','URUN_SEVK_IPTAL') AND tarih >= %s ORDER BY olay_ts""", (BASLANGIC,))
            rs = [dict(x) for x in cur.fetchall() or []]
            rows, iptaller, okunamayan = [], [], 0
            for r in rs:
                if r["etiket"] == "URUN_SEVK_IPTAL":
                    if r.get("ref_event_id"):
                        iptaller.append(str(r["ref_event_id"]))
                    continue
                p = _json_parca(r["aciklama"], "URUN_SEVK_JSON:")
                if p.get("_okunamadi"):
                    okunamayan += 1
                for i, k in enumerate(p.get("kalemler") or []):
                    try:
                        adet = int(k.get("adet") or 0)
                    except (TypeError, ValueError):
                        adet = 0
                    if adet <= 0:
                        continue
                    uid, uad = coz(k.get("urun_id"), k.get("urun_ad"))
                    rows.append((f"urun_sevk:{r['id']}:{i}", "giris", uid, uad, adet, "dışarı:toptanci", f"depo:{r['sid']}",
                                 r["tarih"], r["olay_ts"], None, f"Ürün teslim al · {p.get('tedarikci') or 'toptancı'}", None))
            rapor["giris"] = _yaz(cur, rows)
            if okunamayan:
                rapor["okunamayan_teslim"] = okunamayan
            for did in iptaller:
                cur.execute("""UPDATE ey_stok_hareket SET iptal=TRUE, iptal_sebep='panelde geri alındı'
                                WHERE kaynak_ref LIKE %s AND NOT iptal""", (f"urun_sevk:{did}:%",))
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron giriş: %s", str(e)[:200])

    # 2) SEVK + KABUL — stok_yolda  (Codex + Fable denetimi sonrası)
    #    · sevk/kabul adedi sonradan değişebilir (merkez uzlaşması) → _yaz_guncel
    #    · kabul_adet = 0 da KABULDÜR ("hiç gelmedi"), bekleyen sayılmaz
    #    · FAZLA kabul şube stoğuna değil ASKIDA konumuna (doğrulanana kadar kullanılamaz)
    #    · şube gerçek kabul ederse "merkez adına kabul" iptal olur, gerçek adet yazılır
    #    · eski sistemde silinen (iptal edilen) sevk → defterde de iptal
    try:
        with savepoint(cur, "sp_dp_yolda"):
            cur.execute("""SELECT y.id, y.sube_id::text AS hedef, y.kalem_kodu, y.kalem_adi, y.sevk_adet, y.sevk_ts, y.kabul_ts, y.kabul_adet, y.durum,
                                  COALESCE(y.sevk_kaynak_depo_sube_id, %s) AS kaynak
                             FROM stok_yolda y WHERE y.sevk_ts >= %s ORDER BY y.sevk_ts""", (depo, BASLANGIC))
            yrs = [dict(x) for x in cur.fetchall() or []]
            n = 0
            for r in yrs:
                if str(r["kaynak"]) == str(r["hedef"]):
                    continue   # kendinden kendine (Tema → Tema): net sıfır
                uid, uad = coz(r["kalem_kodu"], r["kalem_adi"])
                sv = int(r["sevk_adet"] or 0)
                gun = _tr_gun(r["sevk_ts"])
                if sv > 0:
                    n += _yaz_guncel(cur, (f"yolda:{r['id']}:sevk", "sevk", uid, uad, sv, f"depo:{r['kaynak']}", "yolda", gun, r["sevk_ts"],
                                           None, "Depodan sevk", r["id"]))
                if r.get("kabul_ts") is not None and r.get("kabul_adet") is not None:
                    kb = int(r["kabul_adet"] or 0)
                    kgun = _tr_gun(r["kabul_ts"])
                    # şube gerçekten kabul etti → merkez adına kabul (varsa) iptal
                    cur.execute("""UPDATE ey_stok_hareket SET iptal=TRUE, iptal_sebep='şube kendisi kabul etti'
                                    WHERE kaynak_ref=%s AND NOT iptal""", (f"yolda:{r['id']}:merkez_kabul",))
                    n += _yaz_guncel(cur, (f"yolda:{r['id']}:kabul", "kabul", uid, uad, min(kb, sv), "yolda", f"depo:{r['hedef']}", kgun,
                                           r["kabul_ts"], None,
                                           "Şube kabulü" + (f" (sevk {sv}, kabul {kb})" if kb != sv else "") + (" — HİÇ GELMEDİ" if kb == 0 else ""), r["id"]))
                    if kb > sv:
                        n += _yaz_guncel(cur, (f"yolda:{r['id']}:fazla", "fazla_kabul", uid, uad, kb - sv, "dışarı:bilinmeyen", "askida", kgun,
                                               r["kabul_ts"], None, f"Sevkten FAZLA kabul (sevk {sv}, kabul {kb}) — doğrulanana kadar ASKIDA",
                                               r["id"]))
            rapor["yolda"] = n
            # eski sistemde silinen sevk (iptal) → defterde iptal (yolda hayalet stok kalmasın)
            mevcut = [r["id"] for r in yrs]
            cur.execute("""UPDATE ey_stok_hareket SET iptal=TRUE, iptal_sebep='sevk eski sistemde iptal edildi'
                            WHERE kaynak_ref LIKE 'yolda:%%' AND NOT iptal AND bag IS NOT NULL AND tur IN ('sevk','kabul','fazla_kabul')
                              AND NOT (bag = ANY(%s)) AND kaynak_ref NOT LIKE '%%:coz%%'""", (mevcut,))
            rapor["iptal_sevk"] = cur.rowcount
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron yolda: %s", str(e)[:200])

    # 3) ÜRÜN AÇ — tüketim
    try:
        with savepoint(cur, "sp_dp_ac"):
            from evvel_yeni_kopru import urun_ac_parcala as _urun_ac_parcala   # Fable: depo artık Gider'e bağlı değil
            cur.execute("""SELECT id, sube_id::text AS sid, tarih, olay_ts, aciklama, etiket FROM operasyon_defter
                            WHERE etiket IN ('URUN_AC','URUN_KULLANIMA_AL') AND tarih >= %s
                              AND NOT (etiket='URUN_AC' AND aciklama LIKE '%%[BİTTİ]%%')""", (BASLANGIC,))
            rows = []
            for r in [dict(x) for x in cur.fetchall() or []]:
                for i, (u, ad, adet) in enumerate(_urun_ac_parcala(r["aciklama"])):
                    uid, uad = coz(u, ad)
                    rows.append((f"ac:{r['id']}:{i}", "ac", uid, uad, int(adet), f"depo:{r['sid']}", "dışarı:tuketim", r["tarih"], r["olay_ts"],
                                 None, "Ürün aç" if r["etiket"] == "URUN_AC" else "Kullanıma al", None))
            rapor["ac"] = _yaz(cur, rows)
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron ürün aç: %s", str(e)[:200])

    # 4) FİRE
    try:
        with savepoint(cur, "sp_dp_fire"):
            cur.execute("""SELECT id, sube_id::text AS sid, tarih, olusturma, kalemler, sebep_label, personel_ad FROM sube_fire_bildirim
                            WHERE tarih >= %s""", (BASLANGIC,))
            rows = []
            for r in [dict(x) for x in cur.fetchall() or []]:
                kal = r["kalemler"] if isinstance(r["kalemler"], list) else json.loads(r["kalemler"] or "[]")
                for i, k in enumerate(kal):
                    try:
                        adet = int(float(k.get("miktar") or 0))
                    except (TypeError, ValueError):
                        adet = 0
                    if adet <= 0:
                        continue
                    uid, uad = coz(k.get("kalem_kodu"), k.get("label"))
                    rows.append((f"fire:{r['id']}:{i}", "fire", uid, uad, adet, f"depo:{r['sid']}", "dışarı:fire", r["tarih"], r["olusturma"],
                                 r.get("personel_ad"), f"Fire · {r.get('sebep_label') or ''}", None))
            rapor["fire"] = _yaz(cur, rows)
    except Exception as e:  # noqa: BLE001
        log.warning("depo senkron fire: %s", str(e)[:200])
    return rapor


def _otomatik_senkron() -> None:
    simdi = time.time()
    if simdi - _SON_SENKRON["zaman"] < SENKRON_SN:
        return
    _SON_SENKRON["zaman"] = simdi
    try:
        with db() as (conn, cur):
            _SON_SENKRON["sonuc"] = senkron(cur)
    except Exception as e:  # noqa: BLE001
        log.warning("depo otomatik senkron: %s", str(e)[:200])


def _bakiyeler(cur, yeni: Optional[bool] = None) -> dict:
    """{(urun_id, konum): adet} — iptal olmayan hareketlerden. yeni=True/False: yalnız o kimlik evreni; None: hepsi."""
    q = "" if yeni is None else (" AND yeni" if yeni else " AND NOT yeni")
    cur.execute(f"""SELECT urun_id, konum, SUM(d) AS adet FROM (
                     SELECT urun_id, hedef AS konum, adet AS d FROM ey_stok_hareket WHERE NOT iptal{q}
                     UNION ALL SELECT urun_id, kaynak AS konum, -adet AS d FROM ey_stok_hareket WHERE NOT iptal{q}) x
                   GROUP BY urun_id, konum""")
    return {(dict(r)["urun_id"], dict(r)["konum"]): int(dict(r)["adet"] or 0) for r in cur.fetchall() or []}


# ─────────────────────────── PUBLIC SERVİSLER (yeni şube paneli + merkez aynı kapıdan yazar) ───────────────────────────
TURLER = {"giris", "sevk", "kabul", "fazla_kabul", "ac", "tuketim", "fire", "sayim", "acilis_sayim", "iade", "kayip"}


def _konum_gecerli(k: str) -> bool:
    # bar:{şube} — sahip (2026-10-19): personel açılış/kapanışta YALNIZ tezgahtakini sayar (arkadaki kapalı koli sayılmaz) →
    # panelde sayılan ürün (panel_sayim) açılınca depo:{şube} → bar:{şube} TAŞINIR (gider değil); tüketim = bar sayım farkı.
    return bool(k) and (k.startswith("depo:") or k.startswith("bar:") or k.startswith("dışarı:") or k in ("yolda", "askida"))


def _konum_kilidi(cur, *konumlar) -> None:
    """Depo konumu kilidi — sayım, hareket ve iptal AYNI kilidi alır; birden çok konum SABİT sırayla (kilitlenme olmasın)."""
    for k in sorted({k for k in konumlar if k and (k.startswith("depo:") or k.startswith("bar:"))}):
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_depo_sayim:" + k,))


def hareket_yaz(cur, *, kaynak_ref: str, tur: str, urun_id: str, adet: int, kaynak: str, hedef: str, kim: str,
                urun_ad: Optional[str] = None, aciklama: Optional[str] = None, bag: Optional[str] = None,
                gun: Optional[date] = None) -> bool:
    """PUBLIC: tek stok hareketi. kaynak_ref ile BİR KEZ (tekrar gönderim ikinci kez yazılmaz → False döner).
    Adet tam sayı > 0 (yön kaynak → hedef ile verilir). Eksi bakiye ENGELLENMEZ (Fable: sevk sorgulanmaz, eksi = merkeze iş)."""
    depo_hazirla(cur)
    if tur not in TURLER:
        raise HTTPException(400, f"Bilinmeyen hareket türü: {tur}")
    if not isinstance(adet, int) or isinstance(adet, bool) or adet <= 0:
        raise HTTPException(400, "Adet 1 ya da daha fazla tam sayı olmalı")
    if not (_konum_gecerli(kaynak) and _konum_gecerli(hedef)) or kaynak == hedef:
        raise HTTPException(400, "Geçersiz konum")
    if not kaynak_ref or not urun_id:
        raise HTTPException(400, "kaynak_ref ve ürün gerekli")
    b = _ey_urun_dogrula(cur, [urun_id])   # Fable: yeni evrene yalnız ey_urun kimliği
    _konum_kilidi(cur, kaynak, hedef)   # Codex: sayımla eşzamanlı hareket fark hesabını bozmasın
    return _yaz(cur, [(kaynak_ref, tur, str(urun_id), urun_ad or b[str(urun_id)]["ad"], adet, kaynak, hedef, gun or _bugun(),
                       _simdi_tr(), kim, aciklama, bag)], yeni=True) == 1


def hareket_iptal(cur, *, bag: str, sebep: str) -> dict:
    """PUBLIC: bir işlemin (bag) hareketlerini iptal eder (iz kalır). Fable S3 + Codex: ÜRÜN BAZINDA — o ürün o konumda hareketten
    SONRA sayıldıysa (sıra = kilit altındaki clock_timestamp) o satır kalır (stok sayımla kesinleşti); diğerleri iptal edilir.
    Dönüş {'iptal': n, 'sayimli': bool, 'kalan': [ad…]}."""
    depo_hazirla(cur)
    cur.execute("SELECT kaynak, hedef FROM ey_stok_hareket WHERE bag=%s AND NOT iptal AND yeni", (bag,))
    k0 = [dict(x) for x in cur.fetchall() or []]
    if not k0:
        return {"iptal": 0, "sayimli": False, "kalan": []}
    _konum_kilidi(cur, *{k for r in k0 for k in (r["kaynak"], r["hedef"]) if k.startswith("depo:") or k.startswith("bar:")})
    cur.execute("SELECT id, urun_id, urun_ad, kaynak, hedef, zaman FROM ey_stok_hareket WHERE bag=%s AND NOT iptal AND yeni FOR UPDATE", (bag,))
    rows = [dict(x) for x in cur.fetchall() or []]   # Codex: kilit ALTINDA yeniden oku
    n, kalan = 0, []
    for r in rows:
        kon = [k for k in (r["kaynak"], r["hedef"]) if k.startswith("depo:") or k.startswith("bar:")]
        cur.execute("""SELECT 1 FROM ey_stok_sayim WHERE yeni AND konum = ANY(%s) AND zaman > %s
                         AND satirlar @> %s::jsonb LIMIT 1""", (kon, r["zaman"], json.dumps([{"urun_id": str(r["urun_id"])}])))
        if cur.fetchone():   # bu ürün o konumda sonradan SAYILDI → stok kesinleşti, satır kalır
            kalan.append(r["urun_ad"] or r["urun_id"])
            continue
        cur.execute("UPDATE ey_stok_hareket SET iptal=TRUE, iptal_sebep=%s WHERE id=%s", ((sebep or "iptal")[:200], r["id"]))
        n += 1
    return {"iptal": n, "sayimli": bool(kalan), "kalan": kalan}


def urun_hareketi_var(cur, urun_id: str) -> bool:
    """PUBLIC: ürünün YENİ evrende (ey_urun kimliğiyle) stok hareketi var mı — Ürün kataloğu birim kilidi bunu sorar."""
    depo_hazirla(cur)
    cur.execute("SELECT 1 FROM ey_stok_hareket WHERE urun_id=%s AND yeni LIMIT 1", (str(urun_id),))
    return cur.fetchone() is not None


def bakiye(cur, konum: Optional[str] = None, urun_id: Optional[str] = None) -> dict:
    """PUBLIC: {(urun_id, konum): adet} — YENİ evren (ey_urun kimliği), iptal olmayan hareketlerden (ayrı saklanan bakiye yok)."""
    depo_hazirla(cur)
    return {k: v for k, v in _bakiyeler(cur, yeni=True).items()
            if (konum is None or k[1] == konum) and (urun_id is None or k[0] == str(urun_id))}


def sayim_yaz(cur, *, konum: str, satirlar: List[dict], kim: str, tur: str = "sayim", kaynak_ref: Optional[str] = None,
              ad_coz=None, gun: Optional[date] = None, eski_evren: bool = False) -> dict:
    """PUBLIC: kör sayım → her sayılan ürün için FARK hareketi (sayılan − o anki defter). Boş bırakılan SAYILMAZ (0 sayılmaz).
    tur: 'sayim' (merkez) · 'acilis' (konumdaki açılış) · 'gunluk' (şube paneli: fark<0 = 'tuketim' (bardak satışı),
    fark>0 = 'sayim'). kaynak_ref verilirse aynı sayım ikinci kez yazılmaz ({'tekrar': True}) — kaynak_ref KONUMU içermeli
    (ör. panel:kapanis:{şube}:{gün}; kilit konum bazlı). gun: İŞ GÜNÜ (panel c['gun'] — gece 00:00–02:00 kapanışı dünün)
    — verilmezse bugün. Yeni evren (varsayılan): yalnız ey_urun kimliği; eski_evren=True yalnız geçişte merkezin eski-katalog sayımı."""
    depo_hazirla(cur)
    if not (konum.startswith("depo:") or konum.startswith("bar:")):
        raise HTTPException(400, "Sayım yalnız bir şube deposunda ya da barında yapılır")
    if tur not in ("sayim", "acilis", "gunluk"):
        raise HTTPException(400, "Sayım türü: sayim / acilis / gunluk")
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_depo_sayim:" + konum,))
    if kaynak_ref:
        import hashlib
        sid = "ss-" + hashlib.md5(kaynak_ref.encode("utf-8")).hexdigest()[:12]
        cur.execute("SELECT 1 FROM ey_stok_sayim WHERE id=%s", (sid,))
        if cur.fetchone():
            return {"sayim_id": sid, "tekrar": True, "kayit": [], "farklar": []}
    else:
        sid = "ss-" + uuid.uuid4().hex[:12]
    B = _bakiyeler(cur, yeni=not eski_evren)
    gun = gun or _bugun()
    if not eski_evren:
        _b = _ey_urun_dogrula(cur, [x.get("urun_id") for x in satirlar if x.get("sayilan") not in (None, "")])
        if ad_coz is None:
            def ad_coz(u):   # noqa: E306
                return (_b.get(str(u)) or {}).get("ad")
    rows, kayit, gorulen = [], [], set()
    for s in satirlar:
        v = s.get("sayilan")
        if v in (None, ""):
            continue
        if isinstance(v, bool):
            raise HTTPException(400, f"Sayı yaz: {s.get('urun_id')}")
        try:   # Codex: 1.9 sessizce 1 olmasın — yalnız tam sayı
            f = float(str(v).replace(",", "."))
        except (TypeError, ValueError):
            raise HTTPException(400, f"Sayı yaz: {s.get('urun_id')}")
        if f != int(f):
            raise HTTPException(400, f"Tam sayı yaz: {s.get('urun_id')}")
        say = int(f)
        if say < 0:
            raise HTTPException(400, "Sayılan eksi olamaz")
        if not s.get("urun_id"):
            raise HTTPException(400, "Ürün kimliği eksik — listeyi yenileyin")
        uid = str(s["urun_id"])
        if uid in gorulen:   # Codex: aynı ürün iki satırda → biri sessizce atlanıyordu
            raise HTTPException(400, f"Aynı ürün iki kez sayıldı: {uid}")
        gorulen.add(uid)
        onceki = B.get((uid, konum), 0)
        f_ = say - onceki
        kayit.append({"urun_id": uid, "sayilan": say, "defter": onceki, "fark": f_})
        if f_:
            uad = ad_coz(uid) if ad_coz else s.get("urun_ad")
            if tur == "gunluk" and f_ < 0:
                ht, kaynak, hedef, acik = "tuketim", konum, "dışarı:tuketim", f"Günlük sayım — dün/defter {onceki}, bugün {say} (kullanılan)"
            else:
                ht = "acilis_sayim" if tur == "acilis" else "sayim"
                kaynak, hedef = ("dışarı:sayim", konum) if f_ > 0 else (konum, "dışarı:sayim")
                acik = ("Açılış sayımı" if tur == "acilis" else "Sayım") + f" — defter {onceki}, sayılan {say}"
            rows.append((f"sayim:{sid}:{uid}", ht, uid, uad, abs(f_), kaynak, hedef, gun, _simdi_tr(), kim, acik, sid))
    if not kayit:
        raise HTTPException(400, "Hiç ürün sayılmadı")
    ilk = False
    if not eski_evren and tur == "sayim":   # Fable: yeni evrende konumun İLK merkez sayımı = açılış sayımı (panel günlük sayımı değil)
        cur.execute("SELECT 1 FROM ey_stok_sayim WHERE konum=%s AND yeni LIMIT 1", (konum,))
        ilk = cur.fetchone() is None
    cur.execute("INSERT INTO ey_stok_sayim (id, konum, is_gunu, kim, acilis, satirlar, yeni, zaman) VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s, clock_timestamp())",
                (sid, konum, gun, kim, tur == "acilis" or ilk, json.dumps(kayit, ensure_ascii=False), not eski_evren))
    _yaz(cur, rows, yeni=not eski_evren)
    return {"sayim_id": sid, "tekrar": False, "kayit": kayit, "farklar": [k for k in kayit if k["fark"]]}


def _konumlar(cur) -> list:
    from evvel_yeni_tanim_api import subeler as _ey_subeler
    depo = _depo_sube(cur)
    out = []
    for s in sorted(_ey_subeler(cur), key=lambda x: (x["id"] != depo, x["ad"])):
        out.append({"id": f"depo:{s['id']}", "ad": s["ad"] + (" (merkez depo + kafe)" if s["id"] == depo else ""), "merkez": s["id"] == depo,
                    "sube_id": s["id"]})
    for s in sorted(_ey_subeler(cur), key=lambda x: (x["id"] != depo, x["ad"])):   # tezgah (açılış/kapanış sayımının yeri)
        out.append({"id": f"bar:{s['id']}", "ad": s["ad"] + " · bar", "merkez": False, "sube_id": s["id"], "bar": True})
    out.append({"id": "yolda", "ad": "Yolda", "merkez": False, "sube_id": None})
    out.append({"id": "askida", "ad": "Askıda (fazla kabul)", "merkez": False, "sube_id": None})
    return out


@router.get("/ozet")
def depo_ozet(evren: Optional[str] = None):
    """📦 NEREDE? — ürün × konum (kategori sırasıyla). 1 Kasım'dan itibaren YENİ katalog (ey_urun) ve yalnız yeni evren;
    öncesinde eski aktarım (geçiş) — ?evren=yeni ile yeni katalog ön izlenir. Eski sistemin bakiyesi yalnız KARŞILAŞTIRMA için."""
    _otomatik_senkron()
    with db() as (conn, cur):
        depo_hazirla(cur)
        varsayilan_yeni = evren_yeni(cur)
        yeni = evren == "yeni" if evren in ("yeni", "eski") else varsayilan_yeni
        konumlar = _konumlar(cur)
        B = _bakiyeler(cur, yeni=yeni)
        if yeni:
            from evvel_yeni_urun_api import katalog as _ey_katalog
            katalog = [{"kid": str(k["id"]), "kat": k["ad"], "emoji": k.get("emoji"), "id": str(u["id"]), "ad": u["ad"]}
                       for k in _ey_katalog(cur) for u in k["urunler"]]
        else:
            cur.execute("""SELECT k.id::text AS kid, k.ad AS kat, k.emoji, k.sira AS ks, u.id::text AS id, u.ad, u.sira
                             FROM siparis_urun u JOIN siparis_kategori k ON k.id = u.kategori_id
                            WHERE u.aktif AND k.aktif ORDER BY k.sira, k.ad, u.sira, u.ad""")
            katalog = [dict(r) for r in cur.fetchall() or []]
        cur.execute("SELECT DISTINCT urun_id, urun_ad FROM ey_stok_hareket WHERE yeni = %s", (yeni,))
        hareketli = {dict(r)["urun_id"]: dict(r)["urun_ad"] for r in cur.fetchall() or []}
        eski = {}
        if not yeni:   # yalnız geçiş evreninde (eski sistem bakiyesiyle karşılaştırma)
            try:
                with savepoint(cur, "sp_dp_eski"):
                    coz_e = _urun_haritasi(cur)
                    cur.execute("SELECT sube_id::text AS sid, kalem_kodu, mevcut_adet FROM sube_depo_stok")
                    for r in cur.fetchall() or []:
                        r = dict(r)
                        k_ = (coz_e(r["kalem_kodu"])[0], f"depo:{r['sid']}")   # Fable: havuz kodlu (su, süt, bardak) da eşleşsin
                        eski[k_] = eski.get(k_, 0) + int(r["mevcut_adet"] or 0)
            except Exception:  # noqa: BLE001
                pass
        cur.execute("SELECT konum, MAX(is_gunu) AS son, BOOL_OR(acilis) AS acilis FROM ey_stok_sayim WHERE yeni = %s GROUP BY konum", (yeni,))
        sayimlar = {dict(r)["konum"]: dict(r) for r in cur.fetchall() or []}
    kat_ad = {}
    satirlar = []
    goruldu = set()
    for u in katalog:
        goruldu.add(u["id"])
        kat_ad[u["kid"]] = f"{u['emoji'] or ''} {u['kat']}".strip()
        satirlar.append({"urun_id": u["id"], "ad": u["ad"], "kategori": kat_ad[u["kid"]]})
    for uid, uad in hareketli.items():   # katalogda olmayan ama hareketi olan (eski kod) — kaybolmasın
        if uid not in goruldu:
            satirlar.append({"urun_id": uid, "ad": uad or uid, "kategori": "❔ Katalogda eşleşmeyen"})
    eksi = 0
    for s in satirlar:
        s["bakiye"] = {k["id"]: B.get((s["urun_id"], k["id"]), 0) for k in konumlar}
        s["eski"] = {k["id"]: eski.get((s["urun_id"], k["id"])) for k in konumlar}
        s["eksi"] = [k for k, v in s["bakiye"].items() if v < 0]
        eksi += len(s["eksi"])
    satirlar = [s for s in satirlar if any(s["bakiye"].values()) or s["kategori"] != "❔ Katalogda eşleşmeyen"]
    return {"konumlar": [{**k, "son_sayim": (sayimlar.get(k["id"]) or {}).get("son").isoformat() if (sayimlar.get(k["id"]) or {}).get("son") else None,
                          "acilis_sayimi": bool((sayimlar.get(k["id"]) or {}).get("acilis"))} for k in konumlar],
            "satirlar": satirlar, "eksi_sayi": eksi, "senkron": _SON_SENKRON["sonuc"], "evren": "yeni" if yeni else "eski",
            "varsayilan_evren": "yeni" if varsayilan_yeni else "eski",
            "baslangic": BASLANGIC.isoformat(),
            "not": "Stok = 1 Ekim'den bu yana panel kayıtlarının toplamı (Ürün Teslim Al + kabul − sevk − ürün aç − fire ± sayım). "
                   "Konumda AÇILIŞ SAYIMI yapılana kadar rakamlar başlangıç stoğunu içermez. Tema'da ürün aç depodan düşer."}


@router.get("/iz")
def depo_iz(urun_id: str, konum: str):
    """Bir ürünün bir konumdaki izi: ne geldi/gitti, nereden/nereye, ne zaman, kalan."""
    with db() as (conn, cur):
        depo_hazirla(cur)
        cur.execute("""SELECT * FROM ey_stok_hareket WHERE urun_id=%s AND (kaynak=%s OR hedef=%s)
                        ORDER BY yeni, is_gunu, olay_zaman NULLS LAST, zaman""", (urun_id, konum, konum))
        rs = [dict(r) for r in cur.fetchall() or []]
        konum_ad = {k["id"]: k["ad"] for k in _konumlar(cur)}
    konum_ad.update(DISARI)
    kalan, out = 0, []
    for r in rs:
        d = r["adet"] if r["hedef"] == konum else -r["adet"]
        if not r["iptal"]:
            kalan += d
        karsi = r["kaynak"] if r["hedef"] == konum else r["hedef"]
        out.append({"gun": r["is_gunu"].isoformat(), "tur": r["tur"], "aciklama": r["aciklama"], "d": d,
                    "karsi": ("← " if d > 0 else "→ ") + konum_ad.get(karsi, karsi), "kim": r.get("kim"),
                    "iptal": r["iptal"], "iptal_sebep": r.get("iptal_sebep"), "kalan": kalan})
    return {"urun_id": urun_id, "konum": konum, "konum_ad": konum_ad.get(konum, konum), "iz": out[::-1], "kalan": kalan}


@router.get("/yolda")
def depo_yolda():
    """Yoldakiler (sevk edildi, kabul edilmedi) + sevk ≠ kabul olanlar. GEC_KABUL_GUN'den eski olan kırmızı."""
    _otomatik_senkron()
    bugun = _bugun()
    with db() as (conn, cur):
        depo_hazirla(cur)
        cur.execute("""SELECT bag, MAX(urun_ad) AS urun_ad, MAX(urun_id) AS urun_id,
                              SUM(CASE WHEN tur='sevk' THEN adet ELSE 0 END) AS sevk,
                              SUM(CASE WHEN tur='kabul' THEN adet ELSE 0 END) AS kabul,
                              COUNT(*) FILTER (WHERE tur='kabul') AS kabul_kayit,
                              BOOL_OR(tur='kabul' AND kaynak_ref LIKE '%%:merkez_kabul') AS merkez,
                              SUM(CASE WHEN tur IN ('kayip','iade_geri') THEN adet ELSE 0 END) AS cozulen,
                              SUM(CASE WHEN tur='fazla_kabul' THEN adet WHEN tur IN ('fazla_onay','fazla_ret') THEN -adet ELSE 0 END) AS fazla,
                              MIN(CASE WHEN tur='sevk' THEN is_gunu END) AS sevk_gunu,
                              MAX(CASE WHEN tur='sevk' THEN kaynak END) AS kaynak,
                              MAX(CASE WHEN tur IN ('kabul','fazla_kabul') THEN hedef END) AS hedef_k
                         FROM ey_stok_hareket WHERE bag IS NOT NULL AND NOT iptal AND yeni = %s GROUP BY bag""", (evren_yeni(cur),))
        rs = [dict(r) for r in cur.fetchall() or []]
        cur.execute("SELECT id, sube_id::text AS hedef FROM stok_yolda WHERE sevk_ts >= %s", (BASLANGIC,))
        hedefler = {dict(r)["id"]: dict(r)["hedef"] for r in cur.fetchall() or []}
        konum_ad = {k["id"]: k["ad"] for k in _konumlar(cur)}
    bekleyen, fark = [], []
    for r in rs:
        hedef = r.get("hedef_k") or (f"depo:{hedefler.get(r['bag'])}" if hedefler.get(r["bag"]) else None)
        x = {"id": r["bag"], "urun": r["urun_ad"], "urun_id": r["urun_id"], "sevk": int(r["sevk"] or 0), "kabul": int(r["kabul"] or 0),
             "fazla": int(r["fazla"] or 0), "cozulen": int(r["cozulen"] or 0), "merkez_kabul": bool(r.get("merkez")), "sevk_gunu": r["sevk_gunu"].isoformat() if r["sevk_gunu"] else None,
             "nereden": konum_ad.get(r["kaynak"], r["kaynak"]), "nereye": konum_ad.get(hedef, hedef)}
        x["gun"] = (bugun - r["sevk_gunu"]).days if r["sevk_gunu"] else None
        x["eksik"] = max(0, x["sevk"] - x["kabul"] - x["cozulen"])
        if x["sevk"] and not r.get("kabul_kayit"):
            x["gec"] = bool(x["gun"] is not None and x["gun"] >= GEC_KABUL_GUN)
            bekleyen.append(x)
        elif x["sevk"] and (x["eksik"] or x["fazla"] > 0):
            fark.append(x)
    bekleyen.sort(key=lambda z: z["sevk_gunu"] or "")
    fark.sort(key=lambda z: z["sevk_gunu"] or "", reverse=True)
    return {"bekleyen": bekleyen, "fark": fark, "gec_sayi": sum(1 for x in bekleyen if x["gec"]), "gec_gun": GEC_KABUL_GUN}


class SayimBody(BaseModel):
    konum: str
    satirlar: List[dict]          # [{urun_id, sayilan}] — boş bırakılan ürün SAYILMAZ (0 sayılmaz)
    acilis: bool = False
    gun: Optional[str] = None
    evren: Optional[str] = None   # 'yeni' | 'eski' — ekran hangi katalogla sayıyorsa (ozet.evren)


@router.post("/sayim")
def depo_sayim(body: SayimBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Kör sayım → her sayılan ürün için FARK hareketi (sayılan − defter). Defter sayım ANINDAKİ haliyle karşılaştırılır."""
    with db() as (conn, cur):   # Fable/Codex: sayım ANINDAKİ defterle karşılaştırılır — geçmiş tarihli sayım yok (sayim_yaz bugün yazar)
        depo_hazirla(cur)
        if body.konum not in {k["id"] for k in _konumlar(cur)} or body.konum == "yolda":
            raise HTTPException(400, "Sayım yalnız bir şube deposunda yapılır")
        kim = _aktor(cur, x_evvel_oturum)
        yeni = body.evren == "yeni" if body.evren in ("yeni", "eski") else evren_yeni(cur)
        if not yeni and evren_yeni(cur):
            raise HTTPException(400, "1 Kasım'dan sonra eski katalogla sayım yapılmaz — ekranda 'Yeni katalog'a geç")
        if yeni:   # Fable: merkez sayımı yeni katalog kimliğiyle (panel sayımıyla AYNI ürün kimliği)
            r = sayim_yaz(cur, konum=body.konum, satirlar=body.satirlar, kim=kim, tur="acilis" if body.acilis else "sayim")
        else:
            senkron(cur)   # Codex: aktarılmamış son kayıtlar farka girip sonra İKİNCİ kez yazılmasın
            coz = _urun_haritasi(cur)
            r = sayim_yaz(cur, konum=body.konum, satirlar=body.satirlar, kim=kim, tur="acilis" if body.acilis else "sayim",
                          ad_coz=lambda u: coz(u)[1], eski_evren=True)
    kayit = r["kayit"]
    return {"ok": True, "mesaj": f"{len(kayit)} ürün sayıldı · {sum(1 for k in kayit if k['fark'])} üründe fark yazıldı", "sayim_id": r["sayim_id"],
            "farklar": r["farklar"]}


class KabulBody(BaseModel):
    sebep: Optional[str] = None


@router.post("/yolda/{yid}/merkez-kabul")
def merkez_kabul(yid: str, body: KabulBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Fable: şube kabulü unutursa sevk sonsuza dek 'yolda' kalmasın — merkez, sevk adediyle kabul eder (iz: merkez adına).
    Şube sonradan kabul ederse aynı kayıt kimliği olduğu için İKİNCİ kez yazılmaz."""
    with db() as (conn, cur):
        depo_hazirla(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("SELECT * FROM ey_stok_hareket WHERE kaynak_ref=%s AND NOT iptal", (f"yolda:{yid}:sevk",))
        sv = cur.fetchone()
        if not sv:
            raise HTTPException(404, "Sevk bulunamadı")
        sv = dict(sv)
        cur.execute("SELECT sube_id::text AS hedef FROM stok_yolda WHERE id=%s", (yid,))
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Sevkin hedef şubesi bulunamadı")
        cur.execute("SELECT 1 FROM ey_stok_hareket WHERE kaynak_ref=%s AND NOT iptal", (f"yolda:{yid}:kabul",))
        if cur.fetchone():
            raise HTTPException(409, "Şube bu sevki zaten kabul etmiş")
        n = _yaz(cur, [(f"yolda:{yid}:merkez_kabul", "kabul", sv["urun_id"], sv["urun_ad"], sv["adet"], "yolda", f"depo:{dict(h)['hedef']}",
                        _bugun(), _simdi_tr(), kim, "Merkez adına kabul (şube kabul ederse onun adedi geçer)"
                        + (f" · {body.sebep}" if body.sebep else ""), yid)], yeni=bool(dict(sv).get("yeni")))   # Fable: sevkin evreni
    if not n:
        raise HTTPException(409, "Bu sevk zaten merkez adına kabul edilmiş")
    return {"ok": True, "mesaj": "Merkez adına kabul edildi"}


class FarkCozBody(BaseModel):
    karar: str                 # eksik: 'kayip' | 'iade' · fazla: 'fazla_onay' | 'fazla_ret'
    not_: Optional[str] = None


@router.post("/yolda/{yid}/fark-coz")
def fark_coz(yid: str, body: FarkCozBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Sevk ≠ kabul çözümü (Fable): EKSİK (yolda kalan) → kayıp ya da kaynağa iade; FAZLA (askıda) → onay (şubeye) ya da ret."""
    with db() as (conn, cur):
        depo_hazirla(cur)
        kim = _aktor(cur, x_evvel_oturum)
        cur.execute("""SELECT tur, urun_id, urun_ad, adet, kaynak, hedef, yeni FROM ey_stok_hareket WHERE bag=%s AND NOT iptal""", (yid,))
        hs = [dict(x) for x in cur.fetchall() or []]
        if not hs:
            raise HTTPException(404, "Sevk bulunamadı")
        sev = next((h for h in hs if h["tur"] == "sevk"), None)
        sevk = sum(h["adet"] for h in hs if h["tur"] == "sevk")
        kab = sum(h["adet"] for h in hs if h["tur"] == "kabul")
        coz = sum(h["adet"] for h in hs if h["tur"] in ("kayip", "iade_geri"))
        fazla = sum(h["adet"] for h in hs if h["tur"] == "fazla_kabul") - sum(h["adet"] for h in hs if h["tur"] in ("fazla_onay", "fazla_ret"))
        hedef = next((h["hedef"] for h in hs if h["tur"] == "kabul"), None)
        u, ua = hs[0]["urun_id"], hs[0]["urun_ad"]
        ek = f" · {body.not_}" if body.not_ else ""
        if body.karar in ("kayip", "iade"):
            kalan = sevk - kab - coz
            if kalan <= 0:
                raise HTTPException(400, "Yolda kalan eksik yok")
            row = (f"yolda:{yid}:coz:{body.karar}:{uuid.uuid4().hex[:6]}", "kayip" if body.karar == "kayip" else "iade_geri", u, ua, kalan, "yolda",
                   "dışarı:kayip" if body.karar == "kayip" else (sev or {}).get("kaynak"), _bugun(), _simdi_tr(), kim,
                   ("Eksik geldi → KAYIP" if body.karar == "kayip" else "Eksik geldi → kaynağa geri") + ek, yid)
        elif body.karar in ("fazla_onay", "fazla_ret"):
            if fazla <= 0 or not hedef:
                raise HTTPException(400, "Askıda fazla yok")
            row = (f"yolda:{yid}:coz:{body.karar}:{uuid.uuid4().hex[:6]}", body.karar, u, ua, fazla, "askida",
                   hedef if body.karar == "fazla_onay" else "dışarı:bilinmeyen", _bugun(), _simdi_tr(), kim,
                   ("Fazla kabul ONAYLANDI → şube stoğuna" if body.karar == "fazla_onay" else "Fazla kabul REDDEDİLDİ (birim hatası)") + ek, yid)
        else:
            raise HTTPException(400, "karar: kayip | iade | fazla_onay | fazla_ret")
        _yaz(cur, [row], yeni=bool(hs[0].get("yeni")))   # Fable: çözüm sevkin evreninde (aksi hâlde yeni evrende sevk hep 'yolda')
    return {"ok": True, "mesaj": "Fark çözüldü"}


@router.post("/senkron")
def depo_senkron_simdi():
    with db() as (conn, cur):
        r = senkron(cur)
    _SON_SENKRON["zaman"] = time.time()
    _SON_SENKRON["sonuc"] = r
    return {"ok": True, "rapor": r}


def depo_isleri(cur) -> list:
    """Bekleyen işler: GEC_KABUL_GUN'den uzun süredir yolda olan sevkler."""
    depo_hazirla(cur)
    cur.execute("""SELECT bag, MAX(urun_ad) AS urun, MIN(is_gunu) AS gun FROM ey_stok_hareket WHERE bag IS NOT NULL AND NOT iptal
                      AND yeni = %s
                    GROUP BY bag HAVING SUM(CASE WHEN tur='sevk' THEN 1 ELSE 0 END) > 0
                       AND SUM(CASE WHEN tur='kabul' THEN 1 ELSE 0 END) = 0
                       AND MIN(is_gunu) <= %s""", (evren_yeni(cur), _bugun() - timedelta(days=GEC_KABUL_GUN)))
    rs = [dict(r) for r in cur.fetchall() or []]
    if not rs:
        return []
    return [{"tur": "depo_yolda", "grup": "tedarik", "id": "dy", "tarih": min(r["gun"] for r in rs).isoformat(), "ad": f"{len(rs)} sevk kalemi",
             "sayi": len(rs), "ornek": ", ".join(str(r["urun"]) for r in rs[:3])}]


# 🧩 Bekleyen işler kayıt defterine (Kasa bu modülü tanımaz; modül kapanınca satırları da kalkar)
bekleyen_is_kaydet("depo", lambda cur, b: depo_isleri(cur))
