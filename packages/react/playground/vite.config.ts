import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: {
      '@marginfront/react': path.resolve(__dirname, '../src'),
    },
  },
  server: {
    port: 5555,
  },
});
