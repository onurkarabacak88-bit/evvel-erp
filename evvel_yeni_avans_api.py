"""🤝 EVVEL YENİ · AVANS TALEPLERİ (2026-10-17) — tak-çıkar modül (sayfası Personel altında).

Sahip (envanter madde 13): "Avans taleplerini görebileceğim bir mekanizma olmalı." Personel talebi QR personel sayfasından
gönderiyor (eski avans_service → personel_avans 'talep'); onay yalnız eski Cep uygulamasındaydı → Eylül'den bekleyen talepler
kimse görmeden kaldı.
  · Liste: açık talepler (talep · onaylandı-elden teslim bekliyor) + Bekleyen işler'de tek satır (çekirdek kayıt defteri).
  · Onay (havale / elden) ve ret ŞİMDİLİK yalnız eski avans akışıyla (Codex: iki sisteme yazmak çift mahsup + ayrışma üretiyordu).
  · Reddet: eski reddet.
KÖPRÜ (eski sistem kalkınca: talepler doğrudan Evvel Yeni'ye yazılacak — KESIM_LISTESI): personel_avans okuması ve
avans_service.avans_onayla / avans_reddet çağrıları.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db, savepoint
from evvel_yeni_cekirdek import aktor as _aktor, bekleyen_is_kaydet, bugun as _bugun

router = APIRouter(prefix="/api/evvel-yeni/avans", tags=["evvel-yeni-avans"])
log = logging.getLogger(__name__)


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
                            "durum": r["durum"], "yontem": r.get("odeme_yontemi"), "sube": r.get("sube_ad"),
                            "talep": str(r.get("talep_ts") or "")[:16], "onay": str(r.get("onay_ts") or "")[:16],
                            "donem": f"{int(r['donem_yil'])}-{int(r['donem_ay']):02d}" if r.get("donem_yil") else None})
            return out
    except Exception as e:  # noqa: BLE001
        log.warning("avans talepleri okunamadı: %s", str(e)[:150])
        raise HTTPException(503, "Avans talepleri okunamadı — biraz sonra yeniden dene")


def _bekleyen(cur, baglam: dict) -> list:
    """Bekleyen işler: karar bekleyen (durum 'talep') her avans talebi tek satır."""
    return [{"tur": "avans_talep", "genel": True, "id": f"avans:{t['id']}", "tarih": (t["talep"] or _bugun().isoformat())[:10],
             "etiket": "🤝 Avans talebi", "ad": t["ad"], "alt": f"{t['tutar']:,.0f} ₺ — onayla ya da reddet".replace(",", "."),
             "sayfa": "avans_talepleri", "dugme": "Avans talepleri"}
            for t in _acik_talepler(cur) if t["durum"] == "talep"]


bekleyen_is_kaydet("avans_talep", _bekleyen)


@router.get("/talepler")
def talepler():
    with db() as (conn, cur):
        return {"talepler": _acik_talepler(cur), "bugun": _bugun().isoformat()}


class OnayBody(BaseModel):
    yontem: str                    # havale | elden
    cep: Optional[str] = None      # havale: hangi bankadan (Evvel Yeni cebi)
    sube_id: Optional[str] = None  # elden: hangi şubeden verilecek


@router.post("/{aid}/onayla")
def onayla(aid: str, body: OnayBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Codex denetimi (2026-10-17): iki sisteme ayrı ayrı yazmak çift mahsup / ayrışma / yarış üretiyordu → ŞİMDİLİK onay YALNIZ eski
    avans akışıyla (eski Cep ekranının yaptığı birebir): havale = eski kasa + eski maaş mahsubu; elden = şube panelinden teslim
    edilince Kasa köprüsüyle Evvel Yeni dükkân nakdinden düşer. Avansın Evvel Yeni'ye tam taşınması (havalenin EY bankasından
    düşmesi) envanter madde 35'te, 1 Kasım öncesi — KESIM_LISTESI."""
    import avans_service as eski
    with db() as (conn, cur):
        kim = _aktor(cur, x_evvel_oturum)
    if body.yontem not in ("havale", "elden"):
        raise HTTPException(400, "Yöntem: havale ya da elden")
    if body.yontem == "elden" and not body.sube_id:
        raise HTTPException(400, "Elden verilecekse şubeyi seç")
    eski.avans_onayla(aid, eski.AvansOnayModel(yontem=body.yontem, sube_id=body.sube_id if body.yontem == "elden" else None, onaylayan=kim))
    return {"ok": True, "mesaj": "Avans havaleyle ödendi olarak işaretlendi (maaştan düşer)" if body.yontem == "havale"
            else "Avans onaylandı — şube panelinden teslim edilince dükkân kasasından düşer"}


class RedBody(BaseModel):
    neden: Optional[str] = None


@router.post("/{aid}/reddet")
def reddet(aid: str, body: RedBody):
    import avans_service as eski
    eski.avans_reddet(aid, eski.AvansRedModel(neden=(body.neden or "Merkez reddetti")[:200]))
    return {"ok": True, "mesaj": "Talep reddedildi"}
