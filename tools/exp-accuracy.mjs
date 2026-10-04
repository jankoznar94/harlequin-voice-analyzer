#!/usr/bin/env node
/**
 * EXPERIMENT: kde přesně šumí SPR a FHE a co s tím udělá průměr více metod.
 *
 * Motivace (Jan): „měření ještě není úplně přesné, dá se použít víc metod a
 * udělat průměr?"
 *
 * Co se měří:
 *  1) ŠUM JEDNOTLIVÝCH METOD — každý tón se změří DVAKRÁT (první a druhá
 *     polovina úseku) a spočítá se, jak moc se obě čísla rozejdou. Metoda,
 *     která se sama se sebou rozchází, nemůže být přesná, ať vypadá jakkoli.
 *  2) ŠUM PRŮMĚRU METOD — totéž pro průměr/medián všech metod. Tím se odpoví
 *     na otázku „pomůže průměrování?", aniž by se to muselo hádat.
 *  3) CITLIVOST NA ROZLIŠENÍ FFT (nfft 4096 vs 8192 vs 16384) a na způsob
 *     hledání vrcholu (surový bin vs parabolická interpolace). Tohle je
 *     SYSTEMATICKÁ chyba — nešumí, ale posouvá všechna čísla.
 *  4) VZTAH K HLASITOSTI — korelace SPR s SPL po tónech.
 *
 * Použití: node tools/exp-accuracy.mjs soubor.wav [fach]
 */
import { readFileSync } from 'node:fs';
import {
  analyze, ltas, spr, fhe, spectralEnvelope,
} from '../src/analysis.js';

function loadWav(p) {
  const b = readFileSync(p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const N = Math.floor(data.length / (fmt.ch * fmt.bits / 8));
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let a = 0;
    for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
    x[i] = a / fmt.ch;
  }
  return { samples: x, sampleRate: fmt.sr };
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
const corr = (a, b) => {
  const n = Math.min(a.length, b.length);
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
};

/** Parabolická interpolace vrcholu na log-výkonu — odstraní chybu z kvantování binu. */
function peakInterp(spec, lo, hi) {
  const { freq, db } = spec;
  let bi = -1, bv = -Infinity;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= lo && freq[i] <= hi && db[i] > bv) { bv = db[i]; bi = i; }
  }
  if (bi <= 0 || bi >= freq.length - 1) return bv;
  const y0 = db[bi - 1], y1 = db[bi], y2 = db[bi + 1];
  const den = y0 - 2 * y1 + y2;
  if (den === 0) return bv;
  const d = 0.5 * (y0 - y2) / den;
  if (Math.abs(d) > 1) return bv;
  return y1 - 0.25 * (y0 - y2) * d;
}

/** Metody SPR. Všechny měří totéž (poměr energie vysoko/nízko), jen jinak. */
const METHODS = {
  // dnešní implementace: vrchol binu, nfft 4096 (jak to dělá measureNote)
  m1_peak:
    (seg, sr, f0) => spr(ltas(seg, sr, 4096)),
  // totéž, ale vrchol interpolovaný (odstraní chybu z kvantování binu)
  m2_peak_interp:
    (seg, sr, f0) => peakInterp(ltas(seg, sr, 4096), 2000, 4000) - peakInterp(ltas(seg, sr, 4096), 30, 2000),
  // jemnější rozlišení FFT
  m3_peak_8192:
    (seg, sr, f0) => {
      const s = ltas(seg, sr, 8192);
      return peakInterp(s, 2000, 4000) - peakInterp(s, 30, 2000);
    },
  // pásmové průměry na OBÁLCE (ne jeden vrchol) — klasické LTAS měřítko ringu
  m4_env_mean:
    (seg, sr, f0) => {
      const e = spectralEnvelope(ltas(seg, sr, 4096), 0.01);
      const band = (a, b) => {
        let s = 0, n = 0;
        for (let i = 0; i < e.freq.length; i++) if (e.freq[i] >= a && e.freq[i] <= b) { s += e.db[i]; n++; }
        return n ? s / n : NaN;
      };
      return band(2000, 4000) - band(200, 2000);
    },
  // harmonický součet: sečte výkon v okolí každé harmonické (potřebuje f0)
  m5_harm_sum:
    (seg, sr, f0) => {
      if (!(f0 > 0)) return NaN;
      const spec = ltas(seg, sr, 8192);
      const { freq, db } = spec;
      const p = (a, b) => {
        let s = 0, n = 0;
        for (let i = 0; i < freq.length; i++) if (freq[i] >= a && freq[i] <= b) { s += Math.pow(10, db[i] / 10); n++; }
        return n ? s / n : NaN;
      };
      const half = Math.max(25, 0.35 * f0);
      let lo = 0, hi = 0;
      for (let k = Math.max(1, Math.floor(200 / f0)); k * f0 <= 4000; k++) {
        const c = k * f0;
        const v = p(c - half, c + half);
        if (!(v > 0)) continue;
        if (c < 2000) lo += v; else hi += v;
      }
      if (!(lo > 0) || !(hi > 0)) return NaN;
      return 10 * Math.log10(hi / lo);
    },
};

