FROM node:20-bookworm-slim AS frontend 

WORKDIR /app
COPY package.json package-lock.json ./
# Birçok builder NODE_ENV=production ile çalışır; o durumda `npm ci` devDependencies
# (vite, @vitejs/plugin-react) kurmaz ve `vite build` bulunamadığı için patlar.
# Bu satırda ortamı developman bırakıyoruz; sonraki `npm run build` yine üretim bundle üretir.
RUN NODE_ENV=development npm ci
COPY . .

# Önceki build çıktılarını temizle — taahhüt edilmiş static/ veya lokal artıklar
# Vite’ın emptyOutDir:true ayarına rağmen eski index.html’in yeniden taranmasını önler.
RUN rm -rf static/ dist/

# Küçük RAM’li builder’larda Rollup/Vite SIGKILL yerine çıkabilsin diye (Railway vb.)
ENV NODE_OPTIONS=--max-old-space-size=4096

# Vite build (outDir=static, emptyOutDir). Hata çıktısı için tek komut:
RUN npm run build
RUN test -f static/index.html

# Kök HTML panelleri — build çıktısına kopyalanır (dosya yoksa sessiz geç)
RUN cp -f sube_panel.html static/ 2>/dev/null || true

FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=frontend /app/static ./static
# Runtime uygulama modülleri. Dev/test/bakım scriptleri bilerek production imajına alınmaz.
COPY \
    analitik_olay.py \
    banka_yatirim_api.py \
    belge_talep_api.py \
    borc_navigasyon_api.py \
    ciro_taslak_api.py \
    database.py \
    ekstre_parser.py \
    ev_tasarim_api.py \
    evo_sync.py \
    evvel_merkez_guard.py \
    fatura_api.py \
    finans_core.py \
    finansal_duyu_api.py \
    fire_bildirim.py \
    gorev_api.py \
    is_basvuru_api.py \
    kart_analiz.py \
    kasa_acilis_backfill.py \
    kasa_fark_recalc.py \
    kasa_service.py \
    kasa_teslim_api.py \
    kontrol_motoru.py \
    main.py \
    motors.py \
    odeme_plani_api.py \
    odeme_plani_motor_api.py \
    operasyon_defter.py \
    operasyon_kurallar.py \
    operasyon_merkez_api.py \
    operasyon_stok_motor.py \
    personel_maliyet.py \
    personel_panel_auth.py \
    rapor_cache.py \
    sevkiyat_helpers.py \
    siparis_depo_temizlik.py \
    siparis_kontrol_kulesi.py \
    siparis_sevkiyat_islem.py \
    stok_bar_uyum.py \
    stok_sayim_api.py \
    sube_kapanis_dual.py \
    sube_operasyon.py \
    sube_panel.py \
    sube_personel_api.py \
    supplier_payment.py \
    tam_maliyet_api.py \
    tedarikci_api.py \
    tr_saat.py \
    truth_motor.py \
    tv_menu_api.py \
    vardiya_plan_motor.py \
    vardiya_v2.py \
    whatsapp_bildirim.py \
    ./

RUN mkdir -p data/x_rapor_uploads

# Railway / Render / Fly: gerçek port $PORT ile gelir. Sabit 8080 = deploy kırılır.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
