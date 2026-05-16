import requests, re

# evo_oturum_veri fonksiyonunu bul
for url in [
    'https://web.evobulut.com/hizli/js/genel.js',
    'https://web.evobulut.com/js/genel.js',
    'https://web.evobulut.com/hizli/js/script.js',
]:
    r = requests.get(url, timeout=10)
    if r.status_code != 200:
        continue
    txt = r.text
    idx = txt.find('evo_oturum_veri')
    if idx >= 0:
        print(f'=== {url} ===')
        print(txt[max(0,idx-100):idx+500])
        print()
