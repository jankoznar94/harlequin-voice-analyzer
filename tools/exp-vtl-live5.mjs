#!/usr/bin/env node
/**
 * EXPERIMENT 5: ŽIVÝ VTL — přesnost proti ZNÁMÉ PRAVDĚ a výtěžnost na nahrávce.
 *
 * Předchozí běhy ukázaly, že krátké okno dá totéž co offline tón, ALE jen
 * u tónů, kde i offline projde fyziologickým filtrem — a těch je na nahrávce
 * málo, takže chybí reference. Proto se tady přesnost měří tam, kde pravda
 * ZNÁMÁ je (syntetický držený tón s předepsaným traktem) a na nahrávce se měří
 * jen VÝTĚŽNOST (u kolika tónů by se vůbec nějaké číslo ukázalo).
 *
 * DŮLEŽITÉ: bere se jen F1–F3, přesně jako `delkaTraktu` v aplikaci. Když se
 * do rozestupu přidají i vyšší formanty, vyjde jiné (a špatné) číslo.
 *
 * Použití: node tools/exp-vtl-live5.mjs [soubor.wav]
 */
import fs from 'node:fs';
import { analyze, formantsAt } from '../src/analysis.js';

const SR = 48000;
const PRAVDA_F = [500, 1500, 2500];
const PHY = (d) => d >= 780 && d <= 1429;
const D3 = (F) => {
  const v = F.slice(0, 3).filter(x => x === x && x > 0);
  if (v.length < 2) return NaN;
  const r = [];
  for (let i = 1; i < v.length; i++) r.push(v[i] - v[i - 1]);
  return r.reduce((a, b) => a + b, 0) / r.length;
};
const VTL = (F) => 34300 / (2 * D3(F));
const med = (v) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s.length & 1 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2; };
const PRAVDA = 34300 / (2 * 1000);

/* ── A) PŘESNOST PROTI ZNÁMÉ PRAVDĚ (syntetika) ───────────────────────────── */
const traktGain = (f) => {
  const r = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
  return r(500, 120, 1.0) + r(1500, 180, 0.45) + r(2500, 220, 0.30) + r(3000, 250, 0.22) + r(3500, 300, 0.10);
};
function ton(f0, sek = 3.0, vib = 0) {
  const n = Math.round(sek * SR);
  const o = new Float64Array(n);
  let fi = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = vib ? f0 * Math.pow(2, (vib / 100) * Math.sin(2 * Math.PI * 5.5 * t) / 12) : f0;
    fi += 2 * Math.PI * f / SR;
    let s = 0;
    for (let h = 1; h * f0 < 6000; h++) s += traktGain(h * f0) / h * Math.sin(h * fi);
    o[i] = 0.25 * s * Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
  }
  return o;
}
console.log(`\n══ A) PŘESNOST PROTI ZNÁMÉ PRAVDĚ (syntetický držený tón, VTL = ${PRAVDA.toFixed(2)} cm) ══`);
console.log('   berou se JEN F1–F3 (jako v aplikaci); číslo = medián přes poslední 1 s držení');
console.log('   f0     vibrato   okno     projde filtr   VTL (medián)   |chyba|');

