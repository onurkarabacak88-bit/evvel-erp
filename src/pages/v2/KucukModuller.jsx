// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — küçük modüller (13 görünüm, 5 modül)
//
// Bu beşi tek dosyada: hiçbiri YENİ blok gerektirmiyor, hepsi mevcut
// KpiSeridi / Tablo / Liste üçlüsüyle kuruluyor. Ayrı dosyaya bölmek 5 kat
// kalıp kodu üretirdi; büyüyen bir modül çıkarsa kendi dosyasına taşınır.
//
//   OnayModulu    → onaylar.kuyruk / onaylar.ciro
//   YukModulu     → yuk.krediler / yuk.sabit
//   RaporModulu   → rapor.aylik / rapor.defter
//   SistemModulu  → sistem.excel / sistem.teslim / sistem.temizle
//   TanimModulu   → tanim.tedarikciler / tanim.zincir / tanim.dosya / tanim.tv
//
// ⚠️ Çoğu SALT-OKUR. İstisna (köprü kaldırma turu, 2026-07-29): OnayModulu
// onay/red artık YERLİ — klasik guard'lı uçlara yazar (onay-kuyrugu onayla/
// reddet/toplu-onayla + ciro-taslak onayla/reddet). Diğer yazma işleri
// (ödeme, silme, fiyat basma…) hâlâ köprülü.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, OnayModali } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const kisalt = (s, n = 60) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');
// ⚠️ İKİ YÖNLÜ TÜRKÇE-I TUZAĞI:
//   trKucuk  → 'İ'yi doğru çevirir ama ASCII 'I'yı NOKTASIZ 'ı' yapar.
//              'FAIZ' → 'faız', 'CIRO' → 'cıro' (yanlış).
//   slugAd   → veritabanı slug'ları (ASCII, BÜYÜK, alt çizgili) için: düz
//              toLowerCase + alt çizgi → boşluk. 'ANLIK_GIDER' → 'anlik gider'.
// Kural: TÜRKÇE metinde trKucuk, DB SLUG'ında slugAd.
const slugAd = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');
const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

const isoBugun = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

// ─── ortak kabuk parçaları ───────────────────────────────────────────────────
const Yukleniyor = ({ ad }) => (
  <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>{ad} yükleniyor…</div>
);

const Hata = ({ mesaj, onTekrar }) => (
  <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
    <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>{mesaj}</div>
    <button onClick={onTekrar} style={{
      marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
      fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
    }}>Tekrar dene</button>
  </div>
);

/** Veri yok / bu ekran henüz veri üretmiyor — uydurma sayı yerine dürüst kutu. */
const Bos = ({ baslik, aciklama, aksiyon, onAksiyon, renk = R.not }) => (
  <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
    <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: renk }}>{baslik}</div>
    {aciklama && (
      <div style={{ fontSize: 13, color: R.not, marginTop: 8, lineHeight: 1.6, maxWidth: 520, margin: '8px auto 0' }}>
        {aciklama}
      </div>
    )}
    {aksiyon && (
      <button onClick={onAksiyon} style={{
        marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
        background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
        fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
      }}>{aksiyon}</button>
    )}
  </div>
);

/** Ortak yükleyici: uç listesi → state. Hepsi hata-yutar. */
function useVeri(istekler, bagimlilik = []) {
  const [durum, setDurum] = useState({ yukleniyor: true, hata: '', veri: [] });
  const yukle = () => {
    setDurum(d => ({ ...d, yukleniyor: true, hata: '' }));
    Promise.all(istekler.map(([yol, varsayilan]) => api(yol).catch(() => varsayilan)))
      .then(v => setDurum({ yukleniyor: false, hata: '', veri: v }))
      .catch(e => setDurum({ yukleniyor: false, hata: e?.message || 'Veriler alınamadı.', veri: [] }));
  };
  useEffect(yukle, bagimlilik);
  return { ...durum, yukle };
}

