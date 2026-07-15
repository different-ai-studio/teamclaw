import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'
import viteReact from '@vitejs/plugin-react'
import tsConfigPaths from 'vite-tsconfig-paths'

// FC custom runtime (custom.debian10) runs the build output as a long-lived
// Node HTTP server: `node .output/server/index.mjs`, listening on $PORT (FC
// injects PORT=9000) bound to all interfaces. The Nitro `node-server` preset
// emits exactly that bundle (entry + externalized deps under
// .output/server/node_modules), which the daemon zips wholesale.
export default defineConfig({
  server: { port: 3000 },
  // Keep esbuild from down-transpiling the Node server bundle to the browser
  // default target (es2020/chrome87) — that fails on modern destructuring in
  // the Nitro server entry.
  build: { target: 'esnext' },
  plugins: [
    tsConfigPaths(),
    tanstackStart(),
    nitroV2Plugin({ preset: 'node-server' }),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
  ],
})
