import { readFileSync } from 'node:fs';
import { analyze } from '../src/analysis.js';

function loadWav(path) {
  const b = readFileSync(path);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const n = Math.floor(data.length / (fmt.ch * fmt.bits / 8));
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
    x[i] = a / fmt.ch;
  }
  return { samples: x, sampleRate: fmt.sr };
}

const [, , wavPath, pyReportPath, fach = 'tenor'] = process.argv;
const { samples, sampleRate } = loadWav(wavPath);
const py = JSON.parse(readFileSync(pyReportPath, 'utf8'));

// dva režimy: aktuální a "držený tón" (konzervativnější)
const modes = {
  'současné (tolCents 120, gap 0.12)': {},
  'držený tón (tolCents 50, gap 0.20)': { tolCents: 50, gap: 0.20 },
};

for (const [label, over] of Object.entries(modes)) {
  const res = analyze(samples, sampleRate, { fach, ...over });
  console.log(`\n═══ ${label} ═══`);
  console.log(`JS tónů: ${res.n_notes}   PY tónů: ${py.notes.length}`);
  const fmt = (v, d = 2) => (v === v && v != null ? v.toFixed(d) : '—');
  console.log(`JS noty: ${res.notes.map(n => n.note).join(' ')}`);
  console.log(`PY noty: ${py.notes.map(n => n.note).join(' ')}`);

  // párování podle času
  let paired = 0;
  const unpairedJs = [];
  for (const a of res.notes) {
    let best = null, bestOv = 0;
    for (const b of py.notes) {
      const ov = Math.min(a.t_end, b.t_end) - Math.max(a.t_start, b.t_start);
      if (ov > bestOv) { bestOv = ov; best = b; }
    }
    const minLen = Math.min(a.t_end - a.t_start, best ? best.t_end - best.t_start : 0);
    if (best && minLen > 0 && bestOv / minLen > 0.5) paired++; else unpairedJs.push(a);
  }
  let unpairedPy = 0;
  for (const b of py.notes) {
    let bestOv = 0;
    for (const a of res.notes) {
      const ov = Math.min(a.t_end, b.t_end) - Math.max(a.t_start, b.t_start);
      if (ov > bestOv) bestOv = ov;
    }
    const minLen = b.t_end - b.t_start;
    if (!(bestOv / minLen > 0.5)) unpairedPy++;
  }
  console.log(`spárováno: ${paired}   JS tóny navíc: ${unpairedJs.length}   PY tóny nenalezené JS: ${unpairedPy}`);
  console.log('\nJS tóny navíc (čas / délka / nota / SPR):');
  for (const a of unpairedJs.slice(0, 40)) {
    console.log(`   ${a.t_start.toFixed(2)}–${a.t_end.toFixed(2)}  ${a.dur.toFixed(2)}s  ${a.note.padEnd(4)}  ${fmt(a.spr, 1)} dB  ring=${a.ring_ok ? 'ANO' : 'NE'}`);
  }
  console.log('\nJS segmenty (vše):');
  res.notes.forEach(n => console.log(`   ${String(n.idx).padStart(2)} ${n.t_start.toFixed(2)}–${n.t_end.toFixed(2)} ${n.dur.toFixed(2)}s ${n.note.padEnd(4)} ${fmt(n.spr, 1)} ${n.ring_ok ? '' : ' VÝPADEK'}`));
  break;  // detaily jen pro první režim
}
