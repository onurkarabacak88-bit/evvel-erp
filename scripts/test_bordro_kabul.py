# -*- coding: utf-8 -*-
"""BORDRO KABUL TESTİ — elle doğrulanmış gerçekleri sistem üretebiliyor mu?

NEDEN VAR (sahip, 2026-09-06):
    "Deniz Kırlı'da yaşanan sapmaları bulgu olarak gördük ve bunu düzeltmek
     zorundayız. Aslında biz MANUEL olarak hesapladık ve Deniz'in bizden
     alması gereken bedeli kurguladık. Ama sistemi öyle bir kurmalıyız ki
     HATASIZ yapmalı."

Bu test, "sistem eskiden ne üretiyordu"yu değil **GERÇEĞİ** dondurur. Vakalar
banka ekstresi ve sahip beyanıyla BAĞIMSIZ doğrulanmıştır. Sistem bu rakamları
kendiliğinden üretemiyorsa test kırılır — ve kırılan sistemdir, test değil.

⚠️ Bu bir "golden master" DEĞİLDİR. Golden master mevcut davranışı dondurur;
   mevcut davranış YANLIŞTI (Deniz'de 1.166,67 ₺ eksik). Burada dondurulan şey
   ölçülmüş gerçektir.

KULLANIM
    python scripts/test_bordro_kabul.py                  # canlıya sorar
    python scripts/test_bordro_kabul.py --url http://localhost:8000
Çıkış kodu 0 = tüm vakalar geçti · 1 = en az bir vaka kırık.
Push öncesi kapı:  python scripts/kapi_kontrol.py && python scripts/test_bordro_kabul.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

VARSAYILAN_URL = "https://evvel-erp-production.up.railway.app"
DOSYA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kabul_bordro.json")

# Windows konsolu cp1254 — Türkçe ve çizgi karakterleri çökertiyor.
# errors="replace": test bir KAPIdır, kodlama yüzünden düşemez.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001 — eski Python / yönlendirilmiş çıktı
    pass


def _oku(url: str, yol: str):
    with urllib.request.urlopen(url.rstrip("/") + yol, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def _kisi_bul(veri: dict, ad: str):
    for r in (veri.get("personeller") or []):
        if (r.get("ad_soyad") or "") == ad:
            return r
    return None


def _tl(x) -> str:
    return f"{float(x or 0):,.2f}"


def main() -> int:
    url = VARSAYILAN_URL
    if "--url" in sys.argv:
        url = sys.argv[sys.argv.index("--url") + 1]

    with open(DOSYA, encoding="utf-8") as f:
        kabul = json.load(f)

    onbellek: dict = {}
    kirik = gecti = atlandi = 0

    print("=" * 78)
    print("BORDRO KABUL TESTİ — elle doğrulanmış gerçekler")
    print(f"hedef: {url}")
    print("=" * 78)

    for v in kabul["vakalar"]:
        ad, yil, ay = v["ad_soyad"], v["yil"], v["ay"]
        tol = float(v.get("tolerans") or 0.05)
        anahtar = (yil, ay)
        if anahtar not in onbellek:
            try:
                onbellek[anahtar] = _oku(url, f"/api/gorev/vardiya-takip?yil={yil}&ay={ay}")
            except Exception as e:  # noqa: BLE001
                print(f"\n⛔ {v['kod']}: uç okunamadı — {e}")
                kirik += 1
                continue
        r = _kisi_bul(onbellek[anahtar], ad)
        print(f"\n── {v['kod']} · {ad} · {yil}-{ay:02d} ──")
        if r is None:
            # Personel dönemden düşmüş olabilir (çıkış tarihi). Bu KIRIK değil,
            # ATLANDI: vaka artık ölçülemiyor, ama sessizce geçmiş de sayılmaz.
            print("   ⚠️  ATLANDI — bu dönemde personel bulunamadı (çıkış/aktiflik?)")
            atlandi += 1
            continue

        u = r.get("ucret_detay") or {}
        hatalar = []

        # 1) NET
        if "beklenen_net" in v:
            net = float(r.get("net_hakediş") or 0)
            fark = net - float(v["beklenen_net"])
            imza = "✅" if abs(fark) <= tol else "❌"
            print(f"   {imza} net      beklenen {_tl(v['beklenen_net'])} · sistem {_tl(net)} · fark {_tl(fark)}")
            if abs(fark) > tol:
                hatalar.append(f"net {_tl(fark)}")

        # 2) YEMEK (net verilmeyen vakalarda tek başına ölçülür)
        if "beklenen_yemek" in v:
            ye = float(u.get("yemek_ucret") or 0)
            fark = ye - float(v["beklenen_yemek"])
            imza = "✅" if abs(fark) <= tol else "❌"
            print(f"   {imza} yemek    beklenen {_tl(v['beklenen_yemek'])} · sistem {_tl(ye)} · fark {_tl(fark)}")
            if abs(fark) > tol:
                hatalar.append(f"yemek {_tl(fark)}")

        # 3) KALEM KALEM — hangi kalem sapmış, tek bakışta görünsün
        ALAN = {"TABAN": "kazanilan_taban", "FAZLA_MESAI": "fazla_mesai_ucret",
                "YEMEK": "yemek_ucret", "YOL": "yol_ucret"}
        for k in v.get("beklenen_kalemler") or []:
            alan = ALAN.get(k["tur"])
            if not alan or alan not in u:
                continue
            g = float(u.get(alan) or 0)
            fark = g - float(k["tutar"])
            imza = "✅" if abs(fark) <= tol else "❌"
            print(f"      {imza} {k['tur']:<13}beklenen {_tl(k['tutar']):>12} · sistem {_tl(g):>12}"
                  f" · fark {_tl(fark):>9}   {k.get('aciklama','')}")
            if abs(fark) > tol:
                hatalar.append(f"{k['tur']} {_tl(fark)}")

        # 4) ÖLÇÜM girdileri — rakam tutsa bile YANLIŞ SEBEPTEN tutuyor olabilir
        o = v.get("olcum") or {}
        for alan, kaynak in (("planli_gun", r.get("planli_gun")),
                             ("yemek_hakki_dogan_gun", r.get("yemek_ucret_gun")),
                             ("mola_ihlal_gun", r.get("yemek_ihlal_gun"))):
            if alan in o and kaynak is not None and int(o[alan]) != int(kaynak):
                print(f"      ⚠️  {alan}: beklenen {o[alan]} · sistem {kaynak}"
                      f"  (rakam tutsa bile GİRDİ farklı — sebep değişmiş olabilir)")
                hatalar.append(f"{alan} {o[alan]}≠{kaynak}")

        if hatalar:
            kirik += 1
            esk = v.get("sistemin_eski_hatasi") or {}
            if esk:
                print(f"   ↩ bilinen eski hata: {_tl(esk.get('uretilen'))} üretiyordu"
                      f" ({esk.get('sebep','')})")
            print(f"   ❌ KIRIK: {', '.join(hatalar)}")
        else:
            gecti += 1
            print("   ✅ GEÇTİ")

    print("\n" + "=" * 78)
    print(f"GEÇTİ {gecti} · KIRIK {kirik} · ATLANDI {atlandi}")
    if kirik:
        print("⛔ Sistem elle doğrulanmış gerçeği üretemiyor. Push ETMEYİN.")
    elif atlandi:
        print("⚠️  Bazı vakalar ölçülemedi — kapı AÇIK ama kapsam eksik.")
    else:
        print("✅ Tüm kabul vakaları geçti.")
    print("=" * 78)
    return 1 if kirik else 0


if __name__ == "__main__":
    sys.exit(main())
