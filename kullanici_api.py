# -*- coding: utf-8 -*-
"""👤 KULLANICILAR — kişiye özel giriş + hangi ekranı göreceği.

🔴 NEDEN (sahip 2026-09-08): "tanımlarla tek tek açılmasına ve şifresiyle
girmesine izin vereceğiz! yetki tanımı ekranda görünmesi vs"

Bugüne kadar yönetim paneline giriş TEK ortak şifreyle yapılıyordu. İki sonucu
vardı: (1) giren herkes her ekranı görüyordu, (2) denetim defterinde herkes
"yönetim (oturum)" görünüyordu — "bu bordroyu kim onayladı" sorusunun cevabı
yoktu.

── DÜRÜST SINIR (ekranda da aynen yazar) ───────────────────────────────────
`gorunumler` bir **GÖRÜNÜRLÜK** ayarıdır, **erişim güvenliği DEĞİLDİR.**
API uçlarının çoğu hâlâ auth'suz (bkz. güvenlik backlog'u); adresi bilen
tarayıcıya yazıp veriye ulaşabilir. Bu özelliği "yetki" diye sunmak sahibe
olmayan bir güvence satmak olurdu. Kazandığımız iki gerçek şey var:
  · ekran sadeleşir — kimse işine yaramayan 60 görünümde kaybolmaz
  · denetim defteri İLK KEZ gerçek isim yazar

── DOKUNULMAYANLAR ─────────────────────────────────────────────────────────
· `personel.panel_pin_*` — baristanın ŞUBE PANELİ kimliği. Sahip 2026-09-08:
  "pini olan personel serbest". Bu iş onu hiç ilgilendirmez.
· `ADMIN_SIFRE` — ortak şifre ÇALIŞMAYA DEVAM EDER (geçiş güvenliği: kimse
  kapıda kalmasın). Onunla girenin kimliği yoktur ve defterde öyle görünür.
"""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["kullanici"])

# ⚠️ TEK ÇEKİRDEK: şifre özeti personel PIN'iyle AYNI yöntemle üretilir
# (`personel_panel_auth.panel_pin_hash`). İkinci bir yöntem icat etmek, gün
# gelir biri düzelir öteki kalır — güvenlikte bu sessiz bir çatlaktır.
try:
    from personel_panel_auth import panel_pin_hash as _ozet
except Exception:  # noqa: BLE001 — modül taşınırsa sistem durmasın
    def _ozet(sifre: str, salt: str) -> str:
        return hashlib.sha256(f"{salt}:{sifre}".encode()).hexdigest()

TUM = "*"          # gorunumler=["*"] → her ekranı görür
MIN_SIFRE = 4


def _satir(r: Dict[str, Any]) -> Dict[str, Any]:
    """Dışarı çıkan kayıt — ŞİFRE ÖZETİ ve TUZU ASLA DÖNMEZ."""
    g = r.get("gorunumler")
    if isinstance(g, str):
        try:
            g = json.loads(g)
        except ValueError:
            g = []
    return {"id": r["id"], "ad": r.get("ad"), "kullanici_adi": r.get("kullanici_adi"),
            "rol": r.get("rol"), "gorunumler": g or [],
            "hepsi": TUM in (g or []),
            "personel_id": r.get("personel_id"), "aktif": bool(r.get("aktif")),
            "son_giris": r.get("son_giris"), "olusturma": r.get("olusturma")}


class KullaniciModel(BaseModel):
    ad: str
    kullanici_adi: str
    sifre: Optional[str] = None          # yeni kayıtta ZORUNLU, güncellemede opsiyonel
    rol: Optional[str] = None
    gorunumler: List[str] = []
    personel_id: Optional[str] = None
    aktif: bool = True


@router.get("/kullanici")
def kullanicilar():
    """Tanımlı kullanıcılar. Şifre bilgisi DÖNMEZ."""
    with db() as (_, cur):
        cur.execute("SELECT * FROM kullanici ORDER BY aktif DESC, ad")
        satirlar = [_satir(dict(r)) for r in (cur.fetchall() or [])]
    return {"adet": len(satirlar), "kullanicilar": satirlar,
            "not": ("Bu liste EKRAN GÖRÜNÜRLÜĞÜNÜ düzenler, veriye erişimi "
                    "KISITLAMAZ — API uçları hâlâ açıktır.")}


