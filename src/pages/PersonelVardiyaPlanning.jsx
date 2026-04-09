import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, today } from '../utils/api';

const GUN_ADLARI = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

/** Kullanıcıya gösterim (API değerleri FULL / PART kalır) */
function planlamaTipiEtiket(tip) {
  const t = (tip || '').toString().toUpperCase();
  if (t === 'PART') return 'Yarı zamanlı';
  return 'Tam zamanlı';
}

function pazartesiBuHafta(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  const wd = d.getDay();
  const diff = wd === 0 ? -6 : 1 - wd;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function tarihEkle(isoDate, gun) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + gun);
  return d.toISOString().slice(0, 10);
}

function indirBlob(dosyaAdi, icerik, mime) {
  const blob = new Blob([icerik], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = dosyaAdi;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function pdfKacis(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

function basitPdfUret(satirlar) {
  const width = 595;
  const height = 842;
  const margin = 40;
  const lineHeight = 14;
  const maxLines = Math.floor((height - margin * 2) / lineHeight);
  const pages = [];
  for (let i = 0; i < satirlar.length; i += maxLines) {
    pages.push(satirlar.slice(i, i + maxLines));
  }
  if (!pages.length) pages.push(['Bos plan']);

  const objects = [];
  const offsets = [];
  let pdf = '%PDF-1.4\n';
  const addObj = (content) => {
    offsets.push(pdf.length);
    const id = offsets.length;
    pdf += `${id} 0 obj\n${content}\nendobj\n`;
    return id;
  };

  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = [];
  const contentIds = [];
  pages.forEach((lines) => {
    const text = lines
      .map((l, i) => `${margin} ${height - margin - i * lineHeight} Td (${pdfKacis(l)}) Tj`)
      .join('\n0 0 Td\n');
    const stream = `BT\n/F1 10 Tf\n${text}\nET`;
    const contentId = addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    contentIds.push(contentId);
    const pageId = addObj(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    pageIds.push(pageId);
  });

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pagesId = addObj(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  // fix parent refs
  pdf = '%PDF-1.4\n';
  offsets.length = 0;
  const rewritten = [];
  const addObj2 = (content) => {
    offsets.push(pdf.length);
    const id = offsets.length;
    pdf += `${id} 0 obj\n${content}\nendobj\n`;
    rewritten.push(id);
    return id;
  };
  const font2 = addObj2('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content2 = [];
  pages.forEach((lines) => {
    const text = lines
      .map((l, i) => `${margin} ${height - margin - i * lineHeight} Td (${pdfKacis(l)}) Tj`)
      .join('\n0 0 Td\n');
    const stream = `BT\n/F1 10 Tf\n${text}\nET`;
    content2.push(addObj2(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  });
  const page2 = content2.map((cid) =>
    addObj2(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${cid} 0 R /Resources << /Font << /F1 ${font2} 0 R >> >> >>`,
    ));
  const kids2 = page2.map((id) => `${id} 0 R`).join(' ');
  const pages2 = addObj2(`<< /Type /Pages /Kids [${kids2}] /Count ${page2.length} >>`);
  const catalog2 = addObj2(`<< /Type /Catalog /Pages ${pages2} 0 R >>`);
  // patch parent 0 0 R
  pdf = pdf.replace(/\/Parent 0 0 R/g, `/Parent ${pages2} 0 R`);

  const xrefPos = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root ${catalog2} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return pdf;
}

function fixed(text, len) {
  const s = String(text ?? '');
  if (s.length > len) return `${s.slice(0, Math.max(0, len - 1))}…`;
  return s.padEnd(len, ' ');
}

/** Motor / taslak rol kodu → Türkçe kısa görev (yazdırılabilir liste) */
function vardiyaRolEtiket(rol) {
  const r = String(rol || 'aralik').toLowerCase();
  if (r === 'acilis') return 'Açılış';
  if (r === 'kapanis') return 'Kapanış';
  return 'Vardiya';
}

function saatHucre(bas, bit) {
  const b = String(bas || '').slice(0, 5);
  const e = String(bit || '').slice(0, 5);
  return `${b}-${e}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * PDF’deki gibi: Şube | Görev | Ad | Pzt…Paz | Kapanış
 * Kutucukta: ana şubede saat aralığı; başka şubede büyük harf şube adı.
 */
function buildHaftalikListeSatirlari(taslak, haftaIzinMap, haftaKolonlari) {
  if (!Array.isArray(taslak) || taslak.length === 0) return [];
  const byPerson = new Map();
  for (const t of taslak) {
    const pid = t.personel_id;
    if (!byPerson.has(pid)) byPerson.set(pid, []);
    byPerson.get(pid).push(t);
  }
  const out = [];
  for (const [pid, items] of byPerson.entries()) {
    const ad = items[0].ad_soyad || pid;
    const subeCount = {};
    const rolCount = {};
    for (const t of items) {
      const sa = t.sube_ad || '—';
      subeCount[sa] = (subeCount[sa] || 0) + 1;
      const ro = String(t.rol || 'aralik').toLowerCase();
      rolCount[ro] = (rolCount[ro] || 0) + 1;
    }
    const anaSube = Object.keys(subeCount).sort(
      (a, b) => subeCount[b] - subeCount[a] || a.localeCompare(b, 'tr'),
    )[0];
    const anaRol = Object.keys(rolCount).sort(
      (a, b) => rolCount[b] - rolCount[a] || a.localeCompare(b),
    )[0];
    const gorev = vardiyaRolEtiket(anaRol);
    const kapanisSayisi = items.filter((x) => String(x.rol || '').toLowerCase() === 'kapanis').length;

    const gunHucreleri = haftaKolonlari.map((g, ix) => {
      const ymd = g.tarih;
      const gunItems = items.filter((x) => String(x.tarih).slice(0, 10) === ymd);
      const izinli = !!(haftaIzinMap[pid] && haftaIzinMap[pid][ix]);
      if (gunItems.length === 0) {
        return {
          text: izinli ? 'İZİNLİ' : '—',
          izinOnly: izinli,
          bos: !izinli,
          hasIhlal: false,
        };
      }
      const parts = gunItems.map((it) => {
        const sube = it.sube_ad || '';
        if (sube === anaSube) return saatHucre(it.bas_saat, it.bit_saat);
        return sube.toLocaleUpperCase('tr-TR');
      });
      const hasIhlal = gunItems.some((it) => it.izin_ihlali || it.rol_ihlali || it.mesai_ihlali);
      return {
        text: parts.join(' / '),
        izinOnly: false,
        bos: false,
        hasIhlal,
      };
    });

    out.push({ pid, ad, anaSube, gorev, kapanisSayisi, gunHucreleri });
  }
  out.sort((a, b) => {
    const s = a.anaSube.localeCompare(b.anaSube, 'tr');
    if (s !== 0) return s;
    return a.ad.localeCompare(b.ad, 'tr');
  });
  return out;
}

export default function PersonelVardiyaPlanning() {
  const [liste, setListe] = useState([]);
  const [seciliId, setSeciliId] = useState(null);
  const [haftaRefTarih, setHaftaRefTarih] = useState(today());
  const [detay, setDetay] = useState(null);
  const [form, setForm] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [kaydediyor, setKaydediyor] = useState(false);
  const [msg, setMsg] = useState(null);
  const [ustSekme, setUstSekme] = useState('personel');
  const [senaryoTarih, setSenaryoTarih] = useState(today());
  const [senaryoSonuc, setSenaryoSonuc] = useState(null);
  const [senaryoYukleniyor, setSenaryoYukleniyor] = useState(false);
  const [haftaRef, setHaftaRef] = useState(today());
  const [haftaSonuc, setHaftaSonuc] = useState(null);
  const [haftaKriz, setHaftaKriz] = useState(false);
  const [haftaYukleniyor, setHaftaYukleniyor] = useState(false);
  const [taslak, setTaslak] = useState([]);
  const [taslakYukleniyor, setTaslakYukleniyor] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [haftaIzinMap, setHaftaIzinMap] = useState({});
  const [izinOneri, setIzinOneri] = useState(null);
  const [izinYukleniyor, setIzinYukleniyor] = useState(false);
  /** hafta sekmesi: kart düzenleme tablosu mu, yazdırım tarzı liste mi */
  const [haftaPlanGorunum, setHaftaPlanGorunum] = useState('liste');

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 4000);
  };

  const listeYukle = useCallback(async () => {
    try {
      const rows = await api('/personel-vardiya/planlama-liste?aktif=true');
      setListe(Array.isArray(rows) ? rows : []);
    } catch {
      setListe([]);
      toast('Personel listesi alınamadı', 'red');
    }
  }, []);

  useEffect(() => {
    listeYukle();
  }, [listeYukle]);

  const detayYukle = useCallback(async (pid, refTarih) => {
    if (!pid) return;
    setYukleniyor(true);
    try {
      const pzt = pazartesiBuHafta(refTarih);
      const d = await api(
        `/personel-vardiya/${encodeURIComponent(pid)}/detay?hafta_baslangic=${encodeURIComponent(pzt)}`,
      );
      setDetay(d);
      const gm = Array.isArray(d.gun_musaitlik) && d.gun_musaitlik.length === 7
        ? d.gun_musaitlik.map((x) => ({
            is_active: !!x.is_active,
            available_from: x.available_from || '',
            available_to: x.available_to || '',
          }))
        : Array.from({ length: 7 }, () => ({
            is_active: true,
            available_from: '',
            available_to: '',
          }));
      setForm({
        include_in_planning: d.personel.include_in_planning,
        vardiya_tipi: d.personel.vardiya_tipi || d.personel.planlama_tipi || 'FULL',
        max_weekly_hours: d.personel.max_weekly_hours ?? '',
        hafta_baslangic: d.hafta_baslangic,
        sube_yetkileri: d.sube_yetkileri.map((x) => ({ ...x })),
        gun_musaitlik: gm,
        haftalik_izin: [...d.haftalik_izin],
        sube_erisim: Array.isArray(d.personel.sube_erisim) ? [...d.personel.sube_erisim] : [],
        vardiya_kapanis_atanabilir: d.personel.vardiya_kapanis_atanabilir !== false,
        vardiya_araci_atanabilir: d.personel.vardiya_araci_atanabilir !== false,
        vardiya_gun_icinde_cok_subeye_gidebilir: d.personel.vardiya_gun_icinde_cok_subeye_gidebilir !== false,
        vardiya_oncelikli_sube_id: d.personel.vardiya_oncelikli_sube_id || '',
      });
    } catch (e) {
      toast(e.message || 'Detay yüklenemedi', 'red');
      setDetay(null);
      setForm(null);
    } finally {
      setYukleniyor(false);
    }
  }, []);

  useEffect(() => {
    if (!seciliId) {
      setDetay(null);
      setForm(null);
      return;
    }
    detayYukle(seciliId, haftaRefTarih);
  }, [seciliId, haftaRefTarih, detayYukle]);

  async function planlamayaDahil(pid, dahil) {
    try {
      await api(`/personel-vardiya/${encodeURIComponent(pid)}/planlamaya-dahil`, {
        method: 'PATCH',
        body: { include_in_planning: dahil },
      });
      await listeYukle();
      if (pid === seciliId && form) {
        setForm((f) => (f ? { ...f, include_in_planning: dahil } : f));
      }
    } catch (e) {
      toast(e.message || 'Güncellenemedi', 'red');
    }
  }

  async function kaydet() {
    if (!seciliId || !form) return;
    setKaydediyor(true);
    try {
      const maxH = form.max_weekly_hours === '' || form.max_weekly_hours == null
        ? null
        : Number(form.max_weekly_hours);
      await api(`/personel-vardiya/${encodeURIComponent(seciliId)}/detay`, {
        method: 'PUT',
        body: {
          include_in_planning: form.include_in_planning,
          vardiya_tipi: form.vardiya_tipi,
          max_weekly_hours: Number.isNaN(maxH) ? null : maxH,
          hafta_baslangic: form.hafta_baslangic,
          sube_yetkileri: form.sube_yetkileri.map((s) => ({
            sube_id: s.sube_id,
            opening: s.opening,
            closing: s.closing,
          })),
          gun_musaitlik: form.gun_musaitlik.map((x) => ({
            is_active: x.is_active,
            available_from: x.available_from || null,
            available_to: x.available_to || null,
          })),
          haftalik_izin: form.haftalik_izin,
          sube_erisim: form.sube_erisim || [],
          vardiya_kapanis_atanabilir: form.vardiya_kapanis_atanabilir,
          vardiya_araci_atanabilir: form.vardiya_araci_atanabilir,
          vardiya_gun_icinde_cok_subeye_gidebilir: form.vardiya_gun_icinde_cok_subeye_gidebilir,
          vardiya_oncelikli_sube_id: form.vardiya_oncelikli_sube_id || null,
        },
      });
      toast('✓ Kaydedildi');
      await listeYukle();
      await detayYukle(seciliId, haftaRefTarih);
    } catch (e) {
      toast(e.message || 'Kayıt başarısız', 'red');
    } finally {
      setKaydediyor(false);
    }
  }

  async function senaryoUret() {
    setSenaryoYukleniyor(true);
    setSenaryoSonuc(null);
    try {
      const r = await api(
        `/vardiya-motor/senaryolar?tarih=${encodeURIComponent(senaryoTarih)}`,
      );
      setSenaryoSonuc(r);
    } catch (e) {
      toast(e.message || 'Senaryolar alınamadı', 'red');
    } finally {
      setSenaryoYukleniyor(false);
    }
  }

  async function haftaSenaryoUret() {
    setHaftaYukleniyor(true);
    setHaftaSonuc(null);
    try {
      const path = haftaKriz ? '/vardiya-motor/hafta-senaryolar-kriz' : '/vardiya-motor/hafta-senaryolar';
      const r = await api(`${path}?hafta_baslangic=${encodeURIComponent(haftaRef)}`);
      setHaftaSonuc(r);
    } catch (e) {
      toast(e.message || 'Haftalık senaryolar alınamadı', 'red');
    } finally {
      setHaftaYukleniyor(false);
    }
  }

  async function haftaSenaryoUretExpert() {
    setHaftaYukleniyor(true);
    setHaftaSonuc(null);
    try {
      const r = await api(
        `/vardiya-motor/hafta-senaryolar-expert?hafta_baslangic=${encodeURIComponent(haftaRef)}&kriz_modu=${haftaKriz ? 'true' : 'false'}`,
      );
      setHaftaSonuc(r);
    } catch (e) {
      toast(e.message || 'Uzman haftalık senaryolar alınamadı', 'red');
    } finally {
      setHaftaYukleniyor(false);
    }
  }

  async function taslakYukle() {
    setTaslakYukleniyor(true);
    try {
      const r = await api(`/vardiya/taslak?hafta_baslangic=${encodeURIComponent(haftaRef)}`);
      setTaslak(Array.isArray(r) ? r : []);
    } catch (e) {
      toast(e.message || 'Taslak alınamadı', 'red');
      setTaslak([]);
    } finally {
      setTaslakYukleniyor(false);
    }
  }

  async function haftaIzinYukle() {
    try {
      const rows = await api(`/vardiya/hafta-izin?hafta_baslangic=${encodeURIComponent(haftaBas)}`);
      const m = {};
      (Array.isArray(rows) ? rows : []).forEach((r) => {
        m[r.personel_id] = Array.isArray(r.izinler) ? r.izinler : [false, false, false, false, false, false, false];
      });
      setHaftaIzinMap(m);
    } catch {
      setHaftaIzinMap({});
    }
  }

  async function taslagaKaydet(senaryoId) {
    try {
      const r = await api('/vardiya/taslak/kaydet', {
        method: 'POST',
        body: { hafta_baslangic: haftaRef, senaryo_id: senaryoId },
      });
      toast(`✓ Taslak kaydedildi (${r.eklenen} satır)`);
      await taslakYukle();
    } catch (e) {
      toast(e.message || 'Taslak kaydedilemedi', 'red');
    }
  }

  async function swapYap(id1, id2) {
    if (!id1 || !id2 || id1 === id2) return;
    try {
      await api('/vardiya/taslak/swap', { method: 'POST', body: { id1, id2 } });
      await taslakYukle();
    } catch (e) {
      toast(e.message || 'Yer değiştirme başarısız', 'red');
    }
  }

  async function izinOnerisiAl(uygula = false) {
    setIzinYukleniyor(true);
    try {
      const seciliSenaryoId = (haftaSonuc?.senaryolar || [])[0]?.id || null;
      const r = await api('/vardiya/hafta-izin-otomatik', {
        method: 'POST',
        body: {
          hafta_baslangic: haftaBas,
          senaryo_id: seciliSenaryoId,
          uygula,
        },
      });
      setIzinOneri(r);
      if (uygula) {
        toast(`✓ ${r.onerilen_izin_sayisi} izin kaydı uygulandı`);
        await haftaIzinYukle();
      } else {
        toast(`✓ ${r.onerilen_izin_sayisi} izin önerisi üretildi`);
      }
    } catch (e) {
      toast(e.message || 'İzin önerisi alınamadı', 'red');
    } finally {
      setIzinYukleniyor(false);
    }
  }

  function exportExcel() {
    if (!taslak.length) {
      toast('İndirilecek taslak bulunamadı', 'yellow');
      return;
    }
    const tr = taslak
      .map((t) => `
        <tr>
          <td>${String(t.tarih || '')}</td>
          <td>${String(t.ad_soyad || '')}</td>
          <td>${String(t.sube_ad || '')}</td>
          <td>${String(t.bas_saat || '')}</td>
          <td>${String(t.bit_saat || '')}</td>
          <td>${String(t.rol || '')}</td>
          <td>${String(t.durum || '')}</td>
          <td>${t.izin_ihlali ? 'Evet' : 'Hayır'}</td>
          <td>${t.rol_ihlali ? 'Evet' : 'Hayır'}</td>
          <td>${t.mesai_ihlali ? 'Evet' : 'Hayır'}</td>
        </tr>
      `)
      .join('');
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: Arial, sans-serif; }
    h2 { margin: 0 0 10px 0; }
    .sub { font-size: 12px; color: #666; margin-bottom: 10px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; }
    th { background: #efefef; text-align: left; }
  </style>
</head>
<body>
  <h2>Haftalık Vardiya Planı</h2>
  <div class="sub">Hafta başlangıcı: ${haftaBas}</div>
  <table>
    <thead>
      <tr>
        <th>Tarih</th><th>Personel</th><th>Şube</th><th>Başlangıç</th><th>Bitiş</th>
        <th>Rol</th><th>Durum</th><th>İzin İhlali</th><th>Rol İhlali</th><th>Mesai İhlali</th>
      </tr>
    </thead>
    <tbody>${tr}</tbody>
  </table>
</body>
</html>`;
    indirBlob(`haftalik-vardiya-${haftaBas}.xls`, html, 'application/vnd.ms-excel;charset=utf-8;');
  }

  function exportPdf() {
    if (!taslak.length) {
      toast('İndirilecek taslak bulunamadı', 'yellow');
      return;
    }
    const head = `${fixed('Tarih', 10)} | ${fixed('Personel', 20)} | ${fixed('Şube', 14)} | ${fixed('Saat', 11)} | ${fixed('Rol', 8)} | ${fixed('İhlal', 14)}`;
    const line = '-'.repeat(head.length);
    const lines = [
      `Haftalik Vardiya Plani - ${haftaBas}`,
      line,
      head,
      line,
      ...taslak.map((t) => {
        const flags = `${t.izin_ihlali ? 'İzin ' : ''}${t.rol_ihlali ? 'Rol ' : ''}${t.mesai_ihlali ? 'Mesai' : ''}`.trim() || '-';
        return `${fixed(t.tarih, 10)} | ${fixed(t.ad_soyad, 20)} | ${fixed(t.sube_ad, 14)} | ${fixed(`${t.bas_saat}-${t.bit_saat}`, 11)} | ${fixed(t.rol || '-', 8)} | ${fixed(flags, 14)}`;
      }),
    ];
    const pdf = basitPdfUret(lines);
    indirBlob(`haftalik-vardiya-${haftaBas}.pdf`, pdf, 'application/pdf');
  }

  /** Tulipi tarzı tablo — Excel’e uygun HTML */
  function exportExcelListe() {
    if (!taslak.length) {
      toast('İndirilecek taslak bulunamadı', 'yellow');
      return;
    }
    const kolonlar = GUN_ADLARI.map((ad, i) => ({ ad, tarih: tarihEkle(haftaBas, i) }));
    const satirlar = buildHaftalikListeSatirlari(taslak, haftaIzinMap, kolonlar);
    const gunTh = kolonlar
      .map(
        (g) =>
          `<th style="text-align:center;min-width:88px;font-size:11px"><div>${escapeHtml(g.ad)}</div><div style="font-weight:400;font-size:10px">${escapeHtml(g.tarih)}</div></th>`,
      )
      .join('');
    const body = satirlar
      .map(
        (r) => `<tr>
        <td>${escapeHtml(r.anaSube)}</td>
        <td>${escapeHtml(r.gorev)}</td>
        <td>${escapeHtml(r.ad)}</td>
        ${r.gunHucreleri
          .map(
            (c) =>
              `<td style="text-align:center;font-size:11px;${c.hasIhlal ? 'background:#fff3cd;' : ''}">${escapeHtml(c.text)}</td>`,
          )
          .join('')}
        <td style="text-align:center">${r.kapanisSayisi}</td>
      </tr>`,
      )
      .join('');
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8" />
<style>
  body { font-family: Arial, sans-serif; margin: 12px; }
  h1 { font-size: 15px; margin: 0 0 6px 0; }
  .sub { font-size: 12px; color: #444; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #888; padding: 5px 6px; }
  th { background: #e8e8e8; font-size: 11px; }
</style></head><body>
  <h1>Haftalık vardiya listesi</h1>
  <div class="sub">Hafta (${escapeHtml(haftaBas)} başlangıç) · ${satirlar.length} personel</div>
  <table>
    <thead><tr>
      <th>Şube</th><th>Görev</th><th>Ad ve soyad</th>${gunTh}<th>Kapanış sayısı</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p style="font-size:10px;color:#666;margin-top:10px">Not: Ana şubede saat aralığı; başka şubede şube adı (büyük harf). İhlal varsa hücre sarı vurgulu.</p>
</body></html>`;
    indirBlob(`haftalik-vardiya-liste-${haftaBas}.xls`, html, 'application/vnd.ms-excel;charset=utf-8;');
  }

  function exportCsvListe() {
    if (!taslak.length) {
      toast('İndirilecek taslak bulunamadı', 'yellow');
      return;
    }
    const kolonlar = GUN_ADLARI.map((ad, i) => ({ ad, tarih: tarihEkle(haftaBas, i) }));
    const satirlar = buildHaftalikListeSatirlari(taslak, haftaIzinMap, kolonlar);
    const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const header = ['Şube', 'Görev', 'Ad ve soyad', ...kolonlar.map((g) => `${g.ad} ${g.tarih}`), 'Kapanış sayısı'];
    const lines = [
      header.map(esc).join(';'),
      ...satirlar.map((r) =>
        [r.anaSube, r.gorev, r.ad, ...r.gunHucreleri.map((c) => c.text), r.kapanisSayisi].map(esc).join(';'),
      ),
    ];
    indirBlob(`haftalik-vardiya-liste-${haftaBas}.csv`, lines.join('\n'), 'text/csv;charset=utf-8;');
  }

  function subeErisimToggle(subeId, checked) {
    setForm((f) => {
      if (!f) return f;
      const set = new Set(f.sube_erisim || []);
      if (checked) set.add(subeId);
      else set.delete(subeId);
      return { ...f, sube_erisim: [...set] };
    });
  }

  const haftaBas = pazartesiBuHafta(haftaRef);
  const haftaKolonlari = GUN_ADLARI.map((ad, i) => ({ ad, tarih: tarihEkle(haftaBas, i) }));
  const listeOnizlemeSatirlari = useMemo(
    () => buildHaftalikListeSatirlari(taslak, haftaIzinMap, haftaKolonlari),
    [taslak, haftaIzinMap, haftaBas],
  );
  const taslakPersoneller = Array.from(
    new Map((taslak || []).map((t) => [t.personel_id, { id: t.personel_id, ad: t.ad_soyad }])).values(),
  ).sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
  const hucreSatirlari = (pid, tarih) =>
    (taslak || []).filter((x) => x.personel_id === pid && String(x.tarih).slice(0, 10) === tarih);

  useEffect(() => {
    if (ustSekme !== 'hafta') return;
    haftaIzinYukle();
  }, [ustSekme, haftaBas]);

  useEffect(() => {
    if (ustSekme !== 'hafta') return;
    taslakYukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- taslakYukle haftaRef ile senkron
  }, [ustSekme, haftaRef]);

  return (
    <div style={{ maxWidth: 1280 }}>
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
        Personel yönetim ve planlama
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
        Kaynak: personel (maaş modülü ile aynı liste). Şube erişimi: Sıla’nın Alsancak–Zafer gibi gidebileceği şubeler.
        Boş bırakılırsa havuz dağıtım (tüm aktif şubeler) kabul edilir.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button
          type="button"
          className={`btn btn-sm ${ustSekme === 'personel' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setUstSekme('personel')}
        >
          Personel ayarları
        </button>
        <button
          type="button"
          className={`btn btn-sm ${ustSekme === 'senaryo' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setUstSekme('senaryo')}
        >
          Senaryo üret
        </button>
        <button
          type="button"
          className={`btn btn-sm ${ustSekme === 'hafta' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setUstSekme('hafta')}
        >
          Haftalık plan
        </button>
      </div>

      {ustSekme === 'senaryo' && (
        <div style={{ marginBottom: 20, border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Günlük senaryo önizleme</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--text3)' }}>
              Tarih{' '}
              <input
                type="date"
                value={senaryoTarih}
                onChange={(e) => setSenaryoTarih(e.target.value)}
                style={{ marginLeft: 6 }}
              />
            </label>
            <button type="button" className="btn btn-primary btn-sm" onClick={senaryoUret} disabled={senaryoYukleniyor}>
              {senaryoYukleniyor ? 'Üretiliyor…' : 'Senaryoları üret'}
            </button>
          </div>
          {senaryoSonuc && (
            <div style={{ fontSize: 12 }}>
              <div
                className={`alert-box ${senaryoSonuc.tek_mantikli_varyasyon_mu ? 'yellow' : 'green'}`}
                style={{ marginBottom: 12 }}
              >
                {senaryoSonuc.aciklama}
              </div>
              <div style={{ color: 'var(--text3)', marginBottom: 8 }}>
                İhtiyaç satırı: {senaryoSonuc.toplam_ihtiyac_satiri} · Plan personel: {senaryoSonuc.planlamaya_dahil_personel} ·
                Şubeler arası min. geçiş: {senaryoSonuc.subeler_arasi_min_dakika} dk
              </div>
              {(senaryoSonuc.notlar || []).map((n, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>
                  {n}
                </div>
              ))}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
                {(senaryoSonuc.senaryolar || []).map((sn) => (
                  <div
                    key={sn.id}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 12,
                      background: 'var(--bg2)',
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>
                      Senaryo {sn.id}: {sn.baslik}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{sn.aciklama}</div>
                    <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap' }}>
                      {(sn.ozet_satirlari || []).join('\n')}
                    </div>
                    {(sn.uyarilar || []).length > 0 && (
                      <div className="alert-box red mt-8" style={{ marginTop: 8, fontSize: 11 }}>
                        {(sn.uyarilar || []).map((u, j) => (
                          <div key={j}>{u}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {ustSekme === 'hafta' && (
        <div style={{ marginBottom: 20, border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Haftalık senaryolar + kilitli taslak</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--text3)' }}>
              Hafta başlangıcı (Pzt)
              <input type="date" value={haftaRef} onChange={(e) => setHaftaRef(e.target.value)} style={{ marginLeft: 6 }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={haftaKriz} onChange={(e) => setHaftaKriz(e.target.checked)} />
              Kriz modu (imkansıza yakın: izin/rol ihlali olabilir)
            </label>
            <button type="button" className="btn btn-primary btn-sm" onClick={haftaSenaryoUret} disabled={haftaYukleniyor}>
              {haftaYukleniyor ? 'Üretiliyor…' : 'Haftalık senaryoları üret'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={haftaSenaryoUretExpert} disabled={haftaYukleniyor}>
              {haftaYukleniyor ? 'Üretiliyor…' : 'Expert planner üret'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={taslakYukle} disabled={taslakYukleniyor}>
              {taslakYukleniyor ? 'Yükleniyor…' : 'Taslağı yükle'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => izinOnerisiAl(false)} disabled={izinYukleniyor}>
              {izinYukleniyor ? 'Hesaplanıyor…' : 'İzin önerisi al'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => izinOnerisiAl(true)} disabled={izinYukleniyor}>
              {izinYukleniyor ? 'Uygulanıyor…' : 'Öneriyi uygula'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportExcel}>
              Excel indir
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportPdf}>
              PDF indir
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportExcelListe} title="Şube / görev / haftalık tablo">
              Excel (yazdırım tablosu)
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportCsvListe} title="Excel; ayırıcı ;">
              CSV (tablo)
            </button>
          </div>

          {izinOneri && (
            <div style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--bg2)' }}>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Otomatik izin önerisi</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                6 gün aday: {izinOneri.aday_sayisi_6gun} · Öneri: {izinOneri.onerilen_izin_sayisi} ·
                Uygulandı: {izinOneri.uygulandi ? 'Evet' : 'Hayır'}
              </div>
              {!izinOneri.oneri?.length ? (
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>Bu hafta için yeni izin önerisi bulunamadı.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {izinOneri.oneri.map((o) => (
                    <div key={`${o.personel_id}_${o.izin_tarih}`} style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }}>
                      {o.personel_ad}: <strong>{o.izin_tarih}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {haftaSonuc && (
            <div style={{ fontSize: 12 }}>
              <div className={`alert-box ${haftaSonuc.tek_mantikli_varyasyon_mu ? 'yellow' : 'green'}`} style={{ marginBottom: 12 }}>
                {haftaSonuc.aciklama}
              </div>
              {haftaSonuc.en_iyi_senaryo_id && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                  En iyi senaryo: <strong>{haftaSonuc.en_iyi_senaryo_id}</strong> {haftaSonuc.planner ? `(${haftaSonuc.planner})` : ''}
                </div>
              )}
              <div style={{ color: 'var(--text3)', marginBottom: 10 }}>
                İhtiyaç satırı: {haftaSonuc.toplam_ihtiyac_satiri} · Plan personel: {haftaSonuc.planlamaya_dahil_personel} ·
                Şubeler arası min. geçiş: {haftaSonuc.subeler_arasi_min_dakika} dk
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
                {(haftaSonuc.senaryolar || []).map((sn) => (
                  <div key={sn.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--bg2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <div style={{ fontWeight: 700 }}>Senaryo {sn.id}: {sn.baslik}</div>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => taslagaKaydet(sn.id)}>
                        Bu senaryoyu kilitli taslağa kaydet
                      </button>
                    </div>
                    {(sn.uyarilar || []).length > 0 && (
                      <div className="alert-box yellow mt-8" style={{ marginTop: 8, fontSize: 11 }}>
                        {(sn.uyarilar || []).slice(0, 6).map((u, j) => <div key={j}>{u}</div>)}
                        {(sn.uyarilar || []).length > 6 && <div>… ve {(sn.uyarilar || []).length - 6} uyarı daha</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '12px 0 8px' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Haftalık plan çıktısı</span>
            <button
              type="button"
              className={`btn btn-sm ${haftaPlanGorunum === 'liste' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setHaftaPlanGorunum('liste')}
            >
              Tablo önizleme (PDF stili)
            </button>
            <button
              type="button"
              className={`btn btn-sm ${haftaPlanGorunum === 'duzenle' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setHaftaPlanGorunum('duzenle')}
            >
              Kartla düzenle (sürükle-bırak)
            </button>
          </div>
          {!taslak.length ? (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              Henüz taslak yok. Senaryoyu taslağa kaydedin; hafta sekmesine girince taslak otomatik yeniden yüklenir. İsterseniz
              {' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={taslakYukle} disabled={taslakYukleniyor}>
                yenileyin
              </button>
              .
            </div>
          ) : haftaPlanGorunum === 'liste' ? (
            <div
              style={{
                overflow: 'auto',
                maxHeight: 'min(70vh, 720px)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg2)',
              }}
            >
              <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)' }}>
                <strong>Haftalık vardiya listesi</strong>
                {' · '}
                {(() => {
                  const a = new Date(`${haftaKolonlari[0].tarih}T12:00:00`);
                  const b = new Date(`${haftaKolonlari[6].tarih}T12:00:00`);
                  const f = (d) => d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
                  return `${f(a)} – ${f(b)}`;
                })()}
                <span style={{ color: 'var(--text3)', marginLeft: 8 }}>
                  Ana şubede saat; başka şubede şube adı. Boş gün + izin → İZİNLİ.
                </span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100, fontSize: 11 }}>
                <thead>
                  <tr style={{ background: 'var(--bg3)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid var(--border)', position: 'sticky', left: 0, background: 'var(--bg3)', zIndex: 1 }}>Şube</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid var(--border)', minWidth: 72 }}>Görev</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid var(--border)', minWidth: 120 }}>Ad ve soyad</th>
                    {haftaKolonlari.map((g) => (
                      <th key={g.tarih} style={{ textAlign: 'center', padding: '6px 4px', border: '1px solid var(--border)', minWidth: 84 }}>
                        <div>{g.ad}</div>
                        <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>{g.tarih.slice(5)}</div>
                      </th>
                    ))}
                    <th style={{ textAlign: 'center', padding: '6px 6px', border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Kapanış</th>
                  </tr>
                </thead>
                <tbody>
                  {listeOnizlemeSatirlari.map((r) => (
                    <tr key={r.pid}>
                      <td style={{ padding: '6px 8px', border: '1px solid var(--border)', fontWeight: 600, position: 'sticky', left: 0, background: 'var(--bg2)', zIndex: 1 }}>{r.anaSube}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid var(--border)', color: 'var(--text2)' }}>{r.gorev}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid var(--border)' }}>{r.ad}</td>
                      {r.gunHucreleri.map((c, j) => (
                        <td
                          key={j}
                          style={{
                            textAlign: 'center',
                            padding: '6px 4px',
                            border: '1px solid var(--border)',
                            background: c.hasIhlal ? 'rgba(250,200,0,0.18)' : 'transparent',
                            color: c.izinOnly ? 'var(--yellow)' : !c.bos ? 'var(--text1)' : 'var(--text3)',
                            fontWeight: c.izinOnly ? 700 : 500,
                            whiteSpace: 'normal',
                            maxWidth: 120,
                          }}
                        >
                          {c.text}
                        </td>
                      ))}
                      <td style={{ textAlign: 'center', padding: '6px 6px', border: '1px solid var(--border)' }}>{r.kapanisSayisi}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: 'var(--text3)' }}>
                Kartları sürükleyip başka kartın üstüne bırakarak iki personelin yerlerini değiştirin (aynı taslak satırları).
              </div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>Personel</th>
                      {haftaKolonlari.map((g) => (
                        <th
                          key={g.tarih}
                          style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border)', minWidth: 135 }}
                        >
                          <div>{g.ad}</div>
                          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>{g.tarih}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {taslakPersoneller.map((p) => (
                      <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600, verticalAlign: 'top' }}>{p.ad}</td>
                        {haftaKolonlari.map((g) => {
                          const satirlar = hucreSatirlari(p.id, g.tarih);
                          const izinli = !!(haftaIzinMap[p.id] && haftaIzinMap[p.id][haftaKolonlari.findIndex((x) => x.tarih === g.tarih)]);
                          return (
                            <td key={`${p.id}_${g.tarih}`} style={{ padding: '8px 6px', verticalAlign: 'top' }}>
                              {satirlar.length === 0 ? (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: izinli ? 'var(--yellow)' : 'var(--text3)',
                                    opacity: izinli ? 1 : 0.5,
                                    fontWeight: izinli ? 700 : 400,
                                  }}
                                >
                                  {izinli ? 'İzinli' : '—'}
                                </div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {satirlar.map((t) => (
                                    <div
                                      key={t.id}
                                      draggable
                                      onDragStart={() => setDragId(t.id)}
                                      onDragOver={(e) => e.preventDefault()}
                                      onDrop={() => { swapYap(dragId, t.id); setDragId(null); }}
                                      title="Başka bir kartı bunun üstüne bırak: personeller swap olur"
                                      style={{
                                        border: '1px solid var(--border)',
                                        borderRadius: 6,
                                        padding: '6px 7px',
                                        fontSize: 11,
                                        cursor: 'grab',
                                        background: (t.izin_ihlali || t.rol_ihlali || t.mesai_ihlali)
                                          ? 'rgba(250,200,0,0.12)'
                                          : 'var(--bg2)',
                                      }}
                                    >
                                      <div style={{ fontWeight: 600 }}>{t.sube_ad}</div>
                                      <div style={{ color: 'var(--text3)' }}>{t.bas_saat}–{t.bit_saat}</div>
                                      {(t.izin_ihlali || t.rol_ihlali || t.mesai_ihlali) && (
                                        <div style={{ marginTop: 2, color: 'var(--yellow)', fontWeight: 700 }}>
                                          {t.izin_ihlali ? 'İZİN ' : ''}
                                          {t.rol_ihlali ? 'ROL ' : ''}
                                          {t.mesai_ihlali ? 'MESAİ' : ''}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 280,
            flexShrink: 0,
            border: '1px solid var(--border)',
            borderRadius: 10,
            background: 'var(--bg2)',
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
        >
          <div style={{ padding: '10px 12px', fontWeight: 700, fontSize: 12, borderBottom: '1px solid var(--border)' }}>
            Personel listesi
          </div>
          {!liste.length && (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--text3)' }}>Aktif personel yok.</div>
          )}
          {liste.map((p) => {
            const secili = seciliId === p.id;
            const pasifPlan = !p.include_in_planning;
            return (
              <div
                key={p.id}
                onClick={() => setSeciliId(p.id)}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: secili ? 'rgba(74,158,255,0.12)' : 'transparent',
                  opacity: pasifPlan ? 0.55 : 1,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.ad_soyad}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {planlamaTipiEtiket(p.planlama_tipi)}
                </div>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={!!p.include_in_planning}
                    onChange={(e) => planlamayaDahil(p.id, e.target.checked)}
                  />
                  Planlamaya dahil
                </label>
              </div>
            );
          })}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {ustSekme === 'personel' && !seciliId && (
            <div className="alert-box yellow">Soldan bir personel seçin.</div>
          )}
          {ustSekme === 'personel' && seciliId && yukleniyor && (
            <div className="loading"><div className="spinner" /> Yükleniyor…</div>
          )}
          {ustSekme === 'personel' && seciliId && !yukleniyor && form && detay && (
            <>
              <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Hafta (izin bu hafta için)
                  </label>
                  <input
                    type="date"
                    value={haftaRefTarih}
                    onChange={(e) => setHaftaRefTarih(e.target.value)}
                  />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Hafta başı: <span className="mono">{form.hafta_baslangic}</span>
                </div>
              </div>

              <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>A) Şube + vardiya yetkisi</h3>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                {form.sube_yetkileri.map((s) => (
                  <div key={s.sube_id} style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{s.sube_ad}</div>
                    <label style={{ marginRight: 16, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={s.opening}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            sube_yetkileri: f.sube_yetkileri.map((x) =>
                              x.sube_id === s.sube_id ? { ...x, opening: e.target.checked } : x,
                            ),
                          }))
                        }
                      />{' '}
                      Açılış
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={s.closing}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            sube_yetkileri: f.sube_yetkileri.map((x) =>
                              x.sube_id === s.sube_id ? { ...x, closing: e.target.checked } : x,
                            ),
                          }))
                        }
                      />{' '}
                      Kapanış
                    </label>
                  </div>
                ))}
              </div>

              <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>
                B) Gün içinde hangi şubelere gidebilir (kaydırma ağı)
              </h3>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, lineHeight: 1.5 }}>
                Örn. Sıla: Alsancak + Zafer işaretlenir; Köyceğiz / Gazze kapalı kalır. Boş liste = yalnızca ana şube.
                Tam personel, aynı gün ikinci şubeye (mesai tamamlamak için) gidebiliyorsa kutuyu açık tutun; yarı zamanlıda
                genelde kapalıdır.
              </div>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 16,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '10px 16px',
                }}
              >
                {form.sube_yetkileri.map((s) => (
                  <label key={s.sube_id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={(form.sube_erisim || []).includes(s.sube_id)}
                      onChange={(e) => subeErisimToggle(s.sube_id, e.target.checked)}
                    />
                    {s.sube_ad}
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 16, fontSize: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.vardiya_kapanis_atanabilir}
                    onChange={(e) =>
                      setForm((f) => (f ? { ...f, vardiya_kapanis_atanabilir: e.target.checked } : f))
                    }
                  />
                  Kapanışa atanabilir
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.vardiya_araci_atanabilir}
                    onChange={(e) =>
                      setForm((f) => (f ? { ...f, vardiya_araci_atanabilir: e.target.checked } : f))
                    }
                  />
                  Ara / ara dilim görevi (şube aracı ihtiyacı) uygun
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.vardiya_gun_icinde_cok_subeye_gidebilir}
                    onChange={(e) =>
                      setForm((f) => (f ? { ...f, vardiya_gun_icinde_cok_subeye_gidebilir: e.target.checked } : f))
                    }
                  />
                  Aynı gün birden fazla şubede çalışabilir (kaydırma)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>Öncelikli yazılacak şube (opsiyonel):</span>
                  <select
                    value={form.vardiya_oncelikli_sube_id || ''}
                    onChange={(e) => setForm((f) => (f ? { ...f, vardiya_oncelikli_sube_id: e.target.value } : f))}
                    style={{ minWidth: 150 }}
                  >
                    <option value="">Tercih yok (havuz)</option>
                    {form.sube_yetkileri.map((s) => (
                      <option key={s.sube_id} value={s.sube_id}>{s.sube_ad}</option>
                    ))}
                  </select>
                </label>
              </div>

              <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>C) Gün + saat uygunluğu</h3>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.5 }}>
                Her gün: çalışabilir değilse o gün hiç atanamaz. Çalışabilir + saatler boşsa tüm gün müsait.
                Saat doluysa atama yalnız bu aralıkta yapılabilir (ör. 16:00–24:00). Bitiş için 24:00 yazılabilir.
              </div>
              <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                {GUN_ADLARI.map((ad, i) => {
                  const gun = form.gun_musaitlik[i];
                  return (
                    <div
                      key={ad}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 130px 1fr 1fr',
                        gap: 8,
                        alignItems: 'center',
                        marginBottom: 8,
                        fontSize: 12,
                        opacity: gun.is_active ? 1 : 0.55,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{ad}</span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={gun.is_active}
                          onChange={(e) =>
                            setForm((f) => {
                              const gm = f.gun_musaitlik.map((x, j) =>
                                j === i
                                  ? {
                                      ...x,
                                      is_active: e.target.checked,
                                      ...(!e.target.checked
                                        ? { available_from: '', available_to: '' }
                                        : {}),
                                    }
                                  : x,
                              );
                              return { ...f, gun_musaitlik: gm };
                            })
                          }
                        />
                        Çalışabilir
                      </label>
                      <input
                        type="text"
                        placeholder="Müsait başlangıç (örn. 16:00)"
                        disabled={!gun.is_active}
                        value={gun.available_from}
                        onChange={(e) =>
                          setForm((f) => {
                            const gm = f.gun_musaitlik.map((x, j) =>
                              j === i ? { ...x, available_from: e.target.value } : x,
                            );
                            return { ...f, gun_musaitlik: gm };
                          })
                        }
                        style={{ padding: '6px 8px' }}
                      />
                      <input
                        type="text"
                        placeholder="Müsait bitiş (örn. 24:00)"
                        disabled={!gun.is_active}
                        value={gun.available_to}
                        onChange={(e) =>
                          setForm((f) => {
                            const gm = f.gun_musaitlik.map((x, j) =>
                              j === i ? { ...x, available_to: e.target.value } : x,
                            );
                            return { ...f, gun_musaitlik: gm };
                          })
                        }
                        style={{ padding: '6px 8px' }}
                      />
                    </div>
                  );
                })}
              </div>

              <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>D) Haftalık izin (seçili hafta)</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {GUN_ADLARI.map((ad, i) => (
                  <label key={ad} style={{ fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={form.haftalik_izin[i]}
                      onChange={(e) =>
                        setForm((f) => {
                          const h = [...f.haftalik_izin];
                          h[i] = e.target.checked;
                          return { ...f, haftalik_izin: h };
                        })
                      }
                    />{' '}
                    {ad}
                  </label>
                ))}
              </div>

              <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>E) Genel bilgi</h3>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Haftalık üst sınır (saat)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    style={{ width: 120 }}
                    value={form.max_weekly_hours}
                    onChange={(e) => setForm((f) => ({ ...f, max_weekly_hours: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Vardiya tipi (planlama)
                  </label>
                  <select
                    value={form.vardiya_tipi}
                    onChange={(e) => setForm((f) => ({ ...f, vardiya_tipi: e.target.value }))}
                  >
                    <option value="FULL">Tam zamanlı</option>
                    <option value="PART">Yarı zamanlı</option>
                  </select>
                </div>
                <label style={{ fontSize: 12, marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.include_in_planning}
                    onChange={(e) => setForm((f) => ({ ...f, include_in_planning: e.target.checked }))}
                  />{' '}
                  Planlamaya dahil
                </label>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>
                Maaş alanı: çalışma türü = <strong>{detay.personel.calisma_turu || '—'}</strong>
              </div>

              <button className="btn btn-primary" onClick={kaydet} disabled={kaydediyor}>
                {kaydediyor ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
