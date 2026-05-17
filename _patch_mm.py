# -*- coding: utf-8 -*-
from pathlib import Path

p = Path("sube_panel.html")
text = p.read_text(encoding="utf-8")

start = text.find("  if (!okunmamis.length) {\n    el.innerHTML = '<motion.div")
if start < 0:
    start = text.find("  if (!okunmamis.length) {\n    el.innerHTML = '<div class=\"merkez-mesaj-bos\">")
end = text.find("  var h = '';\n  okunmamis.forEach(function(m){", start)
if start < 0 or end < 0:
    raise SystemExit(f"markers not found start={start} end={end}")

new = """  function renderArsivHtml() {
    if (!arsiv.length) return '';
    var hA = '<div style="font-size:11px;color:var(--muted);margin:12px 0 6px;font-weight:700">Panelde saklanan (merkez kaldırdı)</motion.div>';
    arsiv.slice(0, 8).forEach(function(m) {
      var metin = escHtml(String(m.mesaj || '').trim());
      if (metin.length > 280) metin = metin.slice(0, 280) + '…';
      var okLbl = m.okundu ? ' · okundu' : ' · okunmadı';
      hA += '<div class="merkez-msg-kisa merkez-msg-arsiv">';
      hA += '<div><strong>📩</strong> ' + metin + '</div>';
      hA += '<div class="meta">Merkez panelinden silindi' + okLbl + '</div>';
      hA += '</div>';
    });
    return hA;
  }

  if (!okunmamis.length && !arsiv.length) {
    el.innerHTML = '<div class="merkez-mesaj-bos">Şu an okunmamış merkez mesajı yok.</div>';
    return;
  }
  if (mode === 'compact') {
    var hCompact = '';
    if (okunmamis.length) {
      hCompact += '<div class="merkez-mesaj-bos" style="padding:8px 2px;line-height:1.5">' +
        okunmamis.length + ' okunmamış mesaj — ekran ortasında onaylayın veya alt menüden <strong>Mesaj</strong> sekmesine gidin.</div>';
    } else {
      hCompact += '<div class="merkez-mesaj-bos" style="padding:8px 2px">Okunmamış mesaj yok.</div>';
    }
    hCompact += renderArsivHtml();
    el.innerHTML = hCompact;
    return;
  }

"""

new = new.replace("motion.div", "div")  # safety

text = text[:start] + new + text[end:]
# append arsiv to full mode before el.innerHTML = h
needle = "  el.innerHTML = h;\n  fillSels();\n  okunmamis.forEach(function(m){"
if needle in text:
    text = text.replace(
        needle,
        "  h += renderArsivHtml();\n  el.innerHTML = h;\n  fillSels();\n  okunmamis.forEach(function(m){",
        1,
    )
else:
    raise SystemExit("full mode needle missing")

p.write_text(text, encoding="utf-8")
print("patched ok")
