import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // PORT verilmişse onu kullan — paralel Claude oturumları 5173'te çakışmasın.
  server: { port: Number(process.env.PORT) || 5173, proxy: { '/api': 'http://localhost:8000' } },
  build: { outDir: 'static', emptyOutDir: true }
})
