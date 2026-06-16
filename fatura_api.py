"""
Tedarikçi Fatura Okuma Modülü — İZOLE.

Tasarım ilkesi (bkz. memory project_fatura_okuma_modulu + feedback_cozum_felsefesi
"Öneri-Only / Proposed State"):
  - Bu modül sistemin GERÇEKLERİNİ (stok maliyeti, ürün fiyatı) ASLA doğrudan
    değiştirmez. Yalnızca KENDİ tablolarına yazar (öneri/ham veri).
  - FAIL CLOSED + ASENKRON: şube OCR beklemez. Foto yüklenince kabul anında biter;
    OCR arka planda çalışır, sonuç inceleme ekranına düşer. OCR çökse manuel devam.
  - Kill switch: FATURA_MODUL env=0 → tamamen kapanır (kritik akış etkilenmez).
  - Kritik tablolara SERT FK yok; sadece yumuşak id referansı (sube_id, siparis_talep_id).

Faz 1 (bu dosya): foto upload → asenkron vision OCR → ham JSON + kalemler. Öneri-only.
Faz 2+: ürün eşleştirme hafızası, üç-yönlü uzlaşma, fiyat onayı (Price Approval Service).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import uuid
from datetime import date
from typing import Any, Dict, List, Optional

import io

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/fatura", tags=["fatura-okuma"])


def fatura_modul_aktif() -> bool:
    """Kill switch — FATURA_MODUL=0 ise modül pasif (kritik akış etkilenmez)."""
    return os.getenv("FATURA_MODUL", "1").strip() not in ("0", "false", "False", "")


_TABLOLAR_HAZIR = False


def _ensure_tablolar(cur) -> None:
    """Modülün KENDİ tabloları (izole). İlk kullanımda lazy oluşturulur."""
    global _TABLOLAR_HAZIR
    if _TABLOLAR_HAZIR:
        return
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_fatura (
            id                  TEXT PRIMARY KEY,
            sube_id             TEXT,
            siparis_talep_id    TEXT,
            tedarikci_ad        TEXT,
            fatura_tarih        DATE,
            toplam_tutar        DOUBLE PRECISION,
            foto                BYTEA,
            foto_mime           TEXT,
            durum               TEXT NOT NULL DEFAULT 'ocr_bekliyor',
            ocr_json            JSONB,
            ocr_hata            TEXT,
            yukleyen_personel_id TEXT,
            olusturma           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            inceleme_ts         TIMESTAMPTZ,
            inceleyen           TEXT
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tf_sube_durum ON tedarikci_fatura (sube_id, durum, olusturma DESC)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_fatura_kalem (
            id              TEXT PRIMARY KEY,
            fatura_id       TEXT NOT NULL,
            sira            INT,
            ocr_ad          TEXT,
            adet            DOUBLE PRECISION,
            birim           TEXT,
            birim_fiyat     DOUBLE PRECISION,
            satir_toplam    DOUBLE PRECISION,
            eslesen_stok_kodu TEXT,   -- ÖNERİ (nullable), eşleştirme Faz 2
            eslesme_guven   DOUBLE PRECISION,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tfk_fatura ON tedarikci_fatura_kalem (fatura_id)")
    # Köprü: e-faturadaki ürün kodu (alias anahtarı için) — onay adımında kullanılır
    cur.execute("ALTER TABLE tedarikci_fatura_kalem ADD COLUMN IF NOT EXISTS ocr_urun_kodu TEXT")
    # Fiyat geçmişi — GERÇEK fiyat değil; modülün kendi takip kaydı. Kritik maliyete
    # ancak ayrı Price Approval Service + insan onayı ile bağlanır (Faz 3).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_urun_fiyat_gecmis (
            id              TEXT PRIMARY KEY,
            tedarikci_ad    TEXT,
            stok_kodu       TEXT,
            urun_ad         TEXT,
            birim_fiyat     DOUBLE PRECISION,
            fatura_id       TEXT,
            onaylayan       TEXT,
            gecerlilik_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tufg_ted_stok ON tedarikci_urun_fiyat_gecmis (tedarikci_ad, stok_kodu, gecerlilik_ts DESC)")
    _TABLOLAR_HAZIR = True


# ── OCR (asenkron, arka plan) ────────────────────────────────────────────────

_OCR_PROMPT = (
    "Bu, basılı bir Türk e-FATURASI fotoğrafıdır (bilgisayar çıktısı, düzenli tablo).\n"
    "ÖNEMLİ — TEDARİKÇİ KİM: Faturayı DÜZENLEYEN/satan firma EN ÜSTTEKİ başlıktır "
    "(logo/ünvan + VKN + 'e-Fatura'). 'SAYIN' satırından sonra gelen firma ALICIdır "
    "(müşteri) — onu tedarikçi SANMA. tedarikci alanına EN ÜSTTEKİ düzenleyen firmayı yaz.\n"
    "Kalem TABLOSUNDAKİ HER SATIRI oku. 'Ürün Kodu'/'Mal Hizmet Kodu' kolonundaki kodu "
    "(örn. ST00558, STK0590) MUTLAKA al — bu en kritik alan.\n"
    "SADECE şu JSON'u döndür, başka metin yazma:\n"
    '{"tedarikci": "<EN ÜSTTEKİ düzenleyen firma ünvanı>", '
    '"fatura_no": "<fatura no>", "fatura_tarih": "YYYY-MM-DD veya null", '
    '"toplam_tutar": <Ödenecek/Genel Toplam sayı veya null>, "kalemler": [{'
    '"urun_kodu": "<Ürün Kodu, örn ST00558; yoksa null>", '
    '"ad": "<malzeme/hizmet açıklaması>", "adet": <miktar sayı>, '
    '"birim": "<Adet/kg/lt>", "birim_fiyat": <Birim Fiyatı sayı>, '
    '"satir_toplam": <satır KDV hariç tutar sayı>}]}\n'
    "Sayı biçimi: Türkçe 1.234,56 → 1234.56 (nokta=ondalık). Tarih gün-ay-yıl ise "
    "YYYY-MM-DD'ye çevir. Her ürün satırını ekle; sadece okunamayan TEK alanı null bırak."
)


def _vision_ocr(foto: bytes, mime: str) -> Dict[str, Any]:
    """Vision model ile faturadan yapılandırılmış JSON çıkarır. Hata → exception."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY yok")
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    b64 = base64.b64encode(foto).decode("ascii")
    resp = client.chat.completions.create(
        model=os.getenv("OPENAI_FATURA_MODEL", "gpt-4o"),  # fatura kritik → tam model
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": _OCR_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }],
        max_tokens=1500,
    )
    metin = (resp.choices[0].message.content or "").strip()
    # JSON gövdeyi ayıkla (model bazen ```json ... ``` sarar)
    if "```" in metin:
        metin = metin.split("```")[1]
        if metin.startswith("json"):
            metin = metin[4:]
    metin = metin.strip()
    j = json.loads(metin)
    return j if isinstance(j, dict) else {}


