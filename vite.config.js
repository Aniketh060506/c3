import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src',
  base: './',
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
  },
  resolve: {
    alias: { '@': path.resolve(path.dirname(''), 'src') }
  }
});
