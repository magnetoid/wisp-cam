import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(here, '../shared'),
    },
  },
  server: {
    port: 5173,
    // Allows testing from a phone on the same network; camera access still
    // requires HTTPS or localhost, so use a tunnel for real device testing.
    host: true,
  },
  build: {
    outDir: 'dist',
    // The TensorFlow bundle produces a ~16MB sourcemap that dwarfs the app.
    sourcemap: false,
    // The NSFW model weights are a single large lazy-loaded chunk by design.
    chunkSizeWarningLimit: 4096,
  },
});
