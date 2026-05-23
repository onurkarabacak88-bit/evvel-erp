"""Gönderilecek siparişler: checkbox kaldır, iki buton akışı."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "sube_panel.html"
text = p.read_text(encoding="utf-8")

old_footer = """    h += '<div class="dep-haz-kart-foot">';
    h += '<div class="form-group" style="margin:0"><label for="depNot_' + tidEsc + '">Sevkiyat notu (tüm kart)</label><input id="depNot_' + tidEsc + '" value="' + escHtml(d.sevkiyat_notu||'') + '" placeholder="Opsiyonel genel not" /></div>';
    h += '<label class="chk-row" style="margin:0"><input type="checkbox" id="depDone_' + tidEsc + '" /><span>Sevkiyat tamamlandı (gönderildi) — işaretlenmeden stok yola çıkmaz</span></label>';
    h += '<div class="dep-haz-kaydet-row">';
    h += '<button type="button" class="btn btn-primary btn-sm" id="depKaydet_' + tidEsc + '">Depo sevkiyatını kaydet</button>';
    h += '</div>';
    h += '<div id="depMsg_' + tidEsc + '"></div>';
    h += '</div>';"""

new_footer = """    h += '<div class="dep-haz-kart-foot">';
    h += '<div class="form-group" style="margin:0"><label for="depNot_' + tidEsc + '">Sevkiyat notu (tüm kart)</label><input id="depNot_' + tidEsc + '" value="' + escHtml(d.sevkiyat_notu||'') + '" placeholder="Opsiyonel genel not" /></div>';
    h += '<p style="font-size:11px;color:var(--muted);margin:10px 0 0;line-height:1.45"><strong>Hazırlığı kaydet</strong> stok çıkarmaz. Fiziksel gönderim için <strong>Yola çıkar</strong> — talep şubesinde «Depodan Gelen» açılır.</p>';
    h += '<div class="dep-haz-kaydet-row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">';
    h += '<button type="button" class="btn btn-secondary btn-sm" id="depTaslak_' + tidEsc + '">Hazırlığı kaydet</button>';
    h += '<button type="button" class="btn btn-primary btn-sm" id="depSevk_' + tidEsc + '">Yola çıkar — teslim al aç</button>';
    h += '</div>';
    h += '<div id="depMsg_' + tidEsc + '"></div>';
    h += '</div>';"""

if old_footer not in text:
    raise SystemExit("footer block not found")
text = text.replace(old_footer, new_footer, 1)

old_wire = """function wireDepKaydetHandlers(depoHazirlik) {
  var depoHazirlikLocal = depoHazirlik || [];
  document.querySelectorAll('[id^="depKaydet_"]').forEach(function (btn) {
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.onclick = async function () {
      var tid = String(btn.id || '').replace('depKaydet_', '');
      var msgId = 'depMsg_' + tid;
      setMsg(msgId, '', '');
      btn.disabled = true;
      try {
        var kart = depoHazirlikLocal.find(function (x) {
          return String(x.id || '') === tid;
        });
        if (!kart) throw new Error('Talep kartı bulunamadı');
        var rows = Array.isArray(kart.kalem_duzenle) ? kart.kalem_duzenle : [];
        var kalemler = rows.map(function (k, i) {
          var rid = tid + '_' + i;
          var ist = Number(k.istenen_adet || 0);
          var durum = inpVal('depDur_' + rid) || String(k.durum || 'bekliyor');
          var gonRaw = parseInt(String(inpVal('depAd_' + rid) || '0').replace(/\\D/g, ''), 10);
          var gon = isNaN(gonRaw) ? 0 : gonRaw;
          if (durum === 'var' && gon <= 0 && ist > 0) gon = ist;
          if (durum === 'yok') gon = 0;
          if (durum === 'kismi' && gon <= 0)
            throw new Error((k.urun_ad || 'Kalem') + ' için kısmi adedi girin');
          if (ist > 0 && gon > ist) gon = ist;
          return {
            urun_id: k.urun_id || null,
            urun_ad: k.urun_ad || null,
            istenen_adet: ist,
            durum: durum,
            gonderilen_adet: gon,
            not_aciklama: inpVal('depNt_' + rid) || null,
          };
        });
        if (!kalemler.length) throw new Error('En az bir kalem olmalı');
        var gonderildiChk = document.getElementById('depDone_' + tid);
        var gonderildiFlag = !!(gonderildiChk && gonderildiChk.checked);
        var sevkVar = kalemler.some(function (x) {
          var d = String(x.durum || '');
          return (d === 'var' || d === 'kismi') && (parseInt(x.gonderilen_adet || 0, 10) || 0) > 0;
        });
        if (sevkVar && !gonderildiFlag) {
          throw new Error('Fiziksel gönderim için «Sevkiyat tamamlandı (gönderildi)» kutusunu işaretleyin.');
        }
        var ozetSatirlar = kalemler.map(function(x){
          return '<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px"><span>' + escHtml(x.urun_ad||'') + '</span><strong>×' + (x.gonderilen_adet||0) + '</strong></div>';
        }).join('');
        var modalRes = await pinOnayModalAc({
          baslik: '🚚 Depo sevkiyatını kaydet',
          ozetHtml:
            '<p style="margin:0 0 8px 0;font-size:12px;color:var(--muted)">Kalem özeti — personel ve PIN ile onaylayın.</p>' +
            '<div style="max-height:62vh;overflow:auto">' +
            ozetSatirlar +
            '</div>',
          askCredentials: true,
        });
        if (!modalRes || !modalRes.ok) { setMsg(msgId,'İşlem iptal edildi.','msg-warn'); return; }
        await api('/sube-panel/' + encodeURIComponent(SUBE_ID) + '/siparis-depo-sevkiyat-kaydet', {
          method: 'POST',
          body: {
            talep_id: tid,
            personel_id: modalRes.personel_id,
            pin: modalRes.pin,
            kalemler: kalemler,
            sevkiyat_notu: inpVal('depNot_' + tid) || null,
            gonderildi: !!(
              document.getElementById('depDone_' + tid) &&
              document.getElementById('depDone_' + tid).checked
            ),
          },
        });
        panelToast('✅ Depo sevkiyat kaydı işlendi — talep akışı güncellendi.', 5000);
        siparisAkisCache = null;
        await renderGonderilecekPanel();
        await renderSiparisPanel();
        await siparisGonderSolBlokGuncelle(null);
      } catch (e) {
        if (e.status === 429) handle429(document.getElementById(msgId), e);
        else setMsg(msgId, e.message || 'Hata', 'msg-err');
      }
      btn.disabled = false;
    };
  });
}"""

new_wire = """function depoKartKalemleriOku(tid, kart) {
  var rows = Array.isArray(kart && kart.kalem_duzenle) ? kart.kalem_duzenle : [];
  return rows.map(function (k, i) {
    var rid = tid + '_' + i;
    var ist = Number(k.istenen_adet || 0);
    var durum = inpVal('depDur_' + rid) || String(k.durum || 'bekliyor');
    var gonRaw = parseInt(String(inpVal('depAd_' + rid) || '0').replace(/\\D/g, ''), 10);
    var gon = isNaN(gonRaw) ? 0 : gonRaw;
    if (durum === 'var' && gon <= 0 && ist > 0) gon = ist;
    if (durum === 'yok') gon = 0;
    if (durum === 'kismi' && gon <= 0)
      throw new Error((k.urun_ad || 'Kalem') + ' için kısmi adedi girin');
    if (ist > 0 && gon > ist) gon = ist;
    return {
      urun_id: k.urun_id || null,
      urun_ad: k.urun_ad || null,
      istenen_adet: ist,
      durum: durum,
      gonderilen_adet: gon,
      not_aciklama: inpVal('depNt_' + rid) || null,
    };
  });
}
function depoSevkSatirlariVarMi(kalemler) {
  return (kalemler || []).some(function (x) {
    var d = String(x.durum || '');
    return (d === 'var' || d === 'kismi') && (parseInt(x.gonderilen_adet || 0, 10) || 0) > 0;
  });
}
function wireDepSevkiyatHandlers(depoHazirlik) {
  var depoHazirlikLocal = depoHazirlik || [];
  function kartBul(tid) {
    return depoHazirlikLocal.find(function (x) {
      return String(x.id || '') === tid;
    });
  }
  async function gonder(tid, gonderildi, btn) {
    var msgId = 'depMsg_' + tid;
    setMsg(msgId, '', '');
    var taslakBtn = document.getElementById('depTaslak_' + tid);
    var sevkBtn = document.getElementById('depSevk_' + tid);
    if (btn) btn.disabled = true;
    if (taslakBtn) taslakBtn.disabled = true;
    if (sevkBtn) sevkBtn.disabled = true;
    try {
      var kart = kartBul(tid);
      if (!kart) throw new Error('Talep kartı bulunamadı');
      var kalemler = depoKartKalemleriOku(tid, kart);
      if (!kalemler.length) throw new Error('En az bir kalem olmalı');
      var sevkVar = depoSevkSatirlariVarMi(kalemler);
      if (gonderildi) {
        if (!sevkVar) {
          throw new Error('Yola çıkarmak için en az bir kalemde var/kısmi ve gönderilen adet girin.');
        }
      } else if (sevkVar) {
        throw new Error(
          'Gönderilen adet girilmiş kalemler var — «Yola çıkar» kullanın. Hazırlık kaydı yalnızca bekliyor/yok/not içindir.',
        );
      }
      var modalRes = null;
      if (gonderildi) {
        var ozetSatirlar = kalemler
          .filter(function (x) {
            var d = String(x.durum || '');
            return (d === 'var' || d === 'kismi') && (parseInt(x.gonderilen_adet || 0, 10) || 0) > 0;
          })
          .map(function (x) {
            return (
              '<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px"><span>' +
              escHtml(x.urun_ad || '') +
              '</span><strong>×' +
              (x.gonderilen_adet || 0) +
              '</strong></div>'
            );
          })
          .join('');
        modalRes = await pinOnayModalAc({
          baslik: '🚚 Yola çıkar — stok düşer, teslim al açılır',
          ozetHtml:
            '<p style="margin:0 0 8px 0;font-size:12px;color:var(--muted)">Çıkacak kalemler — personel ve PIN ile onaylayın.</p>' +
            '<div style="max-height:62vh;overflow:auto">' +
            (ozetSatirlar || '<p>Kalem yok</p>') +
            '</div>',
          askCredentials: true,
        });
      } else {
        modalRes = await pinOnayModalAc({
          baslik: '📝 Hazırlığı kaydet (stok çıkmaz)',
          ozetHtml:
            '<p style="margin:0 0 8px 0;font-size:12px;color:var(--muted)">Taslak — yalnızca durum/not kaydı. Fiziksel sevk için «Yola çıkar» kullanın.</p>',
          askCredentials: true,
        });
      }
      if (!modalRes || !modalRes.ok) {
        setMsg(msgId, 'İşlem iptal edildi.', 'msg-warn');
        return;
      }
      await api('/sube-panel/' + encodeURIComponent(SUBE_ID) + '/siparis-depo-sevkiyat-kaydet', {
        method: 'POST',
        body: {
          talep_id: tid,
          personel_id: modalRes.personel_id,
          pin: modalRes.pin,
          kalemler: kalemler,
          sevkiyat_notu: inpVal('depNot_' + tid) || null,
          gonderildi: !!gonderildi,
        },
      });
      if (gonderildi) {
        panelToast('✅ Yola çıkarıldı — talep şubesinde «Depodan Gelen» açıldı.', 6000);
      } else {
        panelToast('✅ Hazırlık kaydedildi (stok çıkmadı).', 4500);
      }
      siparisAkisCache = null;
      await renderGonderilecekPanel();
      await renderSiparisPanel();
      await siparisGonderSolBlokGuncelle(null);
    } catch (e) {
      if (e.status === 429) handle429(document.getElementById(msgId), e);
      else setMsg(msgId, e.message || 'Hata', 'msg-err');
    }
    if (btn) btn.disabled = false;
    if (taslakBtn) taslakBtn.disabled = false;
    if (sevkBtn) sevkBtn.disabled = false;
  }
  document.querySelectorAll('[id^="depTaslak_"]').forEach(function (btn) {
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.onclick = function () {
      gonder(String(btn.id || '').replace('depTaslak_', ''), false, btn);
    };
  });
  document.querySelectorAll('[id^="depSevk_"]').forEach(function (btn) {
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.onclick = function () {
      gonder(String(btn.id || '').replace('depSevk_', ''), true, btn);
    };
  });
}"""

if old_wire not in text:
    raise SystemExit("wireDepKaydetHandlers block not found")
text = text.replace(old_wire, new_wire, 1)

text = text.replace("wireDepKaydetHandlers(depoHazirlik);", "wireDepSevkiyatHandlers(depoHazirlik);")
text = text.replace(
    "document.querySelectorAll('[id^=\"depKaydet_\"]').forEach(function (b) {\n    delete b.dataset.wired;\n  });",
    "document.querySelectorAll('[id^=\"depTaslak_\"],[id^=\"depSevk_\"]').forEach(function (b) {\n    delete b.dataset.wired;\n  });",
)

# snapshot: remove depDone
text = text.replace(
    """  document.querySelectorAll('#gonderilecekPanel input[type="checkbox"][id^="depDone_"]').forEach(function (ch) {
    var tid = String(ch.id || '').replace(/^depDone_/, '');
    kartlar[tid] = kartlar[tid] || {};
    kartlar[tid].done = ch.checked;
  });