const [path, fach = 'tenor'] = process.argv.slice(2);
const { samples, sampleRate } = loadWav(path);
const res = analyze(samples, sampleRate, { fach });

console.log(`soubor ${path}`);
console.log(`délka ${res.duration_s.toFixed(1)} s @ ${sampleRate} Hz · tónů ${res.n_notes} · pásmo ${Math.round(res.band.limit)} Hz (${res.band.valid})`);
console.log(`dnešní SPR medián ${res.summary.spr_unusable ? '—' : res.summary.spr_median.toFixed(2)} dB · ring ${res.summary.spr_unusable ? '—' : res.summary.ring_consistency_pct.toFixed(1) + ' %'}`);
console.log('');

// tóny, které jdou měřit (stejný filtr jako ringAnalysis: dur >= 0.30, není ticho)
const splRef = (() => {
  const s = res.notes.filter(n => n.spr === n.spr).map(n => n.spl_dbfs).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(0.75 * s.length))] : NaN;
})();
const usable = res.notes.filter(n => n.spr === n.spr && n.dur >= 0.30 && n.spl_dbfs >= splRef - 20);
console.log(`měřitelných tónů: ${usable.length} z ${res.n_notes}\n`);

const names = Object.keys(METHODS);
const full = {};   // [metoda] -> pole SPR (plný úsek)
const h1 = {}, h2 = {};
for (const n of names) { full[n] = []; h1[n] = []; h2[n] = []; }
const splArr = [];

for (const n of usable) {
  const dur = n.t_end - n.t_start;
  const a = n.t_start + 0.20 * dur, b = n.t_end - 0.20 * dur;
  const i0 = Math.max(0, Math.floor(a * sampleRate));
  const i1 = Math.min(samples.length, Math.ceil(b * sampleRate));
  if (i1 - i0 < 2048) continue;
  const seg = samples.subarray(i0, i1);
  const m = (i0 + i1) >> 1;
  const sA = samples.subarray(i0, m), sB = samples.subarray(m, i1);
  let any = false;
  for (const k of names) {
    const vf = METHODS[k](seg, sampleRate, n.f0);
    const v1 = METHODS[k](sA, sampleRate, n.f0);
    const v2 = METHODS[k](sB, sampleRate, n.f0);
    full[k].push(vf); h1[k].push(v1); h2[k].push(v2);
    if (vf === vf) any = true;
  }
  if (any) splArr.push(n.spl_dbfs);
}

// ── 1) opakovatelnost: rozchod dvou polovin téhož tónu ────────────────────
console.log('METODA                 medián    SD    |polovina1-polovina2|   korelace s m1');
const rowStats = [];
for (const k of names) {
  const d = h1[k].map((v, i) => Math.abs(v - h2[k][i])).filter(v => v === v);
  const f = full[k].filter(v => v === v);
  const c = (() => {
    const xs = [], ys = [];
    for (let i = 0; i < full.m1_peak.length; i++) {
      if (full[k][i] === full[k][i] && full.m1_peak[i] === full.m1_peak[i]) { xs.push(full[k][i]); ys.push(full.m1_peak[i]); }
    }
    return corr(xs, ys);
  })();
  rowStats.push({ k, med: median(f), sd: sd(f), d: mean(d), c });
  console.log(
    k.padEnd(20) +
    median(f).toFixed(2).padStart(8) +
    sd(f).toFixed(2).padStart(7) +
    mean(d).toFixed(2).padStart(14) + ' dB' +
    ('   ' + c.toFixed(3)).padStart(16)
  );
}

