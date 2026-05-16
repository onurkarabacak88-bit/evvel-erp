import requests, json, os
from dotenv import load_dotenv
load_dotenv()

EVO_USER = os.environ.get("EVO_KULLANICI", "tulipicoffee@gmail.com")
EVO_PASS = os.environ.get("EVO_SIFRE", "Onur040488.")

# REST API token al (web login yok, oturumu bozmaz)
r = requests.post("https://ws.evobulut.com/api/index/base/",
    json={"cmd":"euas","p1":EVO_USER,"p2":EVO_PASS,"app":"evvel-erp"}, timeout=15)
token = r.json()["veri"]["Ana"][0]["UID"]
print(f"Token: {token[:20]}...")

# hs_rapor.ashx cagir - web login OLMADAN, sadece token ile
url = f"https://web.evobulut.com/hizli/hs_rapor.ashx?evo_token={token}&evo_server=web.evobulut.com"
body = {
    "komut": "FORM_LOAD",
    "tarih1": "14.05.2026 00:00:00",
    "tarih2": "14.05.2026 23:59:59",
    "personel": "0",
    "sube": "0"
}

resp = requests.post(url, data=body, timeout=20,
    headers={"X-Requested-With": "XMLHttpRequest",
             "Referer": "https://web.evobulut.com/hizli/hs_rapor.html"})

print(f"Status: {resp.status_code}")
print(f"Response ({len(resp.text)} bytes):")
print(resp.text[:2000])

# JSON parse et
try:
    d = resp.json()
    print("\nJSON keys:", list(d.keys()) if isinstance(d, dict) else type(d))
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, list):
                print(f"  {k}: {len(v)} kayit, ilk: {v[0] if v else 'bos'}")
            else:
                print(f"  {k}: {str(v)[:100]}")
except Exception as e:
    print(f"JSON parse hatasi: {e}")
