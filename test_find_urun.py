import requests, re

# evobulut'taki tum olasi JS dosyalarini tara
dosyalar = [
    '/js/dashboard.js', '/js/genel.js', '/js/fatura.js', '/js/fatura_part01.js',
    '/js/franchise.js', '/js/stok.js', '/js/rapor.js', '/js/satis.js',
    '/ajax/dashboard.html', '/ajax/rapor.html', '/ajax/stok.html',
]

EVO = 'https://web.evobulut.com'

for d in dosyalar:
    try:
        r = requests.get(EVO + d, timeout=8)
        if r.status_code != 200:
            continue
        txt = r.text
        if 'urun_satis' in txt.lower() or 'urun_satis_getir' in txt.lower():
            print(f"\n=== {d} ({len(txt)} bytes) BULUNDU ===")
            for line in txt.split('\n'):
                if 'urun_satis' in line.lower():
                    print(f"  >> {line.strip()[:200]}")
        else:
            # Satılan ürünler ile ilgili herhangi bir sey
            satis_refs = re.findall(r"['\"]([^'\"]*satis[^'\"]*getir[^'\"]*)['\"]", txt, re.I)
            if satis_refs:
                print(f"{d}: {satis_refs[:5]}")
    except Exception as e:
        pass

# Ayrica genel.js icinde tum ashx komutlarini listele
print("\n\n=== genel.js icindeki Dashboard.ashx komutlari ===")
r = requests.get(EVO + '/js/genel.js', timeout=10)
komutlar = re.findall(r"komut['\"\s:=]+['\"]([^'\"]+)['\"]", r.text)
dashkomut = [k for k in komutlar if 'satis' in k.lower() or 'urun' in k.lower() or 'getir' in k.lower()]
print(dashkomut)
