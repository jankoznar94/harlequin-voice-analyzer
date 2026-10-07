/**
 * Ověření, že živá cesta přes SKUTEČNÝ `pushBlock` z live-run.js měří SPR.
 *
 * PROČ: `pushBlock` a `appendKeep` nejsou exportované, takže se snadno stane,
 * že se opraví jen test a ne aplikace. Tady se kód VYTÁHNE ze skutečného
 * souboru a spustí se — ne opis, ne kopie.
 *
 * Nález, který to hlídá: kdyby SPR okno bralo z `pending` (který se ořezává),
 * nikdy by se 4096 nenaplnilo a indikátor by SPR neukazoval vůbec.
 */
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/live-run.js'), 'utf8');

const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`funkce ${name} nenalezena v live-run.js`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('nevyvážené závorky');
};

const code = grab('pushBlock') + '\n' + grab('appendKeep');
const factory = new Function('feedFrame', 'onFrame', 'SPR_NFFT', 'FRAME_SIZE', 'BLOCK_MS',
  'SPEC_NFFT', 'SPEC_BUF_SAMPLES', 'createSpecState', 'feedSpec',
  code + '\nreturn { pushBlock, appendKeep };');

const SPR_NFFT = 4096, FRAME_SIZE = 2048, BLOCK_MS = 20;
/* Živý spektrogram: okno 1024 vzorků, zásobník 4096. Logika sloupce se do
 * testu bere ze SKUTEČNÉHO modulu (ne z opisů), aby test hlídal i to, že si
 * pushBlock bere okno z toho správného zásobníku. */
const SPEC_NFFT = 1024, SPEC_BUF_SAMPLES = 4096;
const SR = 48000;

const {
  createSpecState: realCreateSpecState,
  feedSpec: realFeedSpec,
} = await import('../src/live-spec.js');

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

/* ── appendKeep ──────────────────────────────────────────────────────────── */

console.log('\n1. Kruhový zásobník pro SPR\n');
{
  const { appendKeep } = factory(() => {}, () => {}, SPR_NFFT, FRAME_SIZE, BLOCK_MS, SPEC_NFFT, SPEC_BUF_SAMPLES, realCreateSpecState, realFeedSpec);
  let b = new Float64Array(0);
  b = appendKeep(b, Float64Array.from({ length: 3000 }, (_, i) => i), 4096);
  ok('po 3000 vzorcích drží 3000', b.length === 3000, `${b.length}`);
  b = appendKeep(b, Float64Array.from({ length: 2000 }, (_, i) => 3000 + i), 4096);
  ok('po dalších 2000 se ořízne na 4096', b.length === 4096, `${b.length}`);
  ok('drží POSLEDNÍCH 4096 (první = 904)', b[0] === 904, `${b[0]}`);
  ok('poslední = 4999', b[b.length - 1] === 4999, `${b[b.length - 1]}`);
  // přesnost ořezu: prostřední hodnota musí odpovídat původnímu indexu
  ok('prostřední hodnota sedí (nic se neposunulo)', b[2048] === 904 + 2048, `${b[2048]}`);
  // mnoho malých bloků za sebou
  let c = new Float64Array(0);
  for (let i = 0; i < 500; i++) c = appendKeep(c, Float64Array.from({ length: 960 }, (_, j) => i * 960 + j), 4096);
  ok('po 500 blocích po 960 drží 4096', c.length === 4096, `${c.length}`);
  ok('hodnoty jdou v řadě bez děr', c[100] + 1 === c[101] && c[4000] + 1 === c[4001],
    `${c[100]},${c[101]} … ${c[4000]},${c[4001]}`);
}

/* ── pushBlock přes skutečný kód ─────────────────────────────────────────── */

