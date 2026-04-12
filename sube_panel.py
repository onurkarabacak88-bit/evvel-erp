"""
Şube personel paneli — CFO verisi yok.
Prefix: /api/sube-panel
Statik arayüz: GET /sube-panel veya /sube-panel/{sube_id}

X rapor OCR: OPENAI_API_KEY, isteğe OPENAI_X_RAPOR_MODEL (varsayılan gpt-4o-mini).
"""
import base64
import json
import os
import pathlib
import re
import uuid
from datetime import date, datetime
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import db
from finans_core import kasa_bakiyesi
from kasa_service import insert_kasa_hareketi, audit
from sube_kapanis_dual import _dogrula_pin, _list_panel_kullanici, _pin_hash

router = APIRouter(prefix="/api/sube-panel", tags=["sube-panel"])

_X_RAPOR_MAX_BYTES = 8 * 1024 * 1024
_X_UPLOAD_ROOT = pathlib.Path("data/x_rapor_uploads")


def _x_parse_model_json(raw: str) -> dict:
    """Model çıktısından JSON nesnesi çıkar (markdown code fence toleransı)."""
    t = (raw or "").strip()
    if "```" in t:
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", t, re.IGNORECASE)
        if m:
            t = m.group(1).strip()
    return json.loads(t)


def _x_to_float(v: Any, default: float = 0.0) -> float:
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "").replace("₺", "").replace("TL", "")
    if not s:
        return default
    # TR: 12.345,67 → 12345.67
    if "," in s:
        a, b = s.rsplit(",", 1)
        a = a.replace(".", "")
        try:
            return float(f"{a}.{b}")
        except ValueError:
            return default
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return default


def _x_extract_amounts(obj: dict) -> dict:
    low = {str(k).lower().strip(): v for k, v in obj.items()}
    nakit = _x_to_float(low.get("nakit"), 0)
    pos = _x_to_float(low.get("pos"), 0)
    online = _x_to_float(low.get("online"), 0)
    toplam = _x_to_float(low.get("toplam"), 0)
    if toplam <= 0 and (nakit + pos + online) > 0:
        toplam = nakit + pos + online
    return {"nakit": nakit, "pos": pos, "online": online, "toplam": toplam}


