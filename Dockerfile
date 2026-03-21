FROM node:20-slim AS frontend

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=frontend /app/static ./static
COPY main.py database.py motors.py ./

EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
