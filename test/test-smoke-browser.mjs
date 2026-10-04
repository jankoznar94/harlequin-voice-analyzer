#!/usr/bin/env node
/**
 * Smoke test aplikace v prohlížeči — načte se opravdu celá?
 *
 * Statické testy propojení čtou jen text souborů. Nechytí syntaktickou chybu,
 * nefunkční import ani to, že se `.wasm` přes http nestáhne. Tohle prožene
 * skutečný prohlížeč a vyčte výsledek z kontrola-smoke.html.
 *
 * Použití: node test/test-smoke-browser.mjs
 * (bez chromium-browser se přeskočí — ne každý stroj ho má)
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8147;

const haveChrome = spawnSync('which', ['chromium-browser'], { encoding: 'utf8' }).status === 0;
if (!haveChrome) {
  console.log('\n⏭  chromium-browser není k dispozici — smoke test přeskočen.\n');
  process.exit(0);
}

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

const server = spawn('node', ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

try {
  const r = spawnSync('chromium-browser', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    // WASM + pět modulů se musí stihnout stáhnout a spustit; krátký limit
    // test podřízne a vypadá to jako chyba aplikace
    '--virtual-time-budget=30000',
    '--dump-dom',
    `http://localhost:${PORT}/kontrola-smoke.html`,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });

  const dom = r.stdout || '';
  const m = dom.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/);
  const text = m ? m[1].replace(/<[^>]*>/g, '').trim() : '';

  console.log('\n═══ Aplikace se načte v prohlížeči ═══\n');

  ok('testovací stránka doběhla', text.includes('HOTOVO'),
    text.split('\n').slice(-3).join(' | ').slice(0, 160));

  for (const mod of ['analysis', 'charts', 'live', 'live-charts', 'dsp-backend', 'live-run']) {
    ok(`modul ${mod}.js se načte`, text.includes(`OK import ./src/${mod}.js`) ||
      text.includes(`OK import ./src/${mod}.js`));
  }
  ok('WASM jádro se stáhne a přeloží', text.includes('dsp.wasm stažen a přeložen'));
  ok('použije se WASM backend', /OK backend: wasm/.test(text));

  const f0 = text.match(/f0=([\d.]+) Hz, tón=(\w+)/);
  ok('živý rámec najde správnou výšku', f0 && Math.abs(+f0[1] - 440) < 2,
    f0 ? `${f0[1]} Hz, ${f0[2]}` : 'řádek chybí');

  ok('všechny prvky aplikace jsou v index.html', text.includes('OK všechny prvky jsou v index.html'));
  ok('žádné chyby v konzoli', text.includes('BEZ CHYB'),
    (text.match(/CHYBY[^\n]*/) || [''])[0]);
} finally {
  server.kill('SIGKILL');
}

console.log(`\n═══ SMOKE: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
