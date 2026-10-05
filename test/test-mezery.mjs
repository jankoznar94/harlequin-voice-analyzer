#!/usr/bin/env node
/**
 * „Proč je v grafu mezera?" — co všechno umí zmizet bez stopy.
 *
 * Graf ringu kreslí JEN tóny, takže každé prázdné místo je díra. `dropped`
 * ale dřív zachytil jen úseky, které segmentace vytvořila a pak vyřadila
 * (mimo obor / příliš dlouhé). Ostatní díry vznikaly tiše — a přesně to
 * uživatel viděl: „v grafu je mnoho mezer, i když tam zcela evidentně tóny
 * jsou".
 *
 * Teď se hlásí i mezery mezi tóny, rozdělené podle příčiny:
 *   - „výška nalezena, ale tón z ní nevznikl"  → ukazuje na segmentaci
 *   - „signál bez nalezené výšky"              → ukazuje na YIN
 *   - ticho (pauza, nadechnutí) se NEHLÁSÍ — to žádná díra není
 *
 * OVĚŘENO MUTACÍ: vypnutí bloku s mezerami shodí sekce 1, 3 a 4.
 */
import { analyze } from '../src/analysis.js';

const RATE = 48000;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

function tone(f0, secs, rate = RATE, amp = 0.22) {
  const n = Math.round(secs * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 14; h++) { if (h * f0 > rate / 2 - 200) break; v += (1 / h) * Math.sin(2 * Math.PI * h * f0 * i / rate); }
    const fade = Math.min(1, i / 400) * Math.min(1, (n - i) / 400);
    out[i] = amp * v * fade;
  }
  return out;
}
const silence = (secs, rate = RATE) => new Float64Array(Math.round(secs * rate));
function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float64Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function noiseSig(secs, amp = 0.12, seed = 12345) {
  let s = seed;
  const out = new Float64Array(Math.round(secs * RATE));
  for (let i = 0; i < out.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out[i] = amp * (s / 0x3fffffff - 1); }
  return out;
}

const mezery = (r) => (r.dropped || []).filter(d => /tón z ní nevznikl|bez nalezené výšky/.test(d.why));

console.log('\n═══ 1. Šum mezi tóny se hlásí jako „signál bez nalezené výšky" ═══');
{
  const sig = concat(silence(0.4), tone(220, 1.0), noiseSig(3.0), tone(220, 1.0), silence(0.3));
  const r = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  const mz = mezery(r);
  console.log(`    dropped: ${(r.dropped || []).map(d => `${d.why} ${d.t0.toFixed(1)}–${d.t1.toFixed(1)}`).join(' | ') || '—'}`);
  check('mezera se hlásí', mz.length > 0);
  check('důvod je o chybějící výšce', mz.some(d => /bez nalezené výšky/.test(d.why)),
    mz.map(d => d.why).join(' | '));
  check('délka odpovídá vloženému šumu (3 s ±0,5 s)',
    mz.some(d => Math.abs((d.t1 - d.t0) - 3.0) < 0.5),
    mz.map(d => (d.t1 - d.t0).toFixed(2)).join(', '));
}

console.log('\n═══ 2. Krátká pauza mezi tóny se NEHLÁSÍ (nadechnutí není díra) ═══');
{
  const sig = concat(silence(0.4), tone(220, 1.0), silence(0.3), tone(240, 1.0), silence(0.3));
  const r = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  check('žádná mezera se nehlásí', mezery(r).length === 0,
    mezery(r).map(d => `${d.t0.toFixed(1)}–${d.t1.toFixed(1)}`).join(' | '));
  check('oba tóny zůstaly', r.n_notes >= 2, `n_notes=${r.n_notes}`);
}

console.log('\n═══ 3. Dlouhá pauza uprostřed se NEHLÁSÍ jako díra ═══');
{
  const sig = concat(silence(0.5), tone(220, 1.2), silence(5.8), tone(196, 1.2), silence(0.3));
  const r = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  console.log(`    dropped: ${(r.dropped || []).map(d => d.why).join(' | ') || '—'}`);
  check('ticho se mezi mezery nepočítá', mezery(r).length === 0,
    mezery(r).map(d => d.why).join(' | '));
  check('tóny zůstaly', r.n_notes >= 2, `n_notes=${r.n_notes}`);
}

