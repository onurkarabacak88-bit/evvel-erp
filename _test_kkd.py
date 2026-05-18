import urllib.request, json, urllib.error
BASE = 'https://evvel-erp-production.up.railway.app/api/ops'

def hit(uid, sebep, payload):
    body = {'sebep': sebep, 'payload': payload, 'notu': 'test ' + sebep}
    req = urllib.request.Request(BASE + '/kasa-uyumsuzluk/' + uid + '/kaynak-duzelt',
        method='POST', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        rr = urllib.request.urlopen(req, timeout=30)
        return 'OK', json.loads(rr.read())
    except urllib.error.HTTPError as e:
        return 'HTTP ' + str(e.code), e.read().decode()[:600]
    except Exception as e:
        return 'ERR', str(e)

uyarilar = []
for tarih in ['2026-05-17', '2026-05-18', '2026-05-16', '2026-05-15']:
    try:
        r = urllib.request.urlopen(BASE + '/kasa-uyumsuzluk?tarih=' + tarih + '&sadece_bekleyen=true', timeout=20)
        d = json.loads(r.read())
        uyarilar += [u for u in d.get('liste', []) if not u.get('cozuldu')]
    except Exception:
        pass

print('Bekleyen uyari toplam:', len(uyarilar))
print()

TESTLER = [
    ('gercek_acik',   {}),
    ('ciro_yanlis',   {'yeni_nakit': 100.0}),
    ('acilis_yanlis', {'yeni_acilis_kasa': 500.0}),
    ('gider_eksik',   {'kategori': 'Test', 'tutar': 1.0, 'aciklama': 'API test'}),
    ('devir_yanlis',  {'yeni_teslim': 100.0, 'yeni_devir': 50.0}),
]

for i, (sebep, payload) in enumerate(TESTLER):
    if i >= len(uyarilar):
        print('SKIP', sebep, '(uyari yok)')
        continue
    u = uyarilar[i]
    status, sonuc = hit(u['id'], sebep, payload)
    print('[' + status + ']', 'sebep=' + sebep, 'uid=' + u['id'][:8], 'sube=' + u['sube_id'], 'fark=' + str(u['fark_tl']))
    if status != 'OK':
        print('   HATA:', sonuc)
    else:
        print('   yeni_fark=' + str(sonuc.get('yeni_fark')))
