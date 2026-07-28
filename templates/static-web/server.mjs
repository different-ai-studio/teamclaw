// Static file server for the deployed app.
//
// The build copies this to `.output/server/index.mjs` and the site to
// `.output/public/`, which is the artifact shape Alibaba FC runs:
// `node server/index.mjs`, listening on $PORT. Resolving `../public` relative
// to this file works both there and when running it straight from the repo.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)))
const PORT = Number(process.env.PORT || 9000)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Map a request path to a file inside ROOT, or null.
 *
 * Everything is resolved and then checked to still sit under ROOT, so `..`
 * segments and encoded traversal cannot escape the published directory.
 */
async function resolveFile(urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null
  }
  const candidate = resolve(join(ROOT, decoded))
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null
  try {
    const info = await stat(candidate)
    if (info.isDirectory()) {
      const index = join(candidate, 'index.html')
      await stat(index)
      return index
    }
    return candidate
  } catch {
    return null
  }
}

createServer(async (req, res) => {
  const file = (await resolveFile(req.url || '/')) ?? (await resolveFile('/index.html'))
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`Failed to read ${file}: ${err.message}`)
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on :${PORT}`)
})
