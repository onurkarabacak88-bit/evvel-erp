import re
from pathlib import Path

for rel in ("operasyon_merkez_api.py", "operasyon_stok_motor.py", "sube_panel.py", "siparis_sevkiyat_islem.py"):
    p = Path(__file__).resolve().parents[1] / rel
    if not p.exists():
        continue
    lines = p.read_text(encoding="utf-8").splitlines()
    mod_log = any(re.match(r"^log\s*=\s*logging\.getLogger", l) for l in lines[:40])
    print(f"=== {rel} module_log={mod_log}")
    funcs = []
    cur = None
    for i, line in enumerate(lines, 1):
        m = re.match(r"^def (\w+)\(", line)
        if m:
            if cur:
                funcs.append(cur)
            cur = {"name": m.group(1), "uses": [], "assigns": []}
        elif cur:
            if re.search(r"\blog\.(warning|info|debug|error)\(", line):
                cur["uses"].append(i)
            if re.match(r"^\s+log\s*=\s*logging", line):
                cur["assigns"].append(i)
    if cur:
        funcs.append(cur)
    for f in funcs:
        if f["uses"] and f["assigns"]:
            fu, fa = min(f["uses"]), min(f["assigns"])
            if fu < fa:
                print(f"  BUG {f['name']}: log use L{fu} before assign L{fa}")
        if f["uses"] and not mod_log and not f["assigns"]:
            print(f"  BUG {f['name']}: uses log but no module/local logger")
