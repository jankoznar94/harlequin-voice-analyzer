/**
 * Živý spektrogram — čistá logika bez DOM a bez prohlížeče.
 *
 * Záměrně oddělené od live.js: ten řeší výšku, SPR a trakt, kdežto tady jde
 * jen o jeden sloupec obrazu a jeho normalizaci. Kresba je v live-charts.js.
 *
 * ── Co je na živém spektrogramu jiné než u nahrávky ───────────────────────
 *
 * Nahrávka (drawSpec v charts.js) normalizuje obraz tak, že 99,5. percentil
 * VŠECH PIXELŮ obrazu leží na horním okraji barevné stupnice. Živý režim tenhle
 * údaj nemá — do budoucna nevidí. Nabízely se čtyři cesty a měřily se proti
 * offline obrazu téhož zvuku (`tools/exp-spektrogram-*.mjs`):
 *
 *   A klouzavý percentil (10 s)   střední |Δ| jasu 5,6 z 255
 *   B kumulativní percentil       střední |Δ| 3,1 … a po skoku hlasitosti 0,4
 *   C adaptivní špička            střední |Δ| 17,3 (a po skoku 36,4)
 *   D pevná stupnice              střední |Δ| 17,3, ale první sekundy nejlepší
 *
 * Vyhrálo B — kumulativní percentil od začátku měření. Je to statistika
 * NEJBLÍŽ tomu, co dělá report (oba se přes celé měření sbíhají k témuž číslu),
 * a na rozdíl od špičky (C) se nerozejde po změně hlasitosti: naměřeno při
 * skoku o −20 dB je chyba kumulativní cesty 0,4 proti 36,4 u špičky.
 *
 * ── Dvě pasti, které měřily špatně ───────────────────────────────────────
 *
 * 1. **Percentil přes VŠECHNY PIXELY není totéž co percentil přes VRCHOLY
 *    SLOUPCŮ.** Vrchol sloupce je maximum přes biny, kdežto report počítá
 *    percentil přes všechny biny všech sloupců. Ta dvě čísla vyšla o **8,8 dB**
 *    od sebe (21 úrovní jasu z 255), takže obraz by byl systematicky tmavý.
 *    Řešení: z každého sloupce se do statistiky bere PRAVIDELNÝ VZOREK ŘÁDKŮ
 *    (`SPEC_STAT_STEP`), ne vrchol — vzorek je nevychýlený.
 *    Naměřeno: chyba percentilu 0,7 dB (každý 8. řádek), tři úrovně jasu.
 * 2. **Hodnoty se musí počítat ve STEJNÝCH JEDNOTKÁCH jako report** —
 *    `10·log10(výkonu)` z okna NFFT bez kalibrace na dBFS. Kalibrované hodnoty
 *    by se rozjely o konstantu 10·log10(16/N²) = −48,2 dB a stupnice obrazu
 *    (`dbLo −95 … dbHi 12` v charts.js) by přestala platit.
 *
 * ── První sekundy ────────────────────────────────────────────────────────
 *
 * Než je z čeho vzít percentil, je obraz přesvětlený — naměřeno: v první
 * sekundě je 50 % sloupců v bílém saturovaném pásmu. Proto první `SPEC_WARMUP_S`
 * sekundy jede obraz na pevné hodnotě a pak se plynule předá percentilu.
 * Naměřeno na reálných nahrávkách: s pevným startem je chyba v prvních dvou
 * sekundách ~14 úrovní jasu z 255, bez něj 75–122.
 */

import { fft } from './analysis.js';

/** Délka okna sloupce. Stejná jako u spektrogramu z nahrávky (drawSpec). */
export const SPEC_NFFT = 1024;

/** Nejvyšší zobrazený kmitočet. Stejný jako u nahrávky. */
export const SPEC_MAX_HZ = 6000;

/**
 * Rozsah barevné stupnice — PŘEVZATÝ z drawSpec, nesmí se rozejít.
 * Hodnoty jsou v jednotkách `10·log10(výkonu)`, ne v dBFS (viz hlavička).
 */
export const SPEC_DB_LO = -95;
export const SPEC_DB_HI = 12;

