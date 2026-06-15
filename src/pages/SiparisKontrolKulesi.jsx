import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import IslemSonucOverlay from '../components/IslemSonucOverlay';
import { publishGlobalDataRefresh } from '../utils/globalDataRefresh';

const ASAMA_STIL = {
  bekliyor: { renk: '#4a9eff', ikon: '🕐', label: 'Merkez kuyruğu' },
  depoda: { renk: '#f59e0b', ikon: '🏭', label: 'Depoda' },
  yolda: { renk: '#3b82f6', ikon: '🚚', label: 'Yolda' },
  uyumsuzluk: { renk: '#ef4444', ikon: '⚠', label: 'Uyumsuzluk' },
  tamamlandi: { renk: '#22c55e', ikon: '✅', label: 'Tamamlandı' },
  iptal: { renk: '#94a3b8', ikon: '✕', label: 'İptal' },
  gonderilmedi: { renk: '#f97316', ikon: '⊘', label: 'Gönderilmedi' },
};

const DURUM_OPS = [
  { id: 'var', label: '✓ Var' },
  { id: 'yok', label: '✗ Yok' },
  { id: 'kismi', label: '~ Kısmi' },
];

const GUN_SEC = [7, 14, 30, 60, 90];

function kisaTs(ts) {
  if (!ts) return '—';
  const s = String(ts);
  return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
}

function kalemOzet(kalemler) {
  if (!Array.isArray(kalemler) || !kalemler.length) return '—';
  return kalemler
    .filter((k) => k && Number(k.adet ?? k.istenen_adet) > 0)
    .slice(0, 4)
    .map((k) => `${k.urun_ad || k.kalem_kodu || '?'} ×${k.adet ?? k.istenen_adet}`)
    .join(' · ');
}

/** Şube panelinden siparişi onaylayan personel (siparis_talep.personel_ad). */
function siparisGonderenAdi(kayit) {
  const ad = String(kayit?.personel_ad || kayit?.gonderen_ad || '').trim();
  if (ad) return ad;
  const pid = String(kayit?.personel_id || '').trim();
  return pid ? `Personel #${pid.slice(0, 8)}` : null;
}

function SiparisGonderenSatiri({ kayit, style = {} }) {
  const ad = siparisGonderenAdi(kayit);
  if (!ad) return null;
  return (
    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, ...style }}>
      👤 Gönderen: <span style={{ color: 'var(--text2)', fontWeight: 500 }}>{ad}</span>
    </div>
  );
}

