"""Ödeme planı — salt okuma uçları (GET).

Mutasyon uçları (POST /ode, /ertele, /kismi-ode, DELETE vb.) main.py içinde kalır;
ortak iş mantığı (odeme_yap vb.) ile sıkı bağlı oldukları için aşamalı taşınır.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from database import db

router = APIRouter(tags=["odeme-plani"])


@router.get("/api/odeme-plani/{oid}/kaynak")
def odeme_plani_kaynak(oid: str):
    """Panel'in vadeli alım kart önerisi için kaynak_tablo ve kaynak_id döner."""
    with db() as (conn, cur):
        cur.execute("SELECT kaynak_tablo, kaynak_id FROM odeme_plani WHERE id=%s", (oid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404)
        return {"kaynak_tablo": row["kaynak_tablo"], "kaynak_id": row["kaynak_id"]}


@router.get("/api/odeme-plani/bugun")
def odeme_plani_bugun():
    """Cep — bugün ödenmesi gereken + gecikmiş (vadesi geçmiş, hâlâ bekleyen) ödemeler.
    TÜM kaynaklar (kredi kartı + sabit gider + borç taksiti + vadeli alım): kartlar LEFT JOIN
    (kart_id NULL olan sabit/borç ödemeleri de gelsin). Sadece durum='bekliyor' —
    onay_bekliyor olanlar Onay kartında, burada değil (çift sayım olmasın)."""
    KAYNAK_AD = {
        "kartlar": "Kredi Kartı", "borc_envanteri": "Borç Taksiti",
        "sabit_giderler": "Sabit Gider", "vadeli_alimlar": "Vadeli Alım",
        "personel": "Personel Ödemesi",
    }
    with db() as (conn, cur):
        cur.execute(
            """SELECT op.id, op.tarih, op.odenecek_tutar, op.asgari_tutar,
                      op.aciklama, op.kaynak_tablo, k.banka, k.kart_adi,
                      (CURRENT_DATE - op.tarih) AS gun_gecikme
               FROM odeme_plani op
               LEFT JOIN kartlar k ON k.id = op.kart_id
               WHERE op.durum = 'bekliyor' AND op.tarih <= CURRENT_DATE
               ORDER BY op.tarih ASC"""
        )
        rows = [dict(r) for r in cur.fetchall()]
    out = []
    for r in rows:
        if r.get("kart_adi"):
            baslik = f"{(r.get('banka') or '').strip()} {r['kart_adi']}".strip()
            tip = "Kredi Kartı"
        else:
            baslik = r.get("aciklama") or KAYNAK_AD.get(r.get("kaynak_tablo") or "", "Ödeme")
            tip = KAYNAK_AD.get(r.get("kaynak_tablo") or "", "Ödeme")
        gun = int(r.get("gun_gecikme") or 0)
        out.append({
            "id": r["id"],
            "baslik": baslik,
            "tip": tip,
            "tutar": float(r["odenecek_tutar"]) if r["odenecek_tutar"] is not None else 0.0,
            "asgari": float(r["asgari_tutar"]) if r.get("asgari_tutar") is not None else None,
            "tarih": str(r["tarih"]),
            "gecikmis": gun > 0,
            "gun_gecikme": gun,
        })
    return out


@router.get("/api/odeme-plani")
def odeme_plani_listele():
    with db() as (conn, cur):
        cur.execute(
            """SELECT op.*, k.banka, k.kart_adi, k.faiz_orani FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.tarih >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY op.tarih ASC"""
        )
        return [dict(r) for r in cur.fetchall()]
