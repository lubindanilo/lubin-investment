import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // Charge le .env du root (un seul .env pour le monorepo)
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  return {
    plugins: [react()],
    envDir: path.resolve(__dirname, '../..'),
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_API_URL ?? 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
