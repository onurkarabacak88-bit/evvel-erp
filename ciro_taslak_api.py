"""
Merkez ciro taslağı onayı — ödeme onay kuyruğundan ayrı uçlar.
Prefix: /api/ciro-taslak
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit
from sube_panel import _bugun_ciro_var_mi, _ciro_insert_aktif_ve_kasa, _sube_getir

router = APIRouter(prefix="/api/ciro-taslak", tags=["ciro-taslak"])


class CiroTaslakTutarBody(BaseModel):
    nakit: float = 0
    pos: float = 0
    online: float = 0


class CiroTaslakOnayTutarlari(BaseModel):
    """Boş gövde: taslağın mevcut tutarlarıyla onay. Dolu alanlar onay anında düzeltme sayılır."""
    nakit: Optional[float] = None
    pos: Optional[float] = None
    online: Optional[float] = None


class CiroTaslakRedBody(BaseModel):
    neden: str = ""


def _taslak_dict(row: dict) -> dict:
    d = dict(row)
    if d.get("tarih"):
        d["tarih"] = str(d["tarih"])
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    if d.get("onay_zamani"):
        d["onay_zamani"] = str(d["onay_zamani"])
    for k in ("nakit", "pos", "online"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    return d


@router.get("")
def ciro_taslak_liste(durum: str = "bekliyor") -> List[dict]:
    if durum not in ("bekliyor", "onaylandi", "reddedildi", "hepsi"):
        raise HTTPException(400, "durum: bekliyor | onaylandi | reddedildi | hepsi")
    with db() as (conn, cur):
        if durum == "hepsi":
            cur.execute(
                """
                SELECT t.*, s.ad AS sube_adi
                FROM ciro_taslak t
                JOIN subeler s ON s.id = t.sube_id
                ORDER BY t.olusturma DESC
                LIMIT 200
                """
            )
        else:
            cur.execute(
                """
                SELECT t.*, s.ad AS sube_adi
                FROM ciro_taslak t
                JOIN subeler s ON s.id = t.sube_id
                WHERE t.durum = %s
                ORDER BY t.olusturma ASC
                """,
                (durum,),
            )
        rows = cur.fetchall()
    return [_taslak_dict(r) for r in rows]


@router.get("/{taslak_id}")
def ciro_taslak_detay(taslak_id: str):
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT t.*, s.ad AS sube_adi
            FROM ciro_taslak t
            JOIN subeler s ON s.id = t.sube_id
            WHERE t.id = %s
            """,
            (taslak_id,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Taslak bulunamadı")
    return _taslak_dict(dict(row))


@router.patch("/{taslak_id}")
def ciro_taslak_duzenle(taslak_id: str, body: CiroTaslakTutarBody):
    nakit = float(body.nakit or 0)
    pos = float(body.pos or 0)
    online = float(body.online or 0)
    if online > 0.001 and nakit > 0.001 and pos > 0.001 and abs(online - (nakit + pos)) < 0.01:
        raise HTTPException(
            400,
            "Online tutarı nakit+POS toplamına eşit — çift sayım. Online yoksa 0 girin.",
        )
    toplam = nakit + pos + online
    if toplam <= 0:
        raise HTTPException(400, "En az bir tutar girilmeli")
    with db() as (conn, cur):
        cur.execute(
            "SELECT id, durum FROM ciro_taslak WHERE id=%s FOR UPDATE",
            (taslak_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Taslak bulunamadı")
        if r["durum"] != "bekliyor":
            raise HTTPException(400, "Yalnızca bekleyen taslaklar düzenlenebilir")
        cur.execute(
            """
            UPDATE ciro_taslak
            SET nakit=%s, pos=%s, online=%s
            WHERE id=%s AND durum='bekliyor'
            """,
            (body.nakit, body.pos, body.online, taslak_id),
        )
        audit(cur, "ciro_taslak", taslak_id, "MERKEZ_DUZENLE")
    return {"success": True, "id": taslak_id}


@router.post("/{taslak_id}/onayla")
def ciro_taslak_onayla(taslak_id: str, body: CiroTaslakOnayTutarlari = CiroTaslakOnayTutarlari()):
    """Taslağı onayla; isteğe bağlı gövde ile tutarları onay anında güncelleyebilirsiniz."""
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT * FROM ciro_taslak
            WHERE id=%s AND durum='bekliyor'
            FOR UPDATE
            """,
            (taslak_id,),
        )
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "Bekleyen taslak bulunamadı")
        t = dict(t)
        sube_id = t["sube_id"]
        lock_key = f"ciro:{sube_id}:{t.get('tarih')}"
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))
        cur.execute(
            """
            SELECT id
            FROM ciro
            WHERE sube_id=%s AND tarih=%s AND durum='aktif'
            FOR UPDATE
            """,
            (sube_id, t.get("tarih")),
        )
        if cur.fetchone():
            raise HTTPException(
                409,
                "Bu şube için bugün onaylı ciro zaten var — taslak çakışıyor.",
            )

        # Bu ek guard yalnızca taslak BUGÜNE aitse anlamlı (geçmiş-gün/Evo önerisi
        # onaylanırken 'bugün ciro var' diye yanlış bloklamasın — tarihe özel kontrol
        # yukarıda zaten yapıldı).
        from tr_saat import is_gunu_tr as _is_gunu_tr
        if str(t.get("tarih")) == str(_is_gunu_tr()) and _bugun_ciro_var_mi(cur, sube_id):
            raise HTTPException(
                409,
                "Bu şube için bugün onaylı ciro zaten var — taslak çakışıyor.",
            )

        nakit = float(body.nakit) if body.nakit is not None else float(t["nakit"])
        pos = float(body.pos) if body.pos is not None else float(t["pos"])
        online = float(body.online) if body.online is not None else float(t["online"])
        if online > 0.001 and nakit > 0.001 and pos > 0.001 and abs(online - (nakit + pos)) < 0.01:
            raise HTTPException(
                400,
                "Online tutarı nakit+POS toplamına eşit — çift sayım. Online yoksa 0 onaylayın.",
            )
        if nakit + pos + online <= 0:
            raise HTTPException(400, "Onay tutarları geçersiz")

        sube = _sube_getir(cur, sube_id)
        aciklama = (t.get("aciklama") or "").strip() or "Şube paneli taslağı — onay"
        sonuc = _ciro_insert_aktif_ve_kasa(
            cur,
            sube,
            sube_id,
            nakit,
            pos,
            online,
            aciklama,
            audit_etiket="CIRO_TASLAK_ONAY",
            tarih=t.get("tarih"),  # Taslağın gerçek gelir tarihi — bugün değil
        )
        cid = sonuc["id"]

        cur.execute(
            """
            UPDATE ciro_taslak
            SET durum='onaylandi', onay_zamani=NOW(), ciro_id=%s,
                nakit=%s, pos=%s, online=%s
            WHERE id=%s
            """,
            (cid, nakit, pos, online, taslak_id),
        )
        audit(cur, "ciro_taslak", taslak_id, "ONAYLANDI")

        # ── RAPOR CACHE HOOK ── (defensive)
        try:
            from rapor_cache import gunluk_ozet_yenile
            gunluk_ozet_yenile(cur, sube_id, t.get("tarih"), kaynak='event_ciro_onay')
        except Exception:
            pass

    return {
        "success": True,
        "ciro_id": cid,
        "net_tutar": sonuc["net_tutar"],
        "pos_kesinti": sonuc["pos_kesinti"],
        "online_kesinti": sonuc["online_kesinti"],
    }


class GecmisCiroBody(BaseModel):
    sube_ad: str = "tema"        # şube adı parçası (ILIKE)
    tarih: str                   # YYYY-MM-DD (geçmiş gün)
    nakit: float = 0
    pos: float = 0
    online: float = 0
    uygula: bool = False         # False → sadece önizleme


@router.post("/gecmis-gun-gonder")
def gecmis_gun_ciro_gonder(body: GecmisCiroBody):
    """Geçmiş bir gün için (kapanışı yapılmamış) ciroyu kaydeder — mevcut onay
    pipeline'ının çekirdeği (_ciro_insert_aktif_ve_kasa, tarih=geçmiş) ile ciro +
    kasa + günlük özet üretir. İdempotent: o tarihte aktif ciro varsa eklemez.
    uygula=False → önizleme (yazmaz)."""
    sad = f"%{(body.sube_ad or '').strip().lower()}%"
    nakit = float(body.nakit or 0); pos = float(body.pos or 0); online = float(body.online or 0)
    toplam = round(nakit + pos + online, 2)
    if toplam <= 0:
        raise HTTPException(400, "Tutar 0 — nakit/pos girilmeli")
    with db() as (conn, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE LOWER(ad) LIKE %s ORDER BY ad LIMIT 1", (sad,))
        s = cur.fetchone()
        if not s:
            raise HTTPException(404, "Şube bulunamadı")
        sube_id = s["id"]; sube_ad2 = s["ad"]
        # FIX SEC2 (2026-07-06): şube+tarih yarış kilidi — idempotent kontrol ile insert arasında
        # kilit yoktu; eşzamanlı iki istek ikisi de 'yok' görüp aynı güne ÇİFT ciro+kasa yazardı.
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"gecmis-ciro:{sube_id}:{body.tarih}",))
        # İdempotent: o tarihte aktif ciro zaten var mı?
        cur.execute("SELECT id FROM ciro WHERE sube_id=%s AND tarih=%s::date AND durum='aktif' LIMIT 1",
                    (sube_id, body.tarih))
        if cur.fetchone():
            return {"durum": "zaten_var", "sube": sube_ad2, "tarih": body.tarih,
                    "mesaj": f"{sube_ad2} {body.tarih} için zaten aktif ciro var — eklenmedi."}
        if not body.uygula:
            return {"durum": "onizleme", "sube": sube_ad2, "tarih": body.tarih,
                    "nakit": nakit, "pos": pos, "online": online, "toplam": toplam,
                    "mesaj": "ÖNİZLEME — henüz gönderilmedi."}
        sube = _sube_getir(cur, sube_id)
        sonuc = _ciro_insert_aktif_ve_kasa(
            cur, sube, sube_id, nakit, pos, online,
            f"Geçmiş gün ciro (Evo) — {body.tarih}",
            audit_etiket="GECMIS_CIRO_EVO", tarih=body.tarih,
        )
        try:
            from rapor_cache import gunluk_ozet_yenile
            gunluk_ozet_yenile(cur, sube_id, body.tarih, kaynak='gecmis_ciro_evo')
        except Exception:
            pass
    return {"durum": "gonderildi", "sube": sube_ad2, "tarih": body.tarih,
            "nakit": nakit, "pos": pos, "online": online, "toplam": toplam,
            "ciro_id": sonuc.get("id"), "mesaj": "Ciro kaydedildi (ciro + kasa + özet)."}


class EksikGunTaraBody(BaseModel):
    gun_sayisi: int = 10
    uygula: bool = False         # False → sadece tespit/önizleme (yazmaz)


@router.post("/eksik-gun-tara")
def eksik_gun_ciro_tara(body: EksikGunTaraBody):
    """DUYU — EVO-GÜDÜMLÜ gece sweep'i: Evo'da SATIŞ olan ama Evvel'de ciro OLMAYAN
    geçmiş günleri bulur → ONAY BEKLEYEN ciro_taslak ÖNERİSİ üretir (kaynak=Evo).
    Mevcut merkez ciro-taslak onay kuyruğunda görünür, CFO tek tuşla onaylar.

    ÖNEMLİ: açılış kaydı ŞARTI YOK. Açılış da operasyonel bir aksiyon; şube sistemi
    hiç kullanmasa (açılış da girilmese) bile Evo'da satış varsa öneri çıkar — finansal
    gerçek Evo'dur. İLKE (operasyon ≠ finans): KAPANIS event'ine ASLA dokunmaz.
    İdempotent (aktif ciro/bekleyen taslak olan güne yeni öneri yok). Hata-yutar."""
    from tr_saat import is_gunu_tr
    from datetime import timedelta, date as _date
    import uuid as _uuid
    bugun = is_gunu_tr()
    gun_sayisi = max(1, min(int(body.gun_sayisi or 10), 90))
    try:
        from evo_sync import hs_rapor_sube_bazli, _evvel_sube_evo_payload_eslestir
    except Exception as e:
        return {"oneriler": [], "evo_hata": str(e), "mesaj": "Evo modülü yüklenemedi."}
    oneriler = []; evo_hata = None
    with db() as (conn, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE aktif=TRUE")
        subeler = [dict(r) for r in cur.fetchall()]
        for k in range(1, gun_sayisi + 1):
            ts = str(bugun - timedelta(days=k))
            try:
                dd = _date.fromisoformat(ts)
                ev = hs_rapor_sube_bazli(dd, dd)
            except Exception as e:
                evo_hata = str(e); ev = None
            if not ev or not ev.get("subeler"):
                continue
            for s in subeler:
                sid = s["id"]; sad = s["ad"]
                payload = _evvel_sube_evo_payload_eslestir(sad, ev["subeler"])
                if not payload:
                    continue
                nakit = float(payload.get("nakit") or 0); pos = float(payload.get("kart") or 0)
                toplam = round(nakit + pos, 2)
                if toplam <= 0:
                    continue
                # SAHİP KURALI (2026-07-15, hatırlatma: "ciroda HATA olursa YA DA
                # giriş olmazsa denetlesin"): ciro GİRİLMİŞSE Evo ile KIYASLA —
                # fark eşiği aşarsa duyu olayı (öneri-only; aktif ciroya taslak
                # üretilmez — çift kayıt riski; hüküm insanın).
                cur.execute("""SELECT ROUND(SUM(toplam)::numeric,2)::float AS t
                               FROM ciro WHERE sube_id=%s AND tarih=%s::date
                                 AND durum='aktif'""", (sid, ts))
                _cr = dict(cur.fetchone() or {})
                if _cr.get("t") is not None:
                    girilen = float(_cr["t"] or 0)
                    fark = round(girilen - toplam, 2)
                    if abs(fark) > max(50.0, toplam * 0.02):
                        oneriler.append({"sube": sad, "tarih": ts, "durum": "fark",
                                         "girilen": girilen, "evo": toplam, "fark": fark})
                        try:
                            from duyu_omurga import duyu_olay_yaz
                            duyu_olay_yaz(
                                "ciro_guvence", "ciro.evo_fark", f"{sid}_{ts}",
                                entity_scope="sube", entity_id=sad,
                                occurred_at=ts, signal_name="Girilen ciro ≠ Evo satışı",
                                payload={"girilen": girilen, "evo": toplam, "fark": fark})
                        except Exception:  # noqa: BLE001
                            pass
                    continue
                cur.execute("SELECT 1 FROM ciro_taslak WHERE sube_id=%s AND tarih=%s::date AND durum='bekliyor' LIMIT 1", (sid, ts))
                if cur.fetchone():
                    oneriler.append({"sube": sad, "tarih": ts, "nakit": nakit, "pos": pos, "toplam": toplam, "durum": "zaten_oneri_var"})
                    continue
                kayit = {"sube": sad, "tarih": ts, "nakit": nakit, "pos": pos, "toplam": toplam}
                if body.uygula:
                    cur.execute("""
                        INSERT INTO ciro_taslak (id, sube_id, tarih, nakit, pos, online, durum, aciklama, gonderen_ad)
                        VALUES (%s, %s, %s::date, %s, %s, 0, 'bekliyor',
                                '🤖 Evo oto-denetim — kapanışı girilmemiş gün (onay bekliyor)', 'Evo Oto-Denetim')
                        ON CONFLICT DO NOTHING
                    """, (str(_uuid.uuid4()), sid, ts, nakit, pos))
                    kayit["durum"] = "oneri_olusturuldu" if cur.rowcount else "zaten_var"
                else:
                    kayit["durum"] = "onizleme"
                oneriler.append(kayit)
    yeni = [o for o in oneriler if o.get("durum") in ("onizleme", "oneri_olusturuldu")]
    farklar = [o for o in oneriler if o.get("durum") == "fark"]
    return {"oneri_sayisi": len(yeni), "toplam_eslesme": len(oneriler),
            "fark_sayisi": len(farklar), "farklar": farklar,
            "evo_hata": evo_hata, "oneriler": oneriler,
            "mesaj": ("Öneriler onay kuyruğuna düştü." if body.uygula else "ÖNİZLEME — yazılmadı.")}


@router.post("/{taslak_id}/reddet")
def ciro_taslak_reddet(taslak_id: str, body: CiroTaslakRedBody):
    neden = (body.neden or "").strip() or "Reddedildi"
    with db() as (conn, cur):
        cur.execute(
            "SELECT id, durum FROM ciro_taslak WHERE id=%s FOR UPDATE",
            (taslak_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Taslak bulunamadı")
        if r["durum"] != "bekliyor":
            raise HTTPException(400, "Yalnızca bekleyen taslaklar reddedilebilir")
        cur.execute(
            """
            UPDATE ciro_taslak
            SET durum='reddedildi', red_nedeni=%s, onay_zamani=NOW()
            WHERE id=%s
            """,
            (neden, taslak_id),
        )
        audit(cur, "ciro_taslak", taslak_id, "REDDEDILDI")
    return {"success": True, "id": taslak_id}
