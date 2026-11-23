import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true, // Fail if port 5173 is already in use
  },
  resolve: {
    alias: {
      '@marginfront/react': path.resolve(__dirname, './src'),
    },
  },
});
