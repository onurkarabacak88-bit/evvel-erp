"""Z Peçete / Baskılı Peçete — genel pecete_paket havuzuna birleştirmeyi kaldır."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "operasyon_stok_motor.py"
text = p.read_text(encoding="utf-8")

old1 = '''    if "pecete" in n or "peçete" in n:
        if n in ("z_pecete", "baskili_pecete"):
            return None
        if n.startswith("z ") or n.startswith("z pecete") or n.startswith("z peçete"):
            return None
        if "baskili" in n or "baskılı" in n:
            return None
        return "pecete_paket"
    return None'''
new1 = old1  # already patched
if old1 not in text:
    raise SystemExit("pecete block not found")
text = text.replace(old1, new1, 1)

old2 = '''def urun_ac_gorunen_ad(ad_or_key: Any) -> str:
    """Ürün aç listesinde delta (stok anahtarı) ile kalemler (katalog adı) tek etikette birleşir."""
    raw = str(ad_or_key or "").strip()
    if not raw:
        return ""
    key = raw if raw in STOK_KEYS else _stok_key_from_urun_ad(raw)'''
new2 = '''def urun_ac_gorunen_ad(ad_or_key: Any) -> str:
    """Ürün aç listesinde delta (stok anahtarı) ile kalemler (katalog adı) tek etikette birleşir."""
    raw = str(ad_or_key or "").strip()
    if not raw:
        return ""
    _KATALOG_OZEL = {
        "z_pecete": "Z Peçete",
        "baskili_pecete": "Baskılı Peçete",
    }
    if raw in _KATALOG_OZEL:
        return _KATALOG_OZEL[raw]
    key = raw if raw in STOK_KEYS else _stok_key_from_urun_ad(raw)'''
if old2 not in text:
    raise SystemExit("urun_ac_gorunen_ad block not found")
text = text.replace(old2, new2, 1)

p.write_text(text, encoding="utf-8")
print("patched", p)
