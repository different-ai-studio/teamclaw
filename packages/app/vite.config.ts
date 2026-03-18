import { existsSync } from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'

const tauriPluginMcpPath = path.resolve(__dirname, '../../.tauri-plugin-mcp')
const useTauriPluginMcpStub = !existsSync(path.join(tauriPluginMcpPath, 'package.json'))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Bundle analysis: run with ANALYZE=true pnpm build
    process.env.ANALYZE && visualizer({
      open: true,
      filename: 'dist/bundle-analysis.html',
      gzipSize: true,
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      ...(useTauriPluginMcpStub && {
        'tauri-plugin-mcp': path.resolve(__dirname, 'src/lib/tauri-plugin-mcp-stub.ts'),
      }),
    },
  },
  // Dev server – MUST stay on 1420 for Tauri devUrl
  server: {
    port: 1420,
    // If 1420 is occupied, fail instead of switching ports,
    // otherwise the Tauri window will load the wrong (blank) URL.
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // Prevent vite from obscuring rust errors
  clearScreen: false,
  // Env prefix for Tauri
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    globals: true,
    environment: 'jsdom',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.tsx',
    ],
  },
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // Produce sourcemaps for error reporting
    sourcemap: !!process.env.TAURI_DEBUG,
    // Chunk splitting strategy
    rollupOptions: {
      // tauri-plugin-mcp is dev-only (linked from .tauri-plugin-mcp/, gitignored)
      external: ['tauri-plugin-mcp'],
      output: {
        manualChunks: {
          // React runtime - stable, long-cache
          'react-vendor': ['react', 'react-dom'],
          // Radix UI primitives
          'radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-select',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-avatar',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
          ],
          // Markdown rendering
          'markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
})
