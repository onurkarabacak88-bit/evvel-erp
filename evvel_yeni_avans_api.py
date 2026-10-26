"""🤝 EVVEL YENİ · AVANS TALEPLERİ (2026-10-17) — tak-çıkar modül (sayfası Personel altında).

Sahip (envanter madde 13): "Avans taleplerini görebileceğim bir mekanizma olmalı." Personel talebi QR personel sayfasından
gönderiyor (eski avans_service → personel_avans 'talep'); onay yalnız eski Cep uygulamasındaydı → Eylül'den bekleyen talepler
kimse görmeden kaldı.
  · Liste: açık talepler (talep · onaylandı-elden teslim bekliyor) + Bekleyen işler'de tek satır (çekirdek kayıt defteri).
  · Onay (havale / elden) ve ret ŞİMDİLİK yalnız eski avans akışıyla (Codex: iki sisteme yazmak çift mahsup + ayrışma üretiyordu).
  · Reddet: eski reddet.
KÖPRÜ (eski sistem kalkınca: talepler doğrudan Evvel Yeni'ye yazılacak — KESIM_LISTESI): personel_avans okuması ve
avans_service.avans_onayla / avans_reddet çağrıları.

🆕 1 KASIM (kesim engeli T3-17 — Fable mekanizması + sahip kararları 20 Eki): talep defteri Evvel Yeni'nin `ey_avans_talep`
tablosu (kimlikler 'av-…'). Talep telefondan (yoklama /avans — imzalı cihaz); TAVAN = eski oran (Maaş PUBLIC avans_tavani).
Havale onayı = Ödeme formunun KENDİ yolu (konu personel · kalem Avans → Kasa → Maaş mahsup; ikinci yazıcı yok). Elden onay →
şube panelinde ad + PIN "teslim ettim" → Kasa PUBLIC sube_avansi_yaz (çekmeceden düşer, Maaş 'Avans (şube)' mahsup).
Personelin "aldım" onayı KALKTI (sahip). 1 Kasım'a kadar eski talepler eski yoldan; sonra yalnız yeni defter.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import uuid
from decimal import Decimal
from datetime import date

from database import db, savepoint
from evvel_yeni_cekirdek import merkez_aktor
from evvel_yeni_cekirdek import aktor as _aktor, bekleyen_is_kaydet, bugun as _bugun, yeni_donem

router = APIRouter(prefix="/api/evvel-yeni/avans", tags=["evvel-yeni-avans"])
log = logging.getLogger(__name__)


# ─────────────────────────── 🆕 YENİ DEFTER ey_avans_talep ───────────────────────────
def avans_hazirla(cur) -> None:
    """Çağıranın işleminde, savepoint + lock_timeout; yalnız eksikse (19 Eki dersi)."""
    if __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_avans_talep"):
        _teslim_pid_kolonu(cur)
        return
    try:
        with savepoint(cur, "sp_ey_avans_hazirla"):
            _onceki_lt = __import__("evvel_yeni_cekirdek").lock_timeout_ayarla(cur, "3s")
            cur.execute("""CREATE TABLE IF NOT EXISTS ey_avans_talep (
                id TEXT PRIMARY KEY, personel_id TEXT NOT NULL, tutar BIGINT NOT NULL, donem TEXT NOT NULL, not_ TEXT,
                durum TEXT NOT NULL DEFAULT 'talep', yontem TEXT, sube_id TEXT, istek_id TEXT UNIQUE,
                talep_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), karar_ts TIMESTAMPTZ, karar_kim TEXT, karar_not TEXT,
                odeme_ref TEXT, teslim_ts TIMESTAMPTZ, teslim_kim TEXT)""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_ey_avans_p ON ey_avans_talep (personel_id, donem)")
            __import__("evvel_yeni_cekirdek").lock_timeout_ayarla(cur, _onceki_lt)   # çağıranın değeri geri (Fable D4-4)
    except Exception:  # noqa: BLE001
        log.warning("avans tablosu kurulamadı", exc_info=True)
        raise HTTPException(503, "Avans hazırlanıyor — birkaç saniye sonra tekrar dene")


_TESLIM_PID = False


