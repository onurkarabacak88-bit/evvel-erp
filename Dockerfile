FROM node:20-slim AS frontend
 
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite build (outDir=static, emptyOutDir) static/ içeriğini siler — kök HTML panelleri korunur
RUN mkdir -p /tmp/evvel_static_html && \
    (cp static/*.html /tmp/evvel_static_html/ 2>/dev/null || true) && \
    npm run build && \
    (cp /tmp/evvel_static_html/*.html static/ 2>/dev/null || true)

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