def _ocr_calistir(fatura_id: str) -> None:
    """Arka plan iş parçacığı — kendi DB bağlantısı. Hiçbir hata fırlatmaz."""
    try:
        with db() as (conn, cur):
            _ensure_tablolar(cur)
            cur.execute("SELECT foto, foto_mime FROM tedarikci_fatura WHERE id=%s", (fatura_id,))
            r = cur.fetchone()
            if not r:
                return
            foto = bytes(dict(r).get("foto") or b"")
            mime = dict(r).get("foto_mime") or "image/jpeg"
        if not foto:
            raise RuntimeError("foto boş")

        j = _vision_ocr(foto, mime)
        kalemler = j.get("kalemler") if isinstance(j.get("kalemler"), list) else []

        with db() as (conn, cur):
            _ensure_tablolar(cur)
            cur.execute(
                """
                UPDATE tedarikci_fatura
                SET tedarikci_ad=%s, fatura_tarih=%s, toplam_tutar=%s,
                    ocr_json=%s::jsonb, durum='ocr_tamam', ocr_hata=NULL
                WHERE id=%s
                """,
                (
                    (str(j.get("tedarikci") or "").strip() or None),
                    (str(j.get("fatura_tarih")) if j.get("fatura_tarih") else None),
                    _sayi(j.get("toplam_tutar")),
                    json.dumps(j, ensure_ascii=False),
                    fatura_id,
                ),
            )
            for i, k in enumerate(kalemler):
                if not isinstance(k, dict):
                    continue
                _ad = (str(k.get("ad") or "").strip() or None)
                _kod = (str(k.get("urun_kodu") or "").strip() or None)
                # ── KÖPRÜ: mevcut alias hafızasından eşleşen stok kalemini öner ──
                _anahtar = _fatura_anahtar_ocr(_kod, _ad)
                _es = _alias_eslesme(cur, _anahtar)
                _eslesen = _es.get("kalem_kodu") if _es else None
                cur.execute(
                    """
                    INSERT INTO tedarikci_fatura_kalem
                        (id, fatura_id, sira, ocr_ad, ocr_urun_kodu, adet, birim,
                         birim_fiyat, satir_toplam, eslesen_stok_kodu, eslesme_guven)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        str(uuid.uuid4()), fatura_id, i, _ad, _kod,
                        _sayi(k.get("adet")), (str(k.get("birim") or "").strip() or None),
                        _sayi(k.get("birim_fiyat")), _sayi(k.get("satir_toplam")),
                        _eslesen, (1.0 if _eslesen else None),
                    ),
                )
            conn.commit()
        logger.info("fatura OCR tamam: %s (%d kalem)", fatura_id, len(kalemler))
    except Exception as e:
        logger.warning("fatura OCR hata %s: %s", fatura_id, e)
        try:
            with db() as (conn, cur):
                cur.execute(
                    "UPDATE tedarikci_fatura SET durum='ocr_hata', ocr_hata=%s WHERE id=%s",
                    (str(e)[:500], fatura_id),
                )
                conn.commit()
        except Exception:
            pass


def _sayi(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def _fatura_anahtar_ocr(urun_kodu: Optional[str], ad: Optional[str]) -> str:
    """operasyon_merkez_api._fatura_anahtar ile AYNI mantık (inline — izolasyon).
    Ürün kodu varsa kod:<kod>, yoksa normalize açıklama. Mevcut alias hafızasına
    (fatura_kalem_eslestirme) köprü için anahtar tutarlı olmalı."""
    kod = (urun_kodu or "").strip()
    if kod:
        return f"kod:{kod.lower()}"
    a = re.sub(r"\s+", " ", (ad or "")).strip().lower()
    a = re.sub(r"[^a-zçğıöşü0-9 ]", "", a)
    return a[:120]


def _alias_eslesme(cur, anahtar: str) -> Optional[Dict[str, Any]]:
    """Mevcut öğrenen eşleştirme hafızasından (fatura_kalem_eslestirme) öneri.
    Tablo yoksa/hata → None (best-effort, OCR'ı bozmaz)."""
    if not anahtar:
        return None
    try:
        cur.execute("SAVEPOINT sp_alias")
        cur.execute(
            "SELECT kalem_kodu, kalem_adi FROM fatura_kalem_eslestirme WHERE anahtar=%s",
            (anahtar,),
        )
        r = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT sp_alias")
        return dict(r) if r else None
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_alias")
            cur.execute("RELEASE SAVEPOINT sp_alias")
        except Exception:
            pass
        return None


def _son_alis_fiyat(cur, kalem_kodu: str) -> Optional[Dict[str, Any]]:
    """Mevcut fiyat geçmişinden (urun_alis_fiyat) son bilinen birim maliyet —
    zam/azalış karşılaştırması için. Best-effort."""
    if not kalem_kodu:
        return None
    try:
        cur.execute("SAVEPOINT sp_fiyat")
        cur.execute(
            """SELECT birim_maliyet_tl, gecerli_baslangic::text AS tarih
               FROM urun_alis_fiyat WHERE kalem_kodu=%s
               ORDER BY gecerli_baslangic DESC LIMIT 1""",
            (kalem_kodu,),
        )
        r = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT sp_fiyat")
        return dict(r) if r else None
    except Exception:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sp_fiyat")
            cur.execute("RELEASE SAVEPOINT sp_fiyat")
        except Exception:
            pass
        return None


# ── Endpoint'ler ─────────────────────────────────────────────────────────────

@router.post("/yukle")
async def fatura_yukle(
    foto: UploadFile = File(...),
    sube_id: str = Form(...),
    siparis_talep_id: Optional[str] = Form(None),
    personel_id: Optional[str] = Form(None),
):
    """Fatura fotoğrafı yükle. ANINDA döner (durum=ocr_bekliyor); OCR arka planda.
    Şube bu çağrıyı beklemez — kabul akışı kesintisiz devam eder."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı (FATURA_MODUL=0).")
    raw = await foto.read()
    if not raw:
        raise HTTPException(400, "Boş dosya")
    mime = foto.content_type or "image/jpeg"
    fid = str(uuid.uuid4())
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            INSERT INTO tedarikci_fatura
                (id, sube_id, siparis_talep_id, foto, foto_mime, durum, yukleyen_personel_id)
            VALUES (%s, %s, %s, %s, %s, 'ocr_bekliyor', %s)
            """,
            (fid, sube_id.strip(), (siparis_talep_id or None), raw, mime, (personel_id or None)),
        )
        conn.commit()
    # Asenkron OCR — şubeyi bekletmeden
    threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()
    return {"fatura_id": fid, "durum": "ocr_bekliyor"}


@router.get("/bekleyen")
def fatura_bekleyen(sube_id: Optional[str] = None, limit: int = 50):
    """İncelenmeyi bekleyen faturalar (OCR tamam ama insan onayı yok)."""
    if not fatura_modul_aktif():
        return {"satirlar": []}
    lim = max(1, min(200, int(limit or 50)))
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        kosul = "durum IN ('ocr_tamam','ocr_hata','ocr_bekliyor')"
        params: List[Any] = []
        if sube_id:
            kosul += " AND sube_id=%s"
            params.append(sube_id.strip())
        cur.execute(
            f"""
            SELECT id, sube_id, tedarikci_ad, fatura_tarih, toplam_tutar, durum,
                   ocr_hata, olusturma
            FROM tedarikci_fatura
            WHERE {kosul}
            ORDER BY olusturma DESC
            LIMIT %s
            """,
            tuple(params + [lim]),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    for r in rows:
        r["fatura_tarih"] = str(r.get("fatura_tarih") or "")
        r["olusturma"] = str(r.get("olusturma") or "")
    return {"satirlar": rows, "toplam": len(rows)}


_CEK_HTML = """<!doctype html><html lang="tr"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<title>Fatura Çek</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:#0f172a;color:#e2e8f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:560px;margin:0 auto;padding:16px;min-height:100vh;display:flex;flex-direction:column;gap:14px}
  h1{font-size:18px;margin:4px 0 0}
  .sub{font-size:13px;color:#94a3b8;margin-bottom:4px}
  video,canvas,img.snap{width:100%;border-radius:14px;background:#000;aspect-ratio:3/4;object-fit:cover}
  .btn{border:0;border-radius:14px;padding:18px;font-size:18px;font-weight:700;cursor:pointer;width:100%}
  .btn-acik{background:#3b82f6;color:#fff}
  .btn-cek{background:#22c55e;color:#06281a}
  .btn-yukle{background:#22c55e;color:#06281a}
  .btn-tekrar{background:#334155;color:#e2e8f0}
  .row{display:flex;gap:10px}
  .row .btn{flex:1}
  .hata{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.5);border-radius:12px;padding:12px;font-size:14px}
  .ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.4);border-radius:12px;padding:12px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #1e293b}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .durum{font-size:14px;color:#cbd5e1;display:flex;align-items:center;gap:8px}
  .spin{width:16px;height:16px;border:2px solid #475569;border-top-color:#22c55e;border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  .gizle{display:none}
</style></head><body><div class="wrap">
  <div><h1>📄 Fatura Çek</h1><div class="sub" id="subeAd"></div></div>
  <div id="hata" class="hata gizle"></div>

  <div id="adimKamera">
    <video id="vid" autoplay playsinline muted></video>
    <div style="height:10px"></div>
    <button id="btnAc" class="btn btn-acik">📷 Kamerayı Aç</button>
    <button id="btnCek" class="btn btn-cek gizle">⚪ Çek</button>
  </div>

  <div id="adimOnizle" class="gizle">
    <img id="snap" class="snap"/>
    <div style="height:10px"></div>
    <div class="row">
      <button id="btnTekrar" class="btn btn-tekrar">↺ Tekrar Çek</button>
      <button id="btnYukle" class="btn btn-yukle">⬆ Yükle</button>
    </div>
  </div>

  <div id="adimSonuc" class="gizle">
    <div id="durumKutu" class="durum"><span class="spin"></span><span id="durumYazi">OCR bekleniyor…</span></div>
    <div id="sonucKutu"></div>
    <div style="height:8px"></div>
    <button id="btnYeni" class="btn btn-acik">＋ Yeni Fatura</button>
  </div>

  <canvas id="cv" class="gizle"></canvas>
</div>
<script>
const qp=new URLSearchParams(location.search);
const SUBE=qp.get('sube_id')||'';
const TALEP=qp.get('siparis_talep_id')||'';
document.getElementById('subeAd').textContent = SUBE ? ('Şube: '+SUBE) : 'Şube belirtilmedi (sube_id parametresi gerekli)';
let stream=null, blob=null;
const $=id=>document.getElementById(id);
function hata(m){const h=$('hata');h.textContent=m;h.classList.remove('gizle');}
function temizHata(){$('hata').classList.add('gizle');}
function goster(id){['adimKamera','adimOnizle','adimSonuc'].forEach(a=>$(a).classList.toggle('gizle',a!==id));}

$('btnAc').onclick=async()=>{
  temizHata();
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    $('vid').srcObject=stream;
    $('btnAc').classList.add('gizle');$('btnCek').classList.remove('gizle');
  }catch(e){hata('Kamera açılamadı: '+(e.message||e)+' (HTTPS ve kamera izni gerekli)');}
};
$('btnCek').onclick=()=>{
  const v=$('vid'),cv=$('cv');
  cv.width=v.videoWidth||1080;cv.height=v.videoHeight||1440;
  cv.getContext('2d').drawImage(v,0,0,cv.width,cv.height);
  cv.toBlob(b=>{blob=b;$('snap').src=URL.createObjectURL(b);goster('adimOnizle');},'image/jpeg',0.85);
};
$('btnTekrar').onclick=()=>goster('adimKamera');
$('btnYukle').onclick=async()=>{
  if(!blob){hata('Önce fotoğraf çek');return;}
  if(!SUBE){hata('sube_id parametresi eksik — şube panelinden açın');return;}
  temizHata();$('btnYukle').disabled=true;$('btnYukle').textContent='Yükleniyor…';
  try{
    const fd=new FormData();
    fd.append('foto',blob,'fatura.jpg');fd.append('sube_id',SUBE);
    if(TALEP)fd.append('siparis_talep_id',TALEP);
    const r=await fetch('/api/fatura/yukle',{method:'POST',body:fd});
    const d=await r.json();
    if(!r.ok)throw new Error(d.detail||'yükleme hatası');
    // kamerayı kapat
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
    goster('adimSonuc');pollOCR(d.fatura_id);
  }catch(e){hata('Yükleme hatası: '+(e.message||e));}
  $('btnYukle').disabled=false;$('btnYukle').textContent='⬆ Yükle';
};
async function pollOCR(fid){
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,2000));
    let d;try{d=await (await fetch('/api/fatura/'+fid)).json();}catch(e){continue;}
    const f=d.fatura||{};
    if(f.durum==='ocr_tamam'){renderSonuc(f,d.kalemler||[]);return;}
    if(f.durum==='ocr_hata'){
      $('durumKutu').innerHTML='';
      $('sonucKutu').innerHTML='<div class="hata">OCR okunamadı: '+(f.ocr_hata||'bilinmeyen')+'. Fatura kaydedildi, merkez manuel inceleyebilir.</div>';
      return;
    }
  }
  $('durumKutu').innerHTML='';
  $('sonucKutu').innerHTML='<div class="ok">Fatura yüklendi. OCR arka planda devam ediyor — sonuç merkez inceleme ekranına düşecek.</div>';
}
function renderSonuc(f,kalemler){
  $('durumKutu').innerHTML='';
  let h='<div class="ok"><b>'+(f.tedarikci_ad||'(tedarikçi okunamadı)')+'</b>';
  if(f.fatura_tarih)h+=' · '+f.fatura_tarih;
  if(f.toplam_tutar!=null)h+=' · Toplam '+f.toplam_tutar+'₺';
  h+='</div>';
  if(kalemler.length){
    h+='<table><tr><th>Ürün</th><th class="num">Adet</th><th class="num">B.Fiyat</th><th class="num">Tutar</th></tr>';
    kalemler.forEach(k=>{h+='<tr><td>'+(k.ocr_ad||'-')+'</td><td class="num">'+(k.adet??'-')+'</td><td class="num">'+(k.birim_fiyat??'-')+'</td><td class="num">'+(k.satir_toplam??'-')+'</td></tr>';});
    h+='</table>';
  }
  h+='<div class="sub" style="margin-top:10px">✅ Yüklendi. Merkez onayına düştü — fiyatlar onaysız hiçbir yere yazılmaz.</div>';
  $('sonucKutu').innerHTML=h;
}
$('btnYeni').onclick=()=>{blob=null;temizHata();$('sonucKutu').innerHTML='';$('durumKutu').innerHTML='<span class="spin"></span><span id="durumYazi">OCR bekleniyor…</span>';goster('adimKamera');};
</script></body></html>"""


@router.get("/qr")
def fatura_qr(sube_id: str, siparis_talep_id: Optional[str] = None):
    """Panel PC'de çalışıyor → fatura TELEFON kamerasıyla çekilmeli. Bu QR'ı PC'de
    gösterir; personel telefonuyla okutunca /cek sayfası TELEFONDA açılır (telefon
    kamerası). Mutlak URL gerekir (telefon erişebilsin) → APP_URL env."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    try:
        import qrcode
    except ImportError:
        raise HTTPException(500, "qrcode kütüphanesi yok")
    base = os.getenv("APP_URL", "https://evvel-erp-production.up.railway.app").rstrip("/")
    url = f"{base}/api/fatura/cek?sube_id={sube_id}"
    if siparis_talep_id:
        url += f"&siparis_talep_id={siparis_talep_id}"
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=3)
    qr.add_data(url)
    qr.make(fit=True)
    # PIL ile çiz (gorev_api QR deseni — production'da PIL var, PyPNG yok)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@router.get("/cek", response_class=HTMLResponse)
def fatura_cek_sayfasi():
    """Personel telefonu için CANLI KAMERA fatura çekme sayfası (galeri yok).
    Şube paneli ?sube_id=...&siparis_talep_id=... ile açar. İzole, kendi içinde yeterli."""
    if not fatura_modul_aktif():
        return HTMLResponse("<h3 style='font-family:sans-serif'>Fatura modülü kapalı.</h3>", status_code=503)
    return HTMLResponse(_CEK_HTML)


@router.get("/{fatura_id}")
def fatura_detay(fatura_id: str):
    """Tek fatura: başlık + OCR kalemleri (öneri-only)."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT id, sube_id, siparis_talep_id, tedarikci_ad, fatura_tarih,
                   toplam_tutar, durum, ocr_hata, olusturma
            FROM tedarikci_fatura WHERE id=%s
            """,
            (fatura_id,),
        )
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Fatura bulunamadı")
        h = dict(h)
        cur.execute(
            """
            SELECT id, sira, ocr_ad, ocr_urun_kodu, adet, birim, birim_fiyat, satir_toplam,
                   eslesen_stok_kodu, eslesme_guven
            FROM tedarikci_fatura_kalem WHERE fatura_id=%s ORDER BY sira
            """,
            (fatura_id,),
        )
        kalemler = [dict(r) for r in (cur.fetchall() or [])]
        # ── KÖPRÜ: eşleşen kalemler için son bilinen fiyat + değişim (zam) ──
        for k in kalemler:
            kod = k.get("eslesen_stok_kodu")
            son = _son_alis_fiyat(cur, kod) if kod else None
            if son:
                k["onceki_fiyat"] = float(son.get("birim_maliyet_tl") or 0)
                k["onceki_tarih"] = son.get("tarih")
                yeni = k.get("birim_fiyat")
                if yeni is not None and k["onceki_fiyat"]:
                    k["fiyat_degisim"] = round(float(yeni) - k["onceki_fiyat"], 4)
                    k["fiyat_degisim_yuzde"] = round(
                        (float(yeni) - k["onceki_fiyat"]) / k["onceki_fiyat"] * 100, 1
                    )
            else:
                k["onceki_fiyat"] = None
                k["onceki_tarih"] = None
    h["fatura_tarih"] = str(h.get("fatura_tarih") or "")
    h["olusturma"] = str(h.get("olusturma") or "")
    return {"fatura": h, "kalemler": kalemler}


class FaturaKalemOnayBody(BaseModel):
    kalem_kodu: str               # eşleştirilen STOK kalemi (insan seçer)
    kalem_adi: Optional[str] = None
    birim: str = "adet"
    birim_maliyet_tl: float
    tedarikci: Optional[str] = None
    gecerli_baslangic: Optional[str] = None


@router.post("/kalem/{kalem_id}/onayla")
def fatura_kalem_onayla(kalem_id: str, body: FaturaKalemOnayBody):
    """Foto faturasının bir kalemini bir STOK kalemiyle eşleştirip ONAYLAR.

    PDF onayıyla BİREBİR AYNI paylaşımlı servisi kullanır → TEK BEYİN:
      - `_kaydet_alis_fiyati`  → urun_alis_fiyat (fiyat geçmişi) + canlı maliyet
      - `fatura_kalem_eslestirme` upsert → alias ÖĞREN (sonraki PDF/foto otomatik eşleşir)
    Öneri-only ilkesi: gerçeği yazan İNSAN ONAYLI bu adımdır; OCR sadece önerdi.
    """
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    kalem = (body.kalem_kodu or "").strip()
    if not kalem:
        raise HTTPException(400, "kalem_kodu zorunlu")
    if body.birim_maliyet_tl < 0:
        raise HTTPException(400, "birim_maliyet_tl negatif olamaz")
    # Mevcut paylaşımlı servis (PDF ile AYNI kod) — lazy import (yük sırası güvenli)
    from operasyon_merkez_api import (
        _kaydet_alis_fiyati, _fatura_anahtar, _ensure_maliyet_tablolari,
    )
    bas = body.gecerli_baslangic or str(date.today())
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        _ensure_maliyet_tablolari(cur)
        cur.execute(
            "SELECT ocr_ad, ocr_urun_kodu FROM tedarikci_fatura_kalem WHERE id=%s",
            (kalem_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Kalem bulunamadı")
        r = dict(r)
        ocr_ad = r.get("ocr_ad") or ""
        anahtar = _fatura_anahtar({"urun_kodu": r.get("ocr_urun_kodu"), "aciklama": ocr_ad})
        # 1) Fiyatı kaydet (PDF ile aynı servis) → urun_alis_fiyat + canlı maliyet
        fiyat_id = _kaydet_alis_fiyati(
            cur, kalem, body.kalem_adi, body.birim, body.birim_maliyet_tl, bas,
            body.tedarikci, f"Foto fatura onaylandı: {ocr_ad}",
        )
        # 2) Alias öğren (PDF ile aynı upsert)
        if anahtar:
            cur.execute(
                """
                INSERT INTO fatura_kalem_eslestirme (anahtar, kalem_kodu, kalem_adi, adet, guncelleme)
                VALUES (%s, %s, %s, 1, NOW())
                ON CONFLICT (anahtar) DO UPDATE
                    SET kalem_kodu = EXCLUDED.kalem_kodu,
                        kalem_adi  = EXCLUDED.kalem_adi,
                        adet       = fatura_kalem_eslestirme.adet + 1,
                        guncelleme = NOW()
                """,
                (anahtar, kalem, body.kalem_adi or kalem),
            )
        # 3) Bu satırı eşleşmiş işaretle
        cur.execute(
            "UPDATE tedarikci_fatura_kalem SET eslesen_stok_kodu=%s, eslesme_guven=1.0 WHERE id=%s",
            (kalem, kalem_id),
        )
        conn.commit()
    return {"success": True, "fiyat_id": fiyat_id, "kalem_kodu": kalem, "anahtar": anahtar}
