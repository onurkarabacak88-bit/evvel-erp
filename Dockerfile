FROM node:20-slim AS frontend

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite build (outDir=static, emptyOutDir) tüm static/ siler — şube paneli HTML korunur
RUN set -eux; \
    if [ -f static/sube_panel.html ]; then cp static/sube_panel.html /tmp/sube_panel.html; fi; \
    npm run build; \
    if [ -f /tmp/sube_panel.html ]; then cp /tmp/sube_panel.html static/sube_panel.html; fi

FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=frontend /app/static ./static
# Kökteki tüm uygulama modülleri (yeni router / servis dosyaları dahil)
COPY *.py ./

RUN mkdir -p data/x_rapor_uploads

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
