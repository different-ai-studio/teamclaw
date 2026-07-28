// Produce the deployable artifact: `.output/server/index.mjs` + `.output/public/`.
// The daemon zips the CONTENTS of `.output`, and FC runs `node server/index.mjs`.
//
// reveal.js is copied out of node_modules into `public/vendor/` so the deck
// never depends on a CDN at view time — FC's outbound network is not something
// we want a slide deck to rely on.
import { cp, mkdir, rm } from 'node:fs/promises'

await rm('.output', { recursive: true, force: true })
await mkdir('.output/server', { recursive: true })
await cp('public', '.output/public', { recursive: true })
await cp('node_modules/reveal.js/dist', '.output/public/vendor', { recursive: true })
await cp('server.mjs', '.output/server/index.mjs')

console.log('built .output/')
