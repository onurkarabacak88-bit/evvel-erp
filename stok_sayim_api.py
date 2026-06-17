"""
Stok Sayım / Kalibrasyon Modülü — İZOLE.

Tasarım (bkz. memory project_stok_sayim_kalibrasyon_backlog + feedback_cozum_felsefesi
"Öneri-Only / Proposed State"):
  - ÇEKİRDEK: mevcut sube_depo_stok güvenilmez ("kâğıt stok"). İlk sayım KALİBRASYON
    (gerçeği KURAR, hakem yok), sonraki KONTROL (DOĞRULAR, sayım↔sistem hakemliği anlamlı).
  - Öneri-Only: sayım = personelin BEYANI (sayim_sonuc, değişmez). Onay = SAHİBİN kararı,
    ayrı bir envanter_duzeltme kaydı yazar; sube_depo_stok ASLA sessiz ezilmez (iz bırakır).
  - İZOLE: kendi tablolarına yazar; kritik tablolardan SADECE sube_depo_stok'u (onaydan
    sonra, iz bırakarak) günceller. Sert FK yok; yumuşak id referansı.
  - Tam kilit + uzaktan-açma valfi: personel sayım bitene kadar kilitli; sahip takılırsa
    uzaktan açar (kilit-ac).

Akış durum makinesi:
  atandi -> basladi -> tamamlandi -> onaylandi -> kapandi
            (sahip) kilit-ac -> iptal  [her aktif durumdan]
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/stok-sayim", tags=["stok-sayim"])

AKTIF_DURUMLAR = ("atandi", "basladi")  # personeli kilitleyen durumlar


def _ensure_tablolar(cur) -> None:
    """Modülün kendi tabloları — lazy ensure (ilk çağrıda). İzole, kritik akışı etkilemez."""
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS stok_sayim_gorev (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            sube_id       TEXT NOT NULL,
            personel_id   TEXT NOT NULL,
            personel_ad   TEXT,
            atayan_ad     TEXT,
            kapsam_tip    TEXT NOT NULL DEFAULT 'tam',     -- 'set' | 'tam'
            mod           TEXT NOT NULL DEFAULT 'kontrol',  -- 'kalibrasyon' | 'kontrol'
            kalemler      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{kalem_kodu, kalem_adi}]
            sayim_sonuc   JSONB,                                -- [{kalem_kodu, sayilan_adet}]
            durum         TEXT NOT NULL DEFAULT 'atandi',
            not_aciklama  TEXT,
            kilit_ac_neden TEXT,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            baslama_ts    TIMESTAMPTZ,
            tamamlama_ts  TIMESTAMPTZ,
            onay_ts       TIMESTAMPTZ
        )
        """
    )
    # İlk rakam girildiği an (freeze başlangıcı) — eski tablolarda eksik olabilir
    cur.execute("ALTER TABLE stok_sayim_gorev ADD COLUMN IF NOT EXISTS ilk_giris_ts TIMESTAMPTZ")
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_ssg_sube_personel ON stok_sayim_gorev (sube_id, personel_id, durum)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_ssg_durum ON stok_sayim_gorev (durum, olusturma DESC)"
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS envanter_duzeltme (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            gorev_id      TEXT,
            sube_id       TEXT NOT NULL,
            kalem_kodu    TEXT NOT NULL,
            kalem_adi     TEXT,
            eski_adet     INT NOT NULL DEFAULT 0,   -- onaydan ÖNCE sistemdeki (kâğıt) adet
            sayilan_adet  INT NOT NULL DEFAULT 0,   -- personelin saydığı
            yeni_adet     INT NOT NULL DEFAULT 0,   -- sahibin kararıyla oluşan gerçek
            delta         INT NOT NULL DEFAULT 0,   -- yeni - eski
            karar         TEXT NOT NULL DEFAULT 'sayim',   -- 'sayim' | 'sistem'
            neden         TEXT NOT NULL DEFAULT 'sayim_duzeltme',  -- 'kalibrasyon' | 'sayim_duzeltme'
            karar_veren_ad TEXT,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_envduz_sube ON envanter_duzeltme (sube_id, kalem_kodu, olusturma DESC)"
    )