console.log('\n2. Okno pro SPR se musí skutečně naplnit (jinak se SPR neměří)\n');
{
  const sr = SR;
  const n = sr * 4;
  const sig = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * 440 / sr;
    let v = 0;
    for (let h = 1; h * 440 < 5200; h++) {
      const f = h * 440;
      let a = 0.02;
      for (const [fc, bw] of [[700, 80], [1200, 110], [2600, 180]]) a += 0.5 / (1 + ((f - fc) / bw) ** 2);
      v += a * Math.sin(ph * h) / Math.sqrt(h);
    }
    sig[i] = 0.28 * v;
  }

  const calls = [];
  const feedFrame = (state, dsp, frame, sprWin) => {
    calls.push({ frameLen: frame.length, sprLen: sprWin ? sprWin.length : 0 });
    return { sprLast: 1, spr: 1, sprOld: 1, voiced: true, f0: 440 };
  };
  const { pushBlock } = factory(feedFrame, () => {}, SPR_NFFT, FRAME_SIZE, BLOCK_MS, SPEC_NFFT, SPEC_BUF_SAMPLES, realCreateSpecState, realFeedSpec);

  const r = { state: { sampleRate: sr }, sprBuf: new Float64Array(0), specBuf: new Float64Array(0), pending: new Float64Array(0), specRows: 192, lastBlockEnd: 0 };
  const HOP = Math.round(sr * BLOCK_MS / 1000);
  for (let b = 0; b + HOP <= sig.length; b += HOP) { r.lastBlockEnd = b + HOP; pushBlock(r, sig.subarray(b, b + HOP)); }

  ok('rámce se zpracovávají vůbec', calls.length > 180, `${calls.length} rámců`);
  const withSpr = calls.filter(c => c.sprLen === SPR_NFFT).length;
  ok(`okno 4096 pro SPR se naplní u ${withSpr} z ${calls.length} rámců`,
    withSpr > 0.9 * calls.length, `${(100 * withSpr / calls.length).toFixed(0)} %`);
  // první rámce okno ještě nemají — to je správně (SPR se nehlásí, ne dopočítává)
  const firstNoSpr = calls.findIndex(c => c.sprLen === SPR_NFFT);
  ok('na začátku se SPR chvíli nehlásí (ne dopočítává z nul)', firstNoSpr >= 1,
    `první plné okno u rámce ${firstNoSpr}`);
  ok('rámec pro výšku zůstává 2048', calls.every(c => c.frameLen === FRAME_SIZE),
    `délky: ${[...new Set(calls.map(c => c.frameLen))].join(',')}`);

  // okno pro SPR musí končit na konci rámce — nezačínat stejně
  const r2 = { state: { sampleRate: sr }, sprBuf: new Float64Array(0), specBuf: new Float64Array(0), pending: new Float64Array(0), specRows: 192, lastBlockEnd: 0 };
  let lastFrameEnd = 0, lastSprWinEnd = 0;
  const feed2 = (state, dsp, frame, sprWin) => {
    lastFrameEnd = frame[frame.length - 1];
    lastSprWinEnd = sprWin ? sprWin[sprWin.length - 1] : 0;
    return { sprLast: 1, spr: 1, sprOld: 1, voiced: true, f0: 440 };
  };
  const f2 = factory(feed2, () => {}, SPR_NFFT, FRAME_SIZE, BLOCK_MS, SPEC_NFFT, SPEC_BUF_SAMPLES, realCreateSpecState, realFeedSpec);
  // signál = indexy, ať se dá poznat, odkud okno je
  const idx = new Float64Array(sr * 2);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  for (let b = 0; b + HOP <= idx.length; b += HOP) { r2.lastBlockEnd = b + HOP; f2.pushBlock(r2, idx.subarray(b, b + HOP)); }
  // Okno pro SPR končí na NEJNOVĚJŠÍM vzorku (konec bloku), zatímco poslední
  // zpracovaný rámec pro výšku končí o kus dřív — uvnitř téhož bloku.
  // Rozdíl je nejvýš jeden blok (20 ms) a je to tak správně: SPR má ukazovat
  // to, co se děje TEĎ, takže se bere z nejnovějšího zvuku. Kdyby okno končilo
  // na konci rámce, indikátor by na nejnovější zvuk čekal o blok déle.
  const HOP_SAMPLES = Math.round(SR * BLOCK_MS / 1000);
  ok(`okno pro SPR končí na nejnovějším vzorku (nejvýš o blok dřív než rámec)`,
    lastSprWinEnd >= lastFrameEnd && lastSprWinEnd - lastFrameEnd <= HOP_SAMPLES,
    `konec rámce ${lastFrameEnd}, konec SPR okna ${lastSprWinEnd}, rozdíl ${lastSprWinEnd - lastFrameEnd} vzorků (blok ${HOP_SAMPLES})`);
  ok('okno SPR nikdy nepředbíhá zvuk, který dorazil', lastSprWinEnd < idx.length,
    `konec okna ${lastSprWinEnd} z ${idx.length}`);
}

