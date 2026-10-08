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
  // Vyřazený tón (moc krátký / moc tichý) — neutrální šeď, NE červená.
  // Červená znamená výpadek ringu; tohle žádný výpadek není, jen se o tónu
  // nic netvrdí. Když se obojí kreslilo stejně, uživatel viděl „červený" tón
  // s SPR −9,7 dB, tedy na úrovni profesionála.
  excl: '#6f6862',
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

/* Výšky všech tří panelů jsou STEJNÉ (`SPR_H` = `SPEC_H` = `F1_H` = 230 px).
 * Různé výšky znamenaly, že přepnutí záložky posunulo celý obsah pod grafy
 * (přehrávač i čas) svisle — spektrogram o 70 px, ladění o 30 px. Panel smí
 * měnit jen obsah, ne výšku. Hlídá `test-ui-wiring.mjs` (sekce 10). */
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

/* Spektrogram má STEJNOU výšku jako graf ringu (SPR_H). Když byl vyšší
 * (300 px), při přepnutí záložky se celý obsah pod grafy posunul o 70 px —
 * přehrávač, čas i lišta „uskočily" vertikálně nahoru a dolů. Výška panelu
 * proto musí být u všech záložek stejná; mění se jen to, co je uvnitř.
 * Hlídá to `test-ui-wiring.mjs` i `kontrola-zalozky.html` v prohlížeči. */
export const SPEC_H = 230;
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
/**
 * Geometrie grafu ringu.
 *
 * ⚠️ **Osa X musí končit na DÉLCE NAHRÁVKY, ne na konci posledního tónu.**
 *
 * Reálná vada, kterou uživatel viděl (naměřeno v prohlížeči na 72,6s nahrávce):
 * přehrávač hlásil 1:12 (72,58 s), ale `t1` grafu bylo 71,43 s = konec posledního
 * tónu. Ukazatel na grafu proto dojel na konec osy o 1,15 s dřív, než nahrávka
 * skutečně skončila — a čím delší dozvuk na konci, tím větší rozdíl. Spektrogram
 * i přehrávač jedou do délky souboru, takže se dvě osy v jedné obrazovce
 * rozcházely.
 *
 * `duration` je proto nový parametr; když se nepředá (0), chová se geometrie
 * jako dřív a osa končí posledním tónem — na tom stojí starší testy a volající,
 * kteří délku neznají.
 */
