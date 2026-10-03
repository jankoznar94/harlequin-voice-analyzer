/**
 * Test tlačítka „zkontrolovat novou verzi" (service worker update).
 *
 * Headless Chromium v tomto prostředí service workery nespouští, takže se
 * netestuje přes prohlížeč, ale přes mock `navigator.serviceWorker`. Test
 * prožene SKUTEČNÝ kód z app.js (init → registerSW → klik na tlačítko), ne
 * jeho kopii — jinak by testoval něco jiného, než co běží v aplikaci.
 *
 * Hlídá tři chyby, které se v této logice dělají nejčastěji:
 *  1. `update()` se vrátí dřív, než se nový worker objeví → čtení
 *     `registration.installing` hned po něm je null a kód hlásí „aktuální",
 *     i když nová verze existuje. Musí se čekat na `updatefound`.
 *  2. Reload dřív, než nový worker převezme kontrolu → stránka se načte
 *     znovu ze STARÉ cache a uživatel vidí totéž.
 *  3. Když nic nového není, nesmí se reloadovat ani věčně točit spinner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(DIR, '..', 'src', 'app.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── mock DOM ──────────────────────────────────────────────────────────── */

function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', disabled: false,
    onclick: null, onchange: null, className: '', files: [], style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    append() {}, appendChild() {}, remove() {},
    querySelector: () => makeEl('child'), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    getContext: () => null,
    clientWidth: 800, clientHeight: 300, width: 800, height: 300,
  };
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

globalThis.document = {
  readyState: 'complete',
  getElementById: (id) => el(id),
  createElement: (tag) => makeEl(tag),
  addEventListener() {}, querySelectorAll: () => [], body: makeEl('body'),
};
globalThis.window = {
  devicePixelRatio: 1, addEventListener() {}, scrollTo() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  AudioContext: class { close() { return Promise.resolve(); } },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.alert = () => {};

let reloadCount = 0;
Object.defineProperty(globalThis, 'location', {
  value: { reload: () => { reloadCount++; }, search: '', href: 'http://x/' },
  writable: true, configurable: true,
});

/* ── mock service workeru ──────────────────────────────────────────────── */

function makeWorker() {
  const listeners = [];
  return {
    state: 'installing', received: null,
    postMessage(msg) { this.received = msg; },
    addEventListener(type, fn) { if (type === 'statechange') listeners.push(fn); },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
    },
    _to(state) { this.state = state; listeners.slice().forEach((fn) => fn({ target: this })); },
  };
}

/**
 * Jediná registrace pro celý test. app.js si ji zapamatuje při registraci,
 * takže ji NELZE vyměnit za jinou — mění se jen to, jak se zachová `update()`,
 * přes `updateBehaviour`. (Vyměnit celý objekt byl omyl: app.js by dál držel
 * ten původní a testy by potichu běžely proti němu.)
 */
let updateBehaviour = async () => {};

const reg = {
  waiting: null, installing: null, scope: 'http://x/',
  _updatefound: [],
  update() { return updateBehaviour(reg); },
  addEventListener(type, fn) { if (type === 'updatefound') reg._updatefound.push(fn); },
  removeEventListener(type, fn) { reg._updatefound = reg._updatefound.filter((f) => f !== fn); },
  _emitUpdatefound() { reg._updatefound.slice().forEach((fn) => fn({ target: reg })); },
  _reset() { reg.waiting = null; reg.installing = null; reg._updatefound = []; },
};

const swListeners = {};
const swMock = {
  controller: { scriptURL: 'http://x/sw.js' },
  register: async () => reg,
  addEventListener(type, fn) { (swListeners[type] ||= []).push(fn); },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { serviceWorker: swMock }, writable: true, configurable: true,
});

/* ── načtení skutečného app.js (init se spustí sám) ────────────────────── */

await import('file://' + APP + '?t=' + Date.now());
await sleep(30);   // nechat doběhnout registerSW()

const clickUpdate = () => el('btn-update').onclick();
const toastText = () => el('toast').textContent;
const isSpinning = () => el('upd-icon').innerHTML.includes('spinner');
const emit = (type) => (swListeners[type] || []).slice().forEach((fn) => fn({}));

console.log('\n═══ Tlačítko aktualizace (service worker) ═══\n');

check('tlačítko má přiřazenou akci', typeof el('btn-update').onclick === 'function');

/* ── 1. nová verze na serveru ───────────────────────────────────────────── */

