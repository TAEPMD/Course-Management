import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [
    viteSingleFile() // Bundles everything into one HTML file for GAS deployment
  ],
  build: {
    outDir: 'dist',
    // Inline all assets — required for GAS (no external file serving)
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Single JS bundle
        inlineDynamicImports: true
      }
    }
  },
  // Dev server config
  server: {
    port: 3000,
    open: true
  }
});
