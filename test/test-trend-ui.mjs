#!/usr/bin/env node
/**
 * Test UI: hlásí aplikace POKLES ringu v PRŮBĚHU tónu?
 *
 * PROČ: křivka v grafu ukáže průběh, ale člověk, který se na graf neumí dívat,
 * potřebuje větu. Hlášení má tři stavy (žádné dlouhé tóny / drží / upadl)
 * a každý musí říct něco jiného — jinak je to placebo.
 *
 * Test jde SKUTEČNOU cestou soubor → dekódování → analýza → vykreslení
 * (jako `test-player-wiring.mjs` se sdíleným mockem prohlížeče), takže chytí
 * i to, co statická kontrola nevidí: že prvek v HTML existuje a že se do něj
 * opravdu zapíše.
 *
 * Zvuk dodává mock (`synth` v mock-app-env.mjs) — je to držený tón, takže
 * průběh ringu se z něj měří. `ring_trend_tones` proto musí být aspoň 1.
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

const env = installAppEnv({ audioSampleRate: 44100, offlineSampleRate: 48000 });
const { el, errors } = env;

await import('file://' + APP + '?t=' + Date.now());
await sleep(30);

console.log('\n═══ Hlášení průběhu ringu v UI (skutečný app.js) ═══\n');

check('init proběhl bez chyby', errors.length === 0,
  errors.length ? String(errors[0] && errors[0].message) : '');

const BLOB = new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/wav' });
BLOB.name = 'nahravka.wav';
el('file-input').onchange({ target: { files: [BLOB], value: 'x' } });

for (let i = 0; i < 120 && !el('r-meta').textContent; i++) await sleep(100);
await sleep(150);

check('analýza se dokončila bez neodchycené chyby', errors.length === 0,
  errors.length ? `${errors[0].name}: ${errors[0].message}` : '');

/* Dlaždice musí existovat v HTML — jinak se hlášení nemá kam zapsat a app.js
 * spadne na `$('k-trend')` (přesně ta chyba, kterou statická kontrola odhalí
 * jen u ID, která zná). */
const html = (await import('node:fs')).readFileSync(path.join(DIR, '..', 'index.html'), 'utf8');
check('dlaždice #k-trend je v index.html', html.includes('id="k-trend"'));
check('dlaždice má i popisek a vysvětlivku',
  html.includes('id="k-trend-s"') && html.includes('id="k-trend-d"'));

const v = el('k-trend').textContent;
const d = el('k-trend-d').textContent;   // setKpi píše přes textContent (bezpečně), ne innerHTML
check('dlaždice průběhu není prázdná', v !== '' && v !== undefined, `„${v}“`);
check('vysvětlivka není prázdná', d.length > 20, `${d.length} znaků`);

/* Tři stavy dlaždice: „drží“ / „N×“ / „—“. Každý musí být odlišitelný. */
const stav = v === 'drží' ? 'drzi' : v === '—' ? 'zadne' : /^\d+×$/.test(v) ? 'pokles' : 'neznámý';
check('stav dlaždice je jeden ze tří očekávaných', stav !== 'neznámý', `„${v}“ → ${stav}`);
if (stav === 'drzi') {
  check('„drží“ má vysvětlivku, že ring v průběhu neupadl', /neupadl|drží/i.test(d), d.slice(0, 70));
} else if (stav === 'pokles') {
  check('pokles má vysvětlivku s dB a tónem', /dB/.test(d) && /upadl/i.test(d), d.slice(0, 70));
} else {
  check('„—“ vysvětluje, proč se to nedá sledovat', /dlouh|0,6/.test(d), d.slice(0, 70));
}

/* Verdikt: NESMÍ hlásit pokles, který analýza nenašla (a naopak). */
const verdict = el('r-verdict').innerHTML;   // verdikt se skládá z HTML (tučné pasáže)
check('verdikt nehlásí pokles, když pro něj nejsou data',
  !(stav !== 'pokles' && /ring v průběhu upadl/i.test(verdict)), verdict.slice(0, 80));

/* Metadata musí pořád fungovat — dlaždice se nesmí přidat na úkor starých. */
check('výsledek se vyplnil (nezůstalo na „Hotovo“)', /\d+ tón/.test(el('r-meta').textContent),
  el('r-meta').textContent || '(prázdné)');

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
process.exit(fail ? 1 : 0);
