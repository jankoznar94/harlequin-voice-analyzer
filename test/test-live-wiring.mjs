#!/usr/bin/env node
/**
 * Statická kontrola propojení živého režimu (bez prohlížeče).
 *
 * Prohlížeč při vývoji není k dispozici, takže se ověřuje text souborů:
 * že každé volání `$('id')` má v HTML skutečný prvek, že každý import
 * někam vede a že se nezapomnělo na cache-busting nebo na service worker.
 *
 * Chytá to chyby, které se jinak projeví až uživateli: překlep v id prvku,
 * import neexistujícího souboru, zapomenutý asset v CACHE.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

const html = read('index.html');
const appJs = read('src/app.js');
const liveUi = read('src/live-ui.js');
const liveRun = read('src/live-run.js');
const liveJs = read('src/live.js');
const liveCharts = read('src/live-charts.js');
const dspBackend = read('src/dsp-backend.js');
const sw = read('sw.js');

/* ── 1. ID prvků ─────────────────────────────────────────────────────────── */

console.log('\n1. Každé volané id musí v HTML existovat\n');
{
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

  // id volané z live-ui.js
  const asked = new Set();
  for (const src of [liveUi, liveRun]) {
    for (const m of src.matchAll(/\$\('([^']+)'\)/g)) asked.add(m[1]);
    for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) asked.add(m[1]);
  }
  // id v cacheEls() jsou vypsaná v objektu, ne přes $() — vytáhni i ty
  for (const m of liveUi.matchAll(/^\s*(\w+): \$\('([^']+)'\)/gm)) asked.add(m[2]);

  let missing = 0;
  for (const id of asked) {
    if (!htmlIds.has(id)) { missing++; console.log(`     chybí prvek #${id}`); }
  }
  ok(`všech ${asked.size} volaných id existuje v HTML`, missing === 0, `${missing} chybí`);
}

/* ── 2. Importy ──────────────────────────────────────────────────────────── */

console.log('\n2. Importy musí vést na existující soubor a existující export\n');
{
  const files = { 'src/app.js': appJs, 'src/live-ui.js': liveUi, 'src/live-run.js': liveRun, 'src/dsp-backend.js': dspBackend, 'src/live-charts.js': liveCharts };
  let bad = 0;
  for (const [file, src] of Object.entries(files)) {
    const dir = path.dirname(path.join(ROOT, file));
    for (const m of src.matchAll(/from '(\.[^']+)'/g)) {
      const target = path.join(dir, m[1]);
      if (!fs.existsSync(target)) { bad++; console.log(`     ${file}: chybí ${m[1]}`); }
    }
  }
  ok('všechny relativní importy vedou na existující soubor', bad === 0, `${bad} chybí`);
}

/* ── 3. app.js odkazuje na živý režim ────────────────────────────────────── */

console.log('\n3. app.js musí živý režim opravdu zapojit\n');
{
  ok('app.js importuje initLive', /import\s*\{[^}]*initLive[^}]*\}\s*from\s*'\.\/live-ui\.js'/.test(appJs));
  ok('app.js volá initLive(v init)', /initLive\(/.test(appJs));
  ok('app.js umí uložit živé měření do historie', /function addLiveToHistory/.test(appJs));
  ok('záznam z živého měření je označen příznakem live', /live:\s*true/.test(appJs));
  ok('živý režim nepředstírá vyrovnanost ringu', /ring_pct:\s*null/.test(appJs));
}

/* ── 4. tlačítko ─────────────────────────────────────────────────────────── */

console.log('\n4. Tlačítko Živě\n');
{
  ok('HTML má tlačítko #btn-live', /id="btn-live"/.test(html));
  ok('HTML má sekci #panel-live', /id="panel-live"/.test(html));
  ok('HTML má tlačítko pro ukončení', /id="btn-live-stop"/.test(html));
  ok('HTML má tlačítko pro uložení', /id="btn-live-save"/.test(html));
  ok('live-ui zapojuje klik na tlačítko i na obě akce',
    /btnLive\.onclick/.test(liveUi) && /btnStop\.onclick/.test(liveUi) && /btnSave\.onclick/.test(liveUi));
}

/* ── 5. plátna ───────────────────────────────────────────────────────────── */

