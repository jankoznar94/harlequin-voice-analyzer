/**
 * Živá zpětná vazba — čistá logika bez prohlížeče.
 *
 * Záměrně BEZ DOM, bez AudioContextu: celé jádro se dá prohnat v Node, takže
 * se dá testovat i tam, kde mikrofon není (což je přesně tento stroj).
 * Vykreslování je oddělené v live-ui.js.
 *
 * Co se měří a proč:
 *   výška  — okamžitá f0 a odchylka v centech od nejbližšího tónu
 *   úroveň — RMS v dBFS, aby bylo vidět, že se zpívá málo/moc
 *   SPR    — PO RÁMCÍCH okna 4096, horní percentil. NENÍ to vyhlazený průměr
 *            spektra; ten vibrato systematicky sráží dolů (naměřeno −2,4 dB
 *            proti známé pravdě, kdežto tato cesta −0,0 dB). Důvody a čísla
 *            jsou u `SprCore` v analysis.js.
 *   FHE    — z klouzavého průměru spektra. Tady vyhlazení NEVADÍ: FHE je
 *            medián energie v pásmu, ne vrchol, a na měřených nahrávkách
 *            vychází živě a v reportu do 25 Hz od sebe.
 *
 * POZOR na jednu věc, která se u SPR plete: absolutní mez −20 dB NENÍ verdikt.
 * Živý indikátor proto hlásí hodnotu a referenční pásma, ale sám z ní nedělá
 * „má/nemá ring“ — to umí až analýza nahrávky, která tóny segmentuje a porovnává
 * je mezi sebou (viz SKILL, „vyrovnanost ≠ úroveň").
 */

import {
  hzToNote, REFS, percentile, SprCore, SPR_NFFT, SPR_QUANTILE,
} from './analysis.js';

/* ── konstanty ────────────────────────────────────────────────────────────── */

/** Délka rámce pro VÝŠKU a ÚROVEŇ. 2048 @48 kHz = 42,7 ms — dost na 70 Hz. */
export const FRAME_SIZE = 2048;

/** Jak chodí bloky z AudioWorkletu (ms). */
export const BLOCK_MS = 20;

/**
 * Jak dlouhé klouzavé okno drží hodnoty SPR pro zobrazení.
 *
 * 200 ms = čtyřicet rámců. Delší okno znamená klidnější číslo, ale přes pauzy
 * mezi tóny do něj vtéká doznívání (SPR tam padá o desítky dB) a indikátor by
 * hlásil slabý ring na tónu, který ho má. Krátké okno naopak cuká.
 */
export const SPR_ROLL_MS = 200;

/** Pod touto úrovní se rámec považuje za ticho a do spektra se nepřičte. */
export const RMS_GATE = 0.010;

/** Časová konstanta vyhlazení spektra v rámcích (α = 1/K). Pro FHE. */
export const SPEC_ALPHA = 0.12;

/**
 * Vyhlazení ručičky ladění. Surová výška z jednoho rámce skáče mezi rámci
 * o desítky centů (naměřeno: medián skoku 31 c, 90. percentil 87 c), protože
 * vibrato a šum se do 42ms okna promítají naplno. Klouzavý průměr tento
 * rozkmit srazí na 19 c (90. percentil) při zpoždění ~57 ms.
 *
 * Proč EMA (exponenciální) a ne medián: medián posledních N rámců sice cukání
 * srazí víc, ale na plynulém přechodu (glissando) se „lepí" na starou hodnotu
 * a reaguje skokem. EMA sleduje změnu spojitě.
 *
 * POZOR: vyhlazuje se JEN to, co se zobrazuje. Rozptyl ladění (spread) se
 * počítá ze SUROVÝCH hodnot — jinak by vyhlazení vibrato uměle zmenšilo
 * a číslo by lhalo o tom, jak přesně se tón drží.
 */
export const CENTS_SMOOTH_ALPHA = 0.35;

/** Přeskočí-li se tón o víc než tohle, vyhlazení se restartuje (nový tón). */
export const CENTS_RESET_CENTS = 150;

/** Ladění: do kolika centů se to ještě považuje za „v tónu". */
export const CENTS_OK = 15;
export const CENTS_MID = 35;

/* ── pomocné převody ──────────────────────────────────────────────────────── */

/** Nejbližší tón rovnoměrné temperatury a odchylka v centech. */
export function centsFromNote(f0) {
  if (!(f0 > 0)) return { note: null, cents: null, targetHz: null };
  const midi = Math.round(12 * Math.log2(f0 / 440) + 69);
  const targetHz = 440 * Math.pow(2, (midi - 69) / 12);
  const cents = 1200 * Math.log2(f0 / targetHz);
  return { note: hzToNote(f0), cents, targetHz, midi };
}

