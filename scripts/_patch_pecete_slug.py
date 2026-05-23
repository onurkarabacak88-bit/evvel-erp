from pathlib import Path

p = Path(__file__).resolve().parents[1] / "operasyon_stok_motor.py"
text = p.read_text(encoding="utf-8")
needle = '    if "pecete" in n or "peçete" in n:\n        if n.startswith("z ")'
insert = '    if "pecete" in n or "peçete" in n:\n        if n in ("z_pecete", "baskili_pecete"):\n            return None\n        if n.startswith("z ")'
if needle not in text:
    if 'if n in ("z_pecete", "baskili_pecete")' in text:
        print("already patched")
    else:
        raise SystemExit("needle not found")
else:
    text = text.replace(needle, insert, 1)
    p.write_text(text, encoding="utf-8")
    print("patched slug")