def _teslim_pid_kolonu(cur) -> None:
    """F4.2 (Fable): avansı ÇEKMECEDEN veren kişinin kimliği — 'kendine teslim' görünsün. Yalnız eksikse, savepoint + lock_timeout."""
    global _TESLIM_PID
    if _TESLIM_PID:
        return
    cur.execute("""SELECT 1 FROM information_schema.columns WHERE table_name='ey_avans_talep' AND column_name='teslim_pid'""")
    if not cur.fetchone():
        try:
            with savepoint(cur, "sp_ey_avans_teslim_pid"):
                _lt = __import__("evvel_yeni_cekirdek").lock_timeout_ayarla(cur, "3s")
                cur.execute("ALTER TABLE ey_avans_talep ADD COLUMN IF NOT EXISTS teslim_pid TEXT")
                __import__("evvel_yeni_cekirdek").lock_timeout_ayarla(cur, _lt)
        except Exception:  # noqa: BLE001
            log.warning("avans teslim_pid kolonu eklenemedi — sonraki istekte yeniden", exc_info=True)
            return
    _TESLIM_PID = True


def _veren(r: dict, pad: dict) -> tuple:
    """(veren adı, kendine mi) — teslim_pid varsa kimlikle; eski satırda teslim_kim metninin son parçası."""
    pid = r.get("teslim_pid")
    if pid:
        return pad.get(str(pid)) or "—", str(pid) == str(r["personel_id"])
    k = (r.get("teslim_kim") or "").split(" · ")[-1].strip()
    return (k or None), bool(k) and k == pad.get(str(r["personel_id"]))   # eski satır (kimlik alanı öncesi): ad eşlemesi yedek


AKTIF = ("talep", "onaylandi", "odendi")   # tavana sayılan


def avans_durumu(cur, personel_id: str, ay: Optional[str] = None) -> dict:
    """PUBLIC (telefon): tavan · o ay (verilmezse bu ay) kullanılan · kullanılabilir · açık talep (kuruş). Tavan Maaş'ın (eski oran).
    ay verilirse tavan O AYIN sonuna göre (Codex 2. tur: önceki aydan bekleyen talep onaylanırken bu ayın toplamına bakılıyordu)."""
    avans_hazirla(cur)
    _eski_kopya_gerekirse(cur)   # eski açık talep taşınmadan ikinci talep açılmasın
    from evvel_yeni_maas_api import avans_tavani
    gun = None
    if ay and ay[:7] != __import__("evvel_yeni_cekirdek").is_gunu().strftime("%Y-%m"):   # Maaş tavanıyla aynı gün kuralı
        from evvel_yeni_cekirdek import ay_gunu
        gun = ay_gunu(int(ay[:4]), int(ay[5:7]), 31)   # geçmiş ayın son günü — hak ediş o ayın tamamı
    t = avans_tavani(cur, str(personel_id), gun)
    cur.execute("SELECT COALESCE(SUM(tutar),0) AS k FROM ey_avans_talep WHERE personel_id=%s AND donem=%s AND durum = ANY(%s)",
                (str(personel_id), t["ay"], list(AKTIF)))
    kul = int(dict(cur.fetchone())["k"] or 0)
    cur.execute("""SELECT id, tutar, durum, yontem, talep_ts, sube_id FROM ey_avans_talep WHERE personel_id=%s AND durum IN ('talep','onaylandi')
                    ORDER BY talep_ts DESC LIMIT 1""", (str(personel_id),))
    ac = cur.fetchone()
    from evvel_yeni_tanim_api import adlar as _adlar
    sad = _adlar(cur, "ey_sube")   # şube adı Tanımlar kapısından (F4.2 sahip: "nereden alacağım" telefonda)
    # B47: son 7 günde SONUÇLANAN talep — personel telefonda görsün (sessizce kaybolmasın); açık talep varken gerekmez
    son = None
    if not ac:
        cur.execute("""SELECT personel_id, tutar, durum, yontem, karar_not, sube_id, teslim_kim, teslim_pid,
                                  COALESCE(teslim_ts, karar_ts) AS ts FROM ey_avans_talep
                        WHERE personel_id=%s AND durum IN ('odendi','reddedildi','kapatildi')
                          AND COALESCE(teslim_ts, karar_ts) >= NOW() - INTERVAL '7 days' ORDER BY COALESCE(teslim_ts, karar_ts) DESC LIMIT 1""",
                    (str(personel_id),))
        r = cur.fetchone()
        if r:
            r = dict(r)
            son = {"tutar": r["tutar"], "durum": r["durum"], "yontem": r.get("yontem"), "ts": str(r["ts"])[:10],
                   "saat": __import__("evvel_yeni_cekirdek").tr_saat(r["ts"]) if r.get("ts") else None,
                   "sube": sad.get(str(r.get("sube_id"))) if r.get("yontem") == "elden" else None,
                   "kendine": r["durum"] == "odendi" and _veren(r, _adlar(cur, "ey_personel", [x for x in (personel_id, r.get("teslim_pid")) if x]))[1],
                   "neden": (r.get("karar_not") or "")[:120] if r["durum"] in ("reddedildi", "kapatildi") else None}   # B46 + F4.2 kapatma notu
    # F4.2 (sahip: "alınca personel cepte de görünmeli"): bu AYIN alınan avansları kalıcı (7 gün değil) — maaştan düşülecekle aynı
    cur.execute("""SELECT tutar, yontem, sube_id, COALESCE(teslim_ts, karar_ts) AS ts FROM ey_avans_talep
                    WHERE personel_id=%s AND donem=%s AND durum='odendi' ORDER BY COALESCE(teslim_ts, karar_ts)""", (str(personel_id), t["ay"]))
    bu_ay = [{"tutar": int(x["tutar"]), "yontem": x.get("yontem"), "sube": sad.get(str(x.get("sube_id"))) if x.get("yontem") == "elden" else None,
              "ts": str(x["ts"])[:10]} for x in (dict(y) for y in cur.fetchall() or [])]
    return {"ay": t["ay"], "tavan": t["tavan"], "kullanilan": kul, "kullanilabilir": max(0, t["tavan"] - kul),
            "acik": ({**dict(ac), "talep_ts": str(dict(ac)["talep_ts"])[:16],
                      "sube": sad.get(str(dict(ac).get("sube_id"))) if dict(ac).get("yontem") == "elden" else None} if ac else None),
            "son": son, "bu_ay": bu_ay}


