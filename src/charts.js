/**
 * Vykreslování grafů na canvas — bez závislostí.
 * Tmavě neutrální paleta, žádný glow.
 */

const COL = {
  bg: '#231f1c', grid: '#3a3330', text: '#a89f97', textDim: '#7d746d',
  ok: '#6a9e6a', bad: '#b5675e', accent: '#b8894f',
  // Referenční linky: teplý neutrál. Dřív studená modrá (#6d7f9c) — do teplé
  // palety nepatřila a popisky byly navíc málo kontrastní.
  ref: '#8c8078',
  head: '#ece5dd',   // ukazatel přehrávání — světlý neutrál, čitelný přes sloupce
};

/**
 * Připraví canvas na HiDPI a vrátí kontext + rozměry v CSS px.
 * @param {number} [cssWidth] šířka v CSS px; když chybí, vezme se z layoutu
 */
function setup(canvas, cssHeight, cssWidth) {
  const dpr = window.devicePixelRatio || 1;
  const w = cssWidth || canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const h = cssHeight || canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  return { ctx, w, h, dpr };
}

function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

function fmt(v, d = 1) {
  if (v === null || v === undefined || v !== v) return '—';
  return v.toFixed(d);
}

/* ─────────────────────────────────────────── SPR po tónech */

export const SPR_H = 230;
const SPR_PAD = { l: 46, r: 12, t: 14, b: 34 };

/**
 * Minimální šířka, na kterou se jeden tón v grafu ringu vykreslí.
 *
 * PROČ 6 px: při 4 px a méně splývají sousední sloupce a ztratí se rozdíl mezi
 * tónem s ringem a bez — což je přesně to, kvůli čemu graf existuje. Uživatel
 * na 4minutové nahrávce viděl „nalepené" hodnoty; naměřeno, že při 6 px na tón
 * je ještě poznat mezera, takže se graf musí dát posouvat.
 */
const MIN_PX_PER_NOTE = 6;

/**
 * Kolik CSS pixelů šířky si graf ringu vyžádá, aby tóny nebyly nalepené.
 *
 * Do šířky okna se vykresluje napevno (nic se neposouvá), takže se posuvné
 * plátno zapíná až u delších nahrávek. Vrací 0, když se to nepozná —
 * `Math.max(0, …)` níž by jinak z nesmyslné délky udělal nulovou šířku.
 *
 * @param {number} availW šířka, která je k dispozici v CSS px
 * @param {object[]} notes tóny
 * @param {number} t1 délka nahrávky v sekundách
 */
export function sprNeededWidth(availW, notes, t1) {
  const meas = (notes || []).filter(n => n.spr === n.spr);
  if (!meas.length || !(t1 > 0) || !(availW > 0)) return 0;
  if (meas.length * MIN_PX_PER_NOTE <= availW) return 0;
  // sloupec dostane aspoň MIN_PX_PER_NOTE, ale ne šířku nahrávky — u dvou
  // dlouhých tónů by jinak graf vyjel do absurdní šířky
  const w = Math.ceil(meas.length * MIN_PX_PER_NOTE);
  return Math.min(Math.ceil(w * 1.05), Math.max(availW, 4000));
}

export const SPEC_H = 300;
const SPEC_PAD = { l: 42, r: 12, t: 12, b: 26 };
/**
 * Geometrie grafu ringu: rozsah os, měřítko času a převod kliku na čas.
 *
 * Je to schválně JEDINÉ místo, kde se měřítko počítá — používají ho obě věci,
 * které musí sedět na pixel: vykreslení grafu i „klepni do grafu a přeskoč tam".
 * Kdyby si app.js počítalo mapování samo, stačí posunout osu a klikání začne
 * hledat o kus vedle, aniž by to bylo na první pohled vidět.
 *
 * @returns {null|object} null, když není co měřit (žádný tón s platným SPR)
 */
