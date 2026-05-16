import requests, re

EVO = 'https://web.evobulut.com'

# Ana script dosyasi
r = requests.get(f'{EVO}/hizli/js/script.js', timeout=10)
print(f'script.js: {r.status_code} {len(r.text)} bytes')
txt = r.text

# Tum ashx endpoint cagrilarini bul
ashx_refs = re.findall(r"['\"]([^'\"]*\.ashx[^'\"]*)['\"]", txt)
print('\nAshx refs:', list(set(ashx_refs))[:20])

# Tum komutlari bul
komutlar = re.findall(r"komut['\"\s:=]+['\"]([^'\"]+)['\"]", txt)
print('Komutlar:', list(set(komutlar))[:30])

# URL ile fetch/ajax cagrilarini bul
fetch_calls = re.findall(r"fetch\(['\"]([^'\"]+)['\"]", txt)
ajax_urls = re.findall(r"url['\"\s:=]+['\"]([^'\"]+)['\"]", txt)
print('Fetch:', fetch_calls[:10])
print('Ajax URLs:', list(set(ajax_urls))[:15])

# Ilk 3000 karakteri goster
print('\n--- script.js ilk 3000 karakter ---')
print(txt[:3000])
