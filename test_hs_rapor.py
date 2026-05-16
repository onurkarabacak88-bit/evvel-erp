import requests, re

EVO = 'https://web.evobulut.com'
r = requests.get(f'{EVO}/hizli/hs_rapor.html', timeout=10)
print('hs_rapor.html:', r.status_code, len(r.text))

html = r.text

# Script dosyalarini bul
scripts = re.findall(r"src=[\"'](.*?\.js[^\"']*)[\"']", html)
print('Scripts:', scripts)

# Inline scriptleri tara
inline = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL | re.I)
print(f'{len(inline)} inline script')

for i, s in enumerate(inline):
    komutlar = re.findall(r"komut['\"\s:=]+['\"]([^'\"]+)['\"]", s)
    ashx = re.findall(r"ashx[^\"'<]{0,100}", s)
    if komutlar or ashx:
        print(f'\n--- Inline script {i} ---')
        print('Komutlar:', komutlar)
        print('Ashx:', ashx[:5])
        print(s[:1000])

# Harici script dosyalarini da oku
for src in scripts:
    if src.startswith('..') or src.startswith('/') or 'evobulut' in src:
        url = EVO + '/' + src.lstrip('../').lstrip('/')
        try:
            rj = requests.get(url, timeout=10)
            txt = rj.text
            komutlar = re.findall(r"komut['\"\s:=]+['\"]([^'\"]+)['\"]", txt)
            ashx = re.findall(r"['\"]([^'\"]*ashx[^'\"]*)['\"]", txt)
            if komutlar or ashx:
                print(f'\n=== {src} ===')
                print('Komutlar:', list(set(komutlar))[:20])
                print('Ashx refs:', list(set(ashx))[:10])
        except Exception as e:
            print(f'{src}: {e}')
