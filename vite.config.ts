import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    minify: false,     // ⚠️ solo temporal para ver el error claro
    sourcemap: true,
    target: 'esnext'
  },
  optimizeDeps: {
    include: ['date-fns', 'date-fns/locale/es']
  }
});
