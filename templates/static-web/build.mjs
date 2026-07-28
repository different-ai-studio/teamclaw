// Produce the deployable artifact: `.output/server/index.mjs` + `.output/public/`.
// The daemon zips the CONTENTS of `.output`, and FC runs `node server/index.mjs`.
import { cp, mkdir, rm } from 'node:fs/promises'

await rm('.output', { recursive: true, force: true })
await mkdir('.output/server', { recursive: true })
await cp('public', '.output/public', { recursive: true })
await cp('server.mjs', '.output/server/index.mjs')

console.log('built .output/')
