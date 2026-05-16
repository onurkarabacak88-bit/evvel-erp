import requests, re

r = requests.get('https://web.evobulut.com/js/fatura.js', timeout=15)
txt = r.text
print('Boyut:', len(txt))

ashx = re.findall(r"'([^']*\.ashx[^']*)'", txt)
ashx += re.findall(r'"([^"]*\.ashx[^"]*)"', txt)
print('ASHX refs:', list(set(ashx))[:30])

komutlar = re.findall(r"komut[^:]*:\s*['\"]([^'\"]+)['\"]", txt)
print('Komutlar:', list(set(komutlar))[:20])

# Veri_Yukle cagrilari
yukle = re.findall(r'Veri_Yukle.{0,300}', txt)
for v in yukle[:5]:
    print('Veri_Yukle:', v[:200])