def _onay_denetle(cur, t: dict) -> None:
    """Onay ANINDA yeniden denetim (Codex P1 — eski avans_onayla da yapıyordu): personel hâlâ AKTİF mi · bu ayın avansları (bu talep
    dahil) GÜNCEL tavanı aşıyor mu (talepten sonra ücret/saat düzeltilip tavan düştüyse onay verilmez)."""
    from evvel_yeni_tanim_api import tanim_oku
    p = tanim_oku(cur, "ey_personel", t["personel_id"], ("aktif", "cikis"))
    if not p or not p["aktif"]:
        raise HTTPException(409, "Personel pasif — avans verilemez (talebi kapat ya da reddet)")
    if __import__("evvel_yeni_tanim_api").ayrildi_mi(p.get("cikis"), __import__("evvel_yeni_cekirdek").is_gunu()):   # Fable (S-B7 denetimi)
        raise HTTPException(409, "Personelin ayrılış tarihi geçti — avans verilemez (talebi kapat ya da reddet)")
    d = avans_durumu(cur, t["personel_id"], t["donem"])   # talebin AYI (önceki aydan bekleyen talep o ayın tavanına bakar)
    if d["kullanilan"] > d["tavan"]:
        raise HTTPException(409, f"Güncel avans tavanı {d['tavan'] / 100:,.0f} ₺ — bu ay talepler bunu aşıyor; reddet ya da tavan "
                                 f"düzelince onayla".replace(",", "."))


def talep_yaz(cur, *, personel_id: str, tutar: int, not_: Optional[str], istek_id: str) -> dict:
    """PUBLIC (telefon talebi): açık talep varken ikinci talep yok (eski kural) · tavanı aşan talep yok (eski oran)."""
    avans_hazirla(cur)
    istek_id = __import__("evvel_yeni_cekirdek").istek_dogrula(istek_id)   # TEK kural (F#15)
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("ey_avans:" + str(personel_id),))
    cur.execute("SELECT id, tutar FROM ey_avans_talep WHERE istek_id=%s", (str(istek_id),))
    r = cur.fetchone()
    if r:
        if int(dict(r)["tutar"]) != int(tutar):
            raise HTTPException(409, "Bu istek başka tutarla gönderilmiş — sayfayı yenile")
        return {"id": dict(r)["id"], "tekrar": True}
    d = avans_durumu(cur, personel_id)
    if d["acik"]:
        raise HTTPException(409, "Açık avans talebin var — sonuçlanınca yenisini açabilirsin")
    if tutar <= 0:
        raise HTTPException(400, "Tutar yaz")
    if d["tavan"] <= 0:
        raise HTTPException(409, "Bu ay henüz hak ediş oluşmadı — avans talep edilemez")
    if tutar > d["kullanilabilir"]:
        raise HTTPException(409, f"En çok {d['kullanilabilir'] / 100:,.0f} ₺ talep edebilirsin".replace(",", "."))
    tid = "av-" + uuid.uuid4().hex[:12]
    cur.execute("""INSERT INTO ey_avans_talep (id, personel_id, tutar, donem, not_, istek_id) VALUES (%s,%s,%s,%s,%s,%s)""",
                (tid, str(personel_id), int(tutar), d["ay"], (not_ or "").strip()[:200] or None, str(istek_id)))
    return {"id": tid, "tekrar": False}