export function sprGeom(w, h, notes, summary, offX = 0, duration = 0) {
  const plotW = w - SPR_PAD.l - SPR_PAD.r, plotH = h - SPR_PAD.t - SPR_PAD.b;
  const meas = notes.filter(n => n.spr === n.spr);
  if (!meas.length) return null;
  const vals = meas.map(n => n.spr);
  /* Rozsah osy musí pojmout i křivky dlouhých tónů — jinak by se jejich
   * krajní hodnoty jen ořezávaly o okraj a nebylo by vidět, kam až to spadlo.
   * Bere se ale 2. a 98. percentil, ne minimum: jediné zašuměné okno v náběhu
   * umí být o desítky dB jinde a roztáhlo by osu tak, že by zbytek grafu byl
   * jedna čára. (Stejná zásada jako normalizace spektrogramu 99,5. percentilem.) */
  const extra = [];
  for (const n of meas) {
    const ser = n.spr_series;
    if (!ser || ser.length < 3) continue;
    const v = ser.map(p => p[1]).sort((a, b) => a - b);
    extra.push(v[Math.floor(v.length * 0.02)], v[Math.min(v.length - 1, Math.floor(v.length * 0.98))]);
  }
  /* ⚠️ PRÁH VÝPADKU PATŘÍ DO OSY VŽDY — i když leží hluboko pod daty.
   *
   * Reálná vada, kterou uživatel viděl (nahrávka 6,2 s, 5 tónů): práh vyšel
   * −60,96 dB, kdežto tóny ležely mezi −42,7 a −21,7 dB. Osa se počítala jen
   * z DAT, takže sahala do −65,7 dB — a graf kvůli tomu ukazoval rozsah
   * 48,7 dB místo 20,9. Sloupce pak vedly od −65,7 dB (tedy odspodu) a měřily
   * 86–164 px z 182 px plochy, takže z grafu zmizel tvar křivky: každý tón
   * vypadal jako plný sloupec. Červená čára „hranice ringu“ sjela na úplné
   * dno, kde se plete s okrajem grafu.
   *
   * Práh pod daty nevzniká jen tak: je to `medián − k·MAD` a MAD je při málo
   * tónech (5) skoro nulová, takže se odečte plná podlaha 3 dB × 2,5… ve
   * výsledku −61 dB. Když práh leží POD daty, není to vada prahu — prostě
   * žádný tón není výpadek, takže se do rozsahu nesmí pouštět: graf se má
   * vejít na to, co ukazuje. Práh se proto připojí jen tehdy, když leží
   * uvnitř dat (a rozšíří osu o pár dB, aby byla čára vidět). */
  const thr = Number.isFinite(summary?.ring_threshold) ? summary.ring_threshold : null;
  const dataLo = Math.min(...vals, ...extra), dataHi = Math.max(...vals, ...extra);
  /* Podlaha: rozpětí aspoň 8 dB, ať z pěti stejných tónů není nekonečně
   * zvětšená čára. */
  const span0 = Math.max(8, dataHi - dataLo);
  const dataMid = (dataHi + dataLo) / 2;
  let lo = dataMid - span0 / 2, hi = dataMid + span0 / 2;
  const thrIn = thr !== null && thr >= lo - 2 && thr <= hi + 2;
  if (thrIn) { lo = Math.min(lo, thr - 1.5); hi = Math.max(hi, thr + 1.5); }
  const pad = Math.max(2, (hi - lo) * 0.08);
  lo -= pad; hi += pad;
  /* Konec osy: délka nahrávky, když ji známe — jinak konec posledního tónu.
   * Nikdy ale méně, než kam sahají data: tóny se nesmí ocitnout mimo osu. */
  const lastNoteEnd = Math.max(...notes.map(n => n.t_end), 0);
  const t1 = Math.max(duration || 0, lastNoteEnd, 1);
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
  const g = sprGeom(w, h, notes, summary, 0, opts.duration || 0);
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
  const g = sprGeom(w, h, notes, summary, offX, opts.duration || 0);
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
  /* VŠECHNY TÓNY KŘIVKOU. Krátký tón se dřív kreslil plným sloupcem, protože
   * časovou řadu dostal až od 0,6 s — jenže sloupec je starší měření (průměr
   * spekter) a křivka přesné (po rámcích, p90), takže v jednom grafu stála dvě
   * měřítka vedle sebe s rozdílem přes 4 dB. Graf působil, jako by se „míchaly
   * dva typy hodnot" — a přesně to se stalo.
   *
   * Řada je proto nově od 0,30 s (`SPR_SERIE_MIN_DUR`), takže křivku má každý
   * měřený tón. Křivka se kreslí od spodní hrany osy a v pauzách mezi tóny nic
   * není — graf se tím sám dělí na jednotlivé tóny a je z něj vidět, kde ring
   * v průběhu tónu padá.
   *
   * Plný sloupec zůstává jen jako ZÁLOHA pro tón, který řadu nemá (kratší než
   * 0,30 s, nebo se spektrum nepodařilo změřit) — jinak by takový tón v grafu
   * zmizel úplně.
   *
   * ⚠️ TŘI BARVY, NE DVĚ. Tón, který má platné SPR, ale analýza ho z hodnocení
   * ringu VYŘADILA (kratší než ~0,30 s nebo příliš tichý), se NESMÍ kreslit
   * červeně. V datech má `ring_ok === false`, takže dřív červeně vyšel — a
   * vypadal jako výpadek ringu, kterým ale není. Uživatel pak viděl tón s SPR
   * −9,7 dB (tedy na úrovni profesionála) obarvený jako vada. Naměřeno na
   * nahrávce: 1 skutečný výpadek, ale 10 červených sloupců, z toho 3 s SPR
   * jako profesionál. Vyřazené tóny proto dostávají neutrální šeď.
   * Rozhoduje `ring_dropout` (skutečný výpadek), ne jen `!ring_ok`. */
  const bottom = y(lo);
  ctx.save();
  ctx.beginPath(); ctx.rect(clipL, padT, clipR - clipL, plotH); ctx.clip();
  for (const n of meas) {
    if (n.spr !== n.spr) continue;
    const xa = x(n.t_start), xb = x(n.t_end);
    if (xb < clipL - 20 || xa > clipR + 20) continue;
    const color = n.ring_dropout ? COL.bad : n.ring_ok ? COL.ok : COL.excl;

    /* DLOUHÝ TÓN = KŘIVKA, NE JEDEN SLOUPEC.
     *
     * Držený tón měl v grafu jedinou hodnotu, i když trvá pět vteřin a ring se
     * v jejich průběhu mění (naměřeno na reálném zpěvu: IQR uvnitř tónu 6,45 dB
     * i po vyhlazení). Jedno číslo schová přesně to, co zpěvák hledá: jestli
     * ring drží od náběhu do konce, nebo na konci padá. Proto se u tónů, které
     * mají časovou řadu, kreslí stuha (rozptyl v okně) + středová linka.
     *
     * Stuha se kreslí jako JEDNA plocha (tam a zpět), ne dva tahy — dva tahy by
     * v překryvu ztmavly a vypadaly jako změna barvy.
     *
     * ⚠️ PŘED 1.0.40 BYLA ŘADA JEN OD 0,6 s, takže kratší tón zůstal plným
     * sloupcem a v jednom grafu se potkávaly dvě měřítka (viz komentář výš).
     * Dnes má řadu každý tón, který se dá změřit. */
    const ser = n.spr_series;
    if (ser && ser.length >= 2) {
      const t0 = n.t_start;
      const px = (i) => x(t0 + ser[i][0]);
      const py = (i) => y(ser[i][1]);

      ctx.globalAlpha = 0.30;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      for (let i = 1; i < ser.length; i++) ctx.lineTo(px(i), py(i));
      ctx.lineTo(px(ser.length - 1), bottom);
      ctx.lineTo(px(0), bottom);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      for (let i = 1; i < ser.length; i++) ctx.lineTo(px(i), py(i));
      ctx.stroke();
      continue;
    }

    /* Tón bez časové řady (kratší než 0,30 s) se kreslí PLOCHOU ČÁRKOU ve své
     * hodnotě, ne plným sloupcem odspodu.
     *
     * PROČ SE TO ZMĚNILO: krátkých tónů bývá hodně (na nahrávce 6,2 s tři
     * z pěti) a v měřítku, které musí pojmout i dlouhé tóny, vyjde sloupec
     * odspodu skoro přes celou plochu — tvar křivky se ztratí a každý tón
     * vypadá jako plný sloupec. Přitom jde o TOTÉŽ měření jako u křivky, jen
     * z jednoho okna. Plná čárka drží stejnou vizuální řeč (výška = SPR)
     * a sloupec odspodu už nikde nefiguruje. */
    const bw = Math.max(2, Math.min(18, xb - xa));
    const yy = y(n.spr);
    ctx.fillStyle = color;
    ctx.fillRect(xa + (xb - xa - bw) / 2, yy, bw, 3);
    /* Svislá stopa dolů jen slabě — ať je vidět, kam tón časově patří, ale
     * nepřebije křivky svou plochou. */
    ctx.globalAlpha = 0.22;
    ctx.fillRect(xa + (xb - xa - bw) / 2, yy + 3, bw, Math.max(0, bottom - yy - 3));
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  /* Referenční čáry. `ring_threshold` se vypisuje, jen když leží v ose —
   * když je hluboko pod daty (u málo tónů vychází `medián − k·MAD` i −61 dB),
   * čára na dně se plete s okrajem grafu a nic neříká. */
  const refLines = [
    [-13.1, COL.ref, 'profesionálové'],
    [-22.7, COL.ref, 'nezpěváci'],
    ...(lo <= summary.ring_threshold && summary.ring_threshold <= hi
      ? [[summary.ring_threshold, COL.bad, 'hranice ringu']] : []),
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

export const F1_H = 230;
const F1_PAD = { l: 42, r: 12, t: 14, b: 30 };

/**
 * Tóny, které graf ladění opravdu kreslí — hodnotí se jen od G4 výš.
 * Je to na JEDNOM místě schválně: kresba, ukazatel i klik musí vidět stejnou
 * množinu, jinak se rozjedou indexy a ukazatel stojí na jiném sloupci.
 */
export function f1Notes(notes) {
  return (notes || []).filter(n => n.f1_tuning_relevant && n.f1_f0_err_pct === n.f1_f0_err_pct);
}

/**
 * Geometrie grafu ladění (vysoké tóny) + převod ukazatele přehrávání.
 *
 * Osa X je ČAS nahrávky, stejně jako u grafu ringu a spektrogramu — jen tak
 * může ukazatel přehrávání běžet plynule i tady a klik trefit přesné místo.
 * Sloupec stojí na svém tónu a je široký jako tón; krátký tón má nejméně 3 px,
 * aby nezmizel (jinak by graf tvrdil, že tam žádný tón není).
 */
export function f1Geom(w, h, rel, duration = 0) {
  const plotW = w - F1_PAD.l - F1_PAD.r, plotH = h - F1_PAD.t - F1_PAD.b;
  if (!rel || !rel.length || !(plotW > 0) || !(plotH > 0)) return null;
  // Osa X je ČAS nahrávky — stejně jako u grafu ringu a spektrogramu. Ukazatel
  // proto jede plynule i tady a klik míří na přesné místo v nahrávce.
  // POZOR — konec osy je DÉLKA NAHRÁVKY, ne konec posledního tónu: jinak
  // ukazatel ladění dojede dřív než přehrávač (stejná vada jako u grafu ringu).
  const lastEnd = Math.max(...rel.map(n => Math.max(n.t_end, n.t_start)), 0);
  const t1 = Math.max(duration || 0, lastEnd, 0.001);
  const x = (t) => F1_PAD.l + (Math.max(0, Math.min(t, t1)) / t1) * plotW;
  return {
    w, h, padL: F1_PAD.l, padR: F1_PAD.r, padT: F1_PAD.t, padB: F1_PAD.b,
    plotW, plotH, rel, t1, x,
    timeAtX: (px) => ((px - F1_PAD.l) / plotW) * t1,
  };
}

/** Ukazatel přes graf ladění — světlá čára na tónu, který právě zní. */
export function drawF1Head(canvas, notes, t, duration = 0) {
  const rel = f1Notes(notes);
  const { ctx, w, h } = setupOverlay(canvas, F1_H);
  const g = f1Geom(w, h, rel, duration);
  if (!g) return;
  drawPlayhead(ctx, g, t);
}

export function drawF1(canvas, notes, hintEl, duration = 0) {
  const { ctx, w, h } = setup(canvas, F1_H);
  const g = f1Geom(w, h, f1Notes(notes), duration);
  if (!g) {
    const padL = F1_PAD.l;
    const nBelow = notes.length;
    if (hintEl) {
      hintEl.textContent = 'V této nahrávce není žádný tón od G4 výš, takže ladění F1 ' +
        'nelze hodnotit. Nad G4 se teprve pozná, kde se formant rozpadá.' +
        (nBelow ? ` (${nBelow} tónů je níž — tam se nehodnotí.)` : '');
    }
    ctx.fillStyle = COL.textDim;
    ctx.fillText('Žádný tón od G4 výš — nelze hodnotit', padL, h / 2);
    return null;
  }
  const { padL, padR, padT, padB, plotW, plotH, rel } = g;
  const nBelow = notes.length - rel.length;

  if (hintEl) {
    hintEl.textContent = `Hodnoceno ${rel.length} tónů od G4 výš. ${nBelow} tónů níž se nehodnotí — ` +
      'tam je první formant záměrně vysoko (jiná strategie, ne vada).';
  }

  const maxV = Math.max(20, ...rel.map(n => Math.min(n.f1_f0_err_pct, 60)));
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  const x = (t) => g.x(t);

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

  // Čas na ose X — stejně jako u grafu ringu. Bez toho by se z časové osy
  // nedalo přečíst, kde v nahrávce ten který tón je.
  ctx.fillStyle = COL.textDim;
  for (const tv of niceTicks(0, g.t1, 6).filter(v => v > 0)) {
    const xx = Math.round(x(tv));
    if (xx < padL || xx > w - padR) continue;
    ctx.fillText(fmtClock(tv), xx - 12, h - 4);
  }

  /* Sloupce stojí na SVÉM TÓNU (osa X je čas) a začínají přesně na jeho začátku
   * — vycentrování by posunulo hodnotu mimo čas, který tón opravdu zabírá.
   * Šířka je z délky tónu, ale nejméně 3 px (jinak by krátký tón zmizel a graf
   * by tvrdil, že tam žádný není) a nejvýš 18 px (aby dlouhý tón nezakryl okolí).
   * Mezera mezi tóny zůstane prázdná — je vidět, že mezi nimi nic neznělo. */
  const bwLimit = Math.max(3, Math.min(18, plotW / Math.max(1, rel.length) * 0.6));
  rel.forEach((n) => {
    const v = Math.min(n.f1_f0_err_pct, 60);
    const xa = x(n.t_start), xb = x(Math.max(n.t_end, n.t_start));
    const bw = Math.max(3, Math.min(bwLimit, Math.max(3, xb - xa)));
    ctx.fillStyle = n.f1_tuned ? COL.ok : COL.bad;
    ctx.fillRect(xa, y(v), bw, padT + plotH - y(v));
    ctx.save();
    ctx.translate(xa + Math.min(bw, 10) / 2, h - padB + 12);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = COL.textDim;
    ctx.fillText(n.note, 0, 0);
    ctx.restore();
  });
  return g;
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
  /* Textová vysvětlivka („singer's formant 2,5–3,2 kHz") se do plátna NEKRESLÍ
   * — na výšku 230 px se pletla s popisky kmitočtové osy (2 000 a 3 000 Hz)
   * a působila jako šum. Pásmo zpěváckého formantu zůstává vyznačené jen
   * čárkovanými linkami; co znamenají, je v legendě aplikace. */

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
