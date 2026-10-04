import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The daemon serves dist/index.html at / and dist/assets/* at /ui/assets/ (src/http/static.ts).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 700 },
});
