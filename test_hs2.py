import requests, re
r = requests.get('https://web.evobulut.com/hizli/js/script.js', timeout=10)
txt = r.text
idx = txt.find('hs_rapor.ashx')
while idx >= 0:
    print('=== konum', idx, '===')
    print(txt[max(0,idx-400):idx+600])
    print()
    idx = txt.find('hs_rapor.ashx', idx+1)