def _sube_getir(cur, sube_id: str) -> dict:
    cur.execute("SELECT * FROM subeler WHERE id=%s AND aktif=TRUE", (sube_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Şube bulunamadı")
    return dict(row)


def _bugun_ciro_var_mi(cur, sube_id: str) -> bool:
    cur.execute("""
        SELECT 1 FROM ciro
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='aktif'
        LIMIT 1
    """, (sube_id,))
    return cur.fetchone() is not None


def _bugun_ciro_taslak_bekliyor(cur, sube_id: str) -> Optional[dict]:
    cur.execute("""
        SELECT id, nakit, pos, online, olusturma, aciklama, personel_id,
               gonderen_ad, bildirim_saati, panel_kullanici_id
        FROM ciro_taslak
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='bekliyor'
        ORDER BY olusturma DESC
        LIMIT 1
    """, (sube_id,))
    r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    for k in ("nakit", "pos", "online"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    return d


def _ciro_insert_aktif_ve_kasa(
    cur,
    sube: dict,
    sube_id: str,
    nakit: float,
    pos: float,
    online: float,
    aciklama: Optional[str],
    audit_etiket: str = "INSERT_PANEL",
) -> dict:
    """Onaylı ciro satırı + kasa hareketi (şube kesintileri dahil)."""
    pos_oran = float(sube.get("pos_oran") or 0)
    online_oran = float(sube.get("online_oran") or 0)
    pos_kesinti = pos * pos_oran / 100.0
    online_kesinti = online * online_oran / 100.0
    net_tutar = nakit + (pos - pos_kesinti) + (online - online_kesinti)

    cid = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO ciro (id, tarih, sube_id, nakit, pos, online, aciklama)
        VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s)
        """,
        (cid, sube_id, nakit, pos, online, aciklama or "Onaylı ciro"),
    )
    insert_kasa_hareketi(
        cur,
        date.today(),
        "CIRO",
        net_tutar,
        f"Ciro — {sube['ad']} ({audit_etiket})",
        "ciro",
        cid,
        ref_id=cid,
        ref_type="CIRO",
    )
    audit(cur, "ciro", cid, audit_etiket)
    return {
        "id": cid,
        "net_tutar": round(net_tutar, 2),
        "pos_kesinti": round(pos_kesinti, 2),
        "online_kesinti": round(online_kesinti, 2),
    }


def _bugun_anlik_gider_sayisi(cur, sube_id: str) -> int:
    cur.execute("""
        SELECT COUNT(*) as adet FROM anlik_giderler
        WHERE sube=%s AND tarih=CURRENT_DATE AND durum='aktif'
    """, (sube_id,))
    return int(cur.fetchone()['adet'])


def _bugun_sube_acildi_mi(cur, sube_id: str) -> bool:
    cur.execute("""
        SELECT 1 FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        LIMIT 1
    """, (sube_id,))
    return cur.fetchone() is not None


def _bugun_kasa_acildi_mi(cur, sube_id: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM sube_kasa_gun_acma
        WHERE sube_id=%s AND tarih=CURRENT_DATE
        LIMIT 1
        """,
        (sube_id,),
    )
    return cur.fetchone() is not None


def _bugun_kasa_acma_kaydi(cur, sube_id: str) -> Optional[dict]:
    cur.execute(
        """
        SELECT k.panel_kullanici_id, k.olusturma, u.ad AS panel_kullanici_ad
        FROM sube_kasa_gun_acma k
        JOIN sube_panel_kullanici u ON u.id = k.panel_kullanici_id
        WHERE k.sube_id=%s AND k.tarih=CURRENT_DATE
        LIMIT 1
        """,
        (sube_id,),
    )
    r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    return d


def _bugun_acilis_kaydi(cur, sube_id: str) -> Optional[dict]:
    cur.execute("""
        SELECT id, sube_id, tarih, acilis_saati, olusturma, personel_id, durum
        FROM sube_acilis
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        LIMIT 1
    """, (sube_id,))
    r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    if d.get("tarih"):
        d["tarih"] = str(d["tarih"])
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    return d


def _gorev_listesi_uret(
    sube: dict,
    ciro_girildi: bool,
    anlik_adet: int,
    sube_acildi_mi: bool,
    ciro_taslak_bekliyor: bool = False,
    kasa_acildi_mi: bool = True,
) -> list:
    """Günlük görev listesi. Önce kasa PIN, sonra şube açılış (sube_acilis)."""
    _ = anlik_adet
    simdi = datetime.now().strftime("%H:%M")
    gorevler = []

    acilis = sube.get("acilis_saati") or "09:00"
    kapanis = sube.get("kapanis_saati") or "22:00"

    gorevler.append({
        "id":       "kasa_kilit",
        "baslik":   "Kasa kilidi",
        "aciklama": "Günlük kasa kilitlidir. Sabah personel, kayıtlı PIN ile kilidi açmalıdır.",
        "saat":     acilis,
        "tur":      "kasa_kilit",
        "tamamlandi": kasa_acildi_mi,
        "aksiyon":  "kasa_ac" if not kasa_acildi_mi else None,
    })

    gorevler.append({
        "id":       "acilis",
        "baslik":   "Şube Açılışı",
        "aciklama": f"Planlanan açılış {acilis}. Kasa ve ekipman kontrolü — \"Şubeyi Aç\" ile kayıt oluşturun.",
        "saat":     acilis,
        "tur":      "acilis",
        "tamamlandi": sube_acildi_mi,
        "aksiyon":  "sube_ac" if (kasa_acildi_mi and not sube_acildi_mi) else None,
    })

    if ciro_taslak_bekliyor and not ciro_girildi:
        ciro_baslik = "Günlük Ciro (merkez onayında)"
        ciro_aciklama = (
            "Ciro taslağınız gönderildi; merkez onayından sonra sisteme işlenir. "
            "X raporu fotoğrafını WhatsApp ile yöneticiye iletin."
        )
        ciro_tamam = True
        ciro_aksiyon = None
    else:
        ciro_baslik = "Günlük Ciro Girişi"
        ciro_aciklama = "Bugünkü nakit, POS ve online satışlarını girin — merkez onayından sonra ciroya işlenir."
        ciro_tamam = ciro_girildi
        ciro_aksiyon = "ciro_gir" if (kasa_acildi_mi and sube_acildi_mi and not ciro_girildi) else None

    gorevler.append({
        "id":           "ciro",
        "baslik":       ciro_baslik,
        "aciklama":     ciro_aciklama,
        "saat":         kapanis,
        "tur":          "ciro",
        "tamamlandi":   ciro_tamam,
        "aksiyon":      ciro_aksiyon,
    })

    gorevler.append({
        "id":       "kapanis",
        "baslik":   "Kapanış Kontrolü",
        "aciklama": f"Şube {kapanis} kapanıyor. Son kontroller.",
        "saat":     kapanis,
        "tur":      "kapanis",
        "tamamlandi": ciro_girildi and simdi >= kapanis,
        "aksiyon":  None,
    })

    return gorevler


@router.get("/merkez/durum")
def tum_subeler_durum():
    """Tüm şubelerin bugünkü ciro özeti (CFO / merkez)."""
    with db() as (conn, cur):
        cur.execute("SELECT * FROM subeler WHERE aktif=TRUE ORDER BY ad")
        subeler = cur.fetchall()

        sonuc = []
        for s in subeler:
            sid = s['id']
            ciro_girildi = _bugun_ciro_var_mi(cur, sid)
            sube_acik = _bugun_sube_acildi_mi(cur, sid)
            kasa_acik = _bugun_kasa_acildi_mi(cur, sid)

            cur.execute("""
                SELECT COALESCE(SUM(toplam), 0) as toplam
                FROM ciro
                WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='aktif'
            """, (sid,))
            bugun_ciro = float(cur.fetchone()['toplam'])

            cur.execute("""
                SELECT COALESCE(SUM(tutar), 0) as toplam
                FROM anlik_giderler
                WHERE sube=%s AND tarih=CURRENT_DATE AND durum='aktif'
            """, (sid,))
            bugun_gider = float(cur.fetchone()['toplam'])

            taslak_bek = _bugun_ciro_taslak_bekliyor(cur, sid) is not None
            if sube_acik and ciro_girildi:
                durum_txt = "✅ Tamamlandı"
            elif not kasa_acik:
                durum_txt = "🔒 Kasa kilidi (PIN)"
            elif not sube_acik:
                durum_txt = "🌅 Açılış bekliyor"
            elif taslak_bek:
                durum_txt = "📩 Ciro taslağı merkezde"
            else:
                durum_txt = "⏳ Ciro bekliyor"

            cur.execute(
                """
                SELECT tip, durum,
                    to_char(sistem_slot_ts, 'HH24:MI') AS sistem_saat,
                    to_char(cevap_ts, 'HH24:MI') AS cevap_saat,
                    CASE WHEN cevap_ts IS NOT NULL THEN
                        EXTRACT(EPOCH FROM (cevap_ts - sistem_slot_ts)) / 60.0
                    END AS fark_dk
                FROM sube_operasyon_event
                WHERE sube_id=%s AND tarih=CURRENT_DATE AND tip='KAPANIS' AND sira_no=0
                LIMIT 1
                """,
                (sid,),
            )
            kop = cur.fetchone()
            kapanis_op = None
            if kop:
                kapanis_op = {
                    "durum":       kop["durum"],
                    "sistem_saat": kop["sistem_saat"],
                    "cevap_saat":  kop["cevap_saat"],
                    "fark_dk":     float(kop["fark_dk"]) if kop["fark_dk"] is not None else None,
                }

            sonuc.append({
                "sube_id":        sid,
                "sube_adi":       s['ad'],
                "acilis_saati":   s.get('acilis_saati') or '09:00',
                "kapanis_saati":  s.get('kapanis_saati') or '22:00',
                "kasa_acik":      kasa_acik,
                "sube_acik":      sube_acik,
                "ciro_girildi":   ciro_girildi,
                "ciro_taslak_bekliyor": taslak_bek,
                "bugun_ciro":     bugun_ciro,
                "bugun_gider":    bugun_gider,
                "durum":          durum_txt,
                "kapanis_operasyon": kapanis_op,
            })

    return {
        "tarih":   str(date.today()),
        "subeler": sonuc,
        "tamamlanan": sum(1 for s in sonuc if s['sube_acik'] and s['ciro_girildi']),
        "toplam":     len(sonuc),
    }


class SubeAcilisModel(BaseModel):
    """Manuel şube açılış kaydı."""
    personel_id: Optional[str] = None
    aciklama: Optional[str] = None


class KasaKilitAcModel(BaseModel):
    panel_kullanici_id: str
    pin: str


class PanelKullaniciPinGuncelle(BaseModel):
    pin: str


@router.post("/{sube_id}/kasa-kilit-ac")
def kasa_kilit_ac(sube_id: str, body: KasaKilitAcModel):
    """Günlük kasa kilidini kayıtlı panel kullanıcısı + 4 haneli PIN ile aç."""
    uid = (body.panel_kullanici_id or "").strip()
    pin = (body.pin or "").strip()
    if not uid:
        raise HTTPException(400, "panel_kullanici_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli PIN gerekli")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            "SELECT sube_id FROM sube_panel_kullanici WHERE id=%s AND aktif=TRUE",
            (uid,),
        )
        row = cur.fetchone()
        if not row or str(row["sube_id"]) != str(sube_id):
            raise HTTPException(404, "Panel kullanıcısı bu şube için geçerli değil")
        _dogrula_pin(cur, uid, pin)
        cur.execute(
            "SELECT 1 FROM sube_kasa_gun_acma WHERE sube_id=%s AND tarih=CURRENT_DATE",
            (sube_id,),
        )
        if cur.fetchone():
            return {
                "success": True,
                "idempotent": True,
                "mesaj": "Kasa kilidi bugün zaten açılmış.",
            }
        cur.execute(
            """
            INSERT INTO sube_kasa_gun_acma (sube_id, tarih, panel_kullanici_id)
            VALUES (%s, CURRENT_DATE, %s)
            """,
            (sube_id, uid),
        )
        audit(
            cur,
            "sube_kasa_gun_acma",
            f"{sube_id}:{date.today()}",
            "KASA_ACILDI",
        )
    return {"success": True, "idempotent": False}