def _yeni_talepler(cur, acik: bool = True, ayrinti: bool = False) -> list:
    if not __import__("evvel_yeni_cekirdek").tablo_var(cur, "ey_avans_talep"):
        return []
    from evvel_yeni_tanim_api import adlar   # personel / şube adı Tanımlar'ın kapısından (C-T2-11)
    cur.execute(f"""SELECT a.* FROM ey_avans_talep a
                     WHERE {"a.durum IN ('talep','onaylandi')" if acik else "a.durum IN ('reddedildi','kapatildi','odendi') AND a.talep_ts >= NOW() - INTERVAL '60 days'"}
                     ORDER BY a.talep_ts {"" if acik else "DESC"}""")
    rows = [dict(x) for x in cur.fetchall() or []]
    sad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube")
    pad = adlar(cur, "ey_personel", {r["personel_id"] for r in rows} | {r.get("teslim_pid") for r in rows if r.get("teslim_pid")})
    cik = {p["id"]: p["cikis"] for p in __import__("evvel_yeni_tanim_api").tanim_listesi(cur, "ey_personel", ("cikis",),
                                                                                       idler={str(r["personel_id"]) for r in rows}) if p.get("cikis")}
    return [{"id": r["id"], "personel_id": r["personel_id"], "ad": pad.get(str(r["personel_id"])) or "—", "tutar": int(r["tutar"]) / 100, "durum": r["durum"],
             "ayrilis": cik[str(r["personel_id"])].strftime("%d.%m") if str(r["personel_id"]) in cik else None,   # S-B8: ekranda 'ayrıldı' işareti
             "yontem": r.get("yontem"), "sube": sad.get(r.get("sube_id")), "sube_id": r.get("sube_id"), "donem": r["donem"],
             "talep": str(r["talep_ts"])[:16], "onay": str(r.get("karar_ts") or "")[:16],
             "not": " · ".join(x for x in (r.get("not_"), r.get("karar_not")) if x) or None,   # Fable: talep notu varken şube izi de görünsün
             "yeni": True, **_ek(cur, r, pad, acik, ayrinti)} for r in rows]


def _ek(cur, r: dict, pad: dict, acik: bool, ayrinti: bool = False) -> dict:
    """F4.2 (sim 26 Eki · Fable): merkez satırı kendini anlatsın — talepte öntanımlı şube + bu ay tavan / kullanılan; onaylı-elden
    bekleme günü; kapananda veren + kendine teslim."""
    if not acik:
        if r["durum"] != "odendi":
            return {}
        v, kendi = _veren(r, pad)
        return {"veren": v, "kendine": kendi, "teslim": str(r.get("teslim_ts") or r.get("karar_ts") or "")[:16]}
    if r["durum"] == "onaylandi":
        from evvel_yeni_cekirdek import tr_gun, is_gunu
        return {"bekliyor_gun": (is_gunu() - tr_gun(r["karar_ts"])).days if r.get("karar_ts") else None}
    if not ayrinti:   # Fable P2: şube paneli (elden_bekleyen) 5–15 sn'de bir çağırır — maaş hesabı yalnız merkez listesinde
        return {}
    d = avans_durumu(cur, r["personel_id"], r["donem"])
    return {"tavan": d["tavan"] / 100, "kullanilan": d["kullanilan"] / 100, "kisi_sube_id": _kisi_subesi(cur, r["personel_id"])}


def _kisi_subesi(cur, personel_id: str) -> Optional[str]:
    """'Elden ver' öntanımı (Fable sırası): bugün QR'la girdiği şube (Yoklama PUBLIC) → kadro şubesi → aktif değilse boş."""
    from evvel_yeni_moduller import acik as _acik
    from evvel_yeni_tanim_api import subeler as _subeler, tanim_oku
    aktif = {str(s["id"]) for s in _subeler(cur)}
    s = None
    if _acik("yoklama"):
        s = __import__("evvel_yeni_yoklama_api").kisinin_bugunku_subesi(cur, personel_id)
    if not s:
        p = tanim_oku(cur, "ey_personel", personel_id, ("sube_id",))
        s = str(p["sube_id"]) if p and p.get("sube_id") else None
    return s if s in aktif else None


def elden_bekleyen(cur, sube_id: str) -> list:
    """PUBLIC (şube paneli): bu şubeden ELDEN verilecek onaylı avanslar (personel adı + tutar)."""
    _eski_kopya_gerekirse(cur)   # 1 Kasım: eski onaylı-elden avanslar panelde kaybolmasın
    return [t for t in _yeni_talepler(cur) if t["durum"] == "onaylandi" and t["yontem"] == "elden" and t["sube_id"] == str(sube_id)]


