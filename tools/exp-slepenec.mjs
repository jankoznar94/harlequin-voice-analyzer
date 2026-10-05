/* Reprodukce reálné vady: DRŽENÝ tón na „A", u kterého YIN latuje mezi
 * základním tónem a jeho násobky → segmentace slepí celou pětivteřinovou
 * nahrávku do JEDNOHO tónu s rozkmitem přes oktávu.
 *
 * Naměřeno u uživatele (JSON z aplikace): 1 tón, dur 5,36 s, span_cents 1328,
 * is_glide true, f0 145,85 Hz (D3), f0_sd_cents 103. Důsledek: SPR −23,7 dB
 * proti −13,8 dB na jeho jiné nahrávce, FHE 3023 Hz proti tenorské referenci
 * 2705 ± 221 — tedy číslo, které nic nepopisuje, a v grafu jedna hodnota
 * místo pěti vteřin tónu.
 *
 * ⚠️ POZOR NA SYNTEZU (naučeno): `sin(2π·f(t)·t)` s MĚNÍCÍM SE f dělá fázové
 * skoky a YIN v tom výšku nenajde (naměřeno: 45–70 rámců z 396). Správně se
 * fáze INTEGRUJE (`fáze += 2π·f·dt`) — jinak test hlásí vadu kódu, která
 * vznikla v testu.
 */
import { analyze } from '../src/analysis.js';

const SR = 48000;

/** Hlas: harmonická řada s formantovou obálkou a ZADANOU KONTUROU f0.
 *  Fáze se integruje, aby signál neměl skoky. */
function voice(dur, kontura, f0base = 146.83, nharm = 60) {
  const n = Math.round(dur * SR), out = new Float64Array(n);
  const faze = new Float64Array(nharm + 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = f0base * kontura(t);
    let v = 0;
    for (let h = 1; h <= nharm; h++) {
      const f = f0 * h;
      if (f >= SR / 2) break;
      faze[h] += 2 * Math.PI * f / SR;
      let a = 1 / h ** 1.1;
      a *= 1 + 5 / (1 + ((f - 600) / 900) ** 2);
      a *= 1 + 3 / (1 + ((f - 1300) / 1100) ** 2);
      v += a * Math.sin(faze[h]);
    }
    out[i] = 0.18 * v;
  }
  return out;
}

const vysledky = [];
function check(name, ok, detail = '') {
  vysledky.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}
const popisTonu = (r) => r.notes.map(nn =>
  `${nn.note} ${nn.t_start.toFixed(2)}–${nn.t_end.toFixed(2)}s (${nn.dur.toFixed(2)}s, span ${Math.round(nn.span_cents)}c)`).join(' | ');

console.log('\n═══ Rozdělování slepenců: rozkmit přes oktávu není jeden tón ═══');

/* 1) Kontura, která skáče mezi D3 a D4 (jak to YIN na reálném „A" dělá,
 *    když je slabý základní tón). */
{
  const x = voice(5.4, (t) => (t > 1.3 && t < 1.9) ? 2.0 : 1.0);
  const r = analyze(x, SR, { fach: 'tenor' });
  console.log(`     ${r.notes.length} tónů: ${popisTonu(r)}`);
  check('skok přes oktávu se NESLEPÍ do jednoho tónu', r.notes.length >= 2,
    `tónů ${r.notes.length}`);
  check('žádný tón nemá rozkmit přes 700 centů',
    r.notes.every(nn => nn.span_cents <= 700),
    `spans ${r.notes.map(nn => Math.round(nn.span_cents)).join(', ')}`);
  check('hlášený f0 odpovídá zpívanému D3 (ne oktáva výš)',
    r.notes.some(nn => Math.abs(nn.f0 - 146.83) < 4),
    `f0: ${r.notes.map(nn => nn.f0.toFixed(1)).join(', ')}`);
}

/* 2) Skutečně DRŽENÝ tón (stabilní) musí zůstat JEDEN. */
{
  const x = voice(5.4, () => 1.0);
  const r = analyze(x, SR, { fach: 'tenor' });
  console.log(`     stabilní: ${r.notes.length} tón(ů): ${popisTonu(r)}`);
  check('stabilní držený tón zůstává JEDEN', r.notes.length === 1,
    `tónů ${r.notes.length}`);
}

/* 3) Vibrato ±70 centů je JEDEN tón, ne dva. */
{
  const x = voice(4.0, (t) => Math.pow(2, (70 / 1200) * Math.sin(2 * Math.PI * 5 * t)));
  const r = analyze(x, SR, { fach: 'tenor' });
  console.log(`     vibrato ±70c/5Hz: ${r.notes.length} tón(ů): ${popisTonu(r)}`);
  check('vibrato ±70 centů zůstává jeden tón', r.notes.length === 1,
    `tónů ${r.notes.length}`);
  check('vibrato má rozkmit v řádu stovek centů, ne přes 700',
    r.notes.every(nn => nn.span_cents <= 700),
    `span ${r.notes.map(nn => Math.round(nn.span_cents)).join(', ')}`);
}

/* 4) Glissando +500 centů: smí se rozdělit, ale každý díl musí mít smysl. */
{
  const x = voice(4.0, (t) => Math.pow(2, (500 / 1200) * (t / 4)));
  const r = analyze(x, SR, { fach: 'tenor' });
  console.log(`     glissando +500c: ${r.notes.length} tónů, spans ${r.notes.map(nn => Math.round(nn.span_cents)).join(', ')}`);
  check('glissando nedá slepenec přes 700 centů',
    r.notes.every(nn => nn.span_cents <= 700),
    `spans ${r.notes.map(nn => Math.round(nn.span_cents)).join(', ')}`);
}

/* 5) Reálná nahrávka uživatele se nesmí zhoršit — regresní kontrola. */
{
  const { execFileSync } = await import('node:child_process');
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', 'rec-test/rec-audio-64k.webm',
    '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(pcm.length / 4);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = dv.getFloat32(i * 4, true);
  const r = analyze(s, SR, { fach: 'tenor', fileRate: 48000 });
  const spans = r.notes.map(nn => Math.round(nn.span_cents)).sort((a, b) => b - a);
  console.log(`     reálná nahrávka (webm z appky): ${r.notes.length} tónů, ` +
    `SPR ${r.summary.spr_median.toFixed(1)} dB, největší rozkmity ${spans.slice(0, 5).join(', ')}`);
  check('reálná nahrávka dá pořád tóny', r.notes.length >= 30, `tónů ${r.notes.length}`);
  check('žádný tón na reálné nahrávce nemá rozkmit přes 700 centů',
    spans.every(x => x <= 700), `max ${spans[0]} c`);
}

const fail = vysledky.filter(v => !v.ok).length;
console.log(`\n═══ VÝSLEDEK: ${vysledky.length - fail} prošlo, ${fail} selhalo ═══`);
process.exit(fail ? 1 : 0);