export function rmsToDbfs(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * FHE a úroveň SPR z LINEÁRNÍHO výkonového spektra.
 *
 * PROČ TO TU JE I PRO SPR: `metricsFromPower` je dnešní cesta k FHE a k číslu,
 * které se drží pro srovnání s reportem. Pro VYHODNOCENÍ SPR se ale používá
 * nová cesta (`SprCore` — po rámcích, horní percentil), protože právě tohle
 * průměrování vibrato systematicky sráží dolů. Naměřeno proti známé pravdě
 * (tón 440 Hz, vibrato 3 %): staré číslo −7,4 dB, nové −0,1 dB.
 */
export function metricsFromPower(acc, sampleRate, frameSize, nAcc = 1) {
  const half = acc.length;
  const binHz = sampleRate / frameSize;
  let hiPeak = 0, loPeak = 0;
  for (let i = 1; i < half; i++) {
    const f = i * binHz;
    const p = acc[i] / nAcc;
    if (f >= 2000 && f <= 4000) { if (p > hiPeak) hiPeak = p; }
    else if (f < 2000) { if (p > loPeak) loPeak = p; }
  }
  const sprDb = (hiPeak > 0 && loPeak > 0) ? 10 * Math.log10(hiPeak / loPeak) : NaN;

  // FHE — kde kumulativní energie v 2–3,6 kHz dosáhne 50 %
  let total = 0;
  const lo = Math.ceil(2000 / binHz), hi = Math.floor(3600 / binHz);
  for (let i = lo; i <= hi && i < half; i++) total += acc[i] / nAcc;
  let fheHz = NaN;
  if (total > 0) {
    let c = 0;
    for (let i = lo; i <= hi && i < half; i++) {
      c += acc[i] / nAcc;
      if (c >= 0.5 * total) { fheHz = i * binHz; break; }
    }
  }
  return { spr: sprDb, fhe: fheHz };
}

/** Zařazení SPR do referenčních pásem. NENÍ verdikt o ringu — jen orientace. */
export function sprBand(sprDb) {
  if (!Number.isFinite(sprDb)) return 'none';
  const profi = REFS.SPR.profesional[0];   // −13,1
  const nezpevak = REFS.SPR.nezpevak[0];   // −22,7
  if (sprDb >= profi) return 'profi';
  if (sprDb >= nezpevak) return 'mezi';
  return 'pod';
}

/** FHE v pásmu očekávaném pro daný obor (jen orientace, ±1 směrodatná odchylka). */
export function fheBand(fheHz, fach) {
  const ref = REFS.FHE[fach];
  if (!REFS.FHE[fach] || !Number.isFinite(fheHz)) return 'none';
  const d = fheHz - ref[0];
  if (Math.abs(d) <= ref[1]) return 'ok';
  return d < 0 ? 'nizka' : 'vysoka';
}

/* ── stav živého měření ───────────────────────────────────────────────────── */

export function createLiveState(sampleRate = 48000, frameSize = FRAME_SIZE) {
  const rollFrames = Math.max(4, Math.round(SPR_ROLL_MS / BLOCK_MS));
  return {
    sampleRate,
    frameSize,
    frames: 0,            // všech rámců
    voicedFrames: 0,      // rámců nad prahem (skutečně zpívaných)
    lastF0: 0,
    lastDbfs: -Infinity,
    lastCents: null,
    lastNote: null,
    lastCentsSmooth: null,  // vyhlazená odchylka — JEN pro zobrazení ručičky
    sprSamples: [],       // historie SPR pro průběžný medián
    fheSamples: [],
    centsHist: [],        // pro rozptyl ladění (SUROVÉ hodnoty!)
    peakDbfs: -Infinity,
    startedAt: null,
    // měření SPR po rámcích (okno 4096) — stejná cesta jako analýza nahrávky
    sprCore: new SprCore(sampleRate, SPR_NFFT),
    sprRoll: [],          // klouzavé okno posledních hodnot SPR (~200 ms)
    sprRollMax: rollFrames,
    sprLast: NaN,         // SPR posledního rámce
  };
}

/** Souhrn SPR z celého měření — stejná statistika jako `spr_novy_median`. */
export function sprSummary(state) {
  const vals = state.sprSamples;
  if (!vals.length) return { median: NaN, p90: NaN, n: 0 };
  const s = [...vals].sort((a, b) => a - b);
  const h = s.length >> 1;
  return {
    /* MEDIÁN se hlásí jako souhrnné číslo, protože TAK POČÍTÁ REPORT:
     * `spr_novy_median` je medián přes tóny (z tónů, ne z rámců). Živý režim
     * tóny nesegmentuje, takže medián přes rámce je nejbližší obdoba — a je
     * to právě ta statistika, která s reportem sedí (naměřeno na drženém tónu
     * 440 Hz: −2,38 živě proti −2,40 v reportu). Kdyby se hlásil p90, vyšlo by
     * číslo systematicky o ~0,5 dB výš, protože p90 přes rámce je prostě jiná
     * (a vyšší) statistika než p90 přes vnitřek tónu.
     * p90 se proto hlásí jako DRUHÉ číslo — vyjadřuje totéž, co p90 u tónu. */
    median: s.length & 1 ? s[h] : (s[h - 1] + s[h]) / 2,
    p90: percentile(s, SPR_QUANTILE),
    n: s.length,
  };
}

/**
 * Zpracuje jeden živý rámec.
 *
 * Rámec je pro každou veličinu jiný a je to tak správně:
 *   - VÝŠKA a ÚROVEŇ se berou z rámce 2048 (YIN je na něm odladěný a kratší
 *     okno ho posouvá — naměřeno na A2: rámec 1024 dá 108,5 Hz místo 110,0).
 *   - SPR se bere z OKNA 4096, klouzavě s krokem po blocích. Okno 2048 vidí
 *     jen do 12 kHz (na 48 kHz), takže se do pásma 2–4 kHz vejdou dva biny a
 *     vrchol nemá z čeho vzniknout. 4096 je TOTÉŽ okno, ze kterého počítá
 *     analýza nahrávky — proto se čísla nemohou rozejít.
 *
 * @param state  stav z createLiveState
 * @param dsp    backend (dsp-backend.js) — bere vzorky a vrací f0 + spektrum
 * @param frame  vzorky rámce 2048 (Float32/Float64) — výška a úroveň
 * @param sprWin posledních SPR_NFFT (4096) vzorků pro SPR. Když se nepředá
 *               nebo je kratší, SPR se VYNECHÁ — dopočítávat ho z kratšího
 *               okna nebo z nul je špatně (změřeno až 5 dB rozdíl), takže
 *               indikátor do té doby ukazuje „sbírá se…“. Na začátku měření
 *               to trvá 4 okna (80 ms), což je vidět jen jako krátké zpoždění.
 */
export function feedFrame(state, dsp, frame, sprWin = null) {
  const sr = state.sampleRate;
  const n = Math.min(frame.length, state.frameSize);

  // 1. výška + spektrum jedním průchodem (WASM)
  const f0raw = dsp.process(frame.subarray(0, n));
  const rms = dsp.rms(frame.subarray(0, n));
  const dbfs = rmsToDbfs(rms);

  state.frames++;
  if (state.startedAt === null) state.startedAt = Date.now();
  if (dbfs > state.peakDbfs) state.peakDbfs = dbfs;

  const voiced = rms >= RMS_GATE && f0raw > 0;

  let metrics = { spr: NaN, fhe: NaN };
  if (voiced) {
    state.voicedFrames++;
    // spektrum se do klouzavého průměru přičte jen když se skutečně zpívá —
    // jinak by ticho hodnotu FHE ředilo. (Na SPR to vliv nemá: ten se počítá
    // po rámcích z vlastního okna.)
    dsp.accumulate();
    metrics = dsp.readMetrics();
    if (Number.isFinite(metrics.fhe)) state.fheSamples.push(metrics.fhe);

    /* 2. SPR — z celého klouzavého okna 4096, po rámcích, horní percentil.
     * Bere se vždy POSLEDNÍCH 4096 vzorků, takže okno sedí na tom, co se právě
     * zpívá; horní percentil přes posledních ~200 ms odpovídá na otázku „jaký
     * vrchol tam hlas teď umí postavit". Dokud okno 4096 není (první ~80 ms),
     * `sprCore.of` vrátí NaN a SPR se prostě nehlásí. */
    const v = sprWin ? state.sprCore.of(sprWin) : NaN;
    if (Number.isFinite(v)) {
      state.sprLast = v;
      state.sprSamples.push(v);
      state.sprRoll.push(v);
      if (state.sprRoll.length > state.sprRollMax) state.sprRoll.shift();
    }
  }

  const sprNow = state.sprRoll.length ? percentile(state.sprRoll, SPR_QUANTILE) : NaN;

  let pitch = { note: null, cents: null, targetHz: null };
  if (voiced) {
    pitch = centsFromNote(f0raw);
    state.lastCents = pitch.cents;
    state.lastNote = pitch.note;
    // Rozptyl ladění se počítá ze SUROVÝCH hodnot — vyhlazení by vibrato
    // uměle zmenšilo a číslo by lhalo o tom, jak přesně se tón drží.
    state.centsHist.push(pitch.cents);

    // Vyhlazení pro ručičku: EMA. Když se tón přeskočí o víc než
    // CENTS_RESET_CENTS, začíná se od nova — jinak by ručička při novém tónu
    // dojížděla z předchozí polohy a vypadala rozladěná.
    const raw = pitch.cents;
    if (state.lastCentsSmooth === null
        || Math.abs(raw - state.lastCentsSmooth) > CENTS_RESET_CENTS) {
      state.lastCentsSmooth = raw;
    } else {
      state.lastCentsSmooth += CENTS_SMOOTH_ALPHA * (raw - state.lastCentsSmooth);
    }
  } else {
    // V tichu se vyhlazení restartuje, aby další tón nezačínal na staré hodnotě.
    state.lastCentsSmooth = null;
  }

  state.lastF0 = voiced ? f0raw : 0;
  state.lastDbfs = dbfs;

  return {
    f0: voiced ? f0raw : 0,
    note: pitch.note,
    cents: pitch.cents,
    centsShown: state.lastCentsSmooth,   // co kreslit na ručičku
    targetHz: pitch.targetHz,
    dbfs,
    voiced,
    spr: sprNow,                         // co ukázat v číselníku (klouzavě)
    sprLast: state.sprLast,              // SPR posledního rámce (okno 4096)
    /* Starší měřidlo (vyhlazený průměr spektra okna 2048) — v grafu se kreslí
     * jako bledá tlustá čára vedle přesné. Není to pozůstatek: je to číslo,
     * které vibrato sráží dolů, a na grafu je vidět, o kolik. */
    sprOld: metrics.spr,
    sprBand: sprBand(sprNow),
    fhe: metrics.fhe,
    sprMedian: median(state.sprSamples),
    voicedFrames: state.voicedFrames,
    frames: state.frames,
  };
}

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length & 1 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Souhrn po skončení živého měření. */
export function summarizeLive(state) {
  const secs = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const sprS = sprSummary(state);
  return {
    seconds: secs,
    frames: state.frames,
    voicedFrames: state.voicedFrames,
    voicedPct: state.frames ? Math.round(100 * state.voicedFrames / state.frames) : 0,
    peakDbfs: state.peakDbfs,
    /* Dvě čísla SPR, stejně jako v reportu z nahrávky:
     *   sprMedian — medián přes rámce okna 4096 (odpovídá `spr_novy_median`)
     *   sprP90    — horní percentil přes rámce
     * Staré číslo (průměr spektra) se ZÁMĚRNĚ nehlásí: bylo by to třetí
     * měřítko, které s ničím nesedí, a hlavně to je přesně ta metrika, kterou
     * vibrato systematicky sráží dolů. */
    sprMedian: sprS.median,
    sprP90: sprS.p90,
    sprBand: sprBand(sprS.median),
    sprSamples: sprS.n,
    fheMedian: median(state.fheSamples),
    centsSpread: spread(state.centsHist),
    noteNames: null,
  };
}

/** Rozptyl ladění: směrodatná odchylka v centech (jak přesně se drží tón). */
export function spread(cents) {
  if (cents.length < 3) return NaN;
  const m = cents.reduce((a, b) => a + b, 0) / cents.length;
  const v = cents.reduce((a, b) => a + (b - m) * (b - m), 0) / cents.length;
  return Math.sqrt(v);
}

/* ── vyhodnocení pro UI ───────────────────────────────────────────────────── */

export function centsClass(cents) {
  if (cents === null || !Number.isFinite(cents)) return 'none';
  const a = Math.abs(cents);
  return a <= CENTS_OK ? 'ok' : a <= CENTS_MID ? 'mid' : 'bad';
}

export function levelClass(dbfs) {
  if (!Number.isFinite(dbfs)) return 'none';
  if (dbfs < -45) return 'bad';       // skoro nic
  if (dbfs < -30) return 'mid';       // málo
  if (dbfs > -6) return 'bad';        // přebuzeno
  return 'ok';
}

export function sprClass(band) {
  return { profi: 'ok', mezi: 'mid', pod: 'bad' }[band] || 'none';
}
