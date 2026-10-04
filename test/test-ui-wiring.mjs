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
// Záložky grafů a jejich panely app.js skládá z krátkých názvů
// (`$('tab-' + c)`, `$('pane-' + c)`, `$('c-' + …)`), takže se v textu
// jako `$('tab-spr')` vůbec nevyskytují. Bez tohohle je test hlásí jako osiřelé.
const tabIds = new Set();
for (const c of ['spr', 'spec', 'f1']) {
  tabIds.add('tab-' + c); tabIds.add('pane-' + c);
  tabIds.add('c-' + c); tabIds.add('c-' + c + '-head');
}
const usedLoose = (id) =>
  kpiDyn.has(id) || tabIds.has(id) ||
  app.includes(id) || charts.includes(id) || sw.includes(id) ||
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

console.log('\n═══ 9. Výběr souboru: accept nesmí poslat Android do záznamníku ═══');
{
  /* PROČ (reálná chyba u uživatele): Android mapuje `accept="audio/*"` na
   * systémovou akci „zaznamenej zvuk". Klepnutí na „Načíst soubor" pak
   * otevře aplikaci ZÁZNAMNÍKU v režimu nahrávání, kde se seznam nahrávek
   * jen přehraje — vybrat a vrátit se z něj nedá. Uživatel nemá jak dostat
   * existující nahrávku do aplikace.
   *
   * Test hlídá, že tam `accept` není zpátky. Kdyby ho někdo „opravil" zpět
   * (vypadá to jako ztráta funkce), tlačítko na Androidu přestane fungovat.
   */
  const m = html.match(/<input[^>]*id="file-input"[^>]*>/);
  const tag = m ? m[0] : '';
  check('file-input existuje', !!m, tag || '(nenalezen)');
  check('file-input NEMÁ accept (jinak ho Android pošle do záznamníku)',
    !!m && !/\baccept=/.test(tag), tag);
  check('file-input zůstává typu file', /type="file"/.test(tag), tag);
  // a tlačítko na něj musí pořád ukazovat
  check('label „Načíst soubor" ukazuje na file-input',
    /for="file-input"/.test(html), '');
}

console.log('\n═══ 10. Každý modul, který app.js importuje, je v service workeru ═══');
{
  /* Past, která se snadno stane: nový modul se přidá do app.js, ale ne do
   * ASSETS v sw.js. V prohlížeči to funguje (síť ho stáhne), ale OFFLINE
   * režim spadne na chybějícím modulu — a to se pozná až na telefonu bez
   * signálu. Proto se to hlídá staticky.
   */
  const swAssets = new Set([...sw.matchAll(/'(\.\/[^']+)'/g)].map(m => m[1].replace(/^\.\//, '')));
  const ownModules = [];
  for (const file of ['src/app.js', 'src/charts.js', 'src/analysis.js', 'src/live-ui.js',
                      'src/live-run.js', 'src/live-charts.js', 'src/live.js', 'src/dsp-backend.js',
                      'src/sample-rate.js']) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of src.matchAll(/from\s+'\.\/([^']+)'/g)) ownModules.push(m[1]);
  }
  const missingAssets = [...new Set(ownModules)].filter(m => !swAssets.has('src/' + m) && !swAssets.has(m));
  check(`všech ${new Set(ownModules).size} vlastních modulů je v ASSETS`, missingAssets.length === 0,
    missingAssets.length ? 'chybí v sw.js: ' + missingAssets.join(', ') : '');

  // a zpátky: co je v ASSETS, musí na disku existovat
  const missingFiles = [...swAssets].filter(a => a && !fs.existsSync(path.join(root, a)));
  check('všechny ASSETS na disku existují', missingFiles.length === 0,
    missingFiles.length ? 'chybí na disku: ' + missingFiles.join(', ') : '');

  // verze cache musí odpovídat ?v= v index.html
  const cacheV = (sw.match(/CACHE\s*=\s*'vocal-lab-v(\d+)'/) || [])[1];
  const htmlV = (html.match(/app\.js\?v=(\d+)/) || [])[1];
  const appV = (sw.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  check('CACHE, ?v= a APP_VERSION drží spolu',
    cacheV === htmlV && appV === '1.0.' + cacheV,
    `CACHE v${cacheV}, index v${htmlV}, APP_VERSION ${appV}`);
}