console.log('\n═══ 4. Reálná nahrávka: signálové mezery mají záznam, tiché ne ═══');
{
  const { execFileSync } = await import('node:child_process');
  const p = 'rec-test/zpev.wav';
  try {
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const n = Math.floor(pcm.length / 4);
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = dv.getFloat32(i * 4, true);
    const r = analyze(x, RATE, { fach: 'tenor', fileRate: NaN });
    const dr = r.dropped || [];

    /* Nezávisle (ne stejnou funkcí jako kód): kolik je v mezeře ticha.
     * Ticho = RMS okna 2048 pod prahem 0,008 (stejná konstanta jako v
     * `pitchTrack`, ale sem se opisuje SCHVÁLNĚ — kdyby se v kódu změnila,
     * test to má odhalit, ne opsat). */
    const rmsAt = (t) => {
      const s = Math.round(t * RATE);
      let s2 = 0;
      for (let j = s; j < Math.min(x.length, s + 2048); j++) s2 += x[j] * x[j];
      return Math.sqrt(s2 / 2048);
    };
    const tichaFrac = (a, b) => {
      let u = 0, c = 0;
      for (let t = a; t < b; t += 0.010) { c++; if (rmsAt(t) < 0.008) u++; }
      return c ? u / c : 1;
    };

    const segs = [...r.notes].sort((a, b) => a.t_start - b.t_start);
    const holes = [];
    let t = 0;
    for (const s of segs) { if (s.t_start - t > 0.6) holes.push([t, s.t_start]); t = Math.max(t, s.t_end); }
    if (r.duration_s - t > 0.6) holes.push([t, r.duration_s]);
    console.log(`    ${r.duration_s.toFixed(1)} s · ${r.n_notes} tónů · ${holes.length} mezer v grafu · ${dr.length} záznamů v dropped`);

    const bezZaznamuASignal = [], zaznamNaTichu = [];
    for (const [a, b] of holes) {
      const hit = dr.find(d => Math.min(d.t1, b) - Math.max(d.t0, a) > 0.15);
      const tf = tichaFrac(a, b);
      const ticho = tf > 0.5;
      console.log(`      ${a.toFixed(1)}–${b.toFixed(1)} s · ticho ${(100 * tf).toFixed(0)} % → ${hit ? hit.why : (ticho ? 'pauza (správně bez záznamu)' : 'CHYBI ZÁZNAM')}`);
      if (!hit && !ticho) bezZaznamuASignal.push(`${a.toFixed(1)}–${b.toFixed(1)}`);
      if (hit && ticho) zaznamNaTichu.push(`${a.toFixed(1)}–${b.toFixed(1)} (${hit.why})`);
    }
    check('každá mezera se SIGNÁLEM má záznam', bezZaznamuASignal.length === 0, bezZaznamuASignal.join(', '));
    check('na pouhé pauze žádný záznam nevzniká', zaznamNaTichu.length === 0, zaznamNaTichu.join(', '));
    check('aspoň jedna mezera má důvod o výšce',
      dr.some(d => /tón z ní nevznikl|bez nalezené výšky/.test(d.why)));
    check('žádný záznam nepřesahuje délku nahrávky',
      dr.every(d => d.t0 >= -0.01 && d.t1 <= r.duration_s + 0.01));
  } catch (e) {
    console.log('    (soubor rec-test/zpev.wav není k dispozici — přeskakuji)');
  }
}

console.log('\n═══ 5. Vyřazení se nezdvojuje (jedna mezera = jeden záznam) ═══');
{
  /* Signál s tónem mimo obor: ten vytvoří záznam „mimo tenor" i mezeru.
   * Nesmí tam být dvakrát. */
  const sig = concat(silence(0.4), tone(220, 1.0), silence(0.4), tone(110, 1.6), silence(0.4), tone(196, 1.0), silence(0.3));
  const r = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  const dr = r.dropped || [];
  console.log(`    dropped: ${dr.map(d => `${d.why} ${d.t0.toFixed(1)}–${d.t1.toFixed(1)}`).join(' | ') || '—'}`);
  check('záznam o tónu mimo obor existuje', dr.some(d => /mimo tenor/.test(d.why)));
  const prekryv = [];
  for (let i = 0; i < dr.length; i++) {
    for (let j = i + 1; j < dr.length; j++) {
      if (dr[i].t0 < dr[j].t1 - 0.05 && dr[j].t0 < dr[i].t1 - 0.05) prekryv.push(`${dr[i].why} × ${dr[j].why}`);
    }
  }
  check('žádné dva záznamy se nepřekrývají', prekryv.length === 0, prekryv.join(' | '));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass}/${pass + fail} kontrol prošlo`);
process.exit(fail === 0 ? 0 : 1);