console.log('\n5. Plátna indikátoru\n');
{
  for (const id of ['c-live-tune', 'c-live-spr', 'c-live-level', 'c-live-fhe']) {
    ok(`HTML má plátno #${id}`, new RegExp(`id="${id}"`).test(html));
  }
  ok('live-charts kreslí všechny čtyři pohledy',
    /export function drawTuning/.test(liveCharts) &&
    /export function drawSprHistory/.test(liveCharts) &&
    /export function drawLevel/.test(liveCharts) &&
    /export function drawFhe/.test(liveCharts));
  ok('live-ui je skutečně volá',
    /drawTuning\(/.test(liveUi) && /drawSprHistory\(/.test(liveUi) &&
    /drawLevel\(/.test(liveUi) && /drawFhe\(/.test(liveUi));
}

/* ── 6. WASM jádro ───────────────────────────────────────────────────────── */

console.log('\n6. WASM jádro\n');
{
  ok('soubor jádra existuje', fs.existsSync(path.join(ROOT, 'wasm/build/dsp.wasm')));
  const size = fs.existsSync(path.join(ROOT, 'wasm/build/dsp.wasm'))
    ? fs.statSync(path.join(ROOT, 'wasm/build/dsp.wasm')).size : 0;
  ok('jádro má rozumnou velikost (< 100 kB)', size > 2000 && size < 100000, `${size} B`);
  ok('zdroj jádra existuje', fs.existsSync(path.join(ROOT, 'wasm/src/dsp.ts')));
  ok('backend umí spadnout na JS, když WASM není',
    /class JsDsp/.test(dspBackend) && /catch\s*\(e\)\s*\{[\s\S]{0,200}new JsDsp/.test(dspBackend));
  ok('backend zkouší WASM jen když prohlížeč umí WebAssembly',
    /typeof WebAssembly/.test(dspBackend));
}

/* ── 7. cache busting a service worker ───────────────────────────────────── */

console.log('\n7. Cache busting — bez něj uživatel uvidí starou verzi\n');
{
  const v = html.match(/app\.js\?v=(\d+)/);
  const vcss = html.match(/style\.css\?v=(\d+)/);
  ok('index.html má verzi u app.js', !!v, v ? `v=${v[1]}` : '');
  ok('index.html má verzi u style.css', !!vcss, vcss ? `v=${vcss[1]}` : '');
  ok('obě verze jsou stejné', v && vcss && v[1] === vcss[1],
    v && vcss ? `${v[1]} vs ${vcss[1]}` : '');

  const cache = sw.match(/const CACHE = '([^']+)'/);
  const appver = sw.match(/const APP_VERSION = '([^']+)'/);
  ok('sw.js má CACHE', !!cache, cache ? cache[1] : '');
  ok('sw.js má APP_VERSION', !!appver, appver ? appver[1] : '');

  // nové soubory musí být v ASSETS, jinak je offline režim nenačte
  for (const asset of ['src/live.js', 'src/live-ui.js', 'src/live-run.js', 'src/live-charts.js', 'src/dsp-backend.js']) {
    ok(`sw.js zahrnuje ${asset}`, sw.includes(asset));
  }
  ok('sw.js zahrnuje i wasm jádro', sw.includes('wasm/build/dsp.wasm'));
}

/* ── 8. zákazy z konvence projektu ───────────────────────────────────────── */

console.log('\n8. Konvence projektu\n');
{
  const all = [html, liveUi, liveRun, liveCharts, liveJs].join('\n');
  ok('žádné emoji v živém režimu', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(all));
  ok('žádný hover efekt v novém CSS',
    !/\.live-[^{]*:hover/.test(fs.readFileSync(path.join(ROOT, 'src/style.css'), 'utf8')));
  /* ⚠️ Zákaz `putImageData` NENÍ plošný — projekt sám ho používá (a musí,
   * protože buffer plněný v device px se na plátno dostane jen přes pomocné
   * plátno). Zakázané je VOLÁNÍ `putImageData` přímo na plátno GRAFU: to
   * ignoruje transformaci plátna a na dsf 2 srazí obsah do levé horní
   * čtvrtiny (naměřeno). Kresba obrazu v živém spektrogramu je proto vázaná
   * na `ctx.drawImage` z pomocného plátna. */
  // hledá se skutečné volání, ne zmínka v komentáři (ta je tu záměrně)
  const codeOnly = liveCharts.split('\n').filter(l => !/^\s*\*|^\s*\/\//.test(l)).join('\n');
  const putDirect = codeOnly.split('\n').filter(l => /\bctx\.putImageData\s*\(/.test(l)).join('\n');
  ok('žádné přímé putImageData na plátno grafu', putDirect === '', putDirect.trim().slice(0, 80));
  ok('obraz se na plátno dostává přes drawImage',
    /ctx\.drawImage\s*\(\s*st\.off/.test(codeOnly));
  ok('ručička ladění je v centech, ne v Hz', /cents/i.test(liveCharts) && !/hzToCents/.test(liveCharts));
}

console.log(`\n═══ PROPOJENÍ: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