// ── 2) pomůže průměr metod? ───────────────────────────────────────────────
const avgOf = (obj, keys) => keys.map((k) => {
  const v = obj[k];
  return v;
}).reduce((acc, v) => acc.map((x, i) => (v[i] === v[i] && Number.isFinite(x)) ? x + v[i] : (Number.isFinite(x) ? x : (v[i] === v[i] ? v[i] : NaN))), new Array(obj[keys[0]].length).fill(0));
const medianOf = (obj, keys, i) => {
  const vals = keys.map(k => obj[k][i]).filter(v => v === v);
  return vals.length ? median(vals) : NaN;
};
const n0 = full[names[0]].length;
const avgFull = [], avgH1 = [], avgH2 = [], medFull = [], medH1 = [], medH2 = [];
for (let i = 0; i < n0; i++) {
  const fv = names.map(k => full[k][i]).filter(v => v === v);
  const a1 = names.map(k => h1[k][i]).filter(v => v === v);
  const a2 = names.map(k => h2[k][i]).filter(v => v === v);
  avgFull.push(fv.length ? mean(fv) : NaN);
  avgH1.push(a1.length ? mean(a1) : NaN);
  avgH2.push(a2.length ? mean(a2) : NaN);
  medFull.push(fv.length ? median(fv) : NaN);
  medH1.push(a1.length ? median(a1) : NaN);
  medH2.push(a2.length ? median(a2) : NaN);
}
const dAvg = avgH1.map((v, i) => Math.abs(v - avgH2[i])).filter(v => v === v);
const dMed = medH1.map((v, i) => Math.abs(v - medH2[i])).filter(v => v === v);
console.log('');
console.log('PRŮMĚR METOD           medián    SD    |polovina1-polovina2|');
console.log(('průměr všech ' + names.length).padEnd(20) + median(avgFull.filter(v => v === v)).toFixed(2).padStart(8) + sd(avgFull.filter(v => v === v)).toFixed(2).padStart(7) + mean(dAvg).toFixed(2).padStart(14) + ' dB');
console.log('medián všech'.padEnd(20) + median(medFull.filter(v => v === v)).toFixed(2).padStart(8) + sd(medFull.filter(v => v === v)).toFixed(2).padStart(7) + mean(dMed).toFixed(2).padStart(14) + ' dB');

// ── 3) vztah k hlasitosti ────────────────────────────────────────────────
console.log('');
console.log('KORELACE s hlasitostí tónu (r):');
for (const k of names) {
  const xs = [], ys = [];
  for (let i = 0; i < full[k].length; i++) {
    if (full[k][i] === full[k][i] && splArr[i] === splArr[i]) { xs.push(full[k][i]); ys.push(splArr[i]); }
  }
  console.log('  ' + k.padEnd(20) + 'r = ' + corr(xs, ys).toFixed(2));
}

// ── 4) co se stane s číslem, které vidí uživatel ─────────────────────────
console.log('');
console.log('HODNOTA PRO UŽIVATELE (medián přes všechny měřitelné tóny):');
for (const k of names) console.log('  ' + k.padEnd(20) + median(full[k].filter(v => v === v)).toFixed(2) + ' dB');
console.log('  ' + 'PRŮMĚR METOD'.padEnd(20) + median(avgFull.filter(v => v === v)).toFixed(2) + ' dB');

// ── 5) FHE: citlivost na rozlišení a na způsob měření ────────────────────
console.log('');
console.log('FHE — totéž na týchž úsecích:');
const fheVals = { fhe_4096: [], fhe_8192: [], fhe_16384: [] };
for (const n of usable) {
  const dur = n.t_end - n.t_start;
  const a = n.t_start + 0.20 * dur, b = n.t_end - 0.20 * dur;
  const i0 = Math.max(0, Math.floor(a * sampleRate));
  const i1 = Math.min(samples.length, Math.ceil(b * sampleRate));
  if (i1 - i0 < 4096) continue;
  const seg = samples.subarray(i0, i1);
  fheVals.fhe_4096.push(fhe(ltas(seg, sampleRate, 4096)));
  fheVals.fhe_8192.push(fhe(ltas(seg, sampleRate, 8192)));
  fheVals.fhe_16384.push(fhe(ltas(seg, sampleRate, 16384)));
}
for (const k of Object.keys(fheVals)) console.log('  ' + k.padEnd(12) + 'medián ' + Math.round(median(fheVals[k].filter(v => v === v))) + ' Hz   SD ' + Math.round(sd(fheVals[k].filter(v => v === v))) + ' Hz');
const p = (x) => x.filter(v => v === v);
const dd = p(fheVals.fhe_16384).map((v, i) => Math.abs(v - p(fheVals.fhe_4096)[i])).filter(v => v === v);
console.log('  rozchod 4096 vs 16384: medián ' + Math.round(median(dd)) + ' Hz, max ' + Math.round(Math.max(...dd)) + ' Hz');
