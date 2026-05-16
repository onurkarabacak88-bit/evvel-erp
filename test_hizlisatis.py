import requests, json, os
from dotenv import load_dotenv
load_dotenv()

EVO_USER = os.environ.get("EVO_KULLANICI", "tulipicoffee@gmail.com")
EVO_PASS = os.environ.get("EVO_SIFRE", "Onur040488.")

# Token al
r = requests.post("https://ws.evobulut.com/api/index/base/",
    json={"cmd":"euas","p1":EVO_USER,"p2":EVO_PASS,"app":"evvel-erp"}, timeout=15)
data = r.json()
token = data["veri"]["Ana"][0]["UID"]
print(f"Token: {token[:20]}...")

# hizlisatis modülünde komutları dene
for cmd in ["jq_list","listele","satis_listesi","get","getir","rapor","urun_satis","detay_list"]:
    try:
        resp = requests.post("https://ws.evobulut.com/api/hizlisatis/base/",
            json={"cmd":cmd,"UID":token,"p1":"01.05.2026","p2":"15.05.2026"}, timeout=10)
        print(f"{cmd}: HTTP{resp.status_code} | {resp.text[:120]}")
    except Exception as e:
        print(f"{cmd}: HATA {e}")
