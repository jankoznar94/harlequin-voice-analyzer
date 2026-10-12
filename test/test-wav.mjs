#!/usr/bin/env node
/**
 * Uložení nahrávky jako zvukového souboru (WAV) — `src/wav.js`.
 *
 * PROČ: uživatel nahrává přímo v aplikaci a soubor se nikdy nedostane ven
 * (prohlížeč ho drží v paměti) — nemůže nahrávku poslat ani archivovat.
 * Uložený soubor musí být PŘESNĚ to, co se analyzovalo, a hlavně formát, který
 * aplikace umí i PŘEČÍST (jinak si vyrobí soubor, který sama odmítne — ta past
 * se v tomhle projektu už jednou řešila u webm/opus).
 *
 * Test hlídá hlavičku, převod vzorků (včetně mezí a NaN) a jméno souboru.
 * Že soubor jde PŘEČÍST, ověřuje prohlížeč: `tools/check-wav-export-browser.mjs`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const mod = await import('file://' + path.join(DIR, '..', 'src', 'wav.js') + '?t=' + Date.now());
const { encodeWav, wavFileName } = mod;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('\n═══ Uložení nahrávky jako WAV ═══\n');

const SR = 48000, N = 4800;                     // 0,1 s
const s = new Float64Array(N);
for (let i = 0; i < N; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
const wav = encodeWav(s, SR);

const str = (off, len) => String.fromCharCode(...wav.slice(off, off + len));
const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

/* ── 1. Hlavička ──────────────────────────────────────────────────────── */
check('začíná RIFF/WAVE', str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE');
check('blok fmt je PCM', str(12, 4) === 'fmt ' && view.getUint16(20, true) === 1);
check('mono', view.getUint16(22, true) === 1);
check('vzorkovací kmitočet sedí', view.getUint32(24, true) === SR, `${view.getUint32(24, true)} Hz`);
check('16 bitů na vzorek', view.getUint16(34, true) === 16);
check('blok data je označený', str(36, 4) === 'data');
check('délka dat = 2 B na vzorek', view.getUint32(40, true) === N * 2, `${view.getUint32(40, true)} B`);
check('velikost souboru v RIFF sedí', view.getUint32(4, true) === wav.length - 8);
check('celková velikost = 44 + data', wav.length === 44 + N * 2, `${wav.length} B`);
check('bajtů za sekundu = SR × 2', view.getUint32(28, true) === SR * 2);

/* ── 2. Vzorky: sinusovka musí zůstat sinusovka ───────────────────────── */
let maxErr = 0;
for (let i = 0; i < N; i++) {
  const got = view.getInt16(44 + i * 2, true) / 32767;
  maxErr = Math.max(maxErr, Math.abs(got - s[i]));
}
check('vzorky se vrátí (±1 LSB)', maxErr <= 1.5 / 32767, `max chyba ${maxErr.toExponential(1)}`);

/* ── 3. Meze a nesmysly ───────────────────────────────────────────────── */
const edge = encodeWav(new Float64Array([1, -1, 0, 2, -2, NaN]), SR);
const ev = new DataView(edge.buffer, edge.byteOffset, edge.byteLength);
const at = (i) => ev.getInt16(44 + i * 2, true);
check('+1 → 32767 (nesmí přetéct)', at(0) === 32767, `${at(0)}`);
check('−1 → −32767', at(1) === -32767, `${at(1)}`);
check('0 → 0', at(2) === 0);
check('nad rozsah se ořeže', at(3) === 32767 && at(4) === -32767);
check('NaN → ticho, ne odpad', at(5) === 0, `${at(5)}`);

/* ── 4. Prázdný vstup a nesmyslný kmitočet nesmí spadnout ─────────────── */
const empty = encodeWav(new Float64Array(0), SR);
check('prázdný vstup = platná hlavička', empty.length === 44 && str(0, 4) === 'RIFF');
const noRate = encodeWav(new Float64Array([0.1]), 0);
check('nulový kmitočet → 48 kHz (ne NaN)', new DataView(noRate.buffer).getUint32(24, true) === 48000);
check('bez vzorků nespadne', encodeWav(undefined, SR).length === 44);

/* ── 5. Jméno souboru ─────────────────────────────────────────────────── */
const name = wavFileName(new Date(2026, 9, 12, 9, 5));
check('jméno s časem měření', name === 'nahravka-2026-10-12-0905.wav', name);
check('koncovka .wav', name.endsWith('.wav'));

console.log(`\n${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