{
  reg._reset();
  const worker = makeWorker();
  updateBehaviour = async (r) => {
    // Přesně jako prohlížeč: update() se vrátí hned, nový worker se objeví
    // až o chvíli později přes 'updatefound'. Na tomhle se dá snadno spálit —
    // čtení `r.installing` hned po update() je null a kód by lživě ohlásil,
    // že je aplikace aktuální.
    setTimeout(() => { r.installing = worker; r._emitUpdatefound(); }, 80);
    // Assety se stáhnou a worker se překlopí do 'installed'; prohlížeč ho
    // zároveň zařadí do `waiting` (starý worker pořád kontroluje stránku).
    setTimeout(() => { worker._to('installed'); r.waiting = worker; }, 250);
  };

  const p = clickUpdate();
  await sleep(30);
  check('během kontroly se točí spinner', isSpinning());
  check('tlačítko je po dobu kontroly neaktivní', el('btn-update').disabled === true);

  await sleep(250);
  check('dokud se assety stahují, reload neproběhne', reloadCount === 0,
    `reloadů: ${reloadCount}`);

  await sleep(200);
  check('nový worker nalezen i přes zpožděný updatefound',
    worker.received && worker.received.type === 'SKIP_WAITING',
    worker.received ? 'posláno SKIP_WAITING' : 'SKIP_WAITING neposláno');
  check('reload ještě neproběhl (čeká se na controllerchange)', reloadCount === 0,
    `reloadů: ${reloadCount}`);

  // Teprve teď prohlížeč ohlásí, že nový worker převzal kontrolu
  emit('controllerchange');
  // Reload je záměrně ODLOŽENÝ, aby uživatel stihl vidět potvrzení.
  await sleep(400);
  check('reload se odloží, aby bylo potvrzení vidět', reloadCount === 0,
    `reloadů po 400 ms: ${reloadCount}`);
  check('potvrzení je vidět i po skončení kontroly', !el('toast').classList.contains('hidden'),
    'toast: ' + JSON.stringify(toastText()));
  check('potvrzení zmiňuje aktualizaci', toastText().includes('Aktualizováno'),
    'toast: ' + JSON.stringify(toastText()));

  await sleep(1200);
  check('reload proběhl až po controllerchange', reloadCount === 1, `reloadů: ${reloadCount}`);

  await p;
  await sleep(50);
  check('spinner po dokončení zmizí', isSpinning() === false);
  check('tlačítko je zase aktivní', el('btn-update').disabled === false);
}

/* ── 1b. spinner musí být vidět i u běžné kontroly (ne jen bliknout) ─────── */

{
  reg._reset();
  updateBehaviour = async () => {};      // žádná nová verze
  const p = clickUpdate();
  await sleep(100);
  check('spinner se ukáže hned po kliku', isSpinning() === true);
  await sleep(3200);
  check('u aktuální verze spinner chvíli vydrží, ne jen blikne',
    /minSpinnerMs/.test(fs.readFileSync(APP, 'utf8')),
    'kód musí spinner podržet minimální dobu');
  await p;
}

/* ── 1c. verze aplikace musí být dohledatelná ────────────────────────────── */

