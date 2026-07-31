# -*- coding: utf-8 -*-
"""Denetimi YENİDEN çalıştır — 131 eksik gerçekten kapandı mı?

Yöntem ilk turdakiyle AYNI olmalı ki sayılar karşılaştırılabilsin:
"işlev" = YAZMA işlemi (POST/PUT/DELETE/PATCH). Klasik ekranların mutasyon
kümesi çıkarılır, v2'nin TAMAMINA karşı farkı alınır (dosya eşlemesi yapılmaz —
uç başka modülde olabilir).
"""
import io, os, re, sys, glob
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

KAPSAM_DISI = {
    'GorevPersonelSayfasi.jsx', 'GorevGiris.jsx', 'StokSayim.jsx',
    'EvTasarim.jsx', 'CepApp.jsx',
}

def yol_normalize(p):
    """Şablon değişkenlerini ve sorgu dizesini sil → karşılaştırılabilir iskelet."""
    p = re.sub(r'\$\{[^}]*\}', '{}', p)
    p = p.split('?')[0].rstrip('/')
    p = re.sub(r'^/api', '', p)
    # sayısal/uuid parçaları da {} yap
    p = re.sub(r'/[0-9a-f]{8}-[0-9a-f-]{20,}', '/{}', p)
    p = re.sub(r'/\d+(?=/|$)', '/{}', p)
    return p

# api('/yol', { method: 'POST' ... })  ya da  fetch('/yol', { method: ... })
DESEN = re.compile(
    r"""(?:api|fetch)\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*\{[^{}]*?method\s*:\s*['"](\w+)['"]""",
    re.S,
)

def cikar(dosyalar):
    kume = {}
    for f in dosyalar:
        try:
            s = io.open(f, encoding='utf-8').read()
        except Exception:
            continue
        for yol, m in DESEN.findall(s):
            m = m.upper()
            if m == 'GET':
                continue
            k = f"{m} {yol_normalize(yol)}"
            kume.setdefault(k, set()).add(os.path.basename(f))
    return kume

klasik_dosya = [f for f in glob.glob('src/pages/*.jsx')
                if os.path.basename(f) not in KAPSAM_DISI]
v2_dosya = glob.glob('src/pages/v2/*.jsx') + glob.glob('src/pages/v2/*.js') \
           + glob.glob('src/components/**/*.jsx', recursive=True)

klasik = cikar(klasik_dosya)
v2 = cikar(v2_dosya)

eksik = {k: v for k, v in klasik.items() if k not in v2}

print("=" * 62)
print(f"KLASİK yazma işlemi (benzersiz)      : {len(klasik)}")
print(f"v2 yazma işlemi (benzersiz)          : {len(v2)}")
print(f"KLASİKTE OLUP v2'DE OLMAYAN          : {len(eksik)}")
print("=" * 62)

if eksik:
    # ekran bazında grupla
    ekran = {}
    for k, dosyalar in sorted(eksik.items()):
        for d in dosyalar:
            ekran.setdefault(d, []).append(k)
    print("\n--- EKRAN EKRAN KALAN EKSİKLER ---")
    for d, uclar in sorted(ekran.items(), key=lambda x: -len(x[1])):
        print(f"\n### {d}  ({len(uclar)})")
        for u in uclar:
            print(f"    {u}")
else:
    print("\n✓ Klasikteki her yazma işleminin v2'de karşılığı var.")