def _jliste(v: Any) -> List[Dict[str, Any]]:
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        try:
            x = json.loads(v)
            return x if isinstance(x, list) else []
        except Exception:
            return []
    return []


def _sube_stok_map(cur, sube_id: str) -> Dict[str, Dict[str, Any]]:
    """sube_depo_stok'tan {kalem_kodu: {kalem_adi, mevcut_adet}} — 'sistemde kayıtlı' (kâğıt) stok."""
    cur.execute(
        "SELECT kalem_kodu, kalem_adi, mevcut_adet FROM sube_depo_stok WHERE sube_id=%s",
        (sube_id,),
    )
    out: Dict[str, Dict[str, Any]] = {}
    for r in cur.fetchall() or []:
        d = dict(r)
        out[str(d.get("kalem_kodu"))] = {
            "kalem_adi": d.get("kalem_adi"),
            "mevcut_adet": int(d.get("mevcut_adet") or 0),
        }
    return out


def _katalog_kalemler(cur) -> List[Dict[str, Any]]:
    """Tam ürün kataloğu (siparis_urun, aktif) — 'tam sayım'ın gerçek evreni.
    sube_depo_stok DEĞİL (o seyrek/eksik); kalem_kodu = siparis_urun.id (sevkiyat
    kabulü de bu id ile sube_depo_stok'a yazar → sistem adedi eşleşir)."""
    try:
        cur.execute(
            """
            SELECT u.id::text AS kalem_kodu, u.ad AS kalem_adi,
                   COALESCE(k.ad, '') AS kategori_ad, COALESCE(k.sira, 999) AS kat_sira,
                   COALESCE(u.sira, 999) AS u_sira
            FROM siparis_urun u
            LEFT JOIN siparis_kategori k ON k.id = u.kategori_id
            WHERE u.aktif = TRUE AND COALESCE(k.aktif, TRUE) = TRUE
            ORDER BY kat_sira ASC, k.ad ASC, u_sira ASC, u.ad ASC
            """
        )
        return [
            {"kalem_kodu": str(r["kalem_kodu"]), "kalem_adi": r["kalem_adi"], "kategori_ad": r.get("kategori_ad") or ""}
            for r in (cur.fetchall() or [])
        ]
    except Exception:
        return []


def _sube_hic_sayildi_mi(cur, sube_id: str) -> bool:
    """Bu şubede daha önce ONAYLANMIŞ stok sayımı oldu mu? (mod = kalibrasyon/kontrol kararı)"""
    cur.execute(
        "SELECT 1 FROM stok_sayim_gorev WHERE sube_id=%s AND durum IN ('onaylandi','kapandi') LIMIT 1",
        (sube_id,),
    )
    return cur.fetchone() is not None


# ────────────────────────────── PYDANTIC ──────────────────────────────
class GorevAtaBody(BaseModel):
    sube_id: str
    personel_id: str
    kapsam_tip: str = "tam"                         # 'set' | 'tam'
    kalemler: Optional[List[Dict[str, Any]]] = None  # 'set' için [{kalem_kodu, kalem_adi}]
    atayan_ad: Optional[str] = None
    not_aciklama: Optional[str] = None


class SayimKaydetBody(BaseModel):
    sayim_sonuc: List[Dict[str, Any]]


class TaslakKaydetBody(BaseModel):
    sayim_sonuc: List[Dict[str, Any]]  # kısmi (girilen kalemler) — yenilemede kaybolmasın  # [{kalem_kodu, sayilan_adet}]


class OnayKarar(BaseModel):
    kalem_kodu: str
    karar: str = "sayim"  # 'sayim' | 'sistem'


class GorevOnaylaBody(BaseModel):
    kararlar: Optional[List[OnayKarar]] = None  # kontrol modunda fark satırları; kalibrasyonda yok sayılır
    karar_veren_ad: Optional[str] = None


class KilitAcBody(BaseModel):
    neden: Optional[str] = None


