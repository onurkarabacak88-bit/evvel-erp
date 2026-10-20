// 🎨 EVVEL YENİ TEMA RENKLERİ — TEK kaynak (Dalga 5, T4-16: kabuk EvvelYeniApp '--bg/--paper…' ve modüller KasaModulu '--pi-bg/--pi-paper…'
// AYNI açık/koyu değerleri iki ayrı kopyada tutuyordu; birinde değişen renk ötekinde kalıyordu). İki adlandırma da buradan üretilir.
export const RENK = {
  acik: {
    bg: '#F4EEE2', paper: '#FCFAF4', line: '#E0D4BE', ink: '#2A1E14', ink2: '#5E4C3A', ink3: '#7F6C57',
    accent: '#9A5F2E', on: '#FFF8EC', 'accent-soft': '#F1E3D0', good: '#25794F', 'good-soft': '#E1EFE4',
    bad: '#C03A2B', 'bad-soft': '#F6E1DC', warn: '#8A680E', 'warn-soft': '#F4EBCF',
  },
  koyu: {
    bg: '#161009', paper: '#211710', line: '#3A2C1E', ink: '#F1E9DD', ink2: '#C4B5A2', ink3: '#A3917B',
    accent: '#D29A5B', on: '#241A12', 'accent-soft': '#3A2817', good: '#5FBE8E', 'good-soft': '#163020',
    bad: '#E2604F', 'bad-soft': '#3A1B16', warn: '#E5B84E', 'warn-soft': '#33290F',
  },
};

// Modül adları (--pi-*): 'on' modülde '--pi-on-accent' adını taşır
const PI_AD = (k) => (k === 'on' ? 'on-accent' : k);
export const piDegiskenleri = (mod) => Object.entries(RENK[mod]).map(([k, v]) => `--pi-${PI_AD(k)}:${v}`).join(';');
// Kabuk adları (--bg, --paper, --line, --ink, --ink3, --accent, --on, --bad)
const KABUK = ['bg', 'paper', 'line', 'ink', 'ink3', 'accent', 'on', 'bad'];
export const kabukDegiskenleri = (mod) => KABUK.map((k) => `--${k}:${RENK[mod][k]}`).join(';');