/* ── 3. spektrogram: sloupec musí vznikat z PLNÉHO okna ─────────────────── */

console.log('\n3. Sloupec spektrogramu vzniká z plného okna (ne z nul, ne ze zbytku)\n');
{
  const sr = SR;
  const n = sr * 3;
  const idx = new Float64Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;          // hodnota = index vzorku

  /* `feedSpec` se volá se skutečným stavem; zajímá nás, jaká okna mu chodí.
   * Kdyby pushBlock bral vzorky z `pending` (který se po každém rámci ořezává),
   * okno by nikdy nebylo plné — přesně na to má tenhle test přijít. */
  const winLens = [];
  let captured = null;
  const feedSpecSpy = (st, win) => {
    winLens.push(win.length);
    captured = win;
    return realFeedSpec(st, win);
  };
  const HOP = Math.round(sr * BLOCK_MS / 1000);
  const { pushBlock } = factory(() => ({ sprLast: 1, spr: 1, sprOld: 1, voiced: true, f0: 440 }),
    () => {}, SPR_NFFT, FRAME_SIZE, BLOCK_MS, SPEC_NFFT, SPEC_BUF_SAMPLES, realCreateSpecState, feedSpecSpy);

  const r = { state: { sampleRate: sr }, sprBuf: new Float64Array(0), specBuf: new Float64Array(0), pending: new Float64Array(0), specRows: 192, lastBlockEnd: 0 };
  for (let b = 0; b + HOP <= idx.length; b += HOP) { r.lastBlockEnd = b + HOP; pushBlock(r, idx.subarray(b, b + HOP)); }

  ok('sloupec se počítá při každém rámci', winLens.length > 130, `${winLens.length} sloupců`);
  ok('každé okno má aspoň SPEC_NFFT vzorků', winLens.every(L => L >= SPEC_NFFT),
    `nejmenší ${Math.min(...winLens)}`);
  ok('zásobník se drží na SPEC_BUF_SAMPLES (neroste donekonečna)',
    r.specBuf.length === SPEC_BUF_SAMPLES, `${r.specBuf.length}`);
  // sloupec musí končit na NEJNOVĚJŠÍM vzorku — obraz jinak zaostává
  ok('okno spektrogramu končí na nejnovějším vzorku',
    captured[captured.length - 1] === idx[r.lastBlockEnd - 1],
    `konec okna ${captured[captured.length - 1]}, poslední dodaný ${idx[r.lastBlockEnd - 1]}`);
  // okna se musí posouvat — dvě po sobě nesmí být stejná
  const r2 = { state: { sampleRate: sr }, sprBuf: new Float64Array(0), specBuf: new Float64Array(0), pending: new Float64Array(0), specRows: 192 };
  const wins2 = [];
  const spy2 = (st, win) => { wins2.push(win[win.length - 1]); return realFeedSpec(st, win); };
  const f3 = factory(() => ({ sprLast: 1, spr: 1, sprOld: 1, voiced: true, f0: 440 }),
    () => {}, SPR_NFFT, FRAME_SIZE, BLOCK_MS, SPEC_NFFT, SPEC_BUF_SAMPLES, realCreateSpecState, spy2);
  for (let b = 0; b + HOP <= idx.length; b += HOP) { r2.lastBlockEnd = b + HOP; f3.pushBlock(r2, idx.subarray(b, b + HOP)); }
  const uniq = new Set(wins2).size;
  ok('okna se posouvají (žádné dvě stejné)', uniq === wins2.length, `${uniq} unikátních z ${wins2.length}`);
}

console.log(`\n═══ ŽIVÝ BĚH: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