{
  // Bez zobrazené verze nemá uživatel po aktualizaci jak zjistit, že proběhla.
  const appSrc = fs.readFileSync(APP, 'utf8');
  const swSrc = fs.readFileSync(path.join(DIR, '..', 'sw.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(DIR, '..', 'index.html'), 'utf8');

  check('index.html má prvek pro verzi', /id="app-ver"/.test(htmlSrc),
    'chybí #app-ver v index.html');
  check('sw.js nese APP_VERSION', /APP_VERSION\s*=/.test(swSrc),
    'sw.js musí mít APP_VERSION');
  check('APP_VERSION odpovídá číslu v CACHE',
    (() => {
      const cv = (swSrc.match(/const CACHE = 'vocal-lab-v(\d+)'/) || [])[1];
      const av = (swSrc.match(/APP_VERSION\s*=\s*'([0-9.]+)'/) || [])[1];
      return !!cv && av === '1.0.' + cv;                 // v9 → 1.0.9
    })(),
    'APP_VERSION musí odpovídat CACHE (v9 → 1.0.9)');
  check('verze se načítá ze serveru, ne z běžícího skriptu',
    /cache:\s*['"]no-store['"]/.test(appSrc) && /fetchVersionOf\(['"]sw\.js['"]\)/.test(appSrc),
    'verze se musí číst z sw.js s cache: no-store');
  check('verze se zobrazí při startu aplikace', /showVersions\(\)/.test(appSrc),
    'showVersions() se musí volat po registraci');
  check('reload má odklad aspoň 300 ms',
    /setTimeout\(\(\)\s*=>\s*location\.reload\(\),\s*\d{3,}/.test(appSrc),
    'reload musí mít odklad, aby hláška byla vidět');
}

/* ── 2. nic nového na serveru ───────────────────────────────────────────── */

{
  reg._reset();
  updateBehaviour = async () => {};      // update() nic nenajde
  const beforeReloads = reloadCount;
  const beforeListeners = (swListeners.controllerchange || []).length;

  const p = clickUpdate();
  // Čekání na updatefound má v aplikaci limit 3 s — test musí počkat na něj.
  await sleep(3200);
  check('bez nové verze se ohlásí, že je aktuální',
    toastText().includes('nejnovější'), 'toast: ' + JSON.stringify(toastText()));
  check('bez nové verze spinner zmizí', isSpinning() === false);
  check('bez nové verze se neregistruje reload',
    (swListeners.controllerchange || []).length === beforeListeners);
  check('bez nové verze se nereloaduje', reloadCount === beforeReloads);
  await p;
}

/* ── 3. druhé kliknutí během kontroly nic nerozbije ─────────────────────── */

{
  reg._reset();
  let updateCalls = 0;
  const worker = makeWorker();
  updateBehaviour = async (r) => {
    updateCalls++;
    setTimeout(() => { r.waiting = worker; }, 150);
  };
  const p1 = clickUpdate();
  await sleep(20);
  const p2 = clickUpdate();     // musí se ignorovat, ne spustit druhou kontrolu
  await sleep(400);
  check('dvojklik nespustí dvě kontroly', updateCalls === 1, `update() voláno ${updateCalls}×`);
  await p1; await p2;
}

/* ── 4. chyba při kontrole ──────────────────────────────────────────────── */

{
  reg._reset();
  updateBehaviour = async () => { throw new Error('síť je pryč'); };
  const p = clickUpdate();
  await sleep(80);
  check('při chybě se spinner zastaví', isSpinning() === false);
  check('při chybě se uživatel dozví', toastText().includes('nepodařilo'),
    'toast: ' + JSON.stringify(toastText()));
  await p;
}

/* ── 5. stahování uvázne — nesmí viset ve spinneru navždy ──────────────── */

{
  reg._reset();
  const worker = makeWorker();          // zůstane navěky v 'installing'
  updateBehaviour = async (r) => { r.installing = worker; };

  const p = clickUpdate();
  await sleep(120);
  check('během stahování se točí spinner', isSpinning());

  // Zkrácený časový limit: v aplikaci je 20 s, tady se čeká stejně,
  // ale test si na něj nesmí sáhnout — ověřuje se jen to, že limit existuje.
  const src = fs.readFileSync(APP, 'utf8');
  check('waitForInstalled má časový limit', /waitForInstalled\(worker,\s*timeoutMs\s*=\s*\d+/.test(src));
  check('limit je rozumný (5–60 s)', (() => {
    const m = src.match(/waitForInstalled\(worker,\s*timeoutMs\s*=\s*(\d+)/);
    return m && +m[1] >= 5000 && +m[1] <= 60000;
  })());
  worker._to('installed');              // stahování doběhne
  await p;
  check('po doinstalování spinner zmizí', isSpinning() === false);
}

/* ── 6. service worker a HTML/CSS ───────────────────────────────────────── */

{
  const sw = fs.readFileSync(path.join(DIR, '..', 'sw.js'), 'utf8');
  check('sw.js poslouchá na SKIP_WAITING', /SKIP_WAITING/.test(sw) && /skipWaiting/.test(sw));
  // install nesmí volat skipWaiting — jinak by se nová verze aktivovala sama
  // a tlačítko by nemělo co dělat. Hlídá se jen tělo install handleru.
  const installHandler = sw.match(/addEventListener\('install'[\s\S]*?\n\}\);/);
  check('sw.js se sám neaktivuje při instalaci (čeká na tlačítko)',
    installHandler && !/skipWaiting/.test(installHandler[0]),
    installHandler ? 'tělo install handleru zkontrolováno' : 'install handler nenalezen');
  check('sw.js po aktivaci převezme kontrolu', /clients\.claim/.test(sw));

  const html = fs.readFileSync(path.join(DIR, '..', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(DIR, '..', 'src', 'style.css'), 'utf8');
  check('index.html má #btn-update', /id="btn-update"/.test(html));
  check('index.html má #upd-icon', /id="upd-icon"/.test(html));
  check('index.html má #toast', /id="toast"/.test(html));
  check('CSS zná .spinner', /\.spinner\s*\{/.test(css));
  check('CSS zná .toast', /\.toast\s*\{/.test(css));
  check('tlačítko nemá hover efekt (mobilní PWA)', !/\.btn:hover|\.icon:hover/.test(css));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} Tlačítko aktualizace: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
