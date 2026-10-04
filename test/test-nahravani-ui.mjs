#!/usr/bin/env node
/**
 * Nahrávací lišta musí po kliku na „Nahrávat" zůstat VIDĚT.
 *
 * ⚠️ REGRESE, KTEROU UŽIVATEL VIDĚL JAKO „Nahrávat nedělá nic":
 * Lišta (#rec-bar) bývala uvnitř #panel-input a `startRecord()` panel skryl
 * — zmizela tedy i časomíra a tlačítko „Ukončit nahrávání", zatímco nahrávání
 * běželo dál. V DOM byl přitom prvek bez třídy `hidden`; schovával ho RODIČ.
 * Proto se test ptá na DVĚ věci: jestli je lišta bez třídy `hidden`, **a**
 * jestli nestojí uvnitř panelu, který se schovává.
 *
 * Používá SKUTEČNÝ `src/app.js` + sdílený mock prohlížeče (`mock-app-env.mjs`)
 * a skutečný `index.html` — statická kontrola tenhle typ chyby nevidí, protože
 * je ve STRUKTUŘE stránky, ne v propojení ID.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAppEnv, sleep } from './mock-app-env.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(root, 'src/app.js');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/* ══ 1. struktura: lišta nesmí být uvnitř schovávaného panelu ═══════════════ */

console.log('\n═══ 1. Struktura index.html ═══');
const iPanel = html.indexOf('id="panel-input"');
const iKonecPanelu = html.indexOf('</section>', iPanel);
const iBar = html.indexOf('id="rec-bar"');
const iAkce = html.indexOf('id="rec-actions"');

check('#panel-input i #rec-bar v HTML existují', iPanel > 0 && iBar > 0);
check('#rec-bar NELEŽÍ uvnitř #panel-input (jinak zmizí s panelem)',
  iBar > iKonecPanelu,
  `panel ${iPanel}–${iKonecPanelu}, rec-bar ${iBar}`);
check('#rec-actions JE uvnitř #panel-input (má se skrýt s panelem)',
  iAkce > iPanel && iAkce < iKonecPanelu, `rec-actions ${iAkce}`);
check('#panel-input má zavírací </section>', iKonecPanelu > iPanel);
{
  const o = (html.match(/<section\b/g) || []).length;
  const c = (html.match(/<\/section>/g) || []).length;
  check(`<section> je vyvážené (${o} otevřeno, ${c} zavřeno)`, o === c);
  const od = (html.match(/<div\b/g) || []).length;
  const zd = (html.match(/<\/div>/g) || []).length;
  check(`<div> je vyvážené (${od} otevřeno, ${zd} zavřeno)`, od === zd);
}

/* ══ 2. za běhu: skutečný app.js ══════════════════════════════════════════ */

const env = installAppEnv({ offlineSampleRate: 48000 });
await import('file://' + APP + '?nahravani=' + Date.now());
await sleep(60);

const el = (id) => document.getElementById(id);
const videt = (id) => !el(id).classList.contains('hidden');

console.log('\n═══ 2. Klik na „Nahrávat" (skutečný app.js) ═══');
el('btn-record').click();
await sleep(80);

check('lišta #rec-bar je VIDĚT',
  videt('rec-bar'), 'třídy: ' + [...(el('rec-bar').tridy || [])].join(' '));
check('akční tlačítka #rec-actions jsou SKRYTÁ', !videt('rec-actions'));
check('„Nahrávat" je zakázané (druhé klepnutí hlásilo falešnou chybu mikrofonu)',
  el('btn-record').disabled === true);
check('„Ukončit nahrávání" (#btn-stop) zůstává použitelné', el('btn-stop').disabled === false);
check('#panel-input je skrytý', !videt('panel-input'));

/* Tohle je jádro regrese: lišta není uvnitř schovaného panelu, takže ji
 * `display: none` rodiče neodnese. V prohlížeči to znamená nenulovou plochu. */
check('lišt u neodnese skrytý panel (stojí mimo #panel-input)', iBar > iKonecPanelu);

console.log('\n═══ 3. Ukončení nahrávání lištu zase schová ═══');
el('btn-stop').click();
await sleep(150);
check('po „Ukončit nahrávání" je lišta skrytá', !videt('rec-bar'));
check('„Nahrávat" je zase povolené', el('btn-record').disabled === false);

console.log(`\n═══ ${pass} prošlo, ${fail} selhalo ═══`);
if (fail) console.log('\nUI by v prohlížeči nechalo nahrávání bez možnosti ukončení.');
process.exitCode = fail ? 1 : 0;
