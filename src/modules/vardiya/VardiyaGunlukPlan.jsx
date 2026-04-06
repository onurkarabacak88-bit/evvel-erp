import { useState, useCallback } from 'react';
import { api } from '../../utils/api';
import './vardiya.css';

function buildSubeGruplari(vardiyalar) {
  const map = new Map();
  for (const v of vardiyalar) {
    const sid = String(v.sube_id || '').trim() || '_nomatch';
    const ad = (v.sube_adi || '—').trim() || '—';
    if (!map.has(sid)) {
      map.set(sid, { sube_id: sid, sube_adi: ad, ACILIS: [], ARA: [], KAPANIS: [] });
    }
    const g = map.get(sid);
    const t = v.tip;
    if (t === 'ACILIS' || t === 'ARA' || t === 'KAPANIS') {
      g[t].push(v);
    }
  }
  const sortAd = (a, b) =>
    (a.personel_adi || '').localeCompare(b.personel_adi || '', 'tr', { sensitivity: 'base' });
  for (const g of map.values()) {
    g.ACILIS.sort(sortAd);
    g.ARA.sort(sortAd);
    g.KAPANIS.sort(sortAd);
  }
  return [...map.values()].sort((a, b) =>
    a.sube_adi.localeCompare(b.sube_adi, 'tr', { sensitivity: 'base' }),
  );
}

function durumForSube(subeOzet, subeId) {
  const o = (subeOzet || []).find((x) => x.sube_id === subeId);
  return o?.durum || 'tam';
}

function planPersonelOptions(personeller, v) {
  const opts = [...(personeller || [])];
  const pid = v.personel_id || '';
  if (pid && !opts.some((p) => p.id === pid)) {
    opts.unshift({ id: pid, ad_soyad: v.personel_adi || pid });
  }
  return opts;
}

/** Tarayıcı `title` ipucu: motor gerekçesi + vardiya tipi + ana şube uyumu */
function vardiyaSecimTitle(v) {
  if ((v.kaynak || 'motor') === 'manuel') {
    return 'Manuel atama.\nOtomatik seçim gerekçesi tutulmaz.';
  }
  const lines = ['Bu kişi seçildi çünkü:'];
  const tip = v.tip || '';
  if (tip === 'KAPANIS') {
    lines.push('- Kapanış ihtiyacını karşılıyor');
  } else if (tip === 'ACILIS') {
    lines.push('- Açılış ihtiyacını karşılıyor');
  } else if (tip === 'ARA') {
    lines.push('- Ara vardiya ihtiyacını karşılıyor');
  } else {
    lines.push('- Şube vardiya ihtiyacını karşılıyor');
  }
  const ps = String(v.personel_ana_sube_id || '').trim();
  const sid = String(v.sube_id || '').trim();
  if (ps && sid && ps === sid) {
    lines.push('- Başka şubede eksik oluşturmuyor');
  } else if (sid) {
    lines.push('- Havuz skoru ve şube kuralları bu atamayı destekliyor');
  }
  const detay = v.secim_nedeni && String(v.secim_nedeni).trim();
  if (detay) {
    lines.push('');
    lines.push(`Motor ayrıntısı: ${detay}`);
  }
  return lines.join('\n');
}

function PlanSatir({
  v,
  personeller,
  disabled,
  simulasyonModu,
  onDragStart,
  onDragOver,
  onDrop,
  onPersonelChange,
}) {
  const manuel = v.kaynak === 'manuel';
  const secenekler = planPersonelOptions(personeller, v);
  const suruklenebilir = !disabled && !simulasyonModu;

  return (
    <li
      className={`vardiya-plan-isim-li ${manuel ? 'vardiya-plan-li--manuel' : ''}`}
      draggable={suruklenebilir}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className="vardiya-plan-dnd-hint" title="Sürükleyip başka satıra bırakın — personel takası">
        ⋮⋮
      </span>
      {manuel && (
        <span className="vardiya-plan-rozet-manuel" title="Kullanıcı müdahalesi">
          🔴
        </span>
      )}
      <span
        className="vardiya-secim-neden-btn"
        title={vardiyaSecimTitle(v)}
        aria-label="Neden bu kişi seçildi?"
      >
        ?
      </span>
      <select
        className="vardiya-plan-personel-sec"
        value={v.personel_id || ''}
        disabled={disabled}
        onChange={(e) => onPersonelChange(e.target.value)}
      >
        {secenekler.map((p) => (
          <option key={p.id} value={p.id}>
            {p.ad_soyad}
          </option>
        ))}
      </select>
      {v.saat_araligi && (
        <span className="vardiya-plan-saat mono">{v.saat_araligi}</span>
      )}
    </li>
  );
}

