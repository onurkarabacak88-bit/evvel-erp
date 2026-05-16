import requests, json, os
from dotenv import load_dotenv
load_dotenv()

EVO_USER = os.environ.get("EVO_KULLANICI", "tulipicoffee@gmail.com")
EVO_PASS = os.environ.get("EVO_SIFRE", "Onur040488.")

r = requests.post("https://ws.evobulut.com/api/index/base/",
    json={"cmd":"euas","p1":EVO_USER,"p2":EVO_PASS,"app":"evvel-erp"}, timeout=15)
token = r.json()["veri"]["Ana"][0]["UID"]
print(f"Token OK")

# Stok hareket modüllerini dene
moduller = [
    ("stok_hareket","jq_list"),
    ("stok_hareket","listele"),
    ("StokHareket","jq_list"),
    ("stokhareket","jq_list"),
    ("stok","hareket_listele"),
    ("stok","stok_hareketleri"),
    ("gelirGider","jq_list"),
    ("fatura","jq_list"),
]

for modul, cmd in moduller:
    try:
        resp = requests.post(f"https://ws.evobulut.com/api/{modul}/base/",
            json={"cmd":cmd,"UID":token,
                  "a_tarih_bas":"14.05.2026","a_tarih_son":"15.05.2026",
                  "bastar":"14.05.2026","bittar":"15.05.2026"}, timeout=10)
        txt = resp.text[:150]
        # Kayit sayisi var mi?
        try:
            d = resp.json()
            ana = d.get("veri",{})
            if isinstance(ana,dict): ana = ana.get("Ana",[])
            print(f"{modul}/{cmd}: {len(ana)} kayit | {txt[:80]}")
        except:
            print(f"{modul}/{cmd}: {txt[:100]}")
    except Exception as e:
        print(f"{modul}/{cmd}: HATA {e}")
