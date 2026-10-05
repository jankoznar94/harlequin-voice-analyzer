#!/usr/bin/env node
/* Sonda: prožene soubory v daném adresáři CESTou jako aplikace.
 *
 * Dekódování: v prohlížeči to dělá OfflineAudioContext (na hardware nevázaný).
 * V Node žádný Web Audio není, takže se tentýž krok dělá ffmpegem na 48 kHz —
 * tím se ověří, co z toho vyjde s plným pásmem, a jestli je problém v datech.
 *
 * Vypíše pro každý soubor: co uhodl sniffSampleRate, jaké pásmo/špičku/počet
 * tónů dala analyze() a co by UI napsalo jako hlášku.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sniffSampleRate } from '../src/sample-rate.js';
import { analyze } from '../src/analysis.js';

const DIR = process.argv[2] || 'rec-test';
const RATE = Number(process.env.RATE || 48000);
const files = readdirSync(DIR).filter(f => /\.(webm|wav|opus|m4a|mp3|ogg)$/i.test(f)).sort();

const fmt = (v, d = 1) => (v === v && v !== null && v !== undefined) ? v.toFixed(d) : String(v);

for (const f of files) {
  const path = join(DIR, f);
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const fileRate = sniffSampleRate(ab);

  // dekódování na 48 kHz mono f32 (ekvivalent OfflineAudioContext cesty)
  let pcm;
  try {
    pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1',
      '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  } catch (e) {
    console.log(`${f}: ffmpeg selhal — ${e.message}`);
    continue;
  }
  const n = Math.floor(pcm.length / 4);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = dv.getFloat32(i * 4, true);

  const res = analyze(samples, RATE, { fileRate });
  const s = res.summary || {};
  console.log('─'.repeat(72));
  console.log(`${basename(f)}  ·  ${(buf.length / 1024).toFixed(0)} kB`);
  console.log(`  sniff kmitočet : ${fileRate === fileRate ? fileRate + ' Hz' : 'NEPOZNÁN (NaN)'}`);
  console.log(`  pásmo          : limit ${Math.round(res.band.limit)} Hz · raw ${Math.round(res.band.limit_raw)} Hz · valid=${res.band.valid}`);
  console.log(`  důvod          : ${res.band.reason}`);
  console.log(`  špička         : ${fmt(res.peak_dbfs, 1)} dBFS · ${fmt(res.duration_s)} s`);
  console.log(`  tóny           : ${res.n_notes} měřených / ${s.n_notes_total ?? '?'} nalezených`);
  console.log(`  SPR medián     : ${fmt(s.spr_median, 2)} dB · nový ${fmt(s.spr_novy_median, 2)} dB`);
  console.log(`  ring           : ${fmt(s.ring_consistency_pct, 0)} % · úroveň ${s.level}`);
  console.log(`  spr_unusable   : ${s.spr_unusable} · reason: ${s.reason ?? '—'}`);
}