// ─── küçük kadife modal (yerli onay/red akışları için) ──────────────────────
function KucukModal({ baslik, alt, onKapat, children, genislik = 470 }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onKapat?.(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
        backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{ ...kartYuzey, width: genislik, maxWidth: '96vw', maxHeight: '90vh', overflowY: 'auto', padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
          <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>{baslik}</div>
          {alt && <div style={{ fontSize: 11.5, color: R.not2, flex: 1 }}>{alt}</div>}
          <button onClick={onKapat} style={{
            marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
            fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
          }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const modalEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};
const modalAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};

// ═════════════════════════════════════════════════════════════════════════════
// 1) ONAY BEKLEYENLER — onaylar.kuyruk / onaylar.ciro
// Onay/red artık v2-YERLİ (köprü kaldırma turu, 2026-07-29): klasik ekranın
// guard'lı uçları AYNEN kullanılır (onayla=kasadan düşer, reddet neden'li).
// ═════════════════════════════════════════════════════════════════════════════
export function OnayModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/onay-kuyrugu?durum=bekliyor&limit=400', []],
    ['/ciro-taslak?durum=bekliyor', []],
    ['/subeler', []],
  ]);
  const [mesgul, setMesgul] = useState(false);
  const [reddetSor, setReddetSor] = useState(null);   // onay kaydı (kuyruk reddi)
  const [topluSor, setTopluSor] = useState(false);    // toplu onay son kapısı
  const [ciroSor, setCiroSor] = useState(null);       // {kayit,nakit,pos,online}
  const [ciroRed, setCiroRed] = useState(null);       // {kayit,neden}
  if (yukleniyor) return <Yukleniyor ad="Onay kuyruğu" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const calistir = async (islem, basari) => {
    setMesgul(true);
    try {
      const r = await islem();
      onToast?.(typeof basari === 'function' ? basari(r) : basari);
      yukle();
      return true;
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
      return false;
    } finally {
      setMesgul(false);
    }
  };

  const [kuyrukHam, ciroHam, subeler] = veri;
  const kuyruk = Array.isArray(kuyrukHam) ? kuyrukHam : [];
  const ciro = Array.isArray(ciroHam) ? ciroHam : [];
  const subeAd = (id) => (subeler || []).find(s => String(s.id) === String(id))?.ad || '—';

  if (gorunum === 'kuyruk') {
    // ⚠️ Kasa hatası kuralı korundu: islem_turu'nde KASA geçen kayıtlar kuyruğa
    // düşmez (bunlar kasa uyumsuzluğu, onay işi değil) — eski ekrandaki filtre.
    const satir = kuyruk.filter(o => !String(o.islem_turu || '').toUpperCase().includes('KASA'));
    const toplam = satir.reduce((s, o) => s + sayi(o.tutar), 0);
    const gunFark = (t) => {
      if (!t) return null;
      const d = Math.round((new Date(isoBugun() + 'T00:00:00Z') - new Date(String(t).slice(0, 10) + 'T00:00:00Z')) / 86400000);
      return Number.isFinite(d) ? d : null;
    };
    const enEski = satir.reduce((a, o) => Math.max(a, gunFark(o.tarih) ?? 0), 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bekleyen onay', deger: String(satir.length), alt: 'gider · avans · fire · tanım', renk: satir.length ? R.amber : R.yesil },
          { etiket: 'Toplam tutar', deger: fmt(toplam), alt: 'onay bekleyen', renk: toplam ? R.amber : R.krem },
          { etiket: 'En eski', deger: enEski ? `${enEski} gün` : '—', alt: enEski > 2 ? 'gecikiyor' : 'taze', renk: enEski > 2 ? R.kirmizi : R.krem },
          { etiket: 'Kasa hatası ayrı', deger: String(kuyruk.length - satir.length), alt: 'onay değil · kasa uyumsuzluğu', renk: R.not },
        ]} />
        {satir.length > 1 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button disabled={mesgul} onClick={() => setTopluSor(true)} style={{
              padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
              fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
            }}>
              Hepsini onayla ({satir.length})
            </button>
          </div>
        )}
        {satir.length ? (
          <Liste
            satirlar={satir.slice(0, 60).map(o => ({
              id: o.id, _o: o,
              baslik: o.aciklama || slugAd(o.islem_turu) || 'Onay kaydı',
              alt: `${slugAd(o.islem_turu)} · ${kisaTarih(o.tarih)}${o.kaynak_tablo ? ` · ${o.kaynak_tablo}` : ''}`,
              tutar: sayi(o.tutar) ? fmt(o.tutar) : '',
              tier: (gunFark(o.tarih) ?? 0) > 2 ? 'kritik' : 'uyari',
              aksiyonlar: [
                { ad: '✓ Onayla', birincil: true, onTikla: () => !mesgul && calistir(
                  () => api(`/onay-kuyrugu/${o.id}/onayla`, { method: 'POST' }),
                  '✓ Onaylandı — kasadan düşüldü',
                ) },
                { ad: '✗ Reddet', onTikla: () => setReddetSor(o) },
              ],
            }))}
            onAc={(l) => onCekmece?.({
              tip: 'ONAY KAYDI',
              baslik: l._o.aciklama || slugAd(l._o.islem_turu),
              alt: `${slugAd(l._o.islem_turu)} · ${kisaTarih(l._o.tarih)}`,
              kpi: [
                { etiket: 'Tutar', deger: sayi(l._o.tutar) ? fmt(l._o.tutar) : '—' },
                { etiket: 'Bekleme', deger: `${gunFark(l._o.tarih) ?? 0} gün`, renk: (gunFark(l._o.tarih) ?? 0) > 2 ? R.kirmizi : R.krem },
              ],
              listeBaslik: 'Kaynak',
              satirlar: [
                { ad: 'İşlem türü', detay: 'kuyruk sınıfı', tutar: slugAd(l._o.islem_turu) },
                { ad: 'Kaynak tablo', detay: 'kaydın geldiği yer', tutar: l._o.kaynak_tablo || '—' },
              ],
              not: 'Onay/red satırın sağındaki butonlardan verilir — onay kasadan düşer, red neden sorar.',
            })}
          />
        ) : (
          <Bos baslik="Onay bekleyen kayıt yok" aciklama="Kuyruk temiz — gider, avans, fire ve tanım değişiklikleri onaylanmış." renk={R.yesil} />
        )}

        {/* Toplu onay son kapısı */}
        <OnayModali
          acik={topluSor}
          baslik="Toplu onay"
          altBaslik={`${satir.length} bekleyen kayıt onaylanacak`}
          tutar={fmt(toplam)}
          satirlar={satir.slice(0, 8).map(o => ({
            ad: (o.aciklama || slugAd(o.islem_turu) || 'kayıt').slice(0, 44),
            deger: sayi(o.tutar) ? fmt(o.tutar) : '—',
          })).concat(satir.length > 8 ? [{ ad: `… ve ${satir.length - 8} kayıt daha`, deger: '' }] : [])}
          not="Onaylanan her gider kasadan düşülür. Bu işlem tek tek geri alınır (ters kayıt)."
          onaylaAd={mesgul ? 'Onaylanıyor…' : `Evet, ${satir.length} kaydı onayla`}
          calisiyor={mesgul}
          onOnayla={async () => {
            const ok = await calistir(
              () => api('/onay-kuyrugu/toplu-onayla', { method: 'POST', body: { ids: satir.map(o => o.id) } }),
              (r) => `✓ ${r?.onaylanan ?? '?'}/${r?.toplam ?? satir.length} onaylandı${sayi(r?.hata) > 0 ? ` · ${r.hata} hata` : ''}`,
            );
            if (ok) setTopluSor(false);
          }}
          onKapat={() => setTopluSor(false)}
        />

        {/* Red sebebi — klasik ekranın iki anlamlı seçeneği korunur */}
        {reddetSor && (
          <KucukModal
            baslik="Reddetme sebebi"
            alt={(reddetSor.aciklama || slugAd(reddetSor.islem_turu) || '').slice(0, 60)}
            onKapat={() => setReddetSor(null)}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                ['hata', '🔧 Hata', 'Plan yanlış oluştu. Kaynak aktif kalır, gelecek ay tekrar üretilir.', R.cizgi3, R.krem],
                ['surec_bitti', '🚫 Süreç bitti', 'İlişki kesildi. Kaynak kapatılır, bir daha plan üretilmez.', `${R.kirmizi}66`, R.kirmizi],
              ].map(([neden, ad, aciklama, kenar, renk]) => (
                <button key={neden} disabled={mesgul} onClick={async () => {
                  const ok = await calistir(
                    () => api(`/onay-kuyrugu/${reddetSor.id}/reddet`, { method: 'POST', body: { neden } }),
                    neden === 'surec_bitti'
                      ? 'Reddedildi — kaynak kapatıldı, plan üretilmeyecek'
                      : 'Reddedildi — plan iptal, kaynak aktif',
                  );
                  if (ok) setReddetSor(null);
                }} style={{
                  textAlign: 'left', padding: '13px 16px', borderRadius: 12, cursor: 'pointer',
                  border: `1px solid ${kenar}`, background: R.girinti, fontFamily: 'inherit',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: renk }}>{ad}</div>
                  <div style={{ fontSize: 11.5, color: R.not, marginTop: 4, lineHeight: 1.5 }}>{aciklama}</div>
                </button>
              ))}
            </div>
          </KucukModal>
        )}
      </>
    );
  }

  // onaylar.ciro
  const toplamCiro = ciro.reduce((s, c) => s + sayi(c.nakit) + sayi(c.pos) + sayi(c.online), 0);
  const gunler = [...new Set(ciro.map(c => String(c.tarih).slice(0, 10)))];
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Bekleyen ciro onayı', deger: String(ciro.length), alt: gunler.length ? gunler.map(kisaTarih).join(', ') : 'yok', renk: ciro.length ? R.amber : R.yesil },
        { etiket: 'Toplam ciro', deger: fmt(toplamCiro), alt: 'onaylanınca deftere işlenir', renk: R.krem },
        { etiket: 'Şube', deger: String(new Set(ciro.map(c => c.sube_id)).size), alt: 'taslak gönderen', renk: R.krem },
        { etiket: 'Onay sonrası', deger: 'deftere işlenir', alt: 'geri alma: ters kayıt', renk: R.not },
      ]} />
      {ciro.length ? (
        <Liste
          satirlar={ciro.map(c => {
            const t = sayi(c.nakit) + sayi(c.pos) + sayi(c.online);
            return {
              id: c.id, _c: c,
              baslik: c.sube_adi || subeAd(c.sube_id),
              alt: `${kisaTarih(c.tarih)} · nakit ${fmt(sayi(c.nakit))} · POS ${fmt(sayi(c.pos))} · online ${fmt(sayi(c.online))}`,
              tutar: fmt(t),
              tier: 'uyari',
              aksiyonlar: [
                { ad: '✓ Onayla', birincil: true, onTikla: () => setCiroSor({
                  kayit: c, nakit: String(sayi(c.nakit)), pos: String(sayi(c.pos)), online: String(sayi(c.online)),
                }) },
                { ad: '✗ Reddet', onTikla: () => setCiroRed({ kayit: c, neden: '' }) },
              ],
            };
          })}
          onAc={(l) => {
            const c = l._c;
            const t = sayi(c.nakit) + sayi(c.pos) + sayi(c.online);
            onCekmece?.({
              tip: 'CİRO TASLAĞI',
              baslik: c.sube_adi || subeAd(c.sube_id),
              alt: `${kisaTarih(c.tarih)} · personel taslağı`,
              kpi: [
                { etiket: 'Toplam', deger: fmt(t) },
                { etiket: 'Nakit payı', deger: t ? `%${trSayi((sayi(c.nakit) / t) * 100, 0)}` : '—' },
              ],
              listeBaslik: 'Kırılım',
              satirlar: [
                { ad: 'Nakit', detay: 'kasaya giren', tutar: fmt(sayi(c.nakit)) },
                { ad: 'POS', detay: 'kart', tutar: fmt(sayi(c.pos)) },
                { ad: 'Online', detay: 'platform', tutar: fmt(sayi(c.online)) },
                { ad: 'Açıklama', detay: 'personel notu', tutar: c.aciklama || '—' },
              ],
              not: 'Onay/red satırın sağındaki butonlardan verilir — onayda tutarlar düzeltilebilir.',
            });
          }}
        />
      ) : (
        <Bos baslik="Bekleyen ciro onayı yok" aciklama="Şubelerden gelen tüm ciro taslakları işlenmiş." renk={R.yesil} />
      )}

      {/* Ciro onayı — tutarlar düzeltilebilir (klasik ekran davranışı korunur) */}
      {ciroSor && (() => {
        const t = sayi(ciroSor.nakit) + sayi(ciroSor.pos) + sayi(ciroSor.online);
        const alan = (k, v) => setCiroSor(s => ({ ...s, [k]: v }));
        return (
          <KucukModal
            baslik="Ciroyu onayla"
            alt={`${ciroSor.kayit.sube_adi || subeAd(ciroSor.kayit.sube_id)} · ${kisaTarih(ciroSor.kayit.tarih)}`}
            onKapat={() => !mesgul && setCiroSor(null)}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              {[['nakit', 'Nakit (₺)'], ['pos', 'POS (₺)'], ['online', 'Online (₺)']].map(([k, ad]) => (
                <div key={k}>
                  <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>{ad}</label>
                  <input type="number" value={ciroSor[k]} onChange={(e) => alan(k, e.target.value)}
                    style={{ ...modalAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
              ))}
            </div>
            <div style={{
              marginTop: 14, padding: '11px 15px', borderRadius: 12, background: R.girinti,
              border: `1px solid ${R.cizgi3}`, fontSize: 12.5, color: R.metin2,
            }}>
              Toplam <strong style={{ fontFamily: F.mono, color: R.krem }}>{fmt(t)}</strong> — onaylanınca ciro defterine ve kasaya işlenir.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button disabled={mesgul} onClick={() => setCiroSor(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={mesgul || t <= 0} onClick={async () => {
                const ok = await calistir(
                  () => api(`/ciro-taslak/${ciroSor.kayit.id}/onayla`, {
                    method: 'POST',
                    body: { nakit: sayi(ciroSor.nakit), pos: sayi(ciroSor.pos), online: sayi(ciroSor.online) },
                  }),
                  (r) => `✓ Onaylandı — net kasa: ${fmt(sayi(r?.net_tutar))}`,
                );
                if (ok) setCiroSor(null);
              }} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none',
                background: t > 0 ? 'linear-gradient(150deg, #D99A4E, #B06E2C)' : R.girinti,
                color: t > 0 ? '#1C1309' : R.not, fontSize: 12.5, fontWeight: 700,
                fontFamily: 'inherit', cursor: t > 0 ? 'pointer' : 'default',
              }}>
                {mesgul ? 'Onaylanıyor…' : 'Onayla — kasaya işle'}
              </button>
            </div>
          </KucukModal>
        );
      })()}

      {/* Ciro reddi — neden'li, şube yeni taslak gönderebilir */}
      {ciroRed && (
        <KucukModal
          baslik="Taslağı reddet"
          alt={`${ciroRed.kayit.sube_adi || subeAd(ciroRed.kayit.sube_id)} · ${kisaTarih(ciroRed.kayit.tarih)}`}
          onKapat={() => !mesgul && setCiroRed(null)}
        >
          <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>
            Red nedeni
          </label>
          <input value={ciroRed.neden} placeholder="örn. tutar hatalı"
            onChange={(e) => setCiroRed(s => ({ ...s, neden: e.target.value }))} style={modalAlanStil} />
          <div style={{ fontSize: 11.5, color: R.not, marginTop: 10, lineHeight: 1.5 }}>
            Reddedilen taslak silinmez — şube düzeltip yeni taslak gönderebilir.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button disabled={mesgul} onClick={() => setCiroRed(null)} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={mesgul} onClick={async () => {
              const ok = await calistir(
                () => api(`/ciro-taslak/${ciroRed.kayit.id}/reddet`, {
                  method: 'POST', body: { neden: (ciroRed.neden || '').trim() || 'Tutar hatalı' },
                }),
                'Taslak reddedildi — şube yeni taslak gönderebilir',
              );
              if (ok) setCiroRed(null);
            }} style={{
              padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            }}>
              {mesgul ? 'Reddediliyor…' : 'Reddet'}
            </button>
          </div>
        </KucukModal>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 2) YÜKÜMLÜLÜKLER — yuk.krediler / yuk.sabit
// ═════════════════════════════════════════════════════════════════════════════
export function YukModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/borclar', []],
    ['/sabit-giderler', []],
    ['/sabit-giderler/odemeler', null],
    ['/subeler', []],
  ]);
  // v2-YERLİ sabit gider CRUD (köprü kaldırma turu) — klasik guard'lar korunur
  const [sgForm, setSgForm] = useState(null);      // {duzenleId?, gider_adi, tip, kategori, ...}
  const [sgMesgul, setSgMesgul] = useState(false);
  const [sgKapatSor, setSgKapatSor] = useState('');
  const [sgKartlar, setSgKartlar] = useState([]);
  if (yukleniyor) return <Yukleniyor ad="Yükümlülükler" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const SG_ZORUNLU_KAT = ['Kira'];
  const sgAc = (g) => {
    setSgForm(g ? {
      duzenleId: g.id, gider_adi: g.gider_adi || '', tip: g.tip || 'sabit',
      kategori: g.kategori || 'Kira', tutar: g.tutar != null ? String(g.tutar) : '',
      periyot: g.periyot || 'aylik', odeme_gunu: g.odeme_gunu || 1,
      sube_id: g.sube_id || '', baslangic_tarihi: String(g.baslangic_tarihi || '').slice(0, 10),
      gecerlilik_tarihi: '', sozlesme_sure_ay: g.sozlesme_sure_ay || '',
      kira_artis_periyot: g.kira_artis_periyot || '',
      odeme_yontemi: g.odeme_yontemi || 'nakit', kart_id: g.kart_id || '',
      stopaj_yuzde: g.stopaj_oran ? String(Math.round(Number(g.stopaj_oran) * 100)) : '',
    } : {
      duzenleId: null, gider_adi: '', tip: 'sabit', kategori: 'Kira', tutar: '',
      periyot: 'aylik', odeme_gunu: 1, sube_id: '', baslangic_tarihi: '',
      gecerlilik_tarihi: '', sozlesme_sure_ay: '', kira_artis_periyot: '',
      odeme_yontemi: 'nakit', kart_id: '', stopaj_yuzde: '',
    });
    if (!sgKartlar.length) api('/kartlar').then((d) => setSgKartlar(Array.isArray(d) ? d : [])).catch(() => {});
  };

  const sgKaydet = async () => {
    const f = sgForm;
    const degisken = f.tip === 'degisken';
    const kiraGibi = !degisken && SG_ZORUNLU_KAT.includes(f.kategori);
    if (!f.gider_adi.trim()) { onToast?.('Gider adı zorunlu'); return; }
    if (!degisken && !(parseFloat(f.tutar) > 0)) { onToast?.('Geçerli bir tutar girin'); return; }
    if (!f.odeme_gunu) { onToast?.('Ödeme günü zorunlu'); return; }
    if (!degisken && !f.sube_id) { onToast?.('Şube seçimi zorunlu — şubesiz gider kâr hesabına girmez'); return; }
    if (kiraGibi && !f.duzenleId && !f.baslangic_tarihi) { onToast?.('Kira için başlangıç tarihi zorunlu'); return; }
    if (kiraGibi && f.duzenleId && !f.gecerlilik_tarihi) { onToast?.('Hangi aydan itibaren geçerli? — tarih zorunlu'); return; }
    setSgMesgul(true);
    try {
      const body = {
        gider_adi: f.gider_adi, kategori: f.kategori, tip: f.tip || 'sabit',
        tutar: parseFloat(f.tutar) || 0, periyot: f.periyot || 'aylik',
        odeme_gunu: parseInt(f.odeme_gunu, 10) || 1,
        odeme_yontemi: f.odeme_yontemi || 'nakit',
        sube_id: f.sube_id || null, kart_id: f.kart_id || null,
        baslangic_tarihi: f.baslangic_tarihi || null,
        gecerlilik_tarihi: f.gecerlilik_tarihi || null,
        sozlesme_sure_ay: f.sozlesme_sure_ay ? parseInt(f.sozlesme_sure_ay, 10) : null,
        kira_artis_periyot: f.kira_artis_periyot || null,
        stopaj_oran: f.kategori === 'Kira' ? ((parseFloat(f.stopaj_yuzde) || 0) / 100) : 0,
      };
      if (f.duzenleId) await api(`/sabit-giderler/${f.duzenleId}`, { method: 'PUT', body });
      else await api('/sabit-giderler', { method: 'POST', body });
      onToast?.('✓ Sabit gider kaydedildi');
      setSgForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setSgMesgul(false);
    }
  };

  const sgKapat = async (id) => {
    setSgMesgul(true);
    try {
      const r = await api(`/sabit-giderler/${id}`, { method: 'DELETE' });
      onToast?.(sayi(r?.iptal_edilen_plan) > 0
        ? `Kapatıldı — ${r.iptal_edilen_plan} bekleyen plan iptal edildi`
        : 'Gider kapatıldı');
      setSgKapatSor('');
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Kapatılamadı');
    } finally {
      setSgMesgul(false);
    }
  };

  const [krediHam, sabitHam, odemeler, sgSubeler] = veri;
  const krediler = (Array.isArray(krediHam) ? krediHam : []).filter(k => k.aktif !== false);
  const sabitler = (Array.isArray(sabitHam) ? sabitHam : []).filter(g => g.aktif !== false);

  if (gorunum === 'krediler') {
    const kalanTop = krediler.reduce((s, k) => s + sayi(k.toplam_borc), 0);
    const taksitTop = krediler.reduce((s, k) => s + sayi(k.aylik_taksit), 0);
    const odemesiz = krediler.filter(k => sayi(k.aylik_taksit) === 0);
    const enYakinBitis = krediler
      .filter(k => sayi(k.kalan_vade) > 0)
      .sort((a, b) => sayi(a.kalan_vade) - sayi(b.kalan_vade))[0];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kalan borç', deger: fmt(kalanTop), alt: `${krediler.length} kredi`, renk: R.kirmizi },
          { etiket: 'Aylık taksit', deger: fmt(taksitTop), alt: 'toplam yük', renk: R.amber },
          { etiket: 'Ödemesiz dönemde', deger: String(odemesiz.length), alt: odemesiz.length ? 'taksiti henüz başlamadı' : 'yok', renk: odemesiz.length ? R.amber : R.yesil },
          { etiket: 'İlk biten', deger: enYakinBitis ? `${enYakinBitis.kalan_vade} taksit` : '—', alt: enYakinBitis ? enYakinBitis.kurum : 'veri yok', renk: R.yesil },
        ]} />
        {krediler.length ? (
          <Tablo
            baslik="Banka kredileri"
            not="satıra tıkla → kredi dosyası"
            kolonlar={[
              { ad: 'Kurum' }, { ad: 'Tür' }, { ad: 'Kalan borç', sag: true },
              { ad: 'Aylık taksit', sag: true }, { ad: 'Kalan vade', sag: true },
              { ad: 'Ödeme günü', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={krediler.map(k => ({
              id: k.id, _k: k,
              hucreler: [
                { v: k.kurum, kalin: true },
                { v: slugAd(k.borc_turu) || '—', renk: R.not },
                { v: fmt(sayi(k.toplam_borc)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                { v: sayi(k.aylik_taksit) ? fmt(k.aylik_taksit) : '—', mono: true, sag: true, renk: sayi(k.aylik_taksit) ? R.amber : R.not },
                { v: `${sayi(k.kalan_vade)}/${sayi(k.toplam_vade)}`, mono: true, sag: true },
                { v: k.odeme_gunu ? `ayın ${k.odeme_gunu}` : '—', mono: true, sag: true },
                {
                  v: sayi(k.aylik_taksit) ? 'ödeniyor' : 'ödemesiz dönem',
                  rozet: sayi(k.aylik_taksit) ? R.yesil : R.amber,
                },
              ],
            }))}
            onSatir={(row) => {
              const k = row._k;
              const odenen = sayi(k.toplam_vade) - sayi(k.kalan_vade);
              onCekmece?.({
                tip: 'KREDİ DOSYASI',
                baslik: k.kurum,
                alt: `${slugAd(k.borc_turu) || 'kredi'} · ${sayi(k.toplam_vade)} taksit`,
                kpi: [
                  { etiket: 'Kalan borç', deger: fmt(sayi(k.toplam_borc)), renk: R.kirmizi },
                  { etiket: 'Aylık taksit', deger: sayi(k.aylik_taksit) ? fmt(k.aylik_taksit) : '—', renk: R.amber },
                  { etiket: 'Ödenen taksit', deger: `${odenen}/${sayi(k.toplam_vade)}` },
                  { etiket: 'Ödeme günü', deger: k.odeme_gunu ? `ayın ${k.odeme_gunu}` : '—' },
                ],
                listeBaslik: 'Zaman çizgisi',
                satirlar: [
                  { ad: 'Başlangıç', detay: 'kredi çekimi', tutar: kisaTarih(k.baslangic_tarihi) },
                  { ad: 'Kalan vade', detay: 'bitmesine', tutar: `${sayi(k.kalan_vade)} taksit` },
                  { ad: 'Kalan toplam ödeme', detay: 'taksit × kalan vade', tutar: fmt(sayi(k.aylik_taksit) * sayi(k.kalan_vade)) },
                ],
                not: sayi(k.aylik_taksit)
                  ? 'Taksit ödeme kuyruğuna otomatik düşer; ödeme Ödeme Merkezi\'nden yapılır.'
                  : 'Ödemesiz dönemde — taksit başladığında aylık yük artacak, borç takviminde görünür.',
                aksiyonAd: 'Borç envanterini aç',
                _hedef: '__modul:yuk:krediler',
              });
            }}
          />
        ) : (
          <Bos baslik="Kayıtlı kredi yok" aciklama="Borç envanterine kredi girildiğinde aylık yük buradan izlenir." aksiyon="Borç envanterini aç" onAksiyon={() => onKopru?.('__modul:yuk:krediler')} />
        )}
      </>
    );
  }

  // yuk.sabit
  const toplamSabit = sabitler.reduce((s, g) => s + sayi(g.tutar), 0);
  const kira = sabitler.filter(g => trKucuk(g.kategori).includes('kira'));
  const odendi = sabitler.filter(g => g.bu_ay_odendi);
  const bekleyen = sabitler.filter(g => !g.bu_ay_odendi);
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Aylık sabit gider', deger: fmt(toplamSabit), alt: `${sabitler.length} kalem` },
        { etiket: 'Kira payı', deger: fmt(kira.reduce((s, g) => s + sayi(g.tutar), 0)), alt: toplamSabit ? `%${trSayi((kira.reduce((s, g) => s + sayi(g.tutar), 0) / toplamSabit) * 100, 0)}` : '—', renk: R.krem },
        { etiket: 'Bu ay ödenen', deger: String(odendi.length), alt: fmt(odendi.reduce((s, g) => s + sayi(g.tutar), 0)), renk: R.yesil },
        { etiket: 'Bu ay bekleyen', deger: String(bekleyen.length), alt: fmt(bekleyen.reduce((s, g) => s + sayi(g.tutar), 0)), renk: bekleyen.length ? R.amber : R.yesil },
      ]} />
      <div style={{ display: 'flex', gap: 9, marginBottom: 12 }}>
        <button onClick={() => sgAc(null)} style={{
          padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
          background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
          fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
        }}>
          + Yeni sabit gider
        </button>
      </div>
      {sabitler.length ? (
        <Liste
          satirlar={sabitler.map(g => ({
            id: g.id, _g: g,
            baslik: g.gider_adi,
            alt: `${g.kategori || '—'} · ${g.sube_adi || 'genel'} · ${slugAd(g.periyot) || 'aylık'}${g.odeme_gunu ? ` · ayın ${g.odeme_gunu}` : ''}`,
            tutar: sayi(g.tutar) ? fmt(g.tutar) : '≈ değişken',
            tier: g.bu_ay_odendi ? 'olumlu' : 'uyari',
            rozet: g.bu_ay_odendi ? 'ödendi' : 'bekliyor',
            rozetRenk: g.bu_ay_odendi ? R.yesil : R.amber,
            aksiyonlar: sgKapatSor === String(g.id) ? [
              { ad: sgMesgul ? '…' : 'Eminim — kapat', birincil: true, onTikla: () => !sgMesgul && sgKapat(g.id) },
              { ad: 'Vazgeç', onTikla: () => setSgKapatSor('') },
            ] : [
              { ad: '✎ Düzenle', birincil: true, onTikla: () => sgAc(g) },
              { ad: 'Kapat', onTikla: () => setSgKapatSor(String(g.id)) },
            ],
          }))}
          onAc={(l) => {
            const g = l._g;
            onCekmece?.({
              tip: 'SABİT GİDER',
              baslik: g.gider_adi,
              alt: `${g.kategori || 'gider'} · ${g.sube_adi || 'genel'}`,
              kpi: [
                { etiket: 'Tutar', deger: sayi(g.tutar) ? fmt(g.tutar) : '≈ değişken' },
                { etiket: 'Periyot', deger: slugAd(g.periyot) || 'aylık' },
                { etiket: 'Ödeme günü', deger: g.odeme_gunu ? `ayın ${g.odeme_gunu}` : '—' },
                { etiket: 'Bu ay', deger: g.bu_ay_odendi ? 'ödendi' : 'bekliyor', renk: g.bu_ay_odendi ? R.yesil : R.amber },
              ],
              listeBaslik: 'Ödeme bilgisi',
              satirlar: [
                { ad: 'Ödeme yöntemi', detay: 'talimat', tutar: slugAd(g.odeme_yontemi) || 'manuel' },
                { ad: 'Başlangıç', detay: 'ilk dönem', tutar: kisaTarih(g.baslangic_tarihi) },
              ],
              not: sayi(g.tutar)
                ? 'Sabit tutarlı gider — ödeme kuyruğuna otomatik düşer. Düzenleme/kapatma satır butonlarından.'
                : 'Değişken tutarlı: her ay fatura tutarı sorulur; ödemesi hatırlatma akışından girilir.',
            });
          }}
        />
      ) : (
        <Bos baslik="Sabit gider tanımlı değil" aciklama="Kira, enerji, abonelik gibi düzenli giderler tanımlanınca ödeme kuyruğuna otomatik düşer." aksiyon="+ Yeni sabit gider" onAksiyon={() => sgAc(null)} />
      )}

      {/* ── YERLİ SABİT GİDER FORMU (klasik doğrulamalar korunur) ── */}
      {sgForm && (() => {
        const f = sgForm;
        const alan = (k, v) => setSgForm((p) => ({ ...p, [k]: v }));
        const degisken = f.tip === 'degisken';
        const kiraGibi = SG_ZORUNLU_KAT.includes(f.kategori);
        return (
          <KucukModal
            baslik={f.duzenleId ? 'Gideri Düzenle' : 'Yeni Sabit Gider'}
            alt="ödeme kuyruğuna otomatik düşer"
            onKapat={() => !sgMesgul && setSgForm(null)}
            genislik={560}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Gider adı *</label>
                <input value={f.gider_adi} onChange={(e) => alan('gider_adi', e.target.value)} style={modalAlanStil} />
              </div>
              <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[['sabit', '📌 Sabit — her ay aynı tutar'], ['degisken', '📄 Değişken — elektrik/su gibi']].map(([t, ad]) => (
                  <div key={t} onClick={() => alan('tip', t)} style={{
                    padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${f.tip === t ? R.bakir : R.cizgi3}`,
                    color: f.tip === t ? R.bakir : R.metin2,
                    background: f.tip === t ? 'rgba(217,154,78,.12)' : 'transparent',
                  }}>{ad}</div>
                ))}
                {degisken && (
                  <div style={{ width: '100%', fontSize: 11.5, color: R.amber, lineHeight: 1.5 }}>
                    ⚡ Değişken gider hatırlatmadır — ödeme geldiğinde tutar sorulur, Anlık Gider olarak işlenir.
                  </div>
                )}
              </div>
              <div>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Kategori</label>
                <select value={f.kategori} onChange={(e) => alan('kategori', e.target.value)} style={modalAlanStil}>
                  {['Kira', 'Fatura', 'Abonelik', 'Ulaşım', 'Diğer'].map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Tutar (₺){degisken ? '' : ' *'}</label>
                <input type="number" value={f.tutar} onChange={(e) => alan('tutar', e.target.value)}
                  style={{ ...modalAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
              </div>
              <div>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Periyot</label>
                <select value={f.periyot} onChange={(e) => alan('periyot', e.target.value)} style={modalAlanStil}>
                  {[['aylik', 'Aylık'], ['3aylik', '3 Aylık'], ['6aylik', '6 Aylık'], ['yillik', 'Yıllık'], ['haftalik', 'Haftalık']].map(([v, ad]) => <option key={v} value={v}>{ad}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Ödeme günü *</label>
                <input type="number" min={1} max={31} value={f.odeme_gunu} onChange={(e) => alan('odeme_gunu', e.target.value)}
                  style={{ ...modalAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
              </div>
              <div>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Şube{degisken ? '' : ' *'}</label>
                <select value={f.sube_id} onChange={(e) => alan('sube_id', e.target.value)} style={modalAlanStil}>
                  <option value="">Seçin…</option>
                  {(sgSubeler || []).map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
                </select>
                {!degisken && <div style={{ fontSize: 10.5, color: R.not, marginTop: 4 }}>şubesiz gider kâr hesabına girmez</div>}
              </div>
              {!f.duzenleId && (
                <div>
                  <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Başlangıç tarihi{kiraGibi ? ' *' : ''}</label>
                  <input type="date" value={f.baslangic_tarihi} onChange={(e) => alan('baslangic_tarihi', e.target.value)}
                    style={{ ...modalAlanStil, colorScheme: 'dark' }} />
                </div>
              )}
              {f.duzenleId && kiraGibi && (
                <div style={{ gridColumn: '1/-1', padding: '11px 14px', borderRadius: 12, background: `${R.amber}12`, border: `1px solid ${R.amber}55` }}>
                  <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.amber, fontWeight: 700, marginBottom: 6, display: 'block' }}>📅 Hangi aydan itibaren geçerli? *</label>
                  <input type="date" value={f.gecerlilik_tarihi} onChange={(e) => alan('gecerlilik_tarihi', e.target.value)}
                    style={{ ...modalAlanStil, colorScheme: 'dark' }} />
                  <div style={{ fontSize: 10.5, color: R.not, marginTop: 5 }}>Eski kayıt kapanır, bu tarihten itibaren yeni tutar geçerli olur.</div>
                </div>
              )}
              {['Kira', 'Abonelik'].includes(f.kategori) && (
                <>
                  <div>
                    <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>📋 Sözleşme süresi (ay)</label>
                    <input type="number" min={1} max={120} placeholder="örn. 12" value={f.sozlesme_sure_ay}
                      onChange={(e) => alan('sozlesme_sure_ay', e.target.value)}
                      style={{ ...modalAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>📈 Kira artış periyodu</label>
                    <select value={f.kira_artis_periyot} onChange={(e) => alan('kira_artis_periyot', e.target.value)} style={modalAlanStil}>
                      <option value="">Yok</option>
                      {[['6ay', '6 Aylık'], ['1yil', 'Yıllık'], ['2yil', '2 Yıllık'], ['5yil', '5 Yıllık']].map(([v, ad]) => <option key={v} value={v}>{ad}</option>)}
                    </select>
                  </div>
                  {f.kategori === 'Kira' && (
                    <div style={{ gridColumn: '1/-1' }}>
                      <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>🏠 Stopaj oranı (%)</label>
                      <input type="number" value={f.stopaj_yuzde} placeholder="0 (şahıs kirasında 20)"
                        onChange={(e) => alan('stopaj_yuzde', e.target.value)}
                        style={{ ...modalAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                      <div style={{ fontSize: 10.5, color: R.not, marginTop: 4 }}>
                        Şahıstan işyeri kirasında %20 stopaj vergi dairesine ödenir.
                        {parseFloat(f.stopaj_yuzde) > 0 && parseFloat(f.tutar) > 0 &&
                          ` Aylık stopaj: ${fmt(Math.round((parseFloat(f.tutar) * parseFloat(f.stopaj_yuzde)) / 100))}`}
                      </div>
                    </div>
                  )}
                </>
              )}
              <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {[['nakit', '💵 Nakit'], ['kart', '💳 Kart talimatı']].map(([y, ad]) => (
                  <div key={y} onClick={() => alan('odeme_yontemi', y)} style={{
                    padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${f.odeme_yontemi === y ? R.bakir : R.cizgi3}`,
                    color: f.odeme_yontemi === y ? R.bakir : R.metin2,
                    background: f.odeme_yontemi === y ? 'rgba(217,154,78,.12)' : 'transparent',
                  }}>{ad}</div>
                ))}
                {f.odeme_yontemi === 'kart' && (
                  <select value={f.kart_id} onChange={(e) => alan('kart_id', e.target.value)}
                    style={{ ...modalAlanStil, width: 'auto', minWidth: 170 }}>
                    <option value="">Kart seçin</option>
                    {sgKartlar.map((k) => <option key={k.id} value={k.id}>{k.ad || k.kart_adi || k.banka}</option>)}
                  </select>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button disabled={sgMesgul} onClick={() => setSgForm(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>İptal</button>
              <button disabled={sgMesgul} onClick={sgKaydet} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>
                {sgMesgul ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </KucukModal>
        );
      })()}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 3) RAPOR & DEFTER — rapor.aylik / rapor.defter
// ═════════════════════════════════════════════════════════════════════════════
export function RaporModulu({ gorunum, onCekmece, onKopru }) {
  const ay = isoBugun().slice(0, 7);
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/rapor/aylik', null],
    [`/ledger?limit=300&ay=${ay}`, null],
  ]);
  if (yukleniyor) return <Yukleniyor ad="Rapor" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const [rapor, ledgerHam] = veri;

  if (gorunum === 'aylik') {
    // trend12 tek çağrıda 12 ay verir — ay ay 12 istek atmaya gerek yok.
    const trend = (rapor?.trend12 || []).filter(t => sayi(t.ciro) > 0 || sayi(t.gider) > 0);
    if (!trend.length) {
      return <Bos baslik="Aylık rapor verisi yok" aciklama="Ciro ve gider kaydı biriktikçe aylık karşılaştırma burada oluşur." aksiyon="Aylık raporu aç" onAksiyon={() => onKopru?.('__modul:rapor:aylik')} />;
    }
    const son = trend[trend.length - 1];
    const toplamCiro = trend.reduce((s, t) => s + sayi(t.ciro), 0);
    const toplamNet = trend.reduce((s, t) => s + sayi(t.net), 0);
    const marj = (t) => (sayi(t.gelir) ? (sayi(t.net) / sayi(t.gelir)) * 100 : 0);
    const enIyi = trend.reduce((a, b) => (marj(a) >= marj(b) ? a : b));
    const enZayif = trend.reduce((a, b) => (marj(a) <= marj(b) ? a : b));
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: `${trend.length} ay ciro`, deger: fmt(toplamCiro), alt: `${trend[0].ay_kisa} – ${son.ay_kisa}` },
          { etiket: `${trend.length} ay net`, deger: fmt(toplamNet), alt: toplamCiro ? `ortalama marj %${trSayi((toplamNet / toplamCiro) * 100)}` : '—', renk: toplamNet >= 0 ? R.yesil : R.kirmizi },
          { etiket: 'En iyi ay', deger: enIyi.ay_kisa, alt: `marj %${trSayi(marj(enIyi))}`, renk: R.yesil },
          { etiket: 'En zayıf ay', deger: enZayif.ay_kisa, alt: `marj %${trSayi(marj(enZayif))}`, renk: R.kirmizi },
        ]} />
        <Tablo
          baslik={`Aylık rapor · son ${trend.length} ay`}
          not="satıra tıkla → ay kırılımı"
          kolonlar={[
            { ad: 'Ay' }, { ad: 'Ciro', sag: true }, { ad: 'Gelir', sag: true },
            { ad: 'Gider', sag: true }, { ad: 'Net', sag: true }, { ad: 'Marj', sag: true },
          ]}
          satirlar={[...trend].reverse().map(t => ({
            id: t.ay, _t: t,
            hucreler: [
              { v: `${t.ay_kisa} ${t.ay.slice(0, 4)}`, kalin: true },
              { v: fmt(sayi(t.ciro)), mono: true, sag: true },
              { v: fmt(sayi(t.gelir)), mono: true, sag: true },
              { v: fmt(sayi(t.gider)), mono: true, sag: true, renk: R.kirmizi },
              { v: fmt(sayi(t.net)), mono: true, sag: true, kalin: true, renk: sayi(t.net) >= 0 ? R.yesil : R.kirmizi },
              { v: `%${trSayi(marj(t))}`, mono: true, sag: true, renk: marj(t) >= 15 ? R.yesil : marj(t) >= 8 ? R.amber : R.kirmizi },
            ],
          }))}
          onSatir={(row) => {
            const t = row._t;
            onCekmece?.({
              tip: 'AY KIRILIMI',
              baslik: `${t.ay_kisa} ${t.ay.slice(0, 4)}`,
              alt: `net ${fmt(sayi(t.net))} · marj %${trSayi(marj(t))}`,
              kpi: [
                { etiket: 'Ciro', deger: fmt(sayi(t.ciro)) },
                { etiket: 'Net', deger: fmt(sayi(t.net)), renk: sayi(t.net) >= 0 ? R.yesil : R.kirmizi },
              ],
              listeBaslik: 'Kalemler',
              satirlar: [
                { ad: 'Toplam gelir', detay: 'ciro + dış kaynak', tutar: fmt(sayi(t.gelir)) },
                { ad: 'Toplam gider', detay: 'kasa çıkışları', tutar: fmt(sayi(t.gider)) },
                { ad: 'Net', detay: 'gelir − gider', tutar: fmt(sayi(t.net)) },
              ],
              not: 'Rakamlar kasa hareketlerinden gelir — kasa izi tek gerçek.',
              aksiyonAd: 'Aylık raporu aç',
              _hedef: '__modul:rapor:aylik',
            });
          }}
        />
      </>
    );
  }

  // rapor.defter
  const satir = Array.isArray(ledgerHam) ? ledgerHam : (ledgerHam?.rows || []);
  const ozet = ledgerHam?.ozet || {};
  const gelir = sayi(ozet.toplam_gelir) || satir.filter(r => sayi(r.tutar) > 0).reduce((s, r) => s + sayi(r.tutar), 0);
  const gider = sayi(ozet.toplam_gider) || satir.filter(r => sayi(r.tutar) < 0).reduce((s, r) => s + Math.abs(sayi(r.tutar)), 0);
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Kayıt', deger: String(satir.length), alt: `${AY_KISA[Number(ay.slice(5, 7)) - 1]} ${ay.slice(0, 4)}` },
        { etiket: 'Giren', deger: fmt(gelir), alt: 'kasa girişi', renk: R.yesil },
        { etiket: 'Çıkan', deger: fmt(gider), alt: 'kasa çıkışı', renk: R.kirmizi },
        { etiket: 'Net', deger: fmt(gelir - gider), alt: 'bu ay', renk: gelir - gider >= 0 ? R.yesil : R.kirmizi },
      ]} />
      {satir.length ? (
        <Tablo
          baslik={`İşlem defteri · ${AY_KISA[Number(ay.slice(5, 7)) - 1]} ${ay.slice(0, 4)}`}
          not="satıra tıkla → kayıt ayrıntısı"
          kolonlar={[
            { ad: 'Tarih' }, { ad: 'İşlem' }, { ad: 'Açıklama' }, { ad: 'Tutar', sag: true }, { ad: 'Kaynak' },
          ]}
          satirlar={satir.slice(0, 150).map(r => ({
            id: r.id, _r: r,
            hucreler: [
              { v: kisaTarih(r.tarih), mono: true },
              { v: slugAd(r.islem_turu), rozet: sayi(r.tutar) >= 0 ? R.yesil : R.bakir },
              { v: r.aciklama || '—', kalin: true },
              { v: fmt(sayi(r.tutar)), mono: true, sag: true, kalin: true, renk: sayi(r.tutar) >= 0 ? R.yesil : R.kirmizi },
              { v: r.kaynak_tablo || '—', renk: R.not },
            ],
          }))}
          onSatir={(row) => {
            const r = row._r;
            onCekmece?.({
              tip: 'DEFTER KAYDI',
              baslik: r.aciklama || slugAd(r.islem_turu),
              alt: `${kisaTarih(r.tarih)} · ${slugAd(r.islem_turu)}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(sayi(r.tutar)), renk: sayi(r.tutar) >= 0 ? R.yesil : R.kirmizi },
                { etiket: 'Yön', deger: sayi(r.tutar) >= 0 ? 'giriş' : 'çıkış' },
              ],
              listeBaslik: 'Bağlantı',
              satirlar: [
                { ad: 'Kaynak tablo', detay: 'kaydın doğduğu yer', tutar: r.kaynak_tablo || '—' },
                { ad: 'İşlem türü', detay: 'defter sınıfı', tutar: slugAd(r.islem_turu) },
              ],
              not: 'İşlem defteri append-only\'dir; düzeltme ters kayıtla yapılır.',
              // İz sekmesi (yeni handoff): defter kaydının kendisi ZATEN değişmez
              // iz — adımlar kaydın gerçek alanlarından türer, uydurulmaz.
              iz: [
                { ad: 'Kayıt doğdu', detay: `kaynak: ${r.kaynak_tablo || 'bilinmiyor'}`, zaman: kisaTarih(r.tarih) },
                { ad: 'Deftere yazıldı', detay: 'append-only · silinemez', renk: R.yesil },
                { ad: 'Düzeltme yolu', detay: 'ters kayıt (silme yok)', bekliyor: true, renk: R.not },
              ],
              dosyaBilgi: {
                'Kayıt no': String(r.id || '—'),
                'Kaynak tablo': r.kaynak_tablo || '—',
                'İşlem türü': slugAd(r.islem_turu),
                'Tarih': kisaTarih(r.tarih),
              },
            });
          }}
        />
      ) : (
        <Bos baslik="Bu ay defter kaydı yok" aciklama="Kasa hareketi oluştukça işlem defteri dolar." aksiyon="İşlem defterini aç" onAksiyon={() => onKopru?.('__modul:rapor:defter')} />
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 4) VERİ & SİSTEM — sistem.excel / sistem.teslim / sistem.temizle
// ═════════════════════════════════════════════════════════════════════════════
export function SistemModulu({ gorunum, onCekmece, onKopru, onToast }) {
  // ── YERLİ TEMİZLİK (köprü kaldırma turu, 2026-07-30) ──────────────────────
  // TEHLİKELİ uçlar; klasikteki yazılı onay ('EVET_SIL') AYNEN korunur +
  // kadifede ikinci kapı (onay metni yazılmadan buton açılmaz).
  const [tmzForm, setTmzForm] = useState(null);   // {tip:'depo'|'sifirla', onay:''}
  const [tmzMesgul, setTmzMesgul] = useState(false);
  const [tmzSonuc, setTmzSonuc] = useState('');
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/teslim-bildirim/liste?gun=7', null],
    ['/ops/siparis/depo-akisi-kalinti', null],
    ['/import-izi?limit=30', null],  // DUYU 6/6: import iz defteri
    ['/bilgi-teslim-kayitlari?gun=30&limit=500', null],  // köprü kalktı: şube→merkez not defteri
  ]);
  if (yukleniyor) return <Yukleniyor ad="Sistem" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const [teslimHam, kalinti, importIzi, bilgiHam] = veri;
  const olaylar = teslimHam?.olaylar || (Array.isArray(teslimHam) ? teslimHam : []);
  const bilgiKayitlari = bilgiHam?.satirlar || (Array.isArray(bilgiHam) ? bilgiHam : []);

  const TMZ_ONAY = 'EVET_SIL';
  const temizlikYap = async () => {
    const f = tmzForm;
    if ((f?.onay || '').trim() !== TMZ_ONAY) { onToast?.(`Onay kutusuna tam olarak «${TMZ_ONAY}» yazın`); return; }
    setTmzMesgul(true);
    setTmzSonuc('');
    try {
      if (f.tip === 'depo') {
        const r = await api('/ops/siparis/depo-akisi-temizle', { method: 'POST', body: { onay: TMZ_ONAY } });
        const n = sayi(r?.silinen) || sayi(r?.temizlenen) || 0;
        setTmzSonuc(`✓ Depo akışı kalıntısı temizlendi${n ? ` — ${n} kayıt` : ''}`);
        onToast?.('✓ Depo akışı kalıntısı temizlendi');
      } else {
        const r = await api('/sistem-sifirla', { method: 'POST', body: { onay: TMZ_ONAY, tablolar: [] } });
        setTmzSonuc(`✓ Sıfırlama tamam${r?.silinen_tablo ? ` — ${r.silinen_tablo} tablo` : ''}`);
        onToast?.('✓ Sistem sıfırlandı');
      }
      setTmzForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally {
      setTmzMesgul(false);
    }
  };

  if (gorunum === 'excel') {
    // DUYU 6/6 (2026-07-29): "Yükleme geçmişi kayıt altına alınmıyor" eksiği
    // KAPANDI — import_izi append-only defteri her yüklemeyi damgalar.
    const izler = importIzi?.kayitlar || [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kayıtlı yükleme', deger: String(izler.length), alt: 'iz defteri (append-only)' },
          { etiket: 'Son yükleme', deger: izler[0] ? String(izler[0].olusturma).slice(5, 16) : '—', alt: izler[0] ? `${izler[0].toplam_eklenen ?? 0} satır eklendi` : 'henüz iz yok' },
          { etiket: 'Toplam eklenen', deger: String(izler.reduce((s, r) => s + (Number(r.toplam_eklenen) || 0), 0)), alt: 'izlenen yüklemelerde', renk: R.yesil },
          { etiket: 'Hatalı satır', deger: String(izler.reduce((s, r) => s + (Number(r.hata_sayisi) || 0), 0)), alt: 'atlanan kayıtlar', renk: izler.some(r => Number(r.hata_sayisi) > 0) ? R.amber : R.yesil },
        ]} />
        {izler.length === 0 ? (
          <Bos
            baslik="Excel Import"
            aciklama="Banka ekstresi ve POS dosyaları (XLSX · CSV) buradan yüklenir. İz defteri bu ilk kurulumla açıldı — bundan sonraki her yükleme burada damgalanır."
            aksiyon="Excel Import'u aç"
            onAksiyon={() => onKopru?.('__modul:sistem:excel')}
          />
        ) : (
          <Tablo
            baslik="Yükleme iz defteri"
            not="her import kim/ne zaman/kaç satır iziyle damgalanır"
            kolonlar={[{ ad: 'Zaman' }, { ad: 'Dosya' }, { ad: 'Eklenen', sag: true }, { ad: 'Hata', sag: true }]}
            satirlar={izler.map((r, i) => ({
              id: `iz-${i}`,
              hucreler: [
                { v: String(r.olusturma || '—'), mono: true, renk: R.not },
                { v: r.dosya_adi || '—', kalin: true },
                { v: String(r.toplam_eklenen ?? 0), mono: true, sag: true, renk: R.yesil },
                { v: String(r.hata_sayisi ?? 0), mono: true, sag: true, renk: Number(r.hata_sayisi) > 0 ? R.amber : R.not },
              ],
            }))}
            onSatir={() => onKopru?.('__modul:sistem:excel')}
          />
        )}
      </>
    );
  }

  if (gorunum === 'teslim') {
    const gorulmemis = olaylar.filter(o => !o.gorulme_zamani && !o.gorildi);
    const bkSube = new Set(bilgiKayitlari.map(r => r.sube_adi || r.sube_id).filter(Boolean)).size;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Son 7 gün teslim', deger: String(olaylar.length), alt: 'şube depo teslimleri' },
          { etiket: 'Görülmemiş', deger: String(gorulmemis.length), alt: gorulmemis.length ? 'bildirim bekliyor' : 'hepsi görüldü', renk: gorulmemis.length ? R.mavi : R.yesil },
          { etiket: 'Bilgi teslimi', deger: String(bilgiKayitlari.length), alt: `son 30 gün · ${bkSube} şube`, renk: R.krem },
          { etiket: 'Kalıcı onay', deger: '"Tamam" sunucuda', alt: 'bir daha çıkmaz', renk: R.not },
        ]} />
        {olaylar.length ? (
          <Liste
            baslik="Depo teslim bildirimleri · son 7 gün"
            satirlar={olaylar.slice(0, 40).map((o, i) => ({
              id: o.anahtar || i, _o: o,
              baslik: `${o.sube_adi || 'Şube'} · ${o.baslik || 'teslim işlendi'}`,
              alt: [o.zaman ? kisaTarih(o.zaman) : null, o.detay].filter(Boolean).join(' · ') || 'ayrıntı yok',
              tutar: sayi(o.tutar) ? fmt(o.tutar) : '',
              tier: (!o.gorulme_zamani && !o.gorildi) ? 'bilgi' : 'iyi',
              aksiyon: 'Bildirimi aç',
            }))}
            onAc={({ _o }) => onCekmece?.({
              tip: 'TESLİM BİLDİRİMİ',
              baslik: `${_o.sube_adi || 'Şube'} · ${_o.baslik || 'teslim işlendi'}`,
              alt: _o.zaman ? kisaTarih(_o.zaman) : 'zaman yok',
              kpi: [
                { etiket: 'Şube', deger: _o.sube_adi || '—' },
                { etiket: 'Zaman', deger: _o.zaman ? kisaTarih(_o.zaman) : '—' },
                { etiket: 'Tutar', deger: sayi(_o.tutar) ? fmt(_o.tutar) : '—', renk: sayi(_o.tutar) ? R.yesil : R.not },
                { etiket: 'Durum', deger: (!_o.gorulme_zamani && !_o.gorildi) ? 'görülmedi' : 'görüldü', renk: (!_o.gorulme_zamani && !_o.gorildi) ? R.mavi : R.yesil },
              ],
              listeBaslik: 'Bildirim',
              satirlar: [
                { ad: 'Ayrıntı', detay: 'bildirim metni', tutar: _o.detay || '—' },
                { ad: 'Anahtar', detay: 'kalıcı onay kimliği', tutar: String(_o.anahtar || '—').slice(0, 24) },
                { ad: 'Görülme', detay: 'sunucuda saklanır', tutar: _o.gorulme_zamani ? kisaTarih(_o.gorulme_zamani) : 'henüz yok' },
              ],
              not: '"Tamam" dediğinde onay sunucuya yazılır — bildirim bir daha çıkmaz. Bu kayıt teslimin kendisi değil, teslimin haberidir.',
            })}
          />
        ) : (
          <Bos baslik="Son 7 günde teslim bildirimi yok" aciklama="Şube depodan teslim aldığında bildirim burada görünür." renk={R.yesil} />
        )}

        {/* Köprü kalktı (2026-07-30): şube→merkez bilgi teslim defteri artık burada */}
        {bilgiKayitlari.length > 0 && (
          <Tablo
            baslik="Bilgi teslim kayıtları · son 30 gün"
            not="şubelerin merkeze ilettiği not defteri · satıra tıkla → kaydın tamamı"
            kolonlar={[{ ad: 'Zaman' }, { ad: 'Şube' }, { ad: 'Personel' }, { ad: 'Kayıt' }]}
            satirlar={bilgiKayitlari.slice(0, 60).map((r, i) => ({
              id: r.id || `bk-${i}`, _r: r,
              hucreler: [
                { v: String(r.olusturma || '—').replace('T', ' ').slice(0, 16), mono: true, renk: R.not },
                { v: r.sube_adi || r.sube_id || '—', kalin: true },
                { v: r.personel_ad || r.personel_id || '—' },
                { v: kisalt(r.metin || '—', 60) },
              ],
            }))}
            onSatir={({ _r }) => onCekmece?.({
              tip: 'BİLGİ TESLİMİ',
              baslik: _r.personel_ad || _r.personel_id || 'Personel kaydı',
              alt: `${_r.sube_adi || _r.sube_id || 'şube yok'} · ${String(_r.olusturma || '').replace('T', ' ').slice(0, 16)}`,
              kpi: [
                { etiket: 'Şube', deger: _r.sube_adi || _r.sube_id || '—' },
                { etiket: 'Personel', deger: _r.personel_ad || '—' },
                { etiket: 'Zaman', deger: String(_r.olusturma || '—').replace('T', ' ').slice(0, 16) },
              ],
              listeBaslik: 'Teslim edilen bilgi',
              satirlar: [{ ad: 'Metin', detay: 'personelin yazdığı', tutar: _r.metin || '—' }],
              not: 'Şube personeli merkeze bir not bıraktığında buraya düşer. Salt-okunur defterdir — merkez silmez, düzeltmez.',
            })}
          />
        )}
      </>
    );
  }

  // sistem.temizle
  const kalintiAdet = sayi(kalinti?.toplam) || (kalinti?.kayitlar || []).length;
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Depo akışı kalıntısı', deger: String(kalintiAdet), alt: kalintiAdet ? 'temizlenebilir kayıt' : 'temiz', renk: kalintiAdet ? R.amber : R.yesil },
        { etiket: 'Yedek', deger: 'otomatik', alt: 'silmeden önce alınır', renk: R.yesil },
        { etiket: 'Geri alma', deger: 'ters kayıt', alt: 'defter append-only', renk: R.not },
        { etiket: 'Yetki', deger: 'sahip', alt: 'mutasyon anahtarı gerekir', renk: R.not },
      ]} />
      <Liste
        satirlar={[
          ...(kalintiAdet ? [{
            id: 'kalinti',
            baslik: `Depo akışı kalıntısı · ${kalintiAdet} kayıt`,
            alt: 'tamamlanmış sipariş akışından artakalan geçici kayıtlar',
            tutar: `${kalintiAdet} kayıt`, tier: 'uyari',
            aksiyonlar: [{ ad: 'Temizle', birincil: true, onTikla: () => { setTmzSonuc(''); setTmzForm({ tip: 'depo', onay: '' }); } }],
          }] : []),
          {
            id: 'merkez',
            baslik: 'Merkez sipariş temizliği',
            alt: 'tamamlanmış siparişlerin eskileri arşive iner',
            tutar: 'arşiv', tier: 'bilgi',
            aksiyon: 'Sipariş akışını aç', _hedef: '__modul:ops:kule',
          },
          {
            id: 'sifirla',
            baslik: 'Sistem sıfırlama',
            alt: 'TÜM işlem verisini siler — yalnızca demo/kurulum aşamasında kullanılır',
            tutar: 'tehlikeli', tier: 'kritik',
            aksiyonlar: [{ ad: '⚠ Sıfırlama kapısı', onTikla: () => { setTmzSonuc(''); setTmzForm({ tip: 'sifirla', onay: '' }); } }],
          },
        ]}
        onAc={(l) => l._hedef && onKopru?.(l._hedef)}
      />

      {tmzSonuc && (
        <div style={{
          ...kartYuzey, padding: '13px 17px', marginTop: 14,
          border: `1px solid ${R.yesil}55`, fontSize: 12.5, color: R.metin2,
        }}>{tmzSonuc}</div>
      )}

      {/* ── YERLİ TEMİZLİK KAPISI (yazılı onay zorunlu) ── */}
      {tmzForm && (
        <KucukModal
          baslik={tmzForm.tip === 'depo' ? 'Depo Akışı Kalıntısı' : '⚠ Sistem Sıfırlama'}
          alt={tmzForm.tip === 'depo' ? 'tamamlanmış akıştan artakalan geçici kayıtlar' : 'TÜM işlem verisi silinir'}
          onKapat={() => !tmzMesgul && setTmzForm(null)}
          genislik={500}
        >
          <div style={{
            padding: '13px 16px', borderRadius: 12, marginBottom: 14,
            background: tmzForm.tip === 'sifirla' ? `${R.kirmizi}14` : `${R.amber}12`,
            border: `1px solid ${tmzForm.tip === 'sifirla' ? `${R.kirmizi}66` : `${R.amber}55`}`,
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: tmzForm.tip === 'sifirla' ? R.kirmizi : R.amber }}>
              {tmzForm.tip === 'sifirla' ? 'BU İŞLEM GERİ ALINAMAZ' : 'Bu işlem geri alınamaz'}
            </div>
            <div style={{ fontSize: 12, color: R.metin2, marginTop: 6, lineHeight: 1.55 }}>
              {tmzForm.tip === 'depo'
                ? 'Yalnızca tamamlanmış sipariş akışının geçici kayıtları silinir; kasa izi ve defter kayıtları ETKİLENMEZ.'
                : 'Ciro, gider, sipariş, kasa — tüm işlem verisi silinir. Yalnızca demo/kurulum aşamasında kullanılır. Gerçek veriyle çalışıyorsan BU KAPIYI KAPAT.'}
            </div>
          </div>
          <label style={modalEtiket}>Onaylamak için «{TMZ_ONAY}» yazın</label>
          <input value={tmzForm.onay} placeholder={TMZ_ONAY}
            onChange={(e) => setTmzForm((f) => ({ ...f, onay: e.target.value }))}
            style={{ ...modalAlanStil, fontFamily: F.mono, letterSpacing: '1px' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button disabled={tmzMesgul} onClick={() => setTmzForm(null)} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button
              disabled={tmzMesgul || (tmzForm.onay || '').trim() !== TMZ_ONAY}
              onClick={temizlikYap}
              style={{
                padding: '10px 20px', borderRadius: 10, border: 'none',
                background: (tmzForm.onay || '').trim() === TMZ_ONAY
                  ? (tmzForm.tip === 'sifirla' ? `${R.kirmizi}30` : 'linear-gradient(150deg, #D99A4E, #B06E2C)')
                  : R.girinti,
                color: (tmzForm.onay || '').trim() === TMZ_ONAY
                  ? (tmzForm.tip === 'sifirla' ? R.kirmizi : '#1C1309') : R.not,
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                cursor: (tmzForm.onay || '').trim() === TMZ_ONAY ? 'pointer' : 'default',
              }}
            >
              {tmzMesgul ? 'İşleniyor…' : (tmzForm.tip === 'depo' ? 'Kalıntıyı temizle' : 'Sıfırla')}
            </button>
          </div>
        </KucukModal>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 5) TANIMLAR — tanim.tedarikciler / zincir / dosya / tv
// ═════════════════════════════════════════════════════════════════════════════
export function TanimModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/tedarikciler', []],
    ['/ops/tedarik-dosyasi?gun=60&limit=150', null],
    ['/tv-menu/liste', []],
  ]);
  // v2-YERLİ tedarikçi CRUD (köprü kaldırma turu) — klasik uçlar aynen
  const [tedForm, setTedForm] = useState(null);   // {duzenleId?, ad, kategori, telefon, aciklama}
  const [tedMesgul, setTedMesgul] = useState(false);
  const [tedPasifSor, setTedPasifSor] = useState('');
  // ── YERLİ TV MENÜ DÜZENLEME (köprü kaldırma turu, 2026-07-30) ─────────────
  // Klasik TvMenuYonetim'in ürün formu: fiyat (8oz/14oz/ice) · sıra · aktiflik.
  // TV'nin KENDİ tasarım dili (TULİPİ) korunur — bu yalnız yönetim yüzü.
  const [tvForm, setTvForm] = useState(null);      // {id, ad, kategori, f8, f14, fice, sira, aktif, yeni, aciklama}
  const [tvMesgul, setTvMesgul] = useState(false);
  const [tvSilSor, setTvSilSor] = useState('');
  const tvKaydet = async () => {
    const f = tvForm;
    if (!(f?.ad || '').trim()) { onToast?.('Ürün adı zorunlu'); return; }
    setTvMesgul(true);
    try {
      const sayiVeyaNull = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
      await api(`/tv-menu/urun/${f.id}`, {
        method: 'PUT',
        body: {
          kategori: f.kategori || null, ad: f.ad, aciklama: f.aciklama || null,
          f8: sayiVeyaNull(f.f8), f14: sayiVeyaNull(f.f14), fice: sayiVeyaNull(f.fice),
          sira: sayi(f.sira), aktif: f.aktif !== false, yeni: f.yeni === true,
        },
      });
      onToast?.(`✓ ${f.ad} kaydedildi — TV ~1 dk içinde güncellenir`);
      setTvForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setTvMesgul(false);
    }
  };

  const tvSil = async (u) => {
    setTvMesgul(true);
    try {
      await api(`/tv-menu/urun/${u.id}`, { method: 'DELETE' });
      onToast?.(`${u.ad} TV menüsünden silindi`);
      setTvSilSor('');
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Silinemedi');
    } finally {
      setTvMesgul(false);
    }
  };

  const tvEvoFiyat = async () => {
    setTvMesgul(true);
    try {
      const r = await api('/tv-menu/evo-fiyat-uygula?gun=30', { method: 'POST' });
      onToast?.(`💰 Evo fiyatları uygulandı${r?.guncellenen != null ? ` — ${r.guncellenen} ürün` : ''}`);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Fiyat uygulanamadı');
    } finally {
      setTvMesgul(false);
    }
  };

  if (yukleniyor) return <Yukleniyor ad="Tanımlar" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const tedKaydet = async () => {
    if (!(tedForm?.ad || '').trim()) { onToast?.('Tedarikçi adı zorunlu'); return; }
    setTedMesgul(true);
    try {
      const body = { ad: tedForm.ad, kategori: tedForm.kategori || '', telefon: tedForm.telefon || '', aciklama: tedForm.aciklama || '' };
      if (tedForm.duzenleId) await api(`/tedarikciler/${tedForm.duzenleId}`, { method: 'PUT', body });
      else await api('/tedarikciler', { method: 'POST', body });
      onToast?.(tedForm.duzenleId ? '✓ Tedarikçi güncellendi' : '✓ Tedarikçi eklendi');
      setTedForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setTedMesgul(false);
    }
  };

  const tedPasife = async (id) => {
    setTedMesgul(true);
    try {
      await api(`/tedarikciler/${id}`, { method: 'DELETE' });
      onToast?.('Tedarikçi pasife alındı');
      setTedPasifSor('');
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Pasife alınamadı');
    } finally {
      setTedMesgul(false);
    }
  };

  const [tedHam, dosyaHam, tvHam] = veri;
  const tedarikciler = (Array.isArray(tedHam) ? tedHam : []).filter(t => t.aktif !== false);
  const dosyalar = dosyaHam?.dosyalar || [];
  const tv = Array.isArray(tvHam) ? tvHam : [];

  if (gorunum === 'tedarikciler') {
    const kategoriler = [...new Set(tedarikciler.map(t => t.kategori).filter(Boolean))];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Aktif tedarikçi', deger: String(tedarikciler.length), alt: `${kategoriler.length} kategori` },
          { etiket: 'Telefonu kayıtlı', deger: String(tedarikciler.filter(t => t.telefon).length), alt: 'WhatsApp ile ulaşılabilir', renk: R.yesil },
          { etiket: 'Telefonu eksik', deger: String(tedarikciler.filter(t => !t.telefon).length), alt: 'fatura isteği gönderilemez', renk: tedarikciler.some(t => !t.telefon) ? R.amber : R.yesil },
          { etiket: 'Kategori', deger: String(kategoriler.length), alt: kategoriler.slice(0, 3).join(', ') || '—', renk: R.krem },
        ]} />
        <div style={{ display: 'flex', gap: 9, marginBottom: 12 }}>
          <button onClick={() => setTedForm({ duzenleId: null, ad: '', kategori: '', telefon: '', aciklama: '' })} style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>
            + Tedarikçi ekle
          </button>
          <span style={{ fontSize: 11.5, color: R.not, alignSelf: 'center' }}>
            şube personeli Ürün Teslim Al'da yalnız bu listeden seçer
          </span>
        </div>
        {tedarikciler.length ? (
          <Liste
            satirlar={tedarikciler.map(t => ({
              id: t.id, _t: t,
              baslik: t.ad,
              alt: `${t.kategori || 'kategori yok'} · ${t.telefon || 'telefon eksik'}${t.aciklama ? ` · ${t.aciklama}` : ''}`,
              tutar: '',
              tier: t.telefon ? 'olumlu' : 'uyari',
              rozet: t.telefon ? 'tam' : 'telefon eksik',
              rozetRenk: t.telefon ? R.yesil : R.amber,
              aksiyonlar: tedPasifSor === String(t.id) ? [
                { ad: tedMesgul ? '…' : 'Eminim — pasife al', birincil: true, onTikla: () => !tedMesgul && tedPasife(t.id) },
                { ad: 'Vazgeç', onTikla: () => setTedPasifSor('') },
              ] : [
                { ad: '✎ Düzenle', birincil: true, onTikla: () => setTedForm({
                  duzenleId: t.id, ad: t.ad || '', kategori: t.kategori || '', telefon: t.telefon || '', aciklama: t.aciklama || '',
                }) },
                { ad: 'Pasife al', onTikla: () => setTedPasifSor(String(t.id)) },
              ],
            }))}
            onAc={(l) => {
              const t = l._t;
              onCekmece?.({
                tip: 'TEDARİKÇİ',
                baslik: t.ad,
                alt: t.kategori || 'kategori girilmemiş',
                kpi: [
                  { etiket: 'Kategori', deger: t.kategori || '—' },
                  { etiket: 'İletişim', deger: t.telefon ? 'kayıtlı' : 'eksik', renk: t.telefon ? R.yesil : R.amber },
                ],
                listeBaslik: 'Tanım',
                satirlar: [
                  { ad: 'Telefon', detay: 'fatura isteği için', tutar: t.telefon || '—' },
                  { ad: 'Açıklama', detay: 'not', tutar: t.aciklama || '—' },
                ],
                not: t.telefon
                  ? 'Fatura isteği WhatsApp ile tek dokunuşla gönderilebilir. Düzenleme satır butonlarından.'
                  : 'Telefon kayıtlı değil — fatura isteği motoru bu tedarikçiye mesaj gönderemez.',
              });
            }}
          />
        ) : (
          <Bos baslik="Tanımlı tedarikçi yok" aksiyon="+ Tedarikçi ekle" onAksiyon={() => setTedForm({ duzenleId: null, ad: '', kategori: '', telefon: '', aciklama: '' })} />
        )}

        {/* ── YERLİ TEDARİKÇİ FORMU ── */}
        {tedForm && (
          <KucukModal
            baslik={tedForm.duzenleId ? 'Tedarikçiyi Düzenle' : 'Yeni Tedarikçi'}
            alt="şube teslim alım listesinde görünür"
            onKapat={() => !tedMesgul && setTedForm(null)}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Tedarikçi adı *</label>
                <input value={tedForm.ad} onChange={(e) => setTedForm((f) => ({ ...f, ad: e.target.value }))} style={modalAlanStil} />
              </div>
              <div>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Kategori</label>
                <select value={tedForm.kategori} onChange={(e) => setTedForm((f) => ({ ...f, kategori: e.target.value }))} style={modalAlanStil}>
                  <option value="">Seçin…</option>
                  {['Gıda', 'İçecek', 'Ambalaj', 'Temizlik', 'Kırtasiye', 'Teknik', 'Diğer'].map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Telefon</label>
                <input value={tedForm.telefon} placeholder="5xx… (fatura isteği için)"
                  onChange={(e) => setTedForm((f) => ({ ...f, telefon: e.target.value }))}
                  style={{ ...modalAlanStil, fontFamily: F.mono }} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>Açıklama</label>
                <input value={tedForm.aciklama} onChange={(e) => setTedForm((f) => ({ ...f, aciklama: e.target.value }))} style={modalAlanStil} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button disabled={tedMesgul} onClick={() => setTedForm(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>İptal</button>
              <button disabled={tedMesgul} onClick={tedKaydet} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>
                {tedMesgul ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </KucukModal>
        )}
      </>
    );
  }

  if (gorunum === 'zincir' || gorunum === 'dosya') {
    // Aynı kaynak iki görünüme bakar: `zincir` sipariş→kabul→fatura akışının
    // AÇIK olanlarına, `dosya` tüm dosya arşivine.
    const acik = dosyalar.filter(d => sayi(d.fatura_say) === 0 || slugAd(d.kabul_durum).includes('uyum'));
    const liste = gorunum === 'zincir' ? acik : dosyalar;
    const tamEslesen = dosyalar.filter(d => sayi(d.fatura_say) > 0 && !slugAd(d.kabul_durum).includes('uyum'));
    return (
      <>
        <KpiSeridi kpiler={gorunum === 'zincir' ? [
          { etiket: 'Açık zincir', deger: String(acik.length), alt: 'kabul veya fatura eksik', renk: acik.length ? R.amber : R.yesil },
          { etiket: 'Tam kapanan', deger: `${tamEslesen.length} / ${dosyalar.length}`, alt: 'son 60 gün', renk: R.yesil },
          { etiket: 'Faturasız teslim', deger: String(dosyalar.filter(d => sayi(d.fatura_say) === 0).length), alt: 'belge bekliyor', renk: R.kirmizi },
          { etiket: 'Kabul uyumsuz', deger: String(dosyalar.filter(d => slugAd(d.kabul_durum).includes('uyum')).length), alt: 'adet farkı', renk: R.amber },
        ] : [
          { etiket: 'Tedarik dosyası', deger: String(dosyalar.length), alt: 'son 60 gün sipariş' },
          { etiket: 'Faturalı', deger: String(dosyalar.filter(d => sayi(d.fatura_say) > 0).length), alt: 'belge eklenmiş', renk: R.yesil },
          { etiket: 'Faturasız', deger: String(dosyalar.filter(d => sayi(d.fatura_say) === 0).length), alt: 'belge eksik', renk: R.kirmizi },
          { etiket: 'Şube', deger: String(new Set(dosyalar.map(d => d.sube_adi).filter(Boolean)).size), alt: 'sipariş veren', renk: R.krem },
        ]} />
        {liste.length ? (
          <Tablo
            baslik={gorunum === 'zincir' ? 'Sipariş → kabul → fatura zinciri' : 'Tedarik dosyası · son 60 gün'}
            not="satıra tıkla → zincir dosyası"
            kolonlar={[
              { ad: 'Sipariş' }, { ad: 'Şube' }, { ad: 'Tarih' },
              { ad: 'Toptancı' }, { ad: 'Fatura', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={liste.slice(0, 120).map(d => ({
              id: d.talep_id, _d: d,
              hucreler: [
                { v: `#${String(d.talep_id).slice(0, 8)}`, mono: true, kalin: true },
                { v: d.sube_adi || '—' },
                { v: kisaTarih(d.tarih), mono: true },
                { v: d.tedarikciler || '—', renk: R.not },
                { v: String(sayi(d.fatura_say)), mono: true, sag: true, renk: sayi(d.fatura_say) ? R.yesil : R.kirmizi },
                {
                  v: sayi(d.fatura_say) === 0 ? 'fatura bekliyor'
                    : slugAd(d.kabul_durum).includes('uyum') ? 'kabul uyumsuz' : 'kapandı',
                  rozet: sayi(d.fatura_say) === 0 ? R.kirmizi
                    : slugAd(d.kabul_durum).includes('uyum') ? R.amber : R.yesil,
                },
              ],
            }))}
            onSatir={(row) => {
              const d = row._d;
              onCekmece?.({
                tip: 'ZİNCİR DOSYASI',
                baslik: `Sipariş #${String(d.talep_id).slice(0, 8)}`,
                alt: `${d.sube_adi || 'şube'} · ${kisaTarih(d.tarih)}`,
                kpi: [
                  { etiket: 'Fatura', deger: String(sayi(d.fatura_say)), renk: sayi(d.fatura_say) ? R.yesil : R.kirmizi },
                  { etiket: 'Sipariş durumu', deger: slugAd(d.durum) || '—' },
                ],
                listeBaslik: 'Zincir noktaları',
                satirlar: [
                  { ad: 'Talep', detay: 'şube siparişi', tutar: kisaTarih(d.tarih) },
                  { ad: 'Toptancı', detay: 'sipariş verilen', tutar: d.tedarikciler || '—' },
                  { ad: 'Kabul', detay: 'şube teslim aldı', tutar: slugAd(d.kabul_durum) || '—' },
                  { ad: 'Fatura', detay: 'belge sayısı', tutar: `${sayi(d.fatura_say)} belge` },
                ],
                not: sayi(d.fatura_say) === 0
                  ? 'Bu teslimatın faturası henüz gelmemiş — belge talep motoru tedarikçiyi kovalar.'
                  : 'Zincirin dört noktası da kayıtlı; adet ve fiyat varyansı Tedarik Dosyası detayında.',
                aksiyonAd: 'Tedarik dosyasını aç',
                _hedef: '__modul:tanim:dosya',
              });
            }}
          />
        ) : (
          <Bos
            baslik={gorunum === 'zincir' ? 'Açık zincir yok' : 'Tedarik dosyası boş'}
            aciklama={gorunum === 'zincir'
              ? 'Son 60 günde kabulü ve faturası tamamlanmamış sipariş bulunmuyor.'
              : 'Son 60 günde toptancı zinciri olan sipariş kaydı yok.'}
            renk={gorunum === 'zincir' ? R.yesil : R.not}
          />
        )}
      </>
    );
  }

  // tanim.tv
  const yayinda = tv.filter(u => u.aktif !== false && u.gorunur !== false);
  const kategoriler = [...new Set(tv.map(u => u.kategori).filter(Boolean))];
  const fiyatli = tv.filter(u => sayi(u.f8) > 0 || sayi(u.f14) > 0 || sayi(u.fice) > 0);
  const fiyatMetni = (u) => {
    const p = [sayi(u.f8), sayi(u.f14), sayi(u.fice)].filter(x => x > 0);
    return p.length ? `${fmt(Math.min(...p)).replace(' ₺', '')}–${fmt(Math.max(...p))}` : '—';
  };
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Yayındaki ürün', deger: String(yayinda.length), alt: `${tv.length} tanımlı ürün`, renk: R.yesil },
        { etiket: 'Gizli', deger: String(tv.length - yayinda.length), alt: 'menüden kaldırılmış', renk: tv.length - yayinda.length ? R.amber : R.krem },
        { etiket: 'Kategori', deger: String(kategoriler.length), alt: kategoriler.slice(0, 3).join(', ') || '—', renk: R.krem },
        { etiket: 'Fiyatı girilmemiş', deger: String(tv.length - fiyatli.length), alt: 'ekranda boş görünür', renk: tv.length - fiyatli.length ? R.kirmizi : R.yesil },
      ]} />
      {tv.length ? (
        <Tablo
          baslik="TV menü içeriği"
          not="satıra tıkla → ürün ayrıntısı · fiyat düzenleme TV Menü ekranında"
          kolonlar={[{ ad: 'Ürün' }, { ad: 'Kategori' }, { ad: 'Fiyat', sag: true }, { ad: 'Sıra', sag: true }, { ad: 'Yayın' }]}
          satirlar={tv.slice(0, 150).map(u => ({
            id: u.id, _u: u,
            hucreler: [
              { v: u.ad, kalin: true },
              { v: u.kategori || '—', renk: R.not },
              { v: fiyatMetni(u), mono: true, sag: true, renk: fiyatli.includes(u) ? R.krem : R.kirmizi },
              { v: String(sayi(u.sira)), mono: true, sag: true },
              {
                v: (u.aktif !== false && u.gorunur !== false) ? 'yayında' : 'gizli',
                rozet: (u.aktif !== false && u.gorunur !== false) ? R.yesil : R.not,
              },
            ],
          }))}
          onSatir={(row) => {
            const u = row._u;
            onCekmece?.({
              tip: 'TV MENÜ ÜRÜNÜ',
              baslik: u.ad,
              alt: `${u.kategori || 'kategori yok'} · ${(u.aktif !== false && u.gorunur !== false) ? 'yayında' : 'gizli'}`,
              kpi: [
                { etiket: 'Fiyat aralığı', deger: fiyatMetni(u) },
                { etiket: 'Sıra', deger: String(sayi(u.sira)) },
              ],
              listeBaslik: 'Boy fiyatları',
              satirlar: [
                { ad: '8 oz', detay: 'küçük', tutar: sayi(u.f8) ? fmt(u.f8) : '—' },
                { ad: '14 oz', detay: 'büyük', tutar: sayi(u.f14) ? fmt(u.f14) : '—' },
                { ad: 'Ice', detay: 'soğuk', tutar: sayi(u.fice) ? fmt(u.fice) : '—' },
              ],
              not: 'TV menü TULİPİ markasının kendi tasarım dilini kullanır — müşteri ekranı kadife koyuya çevrilmez, burası yalnız yönetim görünümü.',
              aksiyonlar: [
                { ad: '✎ Fiyat / sıra düzenle', birincil: true, onTikla: () => setTvForm({
                  id: u.id, ad: u.ad || '', kategori: u.kategori || '', aciklama: u.aciklama || '',
                  f8: u.f8 ?? '', f14: u.f14 ?? '', fice: u.fice ?? '',
                  sira: u.sira ?? 0, aktif: u.aktif !== false, yeni: u.yeni === true,
                }) },
                { ad: (u.aktif !== false && u.gorunur !== false) ? 'Menüden kaldır' : 'Menüye al', onTikla: async () => {
                  setTvMesgul(true);
                  try {
                    const sayiVeyaNull = (v) => (v === '' || v == null ? null : Number(v));
                    await api(`/tv-menu/urun/${u.id}`, {
                      method: 'PUT',
                      body: {
                        kategori: u.kategori || null, ad: u.ad, aciklama: u.aciklama || null,
                        f8: sayiVeyaNull(u.f8), f14: sayiVeyaNull(u.f14), fice: sayiVeyaNull(u.fice),
                        sira: sayi(u.sira), aktif: !(u.aktif !== false), yeni: u.yeni === true,
                      },
                    });
                    onToast?.((u.aktif !== false) ? `${u.ad} menüden kaldırıldı` : `${u.ad} menüye alındı`);
                    yukle();
                  } catch (e) { onToast?.(e?.message || 'Değiştirilemedi'); }
                  finally { setTvMesgul(false); }
                } },
              ],
            });
          }}
        />
      ) : (
        <Bos baslik="TV menüsünde ürün yok" aciklama="Menü ürünleri tanımlanınca TV ekranında görünür." />
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button disabled={tvMesgul} onClick={tvEvoFiyat} style={{
          padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
          background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        }}>
          {tvMesgul ? 'Uygulanıyor…' : '💰 Evo satış fiyatlarını uygula (30 gün)'}
        </button>
        <span style={{ fontSize: 11.5, color: R.not, alignSelf: 'center' }}>
          fiyat düzenleme ve yayın durumu satıra tıklayınca çekmecede
        </span>
      </div>

      {/* ── YERLİ TV ÜRÜN FORMU ── */}
      {tvForm && (
        <KucukModal
          baslik="TV Menü Ürünü"
          alt="kaydedince TV ~1 dk içinde güncellenir"
          onKapat={() => !tvMesgul && setTvForm(null)}
          genislik={520}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={modalEtiket}>Ürün adı *</label>
              <input value={tvForm.ad} onChange={(e) => setTvForm((f) => ({ ...f, ad: e.target.value }))} style={modalAlanStil} />
            </div>
            <div>
              <label style={modalEtiket}>Kategori</label>
              <input value={tvForm.kategori} onChange={(e) => setTvForm((f) => ({ ...f, kategori: e.target.value }))} style={modalAlanStil} />
            </div>
            <div>
              <label style={modalEtiket}>Sıra</label>
              <input type="number" value={tvForm.sira} onChange={(e) => setTvForm((f) => ({ ...f, sira: e.target.value }))}
                style={{ ...modalAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
            </div>
            {[['f8', '8 oz fiyat (₺)'], ['f14', '14 oz fiyat (₺)'], ['fice', 'Ice fiyat (₺)']].map(([k, ad]) => (
              <div key={k}>
                <label style={modalEtiket}>{ad}</label>
                <input type="number" value={tvForm[k]} onChange={(e) => setTvForm((f) => ({ ...f, [k]: e.target.value }))}
                  style={{ ...modalAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
              </div>
            ))}
            <div style={{ gridColumn: '1/-1' }}>
              <label style={modalEtiket}>Açıklama</label>
              <input value={tvForm.aciklama} onChange={(e) => setTvForm((f) => ({ ...f, aciklama: e.target.value }))} style={modalAlanStil} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {[['aktif', 'Yayında'], ['yeni', '✨ YENİ etiketi']].map(([k, ad]) => (
              <div key={k} onClick={() => setTvForm((f) => ({ ...f, [k]: !f[k] }))} style={{
                padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${tvForm[k] ? R.bakir : R.cizgi3}`,
                color: tvForm[k] ? R.bakir : R.metin2,
                background: tvForm[k] ? 'rgba(217,154,78,.12)' : 'transparent',
              }}>{tvForm[k] ? '✓ ' : '□ '}{ad}</div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
            {tvSilSor === String(tvForm.id) ? (
              <>
                <button disabled={tvMesgul} onClick={() => tvSil(tvForm)} style={{
                  padding: '9px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                }}>Eminim — menüden sil</button>
                <button onClick={() => setTvSilSor('')} style={{
                  padding: '9px 12px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 11.5, fontFamily: 'inherit',
                }}>Vazgeç</button>
              </>
            ) : (
              <button onClick={() => setTvSilSor(String(tvForm.id))} style={{
                padding: '9px 14px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.not, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Sil</button>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button disabled={tvMesgul} onClick={() => setTvForm(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>İptal</button>
              <button disabled={tvMesgul} onClick={tvKaydet} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>{tvMesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </div>
        </KucukModal>
      )}
    </>
  );
}
