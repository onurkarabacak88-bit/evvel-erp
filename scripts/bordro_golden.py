# -*- coding: utf-8 -*-
"""BORDRO GOLDEN — V2 geçişinin ÇIPASI. Salt-okur, hiçbir şey yazmaz.

NEDEN VAR (MAAS_V2_PLAN.md · Adım 0):
    V2 motoru yazılırken her adımın "0 fark" iddiası bu dondurulmuş çıktıya
    karşı ölçülecek. Golden olmadan Adım 5-6 "sanırım aynı" ile geçer —
    bu projede canlı `ciro` tablosu tam böyle silindi
    ([[feedback-yikici-ucu-sinama]]).

⚠️ Bu bir KABUL TESTİ DEĞİLDİR. Kabul testi (`test_bordro_kabul.py`) GERÇEĞİ
   dondurur — banka + sahip defteriyle doğrulanmış rakamları. Golden ise
   BUGÜNKÜ DAVRANIŞI dondurur; doğru olduğu iddia edilmez, yalnız "V2 aynısını
   üretiyor mu" sorusunu cevaplar. İkisi birlikte kullanılır.

KULLANIM
    python scripts/bordro_golden.py                    # dondur + ölç
    python scripts/bordro_golden.py --karsilastir      # kayıtlı golden ile canlıyı kıyasla
    python scripts/bordro_golden.py --url http://localhost:8000
Çıktı: scripts/golden/golden_YYYY-MM.json  +  scripts/golden/olcum.json
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from collections import Counter

VARSAYILAN_URL = "https://evvel-erp-production.up.railway.app"
KLASOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden")
DONEMLER = [(2026, 6), (2026, 7), (2026, 8), (2026, 9)]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def oku(url: str, yol: str):
    with urllib.request.urlopen(url.rstrip("/") + yol, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


def liste(d, *adaylar):
    """Uçlar bazen düz liste, bazen {'anahtar': [...]} döner — ikisini de karşıla."""
    if isinstance(d, list):
        return d
    for a in adaylar:
        v = (d or {}).get(a)
        if isinstance(v, list):
            return v
    return []


def tl(x) -> str:
    return f"{float(x or 0):,.2f}"


# ── DONDURMA ────────────────────────────────────────────────────────────────
def dondur(url: str) -> dict:
    os.makedirs(KLASOR, exist_ok=True)
    ozet = {}
    print("=" * 78)
    print("GOLDEN DONDURMA")
    print("=" * 78)
    for yil, ay in DONEMLER:
        vt = oku(url, f"/api/gorev/vardiya-takip?yil={yil}&ay={ay}")
        pa = oku(url, f"/api/personel-aylik?yil={yil}&ay={ay}")
        kayit = {"yil": yil, "ay": ay, "vardiya_takip": vt, "personel_aylik": pa}
        yol = os.path.join(KLASOR, f"golden_{yil}-{ay:02d}.json")
        with open(yol, "w", encoding="utf-8") as f:
            json.dump(kayit, f, ensure_ascii=False, indent=1)
        L = liste(pa, "personeller", "kayitlar")
        top = sum(float(x.get("hesaplanan_net") or 0) for x in L)
        ozet[f"{yil}-{ay:02d}"] = {"kisi": len(L), "toplam_net": round(top, 2)}
        print(f"   {yil}-{ay:02d}  {len(L):>3} kişi  Σ net {tl(top):>14}   → {os.path.basename(yol)}")
    return ozet


# ── ÜÇ ÖLÇÜM (planın Adım 0 bilinmeyenleri) ─────────────────────────────────
def olc(url: str) -> dict:
    out = {}
    print()
    print("=" * 78)
    print("ÖLÇÜM 1 — İZİN KAYITLARI (ücretsiz izin bordroya HİÇ yansımıyor)")
    print("=" * 78)
    iz = liste(oku(url, "/api/vardiya/v2/izin?baslangic=2026-05-01&bitis=2026-12-31"), "izinler")
    say = Counter((x.get("tip") or "?") for x in iz)
    for t in ("ucretsiz", "rapor", "yillik", "mazeret"):
        satirlar = [x for x in iz if (x.get("tip") or "") == t]
        gun = 0
        for x in satirlar:
            try:
                b = x["baslangic_tarih"][:10]; s = x["bitis_tarih"][:10]
                from datetime import date
                gun += (date(*map(int, s.split("-"))) - date(*map(int, b.split("-")))).days + 1
            except Exception:  # noqa: BLE001
                pass
        im = "🔴" if (t == "ucretsiz" and satirlar) else "  "
        print(f"   {im} {t:<10}{say.get(t,0):>3} kayıt · {gun:>3} gün")
        for x in satirlar[:6]:
            print(f"        {x.get('personel_ad','')} {x.get('personel_soyad','')} "
                  f"{x.get('baslangic_tarih','')[:10]}→{x.get('bitis_tarih','')[:10]}  {x.get('aciklama') or ''}")
    out["izin"] = dict(say)
    print(f"\n   → ücretsiz izin {say.get('ucretsiz',0)} kayıt: "
          f"{'BUGÜNE KADAR FAZLA ÖDEME VAR' if say.get('ucretsiz') else 'sorun yok, kural yine de kurulmalı'}")

    print()
    print("=" * 78)
    print("ÖLÇÜM 2 — AYLIK_SABIT ADAYLARI (vardiya tanımlanamayan / yönetici)")
    print("=" * 78)
    P = liste(oku(url, "/api/personel"), "personel")
    aday = []
    for p in P:
        if not p.get("aktif"):
            continue
        g = (p.get("gorev") or "").upper()
        if "MÜDÜR" in g or "MUDUR" in g or p.get("panel_yonetici"):
            aday.append(p)
            print(f"   ➤ {(p.get('ad_soyad') or '?')[:26]:<28}{g[:14]:<16}"
                  f"yönetici={bool(p.get('panel_yonetici'))}  maaş={tl(p.get('maas'))}")
    if not aday:
        print("   (aday yok)")
    out["aylik_sabit_aday"] = [p.get("ad_soyad") for p in aday]

    print()
    print("=" * 78)
    print("ÖLÇÜM 3 — MOLA KAYDI OLMAYAN GÜNLER (Eylül · yemek hakkı doğmayan)")
    print("=" * 78)
    vt = oku(url, "/api/gorev/vardiya-takip?yil=2026&ay=9")
    kayip = []
    print(f"   {'KİŞİ':<24}{'PLANLI':>7}{'HAK DOĞAN':>11}{'KAYIT YOK':>11}{'YEMEK ₺':>11}")
    for r in sorted(liste(vt, "personeller"), key=lambda x: -(x.get("planli_gun") or 0)):
        pg = r.get("planli_gun")
        if not pg:
            continue
        yg = r.get("yemek_ucret_gun") or 0
        eks = pg - yg
        u = r.get("ucret_detay") or {}
        print(f"   {(r.get('ad_soyad') or '?')[:23]:<24}{pg:>7}{yg:>11}{eks:>11}"
              f"{tl(u.get('yemek_ucret')):>11}")
        if eks > 0:
            kayip.append({"ad": r.get("ad_soyad"), "planli": pg, "hak_dogan": yg, "kayit_yok": eks})
    out["eylul_mola_kaydi_yok"] = kayip
    print(f"\n   → {len(kayip)} kişide hak doğmayan gün var")

    print()
    print("=" * 78)
    print("ÖLÇÜM 4 — personel_maliyet.py ÖLÜ MÜ?")
    print("=" * 78)
    kok = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    bulunan = []
    for dosya in os.listdir(kok):
        if not dosya.endswith(".py") or dosya == "personel_maliyet.py":
            continue
        try:
            with open(os.path.join(kok, dosya), encoding="utf-8") as f:
                icerik = f.read()
        except Exception:  # noqa: BLE001
            continue
        if "personel_maliyet" in icerik or "gunluk_personel_maliyeti" in icerik:
            bulunan.append(dosya)
    out["personel_maliyet_cagiran"] = bulunan
    print(f"   ana ağaçta çağıran: {bulunan if bulunan else '❌ YOK — modül ÖLÜ, V2 kapsamı dışı'}")
    return out


# ── KARŞILAŞTIRMA ───────────────────────────────────────────────────────────
def karsilastir(url: str) -> int:
    print("=" * 78)
    print("GOLDEN KARŞILAŞTIRMA — kayıtlı çıpa vs canlı")
    print("=" * 78)
    kirik = 0
    for yil, ay in DONEMLER:
        yol = os.path.join(KLASOR, f"golden_{yil}-{ay:02d}.json")
        if not os.path.exists(yol):
            print(f"   {yil}-{ay:02d}  ⚠️ golden yok — önce dondurun")
            continue
        with open(yol, encoding="utf-8") as f:
            eski = json.load(f)
        yeni = oku(url, f"/api/personel-aylik?yil={yil}&ay={ay}")
        e = {x.get("ad_soyad"): float(x.get("hesaplanan_net") or 0)
             for x in liste(eski["personel_aylik"], "personeller", "kayitlar")}
        y = {x.get("ad_soyad"): float(x.get("hesaplanan_net") or 0)
             for x in liste(yeni, "personeller", "kayitlar")}
        fark = [(k, e.get(k, 0), y.get(k, 0)) for k in set(e) | set(y)
                if abs(e.get(k, 0) - y.get(k, 0)) > 0.005]
        if fark:
            kirik += len(fark)
            print(f"   {yil}-{ay:02d}  ❌ {len(fark)} kişide fark:")
            for k, a, b in sorted(fark, key=lambda z: -abs(z[1] - z[2])):
                print(f"        {str(k)[:26]:<28}golden {tl(a):>12}  canlı {tl(b):>12}  fark {tl(b-a):>11}")
        else:
            print(f"   {yil}-{ay:02d}  ✅ {len(e)} kişi · 0,00 fark")
    print("=" * 78)
    print("✅ Golden korunuyor." if not kirik else f"❌ {kirik} sapma — İNCELEYİN.")
    return 1 if kirik else 0


def main() -> int:
    url = VARSAYILAN_URL
    if "--url" in sys.argv:
        url = sys.argv[sys.argv.index("--url") + 1]
    if "--karsilastir" in sys.argv:
        return karsilastir(url)
    ozet = dondur(url)
    olcum = olc(url)
    os.makedirs(KLASOR, exist_ok=True)
    with open(os.path.join(KLASOR, "olcum.json"), "w", encoding="utf-8") as f:
        json.dump({"donem_ozet": ozet, "olcum": olcum}, f, ensure_ascii=False, indent=1)
    print()
    print("=" * 78)
    print(f"Dondurulan: {len(DONEMLER)} dönem → {KLASOR}")
    print("Sonraki adımlarda:  python scripts/bordro_golden.py --karsilastir")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
