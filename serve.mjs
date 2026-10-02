#!/usr/bin/env node
/**
 * Jednoduchý statický server pro lokální vývoj a testování.
 * Service worker vyžaduje http(s), ne file:// — proto tohle.
 *
 * Použití:  node serve.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  // zabraň path traversal
  const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('403'); return; }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — ' + p);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // service worker potřebuje správný scope
      'Cache-Control': 'no-cache',
      // mikrofon vyžaduje secure context (localhost je považován za bezpečný)
      'Permissions-Policy': 'microphone=(self)',
    });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Analýza zpěvního hlasu běží na http://localhost:${port}/`);
  console.log('(mikrofon vyžaduje localhost nebo https — obojí je v pořádku)');
});
