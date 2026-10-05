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
  formantsAt, noteTraktu,
} from './analysis.js';

/* ── konstanty ────────────────────────────────────────────────────────────── */

/** Délka rámce pro VÝŠKU a ÚROVEŇ. 2048 @48 kHz = 42,7 ms — dost na 70 Hz. */
export const FRAME_SIZE = 2048;

/** Jak chodí bloky z AudioWorkletu (ms). */
export const BLOCK_MS = 20;

/**
 * Okno pro DÉLKU VOKÁLNÍHO TRAKTU (ms).
 *
 * 85 ms = 4096 vzorků @48 kHz, tedy PŘESNĚ okno, které už do `feedFrame` chodí
 * jako `sprWin`. Díky tomu není potřeba druhý kruhový zásobník — kdyby si VTL
 * drželo vlastní okno jiné délky, musel by se přidat a ořezávat zvlášť.
 *
 * PROČ právě 85 ms (naměřeno proti známé pravdě, `tools/exp-vtl-live5.mjs`):
 *   okno  85 ms → |chyba| medián 0,30 cm, číslo se ukáže u 15 z 25 tónů
 *   okno 171 ms → |chyba| 0,32 cm, ale jen u 8 z 25 tónů
 *   okno 341 ms → |chyba| 0,32 cm, jen u 3 z 25 tónů
 * Čím delší okno, tím méně tónů projde fyziologickým filtrem (LPC na delším
 * okně častěji chytne harmonickou). Přesnost je přitom stejná, takže kratší
 * okno je lepší.
 *
 * POZOR — krok výpočtu je KAŽDÝ RÁMEC (20 ms), ne jednou za tři. Naměřeno na čtyřech
 * reálných nahrávkách (122 tónů nad 0,9 s) — kolik tónů se dočká čísla:
 *   krok 20 ms, práh 3 okna → 51 %      krok 60 ms, práh 3 okna → 30 %
 *   krok 20 ms, práh 1 okno → 68 %      krok 60 ms, práh 5 oken → 14 %
 * Vzácná okna (LPC chytne harmonickou) jsou rozesetá nepravidelně, takže delší
 * krok je sítí, kterou propadnou. Cena 1,4 ms/rámec je při rozpočtu 20 ms
 * únosná (živý rámec výšky+SPR stojí 0,41 ms v JS, 0,13 ms ve WASM).
 */
export const VTL_WIN_SAMPLES = 4096;
export const VTL_EVERY_FRAMES = 1;

/**
 * Kolik oken (alespoň) musí tón mít, než se jeho délka traktu ukáže.
 *
 * Tři okna = 3 rámce = 60 ms držení. Jeden tón (jedno okno) není měření —
 * naměřeno, že jednotlivá okna kolísají o ±1 cm. Dvě by šly, ale tři jsou na
 * nahrávce stále u poloviny tónů (viz čísla výš); výš to jde jen za cenu
 * prudkého propadu.
 */
export const VTL_MIN_WINDOWS = 3;

/**
 * Rozpětí, ve kterém se okna téhož tónu považují za TÝŽ tón.
 *
 * Živý režim tóny nesegmentuje, takže začátek tónu pozná jen podle změny
 * noty (`state.lastNote`). Když se nota během držení tónu rozkmitá o půltón
 * (což se u vibrata a v přechodech děje), sada oken by se mazala pořád a číslo
 * by nikdy nedosáhlo prahu. Proto se sada drží, dokud se nota vejde do
 * půltónu; teprve skok na jiný tón (nebo ticho) ji zahodí.
 */
export const VTL_NOTE_KEEP = 1;

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
    // délka vokálního traktu (okno 4096 = tentýž vzorek jako sprWin)
    vtlValues: [],        // okna, která prošla fyziologickým filtrem — od začátku TÓNU
    vtlTones: [],         // hotové tóny (medián jejich oken) — pro souhrn
    vtlNote: null,        // nota, ke které sada oken patří
    vtlNoteCents: null,   // centy té noty (kvůli rozkmitu o půltón)
    frameIndex: 0,        // počítadlo rámců — VTL se počítá každý 3.
    vtlLast: NaN,         // poslední spočítaný odhad (medián sady)
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
 * Délka vokálního traktu pro ŽIVÝ režim — varianta „tón".
 *
 * PROČ „tón" a ne „jehla": číslo z JEDNOHO okna kolísá o ±1 cm (naměřeno), takže
 * by ručička cukala a člověk by nevěděl, čemu věřit. Medián oken od začátku
 * DRŽENÉHO tónu je stabilní a odpovídá tomu, jak číslo počítá report z nahrávky
 * (tam je to medián přes rámce uvnitř tónu). Cena je, že se číslo ukáže až po
 * `VTL_MIN_WINDOWS` oknech (~0,3 s držení tónu) — do té doby UI hlásí „—".
 *
 * Živý režim tóny NESEGMENTUJE (to umí jen analýza celé nahrávky), takže
 * začátek tónu se pozná jen podle VÝŠKY: dokud je nová výška do půltónu od té,
 * se kterou se sada začala, patří okna témuž tónu. Skok na jiný tón sadu zahodí
 * a začne novou. Půltón (ne nula), protože vibrato a přechody se do noty
 * promítají — při přesné shodě by se sada mazala pořád a číslo by nikdy
 * nedosáhlo prahu (naměřeno: sada se nikdy nedostala přes 2 okna).
 *
 * POZOR — do rozestupu jde JEN F1–F3, viz `noteTraktu` v analysis.js. `formantsAt`
 * vrací až pět formantů a s nimi filtrem neprojde nic.
 *
 * @param state  stav z createLiveState
 * @param win    okno 4096 vzorků — TOTÉŽ jako pro SPR, takže není druhý zásobník
 * @param f0     výška rámce (Hz), 0 = ticho
 */