// ── Toptancı Modal ──────────────────────────────────────────────────────────
function ToptanciModal({
  sip,
  tedarikciListesi,
  onKapat,
  kuyrukToptanciTedarikci, setKuyrukToptanciTedarikci,
  kuyrukToptanciNot, setKuyrukToptanciNot,
  kuyrukToptanciKalem, setKuyrukToptanciKalem,
  kuyrukToptanciSecili, setKuyrukToptanciSecili,
  kuyrukToptanciAtanmis,
  kuyrukToptanciListeler,
  toptanciListeOlustur,
  toptanciYazdirListe,
  toptanciListeyiGeriAl,
  toptanciyaYolla,
  kalemIstenenAdet,
  kuyrukBusy,
}) {
  const talepId = String(sip?.id || '');
  const detayRows = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
  const listeler = kuyrukToptanciListeler?.[talepId] || [];
  const kalanlar = detayRows.filter((k, i) => {
    const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
    return !kuyrukToptanciAtanmis?.[`${talepId}::${kk}`];
  });
  const herhangiSecili = detayRows.some((k, i) => {
    const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
    return kuyrukToptanciSecili?.[`${talepId}::${kk}`];
  });
  const datalistId = `toptanci-tedarikci-${talepId}`;

  // Modalı kapatmadan önce atanmamış kalem varsa uyar
  const handleKapat = () => {
    if (kalanlar.length > 0 && listeler.length > 0) {
      // En az bir liste oluşturulmuş ama hâlâ atanmamış kalem var
      const devam = window.confirm(
        `⚠️ ${kalanlar.length} kalem henüz bir toptancıya atanmadı.\n\nModalı kapatırsanız bu kalemler kaybolmaz — sipariş kuyrukta kalır ve modalı tekrar açabilirsiniz.\n\nKapatmak için "Tamam" tıklayın.`
      );
      if (!devam) return;
    }
    onKapat();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9900,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }} onClick={(e) => { if (e.target === e.currentTarget) handleKapat(); }}>
      <div style={{
        background: 'var(--bg)',
        borderRadius: 16,
        width: 'min(860px, 100%)',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
        overflow: 'hidden',
      }}>
        {/* ── Başlık ── */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, background: 'var(--bg2)' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', marginBottom: 4 }}>🚚 TOPTANCI SİPARİŞİ</div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>{sip?.sube_adi || '—'}</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 3 }}>
              {String(sip?.olusturma || '').slice(0, 10)} · {detayRows.length} kalem
              {sip?.personel_ad ? <span style={{ marginLeft: 8, color: 'var(--text3)' }}>👤 {sip.personel_ad}</span> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={handleKapat}
            style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text3)', lineHeight: 1, padding: '2px 6px' }}
          >✕</button>
        </div>

        {/* ── İçerik (scrollable) ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Oluşturulan listeler */}
          {listeler.length > 0 && (
            <div style={{ background: '#edf7ed', border: '1px solid #b2dfb2', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1b5e20', marginBottom: 8 }}>
                ✅ Oluşturulan listeler ({listeler.length})
              </div>
              {listeler.map((lst) => (
                <div key={lst.listeNo} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #c8e6c9', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 13 }}>
                    <strong>#{lst.listeNo}</strong> — {lst.toptanciAd}
                    <span style={{ color: '#555', marginLeft: 8, fontSize: 12 }}>{lst.kalemler.length} kalem · {lst.ts}</span>
                  </span>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button type="button" className="btn btn-sm btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }}
                      onClick={() => toptanciYazdirListe(lst, sip.sube_adi || 'Şube', sip.olusturma || '', (kuyrukToptanciNot[talepId] || '').trim(), false)}>
                      👁 Detay
                    </button>
                    <button type="button" className="btn btn-sm btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }}
                      onClick={() => toptanciYazdirListe(lst, sip.sube_adi || 'Şube', sip.olusturma || '', (kuyrukToptanciNot[talepId] || '').trim(), true)}>
                      🖨️ Yazdır
                    </button>
                    <button type="button" className="btn btn-sm" style={{ fontSize: 12, padding: '4px 12px', background: '#fff3f3', color: '#c62828', border: '1px solid #ffcdd2' }}
                      onClick={() => toptanciListeyiGeriAl(sip, lst.listeNo)}>
                      ↩ Geri Al
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Kalem listesi */}
          <div style={{ background: 'var(--bg2)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>
                Kalemler {kalanlar.length < detayRows.length ? `(${kalanlar.length} kalan / ${detayRows.length} toplam)` : `(${detayRows.length})`}
              </span>
              {kalanlar.length > 0 && (
                <button type="button"
                  style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                  onClick={() => setKuyrukToptanciSecili((prev) => {
                    const next = { ...prev };
                    detayRows.forEach((k, i) => {
                      const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
                      const key = `${talepId}::${kk}`;
                      if (!kuyrukToptanciAtanmis?.[key]) next[key] = true;
                    });
                    return next;
                  })}>
                  Tümünü seç
                </button>
              )}
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {detayRows.map((k, i) => {
                const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
                const key = `${talepId}::${kk}`;
                const atanmisNo = kuyrukToptanciAtanmis?.[key];
                const isSecili = kuyrukToptanciSecili?.[key] || false;
                const val = kuyrukToptanciKalem[key] ?? String(kalemIstenenAdet(k));
                return (
                  <div key={key} style={{
                    display: 'grid', gridTemplateColumns: '28px minmax(0,1fr) 80px',
                    gap: 8, alignItems: 'center',
                    opacity: atanmisNo ? 0.4 : 1,
                    padding: '6px 8px',
                    borderRadius: 8,
                    background: isSecili ? 'rgba(34,197,94,0.08)' : 'transparent',
                    border: isSecili ? '1px solid rgba(34,197,94,0.25)' : '1px solid transparent',
                  }}>
                    <input type="checkbox"
                      style={{ width: 18, height: 18, cursor: atanmisNo ? 'default' : 'pointer', accentColor: 'var(--accent)' }}
                      checked={!!isSecili} disabled={!!atanmisNo}
                      onChange={(e) => setKuyrukToptanciSecili((prev) => ({ ...prev, [key]: e.target.checked }))}
                    />
                    <span style={{ fontSize: 14, textDecoration: atanmisNo ? 'line-through' : 'none' }}>
                      {k.urun_ad || k.ad || kk}
                      {atanmisNo ? <span style={{ fontSize: 11, color: '#2a7a2a', marginLeft: 6 }}>→ Liste #{atanmisNo}</span> : null}
                    </span>
                    <input className="input" inputMode="numeric"
                      style={{ fontSize: 14, padding: '6px 8px', textAlign: 'center', fontWeight: 700 }}
                      value={val} disabled={!!atanmisNo}
                      onChange={(e) => {
                        const v = String(e.target.value || '').replace(/[^\d]/g, '');
                        setKuyrukToptanciKalem((prev) => ({ ...prev, [key]: v }));
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Toptancı seç + Liste oluştur */}
          {herhangiSecili && (
            <div style={{ background: 'var(--bg2)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>Seçilen kalemleri hangi toptancıya gönderiyorsunuz?</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input
                    className="input"
                    list={datalistId}
                    style={{ width: '100%', fontSize: 14, padding: '8px 12px' }}
                    placeholder="Toptancı seç veya yaz…"
                    value={kuyrukToptanciTedarikci[talepId] || ''}
                    onChange={(e) => setKuyrukToptanciTedarikci((prev) => ({ ...prev, [talepId]: e.target.value }))}
                  />
                  <datalist id={datalistId}>
                    {(tedarikciListesi || []).map((t) => (
                      <option key={t.id} value={t.ad} />
                    ))}
                  </datalist>
                </div>
                <button type="button" className="btn btn-primary"
                  style={{ whiteSpace: 'nowrap', fontSize: 14, padding: '8px 18px' }}
                  onClick={() => toptanciListeOlustur(sip)}>
                  📋 Liste Oluştur & Yazdır
                </button>
              </div>
            </div>
          )}

          {/* Not */}
          <div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>Genel sipariş notu (isteğe bağlı)</div>
            <textarea className="input" rows={2}
              style={{ fontSize: 13, resize: 'vertical', width: '100%' }}
              value={kuyrukToptanciNot[talepId] || ''}
              onChange={(e) => setKuyrukToptanciNot((prev) => ({ ...prev, [talepId]: e.target.value }))}
            />
          </div>
        </div>

        {/* ── Alt butonlar ── */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" style={{ fontSize: 14 }} onClick={handleKapat}>
            Kapat
          </button>
          <button type="button" className="btn btn-primary"
            style={{ fontSize: 14, padding: '10px 24px', opacity: listeler.length === 0 ? 0.45 : 1 }}
            disabled={kuyrukBusy === talepId || listeler.length === 0}
            onClick={async () => { await toptanciyaYolla(sip); onKapat(); }}>
            {kuyrukBusy === talepId
              ? '⏳ Kaydediliyor…'
              : `⇢ Toptancıya Yolla & Şubeye Bildir${listeler.length > 0 ? ` (${listeler.length} liste)` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function KuyrukYonlendirmeKarti({
  sip,
  depolar,
  mod,
  onModChange,
  kuyrukDepo,
  setKuyrukDepo,
  kuyrukTalimat,
  setKuyrukTalimat,
  kuyrukToptanciListeler,
  kuyrukToptanciNot,
  kuyrukBusy,
  depoyaGonder,
  toptanciyaYolla,
  onToptanciModalAc,
}) {
  const talepId = String(sip?.id || '');
  const listeler = kuyrukToptanciListeler?.[talepId] || [];
  return (
    <>
      <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
        {[
          { id: 'depo', label: '🏭 Depo sevk' },
          { id: 'toptanci', label: '🚚 Toptancı' },
        ].map((m) => (
          <button
            key={m.id}
            type="button"
            className={`btn btn-sm ${mod === m.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => onModChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mod === 'depo' ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            className="input"
            rows={2}
            placeholder="Operasyon talimatı (isteğe bağlı)"
            style={{ fontSize: 11, resize: 'vertical' }}
            value={kuyrukTalimat[talepId] || ''}
            onChange={(e) => setKuyrukTalimat((p) => ({ ...p, [talepId]: e.target.value }))}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select
              className="input"
              style={{ flex: 1, minWidth: 120, fontSize: 12 }}
              value={kuyrukDepo[talepId] || ''}
              onChange={(e) => setKuyrukDepo((p) => ({ ...p, [talepId]: e.target.value }))}
            >
              <option value="">Hedef depo seç…</option>
              {depolar.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.ad}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={kuyrukBusy === talepId || !kuyrukDepo[talepId]}
              onClick={() => depoyaGonder(talepId)}
            >
              Depoya yönlendir
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Özet: kaç liste var */}
          {listeler.length > 0 ? (
            <div style={{ background: '#edf7ed', border: '1px solid #b2dfb2', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
              <div style={{ fontWeight: 700, color: '#1b5e20', marginBottom: 4 }}>✅ {listeler.length} liste hazır</div>
              {listeler.map((l) => (
                <div key={l.listeNo} style={{ color: '#2e7d32' }}>#{l.listeNo} {l.toptanciAd} — {l.kalemler.length} kalem</div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>Henüz liste oluşturulmadı.</div>
          )}
          {/* Modalı aç */}
          <button type="button" className="btn btn-sm btn-secondary" onClick={onToptanciModalAc}>
            🚚 Toptancı Siparişini Düzenle
          </button>
          {/* Son gönder */}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={kuyrukBusy === talepId || listeler.length === 0}
            onClick={() => toptanciyaYolla(sip)}
          >
            {kuyrukBusy === talepId
              ? '⏳ Kaydediliyor…'
              : listeler.length > 0
                ? `⇢ Toptancıya Yolla & Şubeye Bildir (${listeler.length} liste)`
                : '⇢ Toptancıya Yolla & Şubeye Bildir'}
          </button>
        </div>
      )}
    </>
  );
}

export default function SiparisKontrolKulesi({ vurgulaTalepId: vurgulaProp = null }) {
  const [vurgulaId, setVurgulaId] = useState(vurgulaProp);

  useEffect(() => {
    if (vurgulaProp) {
      setVurgulaId(vurgulaProp);
      return;
    }
    try {
      const tid = sessionStorage.getItem('ops_siparis_vurgula_talep');
      if (tid) {
        sessionStorage.removeItem('ops_siparis_vurgula_talep');
        setVurgulaId(tid);
      }
      const gv = sessionStorage.getItem('ops_kontrol_kulesi_gorunum');
      const dep = sessionStorage.getItem('ops_kontrol_kulesi_depo');
      if (gv === 'depo') {
        sessionStorage.removeItem('ops_kontrol_kulesi_gorunum');
        setGorunum('depo');
      }
      if (dep) {
        sessionStorage.removeItem('ops_kontrol_kulesi_depo');
        setDepoFiltre(dep);
      }
    } catch (_) {}
  }, [vurgulaProp]);
  const [msg, setMsg] = useState(null);
  const toast = useCallback((m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  }, []);

  const [gorunum, setGorunum] = useState('izleme'); // izleme | depo | urun
  const [gun, setGun] = useState(30);
  const [asamaFiltre, setAsamaFiltre] = useState('');
  const [sadeceAcik, setSadeceAcik] = useState(true);
  const [subeArama, setSubeArama] = useState('');
  const [depoFiltre, setDepoFiltre] = useState('');
  const [talepArama, setTalepArama] = useState('');
  const [yukleniyor, setYukleniyor] = useState(true);
  const [veri, setVeri] = useState(null);
  const [secili, setSecili] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [tlYukleniyor, setTlYukleniyor] = useState(false);

  const [bekleyen, setBekleyen] = useState(null);
  const [depolar, setDepolar] = useState([]);
  const [kuyrukDepo, setKuyrukDepo] = useState({});
  const [kuyrukTalimat, setKuyrukTalimat] = useState({});
  const [kuyrukMod, setKuyrukMod] = useState({}); // talep_id → depo | toptanci
  const [kuyrukToptanciTedarikci, setKuyrukToptanciTedarikci] = useState({}); // talep_id -> aktif toptancı adı
  const [kuyrukToptanciNot, setKuyrukToptanciNot] = useState({});
  const [kuyrukToptanciKalem, setKuyrukToptanciKalem] = useState({}); // `${talep_id}::${kk}` → adet override
  const [kuyrukToptanciSecili, setKuyrukToptanciSecili] = useState({});   // `${talep_id}::${kk}` → bool
  const [kuyrukToptanciAtanmis, setKuyrukToptanciAtanmis] = useState({}); // `${talep_id}::${kk}` → listeNo
  const [kuyrukToptanciListeler, setKuyrukToptanciListeler] = useState({}); // talep_id → [{listeNo,toptanciAd,kalemler,ts}]
  const [toptanciModalSip, setToptanciModalSip] = useState(null); // modal için açık sip | null
  const [tedarikciListesi, setTedarikciListesi] = useState([]);
  const [kuyrukBusy, setKuyrukBusy] = useState(null);
  const [iptalBusy, setIptalBusy] = useState(null);
  const [islemSonuc, setIslemSonuc] = useState(null); // { basarili, mesaj }

  // ── Birleştirme seçimi ──────────────────────────────────────
  const [birlestirSecili, setBirlestirSecili] = useState({}); // talep_id → sube_id
  const [birlestirNot, setBirlestirNot] = useState('');
  const [birlestirBusy, setBirlestirBusy] = useState(false);

  const [uyumsuzluklar, setUyumsuzluklar] = useState([]);
  const [urunArama, setUrunArama] = useState('');
  const [urunGecmis, setUrunGecmis] = useState(null);

  // Depo hazırlık
  const [depoListe, setDepoListe] = useState([]);
  const [depoSecili, setDepoSecili] = useState(null);
  const [depoKalem, setDepoKalem] = useState({});
  const [depoNot, setDepoNot] = useState('');
  const [depoBusy, setDepoBusy] = useState(false);
  const [depoDurumFiltre, setDepoDurumFiltre] = useState('hazirlaniyor');

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const q = new URLSearchParams({
        gun: String(gun),
        sadece_acik: sadeceAcik ? 'true' : 'false',
        limit: '500',
      });
      if (asamaFiltre) q.set('asama', asamaFiltre);
      if (subeArama.trim()) q.set('sube_arama', subeArama.trim());
      if (depoFiltre) q.set('depo_sube_id', depoFiltre);
      if (talepArama.trim()) q.set('talep_arama', talepArama.trim());

      const [kk, bek, dep, uy] = await Promise.all([
        api(`/ops/siparis/kontrol-kulesi?${q}`),
        api(`/ops/v2/bekleyen-siparisler?gun=${Math.min(30, gun)}`).catch(() => ({ siparisler: [] })),
        api('/ops/subeler/depolar').then((r) => r?.satirlar || []).catch(() => []),
        api(`/ops/siparis/sevkiyat-uyumsuzluklar?gun=${gun}&limit=120`).catch(() => ({ satirlar: [] })),
      ]);
      setVeri(kk);
      setBekleyen(bek);
      setDepolar(Array.isArray(dep) ? dep : []);
      setUyumsuzluklar(Array.isArray(uy?.satirlar) ? uy.satirlar : []);
    } catch (e) {
      toast(e.message || 'Kontrol kulesi yüklenemedi', 'red');
    } finally {
      setYukleniyor(false);
    }
  }, [gun, asamaFiltre, sadeceAcik, subeArama, depoFiltre, talepArama, toast]);

  const yukleDepoListe = useCallback(async () => {
    try {
      const qs = `durum=${encodeURIComponent(depoDurumFiltre)}&gun=${gun}${
        depoFiltre ? `&sevkiyat_sube_id=${encodeURIComponent(depoFiltre)}` : ''
      }`;
      const ls = await api(`/ops/siparis/sevkiyat-listesi?${qs}`);
      setDepoListe(ls?.satirlar || []);
    } catch (e) {
      toast(e.message || 'Depo listesi yüklenemedi', 'red');
    }
  }, [depoDurumFiltre, depoFiltre, gun, toast]);

  useEffect(() => {
    yukle();
  }, [yukle]);

  useEffect(() => {
    api('/tedarikciler?aktif=true')
      .then((r) => setTedarikciListesi(r.tedarikciler || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (gorunum === 'depo') yukleDepoListe();
  }, [gorunum, yukleDepoListe]);

  useEffect(() => {
    const tid = vurgulaId;
    if (!tid || !veri?.satirlar?.length) return;
    const s = veri.satirlar.find((x) => x.id === tid);
    if (s) setSecili(s);
  }, [vurgulaId, veri]);

  useEffect(() => {
    if (!secili?.id) {
      setTimeline(null);
      return;
    }
    let cancel = false;
    setTlYukleniyor(true);
    api(`/ops/v2/siparis/${encodeURIComponent(secili.id)}/timeline`)
      .then((r) => {
        if (!cancel) setTimeline(r);
      })
      .catch(() => {
        if (!cancel) setTimeline(null);
      })
      .finally(() => {
        if (!cancel) setTlYukleniyor(false);
      });
    return () => {
      cancel = true;
    };
  }, [secili?.id]);

  useEffect(() => {
    if (!depoSecili) return;
    const next = {};
    (depoSecili.kalemler || []).forEach((k, i) => {
      const key = `${k?.urun_id || ''}:${k?.urun_ad || ''}:${i}`;
      next[key] = {
        urun_id: k?.urun_id || null,
        urun_ad: k?.urun_ad || null,
        durum: 'var',
        gonderilen_adet: Number(k?.adet || 0),
        not_aciklama: '',
      };
    });
    (depoSecili.kalem_durumlari || []).forEach((d) => {
      const idx = (depoSecili.kalemler || []).findIndex(
        (k) => (k?.urun_id || '') === (d?.urun_id || '') && (k?.urun_ad || '') === (d?.urun_ad || ''),
      );
      const key =
        idx >= 0
          ? `${depoSecili.kalemler[idx]?.urun_id || ''}:${depoSecili.kalemler[idx]?.urun_ad || ''}:${idx}`
          : `${d?.urun_id || ''}:${d?.urun_ad || ''}:x`;
      next[key] = {
        urun_id: d?.urun_id || null,
        urun_ad: d?.urun_ad || null,
        durum: d?.durum || 'var',
        gonderilen_adet: Number(d?.gonderilen_adet || 0),
        not_aciklama: d?.not_aciklama || '',
      };
    });
    setDepoKalem(next);
    setDepoNot(depoSecili?.sevkiyat_notu || '');
  }, [depoSecili]);

  const ozet = veri?.ozet || {};
  const satirlar = veri?.satirlar || [];
  const bekleyenListe = bekleyen?.siparisler || [];

  const pipelineAdimlar = useMemo(
    () => [
      { key: 'bekliyor', ...ASAMA_STIL.bekliyor, adet: ozet.bekliyor || 0 },
      { key: 'depoda', ...ASAMA_STIL.depoda, adet: ozet.depoda || 0 },
      { key: 'yolda', ...ASAMA_STIL.yolda, adet: ozet.yolda || 0 },
      { key: 'uyumsuzluk', ...ASAMA_STIL.uyumsuzluk, adet: ozet.uyumsuzluk || 0 },
    ],
    [ozet],
  );

  const kalemIstenenAdet = (k) => Math.max(0, Number(k?.istenen_adet ?? k?.adet ?? 0));

  const iptalEdilebilirAsama = (asama) => asama === 'yolda' || asama === 'depoda';

  const akisiIptal = async (talepId, subeAd, asama) => {
    const tid = String(talepId || '').trim();
    if (!tid) return;
    const etiket = ASAMA_STIL[asama]?.label || asama || 'sipariş';
    if (
      !window.confirm(
        `${subeAd || 'Bu sipariş'} — ${etiket} aşamasında iptal edilsin mi?\n\nYolda paketler kaldırılır; sevk edilmiş adetler kaynak depoya iade edilir.`,
      )
    ) {
      return;
    }
    const aciklama = window.prompt('İptal nedeni (isteğe bağlı):', '') ?? '';
    if (aciklama === null) return;
    setIptalBusy(tid);
    try {
      const r = await api('/ops/siparis/akisi-iptal', {
        method: 'POST',
        body: { talep_id: tid, aciklama: aciklama.trim() || undefined },
      });
      if (secili?.id === tid) setSecili(null);
      publishGlobalDataRefresh('siparis-akisi-iptal');
      islemSonucGoster(
        true,
        r?.geri_verilen_adet
          ? `Sipariş iptal edildi — ${r.geri_verilen_adet} adet kaynak depoya iade edildi.`
          : 'Sipariş iptal edildi.',
      );
      yukle();
    } catch (e) {
      islemSonucGoster(false, e.message || 'İptal edilemedi');
    } finally {
      setIptalBusy(null);
    }
  };

  const kuyrukTalepTemizle = useCallback((talepId) => {
    const tid = String(talepId || '');
    if (!tid) return;
    setBekleyen((prev) => {
      const liste = Array.isArray(prev?.siparisler) ? prev.siparisler : [];
      const yeni = liste.filter((s) => String(s?.id || '') !== tid);
      if (yeni.length === liste.length) return prev;
      return { ...prev, siparisler: yeni, toplam: yeni.length };
    });
    setVeri((prev) => {
      if (!prev?.ozet || prev.ozet.bekliyor == null) return prev;
      return {
        ...prev,
        ozet: { ...prev.ozet, bekliyor: Math.max(0, Number(prev.ozet.bekliyor || 0) - 1) },
      };
    });
    setKuyrukDepo((p) => {
      const n = { ...p };
      delete n[tid];
      return n;
    });
    setKuyrukTalimat((p) => {
      const n = { ...p };
      delete n[tid];
      return n;
    });
    setKuyrukMod((p) => {
      const n = { ...p };
      delete n[tid];
      return n;
    });
    setKuyrukToptanciTedarikci((p) => {
      const n = { ...p };
      delete n[tid];
      return n;
    });
    setKuyrukToptanciNot((p) => {
      const n = { ...p };
      delete n[tid];
      return n;
    });
    setKuyrukToptanciKalem((p) => {
      const n = { ...p };
      Object.keys(n).forEach((k) => {
        if (k.startsWith(`${tid}::`)) delete n[k];
      });
      return n;
    });
    if (secili?.id === tid) setSecili(null);
  }, [secili?.id]);

  const islemSonucGoster = useCallback((basarili, mesaj) => {
    setIslemSonuc({ basarili, mesaj });
  }, []);

  // Birleştirme işlemi
  const secilenIdler = Object.keys(birlestirSecili);
  const secilenSubeIdler = [...new Set(Object.values(birlestirSecili))];
  const birlestirAktif = secilenIdler.length >= 2 && secilenSubeIdler.length === 1;

  const birlestirToggle = (talepId, subeId) => {
    setBirlestirSecili((prev) => {
      const next = { ...prev };
      if (next[talepId]) {
        delete next[talepId];
      } else {
        next[talepId] = subeId;
      }
      return next;
    });
  };

  const birlestirTemizle = () => {
    setBirlestirSecili({});
    setBirlestirNot('');
  };

  const birlestirGonder = async () => {
    if (!birlestirAktif) return;
    if (!window.confirm(`${secilenIdler.length} sipariş tek siparişe birleştirilecek. Eski siparişler iptal edilir. Devam?`)) return;
    setBirlestirBusy(true);
    try {
      const r = await api('/ops/siparis/birlestir', {
        method: 'POST',
        body: {
          talep_idler: secilenIdler,
          not_aciklama: birlestirNot.trim() || null,
        },
      });
      birlestirTemizle();
      publishGlobalDataRefresh('siparis-birlestir');
      islemSonucGoster(
        true,
        `${r.birlesik_talep_sayisi} sipariş birleştirildi → ${r.kalem_sayisi} kalem · Yeni: #${String(r.yeni_talep_id).slice(-8)}`
      );
      yukle();
    } catch (e) {
      islemSonucGoster(false, e.message || 'Birleştirme başarısız');
    } finally {
      setBirlestirBusy(false);
    }
  };

  const depoyaGonder = async (talepId) => {
    const depo = kuyrukDepo[talepId];
    if (!depo) {
      toast('Önce hedef depo seçin', 'red');
      return;
    }
    setKuyrukBusy(talepId);
    try {
      const body = { talep_id: talepId, hedef_depo_sube_id: depo };
      const tal = (kuyrukTalimat[talepId] || '').trim();
      if (tal) body.operasyon_yonlendirme_talimati = tal;
      await api('/ops/siparis/sevkiyata-gonder', { method: 'POST', body });
      kuyrukTalepTemizle(talepId);
      publishGlobalDataRefresh('siparis-kontrol-depo-yonlendir');
      islemSonucGoster(true, 'Sipariş depoya yönlendirildi — merkez kuyruğundan çıktı.');
      yukle();
    } catch (e) {
      islemSonucGoster(false, e.message || 'Yönlendirme hatası');
    } finally {
      setKuyrukBusy(null);
    }
  };

  // Tek liste için temiz yazdırma penceresi
  const toptanciYazdirListe = (liste, subeAd, tarih, notAciklama, yazdirMi = true) => {
    const satirlar = liste.kalemler.map((k, idx) =>
      `<tr><td style="padding:12px 14px;font-size:18px;border-bottom:1px solid #e0e0e0">${idx + 1}. ${k.urun_ad || '—'}</td><td style="padding:12px 16px;font-size:22px;font-weight:900;text-align:right;border-bottom:1px solid #e0e0e0">× ${k.adet || 0}</td></tr>`
    ).join('');
    const printScript = yazdirMi ? `<script>window.onload=function(){window.print()};<\/script>` : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${liste.toptanciAd} — ${subeAd}</title>
      <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#fff;font-family:Arial,sans-serif}@media print{@page{margin:12mm}}</style>
      </head><body><div style="padding:40px 44px;max-width:640px">
      <div style="border-bottom:3px solid #111;padding-bottom:16px;margin-bottom:24px">
        <div style="font-size:11px;color:#888;letter-spacing:0.1em;margin-bottom:8px">TOPTANCI SİPARİŞ LİSTESİ · Liste #${liste.listeNo}</div>
        <div style="font-size:26px;font-weight:900">${subeAd}</div>
        <div style="font-size:20px;font-weight:800;margin-top:8px">▸ ${liste.toptanciAd}</div>
        <div style="font-size:13px;color:#666;margin-top:10px">📅 ${String(tarih || '').slice(0, 10)} · ${liste.ts || ''}</div>
      </div>
      <table style="width:100%;border-collapse:collapse">${satirlar}</table>
      ${notAciklama ? `<div style="margin-top:24px;padding:12px 14px;background:#f5f5f5;border-radius:8px;font-size:13px;color:#555">Not: ${notAciklama}</div>` : ''}
      <div style="margin-top:28px;border-top:1px solid #ccc;padding-top:12px;font-size:12px;color:#aaa">
        ${liste.kalemler.length} kalem · ${liste.kalemler.reduce((a, k) => a + (k.adet || 0), 0)} toplam adet
      </div></div>
      ${printScript}</body></html>`;
    const w = window.open('', '_blank', 'width=700,height=920');
    if (!w) { toast('Popup engellendi — tarayıcı izin ayarlarını kontrol edin.', 'red'); return; }
    w.document.write(html); w.document.close();
  };

  // Seçili kalemleri toptancı listesine ekle + ekrandan kaldır + otomatik yazdır
  const toptanciListeOlustur = (sip) => {
    const talepId = String(sip?.id || '');
    const toptanciAd = (kuyrukToptanciTedarikci[talepId] || '').trim();
    if (!toptanciAd) { toast('Önce toptancı adını girin.', 'red'); return; }
    // Yazılan/seçilen adı kayıtlı tedarikçiyle eşleştir → id + telefon yakala.
    // Telefon WhatsApp gönderimi için zorunlu (kullanıcı kararı: telefon yoksa blokla).
    const eslesen = (tedarikciListesi || []).find(
      (t) => String(t.ad || '').trim().toLowerCase() === toptanciAd.toLowerCase()
    );
    let tedarikciId = null;
    let tedarikciTel = null;
    let tedarikciAdFinal = toptanciAd;
    if (eslesen) {
      tedarikciId = String(eslesen.id);
      tedarikciTel = String(eslesen.telefon || '').trim();
      tedarikciAdFinal = String(eslesen.ad || toptanciAd);
      if (!tedarikciTel) {
        toast(`"${tedarikciAdFinal}" için telefon numarası yok. WhatsApp ile sipariş gönderebilmek için Tedarikçiler ekranından numara ekleyin.`, 'red');
        return;
      }
    } else {
      const devam = window.confirm(
        `"${toptanciAd}" kayıtlı tedarikçi değil.\n\nWhatsApp ile sipariş GÖNDERİLEMEZ; yalnızca liste/kayıt oluşturulur.\n\nYine de devam edilsin mi?\n(WhatsApp için listeden kayıtlı bir tedarikçi seçin.)`
      );
      if (!devam) return;
    }
    const rows = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
    const kalemler = [];
    rows.forEach((k, i) => {
      const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
      const key = `${talepId}::${kk}`;
      if (!kuyrukToptanciSecili[key]) return;
      if (kuyrukToptanciAtanmis[key]) return;
      const adetRaw = kuyrukToptanciKalem[key] ?? String(kalemIstenenAdet(k));
      const adet = Math.max(0, parseInt(String(adetRaw), 10) || 0);
      if (adet <= 0) return;
      kalemler.push({ urun_ad: String(k?.urun_ad || k?.ad || kk), adet, kalem_kodu: kk, kategori_kod: String(k?.kategori_kod || '').trim() || null });
    });
    if (!kalemler.length) { toast('Hiç kalem seçilmedi ya da adetler 0.', 'red'); return; }
    const listeNo = (kuyrukToptanciListeler[talepId] || []).length + 1;
    const yeniListe = { listeNo, toptanciAd: tedarikciAdFinal, tedarikciId, tedarikciTel, kalemler, ts: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) };
    setKuyrukToptanciListeler(prev => ({ ...prev, [talepId]: [...(prev[talepId] || []), yeniListe] }));
    setKuyrukToptanciAtanmis(prev => {
      const next = { ...prev };
      kalemler.forEach(k => { next[`${talepId}::${k.kalem_kodu}`] = listeNo; });
      return next;
    });
    setKuyrukToptanciSecili(prev => {
      const next = { ...prev };
      kalemler.forEach(k => { next[`${talepId}::${k.kalem_kodu}`] = false; });
      return next;
    });
    setKuyrukToptanciTedarikci(prev => ({ ...prev, [talepId]: '' }));
    toptanciYazdirListe(yeniListe, sip.sube_adi || 'Şube', sip.olusturma || '', (kuyrukToptanciNot[talepId] || '').trim());
  };

  // Oluşturulan bir listeyi geri al — kalemler tekrar serbest, liste siliniyor
  const toptanciListeyiGeriAl = (sip, listeNo) => {
    const talepId = String(sip?.id || '');
    const hedefListe = (kuyrukToptanciListeler[talepId] || []).find(l => l.listeNo === listeNo);
    if (!hedefListe) return;
    setKuyrukToptanciListeler(prev => ({
      ...prev,
      [talepId]: (prev[talepId] || []).filter(l => l.listeNo !== listeNo),
    }));
    setKuyrukToptanciAtanmis(prev => {
      const next = { ...prev };
      hedefListe.kalemler.forEach(k => { delete next[`${talepId}::${k.kalem_kodu}`]; });
      return next;
    });
    setKuyrukToptanciSecili(prev => {
      const next = { ...prev };
      hedefListe.kalemler.forEach(k => { delete next[`${talepId}::${k.kalem_kodu}`]; });
      return next;
    });
    toast(`Liste #${listeNo} (${hedefListe.toptanciAd}) geri alındı — kalemler tekrar seçilebilir.`, 'green');
  };

  // Son adım: tüm listeler sisteme kaydedilir, şubeye bildirim gider
  const toptanciyaYolla = async (sip) => {
    const talepId = String(sip?.id || '').trim();
    if (!talepId) return;
    const listeler = kuyrukToptanciListeler[talepId] || [];
    if (!listeler.length) { toast('Önce en az bir liste oluşturun.', 'red'); return; }

    // Atanmamış kalem kontrolü — bazı kalemler hiç listeye eklenmeden geçilirse uyar
    const tumKalemler = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
    const atanmamisSayisi = tumKalemler.filter((k, i) => {
      const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
      return !kuyrukToptanciAtanmis[`${talepId}::${kk}`];
    }).length;
    if (atanmamisSayisi > 0) {
      const devamMi = window.confirm(
        `⚠️ ${atanmamisSayisi} kalem hiçbir toptancıya atanmadı.\n\nModalı kapatıp eksik kalemleri tamamlamak ister misiniz?\n\nDevam etmek için "Tamam", iptal için "İptal" tıklayın.`
      );
      if (!devamMi) return;
    }

    // WhatsApp önizleme/onay — hangi tedarikçilere mesaj gidecek (dışa açık aksiyon)
    const waGidecek = listeler.filter(l => l.tedarikciId && l.tedarikciTel);
    const waYok = listeler.filter(l => !(l.tedarikciId && l.tedarikciTel));
    let onayMsg = '';
    if (waGidecek.length) {
      onayMsg += `📲 WhatsApp ile sipariş gidecek:\n` + waGidecek.map(l => `  • ${l.toptanciAd} (${l.kalemler.length} kalem)`).join('\n') + '\n\n';
    }
    if (waYok.length) {
      onayMsg += `⚠️ WhatsApp GÖNDERİLMEYECEK (kayıtsız/telefonsuz):\n` + waYok.map(l => `  • ${l.toptanciAd}`).join('\n') + '\n\n';
    }
    onayMsg += 'Onaylıyor musunuz?';
    if (!window.confirm(onayMsg)) return;

    setKuyrukBusy(talepId);
    try {
      let toplamAdet = 0;
      let waBasarili = 0;
      for (const liste of listeler) {
        const r = await api('/ops/siparis/toptanciya-yolla', {
          method: 'POST',
          body: {
            talep_id: talepId,
            tedarikci_id: liste.tedarikciId || null,
            tedarikci_ad: liste.toptanciAd,
            not_aciklama: (kuyrukToptanciNot[talepId] || '').trim() || null,
            kalemler: liste.kalemler,
          },
        });
        toplamAdet += Number(r?.toplam_adet || 0);
        if (r?.wa_basarili) waBasarili += 1;
      }
      kuyrukTalepTemizle(talepId);
      publishGlobalDataRefresh('siparis-kontrol-toptanci-yonlendir');
      const adlar = listeler.map(l => l.toptanciAd).join(', ');
      const waNot = waBasarili ? ` · 📲 ${waBasarili} tedarikçiye WhatsApp gönderildi` : '';
      islemSonucGoster(true, `${listeler.length} toptancıya yönlendirildi (${adlar}) — ${toplamAdet} adet · kuyruktan düştü${waNot}.`);
      yukle();
    } catch (e) {
      islemSonucGoster(false, e.message || 'Toptancıya gönderim hatası');
    } finally {
      setKuyrukBusy(null);
    }
  };

  const depoKaydet = async (gonderildi = false) => {
    if (!depoSecili) return;
    const payload = Object.values(depoKalem);
    if (!payload.length) {
      toast('Kalem durumu seçin', 'red');
      return;
    }
    const sevkVar = payload.some((x) => {
      const d = String(x.durum || '').toLowerCase();
      return (d === 'var' || d === 'kismi') && Number(x.gonderilen_adet || 0) > 0;
    });
    if (gonderildi && !sevkVar) {
      toast('Yola çıkarmak için en az bir kalemde «var/kısmi» ve gönderilen adet girin.', 'red');
      return;
    }
    if (!gonderildi && sevkVar) {
      toast(
        'Gönderilen adet girilmiş kalemler var — «Yola çıkar» ile sevk edin. Hazırlık kaydı yalnızca bekliyor / yok / not içindir.',
        'red',
      );
      return;
    }
    setDepoBusy(true);
    try {
      await api('/ops/siparis/sevkiyat-guncelle', {
        method: 'POST',
        body: {
          talep_id: depoSecili.id,
          hedef_depo_sube_id: depoSecili.hedef_depo_sube_id || depoSecili.sevkiyat_sube_id,
          kalem_durumlari: payload,
          sevkiyat_notu: (depoNot || '').trim() || null,
          gonderildi,
        },
      });
      toast(
        gonderildi
          ? 'Yola çıkarıldı — talep şubesinde «Depodan Gelen» açıldı'
          : 'Hazırlık kaydedildi (stok çıkmadı)',
      );
      yukleDepoListe();
      yukle();
      setDepoSecili(null);
    } catch (e) {
      toast(e.message || 'Kayıt başarısız', 'red');
    } finally {
      setDepoBusy(false);
    }
  };

  const urunAra = async () => {
    const q = urunArama.trim();
    if (q.length < 2) {
      toast('En az 2 karakter girin', 'red');
      return;
    }
    try {
      const r = await api(
        `/ops/siparis/urun-gecmis?urun=${encodeURIComponent(q)}&gun=${gun}&limit=80`,
      );
      setUrunGecmis(r);
    } catch (e) {
      toast(e.message || 'Ürün geçmişi yüklenemedi', 'red');
    }
  };

  const uyumCoz = async (row) => {
    const yid = String(row?.stok_yolda_id || row?.id || '').trim();
    if (!yid) {
      toast('Stok yolda kaydı bulunamadı — listeyi yenileyin', 'red');
      return;
    }
    const cozum = window.prompt(
      `Uzlaşma adedi (sevk: ${row.sevk_adet}, kabul: ${row.kabul_adet}):`,
      String(row.kabul_adet ?? row.sevk_adet ?? 0),
    );
    if (cozum === null) return;
    const cozumAdet = Number(cozum);
    if (!Number.isFinite(cozumAdet) || cozumAdet < 0) {
      toast('Geçerli bir adet girin (0 veya üzeri)', 'red');
      return;
    }
    try {
      await api('/ops/siparis/sevkiyat-uyumsuzluk-coz', {
        method: 'POST',
        body: {
          stok_yolda_id: yid,
          cozum_adet: cozumAdet,
        },
      });
      toast('Uyumsuzluk kaydı güncellendi');
      yukle();
    } catch (e) {
      toast(e.message || 'Çözüm kaydedilemedi', 'red');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {islemSonuc && (
        <IslemSonucOverlay
          basarili={islemSonuc.basarili}
          mesaj={islemSonuc.mesaj}
          sureMs={5000}
          onKapat={() => setIslemSonuc(null)}
        />
      )}
      {toptanciModalSip && (
        <ToptanciModal
          sip={toptanciModalSip}
          tedarikciListesi={tedarikciListesi}
          onKapat={() => setToptanciModalSip(null)}
          kuyrukToptanciTedarikci={kuyrukToptanciTedarikci}
          setKuyrukToptanciTedarikci={setKuyrukToptanciTedarikci}
          kuyrukToptanciNot={kuyrukToptanciNot}
          setKuyrukToptanciNot={setKuyrukToptanciNot}
          kuyrukToptanciKalem={kuyrukToptanciKalem}
          setKuyrukToptanciKalem={setKuyrukToptanciKalem}
          kuyrukToptanciSecili={kuyrukToptanciSecili}
          setKuyrukToptanciSecili={setKuyrukToptanciSecili}
          kuyrukToptanciAtanmis={kuyrukToptanciAtanmis}
          kuyrukToptanciListeler={kuyrukToptanciListeler}
          toptanciListeOlustur={toptanciListeOlustur}
          toptanciYazdirListe={toptanciYazdirListe}
          toptanciListeyiGeriAl={toptanciListeyiGeriAl}
          toptanciyaYolla={toptanciyaYolla}
          kalemIstenenAdet={kalemIstenenAdet}
          kuyrukBusy={kuyrukBusy}
        />
      )}
      {msg && <div className={`alert-box ${msg.t} mb-8`}>{msg.m}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, flex: '1 1 200px' }}>
          📡 Sipariş Kontrol Kulesi
        </h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { id: 'izleme', label: 'İzleme & Kuyruk' },
            { id: 'depo', label: 'Depo hazırlık' },
            { id: 'urun', label: 'Ürün geçmişi' },
          ].map((g) => (
            <button
              key={g.id}
              type="button"
              className={`btn btn-sm ${gorunum === g.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setGorunum(g.id)}
            >
              {g.label}
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-secondary" onClick={yukle} disabled={yukleniyor}>
            ↺ Yenile
          </button>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)', lineHeight: 1.5 }}>
        Tüm şubelerin sipariş taleplerini tek ekranda izleyin: kuyruk → depo veya toptancı → yol → kabul. Merkez kuyruğunda her talep için «Depo sevk» veya «Toptancı» sekmesini kullanın.
      </p>

      {gorunum === 'izleme' && (
        <>
          {/* Pipeline özeti */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
            }}
          >
            {pipelineAdimlar.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setAsamaFiltre(asamaFiltre === p.key ? '' : p.key)}
                style={{
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: `2px solid ${asamaFiltre === p.key ? p.renk : 'var(--border)'}`,
                  background: asamaFiltre === p.key ? `${p.renk}18` : 'var(--bg2)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 22 }}>{p.ikon}</div>
                <div style={{ fontWeight: 700, fontSize: 22, color: p.renk }}>{p.adet}</div>
                <div style={{ fontSize: 12, color: 'var(--text2)' }}>{p.label}</div>
              </button>
            ))}
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--bg2)',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Açık toplam</div>
              <div style={{ fontWeight: 700, fontSize: 22 }}>{veri?.acik_toplam ?? '—'}</div>
              <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!sadeceAcik}
                  onChange={(e) => setSadeceAcik(!e.target.checked)}
                />
                Tamamlananları da göster
              </label>
            </div>
          </div>

          {/* Filtreler */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              placeholder="🔍 Şube adı…"
              value={subeArama}
              onChange={(e) => setSubeArama(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && yukle()}
              style={{ minWidth: 140, maxWidth: 200 }}
            />
            <input
              className="input"
              placeholder="Sipariş no…"
              value={talepArama}
              onChange={(e) => setTalepArama(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && yukle()}
              style={{ minWidth: 120, maxWidth: 160 }}
            />
            <select className="input" value={depoFiltre} onChange={(e) => setDepoFiltre(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">Tüm depolar</option>
              {depolar.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.ad || d.id}
                </option>
              ))}
            </select>
            <select className="input" value={String(gun)} onChange={(e) => setGun(Number(e.target.value) || 30)} style={{ width: 90 }}>
              {GUN_SEC.map((g) => (
                <option key={g} value={g}>
                  {g} gün
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary btn-sm" onClick={yukle}>
              Filtrele
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(320px, 1.1fr)', gap: 14, alignItems: 'start' }}>
            {/* Sol: liste + kuyruk */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {bekleyenListe.length > 0 && (
                <div className="card" style={{ padding: 12 }}>
                  {/* Başlık + birleştir paneli */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>
                      📬 Merkez kuyruğu ({bekleyenListe.length})
                    </div>
                    {secilenIdler.length === 0 && (
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                        ☑ Birleştirmek için kutucuklara tıklayın
                      </span>
                    )}
                    {secilenIdler.length > 0 && !birlestirAktif && (
                      <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                        ⚠ Birleştirme için aynı şubeden en az 2 sipariş seçin
                      </span>
                    )}
                  </div>

                  {/* Birleştir aksiyonu */}
                  {birlestirAktif && (
                    <div style={{
                      background: 'rgba(59,130,246,0.1)',
                      border: '1px solid rgba(59,130,246,0.3)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      marginBottom: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent)' }}>
                        🔗 {secilenIdler.length} sipariş birleştirilecek
                      </div>
                      <input
                        className="input"
                        placeholder="Birleştirme notu (isteğe bağlı)"
                        value={birlestirNot}
                        onChange={(e) => setBirlestirNot(e.target.value)}
                        style={{ fontSize: 12 }}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={birlestirBusy}
                          onClick={birlestirGonder}
                          style={{ flex: 1 }}
                        >
                          {birlestirBusy ? '…' : `🔗 Birleştir (${secilenIdler.length})`}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={birlestirTemizle}
                        >
                          İptal
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 480, overflowY: 'auto' }}>
                    {bekleyenListe.map((sip) => {
                      const tid = String(sip.id || '');
                      const isSecili = Boolean(birlestirSecili[tid]);
                      // Farklı şubeden seçim varsa bu şubeyi pasif göster
                      const farkliSube = secilenSubeIdler.length > 0 &&
                        !secilenSubeIdler.includes(String(sip.sube_id || ''));
                      return (
                        <div
                          key={sip.id}
                          data-ops-siparis-talep={sip.id}
                          style={{
                            border: `1px solid ${isSecili ? 'rgba(59,130,246,0.5)' : 'var(--border)'}`,
                            borderRadius: 8,
                            padding: 10,
                            background: isSecili ? 'rgba(59,130,246,0.06)' : 'var(--bg)',
                            opacity: farkliSube ? 0.5 : 1,
                            transition: 'border-color .15s, background .15s, opacity .15s',
                          }}
                        >
                          {/* Checkbox + başlık */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                            <input
                              type="checkbox"
                              checked={isSecili}
                              disabled={farkliSube}
                              onChange={() => birlestirToggle(tid, String(sip.sube_id || ''))}
                              style={{ width: 16, height: 16, cursor: farkliSube ? 'not-allowed' : 'pointer', flexShrink: 0 }}
                              title={farkliSube ? 'Farklı şube — birleştirilemez' : 'Birleştirmek için seç'}
                            />
                            <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{sip.sube_adi}</span>
                          </div>
                          <SiparisGonderenSatiri kayit={sip} />
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>
                            {kisaTs(sip.olusturma)} · {kalemOzet(sip.kalemler)}
                          </div>
                          <KuyrukYonlendirmeKarti
                            sip={sip}
                            depolar={depolar}
                            mod={kuyrukMod[tid] || 'depo'}
                            onModChange={(m) => setKuyrukMod((p) => ({ ...p, [tid]: m }))}
                            kuyrukDepo={kuyrukDepo}
                            setKuyrukDepo={setKuyrukDepo}
                            kuyrukTalimat={kuyrukTalimat}
                            setKuyrukTalimat={setKuyrukTalimat}
                            kuyrukToptanciListeler={kuyrukToptanciListeler}
                            kuyrukToptanciNot={kuyrukToptanciNot}
                            kuyrukBusy={kuyrukBusy}
                            depoyaGonder={depoyaGonder}
                            toptanciyaYolla={toptanciyaYolla}
                            onToptanciModalAc={() => setToptanciModalSip(sip)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                  {yukleniyor ? 'Yükleniyor…' : `${satirlar.length} sipariş`}
                  {asamaFiltre && (
                    <span style={{ fontWeight: 400, color: 'var(--text3)', marginLeft: 8 }}>
                      — {ASAMA_STIL[asamaFiltre]?.label}
                    </span>
                  )}
                </div>
                {yukleniyor ? (
                  <div className="loading" style={{ padding: 24 }}>
                    <div className="spinner" />
                  </div>
                ) : satirlar.length === 0 ? (
                  <div className="empty" style={{ padding: 24 }}>
                    <p>Bu filtrede sipariş yok</p>
                  </div>
                ) : (
                  <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                    {satirlar.map((s) => {
                      const st = ASAMA_STIL[s.asama] || { renk: 'var(--text3)', ikon: '•' };
                      const aktif = secili?.id === s.id;
                      const iptalGoster = iptalEdilebilirAsama(s.asama);
                      return (
                        <div
                          key={s.id}
                          data-ops-siparis-talep={s.id}
                          style={{
                            display: 'flex',
                            alignItems: 'stretch',
                            borderBottom: '1px solid var(--border)',
                            borderLeft: `3px solid ${st.renk}`,
                            background: aktif ? 'rgba(59,130,246,0.1)' : 'transparent',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setSecili(s)}
                            style={{
                              display: 'block',
                              flex: 1,
                              textAlign: 'left',
                              padding: '10px 14px',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ fontWeight: 600, fontSize: 13 }}>{s.sube_adi}</span>
                              <span style={{ fontSize: 11, color: st.renk }}>{st.ikon}</span>
                            </div>
                            {s.hedef_depo_sube_adi && (
                              <div style={{ fontSize: 11, color: 'var(--text3)' }}>→ {s.hedef_depo_sube_adi}</div>
                            )}
                            <SiparisGonderenSatiri kayit={s} style={{ marginTop: 2 }} />
                            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{s.asama_metni}</div>
                            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'monospace' }}>
                              #{String(s.id).slice(-8)} · {kisaTs(s.olusturma)}
                            </div>
                          </button>
                          {iptalGoster && (
                            <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px 0 0' }}>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                disabled={iptalBusy === s.id}
                                title="Yolda / depo kalıntısını iptal et"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  akisiIptal(s.id, s.sube_adi, s.asama);
                                }}
                              >
                                {iptalBusy === s.id ? '…' : 'İptal'}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {uyumsuzluklar.length > 0 && (
                <div className="card" style={{ padding: 12, borderColor: '#ef444455' }}>
                  <div style={{ fontWeight: 700, color: '#ef4444', marginBottom: 8 }}>
                    ⚠ Kabul uyumsuzlukları ({uyumsuzluklar.length})
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12 }}>
                    {uyumsuzluklar.slice(0, 15).map((u) => (
                      <div
                        key={u.stok_yolda_id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 0',
                          borderBottom: '1px solid var(--border)',
                          gap: 8,
                        }}
                      >
                        <span>
                          {u.hedef_sube_adi}: {u.kalem_adi} (sevk {u.sevk_adet} / kabul {u.kabul_adet})
                        </span>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => uyumCoz(u)}>
                          Çöz
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Sağ: detay */}
            <div className="card" style={{ padding: 14, minHeight: 400, position: 'sticky', top: 8 }}>
              {!secili ? (
                <div className="empty" style={{ padding: 40 }}>
                  <p>Listeden bir sipariş seçin</p>
                  <p style={{ fontSize: 12, color: 'var(--text3)' }}>Zaman çizelgesi ve kalem detayı burada görünür</p>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{secili.sube_adi}</div>
                      <SiparisGonderenSatiri kayit={secili} style={{ marginTop: 4, fontSize: 12 }} />
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                        {secili.hedef_depo_sube_adi && `Depo: ${secili.hedef_depo_sube_adi} · `}
                        {secili.asama_metni}
                      </div>
                      <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text3)' }}>#{secili.id}</div>
                    </div>
                    {secili.asama === 'depoda' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          setGorunum('depo');
                          if (secili.hedef_depo_sube_id) setDepoFiltre(secili.hedef_depo_sube_id);
                        }}
                      >
                        Depoda aç
                      </button>
                    )}
                    {iptalEdilebilirAsama(secili.asama) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={iptalBusy === secili.id}
                        onClick={() => akisiIptal(secili.id, secili.sube_adi, secili.asama)}
                      >
                        {iptalBusy === secili.id ? 'İptal ediliyor…' : 'Siparişi iptal et'}
                      </button>
                    )}
                  </div>

                  {/* Mini pipeline */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
                    {['bekliyor', 'depoda', 'yolda', 'tamamlandi'].map((a, i) => {
                      const done =
                        ['bekliyor', 'depoda', 'yolda', 'tamamlandi'].indexOf(secili.asama) >= i ||
                        secili.asama === 'uyumsuzluk';
                      const st = ASAMA_STIL[a];
                      return (
                        <div
                          key={a}
                          style={{
                            flex: 1,
                            minWidth: 64,
                            textAlign: 'center',
                            padding: '6px 4px',
                            borderRadius: 6,
                            background: done ? `${st.renk}22` : 'var(--bg3)',
                            fontSize: 10,
                            fontWeight: 600,
                            color: done ? st.renk : 'var(--text3)',
                          }}
                        >
                          {st.ikon} {st.label}
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Kalemler</div>
                  <div style={{ fontSize: 12, marginBottom: 14, maxHeight: 140, overflowY: 'auto' }}>
                    {(secili.kalemler || []).map((k, i) => (
                      <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                        {k.urun_ad || k.kalem_kodu} × {k.adet}
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Zaman çizelgesi</div>
                  {tlYukleniyor ? (
                    <div style={{ color: 'var(--text3)', fontSize: 12 }}>…</div>
                  ) : (
                    <div style={{ fontSize: 11, maxHeight: 200, overflowY: 'auto' }}>
                      <div style={{ padding: '4px 0', color: 'var(--text3)' }}>
                        📝 Talep: {kisaTs(secili.olusturma)}
                        {siparisGonderenAdi(secili) && ` · 👤 ${siparisGonderenAdi(secili)}`}
                      </div>
                      {secili.tahsis_ts && (
                        <div style={{ padding: '4px 0', color: 'var(--text3)' }}>
                          🏭 Tahsis: {kisaTs(secili.tahsis_ts)} {secili.tahsis_yapan_ad && `· ${secili.tahsis_yapan_ad}`}
                        </div>
                      )}
                      {secili.sevkiyat_ts && (
                        <div style={{ padding: '4px 0', color: 'var(--text3)' }}>
                          🚚 Sevk: {kisaTs(secili.sevkiyat_ts)} {secili.sevkiyat_personel_ad && `· ${secili.sevkiyat_personel_ad}`}
                        </div>
                      )}
                      {(timeline?.olaylar || []).map((o, i) => (
                        <div key={i} style={{ padding: '4px 0', borderLeft: '2px solid var(--border)', paddingLeft: 8, marginLeft: 4 }}>
                          <strong>{o.olay}</strong> {kisaTs(o.zaman)}
                          {o.detay && (
                            <div style={{ color: 'var(--text3)', fontSize: 10 }}>{String(o.detay).slice(0, 120)}</div>
                          )}
                        </div>
                      ))}
                      {(secili.yolda || []).map((y, i) => (
                        <div key={`y${i}`} style={{ padding: '4px 0', fontSize: 11 }}>
                          📦 {y.kalem_adi}: sevk {y.sevk_adet} → kabul {y.kabul_adet || '—'} ({y.durum})
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {gorunum === 'depo' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 14, alignItems: 'start' }}>
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <select className="input" value={depoFiltre} onChange={(e) => setDepoFiltre(e.target.value)}>
                <option value="">Tüm depolar</option>
                {depolar.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.ad}
                  </option>
                ))}
              </select>
              <select className="input" value={depoDurumFiltre} onChange={(e) => setDepoDurumFiltre(e.target.value)}>
                <option value="hazirlaniyor">Açık hazırlık</option>
                <option value="depoda_hazirlaniyor">Depoda hazırlanıyor</option>
                <option value="gonderildi">Gönderildi</option>
              </select>
              <button type="button" className="btn btn-sm btn-secondary" onClick={yukleDepoListe}>
                ↺
              </button>
            </div>
            <div className="card" style={{ maxHeight: 520, overflowY: 'auto', padding: 0 }}>
              {depoListe.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setDepoSecili(t)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: 10,
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    background: depoSecili?.id === t.id ? 'rgba(59,130,246,0.12)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{t.talep_sube_adi || t.sube_adi}</div>
                  <SiparisGonderenSatiri kayit={t} />
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{kalemOzet(t.kalemler)}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            {!depoSecili ? (
              <div className="empty">Depo listesinden talep seçin</div>
            ) : (
              <>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{depoSecili.talep_sube_adi || depoSecili.sube_adi}</div>
                <SiparisGonderenSatiri kayit={depoSecili} style={{ marginBottom: 10 }} />
                {(depoSecili.kalemler || []).map((k, i) => {
                  const key = `${k?.urun_id || ''}:${k?.urun_ad || ''}:${i}`;
                  const kd = depoKalem[key] || {};
                  return (
                    <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{ flex: 1, minWidth: 120, fontSize: 13 }}>
                        {k.urun_ad} × {k.adet}
                      </span>
                      <select
                        className="input"
                        style={{ width: 90 }}
                        value={kd.durum || 'var'}
                        onChange={(e) =>
                          setDepoKalem((p) => ({
                            ...p,
                            [key]: { ...kd, durum: e.target.value },
                          }))
                        }
                      >
                        {DURUM_OPS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        style={{ width: 56 }}
                        value={kd.gonderilen_adet ?? k.adet}
                        onChange={(e) =>
                          setDepoKalem((p) => ({
                            ...p,
                            [key]: { ...kd, gonderilen_adet: Number(e.target.value) },
                          }))
                        }
                      />
                    </div>
                  );
                })}
                <textarea
                  className="input"
                  rows={2}
                  placeholder="Sevkiyat notu"
                  value={depoNot}
                  onChange={(e) => setDepoNot(e.target.value)}
                  style={{ width: '100%', marginTop: 8 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-secondary" disabled={depoBusy} onClick={() => depoKaydet(false)}>
                    Hazırlığı kaydet
                  </button>
                  <button type="button" className="btn btn-primary" disabled={depoBusy} onClick={() => depoKaydet(true)}>
                    Yola çıkar — teslim al aç
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {gorunum === 'urun' && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              placeholder="Ürün adı veya kodu (min 2 karakter)…"
              value={urunArama}
              onChange={(e) => setUrunArama(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && urunAra()}
            />
            <button type="button" className="btn btn-primary" onClick={urunAra}>
              Ara
            </button>
          </div>
          {urunGecmis?.satirlar?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {urunGecmis.satirlar.map((r) => (
                <div
                  key={r.talep_id}
                  style={{
                    padding: 10,
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    const s = satirlar.find((x) => x.id === r.talep_id);
                    if (s) {
                      setSecili(s);
                      setGorunum('izleme');
                    } else {
                      setTalepArama(r.talep_id);
                      setGorunum('izleme');
                      yukle();
                    }
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {r.sube_adi} · {r.tarih}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>{r.asama_metni}</div>
                  <div style={{ fontSize: 11 }}>
                    {(r.eslesen_kalemler || []).map((k, i) => (
                      <span key={i}>
                        {k.urun_ad} ×{k.adet}{' '}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : urunGecmis ? (
            <div className="empty">Eşleşen talep yok</div>
          ) : (
            <div style={{ color: 'var(--text3)', fontSize: 13 }}>
              «Bu ürün daha önce hangi şubeden, ne zaman istendi?» sorusu için ürün adı yazın.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