# ────────────────────────────── SAHİP: ŞUBE KALEM LİSTESİ ('set' seçimi için) ──────────────────────────────
@router.get("/sube-kalemler")
def sube_kalemler(sube_id: str):
    """'set' kapsamı seçimi için TÜM ürün kataloğu (siparis_urun) + o şubenin sistem adedi.
    sube_depo_stok seyrek olduğu için katalog evreni kullanılır; sistem adedi şubenin
    deposundan (yoksa 0 — kalibrasyonda zaten kurulur)."""
    sid = (sube_id or "").strip()
    if not sid:
        raise HTTPException(400, "sube_id zorunlu")
    with db() as (_, cur):
        stok_map = _sube_stok_map(cur, sid)
        katalog = _katalog_kalemler(cur)
    kalemler = [
        {
            "kalem_kodu": k["kalem_kodu"], "kalem_adi": k["kalem_adi"],
            "kategori_ad": k.get("kategori_ad") or "",
            "mevcut_adet": int(stok_map.get(k["kalem_kodu"], {}).get("mevcut_adet") or 0),
        }
        for k in katalog
    ]
    return {"toplam": len(kalemler), "kalemler": kalemler}


# ────────────────────────────── 1) SAHİP: ATAMA ──────────────────────────────
@router.post("/gorev-ata")
def gorev_ata(body: GorevAtaBody):
    sube_id = (body.sube_id or "").strip()
    personel_id = (body.personel_id or "").strip()
    if not sube_id or not personel_id:
        raise HTTPException(400, "sube_id ve personel_id zorunlu")
    kapsam = (body.kapsam_tip or "tam").strip().lower()
    if kapsam not in ("set", "tam"):
        raise HTTPException(400, "kapsam_tip: set | tam")

    with db() as (_, cur):
        _ensure_tablolar(cur)
        # Aynı personelde zaten aktif sayım görevi varsa engelle (çift atama)
        cur.execute(
            "SELECT id FROM stok_sayim_gorev WHERE sube_id=%s AND personel_id=%s AND durum IN ('atandi','basladi') LIMIT 1",
            (sube_id, personel_id),
        )
        if cur.fetchone():
            raise HTTPException(409, "Bu personelde zaten aktif bir sayım görevi var")

        # Personel adı
        personel_ad = None
        try:
            cur.execute("SELECT ad_soyad FROM personel WHERE id::text=%s", (personel_id,))
            pr = cur.fetchone()
            if pr:
                personel_ad = str(dict(pr).get("ad_soyad") or "").strip() or None
        except Exception:
            pass

        # Kalemler: 'tam' → TÜM ürün kataloğu (siparis_urun); 'set' → verilen liste.
        # sube_depo_stok seyrek olduğu için 'tam'da onu KULLANMA (Alsancak'ta 3 çıkıyordu).
        # kategori_ad da saklanır → personel ekranında kategori geçiş efekti için.
        stok_map = _sube_stok_map(cur, sube_id)
        katalog = _katalog_kalemler(cur)
        kat_map = {k["kalem_kodu"]: (k.get("kategori_ad") or "") for k in katalog}
        if kapsam == "tam":
            kalemler = [
                {"kalem_kodu": k["kalem_kodu"], "kalem_adi": k["kalem_adi"], "kategori_ad": k.get("kategori_ad") or ""}
                for k in katalog
            ]
        else:
            kalemler = []
            for it in (body.kalemler or []):
                kk = str((it or {}).get("kalem_kodu") or "").strip()
                if not kk:
                    continue
                ad = str((it or {}).get("kalem_adi") or "").strip() or (
                    stok_map.get(kk, {}).get("kalem_adi") or kk
                )
                kalemler.append({"kalem_kodu": kk, "kalem_adi": ad, "kategori_ad": kat_map.get(kk, "")})
        if not kalemler:
            raise HTTPException(
                400,
                "Sayılacak kalem yok. 'tam' için şubede tanımlı stok kalemi olmalı, "
                "'set' için en az bir kalem seçilmeli.",
            )

        # Mod: şube hiç onaylı sayım görmediyse KALİBRASYON, gördüyse KONTROL
        mod = "kontrol" if _sube_hic_sayildi_mi(cur, sube_id) else "kalibrasyon"

        gid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO stok_sayim_gorev
                (id, sube_id, personel_id, personel_ad, atayan_ad, kapsam_tip, mod,
                 kalemler, durum, not_aciklama)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,'atandi',%s)
            """,
            (
                gid, sube_id, personel_id, personel_ad,
                (body.atayan_ad or "").strip() or None, kapsam, mod,
                json.dumps(kalemler, ensure_ascii=False),
                (body.not_aciklama or "").strip() or None,
            ),
        )
    return {"ok": True, "gorev_id": gid, "mod": mod, "kalem_sayisi": len(kalemler), "personel_ad": personel_ad}


# ────────────────────────────── 2-3) PERSONEL: AKTİF GÖREV (KİLİT) ──────────────────────────────
@router.get("/personel-gorev")
def personel_gorev(sube_id: str, personel_id: str):
    """Personelin aktif zorunlu sayım görevi (varsa). QR ekranı bunu çekip ekranı KİLİTLER."""
    sid = (sube_id or "").strip()
    pid = (personel_id or "").strip()
    if not sid or not pid:
        raise HTTPException(400, "sube_id ve personel_id zorunlu")
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT id, mod, kapsam_tip, kalemler, durum, not_aciklama, sayim_sonuc
            FROM stok_sayim_gorev
            WHERE sube_id=%s AND personel_id=%s AND durum IN ('atandi','basladi')
            ORDER BY olusturma DESC LIMIT 1
            """,
            (sid, pid),
        )
        row = cur.fetchone()
        if not row:
            return {"var": False, "gorev": None}
        g = dict(row)
        return {
            "var": True,
            "gorev": {
                "id": g["id"],
                "mod": g["mod"],
                "kapsam_tip": g["kapsam_tip"],
                "durum": g["durum"],
                "not_aciklama": g.get("not_aciklama"),
                "kalemler": _jliste(g.get("kalemler")),
                "sayim_sonuc": _jliste(g.get("sayim_sonuc")),
            },
        }


