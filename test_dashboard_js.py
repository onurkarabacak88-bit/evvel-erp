import requests, re

# Dashboard sayfasindaki JS dosyalarini bul
r = requests.get('https://web.evobulut.com/ajax/dashboard.html', timeout=10)
print('dashboard.html:', r.status_code, len(r.text))

scripts = re.findall(r"src=[\"'](.*?\.js[^\"']*)[\"']", r.text)
print('Scripts:', scripts[:15])

# Her JS dosyasinda Dashboard.ashx komutlarini ara
for s in scripts:
    if not s.startswith('http'):
        url = 'https://web.evobulut.com/' + s.lstrip('/')
    else:
        url = s
    try:
        rj = requests.get(url, timeout=10)
        txt = rj.text
        # Dashboard.ashx komutlarini bul
        komutlar = re.findall(r"komut['\"\s:]+['\"]([^'\"]+)['\"]", txt)
        ashx = re.findall(r"Dashboard\.ashx[^\"']*", txt)
        urun = re.findall(r"urun[^\"'\s]{0,50}", txt, re.I)
        if komutlar or ashx or urun:
            print(f"\n{s} ({len(txt)} bytes):")
            print(f"  komutlar: {list(set(komutlar))[:10]}")
            print(f"  ashx: {list(set(ashx))[:5]}")
            print(f"  urun refs: {list(set(urun))[:5]}")
    except Exception as e:
        print(f"  {s}: {e}")