function pushVtl(state, win, f0) {
  if (!(f0 > 0) || !win || win.length < VTL_WIN_SAMPLES) {
    // ticho (nebo okno ještě není) = tón skončil; sada se uzavře do souhrnu
    closeVtlTone(state);
    return;
  }

  const cents = 1200 * Math.log2(f0 / 440);
  if (state.vtlNoteCents === null || Math.abs(cents - state.vtlNoteCents) > 100 * VTL_NOTE_KEEP) {
    closeVtlTone(state);                    // jiný tón — začni znovu
    state.vtlNoteCents = cents;
  }

  // každý VTL_EVERY_FRAMES. rámec; mezitím se vrací poslední známé číslo
  state.frameIndex++;
  if (state.frameIndex % VTL_EVERY_FRAMES !== 0) return;

  const F = formantsAt(win, state.sampleRate, 0, win.length);
  const t = noteTraktu(F[0], F[1], F[2]);
  if (!t) return;                           // LPC chytil harmonickou — nehlásit
  state.vtlValues.push(t.vtl_cm);
  state.vtlLast = median(state.vtlValues);
}

/** Uzavře sadu oken tónu: dost použitelných oken → do souhrnu přes tóny. */
function closeVtlTone(state) {
  if (state.vtlValues.length >= VTL_MIN_WINDOWS) {
    state.vtlTones.push(median(state.vtlValues));
  }
  state.vtlValues = [];
  state.vtlNoteCents = null;
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

    /* 3. Délka vokálního traktu — okno 4096, tedy TOTÉŽ jako SPR. Drží se od
     * začátku tónu a hlásí se medián; viz pushVtl výš. */
    pushVtl(state, sprWin, f0raw);
  } else {
    // ticho tón ukončuje — sada oken se uzavře, aby se počítala do souhrnu
    pushVtl(state, null, 0);
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
    /* Délka vokálního traktu: `vtl` = číslo od začátku DRŽENÉHO tónu (medián
     * jeho oken), `vtlN` = z kolika oken vzniklo. Dokud je oken málo, je NaN
     * a UI ukazuje „—“ — jeden tón není měření. */
    vtl: state.vtlLast,
    vtlN: state.vtlValues.length,
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
  // Rozpracovaný tón se do souhrnu musí vzít taky — jinak by poslední (často
  // nejdelší) tón v měření chyběl.
  closeVtlTone(state);
  const vtl = vtlSummary(state);
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
    /* Délka vokálního traktu (poloha hrtanu). Živý režim tóny segmentuje jen
     * podle výšky, takže se hlásí i počet tónů, ze kterých číslo vzniklo —
     * bez toho by se z jednoho tónu stalo „měření“. Srovnatelné je to
     * s reportem jen relativně (viz delkaTraktu v analysis.js). */
    vtlCm: vtl.cm,
    vtlN: vtl.n,
    vtlWindows: vtl.okna,
  };
}

/**
 * Souhrn délky traktu z celého měření — medián přes TÓNY (ne přes okna).
 *
 * Stejná statistika jako `delkaTraktu`: jedno číslo na tón, pak medián z nich.
 * Kdyby se mediánoval přes okna, dal by delším tónům větší váhu a na
 * nahrávkách s jedním drženým tónem by to vyšlo jinak než v reportu.
 */
export function vtlSummary(state) {
  const t = state.vtlTones || [];
  if (!t.length) return { cm: NaN, n: 0, okna: 0 };
  const s = [...t].sort((a, b) => a - b);
  const h = s.length >> 1;
  return {
    cm: s.length & 1 ? s[h] : (s[h - 1] + s[h]) / 2,
    n: s.length,
    okna: t.length,
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