@router.post("/gorev/{gorev_id}/basla")
def gorev_basla(gorev_id: str):
    gid = (gorev_id or "").strip()
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute("SELECT durum FROM stok_sayim_gorev WHERE id=%s FOR UPDATE", (gid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Görev bulunamadı")
        durum = str(dict(row).get("durum") or "")
        if durum == "atandi":
            cur.execute(
                "UPDATE stok_sayim_gorev SET durum='basladi', baslama_ts=NOW() WHERE id=%s",
                (gid,),
            )
    return {"ok": True}


@router.post("/gorev/{gorev_id}/sayim-aktif")
def gorev_sayim_aktif(gorev_id: str):
    """Personel İLK rakamı girdiği an çağrılır → FREEZE başlar. O andan itibaren
    şubenin 'ürün aç' alanı kilitlenir (sayım sürerken depodan çıkış yasak).
    İdempotent: ilk_giris_ts bir kez yazılır."""
    gid = (gorev_id or "").strip()
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            "UPDATE stok_sayim_gorev SET ilk_giris_ts=NOW() WHERE id=%s AND durum='basladi' AND ilk_giris_ts IS NULL",
            (gid,),
        )
    return {"ok": True}


@router.get("/sube-kilit")
def sube_kilit(sube_id: str):
    """Şubede AKTİF sayım var mı (personel rakam girmeye başladı mı)? Şube paneli
    'ürün aç' alanını buna göre geçici kilitler. Sayım tamamlanınca/iptal olunca açılır."""
    sid = (sube_id or "").strip()
    if not sid:
        raise HTTPException(400, "sube_id zorunlu")
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT id, personel_ad FROM stok_sayim_gorev
            WHERE sube_id=%s AND durum='basladi' AND ilk_giris_ts IS NOT NULL
            ORDER BY ilk_giris_ts DESC LIMIT 1
            """,
            (sid,),
        )
        row = cur.fetchone()
    if not row:
        return {"kilitli": False, "personel_ad": None, "gorev_id": None}
    g = dict(row)
    return {"kilitli": True, "personel_ad": g.get("personel_ad"), "gorev_id": g.get("id")}


@router.post("/gorev/{gorev_id}/taslak-kaydet")
def gorev_taslak_kaydet(gorev_id: str, body: TaslakKaydetBody):
    """Kısmi sayım taslağı — her giriş sonrası kaydedilir ki sayfa yenilenince
    personelin yazdıkları KAYBOLMASIN. durum'u DEĞİŞTİRMEZ (sadece basladi iken)."""
    gid = (gorev_id or "").strip()
    temiz = []
    for it in (body.sayim_sonuc or []):
        kk = str((it or {}).get("kalem_kodu") or "").strip()
        if not kk:
            continue
        try:
            ad = max(0, int((it or {}).get("sayilan_adet")))
        except Exception:
            continue
        temiz.append({"kalem_kodu": kk, "sayilan_adet": ad})
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            "UPDATE stok_sayim_gorev SET sayim_sonuc=%s::jsonb WHERE id=%s AND durum='basladi'",
            (json.dumps(temiz, ensure_ascii=False), gid),
        )
    return {"ok": True, "kayitli": len(temiz)}