def elden_teslim_yaz(cur, *, talep_id: str, sube_id: str, kim: str, gun: date, veren_pid: Optional[str] = None) -> dict:
    """PUBLIC (panel 'teslim ettim'): Kasa sube_avansi_yaz (çekmeceden düşer) + talep 'odendi'. Aynı talep ikinci kez → tekrar."""
    avans_hazirla(cur)
    from evvel_yeni_kasa_api import sube_avansi_yaz
    cur.execute("SELECT * FROM ey_avans_talep WHERE id=%s FOR UPDATE", (talep_id,))
    t = cur.fetchone()
    if not t:
        raise HTTPException(404, "Avans bulunamadı")
    t = dict(t)
    if t["durum"] == "odendi":
        return {"tekrar": True}
    if t["durum"] != "onaylandi" or t.get("yontem") != "elden" or t.get("sube_id") != str(sube_id):
        raise HTTPException(409, "Bu avans bu şubeden elden verilecek değil — sayfayı yenile")
    from evvel_yeni_tanim_api import adlar
    pad = adlar(cur, "ey_personel", [t["personel_id"]]).get(str(t["personel_id"]))
    ref = f"avans:{talep_id}"
    sube_avansi_yaz(cur, sube_id=str(sube_id), gun=gun.isoformat(), tutar=int(t["tutar"]), personel_id=t["personel_id"], personel_ad=pad,
                    ait_ay=t["donem"], kim=kim, kaynak_ref=ref)
    cur.execute("UPDATE ey_avans_talep SET durum='odendi', odeme_ref=%s, teslim_ts=NOW(), teslim_kim=%s, teslim_pid=%s WHERE id=%s",
                (ref, kim, veren_pid, talep_id))
    return {"tekrar": False, "tutar": int(t["tutar"]), "personel": pad}


def _acik_talepler(cur) -> list:
    """KÖPRÜ: eski personel_avans'ta açık talepler (talep · onaylandı-elden). Okunamazsa HATA yükselir (Codex: 'talep yok' sanılmasın)."""
    try:
        with savepoint(cur, "sp_ey_avans_oku"):
            cur.execute("""SELECT pa.id::text AS id, pa.personel_id::text AS personel_id, pa.tutar, pa.durum, pa.odeme_yontemi,
                                  pa.sube_id::text AS sube_id, pa.talep_ts, pa.onay_ts, pa.donem_yil, pa.donem_ay,
                                  p.ad_soyad AS ad, s.ad AS sube_ad
                             FROM personel_avans pa
                             LEFT JOIN personel p ON p.id::text = pa.personel_id::text
                             LEFT JOIN subeler s ON s.id::text = pa.sube_id::text
                            WHERE pa.durum IN ('talep','onaylandi','teslim_edildi')
                            ORDER BY pa.talep_ts""")
            out = []
            for r in cur.fetchall() or []:
                r = dict(r)
                out.append({"id": r["id"], "personel_id": r["personel_id"], "ad": r["ad"] or "—", "tutar": float(r["tutar"] or 0),
                            "durum": r["durum"], "yontem": r.get("odeme_yontemi"), "sube": r.get("sube_ad"), "sube_id": r.get("sube_id"),
                            "talep": str(r.get("talep_ts") or "")[:16], "onay": str(r.get("onay_ts") or "")[:16],
                            "donem": f"{int(r['donem_yil'])}-{int(r['donem_ay']):02d}" if r.get("donem_yil") else None})
            return out
    except Exception as e:  # noqa: BLE001
        log.warning("avans talepleri okunamadı: %s", str(e)[:150])
        raise HTTPException(503, "Avans talepleri okunamadı — biraz sonra yeniden dene")


def _bekleyen(cur, baglam: dict) -> list:
    """Bekleyen işler: karar bekleyen (durum 'talep') her avans talebi tek satır."""
    return [{"tur": "avans_talep", "genel": True, "grup": "personel", "id": f"avans:{t['id']}", "tarih": (t["talep"] or _bugun().isoformat())[:10],
             "etiket": "🤝 Avans talebi", "ad": t["ad"], "alt": f"{t['tutar']:,.0f} ₺ — onayla ya da reddet".replace(",", "."),
             "sayfa": "avans_talepleri", "dugme": "Avans talepleri"}
            for t in _tum_acik(cur) if t["durum"] == "talep"]