@router.post("/kullanici")
def kullanici_yaz(m: KullaniciModel, id: Optional[str] = Query(None)):
    """Kullanıcı ekle (id yok) ya da güncelle (id var).

    ⚠️ Güncellemede `sifre` boş bırakılırsa ESKİ ŞİFRE KORUNUR — boş string
    gönderip şifreyi sessizce silmek, kişiyi kapıda bırakırdı.
    """
    ad = (m.ad or "").strip()
    kadi = (m.kullanici_adi or "").strip()
    if not ad or not kadi:
        raise HTTPException(400, "ad ve kullanici_adi zorunlu")
    if m.sifre is not None and m.sifre != "" and len(m.sifre) < MIN_SIFRE:
        raise HTTPException(400, "sifre en az %d karakter olmali" % MIN_SIFRE)
    if not id and not m.sifre:
        raise HTTPException(400, "yeni kullanicida sifre zorunlu")
    gor = [str(x) for x in (m.gorunumler or [])]

    with db() as (conn, cur):
        # Giriş adı benzersiz olmalı — aynı adla iki kişi olursa denetim
        # defteri hangisinin yaptığını söyleyemez.
        cur.execute("SELECT id FROM kullanici WHERE LOWER(kullanici_adi)=LOWER(%s)"
                    + (" AND id<>%s" if id else ""),
                    ((kadi, id) if id else (kadi,)))
        if cur.fetchone():
            raise HTTPException(400, "bu giris adi zaten kullaniliyor: %s" % kadi)

        if id:
            cur.execute("SELECT id FROM kullanici WHERE id=%s", (str(id),))
            if not cur.fetchone():
                raise HTTPException(404, "kullanici bulunamadi")
            if m.sifre:
                salt = secrets.token_hex(16)
                cur.execute(
                    "UPDATE kullanici SET ad=%s, kullanici_adi=%s, rol=%s, "
                    "  gorunumler=%s::jsonb, personel_id=%s, aktif=%s, "
                    "  sifre_salt=%s, sifre_hash=%s WHERE id=%s",
                    (ad, kadi, m.rol, json.dumps(gor, ensure_ascii=False),
                     m.personel_id, m.aktif, salt, _ozet(m.sifre, salt), str(id)))
            else:
                cur.execute(
                    "UPDATE kullanici SET ad=%s, kullanici_adi=%s, rol=%s, "
                    "  gorunumler=%s::jsonb, personel_id=%s, aktif=%s WHERE id=%s",
                    (ad, kadi, m.rol, json.dumps(gor, ensure_ascii=False),
                     m.personel_id, m.aktif, str(id)))
            yeni_id = str(id)
        else:
            salt = secrets.token_hex(16)
            cur.execute(
                "INSERT INTO kullanici (ad, kullanici_adi, sifre_salt, sifre_hash, "
                "   rol, gorunumler, personel_id, aktif) "
                "VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s,%s) RETURNING id",
                (ad, kadi, salt, _ozet(m.sifre, salt), m.rol,
                 json.dumps(gor, ensure_ascii=False), m.personel_id, m.aktif))
            yeni_id = cur.fetchone()["id"]
        conn.commit()
    return {"ok": True, "id": yeni_id, "islem": "guncellendi" if id else "eklendi"}


@router.delete("/kullanici/{kid}")
def kullanici_kapat(kid: str):
    """Kullanıcıyı KAPAT — silmez, `aktif=false` yapar.

    Silmek, o kişinin geçmişte yaptığı işlerin izini de anlamsızlaştırırdı:
    denetim defterinde adı geçen bir kimlik ortadan kaybolmamalı.
    """
    with db() as (conn, cur):
        cur.execute("UPDATE kullanici SET aktif=FALSE WHERE id=%s RETURNING ad",
                    (str(kid),))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "kullanici bulunamadi")
        conn.commit()
    return {"ok": True, "ad": r.get("ad"), "durum": "kapatildi"}


class GirisModel(BaseModel):
    kullanici_adi: str
    sifre: str


@router.post("/kullanici-giris")
def kullanici_giris(m: GirisModel):
    """Kişiye özel giriş. Jeton KİMLİK TAŞIR.

    ⚠️ Hata mesajı hangi alanın yanlış olduğunu SÖYLEMEZ ("kullanıcı yok" mu
    "şifre yanlış" mı) — ayrıntı, var olan giriş adlarını sızdırır. Kullanıcı
    için tek eylem aynıdır: doğrusunu gir.
    """
    from admin_oturum import ADMIN_OTURUM_GUN, jeton_uret
    kadi = (m.kullanici_adi or "").strip()
    with db() as (conn, cur):
        cur.execute("SELECT * FROM kullanici WHERE LOWER(kullanici_adi)=LOWER(%s)",
                    (kadi,))
        k = cur.fetchone()
        if not k or not k.get("aktif"):
            raise HTTPException(401, "Giriş adı ya da şifre yanlış")
        if _ozet(m.sifre or "", k["sifre_salt"]) != k["sifre_hash"]:
            raise HTTPException(401, "Giriş adı ya da şifre yanlış")
        cur.execute("UPDATE kullanici SET son_giris=NOW() WHERE id=%s", (k["id"],))
        conn.commit()
        bilgi = _satir(dict(k))
    return {"ok": True, "jeton": jeton_uret(kullanici_id=str(k["id"])),
            "gecerlilik_gun": ADMIN_OTURUM_GUN, "kullanici": bilgi}


@router.get("/kullanici-ben")
def kullanici_ben(jeton: str = Query("")):
    """Bu jeton kime ait, hangi ekranları görebilir?

    Kimliksiz (ortak şifreyle üretilmiş) jetonda `kullanici` None döner ve
    `hepsi=True` olur — ortak şifreyle giren bugünkü gibi her şeyi görür.
    Bu bir ayrıcalık değil, GEÇİŞ davranışıdır: kimse kapıda kalmasın.
    """
    from admin_oturum import jeton_coz
    gecerli, kalan, kid = jeton_coz(jeton or "")
    if not gecerli:
        return {"gecerli": False, "kullanici": None, "hepsi": False, "gorunumler": []}
    if not kid:
        return {"gecerli": True, "kalan_gun": round(kalan / 86400, 1),
                "kullanici": None, "hepsi": True, "gorunumler": [TUM],
                "not": "ortak şifreyle girildi — kişi bilinmiyor"}
    with db() as (_, cur):
        cur.execute("SELECT * FROM kullanici WHERE id=%s", (str(kid),))
        k = cur.fetchone()
    if not k or not k.get("aktif"):
        # Kullanıcı kapatıldıysa jeton hâlâ imzalı ama kişi YOK — oturum düşer.
        return {"gecerli": False, "kullanici": None, "hepsi": False,
                "gorunumler": [], "not": "kullanıcı kapatılmış"}
    b = _satir(dict(k))
    return {"gecerli": True, "kalan_gun": round(kalan / 86400, 1),
            "kullanici": b, "hepsi": b["hepsi"], "gorunumler": b["gorunumler"]}