""",
    "",
)
text = text.replace(
    """    var dEl = document.getElementById('depDone_' + tid);
    if (nEl && kv.kartNot != null) nEl.value = kv.kartNot;
    if (dEl && kv.done != null) dEl.checked = !!kv.done;
""",
    """    if (nEl && kv.kartNot != null) nEl.value = kv.kartNot;
""",
)

# bulk bar: remove isaretle button
text = text.replace(
    """  h +=
    '<button type="button" id="gonderilecekBulkBtnIsaretle" class="btn btn-ghost btn-sm" onclick="gonderilecekBulkHepsiGonderildi();return false;" title="İlk tık: tüm kartlarda tamamlandı işareti. Yeşilken tekrar: önceki işaretleri geri al.">Tüm kartlarda işaretle ✓</button>';
""",
    "",
)
text = text.replace(
    "  ['gonderilecekBulkBtnKismi', 'gonderilecekBulkBtnTam', 'gonderilecekBulkBtnIsaretle'].forEach(function (bid) {",
    "  ['gonderilecekBulkBtnKismi', 'gonderilecekBulkBtnTam'].forEach(function (bid) {",
)
text = text.replace(
    "  var map = { kismi: 'gonderilecekBulkBtnKismi', tam: 'gonderilecekBulkBtnTam', isaretle: 'gonderilecekBulkBtnIsaretle' };",
    "  var map = { kismi: 'gonderilecekBulkBtnKismi', tam: 'gonderilecekBulkBtnTam' };",
)

# remove gonderilecekBulkHepsiGonderildi function and window export
old_bulk = """function gonderilecekBulkHepsiGonderildi() {
  if (gonderilecekHizliIslemModu === 'isaretle') {
    gonderilecekDepoSnapshotUygula(gonderilecekHizliIslemSnapshot);
    gonderilecekHizliIslemSifirla();
    gonderilecekDepoTaslakDirty = true;
    panelToast('Tamamlandı onayları önceki haline döndü.', 3400);
    return;
  }
  gonderilecekHizliIslemSnapshot = gonderilecekDepoSnapshotAl();
  gonderilecekHizliIslemModu = 'isaretle';
  gonderilecekDepoTaslakDirty = true;
  document.querySelectorAll('#gonderilecekPanel input[type="checkbox"][id^="depDone_"]').forEach(function (ch) {
    ch.checked = true;
  });
  gonderilecekBulkBarAktifSiniflari();
  panelToast('Tüm sipariş kartlarında tamamlandı onayı işaretlendi.', 4200);
}
window.gonderilecekBulkTamGonder = gonderilecekBulkTamGonder;
window.gonderilecekBulkHepsiGonderildi = gonderilecekBulkHepsiGonderildi;
"""
new_bulk = """window.gonderilecekBulkTamGonder = gonderilecekBulkTamGonder;
"""
if old_bulk in text:
    text = text.replace(old_bulk, new_bulk, 1)

text = text.replace(
    "  panelToast('Tüm kalemler «var» + istenen adet olarak ayarlandı. Kısmi/yok gönderim varsa satırları düzeltin; sonra kaydedin.', 5200);",
    "  panelToast('Tüm kalemler «var» + istenen adet. Sonra «Yola çıkar» ile sevk edin.', 5200);",
)

text = text.replace("        tid.indexOf('depDone_') !== 0 &&\n", "")

# taslak kayit needs PIN on backend - fix: use pin modal for taslak too OR relax backend for taslak
# Backend requires valid PIN - using 0000 will fail. Need to fix taslak to use PIN or optional auth.

p.write_text(text, encoding="utf-8")
print("patched sube_panel.html (fix taslak PIN separately)")