function PlanBlok({
  baslik,
  classMod,
  kayitlar,
  personeller,
  islemKilit,
  simulasyonModu,
  takasYap,
  personelDegistir,
}) {
  return (
    <section className={`vardiya-plan-blok ${classMod || ''}`}>
      <div className="vardiya-plan-blok-baslik">{baslik}</div>
      {kayitlar.length === 0 ? (
        <p className="vardiya-plan-blok-bos">—</p>
      ) : (
        <ul className="vardiya-plan-isim-liste">
          {kayitlar.map((v) => (
            <PlanSatir
              key={v.id}
              v={v}
              personeller={personeller}
              disabled={islemKilit}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/vardiya-id', v.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (simulasyonModu) return;
                const kaynakId = e.dataTransfer.getData('text/vardiya-id');
                if (kaynakId && kaynakId !== v.id) {
                  takasYap(kaynakId, v.id);
                }
              }}
              simulasyonModu={simulasyonModu}
              onPersonelChange={(pid) => personelDegistir(v, pid)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Günlük plan tahtası + renk + sürükle-bırak takas + personel seçimi.
 */
export default function VardiyaGunlukPlan({
  vardiyalar,
  subeOzet,
  loading,
  tarih,
  personeller,
  onPlanChanged,
  onPlanHata,
  onMotorOzet,
  simulasyonModu,
  simYukleniyor,
  onSimPersonelDegis,
}) {
  const [islemKilit, setIslemKilit] = useState(false);
  const simKilit = !!simulasyonModu && !!simYukleniyor;

  const yenile = useCallback(async () => {
    if (typeof onPlanChanged === 'function') await onPlanChanged();
  }, [onPlanChanged]);

  const motorYanitiIsle = useCallback(
    (res) => {
      if (res && res.optimize && typeof onMotorOzet === 'function') {
        onMotorOzet(res.optimize);
      }
    },
    [onMotorOzet],
  );

  const takasYap = useCallback(
    async (idA, idB) => {
      if (simulasyonModu) {
        if (typeof onPlanHata === 'function') {
          onPlanHata('Simülasyon modunda sürükle-bırak takası kapalı.');
        }
        return;
      }
      setIslemKilit(true);
      try {
        const res = await api('/vardiya/takas', {
          method: 'POST',
          body: { id_a: idA, id_b: idB },
        });
        motorYanitiIsle(res);
        await yenile();
      } catch (err) {
        if (typeof onPlanHata === 'function') {
          onPlanHata(err.message || 'Takas yapılamadı');
        }
      } finally {
        setIslemKilit(false);
      }
    },
    [yenile, onPlanHata, motorYanitiIsle, simulasyonModu],
  );

  const personelDegistir = useCallback(
    async (v, yeniPid) => {
      if (!yeniPid || yeniPid === v.personel_id) return;
      if (simulasyonModu && typeof onSimPersonelDegis === 'function') {
        setIslemKilit(true);
        try {
          await onSimPersonelDegis(v, yeniPid);
        } finally {
          setIslemKilit(false);
        }
        return;
      }
      setIslemKilit(true);
      try {
        const res = await api(`/vardiya/${encodeURIComponent(v.id)}`, {
          method: 'PATCH',
          body: { personel_id: yeniPid },
        });
        motorYanitiIsle(res);
        await yenile();
      } catch (err) {
        if (typeof onPlanHata === 'function') {
          onPlanHata(err.message || 'Güncellenemedi');
        }
      } finally {
        setIslemKilit(false);
      }
    },
    [yenile, onPlanHata, motorYanitiIsle, simulasyonModu, onSimPersonelDegis],
  );

  if (loading) {
    return (
      <div className="vardiya-plan-board">
        <div className="loading vardiya-plan-loading">
          <div className="spinner" />
          <span>Plan yükleniyor…</span>
        </div>
      </div>
    );
  }

  if (!vardiyalar.length) {
    return (
      <div className="vardiya-plan-board">
        <div className="vardiya-plan-empty">
          <div className="icon">🏗️</div>
          <p>
            <strong>{tarih || 'Bu tarih'}</strong> için henüz plan yok.
          </p>
          <p className="sub">Üstteki «Plan oluştur» ile motoru çalıştırın.</p>
        </div>
      </div>
    );
  }

  const gruplar = buildSubeGruplari(vardiyalar);
  const hasManuelSatir = vardiyalar.some((x) => x.kaynak === 'manuel');

  const blokKilit = islemKilit || simKilit;

  return (
    <div className="vardiya-plan-board">
      <div className="vardiya-plan-board-heading">
        <h3>Günlük plan</h3>
        <span className="vardiya-plan-board-tarih mono">{tarih}</span>
      </div>

      {simulasyonModu && (
        <div className="vardiya-sim-banner" role="status">
          <strong>Simülasyon modu</strong>
          <span>
            Kişi değişiklikleri veritabanına yazılmaz; sonuç önizleme olarak gösterilir. Uygula ile
            kalıcı yapın veya simülasyonu kapatın.
          </span>
          {simYukleniyor && <span className="vardiya-sim-banner-spinner">Senaryo hesaplanıyor…</span>}
        </div>
      )}

      <div className="vardiya-renk-legend">
        <span className="vardiya-renk-legend-title">Renk (şube kartı çerçevesi)</span>
        <ul className="vardiya-renk-legend-list">
      <li>
        <span className="vardiya-dot vardiya-dot--eksik" /> 🔴 Eksik (kota / açılış-kapanış)
      </li>
      <li>
        <span className="vardiya-dot vardiya-dot--fazla" /> 🟣 Fazla (girdi kotasından çok atama)
      </li>
      <li>
        <span className="vardiya-dot vardiya-dot--riskli" /> 🟡 Riskli (farketmez kuralı veya tam/part
        hedefi)
      </li>
      <li>
        <span className="vardiya-dot vardiya-dot--tam" /> 🟢 Tam
      </li>
      <li>
        <span className="vardiya-dot vardiya-dot--manuel" /> 🔴 Satır: kullanıcı müdahalesi (manuel)
      </li>
        </ul>
        <p className="vardiya-renk-legend-hint">
          Personeli satırdaki listeden değiştirebilir; iki satırı sürükleyip bırakarak yerlerini
          takas edebilirsiniz (aynı gün). «Plan oluştur» tümünü yeniden motorla yazar.
        </p>
        <p className="vardiya-secim-legend">
          <strong>Neden bu seçildi?</strong> Satırdaki <span className="vardiya-secim-neden-btn inline" aria-hidden>?</span>{' '}
          üzerine gelin: motor özeti (ör. kapanış ihtiyacı, ana şubede görev) ve teknik not.
        </p>
        {islemKilit && (
          <p className="vardiya-renk-legend-saving">Kaydediliyor…</p>
        )}
      </div>

      <div className="vardiya-plan-sube-list">
        {gruplar.map((g) => {
          const durum = durumForSube(subeOzet, g.sube_id);
          const oz = (subeOzet || []).find((x) => x.sube_id === g.sube_id);
          const manuelSay = oz?.manuel_satir ?? 0;
          return (
            <article
              key={g.sube_id}
              className={`vardiya-plan-sube-card vardiya-plan-sube--${durum}`}
            >
              <div className="vardiya-plan-sube-heading">
                <h4 className="vardiya-plan-sube-adi">{g.sube_adi}</h4>
                {manuelSay > 0 && (
                  <span className="vardiya-plan-sube-manuel-ozet" title="Bu şubede manuel satır">
                    🔴 {manuelSay} manuel
                  </span>
                )}
              </div>
              <div className="vardiya-plan-sube-grid">
                <PlanBlok
                  baslik="AÇILIŞ"
                  classMod="vardiya-plan-blok--acilis"
                  kayitlar={g.ACILIS}
                  personeller={personeller}
                  islemKilit={blokKilit}
                  simulasyonModu={!!simulasyonModu}
                  takasYap={takasYap}
                  personelDegistir={personelDegistir}
                />
                <PlanBlok
                  baslik="KAPANIŞ"
                  classMod="vardiya-plan-blok--kapanis"
                  kayitlar={g.KAPANIS}
                  personeller={personeller}
                  islemKilit={blokKilit}
                  simulasyonModu={!!simulasyonModu}
                  takasYap={takasYap}
                  personelDegistir={personelDegistir}
                />
                {g.ARA.length > 0 && (
                  <PlanBlok
                    baslik="ARA"
                    classMod="vardiya-plan-blok--ara vardiya-plan-blok--span2"
                    kayitlar={g.ARA}
                    personeller={personeller}
                    islemKilit={blokKilit}
                    simulasyonModu={!!simulasyonModu}
                    takasYap={takasYap}
                    personelDegistir={personelDegistir}
                  />
                )}
              </div>
            </article>
          );
        })}
      </div>
      {hasManuelSatir && (
        <p className="vardiya-plan-manuel-alt">
          Manuel satırlar korunur; kayıt veya takas sonrası planın geri kalanı otomatik yeniden optimize
          edilir. «Plan oluştur» tüm günü sıfırdan üretir (manuel satırlar dahil silinir).
        </p>
      )}
    </div>
  );
}