def _eski_acik_kopyala(cur) -> None:
    """1 KASIM — BİR KEZ (Codex P1: yeni dönemde eski açık talepler okunmuyordu → merkez listesinden ve Bekleyen işler'den
    KAYBOLUYORDU): eski personel_avans'taki AÇIK talepler yeni deftere taşınır — karar bekleyen 'talep' → 'talep', onaylanmış ELDEN
    (şube teslim etmedi) → 'onaylandi' aynı şubeyle (panel 'teslim ettim' görür). 'teslim_edildi' (para çekmeceden çıktı, yalnız
    personel 'aldım'ı bekliyordu — o onay kalktı) taşınmaz. Köprü değil: sonra eski tablo okunmaz (KESİM)."""
    avans_hazirla(cur)
    for t in _acik_talepler(cur):   # okunamazsa istisna → bir_kez işaretlemez, sonra yeniden dener
        if t["durum"] == "talep":
            durum, yontem, sube = "talep", None, None
        elif t["durum"] == "onaylandi" and t.get("yontem") == "elden" and t.get("sube_id"):
            durum, yontem, sube = "onaylandi", "elden", str(t["sube_id"])
        else:
            continue
        cur.execute("""INSERT INTO ey_avans_talep (id, personel_id, tutar, donem, not_, durum, yontem, sube_id, istek_id, karar_kim)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
                    ("av-e-" + str(t["id"])[:36], str(t["personel_id"]), int(round(float(t["tutar"]) * 100)),
                     t.get("donem") or _bugun().strftime("%Y-%m"), "eski sistemden taşındı", durum, yontem, sube,
                     "eski-" + str(t["id"])[:60], "eski sistem" if durum == "onaylandi" else None))


def _eski_kopya_gerekirse(cur) -> bool:
    """Yeni dönemse eski açıkları (bir kez) taşır; dönüş: yeni dönem mi. Panel / telefon / merkez — hangisi önce okursa."""
    if not yeni_donem(cur):
        return False
    __import__("evvel_yeni_cekirdek").bir_kez(cur, "avans_eski_acik_kopya", _eski_acik_kopyala, "avans eski açık kopyası")
    return True


def _tum_acik(cur, ayrinti: bool = False) -> list:
    """Yeni defter + (1 Kasım'a kadar) eski personel_avans açıkları; 1 Kasım'dan sonra eski açıklar BİR KEZ yeni deftere taşınır."""
    if _eski_kopya_gerekirse(cur):
        if __import__("evvel_yeni_cekirdek").ayar_oku(cur, "avans_eski_acik_kopya") is not None:
            return _yeni_talepler(cur, ayrinti=ayrinti)
        try:   # Fable son denetim S-3: kopya olmadıysa eski açıklar okunmaya devam eder (sessizce kaybolmaz)
            return _acik_talepler(cur) + _yeni_talepler(cur, ayrinti=ayrinti)
        except HTTPException:   # eski tablo artık yok (eski sistem kalktı) → yalnız yeni defter; log _acik_talepler'de
            return _yeni_talepler(cur, ayrinti=ayrinti)
    return _acik_talepler(cur) + _yeni_talepler(cur, ayrinti=ayrinti)


bekleyen_is_kaydet("avans_talep", _bekleyen)


def _kapananlar(cur) -> list:
    """KÖPRÜ: son 60 günde kapatılan / reddedilen talepler (ekranda gri)."""
    try:
        with savepoint(cur, "sp_ey_avans_kapali"):
            cur.execute("""SELECT pa.id::text AS id, pa.tutar, pa.durum, pa.talep_ts, pa.not_aciklama, p.ad_soyad AS ad
                             FROM personel_avans pa LEFT JOIN personel p ON p.id::text = pa.personel_id::text
                            WHERE pa.durum IN ('iptal','reddedildi') AND pa.talep_ts >= NOW() - INTERVAL '60 days'
                            ORDER BY pa.talep_ts DESC""")
            return [{"id": dict(r)["id"], "ad": dict(r)["ad"] or "—", "tutar": float(dict(r)["tutar"] or 0), "durum": dict(r)["durum"],
                     "talep": str(dict(r)["talep_ts"] or "")[:16], "not": dict(r).get("not_aciklama")} for r in cur.fetchall() or []]
    except Exception:  # noqa: BLE001
        return []


@router.get("/talepler")
def talepler():
    with db() as (conn, cur):
        kapanan = _yeni_talepler(cur, acik=False) + ([] if yeni_donem(cur) else _kapananlar(cur))
        return {"talepler": _tum_acik(cur, ayrinti=True), "kapananlar": kapanan, "bugun": _bugun().isoformat()}


class KapatBody(BaseModel):
    not_: Optional[str] = None


@router.post("/{aid}/kapat")
def kapat(aid: str, body: KapatBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Sahip (2026-10-17): "Bu avanslar Eylül'de verilmişti, kapatıldı — grileştir." Talep PARA HAREKETİ OLMADAN kapanır
    (eski sistemde 'iptal' — para çıkmamış kayıt; maaş mahsubu oluşturmaz). Açık talep kalırsa personel yeni talep açamıyordu."""
    if aid.startswith("av-"):
        _karar(aid, "kapatildi", x_evvel_oturum, (body.not_ or "daha önce verildi")[:200], onceki=("talep", "onaylandi"))
        return {"ok": True, "mesaj": "Talep kapatıldı (para hareketi yok)"}
    import avans_service as eski
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
    eski.avans_iptal(aid, eski.AvansIptalModel(neden=f"Kapatıldı ({kim}): {(body.not_ or 'daha önce verildi')}"[:200]))
    return {"ok": True, "mesaj": "Talep kapatıldı (para hareketi yok)"}


def _karar(aid: str, durum: str, jeton: Optional[str], notu: Optional[str] = None, onceki: tuple = ("talep",), **alan) -> dict:
    """Yeni defterde talebin kararı (yalnız 'onceki' durumdaki — varsayılan 'talep'). Teslim edilmemiş onaylı-elden talep de
    kapatılır/reddedilir (Fable O-2: kişi ayrıldı, şube teslim etmedi → talep sonsuza kadar açık kalıyor, yenisi açılamıyordu)."""
    with db() as (conn, cur):
        avans_hazirla(cur)
        kim = merkez_aktor(cur, jeton)   # çekirdek kapısı (F#2)
        ek = "".join(f", {k}=%s" for k in alan)
        cur.execute(f"""UPDATE ey_avans_talep SET durum=%s, karar_ts=NOW(), karar_kim=%s, karar_not=%s{ek}
                         WHERE id=%s AND durum = ANY(%s) RETURNING *""", (durum, kim, notu, *alan.values(), aid, list(onceki)))
        t = cur.fetchone()
        if not t:
            raise HTTPException(409, "Talep bulunamadı ya da karar verilmiş — sayfayı yenile")
        return {**dict(t), "kim": kim}


class OnayBody(BaseModel):
    yontem: str                    # havale | elden
    cep: Optional[str] = None      # havale: hangi bankadan (Evvel Yeni cebi)
    sube_id: Optional[str] = None  # elden: hangi şubeden verilecek


@router.post("/{aid}/onayla")
def onayla(aid: str, body: OnayBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Yeni defter (av-…): HAVALE = Ödeme formunun kendi yazma çekirdeği (seçilen bankadan düşer · Maaş 'Avans' mahsup) + talep
    'odendi' TEK işlemde (onay = gönderildi; ayrı "havale gelecek" adımı yok — Fable F4.2). ELDEN = talep 'onaylandi' + şube; şube
    panelinde "Teslim ettim" (PIN) → Kasa sube_avansi_yaz (dükkân nakdinden düşer) + Maaş mahsup. Eski personel_avans kayıtları
    (1 Kasım öncesi) eski avans_service yoluyla."""
    if body.yontem not in ("havale", "elden"):
        raise HTTPException(400, "Yöntem: havale ya da elden")
    if body.yontem == "elden" and not body.sube_id:
        raise HTTPException(400, "Elden verilecekse şubeyi seç")
    if aid.startswith("av-"):
        if body.yontem == "elden":
            with db() as (conn, cur):   # Fable D-5: olmayan / pasif şubeye onay verilirse talep hiçbir panelde görünmez
                from evvel_yeni_tanim_api import subeler as _subeler
                if str(body.sube_id) not in {str(s["id"]) for s in _subeler(cur)}:
                    raise HTTPException(400, "Şube bulunamadı ya da pasif")
                kim = merkez_aktor(cur, x_evvel_oturum)
                # Fable D4-10: denetim + karar TEK işlemde (talep satırı kilitli — havale yoluyla aynı)
                cur.execute("SELECT * FROM ey_avans_talep WHERE id=%s FOR UPDATE", (aid,))
                _t = cur.fetchone()
                if not _t or dict(_t)["durum"] != "talep":
                    raise HTTPException(409, "Talep bulunamadı ya da karar verilmiş — sayfayı yenile")
                _onay_denetle(cur, dict(_t))   # Codex P1: aktiflik + güncel tavan
                cur.execute("""UPDATE ey_avans_talep SET durum='onaylandi', karar_ts=NOW(), karar_kim=%s, yontem='elden', sube_id=%s
                                WHERE id=%s""", (kim, str(body.sube_id), aid))
            return {"ok": True, "mesaj": "Avans onaylandı — şube panelinde 'teslim ettim' denince dükkân kasasından düşer"}
        if not body.cep:
            raise HTTPException(400, "Havale hangi bankadan? — cep seç")
        import evvel_yeni_odeme_api as o   # Ödeme formunun KENDİ yazma çekirdeği (konu personel · kalem Avans) — ikinci yazıcı yok
        from evvel_yeni_kasa_api import kasa_hazirla
        kasa_hazirla()
        # Fable O-1: talep kilidi → para → durum TEK işlemde (önce üç ayrı işlemdi: aynı anda 'elden' onayı gelirse para bankadan
        # çıkıp talep 'onaylandı-elden' kalıyor, şube de verince ÇİFT avans). Kilit sırası panel teslimiyle aynı: talep → Kasa.
        with db() as (conn, cur):
            avans_hazirla(cur)
            kim = merkez_aktor(cur, x_evvel_oturum)   # çekirdek kapısı (F#2)
            cur.execute("SELECT * FROM ey_avans_talep WHERE id=%s FOR UPDATE", (aid,))
            t = cur.fetchone()
            if not t or dict(t)["durum"] != "talep":
                raise HTTPException(409, "Talep bulunamadı ya da karar verilmiş — sayfayı yenile")
            t = dict(t)
            _onay_denetle(cur, t)   # Codex P1: pasif personele / tavanı aşan avans havale edilmez
            o.odeme_yaz(cur, o.OdemeBody(konu="personel", personel_id=t["personel_id"], personel_kalemi="Avans", ait_ay=t["donem"],
                                         aciklama=f"Avans (havale) · talep {aid}", istek_id=f"avans-{aid}", tekrar_onay=True,
                                         parcalar=[o.Parca(yontem="havale", cep=body.cep, tutar=Decimal(int(t["tutar"])) / 100)]), kim)
            cur.execute("""UPDATE ey_avans_talep SET durum='odendi', karar_ts=NOW(), karar_kim=%s, yontem='havale', odeme_ref=%s
                            WHERE id=%s""", (kim, f"odeme_formu:avans-{aid}", aid))
        return {"ok": True, "mesaj": "Avans havaleyle ödendi (bankadan düştü, maaştan mahsup edilir)"}
    import avans_service as eski
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
    eski.avans_onayla(aid, eski.AvansOnayModel(yontem=body.yontem, sube_id=body.sube_id if body.yontem == "elden" else None, onaylayan=kim))
    return {"ok": True, "mesaj": "Avans havaleyle ödendi olarak işaretlendi (maaştan düşer)" if body.yontem == "havale"
            else "Avans onaylandı — şube panelinden teslim edilince dükkân kasasından düşer"}


class SubeBody(BaseModel):
    sube_id: str


@router.post("/{aid}/sube")
def sube_degistir(aid: str, body: SubeBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """F4.2 (Opus risk 3): onaylı-elden avansı kişi o şubeye gitmiyorsa başka şubeden ver — para hareketi yok, yalnız şube."""
    with db() as (conn, cur):
        avans_hazirla(cur)
        kim = merkez_aktor(cur, x_evvel_oturum)
        from evvel_yeni_tanim_api import subeler as _subeler
        if str(body.sube_id) not in {str(s["id"]) for s in _subeler(cur)}:
            raise HTTPException(400, "Şube bulunamadı ya da pasif")
        ad = __import__("evvel_yeni_tanim_api").adlar(cur, "ey_sube", [str(body.sube_id)]).get(str(body.sube_id)) or str(body.sube_id)
        cur.execute("""UPDATE ey_avans_talep SET sube_id=%s,
                              karar_not=LEFT(CONCAT_WS(' · ', NULLIF(karar_not, ''), %s), 200)
                        WHERE id=%s AND durum='onaylandi' AND yontem='elden' RETURNING id""",
                    (str(body.sube_id), f"şube → {ad} ({kim})", aid))   # Fable: onaylayan (karar_kim) silinmez, iz notta
        if not cur.fetchone():
            raise HTTPException(409, "Talep teslim edilmiş ya da değişmiş — sayfayı yenile")
    return {"ok": True, "mesaj": "Şube değişti — o şubenin panelinde görünür"}


class RedBody(BaseModel):
    neden: Optional[str] = None


@router.post("/{aid}/reddet")
def reddet(aid: str, body: RedBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    if aid.startswith("av-"):
        _karar(aid, "reddedildi", x_evvel_oturum, (body.neden or "Merkez reddetti")[:200], onceki=("talep", "onaylandi"))
        return {"ok": True, "mesaj": "Talep reddedildi"}
    import avans_service as eski
    eski.avans_reddet(aid, eski.AvansRedModel(neden=(body.neden or "Merkez reddetti")[:200]))
    return {"ok": True, "mesaj": "Talep reddedildi"}