# ────────────────────────────── 4) PERSONEL: SAYIMI KAYDET ──────────────────────────────
@router.post("/gorev/{gorev_id}/kaydet")
def gorev_kaydet(gorev_id: str, body: SayimKaydetBody):
    gid = (gorev_id or "").strip()
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            "SELECT kalemler, durum FROM stok_sayim_gorev WHERE id=%s FOR UPDATE", (gid,)
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Görev bulunamadı")
        g = dict(row)
        if str(g.get("durum")) not in ("atandi", "basladi"):
            raise HTTPException(409, "Bu görev sayıma uygun durumda değil (zaten tamamlanmış olabilir)")
        kalemler = _jliste(g.get("kalemler"))
        gereken = {str(k.get("kalem_kodu")) for k in kalemler}

        # Gelen sayım → map. TÜM kalemler sayılmalı (zorunlu, eksik geçilemez).
        sayim_map: Dict[str, int] = {}
        for it in (body.sayim_sonuc or []):
            kk = str((it or {}).get("kalem_kodu") or "").strip()
            if not kk:
                continue
            try:
                ad = int((it or {}).get("sayilan_adet"))
            except Exception:
                raise HTTPException(400, f"Geçersiz adet: {kk}")
            if ad < 0:
                raise HTTPException(400, f"Adet negatif olamaz: {kk}")
            sayim_map[kk] = ad
        eksik = gereken - set(sayim_map.keys())
        if eksik:
            raise HTTPException(400, f"Tüm kalemler sayılmalı — eksik {len(eksik)} kalem var")

        sayim_sonuc = [{"kalem_kodu": k.get("kalem_kodu"), "sayilan_adet": sayim_map[str(k.get("kalem_kodu"))]} for k in kalemler]
        cur.execute(
            "UPDATE stok_sayim_gorev SET sayim_sonuc=%s::jsonb, durum='tamamlandi', tamamlama_ts=NOW() WHERE id=%s",
            (json.dumps(sayim_sonuc, ensure_ascii=False), gid),
        )
    return {"ok": True, "durum": "tamamlandi"}


