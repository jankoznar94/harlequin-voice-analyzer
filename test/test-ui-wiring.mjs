#!/usr/bin/env node
/**
 * Statická kontrola propojení UI ↔ HTML.
 *
 * Prohlížeč tu není k dispozici, takže tohle chytá nejčastější třídu chyb:
 * app.js se odkazuje na prvek, který v index.html neexistuje (nebo naopak
 * zůstal osiřelý). Přesně takhle vznikne "$(...) is null" v konzoli.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const charts = fs.readFileSync(path.join(root, 'src/charts.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
// Živý režim ovládá vlastní moduly. Bez nich by test hlásil všechny prvky
// živého indikátoru jako osiřelé, i když je live-ui.js skutečně používá.
const liveUi = fs.readFileSync(path.join(root, 'src/live-ui.js'), 'utf8');
const liveRun = fs.readFileSync(path.join(root, 'src/live-run.js'), 'utf8');
const liveCharts = fs.readFileSync(path.join(root, 'src/live-charts.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('\n═══ 1. ID použité v app.js existují v HTML ═══');
const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const idsUsed = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
// živý režim sahá na prvky ze svých modulů
for (const src of [liveUi, liveRun]) {
  for (const m of src.matchAll(/\$\('([^']+)'\)/g)) idsUsed.add(m[1]);
  for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) idsUsed.add(m[1]);
}
// id v cacheEls() jsou zapsaná jako  'klic: $("id")'  — regex výše je chytí taky
const missing = [...idsUsed].filter(id => !idsInHtml.has(id));
check(`všech ${idsUsed.size} použitých ID existuje`, missing.length === 0,
  missing.length ? 'chybí: ' + missing.join(', ') : '');

console.log('\n═══ 2. Osiřelé prvky v HTML (nikdo je nepoužívá) ═══');
// ID se používají i dynamicky: $(id + '-s') v setKpi() vytváří <id>-s.
// Ta ověřuje test 3, tady je ber jako použité.
const kpiDyn = new Set();
for (const m of app.matchAll(/setKpi\('([^']+)'/g)) { kpiDyn.add(m[1]); kpiDyn.add(m[1] + '-s'); }
const usedLoose = (id) =>
  kpiDyn.has(id) || app.includes(id) || charts.includes(id) || sw.includes(id) ||
  liveUi.includes(id) || liveRun.includes(id) || liveCharts.includes(id);
const orphanReal = [...idsInHtml].filter(id => !usedLoose(id));
check('žádné osiřelé ID', orphanReal.length === 0,
  orphanReal.length ? 'osiřelé: ' + orphanReal.join(', ') : '');

console.log('\n═══ 3. Dynamicky vytvářené prvky mají svůj protějšek ═══');
// KPI: app nastavuje <id>, <id>-s (popisek) a <id>-d (lidské vysvětlení)
const kpiBases = [...app.matchAll(/setKpi\('([^']+)'/g)].map(m => m[1]);
const kpiMissing = [];
for (const b of new Set(kpiBases)) {
  if (!idsInHtml.has(b)) kpiMissing.push(b);
  if (!idsInHtml.has(b + '-s')) kpiMissing.push(b + '-s');
}
check(`KPI ${[...new Set(kpiBases)].length} párů (hodnota + popisek)`, kpiMissing.length === 0,
  kpiMissing.length ? 'chybí: ' + kpiMissing.join(', ') : '');

// Popisky -d: app je předává jako 5. argument setKpi. Každý musí v HTML existovat,
// jinak uživatel u ukazatele nevidí žádné vysvětlení (a to je celý smysl).
// POZOR: nejde použít setKpi\([^)]*?… — argumenty obsahují vnořené závorky
// (např. ringPct.toFixed(0)), takže se hledá rovnou ID v celém app.js.
const kpiDesc = [...app.matchAll(/'(k-[\w-]+-d)'/g)].map(m => m[1]);
const descMissing = [...new Set(kpiDesc)].filter(id => !idsInHtml.has(id));
check(`${new Set(kpiDesc).size} popisků s vysvětlením existuje`, descMissing.length === 0,
  descMissing.length ? 'chybí: ' + descMissing.join(', ') : '');
check('každý ukazatel má i lidské vysvětlení',
  new Set(kpiBases).size === new Set(kpiDesc).size,
  `${new Set(kpiBases).size} ukazatelů vs ${new Set(kpiDesc).size} vysvětlení`);

// Sloupce tabulky: hlavička a tělo musí mít stejný počet sloupců, jinak se
// tabulka rozjede a čísla sedí pod špatnými názvy.
{
  const thead = html.match(/<table id="t-notes">[\s\S]*?<\/thead>/);
  const thCount = thead ? (thead[0].match(/<th>/g) || []).length : 0;
  const rowBlock = app.match(/tbody'\)[\s\S]*?tb\.append\(tr\)/);
  let cellCount = 0;
  if (rowBlock) {
    const body = rowBlock[0];
    cellCount = (body.match(/cell\(/g) || []).length
      + (body.match(/Object\.assign\(document\.createElement\('td'\)/g) || []).length
      + (body.match(/tr\.append\(ring,/g) || []).length
      + (body.match(/^\s*ring,$/gm) || []).length;
  }
  check(`tabulka: ${thCount} sloupců v hlavičce = ${cellCount} v řádku`,
    thCount > 0 && thCount === cellCount);
}

console.log('\n═══ 4. Canvas elementy, na které se kreslí ═══');
const canvases = [...app.matchAll(/draw\w+\(\$\('([^']+)'\)/g)].map(m => m[1]);
const canvasMissing = canvases.filter(id => !idsInHtml.has(id));
check(`${canvases.length} canvasů existuje`, canvasMissing.length === 0,
  canvasMissing.length ? 'chybí: ' + canvasMissing.join(', ') : '');
for (const id of canvases) {
  const isCanvas = new RegExp(`<canvas[^>]*id="${id}"`).test(html);
  check(`  #${id} je <canvas>`, isCanvas);
}

console.log('\n═══ 5. Service worker cachuje soubory, které existují ═══');
const swAssets = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]).filter(a => a !== '');
const swMissing = swAssets.filter(a => !fs.existsSync(path.join(root, a)));
check(`${swAssets.length} assetů v cache existuje`, swMissing.length === 0,
  swMissing.length ? 'chybí: ' + swMissing.join(', ') : '');

console.log('\n═══ 6. Vše, co index.html načítá, existuje ═══');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map(m => m[1].split('?')[0])
  .filter(u => !u.startsWith('http') && !u.startsWith('data:') && !u.startsWith('#'));
const refMissing = refs.filter(r => !fs.existsSync(path.join(root, r)));
check(`${refs.length} odkazů ze stránky`, refMissing.length === 0,
  refMissing.length ? 'chybí: ' + refMissing.join(', ') : '');

console.log('\n═══ 7. Importy v modulech sedí na soubory ═══');
for (const file of ['src/app.js', 'src/charts.js', 'src/analysis.js']) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const imports = [...src.matchAll(/from\s+'(\.[^']+)'/g)].map(m => m[1]);
  const bad = imports.filter(i => !fs.existsSync(path.join(root, path.dirname(file), i)));
  check(`${file}: ${imports.length} importů`, bad.length === 0,
    bad.length ? 'chybí: ' + bad.join(', ') : '');
}

console.log('\n═══ 8. Exportované funkce, které se importují ═══');
const analysisSrc = fs.readFileSync(path.join(root, 'src/analysis.js'), 'utf8');
// \w+ nestačí — `export { fmt }` má jiný tvar, tak chyť i ten
const exportsOf = (src) => {
  const s = new Set([...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/g)]
    .map(m => m[1]));
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) s.add(part.trim().split(/\s+as\s+/).pop().trim());
  }
  return s;
};
const analysisExports = exportsOf(analysisSrc);
const fromAnalysis = [...app.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/analysis\.js'/g)]
  .flatMap(m => m[1].split(',').map(s => s.trim()));
const badExp = fromAnalysis.filter(e => e && !analysisExports.has(e));
check(`app.js importuje ${fromAnalysis.length} věcí z analysis.js`, badExp.length === 0,
  badExp.length ? 'neexportuje se: ' + badExp.join(', ') : '');

const chartExports = exportsOf(charts);
const fromCharts = [...app.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/charts\.js'/g)]
  .flatMap(m => m[1].split(',').map(s => s.trim()));
const badChart = fromCharts.filter(e => e && !chartExports.has(e));
check(`app.js importuje ${fromCharts.length} věcí z charts.js`, badChart.length === 0,
  badChart.length ? 'neexportuje se: ' + badChart.join(', ') : '');

console.log(`\n═══ ${pass} prošlo, ${fail} selhalo ═══`);
if (fail) console.log('\nUI by v prohlížeči hlásilo chyby.');
process.exitCode = fail ? 1 : 0;
