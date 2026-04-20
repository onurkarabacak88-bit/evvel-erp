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
# Kökteki tüm uygulama modülleri (yeni router / servis dosyaları dahil)
COPY *.py ./

RUN mkdir -p data/x_rapor_uploads

# Railway / Render / Fly: gerçek port $PORT ile gelir. Sabit 8080 = deploy kırılır.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
