import requests, re

r = requests.get('https://web.evobulut.com/ajax/dashboard.html', timeout=10)
html = r.text

# Inline scriptlerdeki Dashboard.ashx cagrilarini bul
scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL | re.I)
print(f"{len(scripts)} inline script bulundu")

for i, s in enumerate(scripts):
    if 'Dashboard' in s or 'urun' in s.lower() or 'satis' in s.lower() or 'ashx' in s.lower():
        komutlar = re.findall(r"komut['\"\s:=]+['\"]([^'\"]+)['\"]", s)
        ashx_calls = re.findall(r"ashx[^'\"]{0,80}", s)
        print(f"\n--- Script {i} ({len(s)} bytes) ---")
        print(f"Komutlar: {list(set(komutlar))[:15]}")
        print(f"Ashx: {list(set(ashx_calls))[:10]}")
        # urun ile ilgili satirlar
        for line in s.split('\n'):
            if 'urun' in line.lower() or 'satis_getir' in line.lower() or 'en_cok' in line.lower():
                print(f"  >> {line.strip()[:150]}")

# dashboard.js icinde de ara
rj = requests.get('https://web.evobulut.com/js/dashboard.js', timeout=10)
txt = rj.text
print(f"\n--- dashboard.js ---")
# satis_getir ile ilgili her satiri bul
for line in txt.split('\n'):
    if 'satis_getir' in line.lower() or 'urun_satis' in line.lower() or 'en_cok' in line.lower():
        print(f"  {line.strip()[:200]}")