/**
 * Kolikátý řádek obrazu jde do statistiky normalizace.
 *
 * Obraz má ~192 řádků; brát z každého sloupce všech 192 hodnot by znamenalo
 * držet v paměti celý obraz. Vzorek po osmi (24 hodnot na sloupec) naměřil
 * chybu percentilu 0,7 dB proti přesné pravdě — tedy tři úrovně jasu z 255,
 * což je pod rozlišovací schopností oka.
 */
export const SPEC_STAT_STEP = 8;

/** První sekundy měření: obraz na pevné hodnotě, než je z čeho vzít percentil. */
export const SPEC_WARMUP_S = 2;

/**
 * Na kolik dB se obraz v prvních sekundách normuje.
 *
 * 34 v jednotkách reportu odpovídá ≈ −14 dBFS (naměřeno na reálných
 * nahrávkách: pravda vyšla −16,1 a −15,2 dBFS, takže 34 je blíž).
 * Je to táž úloha jako u `RMS_GATE` nebo `CENTS_OK` — konstanta odladěná
 * měřením, ne odhad.
 */
export const SPEC_WARMUP_DB = 34;

/**
 * Jak dlouhý je klouzavý zásobník vzorků pro sloupce.
 *
 * Sloupec se bere z POSLEDNÍCH `SPEC_NFFT` vzorků, takže při 48 kHz stačí
 * 1024 vzorků a nic dalšího se držet nemusí. Živý režim ale může rámec
 * propásnout (karta na pozadí, pomalý stroj), a pak se bere posledních
 * 1024 vzorků znovu — obraz se prostě nezopakuje, místo aby se doplňoval
 * nesmysl. Drží se proto okno 4096 (totéž, jaké má SPR), aby sloupec vždycky
 * vznikl z PLNÉHO okna a ne z okna doplněného nulami.
 */
export const SPEC_BUF_SAMPLES = 4096;

/* ── normalizace: histogram ──────────────────────────────────────────────── */

/*
 * Percentil z kumulativní historie se MUSÍ počítat levně. Přepočet tříděním
 * naměřil 0,3–0,7 ms na jedno přečtení — jenže normalizace se čte každý rámec,
 * tedy 50× za sekundu, a to je 1,5–3,5 % rozpočtu.
 *
 * Řešení: histogram. Hodnoty chodí po jedné (24 na sloupec) a percentil je
 * čtení z hotového histogramu — O(počet přihrádek), tedy pár set operací,
 * naměřeno 0,004 ms. Přesnost je daná šířkou přihrádky: 0,25 dB je 0,6 úrovně
 * jasu z 255, což je hluboko pod rozlišovací schopností oka i displeje.
 */

/** Šířka přihrádky histogramu v dB. */
export const SPEC_HIST_BUCKET = 0.25;

/** Rozsah histogramu v jednotkách reportu (ticho je −200, špičky ~50). */
export const SPEC_HIST_MIN = -220;
export const SPEC_HIST_MAX = 60;

const HIST_N = Math.round((SPEC_HIST_MAX - SPEC_HIST_MIN) / SPEC_HIST_BUCKET) + 1;

/**
 * Vytvoří histogram pro kumulativní percentil.
 *
 * Prázdný histogram vrací NaN — volající se podle toho rozhodne, že ještě
 * není z čeho normalizovat (a použije pevnou startovní hodnotu).
 */
export function createHistogram() {
  return { bins: new Float64Array(HIST_N), total: 0 };
}

/** Přidá hodnotu do histogramu (hodnoty mimo rozsah se přiříznou na okraj). */
export function histAdd(h, db) {
  let i = Math.round((db - SPEC_HIST_MIN) / SPEC_HIST_BUCKET);
  if (!Number.isFinite(i)) return;
  if (i < 0) i = 0; else if (i >= HIST_N) i = HIST_N - 1;
  h.bins[i]++;
  h.total++;
}

/** Percentil z histogramu (q = 0,995 → 99,5. percentil). */
export function histQuantile(h, q = 0.995) {
  if (!h.total) return NaN;
  const need = q * h.total;
  let c = 0;
  for (let i = 0; i < HIST_N; i++) {
    c += h.bins[i];
    if (c >= need) return SPEC_HIST_MIN + i * SPEC_HIST_BUCKET;
  }
  return SPEC_HIST_MAX;
}

/* ── stav a zpracování sloupce ───────────────────────────────────────────── */

