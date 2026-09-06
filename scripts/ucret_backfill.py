# -*- coding: utf-8 -*-
"""ÜCRET TANIMI BACKFILL — personel kartındaki ücretleri ZAMAN ÇİZGİSİNE taşır.

NEDEN (MAAS_V2_PLAN.md · Adım 2, sahip 2026-09-06):
    "Asgari ücret alanı her yıl değiştiği için, şu anda 28.075 olarak girsek
     bile bu düzeltilebilir olmalı. Bir kere değiştiğinde HEPSİNE BİRDEN
     uygulanmalı; bazı personellerle asgari ücretin üstünde anlaşma yapılabilir."

Bugün ücret `personel.maas` kolonunda TEK DEĞER olarak duruyor. Asgari ücret
artınca 30 kartı elle güncellemek gerekiyor ve geçmiş aylar YENİ tutarla
hesaplanıyor. `ucret_tanim` bunu zaman çizgisine çevirir:
    mod='ASGARIYE_BAGLI' → o tarihte geçerli asgari + fark   (otomatik artar)
    mod='SABIT'          → sabit tutar                        (asgari artınca DEĞİŞMEZ)

⚠️ VARSAYILAN KURU. `--uygula` verilmeden HİÇBİR ŞEY yazılmaz.
   Kuru liste okunmadan uygulanmaz ([[feedback-kuru-calistirma-kapisi]]).

KULLANIM
    python scripts/ucret_backfill.py                      # kuru liste
    python scripts/ucret_backfill.py --asgari 28075       # asgari ücreti varsay
    python scripts/ucret_backfill.py --uygula             # (Adım 2b'de aktif olur)
"""
from __future__ import annotations

import json
import sys
import urllib.request
from collections import Counter, defaultdict

VARSAYILAN_URL = "https://evvel-erp-production.up.railway.app"
SISTEM_BASLANGIC = "2026-06-01"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def oku(url: str, yol: str):
    with urllib.request.urlopen(url.rstrip("/") + yol, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def tl(x) -> str:
    return f"{float(x or 0):,.2f}"


def main() -> int:
    url = VARSAYILAN_URL
    if "--url" in sys.argv:
        url = sys.argv[sys.argv.index("--url") + 1]
    asgari = None
    if "--asgari" in sys.argv:
        asgari = float(sys.argv[sys.argv.index("--asgari") + 1])
    uygula = "--uygula" in sys.argv

    d = oku(url, "/api/personel")
    P = d if isinstance(d, list) else (d.get("personel") or [])

    # ── Asgari ücret adayı: EN SIK GEÇEN sıfır olmayan maaş ──────────────────
    maaslar = Counter(round(float(p.get("maas") or 0), 2) for p in P
                      if float(p.get("maas") or 0) > 0)
    aday, adet = (maaslar.most_common(1)[0] if maaslar else (0, 0))
    if asgari is None:
        asgari = aday

    print("=" * 96)
    print("ÜCRET TANIMI — KURU LİSTE (hiçbir şey yazılmadı)")
    print("=" * 96)
    print(f"   Toplam personel kaydı: {len(P)}   ·   aktif: {sum(1 for p in P if p.get('aktif'))}")
    print()
    print("   MAAŞ DAĞILIMI (asgari ücret adayı = en sık geçen tutar):")
    for m, n in maaslar.most_common():
        im = "  ⬅ ASGARİ ADAYI" if m == aday else ""
        print(f"      {tl(m):>12}  ×{n:<3}{im}")
    sifir = sum(1 for p in P if float(p.get("maas") or 0) == 0)
    print(f"      {'0,00':>12}  ×{sifir:<3}  (saatlik çalışanlar + tanımsız)")
    print()
    print(f"   ➤ Varsayılan asgari: {tl(asgari)}   (--asgari ile değiştirin)")

    # ── Önerilen satırlar ────────────────────────────────────────────────────
    print()
    print("=" * 96)
    print("ÖNERİLEN ÜCRET TANIMI SATIRLARI")
    print("=" * 96)
    print(f"{'PERSONEL':<24}{'TÜR':<9}{'MOD':<16}{'TUTAR/FARK':>13}  GEÇERLİ BAŞ   not")
    print("-" * 96)
    satir = []
    bagli = sabit = 0
    for p in sorted(P, key=lambda x: (not x.get("aktif"), x.get("ad_soyad") or "")):
        ad = p.get("ad_soyad") or "?"
        bas = (p.get("baslangic_tarihi") or SISTEM_BASLANGIC)[:10]
        aktif_im = "" if p.get("aktif") else "  (pasif)"
        part = (p.get("calisma_turu") or "surekli") != "surekli"
        for tur, kolon in (("TABAN", "maas"), ("SAATLIK", "saatlik_ucret"),
                           ("YEMEK", "yemek_ucreti"), ("YOL", "yol_ucreti")):
            v = float(p.get(kolon) or 0)
            if v <= 0:
                continue
            if tur == "TABAN" and part:
                continue          # part-time'da taban yok, saatlik var
            if tur == "SAATLIK" and not part:
                continue
            if tur == "TABAN" and abs(v - asgari) < 0.01:
                mod, gosterim, not_ = "ASGARIYE_BAGLI", "fark 0,00", "asgari ücreti TAKİP EDER"
                bagli += 1
            elif tur == "TABAN":
                fark = v - asgari
                mod = "SABIT"
                gosterim = tl(v)
                not_ = f"asgari+{tl(fark)} → ASGARIYE_BAGLI yapılabilir" if fark > 0 else "asgari ALTINDA ⚠️"
                sabit += 1
            else:
                mod, gosterim, not_ = "SABIT", tl(v), ""
            satir.append({"personel_id": p.get("id"), "ad_soyad": ad, "tur": tur,
                          "mod": mod, "tutar": v, "gecerli_bas": bas})
            print(f"{ad[:23]:<24}{tur:<9}{mod:<16}{gosterim:>13}  {bas}   {not_}{aktif_im}")
    print("-" * 96)
    print(f"   {len(satir)} satır  ·  TABAN'da asgariye bağlı {bagli} · sabit {sabit}")

    # ── Sahip kararı ─────────────────────────────────────────────────────────
    print()
    print("=" * 96)
    print("SAHİP KARARI GEREKEN")
    print("=" * 96)
    print(f"   1) Asgari ücret {tl(asgari)} mi?  (2026 net asgari ücret bu mu)")
    print(f"   2) Aşağıdaki {bagli} kişi ASGARİYE BAĞLI mı — asgari artınca")
    print( "      maaşları da otomatik artsın mı?")
    for s in satir:
        if s["tur"] == "TABAN" and s["mod"] == "ASGARIYE_BAGLI":
            print(f"         · {s['ad_soyad']}")
    ustu = [s for s in satir if s["tur"] == "TABAN" and s["mod"] == "SABIT" and s["tutar"] > asgari]
    if ustu:
        print(f"   3) Asgari ÜSTÜ anlaşmalılar — asgari artınca ne olsun?")
        for s in ustu:
            print(f"         · {s['ad_soyad']:<24}{tl(s['tutar']):>12}  (asgari + {tl(s['tutar']-asgari)})")
        print("      (a) SABİT kalsın — asgari artsa da değişmesin")
        print("      (b) ASGARIYE_BAGLI olsun — fark korunarak birlikte artsın")

    if not uygula:
        print()
        print("=" * 96)
        print("KURU ÇALIŞTIRMA — hiçbir şey yazılmadı.")
        print("Sahip kararları alındıktan sonra --uygula ile yazılacak.")
        print("=" * 96)
    return 0


if __name__ == "__main__":
    sys.exit(main())
