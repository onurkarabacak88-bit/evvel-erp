import requests, json, os
from dotenv import load_dotenv
load_dotenv()

EVO_USER = os.environ.get("EVO_KULLANICI", "tulipicoffee@gmail.com")
EVO_PASS = os.environ.get("EVO_SIFRE", "Onur040488.")

r = requests.post("https://ws.evobulut.com/api/index/base/",
    json={"cmd":"euas","p1":EVO_USER,"p2":EVO_PASS,"app":"evvel-erp"}, timeout=15)
token = r.json()["veri"]["Ana"][0]["UID"]

url = f"https://web.evobulut.com/hizli/hs_rapor.ashx?evo_token={token}&evo_server=web.evobulut.com"
headers = {"X-Requested-With": "XMLHttpRequest", "Referer": "https://web.evobulut.com/hizli/hs_rapor.html"}

denemeler = [
    {"komut":"FORM_LOAD","tarih1":"15.05.2026 00:00:00","tarih2":"15.05.2026 23:59:59","personel":"0","sube":"0"},
    {"komut":"FORM_LOAD","tarih1":"01.05.2026 00:00:00","tarih2":"15.05.2026 23:59:59","personel":"0","sube":"0"},
    {"komut":"FORM_LOAD","tarih1":"01.05.2026 00:00:00","tarih2":"15.05.2026 23:59:59","personel":"","sube":""},
    {"komut":"FORM_LOAD","tarih1":"14.05.2026 00:00:00","tarih2":"15.05.2026 23:59:59","personel":"0","sube":"1"},
    {"komut":"FORM_LOAD","tarih1":"14.05.2026 00:00:00","tarih2":"15.05.2026 23:59:59"},
]

for i, body in enumerate(denemeler):
    resp = requests.post(url, data=body, headers=headers, timeout=20)
    try:
        d = resp.json()
        cok = d.get("Cok_Satilan", [])
        s = d.get("S", [])
        print(f"Deneme {i+1}: Cok_Satilan={len(cok)}, S={len(s)}, params={list(body.values())[:4]}")
        if cok:
            print(f"  >>> COK_SATILAN: {cok[:3]}")
        if s:
            print(f"  >>> S: {s[:2]}")
    except:
        print(f"Deneme {i+1}: {resp.text[:100]}")