@router.get("/merkez/{sube_id}/panel-pin-kullanicilar")
def merkez_panel_pin_kullanicilar(sube_id: str):
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT u.id, u.ad, u.personel_id, u.aktif, u.yonetici,
                   p.ad_soyad AS personel_ad_soyad
            FROM sube_panel_kullanici u
            LEFT JOIN personel p ON p.id = u.personel_id
            WHERE u.sube_id=%s
            ORDER BY u.yonetici DESC, u.aktif DESC, u.ad
            """,
            (sube_id,),
        )
        return [dict(x) for x in cur.fetchall()]


@router.put("/merkez/{sube_id}/panel-kullanici/{kullanici_id}/pin")
def merkez_panel_kullanici_pin_guncelle(
    sube_id: str, kullanici_id: str, body: PanelKullaniciPinGuncelle
):
    p = (body.pin or "").strip()
    if len(p) != 4 or not p.isdigit():
        raise HTTPException(400, "4 haneli PIN gerekli")
    salt = uuid.uuid4().hex[:12]
    ph = _pin_hash(p, salt)
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        cur.execute(
            """
            SELECT id FROM sube_panel_kullanici
            WHERE id=%s AND sube_id=%s
            """,
            (kullanici_id, sube_id),
        )
        if not cur.fetchone():
            raise HTTPException(404, "Panel kullanıcısı bulunamadı")
        cur.execute(
            """
            UPDATE sube_panel_kullanici
            SET pin_salt=%s, pin_hash=%s
            WHERE id=%s
            """,
            (salt, ph, kullanici_id),
        )
        audit(cur, "sube_panel_kullanici", kullanici_id, "PIN_GUNCELLE")
    return {"success": True}


@router.post("/{sube_id}/acilis")
def sube_acilis_kaydet(sube_id: str, body: SubeAcilisModel = SubeAcilisModel()):
    """
    Şubeyi aç — gün başına tek aktif kayıt (durum=acildi).
    Saat geçmiş olsa bile açılış, bu kayıt olmadan tamamlanmış sayılmaz.
    """
    simdi = datetime.now()
    saat_str = simdi.strftime("%H:%M")
    with db() as (conn, cur):
        _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce günlük kasa kilidini PIN ile açmalısınız.",
            )
        cur.execute("""
            SELECT id FROM sube_acilis
            WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='acildi'
        """, (sube_id,))
        mevcut = cur.fetchone()
        if mevcut:
            return {
                "success": True,
                "idempotent": True,
                "id":         str(mevcut["id"]),
                "acilis_saati": saat_str,
                "mesaj":      "Bugün bu şube zaten açılmış kayıtlı.",
            }
        aid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO sube_acilis
                (id, sube_id, tarih, acilis_saati, personel_id, durum, aciklama)
            VALUES (%s, %s, CURRENT_DATE, %s, %s, 'acildi', %s)
        """, (
            aid,
            sube_id,
            saat_str,
            body.personel_id,
            body.aciklama,
        ))
        audit(cur, "sube_acilis", aid, "ACILIS_PANEL")
    return {
        "success":       True,
        "id":            aid,
        "acilis_saati":  saat_str,
        "idempotent":    False,
    }


