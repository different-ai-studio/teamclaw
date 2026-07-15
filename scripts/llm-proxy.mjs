#!/usr/bin/env node
/**
 * LLM Proxy Server
 * 
 * Proxies requests to OpenAI-compatible APIs while rewriting parameters
 * that are incompatible with certain models (e.g., gpt-5.x requires
 * max_completion_tokens instead of max_tokens).
 * 
 * Usage:
 *   node scripts/llm-proxy.mjs [--port PORT] [--target TARGET_URL]
 * 
 * Default:
 *   Port: 13142
 *   Target: (user-provided URL)
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const args = process.argv.slice(2);
const PORT = parseInt(args.find((_, i, a) => a[i - 1] === '--port') || '13142');
const TARGET = args.find((_, i, a) => a[i - 1] === '--target') || '';

const targetUrl = new URL(TARGET);

function rewriteRequestBody(body) {
  try {
    const data = JSON.parse(body);
    
    // Rewrite max_tokens -> max_completion_tokens for models that require it
    if (data.max_tokens !== undefined) {
      data.max_completion_tokens = data.max_tokens;
      delete data.max_tokens;
    }
    
    // Fix empty tool role content — Compass API rejects "tool role content cannot be empty"
    if (Array.isArray(data.messages)) {
      for (let i = 0; i < data.messages.length; i++) {
        const msg = data.messages[i];
        if (msg.role !== 'tool') continue;

        let empty = false;
        if (msg.content == null) {
          empty = true;
        } else if (typeof msg.content === 'string') {
          empty = msg.content.trim() === '';
        } else if (Array.isArray(msg.content)) {
          // content can be an array of parts like [{type:"text", text:"..."}]
          empty = msg.content.length === 0
            || msg.content.every(p => !p.text || (typeof p.text === 'string' && p.text.trim() === ''));
        }

        if (empty) {
          console.log(`[LLM Proxy] Fixing empty tool content at message[${i}], tool_call_id=${msg.tool_call_id}, original:`, JSON.stringify(msg.content));
          msg.content = '(empty)';
        }
      }
    }
    
    return JSON.stringify(data);
  } catch {
    return body;
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  
  req.on('data', chunk => {
    body += chunk;
  });
  
  req.on('end', () => {
    // Rewrite body for POST requests
    const finalBody = req.method === 'POST' ? rewriteRequestBody(body) : body;
    
    // Build target URL: proxy path appended to target base
    // e.g., /v1/chat/completions -> TARGET_BASE/v1/chat/completions
    // Since TARGET already includes /v1, strip /v1 from incoming path
    let incomingPath = req.url;
    if (incomingPath.startsWith('/v1/')) {
      incomingPath = incomingPath.slice(3); // keep leading /
    } else if (incomingPath === '/v1') {
      incomingPath = '';
    }
    
    // Append to target base path (e.g., /compass-api/v1)
    const basePath = targetUrl.pathname.replace(/\/$/, '');
    const fullPath = basePath + incomingPath;
    const proxyUrl = new URL(fullPath, TARGET);
    
    const options = {
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      path: proxyUrl.pathname + proxyUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: proxyUrl.hostname,
        'content-length': Buffer.byteLength(finalBody),
      },
    };
    
    const transport = proxyUrl.protocol === 'https:' ? https : http;
    
    const proxyReq = transport.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });
    
    proxyReq.on('error', (err) => {
      console.error(`[LLM Proxy] Error: ${err.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
    });
    
    proxyReq.write(finalBody);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[LLM Proxy] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[LLM Proxy] Proxying to ${TARGET}`);
  console.log(`[LLM Proxy] Rewriting max_tokens -> max_completion_tokens`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[LLM Proxy] Shutting down...');
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
