// ⚙️ SİSTEM DURUMU — çekirdek ekranı (sunucu: evvel_yeni_moduller.py · /moduller + /moduller/gorevler). Sayfası Tanımlar altında.
// IS 5c / F3.1 B7+B11 (sim 26 Eki · Opus + Codex + Fable): Kasa ve Depo'nun otomatik işleri ekran açılınca değil arka planda koşar;
// ne zaman koştu, ne yaptı, hata verdi mi TEK yerde + "Şimdi çalıştır". Kural: sök-tak sade, bakım içeride — tek Sistem durumu ekranı.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, Dugme, Cip, soruOnay } from './KasaModulu';

export const SISTEM_SAYFALAR = [{ id: 'sistem_durumu', ad: 'Sistem durumu', alt: 'Modüller · otomatik işler' }];

const saat = (z) => (z ? new Date(z).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const ozetYaz = (o) => (o?.kesildi ? (o.not || 'kapandı') : Object.entries(o || {})   // Fable: 1 Kasım sonrası depo aktarımı "kapandı" der
  .filter(([k, v]) => typeof v === 'number' && v > 0 && k !== 'kilitli')
  .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ') || 'yeni iş yoktu');

// sunucunun teknik durumu → sade söz ('eksik:tanim,depo' → 'Tanımlar, Depo kapalı olduğu için yüklenmedi')
const durumYaz = (d, liste) => {
  if (d === 'kapali') return 'kapalı';
  if (d?.startsWith('eksik:')) {
    const ad = (k) => (liste || []).find((x) => x.kod === k)?.ad || k;
    return `${d.slice(6).split(',').map(ad).join(', ')} kapalı olduğu için yüklenmedi`;
  }
  if (d?.startsWith('hata:')) return `yüklenirken hata — ${d.slice(5)}`;
  return d;
};

// ✂️ 1 KASIM SON AKTARIM (KESIM_1KASIM_ENVANTERI ⚖️ · sunucu: evvel_yeni_moduller /kesim) — eski dönemin çıktısı Evvel Yeni arşivine
// BİR KEZ dondurulur. Adım adım: önce "Kuru dene" (sayar, yazmaz), sonra "Çalıştır" (yalnız 1 Kasım 02:00 sonrası açılır). Kesim yayınında kalkar.
const sonucYaz = (s) => Object.entries(s || {}).filter(([, v]) => v != null).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' && v ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ') : v}`).join(' · ');

function SonAktarim({ onToast }) {
  const [v, setV] = useState(null);
  const [mesgul, setMesgul] = useState('');
  const [kuru, setKuru] = useState({});
  const [hata, setHata] = useState('');
  const yukle = useCallback(() => { api('/evvel-yeni/moduller/kesim').then(setV).catch((e) => setHata(e?.message || 'Okunamadı')); }, []);
  useEffect(() => { yukle(); }, [yukle]);
  if (!v || !v.adimlar?.length) return hata ? <div style={{ color: R.kirmizi }}>{hata}</div> : null;
  const calistir = async (x, k) => {
    if (!k && !(await soruOnay(`"${x.baslik}" GERÇEKTEN yazılsın mı? (Önce kuru denemenin sonucuna bak.)`, 'Evet, yaz'))) return;
    setMesgul(x.kod + (k ? ':kuru' : ''));
    try {
      const r = await api('/evvel-yeni/moduller/kesim/calistir', { method: 'POST', body: { kod: x.kod, kuru: k } });
      if (k) setKuru((o) => ({ ...o, [x.kod]: r })); else { onToast?.(`${x.ad} arşive yazıldı`); yukle(); }
    } catch (e) { setKuru((o) => ({ ...o, [x.kod]: { hata: e?.message || 'çalışmadı' } })); }   // hata kendi satırında (tek satırda bir sonrakini siliyordu)
    setMesgul('');
  };
  // 🟡 E6 (Fable L4b A): hepsi SIRAYLA tek işlemde kuru — her adım öncekinin yazacağını görür (fiş kasayı), sonda tek geri sarma
  const zincir = async () => {
    setMesgul('*');
    try {
      const r = await api('/evvel-yeni/moduller/kesim/calistir', { method: 'POST', body: { kod: '*', kuru: true } });
      setKuru(Object.fromEntries((r.adimlar || []).map((a) => [a.kod, a.hata ? { hata: a.hata } : { sonuc: a.sonuc, sure_sn: a.sure_sn, zincir: true }])));
    } catch (e) { onToast?.(e?.message || 'Kuru deneme çalışmadı'); }
    setMesgul('');
  };
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>✂️ 1 Kasım son aktarım — {v.ay}</b>
        {v.gercek_acik ? <Cip tur="sari">çalıştırılabilir</Cip> : <Cip>yalnız kuru deneme · gerçek {v.baslangic} 02:00 sonrası</Cip>}
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>Eski sistemin {v.ay} kayıtları Evvel Yeni arşivine bir kez dondurulur; sonra ekranlar o ayı arşivden okur. Sırayla: önce kuru dene, sayıları kontrol et, sonra çalıştır. Personel adımı uzun sürebilir — bitene kadar sayfayı kapatma.</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dugme ana disabled={!!mesgul} onClick={zincir}>{mesgul === '*' ? 'Hepsi deneniyor…' : 'Hepsini sırayla kuru dene'}</Dugme>
        <span style={{ fontSize: 12, color: R.not }}>Her adım bir öncekinin yazacağını görür (doğru sayılar); sonunda hiçbir şey yazılmaz. Bağlantı kesilirse sayfayı yenile — yazılmışsa ✓ görünür.</span>
      </div>
      {!v.gercek_acik && <div style={{ fontSize: 12, color: R.amber }}>Şimdiki sayılar bugüne kadar olanı sayar; 31 Ekim akşamının kapanışları 1 Kasım 02:00'den sonra görünür — gerçek yazımdan önce hepsini bir kez daha kuru dene (sistem de bunu ister).</div>}
      {v.adimlar.map((x) => (
        <div key={x.kod} style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span style={{ flex: '1 1 260px' }}><b>{x.ad}</b> — {x.baslik}
            {x.son && <div style={{ color: R.yesil, fontSize: 12 }}>✓ yazıldı {saat(x.son.zaman)} · {x.son.yazan} · {sonucYaz(x.son.sonuc)}</div>}
            {kuru[x.kod]?.hata && <div style={{ color: R.kirmizi, fontSize: 12, overflowWrap: 'anywhere' }}>✗ {kuru[x.kod].hata}</div>}
            {kuru[x.kod]?.sonuc && <div style={{ color: R.metin2, fontSize: 12 }}>{kuru[x.kod].zincir ? 'sıralı kuru' : 'kuru'} ({kuru[x.kod].sure_sn} sn): {sonucYaz(kuru[x.kod].sonuc)}</div>}
            {kuru[x.kod]?.sonuc && !kuru[x.kod].zincir && (x.bagli || []).length > 0 && <div style={{ color: R.not, fontSize: 11.5 }}>tek başına denendi — {x.bagli.join(', ')} adımının yazacağı kayıtlar sayılmadı (doğru sayı için "Hepsini sırayla kuru dene")</div>}
            {(x.bagli_eksik || []).length > 0 && !x.son && <div style={{ color: R.amber, fontSize: 12 }}>⚠ Önce {x.bagli_eksik.join(', ')} adımı yazılmalı — bu adım onun kayıtlarını okur</div>}
          </span>
          <Dugme kucuk disabled={!!mesgul} onClick={() => calistir(x, true)}>{mesgul === `${x.kod}:kuru` ? 'Deneniyor…' : 'Kuru dene'}</Dugme>
          <Dugme kucuk ana disabled={!!mesgul || !v.gercek_acik || !kuru[x.kod]?.sonuc || (x.bagli_eksik || []).length > 0} title={!kuru[x.kod]?.sonuc ? 'Önce kuru dene (hatasız)' : (x.bagli_eksik || []).length ? `Önce ${x.bagli_eksik.join(', ')}` : undefined}
            onClick={() => calistir(x, false)}>{mesgul === x.kod ? 'Yazılıyor…' : x.son ? 'Yeniden yaz' : 'Çalıştır'}</Dugme>
        </div>
      ))}
    </div>
  );
}

// ✂️ ARŞİV SAĞLAMASI (24 Kas · Codex L4b D — HİÇBİR ŞEY YAZMAZ): eski okuyucular SİLİNMEDEN önce sorulan tek soru —
// 1 Kasım son aktarımının yazdığı arşiv, eski tablodan BUGÜN hesaplananla aynı mı? Eski tablolar ayakta olduğu için şimdi
// ölçülebilir, silindikten sonra ölçülemez. "yok" = arşiv hiç yazılmamış (boş arşivden farklı) → silmek sayıları sıfırlar.
const _tl = (k) => ((k || 0) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
const SAGLAMA = {
  ayni: { renk: 'yesil', isaret: '✓', soz: 'arşiv eski tabloyla AYNI — bu adımın eski okuyucusu güvenle silinebilir' },
  fark: { renk: 'kirmizi', isaret: '✗', soz: 'arşiv ile eski tablo TUTMUYOR — silinirse ekranlar yanlış gösterir' },
  yok: { renk: 'kirmizi', isaret: '⚠', soz: 'arşiv YAZILMAMIŞ — şimdi silinirse eski aylar boş görünür' },
  kaynaksiz: { renk: 'amber', isaret: '?', soz: 'eski tablo okunamadı — karşılaştırılamadı' },
  saglamasiz: { renk: 'not', isaret: '○', soz: 'sağlaması henüz yazılmadı' },
  hata: { renk: 'amber', isaret: '?', soz: 'sağlama çalışmadı' },
};

function ArsivSaglamasi() {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const bak = async () => {
    setMesgul(true); setHata('');
    try { setV(await api('/evvel-yeni/moduller/kesim-sagla')); } catch (e) { setHata(e?.message || 'Okunamadı'); }
    setMesgul(false);
  };
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>✂️ Arşiv sağlaması</b>
        <Cip>yazmaz · yalnız karşılaştırır</Cip>
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>Eski sistemin okuyucuları kaldırılmadan önceki son kontrol: son aktarımın dondurduğu arşiv, eski tablodan bugün hesaplananla aynı mı? Eski tablolar hâlâ duruyorken ölçülebilir — kaldırıldıktan sonra ölçülemez.</div>
      <div><Dugme ana disabled={mesgul} onClick={bak}>{mesgul ? 'Karşılaştırılıyor…' : 'Arşivi eski tabloyla karşılaştır'}</Dugme></div>
      {hata && <div style={{ color: R.kirmizi, fontSize: 13 }}>{hata}</div>}
      {v && (v.saglanan || []).length === 0 && <div style={{ fontSize: 13, color: R.not }}>Sağlaması olan adım yok.</div>}
      {v && [...(v.saglanan || [])].sort((a, b) => (a.sonuc === 'saglamasiz') - (b.sonuc === 'saglamasiz')).map((x) => {
        const d = SAGLAMA[x.sonuc] || SAGLAMA.hata;
        return (
          <div key={x.kod} style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, fontSize: 13 }}>
            <div style={{ color: R[d.renk] }}><b>{d.isaret} {x.ad}</b> — {d.soz}</div>
            {x.mesaj && x.sonuc !== 'saglamasiz' && <div style={{ fontSize: 12, color: R.metin2 }}>{x.mesaj}</div>}
            {x.arsiv_kayit != null && (
              <div style={{ fontSize: 12, color: R.metin2 }}>
                arşiv {x.arsiv_kayit} satır · {_tl(x.arsiv_toplam)}
                {x.eski_kayit != null && <> ↔ eski tablo {x.eski_kayit} satır · {_tl(x.eski_toplam)}</>}
              </div>)}
            {(x.ornek || []).map((o, i) => (
              <div key={i} style={{ fontSize: 11.5, color: R.amber }}>• {o.anahtar}: arşiv {o.arsiv == null ? 'yok' : (typeof o.arsiv === 'number' ? _tl(o.arsiv) : o.arsiv)} ↔ eski {o.eski == null ? 'yok' : (typeof o.eski === 'number' ? _tl(o.eski) : o.eski)}</div>))}
          </div>
        );
      })}
      {v && (v.yapilmamis || []).length > 0 && <div style={{ fontSize: 12.5, color: R.kirmizi }}>⚠ {v.yapilmamis.length} adım hazır değil ({(v.hazir || []).length} hazır) — eski okuyucuları kaldırma yayını BEKLETİLMELİ. Sağlaması yazılmamış adımlar da kapıyı kapalı tutar.</div>}
      {v && (v.saglanan || []).length > 0 && (v.yapilmamis || []).length === 0 && <div style={{ fontSize: 12.5, color: R.yesil }}>✓ Hepsi tutuyor — eski okuyucuları kaldırma yayını yapılabilir.</div>}
    </div>
  );
}

// 🗂️ ESKİ TABLOLAR — YERİNE YAZILDI MI? (24 Kas · sahip "ben eskinin bir tane tablosu vs kalmasın" + "kaldırırken de yeni de
// yerine yazılmış mı bak"). Belge değil ÖLÇÜM: her eski tablo canlıda sayılır, Evvel Yeni karşılığı da sayılır. HİÇBİR ŞEY YAZMAZ.
const ESKI_SONUC = {
  karsilik_dolu: { renk: 'yesil', isaret: '✓', soz: 'karşılığında kayıt VAR — ön kontrol geçti' },
  eski_bos: { renk: 'yesil', isaret: '✓', soz: 'eski tablo boş — taşınacak kayıt yok' },
  bos_karsilik: { renk: 'kirmizi', isaret: '✗', soz: 'eski dolu ama Evvel Yeni karşılığı BOŞ — KALDIRMA' },
  yok: { renk: 'not', isaret: '—', soz: 'bu tablo canlıda zaten yok' },
  cikarildi: { renk: 'not', isaret: '✂️', soz: 'sahip kararıyla çıkarıldı — karşılığı aranmaz' },
  kalir: { renk: 'not', isaret: '📌', soz: 'kalır (Evvel Yeni kullanıyor)' },
  sayim_hatasi: { renk: 'amber', isaret: '?', soz: 'sayılamadı — bilinmiyor, "geçti" sayılmaz' },
  sayilmadi: { renk: 'amber', isaret: '⏱', soz: 'süre dolduğu için sayılmadı — yeniden say' },
};
const ESKI_DURUM = { yok: '(tablo yok)', hata: '(sayılamadı)', sayilmadi: '(sayılmadı)' };

function EskiTablolar() {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [hepsi, setHepsi] = useState(false);
  const bak = async () => {
    setMesgul(true); setHata('');
    try { setV(await api('/evvel-yeni/moduller/eski-tablolar')); } catch (e) { setHata(e?.message || 'Okunamadı'); }
    setMesgul(false);
  };
  const ONCE = { bos_karsilik: 0, sayim_hatasi: 1, sayilmadi: 1 };   // engel ve bilinmeyen üstte
  const liste = (v?.tablolar || []).filter((x) => hepsi || (x.sonuc !== 'yok' && x.sonuc !== 'cikarildi' && x.sonuc !== 'kalir'))
    .sort((a, b) => (ONCE[a.sonuc] ?? 9) - (ONCE[b.sonuc] ?? 9));
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>🗂️ Eski tablolar — yerine yazıldı mı?</b>
        <Cip>yazmaz · yalnız sayar</Cip>
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>Eski sistemin her tablosunda kaç kayıt var, Evvel Yeni'deki karşılığında kaç kayıt var — yan yana.</div>
      <div style={{ fontSize: 12.5, color: R.amber }}>⚠ Bu ekran <b>ön kontroldür, kaldırma izni vermez</b>: kayıt sayısı taşındığın kanıtı değildir (eski 500 ↔ yeni 3 de "dolu" görünür). Karşılığı BOŞ çıkan tablo ise kesin engeldir. Kaldırma sırası: arşiv sağlaması ✓ → eski yazıcılar durdurulur → son fark taşınır → Faz B dilimi yayınlanır → canlı okumalar doğrulanır → yedek alınıp geri yükleme denenir → tablo silinir.</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dugme ana disabled={mesgul} onClick={bak}>{mesgul ? 'Sayılıyor…' : 'Eski tabloları say'}</Dugme>
        {v && <Dugme kucuk onClick={() => setHepsi((x) => !x)}>{hepsi ? 'Yalnız iş kalanlar' : 'Hepsini göster'}</Dugme>}
      </div>
      {hata && <div style={{ color: R.kirmizi, fontSize: 13 }}>{hata}</div>}
      {v && (
        <div style={{ fontSize: 12.5, color: (v.duran || []).length ? R.kirmizi : R.yesil }}>
          {(v.duran || []).length ? `✗ ${v.duran.length} tabloda karşılık BOŞ — kaldırma durmalı` : '✓ Karşılığı boş çıkan tablo yok'}
          {' · '}{(v.karsilik_dolu || []).length} karşılığı dolu · {(v.eski_bos || []).length} eski boş · {(v.yok || []).length} zaten yok{(v.belirsiz || []).length ? ` · ${v.belirsiz.length} sayılamadı` : ''}{v.sure_sn != null ? ` · ${v.sure_sn} sn` : ''}
        </div>)}
      {liste.map((x) => {
        const d = ESKI_SONUC[x.sonuc] || ESKI_SONUC.yok;
        return (
          <div key={x.eski} style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, fontSize: 13 }}>
            <div style={{ color: R[d.renk] }}><b>{d.isaret} {x.eski}</b>{x.eski_kayit != null ? <> · {x.eski_kayit.toLocaleString('tr-TR')} kayıt</> : (x.eski_durum && x.eski_durum !== 'yok' ? <> · {ESKI_DURUM[x.eski_durum]}</> : null)} — {d.soz}</div>
            <div style={{ fontSize: 12, color: R.metin2 }}>{x.is}</div>
            {(x.yeni || []).length > 0 && (
              <div style={{ fontSize: 12, color: R.metin2 }}>yerine: {x.yeni.map((y) => `${y.tablo} ${y.kayit == null ? (ESKI_DURUM[y.durum] || '(yok)') : y.kayit.toLocaleString('tr-TR') + ' kayıt'}`).join(' · ')}</div>)}
          </div>
        );
      })}
    </div>
  );
}

// 🚫 ESKİ YAZIM GÖZLEMİ (25 Kas · sahip "eskinin bir tane tablosu kalmasın" · Codex L4b A): eski tabloları SİLMEDEN önce ona
// YAZAN her şey susmalı. Tahmin yerine ölçüm — kim yazmaya çalışıyor, nereden. Öntanımlı gözlem (engel yok); Railway
// ESKI_YAZIM=zorla ile yazma hata verir. Sayaç bellekte: yeniden başlatma sıfırlar, sayı DENEMEdir (yazılan satır değil).
function EskiYazim() {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const bak = useCallback(async () => {
    setMesgul(true); setHata('');
    try { setV(await api('/evvel-yeni/moduller/eski-yazim')); } catch (e) { setHata(e?.message || 'Okunamadı'); }
    setMesgul(false);
  }, []);
  useEffect(() => { bak(); }, [bak]);
  const zorla = v?.mod === 'zorla';
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>🚫 Eski sisteme hâlâ kim yazıyor?</b>
        {v && (zorla ? <Cip tur="kirmizi">yazma KAPALI</Cip> : <Cip tur="sari">yalnız izliyor · engel yok</Cip>)}
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>Eski tablolar silinmeden önce ona yazan her şeyin susması gerekir. Bu liste tahmin değil ölçüm: hangi eski tabloya, nereden yazılmaya çalışıldı. Sayı DENEME sayısıdır. Sunucu yeniden başlayınca liste sıfırlanır — bir gün dolmadan "temiz" demek erken.</div>
      <div><Dugme kucuk disabled={mesgul} onClick={bak}>{mesgul ? 'Okunuyor…' : 'Yenile'}</Dugme></div>
      {hata && <div style={{ color: R.kirmizi, fontSize: 13 }}>{hata}</div>}
      {v && !(v.satirlar || []).length && <div style={{ fontSize: 13, color: R.yesil }}>✓ Sunucu açıldığından beri eskiye yazma denemesi YOK.</div>}
      {v && (v.satirlar || []).length > 0 && (
        <div style={{ fontSize: 12.5, color: R.kirmizi }}>⚠ {v.tablo_sayisi} eski tabloya {v.toplam_deneme} yazma denemesi — tablolar bunlar susmadan silinmemeli.</div>)}
      {(v?.satirlar || []).slice(0, 25).map((x, i) => (
        <div key={i} style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 6, fontSize: 13 }}>
          <b>{x.tablo}</b> · {x.deneme.toLocaleString('tr-TR')} deneme{x.engellendi ? ` · ${x.engellendi} engellendi` : ''}
          <div style={{ fontSize: 12, color: R.metin2 }}>{x.nereden}</div>
        </div>))}
    </div>
  );
}

// 🧪 PİLOT ŞUBE (sahip 27 Eki · Fable L4b A): bir şube 1 Kasım'dan önce yeni panelde GERÇEK kayda geçer; eski panel o şube için kapanır.
// Kaldırınca şube denemeye döner (yazılmış kayıtlar kalır). Sunucu: evvel_yeni_moduller /pilot.
function PilotSube({ onToast }) {
  const [v, setV] = useState(null);
  const [gun, setGun] = useState({});
  const [mesgul, setMesgul] = useState('');
  const yukle = useCallback(() => { api('/evvel-yeni/moduller/pilot').then(setV).catch(() => setV(null)); }, []);
  useEffect(() => { yukle(); }, [yukle]);
  if (!v) return null;
  const yaz = async (s, g) => {
    if (!(await soruOnay(g ? `${s.ad} ${g} iş gününden itibaren yeni panelde GERÇEK kayda geçsin mi? Eski panel bu şube için kapanır.`
      : `${s.ad} pilottan çıksın mı? Yeni panel bu şube için yeniden denemeye döner, eski panel açılır.`, g ? 'Evet, başlat' : 'Evet, kaldır'))) return;
    setMesgul(s.id);
    try { const r = await api('/evvel-yeni/moduller/pilot', { method: 'POST', body: { sube_id: s.id, gun: g || null } }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul('');
  };
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <b>🧪 Pilot şube — {v.panel_baslangic} öncesi yeni panele geçiş</b>
      <div style={{ fontSize: 12.5, color: R.not }}>Pilottaki şube seçilen iş gününden itibaren yeni panelde gerçek kayıt tutar (açılış, kapanış, gider, teslim, sipariş, QR); eski panel o şube için kayıt almaz. İş günü gece 02:00'de değişir.</div>
      {v.subeler.map((s) => (
        <div key={s.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, fontSize: 13 }}>
          <span style={{ flex: '1 1 160px' }}><b>{s.ad}</b>{s.pilot && <Cip tur="sari">pilot · {s.pilot}'den beri</Cip>}</span>
          {s.pilot ? <Dugme kucuk disabled={!!mesgul} onClick={() => yaz(s, null)}>Pilottan çıkar</Dugme> : (<>
            <input type="date" value={gun[s.id] || ''} min={new Date().toISOString().slice(0, 10)} max={v.panel_baslangic} onChange={(e) => setGun((o) => ({ ...o, [s.id]: e.target.value }))}
              style={{ font: 'inherit', padding: '5px 8px', borderRadius: 8, border: `1px solid ${R.cizgi}`, background: 'var(--pi-bg)', color: 'var(--pi-ink)' }} />
            <Dugme kucuk ana disabled={!!mesgul || !gun[s.id]} onClick={() => yaz(s, gun[s.id])}>Pilot başlat</Dugme></>)}
        </div>
      ))}
    </div>
  );
}

// 🔐 YETKİLER (sahip 30 Eki "Mehmet Uçak müdürüm — bütün basamaklar tek tek, sök-tak" · Codex + Fable + Opus): hesap seç → her basamak
// Kapalı / Görür (ekran) · Kapalı / Yapar (işlem). Kip: gözlem (kimse engellenmez, yalnız sayılır) → zorla. Yalnız sahip ve ortak giriş görür.
function Yetkiler({ onToast }) {
  const [k, setK] = useState(null);
  const [soz, setSoz] = useState(null);
  const [sec, setSec] = useState('');
  const [taslak, setTaslak] = useState(null);
  const [goz, setGoz] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const yukle = useCallback(() => {
    Promise.all([api('/evvel-yeni/yetki/kullanicilar'), api('/evvel-yeni/yetki/sozluk'), api('/evvel-yeni/yetki/gozlem')])
      .then(([a, b, c]) => { setK(a); setSoz(b); setGoz(c); }).catch(() => setK(false));
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  if (k === false || !k || !soz) return null;   // sahip değilse hiç görünmez
  const kisi = k.kullanicilar.find((x) => x.id === sec);
  const ac = (x) => { setSec(x.id); setTaslak({ sahip: x.sahip, izinler: { ...x.izinler }, surum: x.surum }); };
  const kaydet = async () => {
    setMesgul(true);
    try { const r = await api(`/evvel-yeni/yetki/kisi/${encodeURIComponent(sec)}`, { method: 'POST', body: taslak }); onToast?.(r.mesaj); yukle(); setSec(''); setTaslak(null); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };
  const kipYaz = async (kip) => {
    if (kip === 'zorla' && !(await soruOnay('İzinler UYGULANSIN mı? Kaydı olmayan hesaplar hiçbir ekranı göremez. (Ortak şifre hep tam yetkili kalır.)', 'Evet, uygula'))) return;
    try { const r = await api('/evvel-yeni/yetki/kip', { method: 'POST', body: { kip } }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Değiştirilemedi'); }
  };
  const gruplar = [];
  for (const b of soz.basamaklar) { let g = gruplar.find((x) => x.mod === b.mod); if (!g) { g = { mod: b.mod, s: [] }; gruplar.push(g); } g.s.push(b); }
  const deger = (a) => taslak?.izinler[a] || 'kapali';
  const degis = (b, v) => setTaslak((t) => {
    const iz = { ...t.izinler, [b.anahtar]: v };
    if (b.tur === 'ekran' && v === 'kapali') soz.basamaklar.filter((x) => x.bagli === b.anahtar).forEach((x) => { iz[x.anahtar] = 'kapali'; });
    return { ...t, izinler: iz };
  });
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>🔐 Yetkiler</b>
        {k.kip === 'zorla' ? <Cip tur="yesil">izinler uygulanıyor</Cip> : <Cip tur="sari">gözlem — kimse engellenmiyor</Cip>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {k.kip === 'zorla' ? <Dugme kucuk onClick={() => kipYaz('gozlem')}>Gözleme al</Dugme> : <Dugme kucuk ana onClick={() => kipYaz('zorla')}>İzinleri uygula</Dugme>}
        </span>
      </div>
      {k.eslenmemis.length > 0 && <div style={{ color: R.amber, fontSize: 13 }}>İzni yazılmamış hesap: {k.eslenmemis.join(', ')} — uygulanınca bunlar hiçbir ekranı göremez.</div>}
      <table className="pi-tablo" style={{ fontSize: 13 }}>
        <thead><tr><th style={{ textAlign: 'left' }}>Hesap</th><th style={{ textAlign: 'left' }}>Durum</th><th /></tr></thead>
        <tbody>{k.kullanicilar.filter((x) => x.aktif).map((x) => (
          <tr key={x.id}><td style={{ textAlign: 'left' }}><b>{x.ad}</b> <span style={{ color: R.not }}>{x.kullanici_adi}{x.rol ? ` · ${x.rol}` : ''}</span></td>
            <td style={{ textAlign: 'left' }}>{x.sahip ? <Cip tur="yesil">sahip — hepsi</Cip> : x.kayit ? `${Object.keys(x.izinler).length} basamak açık` : <span style={{ color: R.amber }}>izin yazılmadı</span>}</td>
            <td><Dugme kucuk onClick={() => ac(x)}>İzinler</Dugme></td></tr>
        ))}</tbody>
      </table>
      {kisi && taslak && (
        <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--pi-line)', paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{kisi.ad}</b>
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={!!taslak.sahip} onChange={(e) => setTaslak((t) => ({ ...t, sahip: e.target.checked }))} /> Sahip (her şey açık)</label>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}><Dugme kucuk onClick={() => { setSec(''); setTaslak(null); }}>Vazgeç</Dugme><Dugme kucuk ana disabled={mesgul} onClick={kaydet}>Kaydet</Dugme></span>
          </div>
          {!taslak.sahip && gruplar.map((g) => (
            <div key={g.mod} style={{ display: 'grid', gap: 2 }}>
              <div style={{ fontSize: 12, color: R.not, letterSpacing: 1, textTransform: 'uppercase', marginTop: 6 }}>{g.mod}{g.s[0] && !g.s[0].modul_acik ? ' · modül kapalı' : ''}</div>
              {g.s.map((b) => {
                const ustKapali = b.bagli && deger(b.bagli) !== 'gor';
                const sec2 = b.tur === 'ekran' ? [['kapali', 'Kapalı'], ['gor', 'Görür']] : [['kapali', 'Kapalı'], ['yap', 'Yapar']];
                return (
                  <div key={b.anahtar} style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: b.tur === 'islem' ? 18 : 0, fontSize: 13.5 }}>
                    <span style={{ flex: 1 }}>{b.tur === 'islem' ? '↳ ' : ''}{b.ad}{b.hassas && <span style={{ color: R.kirmizi, fontSize: 11, marginLeft: 6 }}>HASSAS</span>}</span>
                    {sec2.map(([v, ad]) => (
                      <Dugme key={v} kucuk ana={deger(b.anahtar) === v} disabled={v !== 'kapali' && ustKapali} onClick={() => degis(b, v)}>{ad}</Dugme>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {goz?.satirlar?.length > 0 && (
        <details><summary style={{ cursor: 'pointer', fontSize: 13 }}>Gözlem: uygulansaydı engellenecek {goz.satirlar.length} istek türü</summary>
          <div style={{ fontSize: 12.5, display: 'grid', gap: 2, marginTop: 6 }}>{goz.satirlar.slice(0, 40).map((x, i) => (
            <div key={i}>{(k.kullanicilar.find((u) => u.id === x.kid) || {}).ad || x.kid} · {x.yontem} {x.yol} · {x.anahtar} · {x.sayi} kez</div>))}</div>
        </details>
      )}
    </div>
  );
}

export default function SistemDurumu({ onToast }) {
  const [g, setG] = useState(null);
  const [m, setM] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState('');
  const yukle = useCallback(() => {
    setHata('');
    Promise.all([api('/evvel-yeni/moduller/gorevler'), api('/evvel-yeni/moduller')])
      .then(([a, b]) => { setG(a); setM(b); }).catch((e) => setHata(e?.message || 'Okunamadı'));
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  const calistir = async (ad) => {
    setMesgul(ad);
    try {
      const r = await api(`/evvel-yeni/moduller/gorevler/${ad}/calistir`, { method: 'POST' });
      onToast?.(r.zaten ? 'Bu iş şu an zaten çalışıyor' : r.ok ? `Çalıştı · ${ozetYaz(r.ozet)}` : `Hata: ${r.hata || r.mesaj}`);
      yukle();
    } catch (e) { setHata(e?.message || 'Çalıştırılamadı'); }
    setMesgul('');
  };
  const sorunluMod = (m?.moduller || []).filter((x) => x.durum !== 'yuklendi');
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Tanımlar</div><h1 style={{ fontSize: 30 }}>Sistem durumu</h1></div>
      <Yetkiler onToast={onToast} />
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!g && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {g && (
        <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b>Otomatik işler</b>
            {g.zamanlayici ? <Cip tur="yesil">zamanlayıcı çalışıyor</Cip> : <Cip tur="kirmizi">zamanlayıcı çalışmıyor</Cip>}
          </div>
          <div style={{ overflowX: 'auto' }}>{/* F6.3 sim: dar ekranda (539 px) tablo sayfayı 57 px yana taşırıyordu */}
          <table className="pi-tablo" style={{ fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>İş</th><th style={{ textAlign: 'left' }}>Son koşu</th><th style={{ textAlign: 'left' }}>Ne yaptı</th><th>24 saatte</th><th /></tr></thead>
            <tbody>{g.gorevler.map((x) => {
              const son = x.son;
              return (
                <tr key={x.ad} style={{ background: son && !son.tamam ? 'var(--pi-bad-soft, #fbe9e7)' : x.gecikti ? 'var(--pi-warn-soft, #fff4e0)' : undefined }}>
                  <td style={{ textAlign: 'left' }}><b>{x.baslik}</b><div style={{ fontSize: 11.5, color: R.not }}>{x.modul} · her {Math.round(x.aralik_sn / 60)} dk</div></td>
                  <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                    {son ? saat(son.bitir) : 'henüz koşmadı'}{son?.elle ? ' (elle)' : ''}
                    {x.gecikti && <div style={{ color: R.amber, fontSize: 12 }}>gecikti{x.son_basarili ? ` · son başarılı ${saat(x.son_basarili.bitir)}` : ''}</div>}
                  </td>
                  <td style={{ textAlign: 'left' }}>
                    {son ? (son.hata ? <span style={{ color: son.tamam ? R.amber : R.kirmizi }}>{son.hata}</span> : ozetYaz(son.ozet)) : '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{x.kosu_24s} kez{x.hatali_24s ? <span style={{ color: R.kirmizi }}> · {x.hatali_24s} hatalı</span> : ''}</td>
                  <td><Dugme kucuk disabled={mesgul === x.ad} onClick={() => calistir(x.ad)}>{mesgul === x.ad ? 'Çalışıyor…' : 'Şimdi çalıştır'}</Dugme></td>
                </tr>
              );
            })}</tbody>
          </table>
          </div>
          {g.kayitsiz.length > 0 && <div style={{ color: R.kirmizi, fontSize: 12.5 }}>Kaydedilemeyen iş: {g.kayitsiz.map((x) => `${x.ad} (${x.hata})`).join(' · ')}</div>}
        </div>
      )}
      <SonAktarim onToast={onToast} />
      <ArsivSaglamasi />
      <EskiTablolar />
      <EskiYazim />
      <PilotSube onToast={onToast} />
      {m && (
        <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <b>Modüller</b>
          <div style={{ fontSize: 13 }}>{(m.moduller || []).filter((x) => x.durum === 'yuklendi').length} modül yüklü{sorunluMod.length ? '' : ' · sorun yok'}</div>
          {sorunluMod.map((x) => <div key={x.kod} style={{ fontSize: 13, color: x.durum === 'kapali' ? R.not : R.kirmizi }}>{x.ikon} {x.ad}: {durumYaz(x.durum, m.moduller)}</div>)}
        </div>
      )}
    </div>
  );
}
