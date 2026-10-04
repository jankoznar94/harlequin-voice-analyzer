#!/usr/bin/env node
/**
 * Ověření v REÁLNÉM prohlížeči: objeví se na obrazovce OBĚ čísla SPR?
 *
 * Statické testy propojení vidí jen to, že prvek existuje a že se v kódu čte
 * `spr_novy_median`. Nevidí, jestli se text skutečně vykreslí — a přesně tenhle
 * druh chyby (kód čte proměnnou, kterou nedostane, nebo ji dostane jako null)
 * se v této aplikaci už jednou dostal až k uživateli.
 *
 * Postup: headless Chromium přes CDP, do stránky se podstrčí WAV soubor přes
 * DataTransfer, spustí se analýza a přečte se SKUTEČNÝ text z dlaždice
 * „Síla hlasu" plus řádek v textovém reportu.
 *
 * Použití: node tools/check-novy-ring-browser.mjs [soubor.wav] [port]
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FILE = process.argv[2] || `${process.env.HOME}/.cache/vaud-test/zpev.wav`;
const PORT = Number(process.argv[3] || 8791);
const CHROME = process.env.CHROME || 'chromium-browser';
const PROFILE = path.join(process.env.HOME, '.cache', 'va-chrome-novy-ring');

if (!existsSync(FILE)) { console.error(`chybí soubor ${FILE}`); process.exit(2); }

/** Celý WAV soubor → base64. POZOR: musí se posílat CELÝ soubor včetně RIFF
 *  hlavičky — když se pošle jen `data` chunk, `decodeAudioData` ho odmítne
 *  (přesně na to jsem napoprvé naletěl a vypadalo to jako chyba aplikace). */
function wavBase64(p) {
  return readFileSync(p).toString('base64');
}

/** Rychlá kontrola, že soubor je WAV s 16bit PCM — bez toho by se chyba hledala
 *  v aplikaci, i když je v datech. */
function wavInfo(p) {
  const b = readFileSync(p);
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data') break;
    off = body + sz + (sz & 1);
  }
  return fmt;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

let ws = null, id = 0;
const pending = new Map();

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* ještě neběží */ }
    await sleep(250);
  }
  throw new Error('Chromium se nepřihlásil.\n' + chromeErr.slice(-600));
}

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}

const dialogs = [];
(async () => {
  const url = await target();
  ws = new WebSocket(url);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    /* alert() v prohlížeči blokuje Runtime.evaluate — musí se odklikat hned. */
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message);
      send('Page.handleJavaScriptDialog', { accept: true });
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  const port = process.env.PORT_SRV || 8123;
  await send('Page.navigate', { url: `http://localhost:${port}/index.html` });
  await sleep(2500);

  /* Odchytit chyby a alerty ve stránce — bez toho se „nepodařilo přečíst"
   * nedá rozlišit od chyby v testu samotném (přesně to se stalo napoprvé). */
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__err = []; window.__dialogs = [];
      window.addEventListener('error', e => window.__err.push(String(e.message)));
      window.alert = m => window.__dialogs.push(String(m));
      return 'ok';
    })()`,
    returnByValue: true,
  });

  /* Servisní worker drží staré assety i po změně souboru — bez odregistrování
   * by měření mlčky běželo proti starému kódu. */
  await send('Runtime.evaluate', { expression: `(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(rs.map(x => x.unregister()));
    const caches_ = await caches.keys();
    await Promise.all(caches_.map(k => caches.delete(k)));
    return 'ok';
  })()`, awaitPromise: true });

  const b64 = wavBase64(FILE);
  console.log(`soubor ${FILE.split('/').pop()} (${Math.round(b64.length * 0.75 / 1024)} kB)`);

  const inject = `(async () => {
    const B64 = ${JSON.stringify(b64)};
    const bin = atob(B64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'test.wav', { type: 'audio/wav' }));
    const inp = document.getElementById('file-input');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'posláno';
  })()`;
  const inj = await send('Runtime.evaluate', { expression: inject, awaitPromise: true });
  if (inj.exceptionDetails) throw new Error('vložení souboru: ' + JSON.stringify(inj.exceptionDetails));

  /* Analýza 73s nahrávky trvá ~2,5 s; čeká se na hotový výsledek, ne na čas. */
  let text = '';
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const res = document.getElementById('panel-result');
        const prog = document.getElementById('prog-text');
        return {
          hotovo: !!res && !res.classList.contains('hidden'),
          prog: prog ? prog.textContent.trim() : '',
          value: (document.getElementById('k-level')?.textContent || '').trim(),
          sub: (document.getElementById('k-level-s')?.textContent || '').trim(),
          det: (document.getElementById('k-level-d')?.textContent || '').trim(),
          meta: (document.getElementById('r-meta')?.textContent || '').trim(),
        };
      })()`,
      returnByValue: true,
    });
    const v = r.result?.value;
    if (v?.hotovo) { text = JSON.stringify(v, null, 1); break; }
    if (i % 10 === 9) {
      const dbg = await send('Runtime.evaluate', {
        expression: `JSON.stringify({ err: window.__err, dlg: window.__dialogs })`,
        returnByValue: true,
      });
      console.log(`  … ${v?.prog || 'čekám'}  [${dbg.result?.value || ''}]`);
    }
  }
  if (!text) throw new Error('analýza nedoběhla do 120 s' + (dialogs.length ? ' — dialogy: ' + dialogs.join(' | ') : ''));

  /* Textový report se NESTAVÍ do stránky — `btn-md` rovnou stahuje soubor.
   * Zachytí se proto URL.createObjectURL a přečte se, co by se stáhlo. */
  const rep = await send('Runtime.evaluate', {
    expression: `(async () => {
      /* Blob se zachytí přes createObjectURL. POZOR: ten vrátí blob URL, ne
       * objekt Blobu — číst ho z výsledku CDP nelze. Proto se text vyzvedne
       * ještě VE stránce a ven jde jen řádek. */
      const origCreate = URL.createObjectURL;
      let blob = null;
      URL.createObjectURL = (b) => { blob = b; return origCreate.call(URL, b); };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { /* stahování nezajímat */ };
      document.getElementById('btn-md').click();
      HTMLAnchorElement.prototype.click = origClick;
      URL.createObjectURL = origCreate;
      if (!blob) return '(report se nevyrobil)';
      const t = typeof blob.text === 'function' ? await blob.text() : String(blob);
      return t.split('\\n').filter(l => /SPR|Síla hlasu|percentil/.test(l)).join('\\n');
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  console.log('\n--- dlaždice „Síla hlasu" ---');
  console.log(text);
  console.log('\n--- řádky reportu se SPR ---');
  console.log(rep.result?.value || '(report se nepodařilo přečíst)');
  if (dialogs.length) console.log('\ndialogy: ' + dialogs.join(' | '));

  const ok = /přesné číslo/i.test(text) && /Přesné SPR/i.test(rep.result?.value || '');
  console.log('\n' + (ok ? '✓ OBĚ čísla jsou v UI i v reportu' : '✗ nové číslo se v UI NEobjevilo'));

  ws.close();
  chrome.kill('SIGTERM');
  await sleep(300);
  chrome.kill('SIGKILL');
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  console.error('CHYBA: ' + e.message);
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  process.exit(1);
});
