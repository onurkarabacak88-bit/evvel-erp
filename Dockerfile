# ── Frontend: yalnız gerekli dosyalar (COPY . . + host node_modules = kırık build önlenir) ──
FROM node:20-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build 

FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=frontend /app/static ./static
COPY main.py database.py motors.py finans_core.py vardiya_motor.py kasa_service.py ./

# Railway ve benzeri platformlar PORT atar; exec formunda env genişlemez → sh -c
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