/**
 * Vytvoří stav živého spektrogramu.
 *
 * @param sampleRate vzorkovací kmitočet (Hz)
 * @param rows       počet řádků obrazu — musí být stejný jako při kresbě
 */
export function createSpecState(sampleRate = 48000, rows = 192) {
  const win = new Float64Array(SPEC_NFFT);
  for (let i = 0; i < SPEC_NFFT; i++) {
    win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (SPEC_NFFT - 1));
  }
  const binHz = sampleRate / SPEC_NFFT;
  return {
    sampleRate,
    rows,
    win,
    binHz,
    maxBin: Math.min(SPEC_NFFT / 2 - 1, Math.ceil(SPEC_MAX_HZ / binHz)),
    re: new Float64Array(SPEC_NFFT),
    im: new Float64Array(SPEC_NFFT),
    /* Do kterého binu patří který řádek obrazu — počítá se jednou, ne při
     * každém sloupci (přes 192 řádků × 50 rámců za sekundu by to bylo
     * zbytečných 9600 přepočtů za sekundu). */
    rowBin: null,
    hist: createHistogram(),
    frames: 0,
    norm: SPEC_WARMUP_DB,
    /* Jaká částka je v obraze nová — používá kresba, aby věděla, jestli má
     * posunout, nebo nakreslit celý obraz znovu. */
    seq: 0,
  };
}

/** Dopočítá mapu řádek → bin (líně, protože potřebuje `rows`). */
function rowBins(st) {
  if (st.rowBin) return st.rowBin;
  const m = new Int32Array(st.rows);
  for (let row = 0; row < st.rows; row++) {
    const frac = 1 - row / st.rows;
    m[row] = Math.min(st.maxBin, Math.round(frac * st.maxBin));
  }
  st.rowBin = m;
  return m;
}

/**
 * Jeden sloupec obrazu z okna vzorků.
 *
 * Hodnoty jsou v jednotkách reportu (`10·log10(výkonu)`) a do statistiky
 * normalizace jde POUZE každý `SPEC_STAT_STEP`. řádek — kdyby se do statistiky
 * dával vrchol sloupce, vyšel by percentil o 8,8 dB výš a obraz by byl tmavý
 * (naměřeno).
 *
 * @param st   stav z createSpecState
 * @param win  okno vzorků (bere se posledních `SPEC_NFFT`)
 * @returns Float64Array(rows) hodnot pro kresbu, nebo null když okno nestačí
 */
export function specColumn(st, win) {
  if (!win || win.length < SPEC_NFFT) return null;
  const off = win.length - SPEC_NFFT;
  const re = st.re, im = st.im;
  for (let i = 0; i < SPEC_NFFT; i++) {
    re[i] = win[off + i] * st.win[i];
    im[i] = 0;
  }
  fft(re, im);

  const bins = rowBins(st);
  const out = new Float64Array(st.rows);
  for (let row = 0; row < st.rows; row++) {
    const b = bins[row];
    out[row] = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-20);
    if (row % SPEC_STAT_STEP === 0) histAdd(st.hist, out[row]);
  }
  return out;
}

/**
 * Posune stav o jeden sloupec a vrátí, co má kresba vykreslit.
 *
 * Normalizace: první `SPEC_WARMUP_S` sekundy pevná hodnota, pak percentil
 * z histogramu. Přechod není skokový — obraz by při skoku cuknul jasem —
 * ale plynulý přes jedno okno (0,5 s).
 *
 * @returns { column, norm, warm, frames }
 */
export function feedSpec(st, win) {
  const col = specColumn(st, win);
  if (!col) return null;
  st.frames++;

  const warmFrames = Math.round(SPEC_WARMUP_S * 50);       // rámců po 20 ms
  const p = histQuantile(st.hist, 0.995);
  let warm = false;
  if (st.frames <= warmFrames || !Number.isFinite(p)) {
    st.norm = SPEC_WARMUP_DB;
    warm = true;
  } else {
    const blendFrames = 25;                                // 0,5 s na přechod
    const k = st.frames - warmFrames;
    const w = Math.min(1, k / blendFrames);
    st.norm = p * w + SPEC_WARMUP_DB * (1 - w);
  }
  st.seq++;
  return { column: col, norm: st.norm, warm, frames: st.frames };
}