# ────────────────────────────── 6) SAHİP: BEKLEYEN ONAY + DETAY ──────────────────────────────
@router.get("/bekleyen-onay")
def bekleyen_onay():
    """Sayımı biten, sahibin onayını bekleyen görevler (özet + fark sayısı)."""
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT g.id, g.sube_id, g.personel_ad, g.mod, g.kapsam_tip,
                   g.kalemler, g.sayim_sonuc, g.tamamlama_ts, s.ad AS sube_adi
            FROM stok_sayim_gorev g
            LEFT JOIN subeler s ON s.id = g.sube_id
            WHERE g.durum='tamamlandi'
            ORDER BY g.tamamlama_ts DESC NULLS LAST
            """
        )
        out = []
        for r in cur.fetchall() or []:
            g = dict(r)
            stok_map = _sube_stok_map(cur, str(g.get("sube_id")))
            sayim = {str(x.get("kalem_kodu")): int(x.get("sayilan_adet") or 0) for x in _jliste(g.get("sayim_sonuc"))}
            fark = 0
            for k in _jliste(g.get("kalemler")):
                kk = str(k.get("kalem_kodu"))
                sis = int(stok_map.get(kk, {}).get("mevcut_adet") or 0)
                if sayim.get(kk, 0) != sis:
                    fark += 1
            out.append({
                "id": g["id"], "sube_id": g["sube_id"], "sube_adi": g.get("sube_adi"),
                "personel_ad": g.get("personel_ad"), "mod": g.get("mod"),
                "kapsam_tip": g.get("kapsam_tip"),
                "kalem_sayisi": len(_jliste(g.get("kalemler"))),
                "fark_sayisi": fark,
                "tamamlama_ts": str(g.get("tamamlama_ts") or ""),
            })
    return {"toplam": len(out), "gorevler": out}


@router.get("/gorev/{gorev_id}")
def gorev_detay(gorev_id: str):
    """Sahip inceleme: her kalem için sayılan vs sistem (kâğıt) + fark + mod."""
    gid = (gorev_id or "").strip()
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT g.*, s.ad AS sube_adi
            FROM stok_sayim_gorev g LEFT JOIN subeler s ON s.id=g.sube_id
            WHERE g.id=%s
            """,
            (gid,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Görev bulunamadı")
        g = dict(row)
        stok_map = _sube_stok_map(cur, str(g.get("sube_id")))
        sayim = {str(x.get("kalem_kodu")): int(x.get("sayilan_adet") or 0) for x in _jliste(g.get("sayim_sonuc"))}
        satirlar = []
        for k in _jliste(g.get("kalemler")):
            kk = str(k.get("kalem_kodu"))
            sis = int(stok_map.get(kk, {}).get("mevcut_adet") or 0)
            say = sayim.get(kk, 0)
            satirlar.append({
                "kalem_kodu": kk,
                "kalem_adi": k.get("kalem_adi") or stok_map.get(kk, {}).get("kalem_adi") or kk,
                "sayilan_adet": say,
                "sistem_adet": sis,
                "fark": say - sis,
            })
    return {
        "id": g["id"], "sube_id": g["sube_id"], "sube_adi": g.get("sube_adi"),
        "personel_ad": g.get("personel_ad"), "mod": g.get("mod"),
        "kapsam_tip": g.get("kapsam_tip"), "durum": g.get("durum"),
        "not_aciklama": g.get("not_aciklama"),
        "tamamlama_ts": str(g.get("tamamlama_ts") or ""),
        "satirlar": satirlar,
    }


# ────────────────────────────── 7-8) SAHİP: ONAY + ENVANTER DÜZELTME ──────────────────────────────
@router.post("/gorev/{gorev_id}/onayla")
def gorev_onayla(gorev_id: str, body: GorevOnaylaBody):
    """Sahip onayı. Öneri-Only: sube_depo_stok'u SESSİZ EZMEZ; her değişiklik için
    envanter_duzeltme kaydı yazar, sonra stoğu o karara göre günceller (iz bırakarak).

    - KALİBRASYON modu: hakem yok, sayılan değer gerçeği kurar (karar='sayim').
    - KONTROL modu: fark satırlarında karar 'sayim' (personel) veya 'sistem' (defter).
      Karar gelmeyen fark satırları varsayılan 'sayim' alır (sayım hakikat sayılır).
    """
    gid = (gorev_id or "").strip()
    karar_map = {str(k.kalem_kodu): (k.karar or "sayim").strip().lower() for k in (body.kararlar or [])}
    karar_veren = (body.karar_veren_ad or "").strip() or None

    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute("SELECT * FROM stok_sayim_gorev WHERE id=%s FOR UPDATE", (gid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Görev bulunamadı")
        g = dict(row)
        if str(g.get("durum")) != "tamamlandi":
            raise HTTPException(409, f"Görev onaya uygun değil (durum: {g.get('durum')})")
        sube_id = str(g.get("sube_id"))
        mod = str(g.get("mod") or "kontrol")
        stok_map = _sube_stok_map(cur, sube_id)
        sayim = {str(x.get("kalem_kodu")): int(x.get("sayilan_adet") or 0) for x in _jliste(g.get("sayim_sonuc"))}

        duzeltme_sayisi = 0
        for k in _jliste(g.get("kalemler")):
            kk = str(k.get("kalem_kodu"))
            kad = k.get("kalem_adi") or stok_map.get(kk, {}).get("kalem_adi") or kk
            eski = int(stok_map.get(kk, {}).get("mevcut_adet") or 0)
            say = int(sayim.get(kk, 0))

            if mod == "kalibrasyon":
                karar = "sayim"
                neden = "kalibrasyon"
            else:
                karar = karar_map.get(kk, "sayim")
                if karar not in ("sayim", "sistem"):
                    karar = "sayim"
                neden = "sayim_duzeltme"

            yeni = say if karar == "sayim" else eski
            delta = yeni - eski
            # 'sistem' kararı + fark yok → stok değişmez, kayıt da gereksiz (gürültü olmasın).
            if karar == "sistem" and delta == 0:
                continue

            # 1) İZ DEFTERİ: envanter_duzeltme (asla sessiz ezme yok — önce iz)
            cur.execute(
                """
                INSERT INTO envanter_duzeltme
                    (gorev_id, sube_id, kalem_kodu, kalem_adi, eski_adet, sayilan_adet,
                     yeni_adet, delta, karar, neden, karar_veren_ad)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (gid, sube_id, kk, kad, eski, say, yeni, delta, karar, neden, karar_veren),
            )
            duzeltme_sayisi += 1

            # 2) GERÇEĞİ KUR: sube_depo_stok upsert (yoksa ekle, varsa yeni değere set)
            if delta != 0 or karar == "sayim":
                cur.execute(
                    """
                    INSERT INTO sube_depo_stok (id, sube_id, kalem_kodu, kalem_adi, mevcut_adet, guncelleme)
                    VALUES (%s,%s,%s,%s,%s,NOW())
                    ON CONFLICT (sube_id, kalem_kodu)
                    DO UPDATE SET mevcut_adet=EXCLUDED.mevcut_adet, kalem_adi=EXCLUDED.kalem_adi, guncelleme=NOW()
                    """,
                    (str(uuid.uuid4()), sube_id, kk, kad, max(0, yeni)),
                )

        cur.execute(
            "UPDATE stok_sayim_gorev SET durum='onaylandi', onay_ts=NOW() WHERE id=%s",
            (gid,),
        )
    return {"ok": True, "durum": "onaylandi", "duzeltme_sayisi": duzeltme_sayisi, "mod": mod}


# ────────────────────────────── 9) SAHİP: UZAKTAN KİLİT AÇMA (GÜVENLİK VALFİ) ──────────────────────────────
@router.post("/gorev/{gorev_id}/kilit-ac")
def gorev_kilit_ac(gorev_id: str, body: KilitAcBody):
    """Sahip, takılan/yanlış atanan bir sayım görevini uzaktan iptal eder → personel kilidi açılır.
    Tam kilit ilkesini bozmaz; bu sahibin acil-durum anahtarı (telefon öldü/yanlış kişi vb.)."""
    gid = (gorev_id or "").strip()
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute("SELECT durum FROM stok_sayim_gorev WHERE id=%s FOR UPDATE", (gid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Görev bulunamadı")
        durum = str(dict(row).get("durum") or "")
        if durum not in ("atandi", "basladi", "tamamlandi"):
            raise HTTPException(409, f"Bu görev iptal edilemez (durum: {durum})")
        cur.execute(
            "UPDATE stok_sayim_gorev SET durum='iptal', kilit_ac_neden=%s WHERE id=%s",
            ((body.neden or "").strip() or "sahip uzaktan açtı", gid),
        )
    return {"ok": True, "durum": "iptal"}


# ────────────────────────────── SAHİP: GEÇMİŞ LİSTE ──────────────────────────────
@router.get("/gorevler")
def gorevler(limit: int = 50):
    lim = max(1, min(200, int(limit or 50)))
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT g.id, g.sube_id, s.ad AS sube_adi, g.personel_ad, g.mod, g.kapsam_tip,
                   g.durum, g.olusturma, g.onay_ts,
                   jsonb_array_length(COALESCE(g.kalemler,'[]'::jsonb)) AS kalem_sayisi
            FROM stok_sayim_gorev g LEFT JOIN subeler s ON s.id=g.sube_id
            ORDER BY g.olusturma DESC LIMIT %s
            """,
            (lim,),
        )
        out = [dict(r) for r in (cur.fetchall() or [])]
        for d in out:
            d["olusturma"] = str(d.get("olusturma") or "")
            d["onay_ts"] = str(d.get("onay_ts") or "")
    return {"toplam": len(out), "gorevler": out}