console.log('\n═══ 10. Výška panelů záložek: přepnutí nesmí posunout stránku ═══');
/* ⚠️ REGRESE, KTEROU UŽIVATEL VIDĚL: spektrogram měl vlastní výšku 300 px
 * (třída `.tall`), kdežto graf ringu 230 px. Přepnutí záložky tím posunulo
 * celý obsah POD panely o 70 px — přehrávač, čas i lištu — takže stránka
 * „uskakovala" vertikálně nahoru a dolů. Zdroj pravdy o výšce je `charts.js`
 * (`SPR_H`, `SPEC_H`, `F1_H`); HTML i CSS se podle něj musí řídit a stejnou
 * výšku musí mít i překryvné plátno ukazatele (`.chart-head`). */
{
  const num = (src, name) => Number((src.match(new RegExp(`${name} = (\\d+)`)) || [])[1]);
  const h = { spr: num(charts, 'SPR_H'), spec: num(charts, 'SPEC_H'), f1: num(charts, 'F1_H') };
  check(`panely mají stejnou výšku (spr ${h.spr} / spec ${h.spec} / f1 ${h.f1})`,
    h.spr === h.spec && h.spec === h.f1);

  const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
  /* Bere se podle ID, ne podle třídy — `#c-trend` má taky `class="chart"`
   * a v sekci by pletl počet i výšky. */
  const heightOf = (id) => {
    const m = html.match(new RegExp(`<canvas[^>]*id="${id}"[^>]*height="(\\d+)"`));
    return m ? Number(m[1]) : NaN;
  };
  const bases = ['c-spr', 'c-spec', 'c-f1'].map(heightOf);
  const heads = ['c-spr-head', 'c-spec-head', 'c-f1-head'].map(heightOf);
  check('HTML: překryvná plátna mají stejnou výšku jako grafy',
    heads.every((v, i) => Number.isFinite(v) && v === bases[i]),
    `grafy ${bases.join('/')} vs plátna ${heads.join('/')}`);
  check('HTML: výška pláten v HTML sedí na konstanty z charts.js',
    bases[0] === h.spr && bases[1] === h.spec && bases[2] === h.f1,
    `HTML ${bases.join('/')} vs kód ${h.spr}/${h.spec}/${h.f1}`);
  check('CSS nedrží vlastní výšku spektrogramu (třída .tall)',
    !/\.chart\.tall\b/.test(css) && !/\.chart-head\.tall\b/.test(css));
  check('CSS: plátno ukazatele má pevnou výšku 230 px (nesmí roztáhnout panel)',
    /\.chart-wrap \.chart-head \{[^}]*height: 230px/.test(css));
  /* ⚠️ `flow-root` je nutnost, ne kosmetika: bez něj se margin odstavců
   * v patičce slije s okrajem a unikne ven — naměřeno v prohlížeči 330/332/334 px
   * podle množství textu, takže se obsah pod grafy hýbal o 4 px. */
  check('CSS: patička panelu drží marginy uvnitř (display: flow-root)',
    /\.pane-foot \{[^}]*display: flow-root/.test(css));
  check('CSS: patička panelu má rezervovanou výšku (min-height)',
    /\.pane-foot \{[^}]*min-height: \d+px/.test(css));
  /* Text záložky musí být v patičce POD grafem — kdyby stál v HTML před
   * `.chart-wrap`, posunul by při přepnutí záložky graf svisle dolů. */
  const panes = ['spr', 'spec', 'f1'];
  const textAbove = panes.filter(c => {
    const block = html.match(new RegExp(`id="pane-${c}"[\\s\\S]*?</div>\\s*</div>|<div class="chart-pane[^>]*id="pane-${c}"[\\s\\S]*?<div class="chart-pane`));
    return block && /class="(hint|chart-legend)"[\s\S]*?class="chart-wrap"/.test(block[0]);
  });
  check('HTML: text v panelech stojí POD grafem (v .pane-foot)', textAbove.length === 0,
    textAbove.length ? 'nad grafem: ' + textAbove.join(', ') : '');
  check('HTML: každý panel má .pane-foot (stejná struktura)',
    panes.every(c => new RegExp(`id="pane-${c}"[\\s\\S]*?class="pane-foot"`).test(html)));
}

console.log(`\n═══ ${pass} prošlo, ${fail} selhalo ═══`);
if (fail) console.log('\nUI by v prohlížeči hlásilo chyby.');
process.exitCode = fail ? 1 : 0;
