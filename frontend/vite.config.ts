import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));





export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: true,
    
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
        manualChunks: {
          
          'react-vendor': ['react', 'react-dom'],
          'http-vendor': ['axios'],
          'map-vendor': ['maplibre-gl'],
          'icons-vendor': ['lucide-react'],
        },
      },
    },
  },
});
