// ─────────────────────────────────────────────────────────────────────────────
// 👤 KULLANICILAR — kişiye özel giriş + hangi ekranı göreceği
//
// 🔴 NEDEN (sahip 2026-09-08): "tanımlarla tek tek açılmasına ve şifresiyle
// girmesine izin vereceğiz". Bugüne kadar panele giriş TEK ortak şifreyleydi;
// giren herkes 60 görünümün hepsini görüyordu ve denetim defterinde herkes
// "yönetim (oturum)" yazıyordu.
//
// ⚠️ ADI "YETKİ" DEĞİL "GÖRÜNÜRLÜK" — ve bu bir üslup tercihi değil, dürüstlük:
// API uçlarının çoğu hâlâ auth'suz. Bu ekran menüyü sadeleştirir, veriyi
// KİLİTLEMEZ. Ekranda da aynen böyle yazıyor; olmayan güvence satılmaz.
//
// ⚠️ Ekip ▸ Panel PIN & Görev QR ile KARIŞTIRILMAZ: orası baristanın ŞUBE
// paneli PIN'i ("pini olan personel serbest" — sahip). Burası ofis panelinin
// kimliği. İki ayrı kavram.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { R, F, kartYuzey, MODULLER } from './tema';
import { Tablo, HataBandi } from './parcalar';

const alanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const etiketStil = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};
const dugme = {
  padding: '9px 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};
const dugmeAna = {
  padding: '9px 20px', borderRadius: 9, border: 'none', cursor: 'pointer',
  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
};

// 🎭 HAZIR ŞABLONLAR — 60 kutucuğu her yeni kişide sıfırdan işaretlemek
// angarya olurdu. Şablon bir BAŞLANGIÇ noktasıdır; üstüne tek tek düzeltilir.
// ⚠️ Şablon bir ROL DEĞİL: yetkiyi belirleyen şey seçili görünüm listesidir,
// şablon yalnız o listeyi hızlı doldurur.
const SABLON = {
  'Her şey': () => ['*'],
  'Müdür — günlük iş': () => ['ops', 'gelir', 'ekip', 'onay'],
  'Muhasebe': () => ['belge', 'odeme', 'maliyet', 'vergi', 'borc'],
  'Sadece bakış': () => ['bakis', 'rapor'],
};

const BOS = {
  id: null, ad: '', kullanici_adi: '', sifre: '', rol: '',
  gorunumler: [], personel_id: '', aktif: true,
};

export default function KullaniciModulu({ onToast }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [form, setForm] = useState(null);       // null = form kapalı
  const [mesgul, setMesgul] = useState(false);
  const [silSoru, setSilSoru] = useState(null);

  const yukle = useCallback(() => {
    setHata('');
    api('/kullanici')
      .then((d) => setListe(d || null))
      // HATA≠BOŞ: uç düşerse null kalır, ekran "kullanıcı yok" yalanı basmaz.
      .catch((e) => { setListe(null); setHata(e?.message || 'kullanıcılar okunamadı'); });
  }, []);

  useEffect(() => { yukle(); }, [yukle]);

  /** Bir görünüm seçili mi? Modül tamamı seçiliyse alt görünümleri de seçilidir. */
  const secili = (mid, gid) => {
    const g = form?.gorunumler || [];
    return g.includes('*') || g.includes(mid) || g.includes(`${mid}:${gid}`);
  };
  const modulHepsi = (mid) => {
    const g = form?.gorunumler || [];
    return g.includes('*') || g.includes(mid);
  };

  const modulAc = (mid, ac) => setForm((f) => {
    const g = (f.gorunumler || []).filter((x) => x !== mid && !x.startsWith(`${mid}:`));
    return { ...f, gorunumler: ac ? [...g, mid] : g };
  });

  const gorunumAc = (mid, gid, ac) => setForm((f) => {
    let g = f.gorunumler || [];
    if (g.includes('*')) {
      // "Her şey" seçiliyken tek bir görünümü kapatmak isteniyorsa, kısayolu
      // AÇIK LİSTEYE çevirmek gerekir — yoksa tık hiçbir şey yapmaz gibi görünür.
      const hepsi = [];
      MODULLER.forEach((m) => (m.gorunumler || []).forEach((v) => hepsi.push(`${m.id}:${v.id}`)));
      g = hepsi;
    }
    if (g.includes(mid)) {
      // Modül tamamı seçiliyken tek görünüm kapatılıyor → listeyi aç.
      g = g.filter((x) => x !== mid)
        .concat((MODULLER.find((m) => m.id === mid)?.gorunumler || []).map((v) => `${mid}:${v.id}`));
    }
    const anahtar = `${mid}:${gid}`;
    return { ...f, gorunumler: ac ? [...new Set([...g, anahtar])] : g.filter((x) => x !== anahtar) };
  });

  const kaydet = async () => {
    if (!form.ad.trim() || !form.kullanici_adi.trim()) {
      onToast?.('Ad ve giriş adı zorunlu'); return;
    }
    if (!form.id && !form.sifre) { onToast?.('Yeni kullanıcıda şifre zorunlu'); return; }
    setMesgul(true);
    try {
      const govde = {
        ad: form.ad.trim(), kullanici_adi: form.kullanici_adi.trim(),
        rol: form.rol || null, gorunumler: form.gorunumler || [],
        personel_id: form.personel_id || null, aktif: !!form.aktif,
      };
      if (form.sifre) govde.sifre = form.sifre;
      await api(`/kullanici${form.id ? `?id=${form.id}` : ''}`, { method: 'POST', body: govde });
      onToast?.(`✓ ${form.ad} ${form.id ? 'güncellendi' : 'eklendi'}`);
      setForm(null);
      yukle();
    } catch (e) {
      onToast?.(`✕ ${e?.message || 'kaydedilemedi'}`);
    } finally { setMesgul(false); }
  };

  /** Hiç girmemiş kapalı kaydı KALICI sil. Girmiş olanda sunucu 400 döner. */
  const kaliciSil = async (k) => {
    setMesgul(true);
    try {
      await api(`/kullanici/${k.id}/kalici-sil`, { method: 'DELETE' });
      onToast?.(`✓ ${k.ad} listeden kaldırıldı`);
      setForm(null);
      yukle();
    } catch (e) {
      onToast?.(`✕ ${e?.message || 'silinemedi'}`);
    } finally { setMesgul(false); setSilSoru(null); }
  };

  const kapat = async (k) => {
    setMesgul(true);
    try {
      await api(`/kullanici/${k.id}`, { method: 'DELETE' });
      onToast?.(`✓ ${k.ad} kapatıldı — kaydı silinmedi, girişi kapandı`);
      yukle();
    } catch (e) {
      onToast?.(`✕ ${e?.message || 'kapatılamadı'}`);
    } finally { setMesgul(false); setSilSoru(null); }
  };

  const sayac = (g) => {
    if (!g?.length) return '0 ekran';
    if (g.includes('*')) return 'her ekran';
    let n = 0;
    MODULLER.forEach((m) => {
      if (g.includes(m.id)) n += (m.gorunumler || []).length;
      else n += (m.gorunumler || []).filter((v) => g.includes(`${m.id}:${v.id}`)).length;
    });
    return `${n} ekran`;
  };

  return (
    <>
      {!!hata && <HataBandi mesaj={hata} kaynak="/api/kullanici" onTekrar={yukle} />}

      {/* ⚠️ DÜRÜSTLÜK BANDI — bu ekranın ne OLMADIĞINI söyler.
          Kod tabanının kendi doktrini: olmayan güvence satılmaz. */}
      <div style={{
        ...kartYuzey, padding: '14px 18px', marginBottom: 16,
        borderLeft: `3px solid ${R.amber}`, fontSize: 12.5, lineHeight: 1.65,
      }}>
        <b style={{ color: R.amber }}>Bu ayar EKRAN GÖRÜNÜRLÜĞÜDÜR — veri kilidi değildir.</b>
        <div style={{ color: R.not, marginTop: 4 }}>
          Burada seçtiğiniz ekranlar o kişinin menüsünde görünür, seçmedikleriniz görünmez.
          Ama sistemin veri adresleri hâlâ açık: adresi bilen biri tarayıcıya doğrudan
          yazarsa veriye ulaşabilir. Gerçek kilit ayrı bir iştir ve henüz yapılmadı.
        </div>
        <div style={{ color: R.not2, marginTop: 6, fontSize: 11.5 }}>
          Şube panelindeki personel PIN'i bu listeden bağımsızdır — o Ekip ▸ Panel PIN
          ekranından yönetilir ve buradaki tanımlardan etkilenmez.
        </div>
      </div>

      {liste && (liste.kullanicilar || []).length ? (
        <Tablo
          baslik="Tanımlı kullanıcılar"
          not={`${liste.adet} kişi · satıra tıklayın`}
          kolonlar={[{ ad: 'Kişi' }, { ad: 'Giriş adı' }, { ad: 'Rol' },
            { ad: 'Görebildiği' }, { ad: 'Son giriş' }, { ad: 'Durum' }]}
          satirlar={(liste.kullanicilar || []).map((k) => ({
            id: k.id,
            hucreler: [
              { v: k.ad || '—', kalin: true, renk: k.aktif ? R.krem : R.not },
              { v: k.kullanici_adi || '—', mono: true, renk: R.metin2 },
              { v: k.rol || '—', renk: R.not2 },
              { v: sayac(k.gorunumler), renk: k.hepsi ? R.amber : R.krem },
              { v: k.son_giris ? String(k.son_giris).slice(0, 10) : 'hiç girmedi',
                renk: k.son_giris ? R.metin2 : R.not3 },
              { v: k.aktif ? 'açık' : 'kapalı', rozet: k.aktif ? R.yesil : R.not },
            ],
          }))}
          onSatir={(row) => {
            const k = (liste.kullanicilar || []).find((x) => x.id === row.id);
            if (k) setForm({ ...BOS, ...k, sifre: '', personel_id: k.personel_id || '' });
          }}
        />
      ) : liste ? (
        <div style={{ ...kartYuzey, padding: '30px 26px', textAlign: 'center', color: R.not }}>
          Henüz kullanıcı tanımlanmamış. Şu an panele <b>ortak şifreyle</b> giriliyor ve
          giren herkes her ekranı görüyor.
        </div>
      ) : null}

      {!form && (
        <button onClick={() => setForm({ ...BOS })} style={{ ...dugmeAna, marginBottom: 16 }}>
          + Kullanıcı tanımla
        </button>
      )}

      {form && (
        <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16 }}>
          <div style={{ fontFamily: F.baslik, fontSize: 16, fontWeight: 600, marginBottom: 14 }}>
            {form.id ? `${form.ad} — düzenle` : 'Yeni kullanıcı'}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 180px' }}>
              <label style={etiketStil}>Adı soyadı</label>
              <input value={form.ad} onChange={(e) => setForm((f) => ({ ...f, ad: e.target.value }))}
                placeholder="Merve Karabacak" style={alanStil} />
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <label style={etiketStil}>Giriş adı</label>
              <input value={form.kullanici_adi} placeholder="merve"
                onChange={(e) => setForm((f) => ({ ...f, kullanici_adi: e.target.value }))}
                style={alanStil} />
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <label style={etiketStil}>
                Şifre {form.id ? <span style={{ color: R.not3 }}>· boş = değişmez</span> : ''}
              </label>
              <input type="password" value={form.sifre} placeholder={form.id ? '••••' : 'en az 4 karakter'}
                onChange={(e) => setForm((f) => ({ ...f, sifre: e.target.value }))}
                style={alanStil} />
            </div>
            <div style={{ flex: '1 1 130px' }}>
              <label style={etiketStil}>Rol (etiket)</label>
              <input value={form.rol} placeholder="müdür"
                onChange={(e) => setForm((f) => ({ ...f, rol: e.target.value }))}
                style={alanStil} />
            </div>
          </div>

          {/* 🎭 Şablonlar — başlangıç noktası, kilit değil */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: R.not2 }}>Hızlı başlangıç:</span>
            {Object.keys(SABLON).map((ad) => (
              <button key={ad} onClick={() => setForm((f) => ({ ...f, gorunumler: SABLON[ad]() }))}
                style={{ ...dugme, padding: '5px 11px', fontSize: 11.5 }}>{ad}</button>
            ))}
            <button onClick={() => setForm((f) => ({ ...f, gorunumler: [] }))}
              style={{ ...dugme, padding: '5px 11px', fontSize: 11.5 }}>Hiçbiri</button>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: R.krem, fontWeight: 700 }}>
              {sayac(form.gorunumler)} seçili
            </span>
          </div>

          {/* 🗂 GÖRÜNÜM SEÇİMİ — modül modül gruplu.
              Sahip 60 görünümün tek tek seçilmesini istedi; ama 60 kutucuğu düz
              bir liste hâlinde sunmak angarya olurdu. Modül başlığındaki kutu
              o modülün TAMAMINI açar/kapatır, alttakiler tek tek ayarlanır. */}
          <div style={{ marginTop: 16, display: 'grid', gap: 10,
            gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))' }}>
            {MODULLER.map((m) => (
              <div key={m.id} style={{
                border: `1px solid ${R.cizgi3}`, borderRadius: 10, padding: '10px 12px',
                background: modulHepsi(m.id) ? `${R.bakir}12` : R.girinti,
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={modulHepsi(m.id)}
                    onChange={(e) => modulAc(m.id, e.target.checked)} />
                  <b style={{ fontSize: 12.5, color: R.krem }}>{m.ad}</b>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not3 }}>
                    {(m.gorunumler || []).length}
                  </span>
                </label>
                <div style={{ marginTop: 6, paddingLeft: 4, display: 'grid', gap: 3 }}>
                  {(m.gorunumler || []).map((v) => (
                    <label key={v.id} style={{
                      display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                      fontSize: 11.5, color: secili(m.id, v.id) ? R.metin2 : R.not3,
                    }}>
                      <input type="checkbox" checked={secili(m.id, v.id)}
                        onChange={(e) => gorunumAc(m.id, v.id, e.target.checked)} />
                      {v.ad}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14,
            fontSize: 12, color: R.not, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.aktif}
              onChange={(e) => setForm((f) => ({ ...f, aktif: e.target.checked }))} />
            Girişi açık
          </label>

          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <button disabled={mesgul} onClick={kaydet} style={dugmeAna}>
              {mesgul ? 'Kaydediliyor…' : (form.id ? 'Güncelle' : 'Kullanıcıyı ekle')}
            </button>
            <button disabled={mesgul} onClick={() => { setForm(null); setSilSoru(null); }} style={dugme}>
              Vazgeç
            </button>
            {/* 🗑 KALICI SİLME YALNIZ HİÇ GİRMEMİŞ KAPALI KAYITTA.
                Yanlış yazılmış bir giriş adı ekranda sonsuza kadar durmasın;
                ama bir kez girmiş kimlik defterden kaybolmasın. */}
            {form.id && !form.aktif && !form.son_giris && (
              silSoru === `sil-${form.id}` ? (
                <>
                  <span style={{ fontSize: 12.5, color: R.amber, alignSelf: 'center' }}>
                    Bu kişi hiç giriş yapmamış — kaydı tamamen silinecek. Emin misiniz?
                  </span>
                  <button disabled={mesgul} onClick={() => kaliciSil(form)}
                    style={{ ...dugme, borderColor: `${R.kirmizi}66`, color: R.kirmizi }}>
                    Evet, listeden kaldır
                  </button>
                </>
              ) : (
                <button onClick={() => setSilSoru(`sil-${form.id}`)}
                  style={{ ...dugme, marginLeft: 'auto', color: R.not }}>
                  Listeden kaldır
                </button>
              )
            )}
            {form.id && form.aktif && (
              silSoru === form.id ? (
                <>
                  <span style={{ fontSize: 12.5, color: R.amber, alignSelf: 'center' }}>
                    Girişi kapatılacak — kaydı SİLİNMEZ, geçmiş izleri durur. Emin misiniz?
                  </span>
                  <button disabled={mesgul} onClick={() => kapat(form)}
                    style={{ ...dugme, borderColor: `${R.kirmizi}66`, color: R.kirmizi }}>
                    Evet, kapat
                  </button>
                </>
              ) : (
                <button onClick={() => setSilSoru(form.id)}
                  style={{ ...dugme, marginLeft: 'auto', borderColor: `${R.kirmizi}44`, color: R.kirmizi }}>
                  Girişi kapat
                </button>
              )
            )}
          </div>
        </div>
      )}
    </>
  );
}
