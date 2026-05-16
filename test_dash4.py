import requests, re

rj = requests.get('https://web.evobulut.com/js/dashboard.js', timeout=10)
txt = rj.text

# sube_filtre fonksiyonunu bul - grafik_satis_getir'in response handler'i
idx = txt.find('sube_filtre')
print("sube_filtre konumu:", idx)
if idx >= 0:
    # Fonksiyonun tamamini bul
    chunk = txt[max(0,idx-200):idx+2000]
    print(chunk)

print("\n\n=== dashboard.html icindeki urun_satis_getir ===")
r = requests.get('https://web.evobulut.com/ajax/dashboard.html', timeout=10)
html = r.text
idx2 = html.find('urun_satis')
print("urun_satis konum:", idx2)
if idx2 >= 0:
    print(html[max(0,idx2-300):idx2+500])

# En cok satilan urun aramasi
for term in ['en_cok', 'top_urun', 'urun_satis', 'best_sell', 'top sell', 'satilan']:
    idx3 = html.lower().find(term)
    if idx3 >= 0:
        print(f"\n'{term}' bulundu [{idx3}]:")
        print(html[max(0,idx3-100):idx3+300])