@router.get("/x-rapor/{kayit_id}/foto")
def x_rapor_foto_getir(kayit_id: str):
    """OCR için yüklenen fiş görüntüsü (denetim / kanıt)."""
    with db() as (conn, cur):
        cur.execute(
            "SELECT dosya_yolu, mime_type FROM x_rapor_kayit WHERE id=%s",
            (kayit_id,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Kayıt bulunamadı")
    p = pathlib.Path(row["dosya_yolu"])
    if not p.is_file():
        raise HTTPException(404, "Dosya bulunamadı")
    return FileResponse(
        str(p),
        media_type=row.get("mime_type") or "image/jpeg",
        filename=p.name,
    )


@router.post("/{sube_id}/x-rapor-oku")
async def x_rapor_oku(
    sube_id: str,
    file: UploadFile = File(...),
    personel_id: Optional[str] = Form(None),
):
    """
    Yazarkasa X raporu fotoğrafından nakit / POS / online / toplam çıkarır.
    Görüntü diske yazılır, model cevabı DB'de saklanır (kanıt).
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            503,
            "OPENAI_API_KEY ortam değişkeni tanımlı değil — OCR kullanılamaz.",
        )

    raw_bytes = await file.read()
    if len(raw_bytes) > _X_RAPOR_MAX_BYTES:
        raise HTTPException(413, "Dosya çok büyük (en fazla 8 MB)")

    mime = (file.content_type or "image/jpeg").split(";")[0].strip().lower()
    if not mime.startswith("image/"):
        raise HTTPException(400, "Sadece görüntü dosyası kabul edilir")

    ext = ".jpg"
    if "png" in mime:
        ext = ".png"
    elif "webp" in mime:
        ext = ".webp"
    elif "gif" in mime:
        ext = ".gif"

    rid = str(uuid.uuid4())
    sub_dir = _X_UPLOAD_ROOT / sube_id
    sub_dir.mkdir(parents=True, exist_ok=True)
    rel_path = sub_dir / f"{rid}{ext}"
    abs_path = pathlib.Path(rel_path).resolve()

    kasa_snap: Optional[float] = None
    ham_text = ""
    amounts = {"nakit": 0.0, "pos": 0.0, "online": 0.0, "toplam": 0.0}

    try:
        abs_path.write_bytes(raw_bytes)
        b64 = base64.b64encode(raw_bytes).decode("ascii")
        data_url = f"data:{mime};base64,{b64}"

        try:
            from openai import OpenAI
        except ImportError as e:
            raise HTTPException(503, "openai paketi yüklü değil: pip install openai") from e

        model = os.getenv("OPENAI_X_RAPOR_MODEL", "gpt-4o-mini")
        client = OpenAI(api_key=api_key)

        prompt = """Bu görüntü bir Türkiye yazarkasa X raporu veya günlük satış özeti olabilir.

Şu alanları mümkün olduğunca sayısal çıkar (yoksa 0):
- nakit (nakit satış / nakit tahsilat)
- pos (kredi kartı / POS)
- online (online ödeme / QR / havale satış vb.)
- toplam (rapordaki genel satış toplamı varsa; yoksa nakit+pos+online ile uyumlu bir toplam)

Sadece geçerli bir JSON nesnesi döndür. Başka metin, markdown veya açıklama yazma.
Örnek: {"nakit":10000,"pos":13000,"online":0,"toplam":23000}
"""

        resp = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            max_tokens=400,
        )
        msg = resp.choices[0].message
        raw_content = msg.content
        if isinstance(raw_content, list):
            parts = []
            for c in raw_content:
                if isinstance(c, dict) and c.get("type") == "text":
                    parts.append(c.get("text") or "")
            ham_text = "\n".join(parts).strip()
        else:
            ham_text = (raw_content or "").strip()

        parsed = _x_parse_model_json(ham_text)
        if not isinstance(parsed, dict):
            raise ValueError("Model geçerli JSON nesnesi döndürmedi")
        amounts = _x_extract_amounts(parsed)

        with db() as (conn, cur):
            if not _bugun_kasa_acildi_mi(cur, sube_id):
                raise HTTPException(
                    403,
                    "Önce kasa kilidini PIN ile açmalısınız.",
                )
            if not _bugun_sube_acildi_mi(cur, sube_id):
                raise HTTPException(
                    403,
                    "Önce şubeyi açmalısınız — OCR yalnızca açılış sonrası kullanılabilir.",
                )
            _sube_getir(cur, sube_id)
            kasa_snap = float(kasa_bakiyesi(cur))

            cur.execute(
                """
                INSERT INTO x_rapor_kayit
                    (id, sube_id, tarih, personel_id, dosya_yolu, mime_type, ham_cevap,
                     nakit, pos, online, toplam_ocr, kasa_snapshot)
                VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    rid,
                    sube_id,
                    personel_id or None,
                    str(abs_path),
                    mime,
                    ham_text[:12000],
                    amounts["nakit"],
                    amounts["pos"],
                    amounts["online"],
                    amounts["toplam"],
                    kasa_snap,
                ),
            )
            audit(cur, "x_rapor_kayit", rid, "OCR_X_RAPOR")

        fark = abs(float(amounts["toplam"] or 0) - float(kasa_snap or 0))
        kasa_uyari = None
        if amounts["toplam"] > 0 and fark > max(500.0, 0.05 * float(amounts["toplam"])):
            kasa_uyari = (
                f"OCR toplamı ({amounts['toplam']:,.0f} ₺) ile güncel kasa ({kasa_snap:,.0f} ₺) "
                f"arasında belirgin fark var — değerleri kontrol edin."
            )

        return {
            "nakit":       amounts["nakit"],
            "pos":         amounts["pos"],
            "online":      amounts["online"],
            "toplam":      amounts["toplam"],
            "kayit_id":    rid,
            "foto_url":    f"/api/sube-panel/x-rapor/{rid}/foto",
            "kasa_bakiye": kasa_snap,
            "kasa_uyari":  kasa_uyari,
        }
    except HTTPException:
        if abs_path.is_file():
            try:
                abs_path.unlink()
            except OSError:
                pass
        raise
    except Exception as e:
        if abs_path.is_file():
            try:
                abs_path.unlink()
            except OSError:
                pass
        raise HTTPException(400, f"OCR işlenemedi: {e!s}") from e