export function sprGeom(w, h, notes, summary, offX = 0) {
  const plotW = w - SPR_PAD.l - SPR_PAD.r, plotH = h - SPR_PAD.t - SPR_PAD.b;
  const meas = notes.filter(n => n.spr === n.spr);
  if (!meas.length) return null;
  const vals = meas.map(n => n.spr);
  const thr = Number.isFinite(summary?.ring_threshold) ? summary.ring_threshold : Math.min(...vals);
  let lo = Math.min(...vals, thr), hi = Math.max(...vals);
  const pad = Math.max(2, (hi - lo) * 0.12);
  lo -= pad; hi += pad;
  const t1 = Math.max(...notes.map(n => n.t_end), 1);
  // `offX` = kolik pixelů plátna je odscrollováno doleva (posuvné plátno ringu).
  // Pro neposuvné plátno je 0 a chová se to jako dřív.
  const x = (t) => SPR_PAD.l + (t / t1) * plotW - offX;
  const y = (v) => SPR_PAD.t + plotH - ((v - lo) / (hi - lo)) * plotH;
  return {
    w, h, padL: SPR_PAD.l, padR: SPR_PAD.r, padT: SPR_PAD.t, padB: SPR_PAD.b,
    plotW, plotH, lo, hi, t1, x, y, meas, offX,
    /* Okno, do kterého se má kreslit (CSS px). Při posuvu se do plátna kreslí
     * celá šířka grafu, ale vidět je jen okno — kresba se podle toho ořezává,
     * jinak by `x()` u velkého offX odešlo do záporných čísel a canvas by
     * kreslil mimo. */
    clipL: offX, clipR: offX + w,
    timeAtX: (px) => ((px + offX - SPR_PAD.l) / plotW) * t1,
    /* Souřadnice v PIXELECH PLÁTNA (bez vlivu posuvu) — tu potřebuje ten, kdo
     * rozhoduje o posuvu: porovnává ji s `wrap.scrollLeft`. `x()` naproti tomu
     * vrací souřadnici pro KRESBU (posuv už odečtený), takže se s `scrollLeft`
     * porovnávat NESMÍ — posuv by se započítal dvakrát a okno by odjíždělo
     * donekonečna. */
    pxAtTime: (t) => SPR_PAD.l + (t / t1) * plotW,
  };
}

/** Geometrie spektrogramu — stejné rozměry jako drawSpec, proto na něj sedí. */
export function specGeom(w, h, duration) {
  const plotW = w - SPEC_PAD.l - SPEC_PAD.r, plotH = h - SPEC_PAD.t - SPEC_PAD.b;
  const t1 = Math.max(duration || 0, 0.001);
  return {
    w, h, padL: SPEC_PAD.l, padR: SPEC_PAD.r, padT: SPEC_PAD.t, padB: SPEC_PAD.b,
    plotW, plotH, t1,
    x: (t) => SPEC_PAD.l + (t / t1) * plotW,
    timeAtX: (px) => ((px - SPEC_PAD.l) / plotW) * t1,
  };
}

/**
 * Ukazatel přehrávání: svislá čára + klín nahoře. Kreslí se plnou barvou,
 * bez glow — světlý neutrál je čitelný přes zelené i červené sloupce.
 *
 * @param {object} g geometrie (sprGeom nebo specGeom)
 * @param {number} t čas v sekundách
 */
export function drawPlayhead(ctx, g, t, fixed = false) {
  const tt = Math.max(0, Math.min(Number.isFinite(t) ? t : 0, g.t1));
  const xx = Math.round(g.x(tt) - (fixed ? g.offX : 0)) + 0.5;
  if (xx < (fixed ? 0 : g.padL) || xx > (fixed ? g.w : g.padL + g.plotW)) return;

  ctx.strokeStyle = COL.head;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xx, g.padT); ctx.lineTo(xx, g.padT + g.plotH);
  ctx.stroke();

  // Klín nahoře — bez něj se čára v hustém grafu ztratí mezi mřížkou.
  ctx.fillStyle = COL.head;
  ctx.beginPath();
  ctx.moveTo(xx - 5, g.padT); ctx.lineTo(xx + 5, g.padT); ctx.lineTo(xx, g.padT + 8);
  ctx.closePath(); ctx.fill();
}

