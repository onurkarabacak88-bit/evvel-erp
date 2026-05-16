import requests, re

# dashboard.js icinde grafik_satis_getir fonksiyonunun tamamini bul
rj = requests.get('https://web.evobulut.com/js/dashboard.js', timeout=10)
txt = rj.text

# grafik_satis_getir fonksiyonunun detayini bul (response handling)
idx = txt.find('grafik_satis_getir')
if idx >= 0:
    # Fonksiyonun ilk 2000 karakterini goster
    chunk = txt[idx:idx+3000]
    print("grafik_satis_getir fonksiyonu:")
    print(chunk[:3000])

print("\n\n=== AYRICA: dashboard.js icindeki TUM komutlar ===")
komutlar = re.findall(r"komut:\s*['\"]([^'\"]+)['\"]", txt)
print(list(set(komutlar)))

print("\n=== urun ile ilgili her sey ===")
for line in txt.split('\n'):
    if 'urun' in line.lower():
        print(line.strip()[:200])