def _build_sube_panel_payload(cur, sube_id: str) -> dict:
    """Şube panel tam JSON (CFO / tam yetki)."""
    sube = _sube_getir(cur, sube_id)
    ciro_girildi = _bugun_ciro_var_mi(cur, sube_id)
    taslak_row = _bugun_ciro_taslak_bekliyor(cur, sube_id)
    ciro_taslak_bekliyor = taslak_row is not None
    anlik_adet = _bugun_anlik_gider_sayisi(cur, sube_id)
    sube_acildi_mi = _bugun_sube_acildi_mi(cur, sube_id)
    kasa_acildi_mi = _bugun_kasa_acildi_mi(cur, sube_id)
    kasa_acma = _bugun_kasa_acma_kaydi(cur, sube_id)
    acilis_kaydi = _bugun_acilis_kaydi(cur, sube_id)

    cur.execute("""
        SELECT
            COALESCE(SUM(nakit), 0)  as nakit,
            COALESCE(SUM(pos), 0)    as pos,
            COALESCE(SUM(online), 0) as online,
            COALESCE(SUM(toplam), 0) as toplam
        FROM ciro
        WHERE sube_id=%s AND tarih=CURRENT_DATE AND durum='aktif'
    """, (sube_id,))
    ciro_ozet = dict(cur.fetchone())

    gorevler = _gorev_listesi_uret(
        sube,
        ciro_girildi,
        anlik_adet,
        sube_acildi_mi,
        ciro_taslak_bekliyor,
        kasa_acildi_mi=kasa_acildi_mi,
    )
    panel_pin_kullanicilar = _list_panel_kullanici(cur, sube_id)
    cur.execute(
        """
        SELECT COUNT(*)::int AS c FROM sube_panel_kullanici
        WHERE sube_id=%s AND aktif=TRUE AND yonetici=TRUE
        """,
        (sube_id,),
    )
    panel_yonetici_sayisi = int(cur.fetchone()["c"])
    tamamlanan = sum(1 for g in gorevler if g["tamamlandi"])

    from sube_operasyon import build_panel_operasyon_blob
    from sube_kapanis_dual import vardiya_devir_panel_blob

    operasyon = build_panel_operasyon_blob(cur, sube_id, sube)
    vardiya_devir = vardiya_devir_panel_blob(cur, sube_id)

    kasa_kilitli = not kasa_acildi_mi
    panel_blok = kasa_kilitli or (not sube_acildi_mi)

    return {
        "sube_id":        sube_id,
        "sube_adi":       sube["ad"],
        "acilis_saati":   sube.get("acilis_saati") or "09:00",
        "kapanis_saati":  sube.get("kapanis_saati") or "22:00",
        "tarih":          str(date.today()),
        "kasa_kilitli":   kasa_kilitli,
        "kasa_acma":      kasa_acma,
        "sube_acik":      sube_acildi_mi,
        "panel_kilitli":  panel_blok,
        "panel_blok_asama": (
            "kasa" if kasa_kilitli else ("acilis" if not sube_acildi_mi else None)
        ),
        "panel_pin_kullanicilar": panel_pin_kullanicilar,
        "panel_yonetici_sayisi": panel_yonetici_sayisi,
        "acilis_kaydi":   acilis_kaydi,
        "gorevler":       gorevler,
        "tamamlanan":     tamamlanan,
        "toplam_gorev":   len(gorevler),
        "ciro_girildi":   ciro_girildi,
        "ciro_taslak_bekliyor": ciro_taslak_bekliyor,
        "ciro_taslak":    taslak_row,
        "ciro_ozet":      {k: float(v) for k, v in ciro_ozet.items()},
        "anlik_gider_adet": anlik_adet,
        "operasyon":      operasyon,
        "vardiya_devir":  vardiya_devir,
    }


