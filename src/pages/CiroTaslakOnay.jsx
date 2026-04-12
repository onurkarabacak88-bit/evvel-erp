import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

export default function CiroTaslakOnay() {
  const [liste, setListe] = useState([]);
  const [msg, setMsg] = useState(null);
  const [duzen, setDuzen] = useState({});
  const [yukleniyor, setYukleniyor] = useState(true);

  const load = () => {
    setYukleniyor(true);
    api('/ciro-taslak?durum=bekliyor')
      .then((d) => { setListe(d); setDuzen({}); })
      .catch((e) => setMsg({ m: e.message, t: 'red' }))
      .finally(() => setYukleniyor(false));
  };

  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 4000);
  };

  function tutarInput(id, alan, deger) {
    setDuzen((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [alan]: deger },
    }));
  }

  function cozumTutarlar(kayit) {
    const d = duzen[kayit.id] || {};
    const nakit = d.nakit !== undefined && d.nakit !== '' ? parseFloat(d.nakit) : parseFloat(kayit.nakit) || 0;
    const pos = d.pos !== undefined && d.pos !== '' ? parseFloat(d.pos) : parseFloat(kayit.pos) || 0;
    const online = d.online !== undefined && d.online !== '' ? parseFloat(d.online) : parseFloat(kayit.online) || 0;
    return { nakit, pos, online };
  }

  async function duzenleKaydet(kayit) {
    const { nakit, pos, online } = cozumTutarlar(kayit);
    if (nakit + pos + online <= 0) {
      toast('En az bir tutar girilmeli', 'red');
      return;
    }
    try {
      await api(`/ciro-taslak/${kayit.id}`, {
        method: 'PATCH',
        body: { nakit, pos, online },
      });
      toast('Taslak güncellendi');
      load();
    } catch (e) {
      toast(e.message, 'red');
    }
  }

  async function onayla(kayit) {
    const { nakit, pos, online } = cozumTutarlar(kayit);
    if (nakit + pos + online <= 0) {
      toast('En az bir tutar girilmeli', 'red');
      return;
    }
    if (!confirm(`${kayit.sube_adi}: ${fmt(nakit + pos + online)} tutarında ciroyu onaylayıp kasaya işleyeceksiniz. Emin misiniz?`)) return;
    try {
      const r = await api(`/ciro-taslak/${kayit.id}/onayla`, {
        method: 'POST',
        body: { nakit, pos, online },
      });
      toast(`Onaylandı — net kasa: ${fmt(r.net_tutar)}`);
      load();
    } catch (e) {
      toast(e.message, 'red');
    }
  }

  async function reddet(kayit) {
    const neden = window.prompt('Red nedeni (isteğe bağlı):', '') ?? '';
    try {
      await api(`/ciro-taslak/${kayit.id}/reddet`, { method: 'POST', body: { neden } });
      toast('Taslak reddedildi — şube yeni taslak gönderebilir', 'yellow');
      load();
    } catch (e) {
      toast(e.message, 'red');
    }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>📋 Ciro taslağı onayı</h2>
          <p>
            Şube personelinden gelen ciro talepleri — ödeme onay kuyruğundan bağımsız.
            WhatsApp’taki X raporu ile karşılaştırın; gerekirse tutarları düzenleyip onaylayın.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load} disabled={yukleniyor}>
          ↻ Yenile
        </button>
      </div>

      {yukleniyor ? (
        <div className="loading"><div className="spinner" />Yükleniyor…</div>
      ) : !liste.length ? (
        <div className="empty">
          <div className="icon">✅</div>
          <p>Bekleyen ciro taslağı yok</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Şube</th>
                <th>Tarih</th>
                <th>Nakit</th>
                <th>POS</th>
                <th>Online</th>
                <th style={{ textAlign: 'right' }}>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {liste.map((k) => {
                const d = duzen[k.id] || {};
                const n = d.nakit !== undefined ? d.nakit : k.nakit;
                const p = d.pos !== undefined ? d.pos : k.pos;
                const o = d.online !== undefined ? d.online : k.online;
                return (
                  <tr key={k.id}>
                    <td><strong>{k.sube_adi}</strong><div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{k.id.slice(0, 8)}…</div></td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(k.tarih)}</td>
                    <td>
                      <input className="form-input" style={{ width: 100, fontSize: 13 }} type="number" min="0" step="1"
                        value={n} onChange={(e) => tutarInput(k.id, 'nakit', e.target.value)} />
                    </td>
                    <td>
                      <input className="form-input" style={{ width: 100, fontSize: 13 }} type="number" min="0" step="1"
                        value={p} onChange={(e) => tutarInput(k.id, 'pos', e.target.value)} />
                    </td>
                    <td>
                      <input className="form-input" style={{ width: 100, fontSize: 13 }} type="number" min="0" step="1"
                        value={o} onChange={(e) => tutarInput(k.id, 'online', e.target.value)} />
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ marginRight: 6 }} onClick={() => duzenleKaydet(k)}>Kaydet</button>
                      <button type="button" className="btn btn-primary btn-sm" style={{ marginRight: 6 }} onClick={() => onayla(k)}>Onayla</button>
                      <button type="button" className="btn btn-sm" onClick={() => reddet(k)}>Reddet</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
