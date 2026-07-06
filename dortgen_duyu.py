"""
TÜKETİM MUHASEBESİ DÖRTGENİ — FAZ 1a (2026-07-06, Duyu Ağı Master Planı)

Kural #12: en güçlü sinyal tek bir duyu değil, DÖRT serinin birlikte okunması:
    GİREN (kabul edilen sevkiyat) ↔ SATIŞ (Evo) ↔ KULLANIM (ürün-aç) ↔ SAYIM FARKI
"Sipariş artıyor + satış artmıyor + açılan artıyor + sayım farkı aynı yönde" = değerli
kombinasyon; her seri tek başına ZAYIF. Bu modül dört köşeyi ŞUBE bazında YAN YANA koyar.

SINIR (consistency engine): uyumsuzluk HESAPLAMAZ, skor ÜRETMEZ, yorum YAPMAZ —
dört sayıyı kalem dilinde yan yana gösterir; değerlendirme İNSANIN (üç-evren kuralı).
Kimlik yok (şube seviyesi — kural #15).

KESİT ROZETİ (Codex vuruşu #2): dört köşe FARKLI anların fotoğrafı olabilir — her köşe
kendi kesit/tazelik rozetini taşır (kaynak, kapsam notu, veri aralığı, canlı/cache).
Kesitler uyumsuzsa ekran bunu SAKLAMAZ, rozetle gösterir — sahte uyumsuzluk basılmaz.

Kapsam dürüstlüğü: SATIŞ köşesi yalnız bar-anahtarlı kalemleri (bardak/su/süt/redbull...)
kapsar — Evo grup dili budur. Diğer kalemlerde satış kolonu '—' (veri yok ≠ sıfır satış).

Salt-okur, izole, hata-yutar köşeler (bir köşe çökerse diğer üçü yaşar).
Kaldırmak: main.py'den router'ı çıkar. Hiçbir tabloya yazmaz.
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu", tags=["duyu-dortgen"])

_JSON_DEC = json.JSONDecoder()


def _payload_cek(aciklama: str) -> Optional[dict]:
    """'URUN_AC_JSON:{...} | not' açıklamasından JSON gövdesini güvenle ayıkla."""
    try:
        i = aciklama.index("URUN_AC_JSON:") + len("URUN_AC_JSON:")
        obj, _ = _JSON_DEC.raw_decode(aciklama[i:])
        return obj if isinstance(obj, dict) else None
    except Exception:  # noqa: BLE001
        return None


@router.get("/dortgen")
def tuketim_dortgeni(
    sube_id: str = Query(..., description="Şube id (dörtgen şube seviyesi çalışır)"),
    gun: int = Query(7, ge=1, le=14, description="Geriye dönük gün penceresi"),
):
    bit = date.today()
    bas = bit - timedelta(days=gun - 1)
    rozetler: Dict[str, dict] = {}
    satirlar: Dict[str, dict] = {}  # kalem_kodu → {kalem_adi, giren, kullanim, satis, sayim}

    def _satir(kod: str, ad: str = "") -> dict:
        s = satirlar.get(kod)
        if s is None:
            s = {"kalem_kodu": kod, "kalem_adi": ad or kod,
                 "giren": None, "kullanim": None, "satis": None, "sayim_delta": None}
            satirlar[kod] = s
        elif ad and (not s["kalem_adi"] or s["kalem_adi"] == kod):
            s["kalem_adi"] = ad
        return s

    with db() as (_, cur):
        cur.execute("SELECT ad FROM subeler WHERE id=%s", (sube_id,))
        _s = cur.fetchone()
        if not _s:
            raise HTTPException(404, "Şube bulunamadı")
        sube_ad = dict(_s).get("ad") or sube_id

        # ── KÖŞE 1: GİREN — kabul edilen sevkiyat (stok_yolda, kabul anı kesiti) ──
        try:
            cur.execute(
                """
                SELECT kalem_kodu, MAX(kalem_adi) AS kalem_adi,
                       SUM(COALESCE(kabul_adet, sevk_adet, 0))::int AS adet
                FROM stok_yolda
                WHERE sube_id=%s AND kabul_ts IS NOT NULL
                  AND kabul_ts >= %s::date AND kabul_ts < %s::date + INTERVAL '1 day'
                GROUP BY kalem_kodu
                """,
                (sube_id, str(bas), str(bit)),
            )
            for r in (cur.fetchall() or []):
                d = dict(r)
                _satir(str(d["kalem_kodu"]), d.get("kalem_adi") or "")["giren"] = int(d["adet"] or 0)
            rozetler["giren"] = {"kaynak": "stok_yolda (kabul anı)", "kesit": f"{bas}→{bit}",
                                 "kapsam": "merkez→şube kabul edilen sevkiyat; toptancı direkt teslimat HARİÇ"}
        except Exception as e:  # noqa: BLE001
            logger.warning("dortgen giren kosesi atlandi: %s", str(e)[:120])
            rozetler["giren"] = {"kaynak": "stok_yolda", "hata": "veri alınamadı"}

        # ── KÖŞE 2: KULLANIM — ürün-aç defteri (iş günü kesiti; [BİTTİ] çift-sayım dışlanır) ──
        try:
            cur.execute(
                """
                SELECT REPLACE(aciklama, 'URUN_KULLANIMA_AL_JSON:', 'URUN_AC_JSON:') AS aciklama
                FROM operasyon_defter
                WHERE sube_id=%s AND etiket IN ('URUN_AC','URUN_KULLANIMA_AL')
                  AND NOT (etiket='URUN_AC' AND aciklama LIKE %s)
                  AND tarih BETWEEN %s::date AND %s::date
                """,
                (sube_id, "%[BİTTİ]%", str(bas), str(bit)),
            )
            _rows = [str(dict(r)["aciklama"] or "") for r in (cur.fetchall() or [])]
            try:
                from operasyon_stok_motor import depo_kalem_kodu_resolve as _resolve
            except Exception:  # noqa: BLE001
                _resolve = None
            for a in _rows:
                p = _payload_cek(a)
                if not p:
                    continue
                for k, v in (p.get("delta") or {}).items():  # havuz kodları = doğrudan kalem_kodu
                    try:
                        adet = int(v or 0)
                    except (TypeError, ValueError):
                        continue
                    if adet <= 0:
                        continue
                    s = _satir(str(k))
                    s["kullanim"] = (s["kullanim"] or 0) + adet
                for kal in (p.get("kalemler") or []):
                    try:
                        adet = int(kal.get("adet") or 0)
                    except (TypeError, ValueError):
                        continue
                    if adet <= 0:
                        continue
                    uid = str(kal.get("urun_id") or "").strip()
                    uad = str(kal.get("urun_ad") or "").strip()
                    kod = ""
                    if _resolve and uid:
                        try:
                            kod = _resolve(cur, uid, uad) or ""
                        except Exception:  # noqa: BLE001
                            kod = ""
                    kod = kod or (f"ad:{uad}" if uad else "")
                    if not kod:
                        continue
                    s = _satir(kod, uad)
                    s["kullanim"] = (s["kullanim"] or 0) + adet
            rozetler["kullanim"] = {"kaynak": "operasyon_defter ürün-aç", "kesit": f"{bas}→{bit}",
                                    "kapsam": "açılışta sayım ([BİTTİ] kayıtları çift-sayım koruması gereği hariç)"}
        except Exception as e:  # noqa: BLE001
            logger.warning("dortgen kullanim kosesi atlandi: %s", str(e)[:120])
            rozetler["kullanim"] = {"kaynak": "operasyon_defter", "hata": "veri alınamadı"}

        # ── KÖŞE 3: SATIŞ — Evo bar adetleri (cache kesiti; KISMİ kapsam — dürüst rozet) ──
        try:
            from evo_sync import evo_bar_adet_by_sube_id
            _canli, _son_ts = None, None
            g = bas
            while g <= bit:
                try:
                    ev = evo_bar_adet_by_sube_id(cur, g)
                except Exception:  # noqa: BLE001
                    ev = None
                if ev:
                    if _canli is None:
                        _canli = bool(ev.get("canli"))
                        _son_ts = ev.get("son_cekim_ts")
                    for bk, vd in ((ev.get("by_sube") or {}).get(str(sube_id)) or {}).items():
                        try:
                            adet = int((vd or {}).get("adet") or 0)
                        except (TypeError, ValueError):
                            continue
                        if adet <= 0:
                            continue
                        s = _satir(str(bk), str((vd or {}).get("etiket") or ""))
                        s["satis"] = (s["satis"] or 0) + adet
                g += timedelta(days=1)
            rozetler["satis"] = {"kaynak": "Evo hs_rapor (bar anahtarları)", "kesit": f"{bas}→{bit}",
                                 "canli": _canli, "son_cekim_ts": _son_ts,
                                 "kapsam": "YALNIZ bar-anahtarlı kalemler (bardak/su/süt/redbull…) — "
                                           "diğer kalemlerde '—' = veri yok, sıfır satış DEĞİL"}
        except Exception as e:  # noqa: BLE001
            logger.warning("dortgen satis kosesi atlandi: %s", str(e)[:120])
            rozetler["satis"] = {"kaynak": "Evo", "hata": "veri alınamadı"}

        # ── KÖŞE 4: SAYIM FARKI — envanter_duzeltme (onay anı kesiti; kalibrasyon ayrı) ──
        try:
            cur.execute(
                """
                SELECT kalem_kodu, MAX(kalem_adi) AS kalem_adi,
                       SUM(delta) FILTER (WHERE neden='sayim_duzeltme')::int AS sayim_delta,
                       SUM(delta) FILTER (WHERE neden='kalibrasyon')::int AS kalibrasyon_delta
                FROM envanter_duzeltme
                WHERE sube_id=%s
                  AND olusturma >= %s::date AND olusturma < %s::date + INTERVAL '1 day'
                GROUP BY kalem_kodu
                """,
                (sube_id, str(bas), str(bit)),
            )
            for r in (cur.fetchall() or []):
                d = dict(r)
                s = _satir(str(d["kalem_kodu"]), d.get("kalem_adi") or "")
                if d.get("sayim_delta") is not None:
                    s["sayim_delta"] = int(d["sayim_delta"])
                if d.get("kalibrasyon_delta"):
                    s["kalibrasyon_delta"] = int(d["kalibrasyon_delta"])
            rozetler["sayim"] = {"kaynak": "envanter_duzeltme (onaylı sayım)", "kesit": f"{bas}→{bit}",
                                 "kapsam": "yalnız neden='sayim_duzeltme' sayım farkıdır; "
                                           "kalibrasyon (ilk kurulum ayarı) ayrı alanda gösterilir"}
        except Exception as e:  # noqa: BLE001
            logger.warning("dortgen sayim kosesi atlandi: %s", str(e)[:120])
            rozetler["sayim"] = {"kaynak": "envanter_duzeltme", "hata": "veri alınamadı"}

    # Sıralama: en çok köşesi dolu olan (karşılaştırılabilir) kalemler üste
    def _dolu(s: dict) -> int:
        return sum(1 for k in ("giren", "kullanim", "satis", "sayim_delta") if s.get(k) is not None)

    liste = sorted(satirlar.values(), key=lambda s: (-_dolu(s), -(s.get("kullanim") or 0)))
    return {
        "sube_id": sube_id, "sube_ad": sube_ad,
        "kesit": {"bas": str(bas), "bit": str(bit), "gun": gun},
        "rozetler": rozetler,
        "kalem_sayisi": len(liste),
        "kalemler": liste[:200],
        "not": "DÖRT KÖŞE YAN YANA — uyumsuzluk skoru/yorum YOK (consistency engine). "
               "None/'—' = o köşede VERİ YOK (sıfır değil). Her köşenin kesit rozetine bak: "
               "farklı anların fotoğrafları yan yana olabilir. Değerlendirme insanındır.",
    }