def sube_personel_panel_public(payload: dict) -> dict:
    """
    Personel paneli: finansal sonuç / fark / detaylı vardiya nakitleri gösterilmez.
    """
    p = dict(payload)
    p.pop("ciro_ozet", None)
    p.pop("ciro_taslak", None)
    p.pop("anlik_gider_adet", None)
    vd = p.get("vardiya_devir")
    if isinstance(vd, dict):
        pk = vd.get("panel_kullanicilar")
        p["vardiya_devir"] = {
            "bilgi": "Vardiya / kasa detayı personel ekranında gösterilmez.",
            "vardiya_devir_pin_zorunlu": vd.get("vardiya_devir_pin_zorunlu"),
            "panel_kullanici_sayisi": len(pk) if isinstance(pk, list) else 0,
        }
    op = p.get("operasyon")
    if isinstance(op, dict):
        evs = op.get("events") or []
        akt = op.get("aktif")
        akt_kisa = None
        if isinstance(akt, dict):
            akt_kisa = {
                k: akt.get(k)
                for k in (
                    "id",
                    "tip",
                    "durum",
                    "sistem_slot_ts",
                    "son_teslim_ts",
                    "alarm_sayisi",
                )
            }
        p["operasyon"] = {
            "sunucu_saati": op.get("sunucu_saati"),
            "sunucu_iso": op.get("sunucu_iso"),
            "aktif": akt_kisa,
            "aktif_gecikme_dk": op.get("aktif_gecikme_dk"),
            "aktif_kritik": op.get("aktif_kritik"),
            "aktif_suphe": op.get("aktif_suphe"),
            "alarm_politikasi": op.get("alarm_politikasi"),
            "events_ozet": [{"tip": e.get("tip"), "durum": e.get("durum")} for e in evs],
            "esikler": op.get("esikler"),
        }
    p["uyari"] = (
        "Bu ekran operasyon disiplini içindir; ciro toplamları ve kasa farkı yalnızca "
        "merkez (CFO / operasyon) tarafında analiz edilir."
    )
    return p


