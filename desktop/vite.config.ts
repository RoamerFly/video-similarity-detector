import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri expects a fixed port
  server: {
    port: 5173,
    strictPort: true,
  },
  // Don't clear screen between builds
  clearScreen: false,
  // Env prefix for Tauri
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 2 targets modern system WebViews; es2022 avoids Vite 8 downlevel
    // transforms that are no longer supported by the new build pipeline.
    target: 'es2022',
    // Don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
