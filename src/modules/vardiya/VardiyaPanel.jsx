import { useState, useCallback, useEffect, useRef } from 'react';
import { today, api } from '../../utils/api';
import VardiyaGunlukPlan from './VardiyaGunlukPlan';
import VardiyaListe from './VardiyaListe';
import './vardiya.css';

/**
 * Bölüm 3 — Günlük plan: üstte tarih + Plan oluştur; ana panel şube kartları (Açılış / Kapanış).
 */
export default function VardiyaPanel({ onNavigate }) {
  const [tarih, setTarih] = useState(today());
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [vardiyalar, setVardiyalar] = useState([]);
  const [listeLoading, setListeLoading] = useState(true);
  const [listeHata, setListeHata] = useState(null);
  const [izinliPersonel, setIzinliPersonel] = useState([]);
  const [izinLoading, setIzinLoading] = useState(false);
  const [motorLog, setMotorLog] = useState([]);
  const [planOlusturuyor, setPlanOlusturuyor] = useState(false);
  const [planMesaj, setPlanMesaj] = useState(null);
  const [subeOzet, setSubeOzet] = useState([]);
  const [personeller, setPersoneller] = useState([]);
  const [duzenUyarisi, setDuzenUyarisi] = useState(null);
  const [simulasyonAktif, setSimulasyonAktif] = useState(false);
  const [simOnizleme, setSimOnizleme] = useState(null);
  const [simEdits, setSimEdits] = useState({});
  const [simYukleniyor, setSimYukleniyor] = useState(false);
  const simBaselineRef = useRef({});
  const simEditsRef = useRef({});

  const yukleVardiyalar = useCallback(async () => {
    if (!tarih) {
      setVardiyalar([]);
      setSubeOzet([]);
      setListeLoading(false);
      setListeHata(null);
      return;
    }
    setListeLoading(true);
    setListeHata(null);
    try {
      const res = await api(`/vardiya?tarih=${encodeURIComponent(tarih)}`);
      setVardiyalar(Array.isArray(res.vardiyalar) ? res.vardiyalar : []);
      setSubeOzet(Array.isArray(res.sube_ozet) ? res.sube_ozet : []);
    } catch (e) {
      setListeHata(e.message || 'Vardiya listesi alınamadı.');
      setVardiyalar([]);
      setSubeOzet([]);
    } finally {
      setListeLoading(false);
    }
  }, [tarih]);

  useEffect(() => {
    yukleVardiyalar();
  }, [yukleVardiyalar, refreshTrigger]);

  const handleOlusturSuccess = useCallback((res) => {
    setRefreshTrigger((n) => n + 1);
    if (!res) {
      setMotorLog([]);
      return;
    }
    if (Array.isArray(res.log)) {
      setMotorLog(res.log);
      return;
    }
    if (Array.isArray(res.gunler)) {
      const ozet =
        res.mesaj ||
        `Haftalık: ${res.toplam_olusturulan ?? 0} kayıt (${res.hafta_baslangic ?? ''} – ${res.hafta_bitis ?? ''})`;
      setMotorLog([
        { kural: 'HAFTA', detay: ozet },
        ...res.gunler.map((g) => ({
          kural: g.tarih,
          detay: [
            `${g.olusturulan ?? 0} kayıt`,
            g.log_ozet != null ? `${g.log_ozet} log satırı` : null,
            g.mesaj || null,
          ]
            .filter(Boolean)
            .join(' · '),
        })),
      ]);
      return;
    }
    setMotorLog([]);
  }, []);

  const planOlustur = useCallback(async () => {
    if (!tarih) {
      setPlanMesaj({ tur: 'hata', metin: 'Önce bir tarih seçin.' });
      return;
    }
    setPlanOlusturuyor(true);
    setPlanMesaj(null);
    try {
      const res = await api('/vardiya/olustur', {
        method: 'POST',
        body: { tarih },
      });
      setPlanMesaj({
        tur: 'ok',
        metin: res.mesaj || `${res.olusturulan ?? 0} vardiya kaydı oluşturuldu.`,
      });
      handleOlusturSuccess(res);
    } catch (e) {
      setPlanMesaj({
        tur: 'hata',
        metin: e.message || 'Plan oluşturulamadı.',
      });
    } finally {
      setPlanOlusturuyor(false);
    }
  }, [tarih, handleOlusturSuccess]);

  const planOlusturHafta = useCallback(async () => {
    if (!tarih) {
      setPlanMesaj({ tur: 'hata', metin: 'Önce bir tarih seçin.' });
      return;
    }
    setPlanOlusturuyor(true);
    setPlanMesaj(null);
    try {
      const res = await api('/vardiya/olustur-hafta', {
        method: 'POST',
        body: { tarih },
      });
      setPlanMesaj({
        tur: 'ok',
        metin:
          res.mesaj ||
          `Haftalık: ${res.toplam_olusturulan ?? 0} kayıt (${res.hafta_baslangic ?? ''} – ${res.hafta_bitis ?? ''}).`,
      });
      handleOlusturSuccess(res);
    } catch (e) {
      setPlanMesaj({
        tur: 'hata',
        metin: e.message || 'Haftalık plan oluşturulamadı.',
      });
    } finally {
      setPlanOlusturuyor(false);
    }
  }, [tarih, handleOlusturSuccess]);

  useEffect(() => {
    if (!tarih) {
      setIzinliPersonel([]);
      return;
    }
    let cancelled = false;
    setIzinLoading(true);
    api('/personel-izin?durum=onaylandi')
      .then((res) => {
        if (cancelled) return;
        const izinliler = (res || []).filter(
          (iz) =>
            String(iz.baslangic_tarih).slice(0, 10) <= tarih &&
            String(iz.bitis_tarih).slice(0, 10) >= tarih,
        );
        setIzinliPersonel(izinliler);
      })
      .catch(() => {
        if (!cancelled) setIzinliPersonel([]);
      })
      .finally(() => {
        if (!cancelled) setIzinLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tarih]);

  useEffect(() => {
    api('/personel?aktif=true')
      .then((rows) => setPersoneller(Array.isArray(rows) ? rows : []))
      .catch(() => setPersoneller([]));
  }, []);

  const planDuzenUyarisi = useCallback((mesaj) => {
    setDuzenUyarisi(mesaj);
    window.setTimeout(() => setDuzenUyarisi(null), 6000);
  }, []);

  const manuelSonrasiMotorOzet = useCallback((opt) => {
    if (!opt) return;
    if (Array.isArray(opt.log)) setMotorLog(opt.log);
    if (opt.success === false && opt.mesaj) {
      planDuzenUyarisi(opt.mesaj);
    }
  }, [planDuzenUyarisi]);

  const simKapat = useCallback(() => {
    setSimulasyonAktif(false);
    simEditsRef.current = {};
    setSimEdits({});
    setSimOnizleme(null);
  }, []);

  useEffect(() => {
    simKapat();
  }, [tarih, simKapat]);

  const simToggle = useCallback(() => {
    setSimulasyonAktif((prev) => {
      if (!prev) {
        simBaselineRef.current = Object.fromEntries(
          (vardiyalar || []).map((x) => [x.id, x.personel_id]),
        );
        simEditsRef.current = {};
        setSimEdits({});
        setSimOnizleme(null);
        return true;
      }
      simEditsRef.current = {};
      setSimEdits({});
      setSimOnizleme(null);
      return false;
    });
  }, [vardiyalar]);

  const handleSimPersonelDegis = useCallback(
    async (v, yeniPid) => {
      if (!tarih) return;
      const base = simBaselineRef.current[v.id] ?? v.personel_id;
      const next = { ...simEditsRef.current };
      if (yeniPid === base) {
        delete next[v.id];
      } else {
        next[v.id] = yeniPid;
      }
      simEditsRef.current = next;
      setSimEdits({ ...next });
      const senaryo = Object.entries(next).map(([id, personel_id]) => ({ id, personel_id }));
      if (senaryo.length === 0) {
        setSimOnizleme(null);
        setMotorLog([]);
        return;
      }
      setSimYukleniyor(true);
      try {
        const res = await api('/vardiya/senaryo-dene', {
          method: 'POST',
          body: { tarih, senaryo },
        });
        setSimOnizleme({
          vardiyalar: Array.isArray(res.vardiyalar) ? res.vardiyalar : [],
          sube_ozet: Array.isArray(res.sube_ozet) ? res.sube_ozet : [],
          optimize: res.optimize,
        });
        manuelSonrasiMotorOzet(res.optimize);
      } catch (e) {
        planDuzenUyarisi(e.message || 'Senaryo çalıştırılamadı');
      } finally {
        setSimYukleniyor(false);
      }
    },
    [tarih, manuelSonrasiMotorOzet, planDuzenUyarisi],
  );

  const senaryoUygula = useCallback(async () => {
    if (!tarih) return;
    const senaryo = Object.entries(simEditsRef.current).map(([id, personel_id]) => ({
      id,
      personel_id,
    }));
    if (senaryo.length === 0) return;
    setSimYukleniyor(true);
    try {
      const res = await api('/vardiya/senaryo-uygula', {
        method: 'POST',
        body: { tarih, senaryo },
      });
      manuelSonrasiMotorOzet(res.optimize);
      simKapat();
      setRefreshTrigger((n) => n + 1);
    } catch (e) {
      planDuzenUyarisi(e.message || 'Senaryo uygulanamadı');
    } finally {
      setSimYukleniyor(false);
    }
  }, [tarih, manuelSonrasiMotorOzet, planDuzenUyarisi, simKapat]);

  const planVardiyalar = simOnizleme?.vardiyalar ?? vardiyalar;
  const planSubeOzet = simOnizleme?.sube_ozet ?? subeOzet;
  const simUygulaAktif = simulasyonAktif && Object.keys(simEdits).length > 0;

  return (
    <div className="page vardiya-module">
      <div
        className="page-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h2>Vardiya planlama</h2>
          <p>
            Günlük planı şube bazında görüntüleyin; motor{' '}
            <strong>Vardiya kuralları</strong> ve izinlere göre atama yapar.
          </p>
        </div>
        {typeof onNavigate === 'function' && (
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onNavigate('vardiya-haftalik')}
            >
              Haftalık liste (Tulipi)
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onNavigate('vardiya-ayar')}
            >
              Kurallar ve izinler
            </button>
          </span>
        )}
      </div>

      {/* ÜST PANEL — tarih + plan oluştur */}
      <div className="vardiya-plan-topbar">
        <div className="form-group vardiya-plan-topbar-tarih">
          <label htmlFor="vardiya-tarih">Tarih</label>
          <input
            id="vardiya-tarih"
            type="date"
            value={tarih}
            onChange={(e) => {
              setTarih(e.target.value);
              setMotorLog([]);
              setPlanMesaj(null);
            }}
          />
        </div>
        <div className="vardiya-plan-topbar-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={planOlusturuyor || !tarih || listeLoading || !vardiyalar.length}
            onClick={simToggle}
            title={
              simulasyonAktif
                ? 'Simülasyonu kapatır; kaydedilmemiş önizleme iptal olur'
                : 'Kişi değişikliklerini önce dene, sonra uygula'
            }
          >
            {simulasyonAktif ? 'Simülasyonu kapat' : 'Senaryo dene'}
          </button>
          {simulasyonAktif && (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={planOlusturuyor || simYukleniyor || !simUygulaAktif}
                onClick={senaryoUygula}
              >
                Senaryoyu uygula
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={simYukleniyor}
                onClick={simKapat}
              >
                İptal
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={planOlusturuyor || !tarih || simulasyonAktif}
            onClick={planOlustur}
            title={simulasyonAktif ? 'Önce simülasyonu kapatın' : undefined}
          >
            {planOlusturuyor ? (
              <span className="vardiya-spinner-inline">
                <span className="spinner" />
                Oluşturuluyor…
              </span>
            ) : (
              'Plan oluştur'
            )}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={planOlusturuyor || !tarih || simulasyonAktif}
            onClick={planOlusturHafta}
            title="Seçilen tarihin haftası (Pzt–Pz) için sırayla üretir"
          >
            Bu haftayı oluştur
          </button>
        </div>
      </div>

      {planMesaj && (
        <div className={`alert-box ${planMesaj.tur === 'ok' ? 'green' : 'red'} mb-16`}>
          {planMesaj.metin}
        </div>
      )}

      {!izinLoading && izinliPersonel.length > 0 && (
        <div className="vardiya-izin-uyari">
          <div className="vardiya-izin-baslik">
            Bu tarihte {izinliPersonel.length} personel onaylı izinli — planda yer almaz
          </div>
          <div className="vardiya-izin-chips">
            {izinliPersonel.map((iz) => (
              <span key={iz.id} className="vardiya-izin-chip">
                {iz.ad_soyad}
              </span>
            ))}
          </div>
        </div>
      )}

      {listeHata && (
        <div className="alert-box red mb-16">{listeHata}</div>
      )}

      {duzenUyarisi && (
        <div className="alert-box red mb-16">{duzenUyarisi}</div>
      )}

      {/* ANA PANEL — şube kartları */}
      <VardiyaGunlukPlan
        vardiyalar={planVardiyalar}
        subeOzet={planSubeOzet}
        loading={listeLoading}
        tarih={tarih}
        personeller={personeller}
        onPlanChanged={yukleVardiyalar}
        onPlanHata={planDuzenUyarisi}
        onMotorOzet={manuelSonrasiMotorOzet}
        simulasyonModu={simulasyonAktif}
        simYukleniyor={simYukleniyor}
        onSimPersonelDegis={handleSimPersonelDegis}
      />

      <VardiyaListe
        tarih={tarih}
        vardiyalar={planVardiyalar}
        listeLoading={listeLoading}
        onListeYenile={yukleVardiyalar}
        onListeDegisti={() => setMotorLog([])}
      />

      {motorLog.length > 0 && (
        <div className="vardiya-motor-log">
          <h4>Son çalıştırma özeti</h4>
          <ul>
            {motorLog.slice(0, 40).map((satir, i) => (
              <li key={i}>
                <span className="mono">{satir.kural}</span>
                {satir.sube && ` · ${satir.sube}`}
                {satir.personel && ` · ${satir.personel}`}
                {satir.tip && ` · ${satir.tip}`}
                {satir.detay && ` — ${satir.detay}`}
              </li>
            ))}
          </ul>
          {motorLog.length > 40 && (
            <p className="sub" style={{ marginTop: 8 }}>
              … ve {motorLog.length - 40} satır daha (tam liste API yanıtında).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
