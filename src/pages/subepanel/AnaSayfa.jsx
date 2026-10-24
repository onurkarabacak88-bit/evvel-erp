// 🏠 ŞUBE PANELİ — ANA SAYFA (eski sube_panel.html §4 sırasıyla AYNEN; QR'lar yeni sistem — PANEL_YENIDEN_KURULUM.md Basamak 1)
// ⓪ Vardiyaya giriş (dönen QR + bugün girenler + son okutanlar) · ① gün çizgisi AÇILIŞ · KAPANIŞ (KONTROL yok: istisna 10) ·
// ② 5 hızlı kart · ③ durum çipleri (kaynak henüz yoksa "—") · ④ sipariş red listesi · ⑤ merkez mesajları · ⑥ son teslim / kabul · bugün kaydedilenler.
// "Dünkü kapanış yapılmadı" kartı YOK (sahip: panel söylemesin — merkez Bekleyen işler'de görür).
import React from 'react';
import { C, TabletQR } from './ortak';

const TUR_AD = { acilis: 'Açılış', kapanis: 'Kapanış', urun_ac: 'Ürün açıldı', fire: 'Fire', teslim: 'Ara teslim', vardiya: 'Kasa devri', teslim_al: 'Tedarikçi teslimi', depo_kabul: 'Depodan gelen kabul', siparis: 'Sipariş', sevk_cikis: 'Sevk çıkışı', gider: 'Anlık gider', teslim_geri_al: 'Teslim geri alındı', not: 'Merkez notu' };

function GunNoktasi({ ad, veri, varsayilan, son }) {
  const tamam = !!veri;
  return (
    <div style={{ display: 'flex', alignItems: 'center', flex: son ? '0 0 auto' : 1, gap: 8, minWidth: 0 }}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 4, minWidth: 90 }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900,
          background: tamam ? C.yesil : C.bg3, border: `2px solid ${tamam ? C.yesil : C.cizgi}`, color: tamam ? '#05210f' : C.soluk }}>{tamam ? '✓' : '○'}</div>
        <b style={{ fontSize: 13 }}>{ad}</b>
        <span style={{ fontSize: 12, color: tamam ? C.yesil : C.soluk }}>{tamam ? `${veri.saat} · ${veri.kim || ''}` : (varsayilan === '00:00' ? 'gün sonunda' : `bekleniyor · ${varsayilan}`)}</span>
      </div>
      {!son && <div style={{ flex: 1, height: 3, borderRadius: 2, background: tamam ? C.yesil : C.cizgi, marginBottom: 34 }} />}
    </div>
  );
}

function Cip({ ad, deger, onClick }) {
  const aktif = typeof deger === 'number' && deger > 0;
  return (
    <button type="button" className="sp-cip" onClick={onClick} style={aktif ? { borderColor: C.sari, color: C.sari } : undefined}>
      {ad} <b style={{ color: aktif ? C.sari : C.yazi }}>{deger ?? '—'}</b>
    </button>
  );
}

