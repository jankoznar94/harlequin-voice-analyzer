#!/usr/bin/env node
/**
 * Regresní test: DEKÓDOVÁNÍ AUDIA MUSÍ MÍT PLNÉ PÁSMO.
 *
 * PROČ TAKOVÝ TEST EXISTUJE (reálná chyba, která se dostala až k uživateli):
 *
 *   Na telefonu uživatel nahrál 4:46 dlouhou nahrávku a aplikace mu napsala
 *   „Ring nelze měřit" s radou „nahrávej WAV nebo ve vysokém datovém toku".
 *   Nahrávka byla v pořádku (na počítači z ní vyšlo pásmo 4406 Hz a ring 94 %).
 *
 *   Příčina byla v dekódování: `decodeAudioData` na `AudioContext` je vázaný na
 *   zvukový HARDWARE. Když telefon běží na nízkém kmitočtu, dekóduje klidně na
 *   12 kHz. Pásmo 2–4 kHz, ze kterého se ring měří, je pak useknuté (naměřeno
 *   ~3747 Hz proti prahu 4100 Hz) a hláška to svedla na nahrávku.
 *
 *   Správně se dekóduje přes `OfflineAudioContext`, který na hardware vázaný
 *   není a vrátil vždy 48 kHz.
 *
 * Test hlídá DVĚ věci, protože samotné „použil Offline" nestačí:
 *   1) že se skutečně dekóduje přes OfflineAudioContext (ne přes AudioContext),
 *   2) že z toho vyjde POUŽITELNÉ pásmo — tedy že hláška „Ring nelze měřit"
 *      NEPŘIJDE. Kdyby se bod 1 splnil a pásmo zůstalo useknuté, test musí spadnout.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAppEnv, sleep } from './mock-app-env.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(DIR, '..', 'src', 'app.js');

/* ── 1. příprava: telefon běží na nízkém kmitočtu ────────────────────────
   AudioContext umí jen 12 kHz a jeho spektrum je useknuté na ~3,4 kHz.
   Kdyby se app.js vrátil k AudioContextu, pásmo propadne a test to pozná. */
const env = installAppEnv({
  audioSampleRate: 12000,
  audioCutoffHz: 3400,
  offlineSampleRate: 48000,
});

await import('file://' + APP + '?t=' + Date.now());
await sleep(30);

const pass = { n: 0 };
const fail = { n: 0 };
const check = (name, ok, detail = '') => {
  if (ok) pass.n++; else fail.n++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('\n═══ Dekódování: plné pásmo i na telefonu s nízkým kmitočtem ═══\n');

check('app.js se načetl bez chyby', env.errors.length === 0,
  env.errors.length ? String(env.errors[0] && env.errors[0].message) : '');

/* ── 2. prohnat soubor celou cestou ───────────────────────────────────── */

const BLOB = new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/wav' });
BLOB.name = 'nahravka.wav';
env.el('file-input').onchange({ target: { files: [BLOB], value: 'x' } });

for (let i = 0; i < 150 && !env.el('r-meta').textContent && !env.el('r-unusable').innerHTML; i++) {
  await sleep(100);
}
await sleep(120);

check('analýza doběhla bez neodchycené chyby', env.errors.length === 0,
  env.errors.length ? `${env.errors[0].name}: ${env.errors[0].message}` : '');

/* ── 3. kterou cestou se dekódovalo ───────────────────────────────────── */

check('dekódovalo se přes OfflineAudioContext', env.used.includes('offline'),
  `použité cesty: ${env.used.join(', ') || '(žádná)'}`);
check('AudioContext se k dekódování nepoužil', !env.used.includes('audiocontext'),
  `použité cesty: ${env.used.join(', ') || '(žádná)'}`);

/* ── 4. a hlavně: výsledek musí být POUŽITELNÝ ────────────────────────── */

const unusable = env.el('r-unusable').innerHTML || '';
check('nehlásí se „Ring nelze měřit"', !/Ring nelze změřit/.test(unusable),
  unusable ? unusable.replace(/<[^>]*>/g, '').slice(0, 90) : '(nehlášeno)');
check('výsledek se vyplnil (nezůstalo na „Hotovo")', /\d+ tón/.test(env.el('r-meta').textContent),
  env.el('r-meta').textContent || '(prázdné)');

// Kontrola, že test umí selhat: v simulaci nízkého kmitočtu MUSÍ AudioContext
// cestou dát useknuté pásmo. Ověřuje se na datech, ne na dojmu.
{
  const { analyze } = await import('../src/analysis.js');
  const { synth } = await import('./mock-app-env.mjs');
  const bad = analyze(synth(3.2, 12000, 3400), 12000, {});
  check('kontrola testu: nízký kmitočet by pásmo usekl', bad.band.valid === false,
    `mez pásma ${Math.round(bad.band.limit)} Hz, valid=${bad.band.valid}`);
  const good = analyze(synth(3.2, 48000), 48000, {});
  check('kontrola testu: 48 kHz dává plné pásmo', good.band.valid === true,
    `mez pásma ${Math.round(good.band.limit)} Hz`);
}

/* ── 5. pád OfflineAudioContextu nesmí aplikaci zabít ─────────────────── */

{
  const env2 = installAppEnv({
    audioSampleRate: 44100,
    offlineSampleRate: 48000,
    offlineThrows: true,
  });
  await import('file://' + APP + '?t2=' + Date.now());
  await sleep(30);
  const B2 = new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/wav' });
  B2.name = 'nahravka2.wav';
  env2.el('file-input').onchange({ target: { files: [B2], value: 'y' } });
  for (let i = 0; i < 150 && !env2.el('r-meta').textContent && !env2.el('r-unusable').innerHTML; i++) {
    await sleep(100);
  }
  await sleep(120);
  check('když OfflineAudioContext selže, použije se záložní cesta', env2.used.includes('audiocontext'),
    `použité cesty: ${env2.used.join(', ') || '(žádná)'}`);
  check('a výsledek se i tak vyplní', /\d+ tón/.test(env2.el('r-meta').textContent),
    env2.el('r-meta').textContent || '(prázdné)');
}

console.log(`\n${fail.n === 0 ? '✓' : '✗'} DEKÓDOVÁNÍ: ${pass.n} prošlo, ${fail.n} selhalo\n`);
process.exit(fail.n === 0 ? 0 : 1);
