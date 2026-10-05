/* Vypíše EBML strom souboru — kolik a jakých prvků v něm je.
 * Slouží k ověření, že `findSamplingFrequency` hledá SPRÁVNÉ ID (a na správné
 * délce hodnoty). Bez tohohle ověření by se dalo číst pole, které v souboru
 * vůbec není. */
import { readFileSync } from 'node:fs';

const b = new Uint8Array(readFileSync(process.argv[2]));
const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

/* Přečte EBML ID (1–4 bajty, z prvního bajtu je počet vedoucích jedniček). */
function readId(o) {
  const f = b[o];
  let n = 1;
  if (f & 0x80) n = 1; else if (f & 0x40) n = 2; else if (f & 0x20) n = 3; else if (f & 0x10) n = 4;
  else return null;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return { id: '0x' + v.toString(16).toUpperCase(), bytes: n };
}
function readSize(o) {
  const f = b[o];
  if (!f) return null;
  let n = 0;
  for (let bit = 7; bit >= 0; bit--) if (f & (1 << bit)) { n = 8 - bit; break; }
  if (!n) return null;
  let v = f & ((1 << (8 - n)) - 1);
  for (let k = 1; k < n; k++) v = v * 256 + b[o + k];
  return { size: v, bytes: n, unknown: v === Math.pow(2, 7 * n) - 1 };
}

const ZNAM = {
  '0x1A45DFA3': 'EBML', '0x18538067': 'Segment', '0x1654AE6B': 'Tracks', '0xAE': 'TrackEntry',
  '0xE1': 'Audio', '0xB5': 'SamplingFrequency', '0x78B5': 'OutputSamplingFrequency',
  '0x9F': 'Channels', '0x6264': 'BitDepth', '0x86': 'CodecID', '0x83': 'TrackType',
  '0x63A2': 'CodecPrivate', '0x42B7': '???42B7(není v Matrosce)', '0x42F7': '???',
  '0x4489': 'Duration', '0x4D80': 'MuxingApp', '0x5741': 'WritingApp',
  '0x23E383': 'DefaultDuration', '0x2AD7B1': 'TimestampScale', '0xEC': 'Void',
};
function walk(o, end, depth) {
  while (o < end) {
    const id = readId(o);
    if (!id) return;
    const sz = readSize(o + id.bytes);
    if (!sz) return;
    const dataOff = o + id.bytes + sz.bytes;
    const dataEnd = sz.unknown ? end : Math.min(end, dataOff + sz.size);
    const name = ZNAM[id.id] || '';
    const val = dataOff + sz.size <= b.length && sz.size <= 8 && !['0x1A45DFA3', '0x18538067', '0x1654AE6B', '0xAE', '0xE1'].includes(id.id)
      ? ' = ' + hexToVal(b, dv, dataOff, sz.size) : '';
    if (name || depth < 3) console.log('  '.repeat(depth) + id.id + ' ' + name + val + ` (len ${sz.size})`);
    const jeKontejner = ['0x1A45DFA3', '0x18538067', '0x1654AE6B', '0xAE', '0xE1'].includes(id.id);
    if (jeKontejner && !sz.unknown) walk(dataOff, dataEnd, depth + 1);
    o = dataEnd;
    if (sz.unknown) return;
  }
}
function hexToVal(b, dv, o, n) {
  if (n === 4) return dv.getFloat32(o, false).toString() + ' (float32)';
  if (n === 8) return dv.getFloat64(o, false).toString() + ' (float64)';
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  const txt = String.fromCharCode(...b.slice(o, o + n));
  return /^[\x20-\x7e]+$/.test(txt) ? `"${txt}"` : String(v);
}
console.log('soubor:', process.argv[2], '·', b.length, 'bajtů');
walk(0, b.length, 0);