export default function AnaSayfa({ d, yok, tabletVar, kapali, ac, setQrBuyuk, setMolaQr, bilgi, avansTeslim }) {
  const cizgi = d.gun_cizgisi || {};
  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      {!d.acilis_var && !kapali && (
        <button className="sp-btn sp-ana" style={{ minHeight: 96, fontSize: 22 }} onClick={() => ac('acilis')}>☀️ Açılışı Yap — kasa + sayım</button>
      )}
      {kapali && <div className="sp-kart" style={{ color: C.soluk, fontWeight: 700 }}>🔒 Gün kapandı — yeni iş günü 02:00'de başlar · yalnız Depodan Gelen ve Sipariş Takip açık</div>}

      {/* ⓪ VARDİYAYA GİRİŞ — eski sabit QR KALKTI, yerine yeni dönen QR + bugün girenler */}
      {yok.var && (
        <div className="sp-kart" style={{ display: 'grid', gridTemplateColumns: tabletVar ? '96px 1fr' : '1fr', gap: 14, alignItems: 'start' }}>
          {tabletVar && <TabletQR boyut={96} onClick={() => setQrBuyuk(true)} />}
          <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b>📱 Vardiyaya giriş</b>
              <span style={{ color: C.soluk, fontSize: 13 }}>{tabletVar ? "Sabahçı, aracı veya kapanış — QR'ı telefonunla okut, sistem seni tanır" : 'Bu bilgisayar kayıtlı değil — merkezden bağlantı iste'}</span>
              {yok.kapanis_sorumlusu?.ad && <span style={{ marginLeft: 'auto', color: C.yesil, fontWeight: 700 }}>🌙 Kapanış sorumlusu: {yok.kapanis_sorumlusu.ad}</span>}
            </div>
            {(yok.girenler || []).length === 0 && <div style={{ color: C.soluk }}>Henüz QR ile giren yok.</div>}
            {(yok.girenler || []).map((g) => (
              <div key={g.personel_id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: `1px solid ${C.cizgi}`, opacity: g.acik ? 1 : 0.55 }}>
                <b style={{ flex: 1 }}>{g.ad}</b>
                <span style={{ color: C.soluk }}>giriş {g.giris || '—'}</span>
                <span style={{ color: g.cikis ? C.yesil : C.soluk, width: 110, textAlign: 'right' }}>{g.cikis ? `✓ çıkış ${g.cikis}` : g.molada ? '🍽 molada' : 'içeride'}</span>
              </div>
            ))}
            {(yok.son_okutanlar || []).length > 0 && (
              <div style={{ borderTop: `1px solid ${C.cizgi}`, paddingTop: 6 }}>
                <div style={{ color: C.soluk, fontSize: 12, fontWeight: 700 }}>Son okutanlar</div>
                {yok.son_okutanlar.map((o, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, padding: '3px 0', fontSize: 13 }}>
                    <span style={{ color: C.soluk, width: 44 }}>{o.saat}</span><b style={{ flex: 1 }}>{o.ad}</b>
                    <span style={{ color: o.islem === 'giris' ? C.yesil : C.sari }}>{{ giris: 'giriş', cikis: 'çıkış', mola_bas: '🍽 mola', mola_bit: '🍽 mola bitti', devret: 'devretti', kabul: 'devraldı', ustlen: 'devir sayımı' }[o.islem]
                      || (String(o.islem).startsWith('devir_devreden') ? '💵 devir · veren' : String(o.islem).startsWith('devir_devralan') ? '💵 devir · alan'
                        : String(o.islem).startsWith('onay') ? 'onay' : o.islem)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ① GÜN ÇİZGİSİ — Günlük Operasyon */}
      <div className="sp-kart" style={{ display: 'grid', gap: 10 }}>
        <b>Günlük Operasyon</b>
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          <GunNoktasi ad="AÇILIŞ" veri={cizgi.acilis} varsayilan={d.saat?.acilis || '07:00'} />
          <GunNoktasi ad="KAPANIŞ" veri={cizgi.kapanis} varsayilan={d.saat?.kapanis || '22:30'} son />
        </div>
      </div>

      {/* ② HIZLI AKSİYONLAR — eski 5 kart */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
        <button className="sp-hizli" disabled={kapali} style={{ background: 'linear-gradient(135deg,#7f1d1d,#ef4444)' }} onClick={() => ac('fire')}><i>🔥</i><b>Fire Bildirimi</b><span>Kayıp / zayi kaydı</span></button>
        <button className="sp-hizli" disabled={kapali} style={{ background: 'linear-gradient(135deg,#1e3a8a,#3b82f6)' }} onClick={() => ac('ac')}><i>🔓</i><b>Ürün Aç</b><span>Depodan kullanıma al</span></button>
        <button className="sp-hizli" disabled={kapali} style={{ background: 'linear-gradient(135deg,#78350f,#f59e0b)' }} onClick={() => ac('gider')}><i>💸</i><b>Anlık Gider</b><span>Çekmeceden nakit gider</span></button>
        <button className="sp-hizli" style={{ background: 'linear-gradient(135deg,#4c1d95,#8b5cf6)' }} onClick={() => ac('not')}><i>📝</i><b>Merkez Notu</b><span>Operasyona bildir</span></button>
        <button className="sp-hizli" disabled={!yok.var} style={{ background: 'linear-gradient(135deg,#7c2d12,#f97316)' }} onClick={() => setMolaQr(true)}><i>🍽️</i><b>Yemek Molası</b><span>QR okut → mola başlat / bitir</span></button>
      </div>

      {/* 🤝 ELDEN VERİLECEK AVANS — merkez onayladı; çekmeceden verilince ad + PIN ile "teslim ettim" (sahip 20 Eki) */}
      {(d.avans_elden || []).length > 0 && (
        <div className="sp-kart" style={{ display: 'grid', gap: 8, borderColor: 'rgba(245,158,11,.5)' }}>
          <b>🤝 Elden verilecek avans</b>
          {d.avans_elden.map((t) => (
            <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{t.ad}</span><b>{Number(t.tutar).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ₺</b>
              <button type="button" className="sp-btn sp-yesil" style={{ minHeight: 44 }} disabled={kapali} onClick={() => avansTeslim?.(t)}>Teslim ettim</button>
            </div>
          ))}
        </div>
      )}

      {/* ③ DURUM ÇİPLERİ — kaynak Evvel Yeni'de henüz yoksa "—" (0 yanlış bilgi olur; gizlemek düzeni bozar) */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Cip ad="📦 Bekleyen Sipariş" deger={d.cipler?.bekleyen_siparis} onClick={() => bilgi('Sipariş takip ekranı kendi basamağında açılacak')} />
        <Cip ad="📩 Merkez Mesajı" deger={d.cipler?.merkez_mesaji} onClick={() => bilgi('Mesajlar kendi basamağında açılacak')} />
      </div>

      {/* ④ SİPARİŞ RED LİSTESİ · ⑤ MERKEZ MESAJLARI · ⑥ SON TESLİM / KABUL — kutular yerinde */}
      <div className="sp-kart" style={(d.siparis_red || []).length ? { borderColor: C.kirmizi } : undefined}><b>🚫 Reddedilen sipariş talepleri</b>
        {(d.siparis_red || []).length === 0 && <div style={{ color: C.soluk, marginTop: 6 }}>Reddedilen talep yok.</div>}
        {(d.siparis_red || []).map((r, i) => <div key={i} style={{ color: C.soluk, padding: '4px 0' }}>{/^\d{4}-\d{2}-\d{2}/.test(r.tarih || '') ? `${r.tarih.slice(8, 10)}.${r.tarih.slice(5, 7)}` : r.tarih} · {r.mesaj}</div>)}</div>
      <div className="sp-kart"><b>📩 Merkez Mesajları</b><div style={{ color: C.soluk, marginTop: 6 }}>{(d.mesajlar || []).length ? `${d.mesajlar.length} okunmamış mesaj` : 'Henüz mesaj yok.'}</div></div>
      <div className="sp-kart"><b>📦 Son Teslim / Kabul</b>
        {(d.son_teslimler || []).length === 0 && <div style={{ color: C.soluk, marginTop: 6 }}>Son 3 günde teslim kaydı yok.</div>}
        {(d.son_teslimler || []).map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: i ? `1px solid ${C.cizgi}` : undefined, opacity: t.geri ? 0.55 : 1 }}>
            <span style={{ color: C.soluk, width: 92 }}>{t.gun === d.gun ? 'Bugün' : t.gun.slice(8, 10) + '.' + t.gun.slice(5, 7)} {t.saat}</span>
            <span style={{ flex: 1 }}>{t.ne}{t.geri ? ' · ↩ iptal / geri alındı' : ''}</span>
            <span style={{ color: C.soluk }}>{t.kim}</span>
          </div>
        ))}</div>

      <div className="sp-kart">
        <b>Bugün kaydedilenler</b>
        {d.bugun.length === 0 && <div style={{ color: C.soluk, marginTop: 6 }}>Henüz kayıt yok.</div>}
        {d.bugun.map((o) => (
          <div key={o.id} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: `1px solid ${C.cizgi}`, opacity: o.iptal ? 0.5 : 1 }}>
            <span style={{ color: C.soluk, width: 48 }}>{o.zaman}</span>
            <b style={{ flex: 1 }}>{TUR_AD[o.tur] || o.tur}</b>
            <span style={{ color: C.soluk }}>{o.kim}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
