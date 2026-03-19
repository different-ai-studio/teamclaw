import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'

const tauriPluginMcpPath = path.resolve(__dirname, '../../.tauri-plugin-mcp')
const useTauriPluginMcpStub = !existsSync(path.join(tauriPluginMcpPath, 'package.json'))

// --- Build config: read build.config.json + optional environment/local overrides ---
function readJSON(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function deepMerge(base: Record<string, unknown>, ...overrides: (Record<string, unknown> | null)[]): Record<string, unknown> {
  const result = { ...base }
  for (const override of overrides) {
    if (!override) continue
    for (const key of Object.keys(override)) {
      const baseVal = result[key]
      const overVal = override[key]
      if (
        baseVal && overVal &&
        typeof baseVal === 'object' && !Array.isArray(baseVal) &&
        typeof overVal === 'object' && !Array.isArray(overVal)
      ) {
        result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>)
      } else if (overVal !== undefined) {
        result[key] = overVal
      }
    }
  }
  return result
}

const buildEnv = process.env.BUILD_ENV
const rootDir = path.resolve(__dirname, '../..')
const baseConfig = readJSON(path.join(rootDir, 'build.config.json'))
const envConfig = buildEnv ? readJSON(path.join(rootDir, `build.config.${buildEnv}.json`)) : null
const localConfig = readJSON(path.join(rootDir, 'build.config.local.json'))
const buildConfig = deepMerge(baseConfig || {}, envConfig, localConfig)

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
  define: {
    __BUILD_CONFIG__: JSON.stringify(buildConfig),
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
