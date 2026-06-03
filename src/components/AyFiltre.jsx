// Paylaşılan ay seçici — sol paneldeki zaman-serisi sekmelerinde tutarlı ay ayrımı için.
// value: "YYYY-MM" | "hepsi"   onChange: (yeniDeger) => void
// allowAll: "Tümü" seçeneği göster (ay filtresini kaldırmak için)

const _AYLAR_TR = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

export function buGununAyi() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ayKaydir(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ayEtiket(ym) {
  if (!ym || ym === 'hepsi') return 'Tüm Aylar';
  const [y, m] = ym.split('-').map(Number);
  return `${_AYLAR_TR[(m - 1) % 12] || m} ${y}`;
}

export default function AyFiltre({ value, onChange, allowAll = false }) {
  const aktifAy = value && value !== 'hepsi' ? value : buGununAyi();
  const tumu = value === 'hepsi';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        title="Önceki ay"
        disabled={tumu}
        onClick={() => onChange(ayKaydir(aktifAy, -1))}
        style={{ padding: '4px 8px', opacity: tumu ? 0.4 : 1 }}
      >
        ◀
      </button>
      <div
        style={{
          minWidth: 116, textAlign: 'center', fontWeight: 700, fontSize: 13,
          padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)',
          background: tumu ? 'var(--bg3)' : 'var(--bg2)', color: tumu ? 'var(--text3)' : 'var(--text)',
        }}
      >
        📅 {ayEtiket(value)}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        title="Sonraki ay"
        disabled={tumu}
        onClick={() => onChange(ayKaydir(aktifAy, +1))}
        style={{ padding: '4px 8px', opacity: tumu ? 0.4 : 1 }}
      >
        ▶
      </button>
      {allowAll && (
        <button
          type="button"
          className={`btn btn-sm ${tumu ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onChange(tumu ? buGununAyi() : 'hepsi')}
          title="Ay filtresini kaldır / geri al"
          style={{ marginLeft: 2 }}
        >
          Tümü
        </button>
      )}
    </div>
  );
}
