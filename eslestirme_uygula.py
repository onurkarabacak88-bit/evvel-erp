# -*- coding: utf-8 -*-
# Sahip onayi (2026-07-29 chat): 23 net eslesme onay + 9 yanlis oneri red +
# 'siyah cikolata bar sos'->'Cikolata Sos' + mocktail/karpuz eslesmesi YOK.
import json, urllib.request, unicodedata, re, os

BASE = "https://evvel-erp-production.up.railway.app/api/recete"
TMP = os.path.dirname(os.path.abspath(__file__))

def post(yol, veri):
    r = urllib.request.Request(BASE + yol, data=json.dumps(veri).encode("utf-8"),
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30) as f:
        return json.loads(f.read().decode("utf-8"))

esl = json.load(open(os.path.join(TMP, "..", "..", "esl.json") if False else "esl.json", encoding="utf-8"))["eslestirmeler"]
aday = json.load(open("aday.json", encoding="utf-8"))
evo = aday["evo_adlar"]

def norm(s):
    s = s.replace("İ", "i").replace("I", "ı").lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-zçğıöşü0-9 ]", " ", s)).strip()

evo_map = {norm(a): a for a in evo}

def evo_ad(aranan):
    k = norm(aranan)
    if k not in evo_map:
        raise SystemExit(f"EVO ADI BULUNAMADI: {aranan!r}")
    return evo_map[k]

# 1) ONAYLANACAK oneriler (birebir 1.0 + cikolata sos)
onay_ciftleri = [
    ("urun", "espresso", "Espresso"),
    ("urun", "dibek kahvesi", "Dibek Kahvesi"),
    ("urun", "white mocha 8 oz", "White Mocha 8 Oz"),
    ("malzeme", "siyah cikolata bar sos", "Çikolata Sos"),
]
# 2) REDDEDILECEK oneriler (yanlis urun karismalari + beyaz sos)
red_ciftleri = [
    ("urun", "mocha 8 oz", "White Mocha 8 Oz"),
    ("urun", "zebra mocha 8 oz", "White Mocha 8 Oz"),
    ("urun", "double espresso", "Espresso"),
    ("urun", "white mocha", "White Mocha 8 Oz"),
    ("urun", "americano 8 oz", "Americano 14 Oz"),
    ("urun", "americano 8 oz", "White Mocha 8 Oz"),
    ("urun", "ice white mocha", "White Mocha 8 Oz"),
    ("urun", "latte 8 oz", "Vanilla Latte 14 Oz"),
    ("urun", "latte 8 oz", "White Mocha 8 Oz"),
    ("malzeme", "siyah cikolata bar sos", "Beyaz Çikolata Sos"),
]
idx = {(r["tip"], r["kaynak_ad"], r["hedef_ad"]): r for r in esl if r["durum"] == "oneri"}

for tip, k, h in onay_ciftleri:
    r = idx.get((tip, k, h))
    if r:
        print("ONAY:", k, "->", h, post("/eslestirme-karar", {"id": r["id"], "karar": "onayli"}).get("ok"))
    else:
        print("ONAY oneri bulunamadi (elle eklenecek):", k, "->", h)
for tip, k, h in red_ciftleri:
    r = idx.get((tip, k, h))
    if r:
        print("RED :", k, "->", h, post("/eslestirme-karar", {"id": r["id"], "karar": "reddedildi"}).get("ok"))
    else:
        print("RED oneri bulunamadi (atlandi):", k, "->", h)

# 3) ELLE eklenen dogru eslesmeler (insan karari = dogrudan onayli)
elle = [
    ("Türk Kahvesi", "Türk Kahvesi"),
    ("Menengiç Kahvesi", "Menengiç Kahvesi"),
    ("Americano", "Americano 14 Oz"),
    ("Ice Americano", "Americano Ice"),
    ("Latte", "Latte 14 Oz"),
    ("Ice Latte", "Latte Ice"),
    ("Vanilya Latte", "Vanilla Latte 14 Oz"),
    ("Ice Vanilya Latte", "Vanilla Latte Ice"),
    ("White Mocha", "White Mocha 14 Oz"),
    ("Ice White Mocha", "White Mocha Ice"),
    ("Ice Mocha", "Mocha Ice"),
    ("Ice Zebra Mocha", "Zebra Mocha Ice"),
    ("Ice Caramel Macchiato", "Caramel Macchiato Ice"),
    ("Ice Berry Latte", "Berry Latte Ice"),
    ("Ice Dream Latte", "Dream Latte Ice"),
    ("Ice Toffee Nut Latte", "Toffee Nut Latte Ice"),
    ("Ice Salted Caramel Cappuccino", "Salted Caramel Cappucino Ice"),
    ("Ice Flat White", "Flat White Ice"),
    ("Sıcak Çikolata", "Sıcak Çikolata 14 Oz"),
    ("Çikolata Milkshake", "Çikolata Milkshake"),
]
for kaynak, hedef in elle:
    h = evo_ad(hedef)
    r = post("/eslestirme-ekle", {"tip": "urun", "kaynak_ad": kaynak, "hedef_ad": h})
    print("ELLE:", kaynak, "->", h, r.get("ok"))

print("BITTI")