@router.get("/{sube_id}")
def sube_panel_getir(sube_id: str):
    with db() as (conn, cur):
        return _build_sube_panel_payload(cur, sube_id)


class SubeCiroModel(BaseModel):
    nakit:        float = 0
    pos:          float = 0
    online:       float = 0
    aciklama:     Optional[str] = None
    force:        bool = False
    personel_id:  Optional[str] = None


@router.post("/{sube_id}/ciro")
def sube_ciro_gir(sube_id: str, body: SubeCiroModel):
    """
    Personel ciro girişi — doğrudan ciroya yazılmaz; ciro_taslak (bekliyor) oluşturur.
    Merkez «Ciro onayı» ekranından onaylanınca ciro + kasa işlenir.
    """
    nakit  = float(body.nakit  or 0)
    pos    = float(body.pos    or 0)
    online = float(body.online or 0)
    toplam = nakit + pos + online

    if toplam <= 0:
        raise HTTPException(400, "En az bir tutar girilmeli")

    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce günlük kasa kilidini PIN ile açmalısınız.",
            )
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce şubeyi açmalısınız — panelde «Şubeyi Aç» ile kayıt oluşturun.",
            )

        if _bugun_ciro_var_mi(cur, sube_id):
            raise HTTPException(
                400,
                f"Bugün {sube['ad']} için onaylı ciro zaten kayıtlı. "
                "Düzeltme için merkez ile iletişime geçin.",
            )

        mevcut_taslak = _bugun_ciro_taslak_bekliyor(cur, sube_id)
        if mevcut_taslak and not body.force:
            return {
                "warning": True,
                "taslak_id": mevcut_taslak["id"],
                "mesaj": (
                    f"Bugün {sube['ad']} için bekleyen bir ciro taslağınız var. "
                    "Tutarları güncellemek için «Yine de Kaydet» ile yeniden gönderin."
                ),
            }

        if mevcut_taslak and body.force:
            cur.execute(
                "DELETE FROM ciro_taslak WHERE id=%s AND durum='bekliyor'",
                (mevcut_taslak["id"],),
            )

        tid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO ciro_taslak
                (id, sube_id, tarih, nakit, pos, online, aciklama, personel_id, durum)
            VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s, %s, 'bekliyor')
            """,
            (
                tid,
                sube_id,
                nakit,
                pos,
                online,
                body.aciklama or "Şube panelinden",
                body.personel_id or None,
            ),
        )
        audit(cur, "ciro_taslak", tid, "TASLAK_BEKLIYOR")

    return {
        "success":     True,
        "taslak_id":   tid,
        "bekliyor":    True,
        "mesaj":       "Ciro merkez onayına gönderildi. Onay sonrası sisteme işlenir.",
    }


class SubeAnlikGiderModel(BaseModel):
    kategori:  str
    tutar:     float
    aciklama:  Optional[str] = None


@router.post("/{sube_id}/anlik-gider")
def sube_anlik_gider_gir(sube_id: str, body: SubeAnlikGiderModel):
    if body.tutar <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")

    with db() as (conn, cur):
        sube = _sube_getir(cur, sube_id)
        if not _bugun_kasa_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce günlük kasa kilidini PIN ile açmalısınız.",
            )
        if not _bugun_sube_acildi_mi(cur, sube_id):
            raise HTTPException(
                403,
                "Önce şubeyi açmalısınız — panelde «Şubeyi Aç» ile kayıt oluşturun.",
            )

        gid = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO anlik_giderler
                (id, tarih, kategori, tutar, aciklama, sube, odeme_yontemi)
            VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, 'nakit')
        """, (gid, body.kategori, body.tutar,
              body.aciklama or '', sube_id))

        insert_kasa_hareketi(
            cur, date.today(), 'ANLIK_GIDER', -abs(body.tutar),
            f"Anlık gider: {body.aciklama or body.kategori} — {sube['ad']}",
            'anlik_giderler', gid
        )
        audit(cur, 'anlik_giderler', gid, 'INSERT_PANEL')

    return {"success": True, "id": gid}
