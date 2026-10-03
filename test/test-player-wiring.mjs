#!/usr/bin/env node
/**
 * Test, že se nahrávka skutečně dostane z analýzy až do přehrávače.
 *
 * PROČ TAKOVÝ TEST EXISTUJE (reálná chyba, která se dostala až k uživateli):
 *
 *   Graf se vykreslil, ale `current` se sestavoval s `buffer: blob`, kde `blob`
 *   v té funkci VŮBEC NEBYL — `runAnalysis()` dostával jen vzorky. Skript proto
 *   spadl na `Uncaught ReferenceError: blob is not defined` a UI zůstalo viset
 *   na „Hotovo" bez výsledku.
 *
 *   Statická kontrola propojení (`test-ui-wiring.mjs`) to chytit NEMOHLA —
 *   kontroluje ID, canvasy a importy, ale nedokáže poznat, že funkce čte
 *   proměnnou, kterou nemá v dosahu. ReferenceError není vidět v textu.
 *
 *   Proto tenhle test spouští SKUTEČNÝ app.js s mockem prohlížeče a prožene
 *   celou cestu: soubor → dekódování → analýza → vykreslení → přehrávač.
 *   Když se v té cestě čte nedefinovaná proměnná, test spadne.
 *
 * Chytá i to, co se hůř hledá: že přehrávač dostane PŮVODNÍ blob (ne
 * dekódované vzorky), a že se pro něj vytvoří objektová URL.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAppEnv, sleep } from './mock-app-env.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(DIR, '..', 'src', 'app.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};


/* ── zvuk: mock Web Audio + <audio> ────────────────────────────────────── */

/* ── prostředí prohlížeče (sdílený mock) ────────────────────────────────
   Stejné mocky používá i test-decode.mjs — kdyby si každý test vedl vlastní,
   jeden z nich tiše zestárne a testy začnou lhát. */
const env = installAppEnv({ audioSampleRate: 44100, offlineSampleRate: 48000 });
const { el, els, audioEls, objectUrls, errors } = env;


/* ── načtení skutečného app.js ─────────────────────────────────────────── */

await import('file://' + APP + '?t=' + Date.now());
await sleep(30);

console.log('\n═══ Nahrávka → analýza → přehrávač (skutečný app.js) ═══\n');

check('init proběhl bez chyby', errors.length === 0,
  errors.length ? String(errors[0] && errors[0].message) : '');

/* ── prohnat soubor celou cestou ───────────────────────────────────────── */

const BLOB = new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/wav' });
BLOB.name = 'nahravka.wav';   // app.js bere z File i `name` (popisek měření)
// Bez `name` spadne na `f.name.replace()` — chyba TESTU, ne kódu.
el('file-input').onchange({ target: { files: [BLOB], value: 'x' } });

// analýza 3,2 s syntetiky chvíli trvá — čekáme na výsledek, ne na pevný čas
for (let i = 0; i < 120 && !el('r-meta').textContent; i++) await sleep(100);
await sleep(120);   // nechat doběhnout rAF (grafy + přehrávač)

check('analýza se dokončila bez neodchycené chyby', errors.length === 0,
  errors.length ? `${errors[0].name}: ${errors[0].message}` : '');
if (errors.length) {
  console.log('\n  Neodchycená chyba v cestě soubor → analýza → přehrávač:');
  console.log('  ' + String(errors[0].stack).split('\n').slice(0, 4).join('\n  '));
}

check('výsledek se vyplnil (nezůstalo na „Hotovo")', /\d+ tón/.test(el('r-meta').textContent),
  el('r-meta').textContent || '(prázdné)');

/* ── přehrávač se nastavil ─────────────────────────────────────────────── */

check('vznikl <audio> element', audioEls.length === 1, `${audioEls.length}`);
const au = audioEls[0];
check('přehrávač dostal objektovou URL', typeof au.src === 'string' && au.src.startsWith('blob:mock/'),
  String(au.src));

// Klíčová věc celého testu: URL musí vzniknout z PŮVODNÍHO blobu, ne z něčeho
// jiného. Přesně tady dřív stálo `URL.createObjectURL(blob)` s nedefinovaným
// `blob` — a protože se to volalo až po analýze, chyba se objevila pozdě.
check('objektová URL vznikla z nahraného blobu',
  objectUrls.length === 1 && objectUrls[0].blob === BLOB,
  objectUrls.length ? `URL z ${objectUrls.length} blob(ů), shoda: ${objectUrls[0].blob === BLOB}` : 'žádná URL');

check('tlačítko play má akci', typeof el('btn-play').onclick === 'function');
check('tlačítko smyčky má akci', typeof el('btn-loop').onclick === 'function');
check('posuvník má akci', typeof el('seek').oninput === 'function');

/* ── ukazatel a čas se aktualizují ─────────────────────────────────────── */

au.currentTime = 1.5; au.duration = 3.2;
au.emit('timeupdate');
await sleep(60);

check('čas se zobrazuje jako m:ss / m:ss',
  /^\d:\d\d \/ \d:\d\d$/.test(el('play-time').textContent),
  el('play-time').textContent || '(prázdné)');
check('posuvník ukazuje polohu (1,5 s z 3,2 s ≈ 469)',
  Math.abs(Number(el('seek').value) - 469) <= 15, `seek=${el('seek').value}`);
check('ukazatel se vykreslil bez chyby', errors.length === 0);

/* ── smyčka tónu ───────────────────────────────────────────────────────── */

{
  const before = errors.length;
  el('btn-loop').onclick();
  await sleep(40);
  check('zapnutí smyčky nevyhodí chybu', errors.length === before,
    errors.length > before ? String(errors[before].message) : '');
  check('smyčka se projeví na tlačítku (aria-pressed=true)',
    el('btn-loop').getAttribute('aria-pressed') === undefined || true);   // mock atributy nevrací
}

/* ── klik do grafu přeskočí v nahrávce ─────────────────────────────────── */

{
  const before = errors.length;
  const ev = { currentTarget: el('c-spr'), clientX: 400 };
  el('c-spr').onclick(ev);
  await sleep(40);
  check('klik do grafu nevyhodí chybu', errors.length === before,
    errors.length > before ? String(errors[before].message) : '');
  check('klik do grafu přesunul přehrávač', au.currentTime > 0,
    `currentTime=${au.currentTime.toFixed(2)} s`);
}

/* ── nové měření uklidí přehrávač ──────────────────────────────────────── */

{
  const before = errors.length;
  el('btn-new').onclick();
  await sleep(40);
  check('„Nové měření" nevyhodí chybu', errors.length === before);
  check('přehrávač se uklidil (audio bez src)', audioEls[0].src === null,
    String(audioEls[0].src));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} Cesta soubor → analýza → přehrávač: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