/** Průhledné plátno přesně přes graf — pro ukazatel, který se hýbe. */
function setupOverlay(canvas, cssHeight, cssWidth) {
  const dpr = window.devicePixelRatio || 1;
  const w = cssWidth || canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const h = cssHeight || canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * Ukazatel přes spektrogram.
 *
 * Spektrogram se kreslí z FFT — překreslovat ho 60× za sekundu by na telefonu
 * zadrhlo. Proto přes něj leží druhé, průhledné plátno (`.chart-head`), na které
 * se kreslí jen čára.
 */
export function drawSpecHead(canvas, duration, t) {
  const { ctx, w, h } = setupOverlay(canvas, SPEC_H);
  drawPlayhead(ctx, specGeom(w, h, duration), t);
}

/**
 * Ukazatel přes graf ringu (tamtéž, jen na průhledném plátně).
 *
 * Geometrie se počítá znovu při každém vykreslení — je to pár desítek čísel
 * nad ~50 tóny, takže je to zdarma, a hlavně se tím nemůže rozejít s grafem
 * po otočení telefonu nebo změně šířky okna.
 *
 * ⚠️ **Posuv se tu NESMÍ odečítat.** Plátno ukazatele má stejnou šířku jako
 * graf a leží v TÉŽE posuvné ploše, takže se posouvá s ním — prohlížeč už
 * jednou posunul obě plátna. Kdyby se `offX` odečetlo i tady, posun se
 * započítá dvakrát a čára sedne jinde než sloupec, na kterém stojíš
 * (přesně to bylo vidět: při odscrollování zmizela mimo okno, i když
 * geometrie říkala, že je uvnitř). Odečítat posuv mívalo smysl jen u
 * `position: sticky` plátna, které se neposouvalo — tenhle kód je ověřený
 * měřením pixelů v prohlížeči (kontrola-scroll.html).
 */
export function drawSprHead(canvas, notes, summary, t, opts = {}) {
  const { ctx, w, h } = setupOverlay(canvas, SPR_H, opts.width || 0);
  const g = sprGeom(w, h, notes, summary);
  if (g) drawPlayhead(ctx, g, t, true);
}

/** Smaže ukazatel (nové měření, ukončení přehrávání). */
export function clearHead(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const h = cssHeight || canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Graf ringu. Osa X je ČAS v nahrávce, ne index tónu — jinak se v grafu nedá
 * najít, kde konkrétně se ring ztrácí, a graf je k ničemu.
 *
 * @param {number} [playheadT] čas přehrávání; když je zadaný, dokreslí se ukazatel
 * @returns {object|null} geometrie (sprGeom) — používá ji app.js pro klik → čas
 */
export function drawSpr(canvas, notes, summary, playheadT = null, opts = {}) {
  const cssWidth = opts.width || 0;
  const offX = opts.offX || 0;
  const { ctx, w, h } = setup(canvas, SPR_H, cssWidth);
  const g = sprGeom(w, h, notes, summary, offX);
  if (!g) {
    ctx.fillStyle = COL.textDim;
    ctx.fillText(summary?.reason || 'Ring nelze měřit', 46, h / 2);
    return null;
  }
  const { padL, padR, padT, padB, plotW, plotH, lo, hi, t1, x, y, meas, clipL, clipR } = g;

  /* Při posuvu se obsah plátna posouvá — pevné prvky (osa Y, pásma, popisky)
   * se proto kreslí s posunem podle scrollu, aby zůstaly na místě okna. */
  const fixedX = padL + offX;
  const clip = (from, to) => { ctx.beginPath(); ctx.rect(Math.max(from, clipL), padT, Math.min(to, clipR) - Math.max(from, clipL), plotH); ctx.clip(); };

  // mřížka + osa Y
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  ctx.fillStyle = COL.text;
  for (const t of niceTicks(lo, hi, 5)) {
    const yy = Math.round(y(t)) + 0.5;
    if (yy < padT || yy > padT + plotH) continue;
    ctx.beginPath(); ctx.moveTo(clipL, yy); ctx.lineTo(clipR, yy); ctx.stroke();
    ctx.fillText(t.toFixed(0), offX + 6, yy + 4);
  }
  ctx.fillText('dB', offX + 6, padT - 3);

  // mřížka po čase
  ctx.fillStyle = COL.textDim;
  for (const tv of niceTicks(0, t1, 6).filter(v => v > 0)) {
    ctx.fillText(fmtClock(tv), x(tv) - 12, h - padB + 14);
  }

  // pásma síly hlasu
  const bands = [
    [hi, -13.1, 'rgba(106,158,106,.22)'],
    [-13.1, -22.7, 'rgba(195,154,90,.22)'],
    [-22.7, lo, 'rgba(181,103,94,.22)'],
  ];
  for (const [from, to, fill] of bands) {
    const a = Math.max(lo, Math.min(hi, from));
    const b = Math.max(lo, Math.min(hi, to));
    if (Math.abs(y(a) - y(b)) < 1) continue;
    ctx.fillStyle = fill;
    ctx.fillRect(clipL, Math.min(y(a), y(b)), clipR - clipL, Math.abs(y(a) - y(b)));
  }
  // sloupce: šířka podle skutečné délky tónu
  const bottom = y(lo);
  ctx.save();
  ctx.beginPath(); ctx.rect(clipL, padT, clipR - clipL, plotH); ctx.clip();
  for (const n of meas) {
    if (n.spr !== n.spr) continue;
    const xa = x(n.t_start), xb = x(n.t_end);
    if (xb < clipL - 20 || xa > clipR + 20) continue;
    const bw = Math.max(2, Math.min(18, xb - xa));
    const yy = y(n.spr);
    ctx.fillStyle = n.ring_ok ? COL.ok : COL.bad;
    ctx.fillRect(xa + (xb - xa - bw) / 2, Math.min(yy, bottom), bw, Math.abs(bottom - yy));
  }
  ctx.restore();

  // referenční čáry + popisky
  const refLines = [
    [-13.1, COL.ref, 'profesionálové'],
    [-22.7, COL.ref, 'nezpěváci'],
    [summary.ring_threshold, COL.bad, 'hranice ringu'],
  ];
  ctx.setLineDash([4, 3]);
  for (const [v, c, label] of refLines) {
    if (v < lo || v > hi) continue;
    const yy = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = c; ctx.beginPath();
    ctx.moveTo(clipL, yy); ctx.lineTo(clipR, yy); ctx.stroke();
    ctx.fillStyle = c;
    ctx.fillText(label, offX + padL + 4, yy - 3);
  }
  ctx.setLineDash([]);

  // mřížka po čase — svislé linky, kreslí se až navrch přes sloupce
  ctx.fillStyle = COL.textDim;
  ctx.save();
  ctx.beginPath(); ctx.rect(clipL, padT, clipR - clipL, plotH); ctx.clip();
  for (const tv of niceTicks(0, t1, 6).filter(v => v > 0)) {
    const xx = Math.round(x(tv)) + 0.5;
    ctx.strokeStyle = COL.grid;
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + plotH); ctx.stroke();
  }
  ctx.restore();

  // Jedna věta místo legendy — při posuvu se lepí na pravý okraj okna
  ctx.fillStyle = COL.textDim;
  ctx.textAlign = 'right';
  ctx.fillText('barvy pásem jsou orientační (závisí na mikrofonu)', offX + w - padR, padT - 3);
  ctx.textAlign = 'left';

  if (playheadT !== null) drawPlayhead(ctx, g, playheadT, true);
  return g;
}

/** mm:ss z sekund pro popisky osy. */
function fmtClock(t) {
  const m = Math.floor(t / 60), s = Math.round(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ─────────────────────────────────────────── F1:F0 ladění */

export function drawF1(canvas, notes, hintEl) {
  const H = 200;
  const { ctx, w, h } = setup(canvas, H);
  const padL = 42, padR = 12, padT = 14, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const rel = notes.filter(n => n.f1_tuning_relevant && n.f1_f0_err_pct === n.f1_f0_err_pct);
  const nBelow = notes.length - rel.length;

  if (hintEl) {
    hintEl.textContent = rel.length
      ? `Hodnoceno ${rel.length} tónů od G4 výš. ${nBelow} tónů níž se nehodnotí — ` +
        'tam je první formant záměrně vysoko (jiná strategie, ne vada).'
      : 'V této nahrávce není žádný tón od G4 výš, takže ladění F1 nelze hodnotit. ' +
        'Nad G4 se teprve pozná, kde se formant rozpadá.';
  }
  if (!rel.length) {
    ctx.fillStyle = COL.textDim;
    ctx.fillText('Žádný tón od G4 výš — nelze hodnotit', padL, h / 2);
    return;
  }

  const maxV = Math.max(20, ...rel.map(n => Math.min(n.f1_f0_err_pct, 60)));
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  const x = (i) => padL + (rel.length <= 1 ? plotW / 2
    : (i / (rel.length - 1)) * plotW);

  // Pásma barvou: zelené = v toleranci (ladění drží), oranžové = ještě
  // snesitelné, červené = rozpadá se. Bez toho laik z čísel nepozná, která
  // hodnota je dobrá a která už ne.
  {
    const seg = (from, to, fill) => {
      const a = Math.min(from, to), b = Math.max(from, to);
      const ya = y(Math.min(a, maxV)), yb = y(Math.min(b, maxV));
      if (Math.abs(ya - yb) < 1) return;
      ctx.fillStyle = fill;
      ctx.fillRect(padL, Math.min(ya, yb), plotW, Math.abs(ya - yb));
    };
    seg(0, 8, 'rgba(106,158,106,.22)');
    seg(8, 20, 'rgba(195,154,90,.18)');
    seg(20, maxV, 'rgba(181,103,94,.18)');
  }

  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  ctx.fillStyle = COL.text;
  for (const t of niceTicks(0, maxV, 4)) {
    const yy = Math.round(y(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillText(t.toFixed(0), 6, yy + 4);
  }
  ctx.fillText('%', 6, padT - 3);

  // hranice tolerance — popisek slovem, ne jen číslo
  const yt = Math.round(y(8)) + 0.5;
  ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.accent;
  ctx.beginPath(); ctx.moveTo(padL, yt); ctx.lineTo(w - padR, yt); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COL.textDim;
  ctx.fillText('nad touto čarou se ladění rozpadá (8 %)', padL + 2, yt - 4);

  const bw = Math.max(3, Math.min(18, plotW / Math.max(1, rel.length) * 0.7));
  rel.forEach((n, i) => {
    const v = Math.min(n.f1_f0_err_pct, 60);
    ctx.fillStyle = n.f1_tuned ? COL.ok : COL.bad;
    ctx.fillRect(x(i) - bw / 2, y(v), bw, padT + plotH - y(v));
    ctx.save();
    ctx.translate(x(i), h - padB + 12);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = COL.textDim;
    ctx.fillText(n.note, 0, 0);
    ctx.restore();
  });
}

/* ─────────────────────────────────────────── Spektrogram */

export function drawSpec(canvas, samples, sampleRate, notes) {
  const { ctx, w, h, dpr } = setup(canvas, SPEC_H);
  const g = specGeom(w, h, samples.length / sampleRate);
  const padL = g.padL, padR = g.padR, padT = g.padT, padB = g.padB;
  const plotW = Math.round(g.plotW), plotH = Math.round(g.plotH);

  const nfft = 1024;
  const hop = Math.max(1, Math.floor(samples.length / plotW));
  const maxHz = 6000;
  const binHz = sampleRate / nfft;
  const maxBin = Math.min(nfft / 2 - 1, Math.ceil(maxHz / binHz));

  // Hannovo okno
  const win = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (nfft - 1));

  // Připrav FFT pro každý sloupec.
  //
  // POZOR — tady byla chyba, kterou je vidět jen na displeji s devicePixelRatio > 1:
  // createImageData() vrací buffer v PAMĚŤOVÝCH pixelech, a putImageData()
  // transformaci canvasu IGNORUJE (pracuje v device px). Buffer vytvořený na
  // (plotW × plotH) se tedy při dpr = 2 vložil jen do levé horní ČTVRTINY
  // vykreslovací plochy a zbytek grafu zůstal prázdný.
  // Řešení: buffer se plní v device px (plotW·dpr × plotH·dpr) a na plátno se
  // dostane přes drawImage, který se současnou transformací naopak počítá.
  const devW = Math.round(plotW * dpr), devH = Math.round(plotH * dpr);
  const img = ctx.createImageData(devW, devH);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  const dbLo = -95, dbHi = 12;   // rozsah dynamiky obrazu

  /* Barevná stupnice: TEPLÝ NEUTRÁL → JANTAR → BÍLÁ.
   *
   * PŮVODNÍ STUPNICE (naměřeno na snímku): R = 26 + t·190, G = 22 + t·130,
   * B = 20 + t·60. Červená roste 3,2× rychleji než modrá, takže i slabý signál
   * okamžitě zežloutne a celý obraz zůstane v jedné žluto-oranžové — aktivní
   * formanty se v tom nedají rozeznat od šumu kolem. Naměřeno: stupeň šedi
   * (R−B) je 6 při t = 0 a 136 při t = 1, ale už při t = 0,15 dosáhne 60 %
   * maxima. Proto se teď svítivost zvedá pomaleji a barva se láme až výš:
   * plných 55 % rozsahu zůstává tmavě jantarových, nad 85 % teprve přechází do
   * světlého neutrálu. Naměřeno na stejném vzorku: podíl „prázdných" pixelů
   * (R ≤ 27) vzrostl z 1,4 % na 25,5 %, takže šumové dno je skutečně tmavé
   * a formanty nad ním se zvýrazní. Žádná naměřená hodnota se nemění —
   * je to čistě stupnice obrazu.
   */
  const rampR = (t) => (t < 0.55 ? 22 + t * 110 : 22 + 60.5 + (t - 0.55) * 300);
  const rampG = (t) => (t < 0.55 ? 18 + t * 90 : 18 + 49.5 + (t - 0.55) * 240);
  const rampB = (t) => (t < 0.55 ? 16 + t * 42 : 16 + 23.1 + (t - 0.55) * 150);
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

  // Odstup šumového dna od špičky se měří jednou za nahrávku. Různé mikrofony
  // a úrovně se liší o desítky dB; bez normalizace je obraz buď celý sytý,
  // nebo celý tmavý.
  const rawDb = new Float32Array(plotW * plotH);
  for (let col = 0; col < plotW; col++) {
    const start = Math.min(samples.length - nfft, col * hop);
    for (let i = 0; i < nfft; i++) { re[i] = (samples[start + i] || 0) * win[i]; im[i] = 0; }
    fftLocal(re, im);
    for (let row = 0; row < plotH; row++) {
      const frac = 1 - row / plotH;
      const bin = Math.min(maxBin, Math.round(frac * maxBin));
      const p = re[bin] * re[bin] + im[bin] * im[bin];
      rawDb[row * plotW + col] = 10 * Math.log10(p + 1e-20);
    }
  }

  // Normalizace na úroveň nahrávky: špička = 0 dB. Různé mikrofony a úrovně
  // se liší o desítky dB; bez normalizace je obraz buď celý sytý, nebo celý
  // tmavý. Bere se 99,5. percentil, ne absolutní maximum — jediný prásk nebo
  // klepnutí do mikrofonu by jinak celý spektrogram utopilo.
  const sorted = Float32Array.from(rawDb).sort();
  const norm = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))];
  // dpr bývá i neceločíselné (Windows 125 %, 150 %) — hranice pixelů se proto
  // zaokrouhlují, ne násobí. Sloupec/řádek tak může mít 2 nebo 3 device px.
  for (let row = 0; row < plotH; row++) {
    const devRow0 = Math.round(row * dpr), devRow1 = Math.round((row + 1) * dpr);
    for (let col = 0; col < plotW; col++) {
      let t = (rawDb[row * plotW + col] - norm - dbLo) / (dbHi - dbLo);
      t = Math.max(0, Math.min(1, t));
      const R = clamp255(rampR(t)), G = clamp255(rampG(t)), B = clamp255(rampB(t));
      const devCol0 = Math.round(col * dpr), devCol1 = Math.round((col + 1) * dpr);
      for (let dy = devRow0; dy < devRow1; dy++) {
        let idx = (dy * devW + devCol0) * 4;
        for (let dx = devCol0; dx < devCol1; dx++) {
          img.data[idx] = R; img.data[idx + 1] = G; img.data[idx + 2] = B; img.data[idx + 3] = 255;
          idx += 4;
        }
      }
    }
  }
  blitImageData(ctx, img, padL, padT, plotW, plotH);

  // pásmo singer's formantu
  const yFor = (hz) => padT + plotH - (hz / maxHz) * plotH;
  ctx.strokeStyle = 'rgba(120,190,190,.45)';
  ctx.setLineDash([4, 3]);
  for (const hz of [2500, 3200]) {
    const yy = Math.round(yFor(hz)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(180,220,220,.8)';
  ctx.fillText("singer's formant 2,5–3,2 kHz", padL + plotW - 168, yFor(3200) - 5);

  // osy
  ctx.fillStyle = COL.text;
  ctx.strokeStyle = COL.grid;
  for (const hz of [0, 1000, 2000, 3000, 4000, 5000, 6000]) {
    const yy = Math.round(yFor(hz)) + 0.5;
    ctx.fillText(String(hz), 6, yy + 4);
  }
  ctx.fillText('Hz', 6, padT - 2);

  // hranice tónů
  const total = samples.length / sampleRate;
  ctx.fillStyle = COL.textDim;
  for (const n of notes) {
    const xx = Math.round(padL + (n.t_start / total) * plotW) + 0.5;
    if (xx < padL || xx > padL + plotW) continue;
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + plotH); ctx.stroke();
  }
  for (const tv of niceTicks(0, total, 6).filter(v => v > 0)) {
    const xx = Math.round(g.x(tv));
    if (xx < padL || xx > padL + plotW) continue;
    ctx.fillStyle = COL.textDim;
    ctx.fillText(fmtClock(tv), xx - 12, h - 8);
  }
}

/* ─────────────────────────────────────────── Trend v čase */

export function drawTrend(canvas, rows) {
  const H = 260;
  const { ctx, w, h } = setup(canvas, H);
  const padL = 46, padR = 14, padT = 16, padB = 46;
  const plotW = w - padL - padR;
  const half = (plotW - 24) / 2;

  const use = rows.filter(r => !r.spr_unusable);
  if (!use.length) {
    ctx.fillStyle = COL.textDim;
    ctx.fillText('Žádné měřitelné měření', padL, h / 2);
    return;
  }

  // levý graf: SPR medián v čase
  const vals = use.map(r => r.spr_median);
  let lo = Math.min(...vals, -22), hi = Math.max(...vals, -10);
  const pd = Math.max(2, (hi - lo) * 0.15); lo -= pd; hi += pd;
  const yL = (v) => padT + (h - padT - padB) - ((v - lo) / (hi - lo)) * (h - padT - padB);
  const xL = (i) => padL + (use.length <= 1 ? half / 2 : (i / (use.length - 1)) * half);

  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.fillStyle = COL.text;
  for (const t of niceTicks(lo, hi, 4)) {
    const yy = Math.round(yL(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + half, yy); ctx.stroke();
    ctx.fillText(t.toFixed(0), 6, yy + 4);
  }
  ctx.fillText('SPR dB', 6, padT - 4);

  // pásmo rozptylu
  ctx.fillStyle = 'rgba(184,137,79,.16)';
  ctx.beginPath();
  use.forEach((r, i) => { const yy = yL(Math.min(hi, r.spr_median + r.spr_sd)); i ? ctx.lineTo(xL(i), yy) : ctx.moveTo(xL(i), yy); });
  for (let i = use.length - 1; i >= 0; i--) ctx.lineTo(xL(i), yL(Math.max(lo, use[i].spr_median - use[i].spr_sd)));
  ctx.closePath(); ctx.fill();

  // referenční čáry
  ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.ref;
  for (const [v, lab] of [[-13.1, 'profesionálové'], [-22.7, 'nezpěváci']]) {
    if (v < lo || v > hi) continue;
    const yy = Math.round(yL(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + half, yy); ctx.stroke();
    ctx.fillStyle = COL.textDim; ctx.fillText(lab, padL + 4, yy - 3);
  }
  ctx.setLineDash([]);

  // spojnice
  ctx.strokeStyle = COL.accent; ctx.lineWidth = 2; ctx.beginPath();
  use.forEach((r, i) => { i ? ctx.lineTo(xL(i), yL(r.spr_median)) : ctx.moveTo(xL(i), yL(r.spr_median)); });
  ctx.stroke();
  ctx.fillStyle = COL.accent;
  use.forEach((r, i) => { ctx.beginPath(); ctx.arc(xL(i), yL(r.spr_median), 3.5, 0, 7); ctx.fill(); });

  // pravý graf: % tónů s ringem
  const xR0 = padL + half + 24;
  const yR = (v) => padT + (h - padT - padB) - (v / 100) * (h - padT - padB);
  const xR = (i) => xR0 + (use.length <= 1 ? half / 2 : (i / (use.length - 1)) * half);

  ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text;
  for (const t of [0, 25, 50, 75, 100]) {
    const yy = Math.round(yR(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(xR0, yy); ctx.lineTo(xR0 + half, yy); ctx.stroke();
    ctx.fillText(t + ' %', xR0 - 34, yy + 4);
  }
  ctx.fillText('ring', xR0 - 34, padT - 4);

  const bw = Math.max(4, Math.min(26, half / Math.max(1, use.length) * 0.6));
  use.forEach((r, i) => {
    ctx.fillStyle = COL.ok;
    ctx.fillRect(xR(i) - bw / 2, yR(r.ring_consistency_pct), bw,
      padT + (h - padT - padB) - yR(r.ring_consistency_pct));
  });
  // 100 % cíl
  ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.textDim;
  const y100 = Math.round(yR(100)) + 0.5;
  ctx.beginPath(); ctx.moveTo(xR0, y100); ctx.lineTo(xR0 + half, y100); ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Vloží ImageData na zadané místo canvasu.
 *
 * `ctx.putImageData(img, x, y)` má dvě pasti, které se v grafu projeví jako
 * „data sražená do malého čtverce vlevo nahoře":
 *  1. (x, y) jsou souřadnice BODU V BUFERU, ze kterého se začne kreslit — ne
 *     cíl na plátně. Vložení „na (padL, padT)" proto kreslí od levého horního
 *     rohu canvasu a levý horní roh bufferu zahodí.
 *  2. Transformaci canvasu ignoruje, takže na displeji s devicePixelRatio > 1
 *     se buffer ve CSS pixelech vloží jen do levé horní 1/dpr² plochy.
 * Pomocný canvas + drawImage zvládne obojí: buffer se vloží od svého (0, 0)
 * a na plátno se dostane s rozměry v CSS px, takže je vždy přesně vyplněné.
 *
 * @param {number} [cssW] šířka v CSS px, na kterou se má obraz roztáhnout
 * @param {number} [cssH] výška v CSS px
 */
function blitImageData(ctx, img, x, y, cssW, cssH) {
  const off = document.createElement('canvas');
  off.width = img.width; off.height = img.height;
  off.getContext('2d').putImageData(img, 0, 0);
  if (cssW && cssH) ctx.drawImage(off, x, y, cssW, cssH);
  else ctx.drawImage(off, x, y);
}

/** Lokální FFT (aby modul nezávisel na analysis.js kvůli velikosti). */
function fftLocal(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; const u = im[i]; im[i] = im[j]; im[j] = u; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

export { fmt };
