#!/usr/bin/env node
/**
 * Kontrola SKUTEČNÉHO vykreslení živého spektrogramu v prohlížeči.
 *
 * Mock canvasu nestačí: chyby typu „obraz sražený do čtvrtiny plátna na dsf 2"
 * nebo „okno se neposouvá, jen se přemalovává" se poznají jen ze skutečných
 * pixelů. Test spustí headless Chromium, nechá vykreslit `kontrola-spektrogram.html`
 * a čte, KDE na plátně co opravdu leží.
 *
 * Použití: node test/test-live-spektrogram-render.mjs
 * (vyžaduje chromium-browser; když není, test se přeskočí, ne selže)
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8141;

const haveChrome = spawnSync('which', ['chromium-browser'], { encoding: 'utf8' }).status === 0;
if (!haveChrome) {
  console.log('\n⏭  chromium-browser není k dispozici — kontrola vykreslení přeskočena.\n');
  process.exit(0);
}

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

const server = spawn('node', ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(1500);

function render(dsf) {
  const r = spawnSync('chromium-browser', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--force-device-scale-factor=${dsf}`,
    '--virtual-time-budget=9000',
    '--dump-dom',
    `http://localhost:${PORT}/kontrola-spektrogram.html`,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000 });

  const dom = r.stdout || '';
  const m = dom.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/);
  const text = m ? m[1].replace(/<[^>]*>/g, '').trim() : '';
  const hdr = (dom.match(/<h3 id="hdr">([^<]*)</) || [])[1] || '';
  return { text, hdr };
}

try {
  for (const dsf of [1, 2]) {
    console.log(`\n═══ Živý spektrogram při devicePixelRatio ${dsf} ═══\n`);
    const { text, hdr } = render(dsf);
    if (hdr.startsWith('CHYBA')) {
      ok('stránka proběhla bez chyby', false, hdr);
      console.log(text);
      continue;
    }
    ok('stránka proběhla bez chyby', hdr === 'HOTOVO', hdr);

    const j = JSON.parse((text.match(/VÝSLEDKY (\{.*\})/) || [])[1] || '{}');

    /* Obraz musí být nakreslený V CELÉ šířce. Sloupec, kde není ani jeden
     * neprůhledný pixel, je místo, kam se obraz nedostal — při vložení
     * `putImageData` přímo na plátno by jich na dsf 2 byly tři čtvrtiny. */
    ok('obraz je nakreslený v celé šířce (žádná prázdná místa)',
      j.unpainted === 0, `${j.unpainted} nenakreslených sloupců z ${j.imgW}`);

    /* Jasný blok musí ležet tam, kam patří podle rozvržení sloupců — tím se
     * ověří i to, že mapa sloupec → pixel sedí (Bresenham) a že je obraz
     * orientovaný správně (nejnovější vpravo). */
    ok('jasný blok leží tam, kam patří podle rozvržení sloupců',
      Math.abs(j.blockLeft - j.expectedBlockLeft) <= 2 && Math.abs(j.blockRight - j.expectedBlockRight) <= 2,
      `blok ${j.blockLeft}–${j.blockRight}, čekáno ${j.expectedBlockLeft}–${j.expectedBlockRight}`);
    ok('nejnovější zvuk je vpravo (blok sahá k pravému okraji obrazu)',
      j.expectedBlockRight > j.canvas.x1 - 8 && j.rightEdgePainted > j.darkVal + 30,
      `blok končí na ${j.blockRight}, obraz na ${j.canvas.x1}, světlost u okraje ${j.rightEdgePainted?.toFixed(1)}`);

    /* Posun okna: nový sloupec musí obraz posunout DOLEVA o svou šířku. Kdyby
     * se jen přemalovával, živý spektrogram by v čase nic neukazoval. */
    ok('nový sloupec posune obraz doleva o svou šířku',
      Math.abs(j.moved - j.movedExpected) < Math.max(3, j.colW * 2),
      `posunuto o ${j.moved} px, očekáváno ${j.movedExpected?.toFixed(1)} px (sloupec ${j.colW?.toFixed(2)} px)`);

    ok('osa kmitočtů má popisky rozložené po celé výšce',
      j.labels && j.labels.length >= 6 && j.labelSpan > (j.canvas.y1 - j.canvas.y0) * 0.85,
      `y: ${j.labels?.join(', ')}`);

    /* Hlášení o ustalování měřítka musí být vidět jen dokud se měřítko
     * opravdu ustaluje — jinak by uživatele mástilo. */
    ok('hlášení „měřítko se ustaluje“ se objeví, když se ustaluje',
      j.warmPixels > 40, `${j.warmPixels} px`);
    ok('hlášení zmizí, když je měřítko ustálené', j.warmAfter === 0, `${j.warmAfter} px`);
  }
} finally {
  server.kill();
}

console.log(`\n═══ ŽIVÝ SPEKTROGRAM: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
