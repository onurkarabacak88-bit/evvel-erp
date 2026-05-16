import requests, json, os
from dotenv import load_dotenv
load_dotenv()

EVO_USER = os.environ.get("EVO_KULLANICI", "tulipicoffee@gmail.com")
EVO_PASS = os.environ.get("EVO_SIFRE", "Onur040488.")

# REST token al
r = requests.post("https://ws.evobulut.com/api/index/base/",
    json={"cmd":"euas","p1":EVO_USER,"p2":EVO_PASS,"app":"evvel-erp"}, timeout=15)
token = r.json()["veri"]["Ana"][0]["UID"]
print(f"Token: {token[:20]}...")

EVO_WEB = "https://web.evobulut.com"
headers = {"X-Requested-With": "XMLHttpRequest", "Referer": f"{EVO_WEB}/ajax/dashboard.html"}

# Dashboard.ashx komutlarini dene
komutlar = [
    ("grafik_satis_getir", {"sube_id":"0","satis_tarih_bas":"14.05.2026","satis_tarih_bit":"14.05.2026"}),
    ("urun_satis_getir",   {"sube_id":"0","tarih_bas":"14.05.2026","tarih_bit":"14.05.2026"}),
    ("urun_satis_getir",   {"sube_id":"1","tarih_bas":"14.05.2026","tarih_bit":"14.05.2026"}),
    ("urun_satis_getir",   {"sube_id":"0","bas":"14.05.2026","son":"14.05.2026"}),
    ("urun_satis_getir",   {"tarih":"14.05.2026"}),
    ("urun_satis_getir",   {"sube_id":"0","tarih":"14.05.2026","bastar":"14.05.2026","bittar":"14.05.2026"}),
]

for komut, extra in komutlar:
    body = {"komut": komut, "evo_token": token, "token": token, **extra}
    resp = requests.post(f"{EVO_WEB}/ashx/Dashboard.ashx?evo_server=web.evobulut.com",
                         data=body, headers=headers, timeout=15)
    txt = resp.text[:300]
    print(f"\n{komut} {extra}:")
    print(txt)
