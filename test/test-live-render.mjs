#!/usr/bin/env node
/**
 * Kontrola SKUTEČNÉHO vykreslení živého indikátoru v prohlížeči.
 *
 * Mock canvasu nestačí: chyby typu „ručička se posunula o 0 px" nebo
 * „obsah sražený do čtvrtiny plátna na dsf 2" se poznají jen ze skutečných
 * pixelů. Test proto spustí headless Chromium, nechá ho vykreslit
 * kontrola-live.html a čte, KDE na plátně opravdu která barva leží.
 *
 * Použití: node test/test-live-render.mjs
 * (vyžaduje chromium-browser; když není, test se přeskočí, ne selže)
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Matematika osy se bere ze STEJNÉHO modulu, jaký používá kresba — test tak
// porovnává skutečné pixely s očekávanou polohou podle měřítka, ne s ručně
// opsanými indexy (ty jsem si napoprvé přečetla obráceně a test lhal).
const { sprOffset, sprTicks } = await import('../src/live-charts.js');

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8139;

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

/* ── server ──────────────────────────────────────────────────────────────── */

const server = spawn('node', ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(1500);

/** Spustí prohlížeč s danou hustotou displeje a vrátí text ze #out. */
function render(dsf) {
  const r = spawnSync('chromium-browser', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--force-device-scale-factor=${dsf}`,
    '--virtual-time-budget=9000',
    '--dump-dom',
    `http://localhost:${PORT}/kontrola-live.html`,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000 });

  const dom = r.stdout || '';
  const m = dom.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/);
  const text = m ? m[1].replace(/<[^>]*>/g, '').trim() : '';
  const hdr = (dom.match(/<h3 id="hdr">([^<]*)</) || [])[1] || '';
  return { text, hdr };
}

try {
  for (const dsf of [1, 2]) {
    console.log(`\n═══ Vykreslení při devicePixelRatio ${dsf} ═══\n`);
    const { text, hdr } = render(dsf);

    if (hdr.startsWith('CHYBA')) {
      ok('stránka proběhla bez chyby', false, hdr);
      console.log(text);
      continue;
    }
    ok('stránka proběhla bez chyby', hdr === 'HOTOVO', hdr);

    const j = JSON.parse((text.match(/VÝSLEDKY (\{.*\})/) || [])[1] || '{}');
    const num = (s) => { const m = text.match(new RegExp(s + '[^\\n]*?x≈(\\d+)')); return m ? +m[1] : NaN; };

    /* ── ručička ladění ──
       Vše se poměřuje VŮČI ŠÍŘCE PLÁTNA, ne v pevných pixelech: plátna jsou
       responzivní, takže na jiné hustotě displeje vyjde stejně správná kresba
       na jiných pixelech. (Přesně na tomhle mi test napoprvé selhal.) */
    const c1w = j.canvases.c1[0];
    const mid = c1w / 2;
    // 50 centů odpovídá polovině šířky grafu bez okrajů: padX = 10 CSS px
    const c1wCss = c1w / (c1w > 800 ? 2 : 1);
    const halfRange = (c1wCss - 20) / 2 * (c1w / c1wCss);

    /** Převede x na centy podle skutečné geometrie plátna. */
    const toCents = (x) => ((x - mid) / halfRange) * 50;

    const c0 = num('ladění 0 centů');
    const cL = num('ladění -38 centů');
    const cR = num('ladění \\+38 centů');
    const cM = num('ladění 25 centů');

    ok('0 centů je ve středu plátna', Math.abs(c0 - mid) < c1w * 0.03,
      `${c0} vs střed ${mid}`);
    ok('-38 centů vyšlo jako -38 c', Math.abs(toCents(cL) + 38) < 4, `${toCents(cL).toFixed(1)} c`);
    ok('+38 centů vyšlo jako +38 c', Math.abs(toCents(cR) - 38) < 4, `${toCents(cR).toFixed(1)} c`);
    ok('25 centů vyšlo jako +25 c', Math.abs(toCents(cM) - 25) < 4, `${toCents(cM).toFixed(1)} c`);
    ok('krajní hodnoty jsou od středu stejně daleko',
      Math.abs((c0 - cL) - (cR - c0)) < c1w * 0.03, `${c0 - cL} vs ${cR - c0}`);

    ok('v tichu ručička nesvítí zeleně', j.tuneSilentGreen === 0, `zelených ${j.tuneSilentGreen}`);
    ok('v tichu je plátno i tak popsané', j.tuneSilent?.drawn > 1000, `${j.tuneSilent?.drawn} px`);

    /* ── SPR historie ── */
    const c2w = j.canvases.c2[0];
    ok('SPR čára se kreslí', j.sprLine?.n > 200, `${j.sprLine?.n} px`);
    ok('SPR čára vede přes celou šířku',
      j.sprLine?.minX < c2w * 0.08 && j.sprLine?.maxX > c2w * 0.9,
      `x ${j.sprLine?.minX}–${j.sprLine?.maxX} z ${c2w}`);
    ok('rozkmitaná historie dá vyšší rozsah než plochá',
      (j.sprLine.maxY - j.sprLine.minY) > 3 * (j.sprFlat.maxY - j.sprFlat.minY),
      `rozkmit ${j.sprLine.maxY - j.sprLine.minY} px vs plochá ${j.sprFlat.maxY - j.sprFlat.minY} px`);

    /* ── osa SPR: pásmo −20…−10 dB musí být roztažené ──
       Tohle je jádro celé úpravy: stejných 10 dB musí v pásmu zabrat výrazně
       víc místa než mimo něj, jinak je okno, kde se zpěv opravdu pohybuje,
       zase tenká čára. Lineární rozsah dá obojí stejné → test to odhalí. */
    const spanBand = j.sprBandSpan.maxY - j.sprBandSpan.minY;
    const spanBelow = j.sprBelowSpan.maxY - j.sprBelowSpan.minY;
    ok('10 dB v pásmu −20…−10 zabírá víc místa než 10 dB pod ním',
      spanBand > spanBelow * 2,
      `pásmo ${spanBand} px vs mimo ${spanBelow} px`);
    // 55 % výšky na 10 dB v pásmu proti 25 % na 20 dB pod ním → 4,4×
    ok('roztažení odpovídá záměru (~4,4×)', Math.abs(spanBand / spanBelow - 4.4) < 1.5,
      `poměr ${(spanBand / spanBelow).toFixed(2)}×`);

    /* Popisky osy musí ležet přesně podle nelineárního měřítka. Indexovat je
       ručně se nevyplácí (napoprvé jsem si je přečetla obráceně) — spočítá se
       očekávaná poloha ze stejné funkce, kterou používá kresba. */
    const tickDbs = sprTicks().map(t => t.db).sort((a, b) => b - a);   // shora dolů
    const ys = j.sprGrid.labels;
    ok('osa má popisek pro každou linku', ys.length === tickDbs.length && j.sprGrid.rows === tickDbs.length,
      `popisků ${ys.length}, linek ${j.sprGrid.rows}, očekáváno ${tickDbs.length}`);
    const span = ys[ys.length - 1] - ys[0];
    let maxErr = 0;
    tickDbs.forEach((db, i) => { maxErr = Math.max(maxErr, Math.abs(ys[0] + sprOffset(db) * span - ys[i])); });
    ok('popisky osy leží podle nelineárního měřítka', maxErr <= 2,
      `největší odchylka ${maxErr.toFixed(1)} px (${tickDbs.join(', ')} dB)`);
    // Roztažení pásma zhušťuje zbytek osy — popisky se nesmí překrýt. Oko to
    // na grafu nepozná, ale číslo ano (nejmenší rozestup musí unést výšku textu).
    ok('popisky osy se nepřekrývají', Math.min(...j.sprLabelGaps) >= 11,
      `rozestupy ${j.sprLabelGaps.join(', ')} px`);
    // −15 dB musí ležet uvnitř roztaženého pásma, ne na jeho okraji
    const yMid = ys[tickDbs.indexOf(-15)];
    ok('−15 dB leží uvnitř roztaženého pásma',
      j.sprBandSpan.minY < yMid && yMid < j.sprBandSpan.maxY,
      `−15 dB v ${yMid}, pásmo ${j.sprBandSpan.minY}–${j.sprBandSpan.maxY}`);
    // horní okraj plátna není přiříznutý: −40 nesmí ležet na y=0
    ok('krajní hodnoty zůstávají uvnitř grafu',
      j.sprLine.minY > 0 && j.sprLine.maxY < c2w * 0 + (j.canvases.c2[1] || 1e9),
      `y ${j.sprLine.minY}–${j.sprLine.maxY} z výšky ${j.canvases.c2[1]}`);

    /* ── úroveň ── */
    const c3w = j.canvases.c3[0];
    const wOk = j.lvlOk.maxX - j.lvlOk.minX;
    const wLow = j.lvlLow.maxX - j.lvlLow.minX;
    const wHot = j.lvlHot.maxX - j.lvlHot.minX;
    ok('silnější signál = delší pruh', wHot > wOk && wOk > wLow,
      `-6 dB: ${wHot} px, -22 dB: ${wOk} px, -55 dB: ${wLow} px`);
    // -22 dB leží 22/60 rozsahu od nuly; -55 dB leží 55/60 → rozdíl ~55 %
    ok('délka pruhu odpovídá úrovni (55 % rozsahu mezi -55 a -22 dB)',
      Math.abs((wOk - wLow) / c3w - (55 - 22) / 60) < 0.08,
      `${((wOk - wLow) / c3w * 100).toFixed(1)} % plátna`);
    ok('v tichu pruh nesvítí', j.lvlSilent.green === 0 && j.lvlSilent.red === 0,
      `zelených ${j.lvlSilent.green}, červených ${j.lvlSilent.red}`);

    /* ── FHE ── */
    const c4w = j.canvases.c4[0];
    const fOk = j.fheOk.cx, fLow = j.fheLow.cx, fHigh = j.fheHigh.cx;
    ok('nižší FHE je víc vlevo', fLow < fOk, `${fLow} < ${fOk}`);
    ok('vyšší FHE je víc vpravo', fHigh > fOk, `${fHigh} > ${fOk}`);
    // 2000 až 3600 Hz na šířku plátna: 2200 Hz ≈ 12,5 %, 3400 Hz ≈ 87,5 %
    ok('poloha FHE odpovídá frekvenci',
      Math.abs((fLow / c4w - 0.125)) < 0.06 && Math.abs((fHigh / c4w - 0.875)) < 0.06,
      `2200 Hz na ${(fLow / c4w * 100).toFixed(1)} %, 3400 Hz na ${(fHigh / c4w * 100).toFixed(1)} %`);

    /* ── nic nespadlo do rožku (past s putImageData na dsf > 1) ── */
    ok('obsah není sražený do levé poloviny (past s dsf)',
      j.sprLine.maxX > c2w * 0.75 && fHigh > c4w * 0.75,
      `SPR maxX ${j.sprLine.maxX}/${c2w}, FHE ${fHigh}/${c4w}`);
  }

  console.log(`\n═══ VYKRESLENÍ: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
} finally {
  server.kill('SIGKILL');
}

process.exit(fails ? 1 : 0);
