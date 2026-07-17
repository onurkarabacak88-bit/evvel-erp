// EVVEL SVG ikon seti (2026-07-18) — emoji ikonlardan çıkış, 1. tur: uygulama kabuğu.
// TEK AİLE: outline, 24 viewBox, 1.7 çizgi, yuvarlak uç — stroke=currentColor
// olduğundan renk bulunduğu metnin rengini alır (aktif menüde bakır, pasifte krem).
const CIZIMLER = {
  gosterge: <><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>,
  radar: <><circle cx="12" cy="12" r="2" /><path d="M16.24 7.76a6 6 0 0 1 0 8.49" /><path d="M7.76 16.24a6 6 0 0 1 0-8.49" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M4.93 19.07a10 10 0 0 1 0-14.14" /></>,
  islemci: <><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>,
  goz: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  bag: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  para: <><circle cx="8" cy="8" r="5.5" /><path d="M18.6 9.4a5.5 5.5 0 1 1-9.2 9.2" /><path d="M8 5.5v5M5.5 8h5" /></>,
  banknot: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M5.5 12h.01M18.5 12h.01" /></>,
  dukkan: <><path d="M4 9 5.6 4h12.8L20 9" /><path d="M5 9v11h14V9" /><path d="M9.5 20v-5.5h5V20" /><path d="M4 9h16" /></>,
  pusula: <><circle cx="12" cy="12" r="10" /><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3Z" /></>,
  hedef: <><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="5.5" /><circle cx="12" cy="12" r="1.5" /></>,
  onay: <><circle cx="12" cy="12" r="9.5" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  'pano-onay': <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5V3h6v1.5" /><path d="m9 13 2 2 4-4" /></>,
  trend: <><path d="m2.5 16.5 6-6 4 4L21.5 7" /><path d="M15.5 7h6v6" /></>,
  kahve: <><path d="M17 9h1.5a3.5 3.5 0 1 1 0 7H17" /><path d="M3.5 9H17v7.5a4 4 0 0 1-4 4h-5.5a4 4 0 0 1-4-4Z" /><path d="M7 5.5V3.5M10.5 5.5v-2M14 5.5v-2" /></>,
  cuzdan: <><path d="M20.5 11.5V7.5H5.25a2.25 2.25 0 0 1 0-4.5H19v4" /><path d="M3.5 5.5v13a2 2 0 0 0 2 2h15v-4.5" /><path d="M17.5 11.5a2.25 2.25 0 0 0 0 4.5h4v-4.5Z" /></>,
  fis: <><path d="M5 2.5v19l2.33-1.4L9.67 21.5 12 20.1l2.33 1.4 2.34-1.4L19 21.5v-19l-2.33 1.4L14.33 2.5 12 3.9 9.67 2.5 7.33 3.9Z" /><path d="M9 8.5h6M9 12h6M9 15.5h3.5" /></>,
  'arti-para': <><circle cx="12" cy="12" r="9.5" /><path d="M12 8v8M8 12h8" /></>,
  koli: <><path d="M21 8.2a2 2 0 0 0-1-1.74l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8.2v7.6a2 2 0 0 0 1 1.74l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.74Z" /><path d="M3.3 7.2 12 12.2l8.7-5" /><path d="M12 22.2v-10" /><path d="m7.5 4.7 9 5.1" /></>,
  kart: <><rect x="2" y="5" width="20" height="14" rx="2.5" /><path d="M2 10h20" /><path d="M6 15h4" /></>,
  canta: <><rect x="2.5" y="7" width="19" height="13.5" rx="2" /><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2" /><path d="M2.5 12.5h19" /></>,
  ekip: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="3.75" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.4a3.75 3.75 0 0 1 0 7.2" /></>,
  takvim: <><rect x="3" y="4.5" width="18" height="17" rx="2" /><path d="M8 2.5v4M16 2.5v4M3 10h18" /></>,
  kilit: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" /><path d="M12 15v2" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M18 18h3v3" /></>,
  'onay-kare': <><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  'pano-liste': <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5V3h6v1.5" /><path d="M9 10h6M9 13.5h6M9 17h3.5" /></>,
  saat: <><circle cx="12" cy="12" r="9.5" /><path d="M12 6.5V12l3.5 2" /></>,
  ev: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5" /><path d="M9.5 21v-6h5v6" /></>,
  banka: <><path d="M3 21.5h18" /><path d="M5.5 18v-8M10 18v-8M14 18v-8M18.5 18v-8" /><path d="m3 7 9-4.5L21 7v3H3Z" /></>,
  kamyon: <><path d="M14 17.5V6a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 6v10.5A1 1 0 0 0 3 17.5h1.5" /><path d="M14 17.5H9.5" /><path d="M19.5 17.5H21a1 1 0 0 0 1-1v-3.2a1 1 0 0 0-.21-.61l-3-3.8a1 1 0 0 0-.79-.39H14" /><circle cx="7" cy="17.5" r="2" /><circle cx="17" cy="17.5" r="2" /></>,
  dosya: <><path d="M14.5 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7.5Z" /><path d="M14.5 2.5v5h5" /><path d="M9 13h6M9 16.5h6" /></>,
  tv: <><rect x="2.5" y="7" width="19" height="13" rx="2" /><path d="m16.5 2.5-4.5 4.5-4.5-4.5" /></>,
  grafik: <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M8 16.5v-5M13 16.5V8M18 16.5v-3" /></>,
  defter: <><path d="M4.5 19.5v-15a2.5 2.5 0 0 1 2.5-2.5h12.5v20H7a2.5 2.5 0 0 1 0-5h12.5" /></>,
  tablo: <><rect x="3" y="3.5" width="18" height="17" rx="2" /><path d="M3 9.5h18M10 3.5v17" /></>,
  'gelen-kutusu': <><path d="M22 12.5h-5.5l-2 3h-5l-2-3H2" /><path d="M5.4 5.6 2 12.5v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9a2 2 0 0 0-1.8-1.1H7.2a2 2 0 0 0-1.8 1.1Z" /></>,
  silgi: <><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19.6" /><path d="M22 21H7" /><path d="m5.3 11 8 8" /></>,
  cop: <><path d="M3.5 6.5h17" /><path d="M18.5 6.5V19a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6.5" /><path d="M8.5 6.5v-2a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></>,
  cetvel: <><path d="M21.3 8.7 8.7 21.3a2.4 2.4 0 0 1-3.4 0l-2.6-2.6a2.4 2.4 0 0 1 0-3.4L15.3 2.7a2.4 2.4 0 0 1 3.4 0l2.6 2.6a2.4 2.4 0 0 1 0 3.4Z" /><path d="m7.5 10.5 2 2M10.5 7.5l2 2M13.5 4.5l2 2" /></>,
  klasor: <><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></>,
  anahtar: <><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" /></>,
};

export default function Ikon({ ad, boyut = 16, kalinlik = 1.7, style }) {
  const cizim = CIZIMLER[ad] || CIZIMLER.klasor;
  return (
    <svg width={boyut} height={boyut} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={kalinlik} strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true"
         style={{ display: 'block', ...style }}>
      {cizim}
    </svg>
  );
}