for (const wS of [4096, 8192, 16384]) {
  const chyby = [];
  for (const f0 of [110, 131, 147, 175, 196, 220, 247, 262]) {
    for (const vib of [0, 5]) {
      const s = ton(f0, 3.0, vib);
      const i0 = Math.round(1.0 * SR), i1 = Math.round(2.5 * SR);
      const hop = Math.round(0.010 * SR);
      const vals = [];
      let celkem = 0;
      for (let end = i0 + wS; end <= i1; end += hop) {
        celkem++;
        const F = formantsAt(s, SR, end - wS, end);
        if (PHY(D3(F))) vals.push(VTL(F));
      }
      const m = vals.length >= 5 ? med(vals) : NaN;
      if (m === m) { chyby.push(Math.abs(m - PRAVDA)); }
      console.log(`   ${String(f0).padStart(4)} ${String(vib ? '5 %' : '—').padStart(9)} ${String(Math.round(wS / SR * 1000) + ' ms').padStart(7)}   ` +
        `${String(`${vals.length}/${celkem}`).padStart(11)}   ${(m === m ? m.toFixed(2) + ' cm' : '—').padStart(12)}   ${(m === m ? Math.abs(m - PRAVDA).toFixed(2) + ' cm' : '—').padStart(9)}`);
    }
  }
  const a = chyby.sort((x, y) => x - y);
  console.log(`   → okno ${Math.round(wS / SR * 1000)} ms: |chyba| medián ${a.length ? a[a.length >> 1].toFixed(2) : '—'} cm, max ${a.length ? a[a.length - 1].toFixed(2) : '—'} cm  (n=${chyby.length})\n`);
}

/* ── B) VÝTĚŽNOST NA REÁLNÉ NAHRÁVCE ──────────────────────────────────────── */
function loadWav(p) {
  const b = fs.readFileSync(p);
  let o = 12, fmt = null, dOff = 0, dLen = 0;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4);
    const sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') { dOff = o + 8; dLen = sz; }
    o += 8 + sz + (sz & 1);
  }
  const by = fmt.bits / 8;
  const n = Math.floor(Math.min(dLen, b.length - dOff) / (by * fmt.ch));
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = fmt.bits === 16 ? b.readInt16LE(dOff + i * by * fmt.ch) / 32768 : b.readFloatLE(dOff + i * by * fmt.ch);
  return { samples: s, sampleRate: fmt.sr };
}

const wav = process.argv.find(a => a.endsWith('.wav')) || process.env.HOME + '/.cache/vaud-test/zpev.wav';
const { samples, sampleRate } = loadWav(wav);
const res = analyze(samples, sampleRate, { fach: 'tenor' });
const noty = res.notes.filter(n => n.dur >= 0.8);
console.log(`══ B) VÝTĚŽNOST NA NAHRÁVCE (${wav.split('/').pop()}, dur >= 0,8 s) ══`);
console.log(`   offline: ${res.notes.length} tónů, VTL ${res.summary.vtl_cm.toFixed(1)} cm z ${res.summary.vtl_n} tónů ` +
  `(tj. ${(100 * res.summary.vtl_n / res.summary.vtl_z_tonek).toFixed(0)} % tónů projde filtrem)`);

for (const wS of [4096, 8192, 16384]) {
  const hop = Math.round(0.010 * sampleRate);
  let tonuSCislem = 0, souhlas = 0, nesouhlas = 0, chyby = [];
  for (const n of noty) {
    const i0 = Math.round(n.t_start * sampleRate), i1 = Math.round(n.t_end * sampleRate);
    const vals = [];
    for (let end = i0 + wS; end <= i1; end += hop) {
      const F = formantsAt(samples, sampleRate, end - wS, end);
      if (PHY(D3(F))) vals.push(VTL(F));
    }
    if (vals.length >= 5) {
      tonuSCislem++;
      const m = med(vals);
      const dOff = D3([n.f1, n.f2, n.f3]);
      if (PHY(dOff)) { souhlas++; chyby.push(Math.abs(m - 34300 / (2 * dOff))); }
      else nesouhlas++;
    }
  }
  const ch = chyby.sort((x, y) => x - y);
  console.log(`   okno ${String(Math.round(wS / sampleRate * 1000) + ' ms').padStart(6)}: ` +
    `číslo by se ukázalo u ${tonuSCislem}/${noty.length} tónů  ` +
    `(z toho ${souhlas} tónů mělo i offline fyziologický dF, shoda |chyba| medián ${ch.length ? ch[ch.length >> 1].toFixed(2) : '—'} cm; ` +
    `${nesouhlas} tónů offline filtrem neprošlo)`);
}
console.log();
