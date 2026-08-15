// ─────────────────────────────────────────────────────────────────────────────
// KİMLİK BİRLEŞTİRME — aynı tedarikçinin farklı adlarını tek kimlikte toplama.
//
// SORUN (ATALAY pilotu): faturalar bir ada, ödemeler başka ada yazılınca cari
// ekstre parçalanıyor. Bu ekran KANITLI öneri sunar, sahip karar verir.
//
// ⚠️ BİRLEŞTİRME ≠ MAHSUP: karar yalnız "bunlar aynı kişi" der. Hiçbir bakiye
//    kapanmaz/netleşmez, eski kayıtların ADLARI değişmez (karar bir yorum
//    katmanıdır). Karar defteri APPEND-ONLY: geri alma = ters karar yazmak.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo } from './parcalar';

export default function KimlikBirlestirme({ onToast, Bos, KucukModal }) {
  const [oneri, setOneri] = useState({ yukleniyor: true, hata: '', veri: null });
  const [defter, setDefter] = useState({ yukleniyor: true, hata: '', veri: null });
  const [onay, setOnay] = useState(null);     // {tip:'birlestir'|'ayir', ...}
  const [mesgul, setMesgul] = useState(false);

  const yukle = useCallback(() => {
    setOneri((o) => ({ ...o, yukleniyor: true, hata: '' }));
    api('/tedarikci-zinciri/kimlik-oneriler')
      .then((d) => setOneri({ yukleniyor: false, hata: '', veri: d }))
      // HATA ≠ BOŞ: okuma düşerse "öneri yok" demek yanlış bilgidir.
      .catch((e) => setOneri({ yukleniyor: false, veri: null, hata: e?.message || 'Öneriler alınamadı' }));
    setDefter((o) => ({ ...o, yukleniyor: true, hata: '' }));
    api('/tedarikci-zinciri/kimlik-defteri')
      .then((d) => setDefter({ yukleniyor: false, hata: '', veri: d }))
      .catch((e) => setDefter({ yukleniyor: false, veri: null, hata: e?.message || 'Defter alınamadı' }));
  }, []);
  useEffect(yukle, [yukle]);

  const kararGonder = async () => {
    if (!onay || mesgul) return;              // çift-tık guard
    setMesgul(true);
    try {
      const r = await api('/tedarikci-zinciri/kimlik-karar', {
        method: 'POST',
        body: {
          kanonik_ad: onay.kanonik, aliaslar: onay.aliaslar, karar: onay.tip,
          kanit_ozet: onay.kanit || null,
          gerekce: onay.tip === 'birlestir' ? 'kanıtlı öneri onaylandı' : 'birleştirme geri alındı',
        },
      });
      const n = (r?.yazilan || []).length;
      onToast?.(onay.tip === 'birlestir'
        ? `✓ ${onay.kanonik} kimliği birleştirildi (${n} ad) — bakiye DEĞİŞMEDİ`
        : `✓ ${(onay.aliaslar || []).join(', ')} ayrıldı — birleştirme geri alındı`);
      setOnay(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Karar yazılamadı');
    } finally { setMesgul(false); }
  };

  const oneriler = oneri.veri?.oneriler || [];
  const kararlar = defter.veri?.kararlar || [];

  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Açık öneri', deger: oneri.hata ? '—' : String(oneriler.length),
          alt: oneri.hata ? 'okunamadı' : 'kanıtlı eşleşme',
          renk: oneri.hata ? R.kirmizi : oneriler.length ? R.amber : R.yesil },
        { etiket: 'Karar sayısı', deger: defter.hata ? '—' : String(kararlar.length),
          alt: 'append-only defter', renk: R.krem },
        { etiket: 'Aktif bağ', deger: String(Object.keys(defter.veri?.guncel_baglar || {}).length),
          alt: 'birleşik ad', renk: R.mavi },
      ]} />

      {oneri.hata ? (
        <div style={{ ...kartYuzey, padding: '14px 18px', marginBottom: 12, borderLeft: `3px solid ${R.kirmizi}`, fontSize: 12.5, color: R.metin2 }}>
          ⚠ Öneriler okunamadı — bu &quot;öneri yok&quot; DEĞİL, bilinmiyor. {oneri.hata}
        </div>
      ) : oneri.yukleniyor ? (
        <div style={{ ...kartYuzey, padding: 20, color: R.not, fontSize: 12.5 }}>Öneriler yükleniyor…</div>
      ) : oneriler.length === 0 ? (
        <Bos baslik="Çakışan kimlik önerisi yok"
          aciklama="Sistem fatura serilerini izliyor — aynı seri iki farklı adda görülürse öneri burada çıkar."
          renk={R.yesil} />
      ) : (
        <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14 }}>
          <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
            Aynı tedarikçi olabilir
          </div>
          <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 12, lineHeight: 1.55 }}>
            Kanıt: e-fatura serisi bir mükellefe tahsis edilir. Birleştirme yalnız KİMLİK
            kararıdır — hiçbir bakiye kapanmaz.
          </div>
          {oneriler.map((o) => (
            <div key={o.seri_onek} style={{
              padding: '12px 14px', borderRadius: 11, marginBottom: 9,
              background: R.girinti, border: `1px solid ${R.cizgi3}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 13, color: R.krem }}>{(o.oneri_grubu || []).join('  ·  ')}</b>
                <span style={{ fontSize: 11, color: R.not2, marginLeft: 'auto' }}>{o.fatura_adet} fatura</span>
              </div>
              <div style={{ fontSize: 11.5, color: R.amber, marginTop: 5 }}>🔎 {o.kanit}</div>
              {o.mevcut_harita_kanit && (
                <div style={{ fontSize: 11, color: R.not2, marginTop: 3 }}>+ {o.mevcut_harita_kanit}</div>
              )}
              <div style={{ fontSize: 11, color: R.not2, marginTop: 5 }}>
                {(o.ornek_faturalar || []).map((f) => `${f.ad}: ${f.fatura_no}`).join(' · ')}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {(o.oneri_grubu || []).map((kan) => (
                  <button key={kan} onClick={() => setOnay({
                    tip: 'birlestir', kanonik: kan,
                    aliaslar: (o.oneri_grubu || []).filter((x) => x !== kan),
                    kanit: o.kanit,
                  })} style={{
                    padding: '7px 13px', borderRadius: 9, cursor: 'pointer',
                    border: `1px solid ${R.bakir}66`, background: `${R.bakir}18`,
                    color: R.bakir, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                  }}>{kan} altında birleştir</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {defter.hata ? (
        <div style={{ ...kartYuzey, padding: '14px 18px', borderLeft: `3px solid ${R.kirmizi}`, fontSize: 12.5, color: R.metin2 }}>
          ⚠ Karar defteri okunamadı — {defter.hata}
        </div>
      ) : kararlar.length > 0 && (
        <Tablo
          baslik="Kimlik karar defteri"
          not="append-only · satır silinmez, geri alma ters karar yazar"
          kolonlar={[{ ad: 'Zaman' }, { ad: 'Kanonik' }, { ad: 'Alias' }, { ad: 'Karar' }, { ad: '' }]}
          satirlar={kararlar.map((k) => ({
            id: k.id,
            hucreler: [
              { v: String(k.karar_zamani || '').slice(0, 16).replace('T', ' '), mono: true, renk: R.not },
              { v: k.kanonik_ad, kalin: true },
              { v: k.alias_ad },
              { v: k.karar === 'birlestir' ? 'birleştirildi' : 'ayrıldı',
                rozet: k.karar === 'birlestir' ? R.yesil : R.not },
              {
                v: k.karar === 'birlestir' ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); setOnay({ tip: 'ayir', kanonik: k.kanonik_ad, aliaslar: [k.alias_ad] }); }}
                    style={{
                      padding: '4px 10px', borderRadius: 8, cursor: 'pointer',
                      border: `1px solid ${R.cizgi3}`, background: 'transparent',
                      color: R.metin2, fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                    }}
                  >Ayır</button>
                ) : '',
              },
            ],
          }))}
        />
      )}

      {onay && (
        <KucukModal
          baslik={onay.tip === 'birlestir' ? 'Kimlikleri birleştir' : 'Birleştirmeyi geri al'}
          alt={onay.tip === 'birlestir' ? 'kimlik kararı — bakiye değişmez' : 'ters karar deftere yazılır'}
          onKapat={() => !mesgul && setOnay(null)}
        >
          <div style={{ fontSize: 12.5, color: R.metin2, lineHeight: 1.6 }}>
            {onay.tip === 'birlestir' ? (
              <>
                <b style={{ color: R.krem }}>{(onay.aliaslar || []).join(', ')}</b> adları
                {' '}<b style={{ color: R.bakir }}>{onay.kanonik}</b> kimliği altında toplanacak.
                <div style={{
                  marginTop: 10, padding: '10px 12px', borderRadius: 10,
                  background: `${R.amber}12`, border: `1px solid ${R.amber}44`, fontSize: 11.5, lineHeight: 1.6,
                }}>
                  ⚠ Bu bir <b>kimlik</b> kararıdır: hiçbir bakiye kapanmaz, netleştirilmez.
                  Eski kayıtların adları da <b>değişmez</b>. Cari ekstre ve ödeme akışı
                  bundan sonra bu adları birlikte okur.
                </div>
              </>
            ) : (
              <>
                <b style={{ color: R.krem }}>{(onay.aliaslar || []).join(', ')}</b> bağımsız kimliğe döndürülecek.
                <div style={{ marginTop: 10, fontSize: 11.5, color: R.not2 }}>
                  Önceki karar defterde kalır (silinmez); üstüne &quot;ayrıldı&quot; satırı yazılır.
                </div>
              </>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
            <button disabled={mesgul} onClick={() => setOnay(null)} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer',
            }}>Vazgeç</button>
            <button disabled={mesgul} onClick={kararGonder} style={{
              padding: '10px 20px', borderRadius: 10, border: 'none',
              background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
              fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
            }}>
              {mesgul ? 'Yazılıyor…' : (onay.tip === 'birlestir' ? 'Birleştir' : 'Ayır')}
            </button>
          </div>
        </KucukModal>
      )}
    </>
  );
}
