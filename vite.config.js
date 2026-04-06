import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const haftalikPanelAbs = path.resolve(
  __dirname,
  'src/modules/vardiya/HaftalikVardiyaPanel.jsx',
)

/**
 * Railway / eski App.jsx: `./modules/vardiya/HaftalikVardiyaPanel` (uzantısız)
 * göreli yolunu doğrudan dosyaya bağlar — disk üzerinde dosya yoksa yine hata verir.
 */
function resolveHaftalikVardiyaPanel() {
  return {
    name: 'resolve-haftalik-vardiya-panel',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!importer) return null
      const imp = importer.replace(/\\/g, '/')
      if (!/\/App\.jsx$/.test(imp)) return null
      const i = id.replace(/\\/g, '/')
      if (
        i === './modules/vardiya/HaftalikVardiyaPanel' ||
        i === './modules/vardiya/HaftalikVardiyaPanel.jsx'
      ) {
        return haftalikPanelAbs
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [resolveHaftalikVardiyaPanel(), react()],
  optimizeDeps: {
    include: ['html2pdf.js'],
  },
  server: { proxy: { '/api': 'http://localhost:8000' } },
  build: {
    outDir: 'static',
    emptyOutDir: true,
    commonjsOptions: { transformMixedEsModules: true },
  },
})
