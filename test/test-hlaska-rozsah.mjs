#!/usr/bin/env node
/**
 * Hláška u nuly tónů musí rozlišit „tóny leží mimo zvolený rozsah" od
 * „v nahrávce žádný zpěv není".
 *
 * PROČ (reálná vada, kterou uživatel viděl): nahrál NIŽŠÍ tóny a dostal
 * „V nahrávce nejsou žádné zpívané tóny … bývá to řeč, šum, doprovod bez
 * zpěvu, nebo nahrávka kratší než ~2 s". Analýza přitom tón NAŠLA a jen ho
 * vyřadila jako „G2 mimo tenor". Naměřeno v prohlížeči na tónu G2 (98 Hz,
 * −8 dBFS): rozsah Tenor → 0 tónů a tahle hláška; rozsah Baryton → 1 tón
 * a plný výsledek. Člověk pak hledá vadu v mikrofonu nebo v hlase, kterou
 * nemá — a stačilo přepnout rozsah.
 *
 * Je to táž chyba jako dřív u hlášky o WAV: text tvrdil příčinu, kterou kód neznal.
 *
 * Test spouští SKUTEČNÝ app.js (jako `test-player-wiring.mjs`) — `unusableText`
 * není exportovaná, takže se musí prohnat celou cestou soubor → analýza → UI.
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

console.log('\n═══ Hláška u nuly tónů: rozsah vs. „žádný zpěv" ═══\n');

/* ⚠️ Mock `decodeAudioData` vrací POŘÁD stejnou syntetiku (3,2 s, 44100 Hz),
 * takže se do něj nízký tón podstrčit nedá — a bez nízkého tónu by test
 * nezkoušel to, kvůli čemu existuje. Vlastní `OfflineAudioContext` se proto
 * instaluje PŘED načtením app.js: app.js si ho vezme z `window` při dekódování.
 * (`synth()` z mocku se zahodí — nahrazuje se celá cesta.) */
/* Nízký držený tón s harmonickou řadou — G2 = 98 Hz leží MIMO tenor (123–660). */
function makeLowTone(sr, dur, f0) {
  const n = Math.round(sr * dur);
  const x = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * f0 / sr;
    let v = 0;
    for (let h = 1; h * f0 < 5000; h++) v += Math.sin(h * ph) / Math.sqrt(h);
    /* Náběh a dokmit, ať tón není useknutý (useknutý okraj kazí segmentaci). */
    const env2 = Math.min(1, i / (0.1 * sr)) * Math.min(1, (n - i) / (0.1 * sr));
    x[i] = 0.22 * v * env2;
  }
  return x;
}

/* Ticho — pro regresní kontrolu, že nová větev nepřebije hlášku o tichu. */
const SILENCE = new Float64Array(48000 * 2);

let nextSamples = null;      // co má příští dekódování vrátit
const MockOffline = class {
  constructor(ch, len, rate) { this.sampleRate = rate; }
  async decodeAudioData() {
    const data = nextSamples || SILENCE;
    return { numberOfChannels: 1, length: data.length, sampleRate: 48000, getChannelData: () => data };
  }
};
globalThis.window.OfflineAudioContext = MockOffline;

await import('file://' + APP + '?t=' + Date.now());
await sleep(30);

check('init proběhl bez chyby', errors.length === 0,
  errors.length ? String(errors[0] && errors[0].message) : '');

/* Rozsah nastavit PŘED analýzou — přesně jako by ho uživatel přepnul. */
function setFach(v) {
  const s = el('fach');
  s.value = v;
  if (s.onchange) s.onchange();
}

async function runFile(samples, fach) {
  setFach(fach);
  nextSamples = samples;
  const BLOB = new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/wav' });
  BLOB.name = 'nizky-ton.wav';
  el('r-meta').textContent = '';
  el('file-input').onchange({ target: { files: [BLOB], value: 'x' } });
  for (let i = 0; i < 150 && !el('r-meta').textContent; i++) await sleep(100);
  await sleep(80);
  return el('r-unusable').innerHTML + '\u0000' + el('r-meta').textContent;
}

const low = makeLowTone(48000, 4, 98);

/* 1. Nízký tón na TENORU → hláška musí mluvit o ROZSAHU, ne o šumu. */
const naTenoru = await runFile(low, 'tenor');
const [htmlT, metaT] = naTenoru.split('\u0000');
check('nízký tón na tenoru → hláška o rozsahu',
  /mimo zvolený rozsah/i.test(htmlT), htmlT.slice(0, 90) || '(prázdné)');
check('hláška neposílá hledat vadu v mikrofonu/nahrávce',
  !/bývá to řeč, šum, doprovod bez zpěvu/i.test(htmlT));
check('hláška pojmenuje, které tóny to byly (G2)',
  /G2/.test(htmlT), (htmlT.match(/\(([^)]*)\)/) || [])[0] || '—');
check('hláška poradí přepnout rozsah nahrávky',
  /Rozsah nahrávky/i.test(htmlT) && /Baryton|Bas/i.test(htmlT));
check('hláška uvede, jaký rozsah tóny vyřadil (tenor, Hz)',
  /tenor/i.test(htmlT) && /123[–-]660 Hz/.test(htmlT), htmlT.match(/\((\d+[–-]\d+ Hz)\)/)?.[0] || '—');
check('v metadatech je vidět, že se tón našel a vyřadil (ne 0 nalezených)',
  /0 tónů/.test(metaT) && /1 vyřazeno/.test(metaT), metaT);

/* 2. Týž tón na BARYTONU → musí projít a výsledek se ukázat. */
const naBarytonu = await runFile(low, 'baryton');
const [htmlB, metaB] = naBarytonu.split('\u0000');
check('týž tón na barytonu → projde (1 tón, 0 vyřazeno)',
  /1 tón/.test(metaB) && /0 vyřazeno/.test(metaB), metaB);
/* Na barytonu: hláška se nesmí ZOBRAZIT. POZOR — app.js starý text v prvku
 * nechává (jen ho schová), takže se NESMÍ číst `innerHTML`; ten obsahuje
 * text z předchozího běhu a test by hlásil chybu, kterou kód nemá.
 * Rozhoduje `hidden` na `#r-unusable`. */
check('na barytonu se hláška o rozsahu NEZOBRAZÍ',
  el('r-unusable').classList.contains('hidden'),
  'r-unusable hidden=' + el('r-unusable').classList.contains('hidden'));
check('na barytonu se ukáže plný výsledek (r-body viditelné)',
  !el('r-body').classList.contains('hidden'));

/* 3. Ticho → musí zůstat hláška o tichu (regrese: nová větev ji nesmí přebít). */
const ticho = await runFile(new Float64Array(48000 * 2), 'tenor');
const [htmlTicho, metaTicho] = ticho.split('\u0000');
check('ticho → hláška o tichu, ne o rozsahu',
  /je ticho/i.test(htmlTicho) && !/mimo zvolený rozsah/i.test(htmlTicho),
  htmlTicho.slice(0, 60) || '(prázdné)');
check('ticho → 0 tónů v metadatech', /0 tónů/.test(metaTicho), metaTicho);

check('celá cesta bez neodchycené chyby', errors.length === 0,
  errors.length ? `${errors[0].name}: ${errors[0].message}` : '');

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
process.exit(fail ? 1 : 0);
