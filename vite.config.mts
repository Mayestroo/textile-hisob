import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('./package.json');
const appVersion = process.env.VITE_APP_VERSION?.trim() || packageJson.version;

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion)
  },
  test: {
    fileParallelism: false,
    server: {
      deps: {
        inline: [/.*/]
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/xlsx-js-style')) {
            return 'xlsx-vendor';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'icons-vendor';
          }
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/zustand')
          ) {
            return 'framework-vendor';
          }
          if (id.includes('node_modules/@tanstack')) {
            return 'tanstack-vendor';
          }
        }
      }
    }
  },
  server: {
    port: 3000,
    open: false,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
