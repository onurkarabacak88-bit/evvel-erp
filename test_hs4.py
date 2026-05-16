import requests, re

# evo_oturum_veri fonksiyonunun tanimini bul
for url in [
    'https://web.evobulut.com/hizli/js/genel.js',
    'https://web.evobulut.com/js/genel.js',
]:
    r = requests.get(url, timeout=10)
    txt = r.text
    # function evo_oturum_veri tanimini bul
    idx = txt.find('function evo_oturum_veri')
    if idx >= 0:
        print(f'=== {url} ===')
        print(txt[idx:idx+400])
