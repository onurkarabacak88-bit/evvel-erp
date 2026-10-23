# Python 3.11 uyumluluk: f-string içinde (süslü parantez alanında) AYNI tırnak karakteriyle açılan dize var mı? (PEP 701 yalnız 3.12+)
# Ayrıca 3.11'de yasak: süslü alan içinde ters bölü (\) ve f-string içinde aynı tırnakla yorum. Bu araç tırnak + ters bölüyü yakalar.
import io, sys, tokenize, glob


def _cakisir(ic, dis):
    """3.11: dış f-string tek tırnaklıysa aynı karakterle açılan her dize; üç tırnaklıysa yalnız aynı üçlü tırnak sorun."""
    return ic[:1] == dis[:1] if len(dis) == 1 else ic == dis


def denetle(yol):
    bulgu = []
    try:
        src = io.open(yol, encoding="utf-8").read()
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except Exception as e:  # noqa: BLE001
        return [(yol, 0, f"okunamadı: {e}")]
    yigin = []   # [(tırnak, derinlik_sayacı)]
    for i, t in enumerate(toks):
        if t.type == tokenize.FSTRING_START:
            q = t.string.lstrip("rRbBfFuU")[:3] if t.string.lstrip("rRbBfFuU")[:3] in ('"""', "'''") else t.string.lstrip("rRbBfFuU")[:1]
            if yigin and yigin[-1][1] > 0 and _cakisir(q, yigin[-1][0]):
                bulgu.append((yol, t.start[0], "f-string içinde aynı tırnakla iç içe f-string"))
            yigin.append([q, 0])
        elif t.type == tokenize.FSTRING_END:
            if yigin:
                yigin.pop()
        elif yigin:
            if t.type == tokenize.OP and t.string == "{":
                yigin[-1][1] += 1
            elif t.type == tokenize.OP and t.string == "}":
                yigin[-1][1] = max(0, yigin[-1][1] - 1)
            elif t.type == tokenize.STRING and yigin[-1][1] > 0:
                s = t.string.lstrip("rRbBuU")
                if _cakisir(s[:3] if s[:3] in ('"""', "'''") else s[:1], yigin[-1][0]):
                    bulgu.append((yol, t.start[0], "f-string alanında aynı tırnakla dize (3.11 sözdizimi hatası)"))
            elif t.type == tokenize.FSTRING_MIDDLE and yigin[-1][1] > 0 and "\\" in t.string:
                bulgu.append((yol, t.start[0], "f-string alanında ters bölü"))
    return bulgu


if __name__ == "__main__":
    kok = sys.argv[1] if len(sys.argv) > 1 else "."
    hepsi = []
    for y in sorted(glob.glob(kok + "/*.py")):
        hepsi += denetle(y)
    for y, s, m in hepsi:
        print(f"{y}:{s}: {m}")
    print("toplam", len(hepsi))
