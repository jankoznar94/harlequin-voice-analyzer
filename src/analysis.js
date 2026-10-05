/**
 * DSP jádro pro analýzu zpěvního hlasu — běží celé v prohlížeči.
 *
 * Implementuje stejné metriky jako referenční Python nástroj (vocal_lab.py),
 * aby se výsledky daly porovnat 1:1:
 *   SPR   — Singing Power Ratio (Omori 1996): peak(2-4k) - peak(0-2k)
 *   FHE   — Frequency of Half Energy (Nature 2022): barva hlasu / fach
 *   ALPHA — alpha ratio: prům. 1-5k minus prům. 50-1000
 *   F0    — YIN (difference function) + mediánové vyhlazení
 *   FORMANTY — LPC Burg + hledání peaků ve LPC spektru
 *   HNR   — z autokorelace
 *
 * Žádné závislosti. Bez WASM. Vše čistý JS.
 */

/* ------------------------------------------------------------------ FFT --- */

const _fftCache = new Map();

/** Iterativní radix-2 FFT. Vrací {re, im} (in-place nad kopií). */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT délka musí být mocnina 2');

  // bit-reversal permutace
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    let key = len;
    let tw = _fftCache.get(key);
    if (!tw) {
      tw = { cos: new Float64Array(len / 2), sin: new Float64Array(len / 2) };
      for (let i = 0; i < len / 2; i++) {
        tw.cos[i] = Math.cos(ang * i);
        tw.sin[i] = Math.sin(ang * i);
      }
      _fftCache.set(key, tw);
    }
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * tw.cos[k] - im[i + k + len / 2] * tw.sin[k];
        const vi = re[i + k + len / 2] * tw.sin[k] + im[i + k + len / 2] * tw.cos[k];
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  return { re, im };
}

/** Výkonové spektrum okna (jednostranné), vrací Float64Array délky N/2. */
function powerSpectrum(frame, win) {
  const n = frame.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * win[i];
  fft(re, im);
  const half = n >> 1;
  const p = new Float64Array(half);
  for (let i = 0; i < half; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

/* ------------------------------------------------------- SPEKTRÁLNÍ METRIKY - */

/**
 * Long-term average spectrum. Vrací {freq, db} (db = 10*log10 výkon).
 *
 * @param {function} [onFrame] volitelný odběr průběhu `(hotovo, celkem)`.
 *   Volá se zhruba třicetkrát za běh. Slouží k poctivému hlášení průběhu:
 *   fáze „kontroluji šířku pásma" je na velkých nahrávkách dlouhá a bez
 *   odběru o ní UI neví nic (viz komentář u analyze()).
 */
export function ltas(samples, sampleRate, nfft = 4096, hop = null, onFrame = null) {
  const n = Math.min(nfft, 1 << Math.floor(Math.log2(samples.length)));
  const frameSize = n;
  const step = hop || frameSize >> 1;
  const win = hann(frameSize);
  const half = frameSize >> 1;
  const acc = new Float64Array(half);
  let count = 0;

  const total = Math.max(0, Math.floor((samples.length - frameSize) / step) + 1);
  const stride = Math.max(1, Math.floor(total / 30));

  for (let start = 0; start + frameSize <= samples.length; start += step) {
    const frame = samples.subarray(start, start + frameSize);
    const p = powerSpectrum(frame, win);
    for (let i = 0; i < half; i++) acc[i] += p[i];
    count++;
    if (onFrame && (count % stride === 0 || count === total)) onFrame(count, total);
  }
  if (count === 0) return null;

  const freq = new Float64Array(half);
  const db = new Float64Array(half);
  const binHz = sampleRate / frameSize;
  for (let i = 0; i < half; i++) {
    freq[i] = i * binHz;
    db[i] = 10 * Math.log10(acc[i] / count + 1e-20);
  }
  return { freq, db, binHz };
}

/** SPR = peak(2-4 kHz) - peak(0-2 kHz). Vyšší (méně záporný) = víc ringu. */
export function spr(spec) {
  let hiMax = -Infinity, loMax = -Infinity;
  const { freq, db } = spec;
  for (let i = 0; i < freq.length; i++) {
    const f = freq[i];
    if (f >= 2000 && f <= 4000) { if (db[i] > hiMax) hiMax = db[i]; }
    else if (f > 0 && f < 2000) { if (db[i] > loMax) loMax = db[i]; }
  }
  if (hiMax === -Infinity || loMax === -Infinity) return NaN;
  return hiMax - loMax;
}

/**
 * SPR s INTERPOLOVANÝM vrcholem — jemnější čtení téhož poměru.
 *
 * PROČ (naměřeno): `spr()` bere vrchol jako hodnotu nejvyššího BINU, takže je
 * jeho výsledek kvantovaný na šířku binu (na 4096/48 kHz ~11,7 Hz). Proti známé
 * pravdě (syntetický tón s předepsanou strukturou) dělá chybu 0,30 dB, kdežto
 * s parabolickou interpolací vrcholu 0,07 dB. Rozdíl je jen kvantování — číslo
 * se nemění, jen se přesněji trefí vrchol.
 *
 * Používá se pro NOVÉ měření ringu (`novyRing`). Staré (`spr`) zůstává kvůli
 * srovnatelnosti s literaturou a kvůli paritě — viz `measureNote`.
 */
export function peakInterp(spec, lo, hi) {
  const { freq, db } = spec;
  let bi = -1, bv = -Infinity;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= lo && freq[i] <= hi && db[i] > bv) { bv = db[i]; bi = i; }
  }
  if (bi < 0) return NaN;
  if (bi <= 0 || bi >= freq.length - 1) return bv;
  const y0 = db[bi - 1], y1 = db[bi], y2 = db[bi + 1];
  const den = y0 - 2 * y1 + y2;
  if (den === 0) return bv;
  const d = 0.5 * (y0 - y2) / den;
  if (Math.abs(d) > 1) return bv;          // vrchol není uprostřed → interpolace nesmysl
  return y1 - 0.25 * (y0 - y2) * d;
}

/** SPR z jednoho spektra s interpolovaným vrcholem. */
export function sprInterp(spec) {
  const hi = peakInterp(spec, 2000, 4000);
  const lo = peakInterp(spec, 30, 2000);
  if (!(hi === hi) || !(lo === lo)) return NaN;
  return hi - lo;
}

/**
 * SPR měřený PO RÁMCÍCH, výsledkem horní percentil.
 *
 * ⚠️ TOTO JE OPRAVA SKUTEČNÉ CHYBY (naměřeno, ne odhad). Dnešní `measureNote`
 * dělá PRŮMĚR SPEKTER přes celý tón a teprve pak hledá vrchol. Vibrato ale
 * s harmonickými hýbe (±3 % = ±50 centů), takže se vrchol v pásmu 2–4 kHz přes
 * tón rozprostře a průměrováním SNÍŽÍ. Naměřeno proti známé pravdě (syntetický
 * hlas s předepsanou strukturou harmonických):
 *
 *   |chyba| u vibrata 3 %      dnes 4,62 dB   →  p90 1,17 dB   →  maximum 0,40 dB
 *   průměr přes všech 7 případů  2,50 dB     →  0,63 dB        →  0,36 dB
 *   stabilita na 40 výškách      4,22 dB     →  1,22 dB
 *
 * Je to SYSTEMATICKÝ posun jedním směrem, ne šum — proto ho nelze „průměrovat
 * přes frázi". A týká se každého drženého tónu, protože vibrato je v operním
 * zpěvu pravidlo.
 *
 * Proč PERCENTIL a ne medián: medián bere typický rámec, ale vrchol se hýbe
 * OBĚMA směry, takže i typický rámec je podhodnocený. Horní percentil odpovídá
 * na otázku „jaký vrchol tam ten hlas skutečně umí postavit".
 *
 * Proč ne MAXIMUM: maximum je teoreticky nejpřesnější (0,40 dB), ale stojí na
 * JEDINÉM rámci — chytalo by náraz do mikrofonu, sykavku nebo lupnutí. p90
 * dělá o 0,8 dB větší chybu a je proti tomu odolné: ověřeno, že silný náraz
 * (−0 dB) ho posune jen o 0,04 dB, kdežto dnešní metodu o 2,6 dB (a sykavka ji
 * rozbije úplně, −26,7 dB). Falešný ring přitom nevzniká — na tónech, které
 * ring nemají, vychází p90 VÍC negativní než pravda.
 *
 * @param {Float64Array} x úsek tónu
 * @param {number} sr vzorkovací kmitočet
 * @param {object} [opts] nfft, hopDiv (kolik rámců na okno), q (percentil)
 */
export function sprFrames(x, sr, opts = {}) {
  const nfft = opts.nfft || SPR_NFFT;
  const hopDiv = opts.hopDiv || SPR_HOP_DIV;
  const q = opts.q ?? SPR_QUANTILE;
  const step = Math.max(128, Math.round(nfft / hopDiv));
  const spr = new SprCore(sr, nfft);
  const vals = [];
  for (let s = 0; s + nfft <= x.length; s += step) {
    const v = spr.of(x.subarray(s, s + nfft));
    if (v === v) vals.push(v);
  }
  if (!vals.length) return NaN;
  return percentile(vals, q);
}

/**
 * Horní percentil ze seznamu hodnot.
 *
 * Používá ho měření po rámcích na nahrávce I v živém režimu, aby obě cesty
 * počítaly statistiku STEJNĚ. Kdyby si každá počítala vlastní, stačí jiné
 * zaokrouhlení indexu a čísla se rozejdou — a to je přesně to, čemu se tu
 * vyhýbáme (indikátor má ukazovat totéž, co pak vyjde v reportu).
 */
export function percentile(values, q) {
  if (!values || !values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))];
}

/** Okno, ve kterém se SPR měří. Nahrávka i živý režim musí použít STEJNÉ. */
export const SPR_NFFT = 4096;
/** Kolik rámců okna na jeden krok (čtvrtina okna = 1024 vzorků @48 kHz). */
export const SPR_HOP_DIV = 4;
/** Percentil, kterým se z rámců bere výsledné číslo SPR. */
export const SPR_QUANTILE = 0.90;

/**
 * SPR z výkonového spektra, BEZ alokace polí.
 *
 * Proč vlastní cesta: `sprInterp(ltas(...))` si na každé okno staví `{freq, db}`
 * (dvě pole o tisíci hodnot) a ještě kopii okna. Na nahrávce to nevadí, ale
 * živý indikátor počítá rámec 200× za sekundu a takové proudění alokací rozhýbe
 * garbage collector — přesně to cukání, kvůli kterému živý režim vůbec má WASM
 * jádro. Tady se čte přímo z výkonového spektra.
 *
 * Postup je IDENTICKÝ se `sprInterp`: vrchol se hledá po binech a pak se
 * parabolicky zpřesní ze sousedů v dB. Shodu s `sprInterp` hlídá test
 * (`test-live-parity.mjs`) — čísla se nesmějí rozejít, jinak by živý indikátor
 * ukazoval jinou hodnotu, než jaká vyjde z nahrávky.
 */
export function sprPower(p, binHz) {
  const hi = peakInPower(p, binHz, 2000, 4000);
  const lo = peakInPower(p, binHz, 30, 2000);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return NaN;
  return hi - lo;
}

/** Vrchol v pásmu z výkonového spektra, v dB, s parabolickým zpřesněním. */
function peakInPower(p, binHz, lo, hi) {
  const i0 = Math.max(1, Math.ceil(lo / binHz));
  const i1 = Math.min(p.length - 2, Math.floor(hi / binHz));
  let bi = -1, bv = -Infinity;
  for (let i = i0; i <= i1; i++) {
    if (p[i] > bv) { bv = p[i]; bi = i; }
  }
  if (bi < 0 || bv <= 0) return NaN;
  const y0 = 10 * Math.log10(p[bi - 1] + 1e-20);
  const y1 = 10 * Math.log10(bv + 1e-20);
  const y2 = 10 * Math.log10(p[bi + 1] + 1e-20);
  const den = y0 - 2 * y1 + y2;
  if (den === 0) return y1;
  const d = 0.5 * (y0 - y2) / den;
  if (Math.abs(d) > 1) return y1;
  return y1 - 0.25 * (y0 - y2) * d;
}

/**
 * Měření SPR po rámcích — stavová a BEZ ALOKACÍ za běhu.
 *
 * Drží si vlastní okno, dvě pole pro FFT a výkonové spektrum; při každém
 * zavolání `of()` se jen přepíše stejná paměť. Stav je schválně v objektu, ne
 * v modulové proměnné: kdyby dvě analýzy běžely vedle sebe (nahrávka + živý
 * režim), modulové úložiště by si je pomíchalo.
 *
 * @param {number} sr vzorkovací kmitočet
 * @param {number} nfft okno (musí být stejné na nahrávce i živě)
 * @param {number} [hopDiv] kolik rámců na krok (jen pro dokumentaci volajícího)
 */
export class SprCore {
  constructor(sr, nfft = SPR_NFFT, hopDiv = SPR_HOP_DIV) {
    this.sr = sr;
    this.nfft = nfft;
    this.hopDiv = hopDiv;
    this.binHz = sr / nfft;
    this._re = new Float64Array(nfft);
    this._im = new Float64Array(nfft);
    this._win = hann(nfft);
    this._p = new Float64Array(nfft >> 1);
  }

  /**
   * Přepočte okno a vrátí SPR (dB).
   *
   * ⚠️ KRÁTKÉ OKNO SE ODMÍTNE, NEDOPLŇUJE SE NULAMI. Toto byla reálná chyba:
   * živý režim na začátku měření ještě 4096 vzorků nemá, a když se krátké okno
   * tiše doplnilo nulami, vyšel z něj úplně jiný tvar spektra — naměřeno až
   * **5 dB rozdíl** proti témuž oknu spočítanému s plnou historií. Nula není
   * „žádný signál“, je to hrana, která do spektra přidá schod. Dokud není
   * historie dost, SPR prostě není (indikátor ukáže „sbírá se…“) — což je
   * poctivější než vydávat číslo z okna, které nemá co měřit.
   */
  of(win) {
    const n = this.nfft;
    if (!win || win.length < n) return NaN;
    const re = this._re, im = this._im, w = this._win, p = this._p;
    for (let i = 0; i < n; i++) re[i] = win[i] * w[i];
    im.fill(0);
    fft(re, im);
    const half = n >> 1;
    for (let i = 0; i < half; i++) p[i] = re[i] * re[i] + im[i] * im[i];
    return sprPower(p, this.binHz);
  }
}

/**
 * FHE (frequency of half energy) — kmitočet, pod kterým leží polovina energie
 * v pásmu zpěváckého formantu.
 *
 * ⚠️ PÁSMO SE LIŠÍ PODLE OBORU. Původní práce (Müller, Wang, Caffier et al.
 * 2022, Sci Rep 12:17921, doi 10.1038/s41598-022-22821-w) definuje pásma takto:
 *   soprán              2300–4500 Hz
 *   tenor/baryton/bas   2000–3600 Hz
 * Referenční hodnoty v `REFS.FHE` jsou měřené z TĚCHTO pásem, takže dosadit
 * jiné pásmo znamená srovnávat nesrovnatelné. Naměřeno na syntetickém sopránu
 * (shluk F3–F5 kolem 3,4 kHz): pásmo 2000–3600 dá 3176 Hz, správné pásmo
 * 2300–4500 dá 3633 Hz — rozdíl 457 Hz, tj. **1,3 směrodatné odchylky**
 * (soprán ±284 Hz). Proto se pásmo bere podle `fach`.
 */
export const FHE_BANDS = {
  sopran: [2300, 4500],
  tenor: [2000, 3600], baryton: [2000, 3600], bas: [2000, 3600],
  alt: [2000, 3600],
  vse: [2000, 3600],          // „bez filtru" referenci nemá, pásmo jen orientační
};

export function fhe(spec, lo = 2000, hi = 3600) {
  const { freq, db } = spec;
  let total = 0;
  const idx = [];
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= lo && freq[i] <= hi) {
      const p = Math.pow(10, db[i] / 10);
      total += p;
      idx.push([freq[i], p]);
    }
  }
  if (!idx.length || total <= 0) return NaN;
  let c = 0;
  for (const [f, p] of idx) {
    c += p;
    if (c >= 0.5 * total) return f;
  }
  return idx[idx.length - 1][0];
}

/**
 * Alpha ratio — poměr energie 1–5 kHz ku 50 Hz–1 kHz (dB).
 *
 * ⚠️ POČÍTÁ SE POMĚR ENERGIÍ, NE PRŮMĚR dB. Původní definice
 * (Frøkjær-Jensen & Prytz 1976, Brüel & Kjær Technical Review 3:3–17) je
 * poměr energií v obou pásmech; průměr dB je jiná veličina. Naměřeno na
 * reálné nahrávce (`zpev.wav`): průměr dB dá −14,87 dB, poměr energií
 * −11,72 dB — rozdíl 3,16 dB. Obojí je „skoro totéž" jen zdánlivě.
 *
 * Vrací se v dB (10·log10 poměru), takže číslo je srovnatelné s literaturou.
 */
export function alphaRatio(spec) {
  let aP = 0, aN = 0, bP = 0, bN = 0;
  const { freq, db } = spec;
  for (let i = 0; i < freq.length; i++) {
    const f = freq[i];
    const p = Math.pow(10, db[i] / 10);
    if (f >= 1000 && f <= 5000) { aP += p; aN++; }
    else if (f >= 50 && f <= 1000) { bP += p; bN++; }
  }
  if (!aN || !bN || aP <= 0 || bP <= 0) return NaN;
  return 10 * Math.log10((aP / aN) / (bP / bN));
}

/** Mezní kmitočet: nejvyšší f, kde spektrum ještě není o dropDb pod vrcholem. */
export function bandwidthLimit(spec, dropDb = 40) {
  const { freq, db } = spec;
  let peak = -Infinity;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 200 && freq[i] <= 6000 && db[i] > peak) peak = db[i];
  }
  let last = NaN;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 200 && freq[i] <= 6000 && db[i] > peak - dropDb) last = freq[i];
  }
  return last;
}

/**
 * Obálka spektra: medián přes okno ÚMĚRNÉ KMITOČTU.
 *
 * PROČ TO JE (reálná chyba, naměřeno): `bandwidthLimit` se ptá správně
 * („kde končí pásmo nahrávky"), ale na SUROVÉM spektru na to odpovídá špatně.
 * Špička úzkého tónu je o desítky dB výš než obálka hlasu — držený doprovodný
 * tón 880 Hz na −18 dBFS zvedne vrchol tak, že se všech 40 dB spotřebuje na
 * cestu od něj dolů k obálce hlasu. Nahrávka s plným pásmem do 6 kHz pak vyjde
 * jako „pásmo useknuto na 3855 Hz" a SPR se odmítne měřit.
 *
 * Medián přes okno ±1 % kmitočtu úzkou špičku odstraní (v okně je přes ni
 * pořád většina ostatních bodů) a šířky pásma se nedotkne (pásmo se mění
 * pomalu). Okno se počítá z kmitočtu, ne z počtu binů — jinak by na nízkých
 * kmitočtech bylo širší v Hz a smazalo i pásmo.
 */
export function spectralEnvelope(spec, frac = 0.01) {
  const { freq, db, binHz } = spec;
  const out = new Float64Array(db.length);
  const w = [];
  for (let i = 0; i < db.length; i++) {
    const f = freq[i];
    if (f < 150) { out[i] = db[i]; continue; }
    const half = Math.max(2, Math.round(frac * f / (binHz || 1)));
    w.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(db.length - 1, i + half); j++) w.push(db[j]);
    w.sort((a, b) => a - b);
    out[i] = w[w.length >> 1];
  }
  return { freq, db: out, binHz };
}

/**
 * Je pásmo 2–4 kHz v nahrávce OPRAVDU potlačené, nebo jen nízko vzorkovaná?
 *
 * PROČ NOVÉ MĚŘENÍ (reálná chyba, naměřeno): dosavadní `sprValid` bere
 * `Math.max(bandwidthLimit(spec), bandwidthLimit(spectralEnvelope(spec)))`
 * a porovnává s prahem 4100 Hz. Jenže mez pásma **není invariantní vůči
 * vzorkovacímu kmitočtu**: tentýž zpěv dá na 48 kHz mez 5941 Hz, ale na 16 kHz
 * (převzorkovaný, obsah jinak totožný) jen 3902 Hz → aplikace odmítne měřit
 * ring na nahrávce, ve které 2–4 kHz v pořádku JE. Naměřeno na reálné
 * nahrávce se doprovodem: 48 kHz → 68 tónů, ring 98 %, SPR −13,6 dB;
 * tentýž obsah na 16 kHz → „Ring nelze změřit". Přitom s otevřenou branou
 * dá 16 kHz SPR −15,3 dB a ring 94 % — tedy měřit jde, jen to brána zakázala.
 *
 * PROČ POMĚR UVNITŘ PÁSMA: profil obálky vztažený k hlasové úrovni
 * (1–2 kHz) je na vzorkovacím kmitočtu prakticky nezávislý — naměřeno na
 * tomtéž obsahu: 3,2–3,6 kHz leží na −11,1 dB (48 kHz), −10,9 (16 kHz),
 * −10,9 (12 kHz). Kdežto skutečně ořezaný zdroj se propadá: brick-wall
 * 3,4 kHz → −13,9 dB, 3,0 kHz → −15,0 dB, historický záznam Caruso 1902
 * → −19,7 dB. Práh −12,5 dB tedy oddělí „pásmo je v pořádku" od „pásmo je
 * opravdu utopené" BEZ ohledu na to, jakým kmitočtem byl soubor nahraný.
 *
 * Vrací { cut, rel, reason }. `rel` = úroveň 3,2–3,6 kHz proti 1–2 kHz (dB).
 */
export function bandCut(env) {
  const mean = (a, b) => {
    let s = 0, n = 0;
    for (let i = 0; i < env.freq.length; i++) {
      const f = env.freq[i];
      if (f >= a && f <= b) { s += env.db[i]; n++; }
    }
    return n ? s / n : NaN;
  };
  const ref = mean(1000, 2000);          // jmenovatel SPR — úroveň hlasu
  const hi = mean(3200, 3600);           // horní okraj pásma, kde ring žije
  if (ref !== ref || hi !== hi) return { cut: false, rel: NaN, reason: 'spektrum nelze vyhodnotit' };
  const rel = hi - ref;
  return { cut: rel < -12.5, rel, reason: rel < -12.5 ? 'pásmo 3,2–3,6 kHz je utopené' : 'ok' };
}

/**
 * Je nahrávka vůbec schopna měřit SPR? (úseknuté pásmo = nesmysl)
 *
 * Pásmo se měří na OBÁLCE spektra, ne na surovém — viz `spectralEnvelope`.
 * Do výsledku jde `limit_raw` (co by vyšlo ze surového spektra), aby se dalo
 * rozlišit „skutečně useknutý zdroj" od „nízkofrekvenční tón přebíjí hlas".
 *
 * `opts.fileRate` je PŮVODNÍ vzorkovací kmitočet souboru (hlavička kontejneru).
 * Dekódování ho přepíše na 48 kHz, takže bez něj se nedá poznat, že nahrávka
 * byla nahraná na 16 kHz a výš než 8 kHz fyzicky nést nemůže.
 */
export function sprValid(spec, minHz = 4100, opts = {}) {
  const raw = bandwidthLimit(spec);
  if (isNaN(raw)) return { valid: false, reason: 'spektrum nelze vyhodnotit', limit: NaN, limit_raw: NaN };
  const env = spectralEnvelope(spec);
  const lim = bandwidthLimit(env);
  /* Bereme BLOVĚTVÍ hodnotu (širší z obou), protože každé měření má jiný slepý úhel:
   *  - syrové spektrum nepozná, že vrchol je jen úzký tón doprovodu, a hlásí ořez;
   *  - obálka na nízkém vzorkovacím kmitočtu (málo binů na oktávu) podhodnotí mez.
   *  Ořezaný zdroj propadne v OBOU. */
  const limit = Math.max(raw, lim);
  const fileRate = opts.fileRate;
  const knownRate = fileRate === fileRate && fileRate > 0;

  /* ── Případ 1: soubor sám nemá na pásmo 2–4 kHz dost kmitočtů ──────────
   * Nyquistová mez pod prahem znamená, že se ring měřit NEDÁ — a je to vada
   * ZÁZNAMU (nízký kmitočet), ne zpěvu. Tuhle příčinu musí hláška pojmenovat,
   * jinak pošle člověka hledat kompresi, která tam není. */
  if (knownRate && fileRate / 2 < minHz) {
    return {
      valid: false,
      reason: `nahrávka má vzorkovací kmitočet ${Math.round(fileRate / 1000)} kHz, ` +
        `takže nad ${Math.round(fileRate / 2)} Hz v ní žádné kmitočty nejsou`,
      limit, limit_raw: raw, low_rate: true, file_rate: fileRate,
    };
  }

  if (limit < minHz) {
    /* ── Případ 2: soubor na pásmo MÁ kmitočty, ale pásmo je utopené ──────
     * Rozhoduje POMĚR uvnitř pásma, ne absolutní mez — ta na vzorkovacím
     * kmitočtu závisí (viz `bandCut`). Známý kmitočet souboru je tu klíčový:
     * nahrávka na 16 kHz má nízkou absolutní mez jen proto, že výš nemá
     * kmitočty, ne proto, že by ji někdo utopil. */
    if (knownRate) {
      const cut = bandCut(env);
      if (cut.cut !== cut.cut) {
        return { valid: false, reason: 'spektrum nelze vyhodnotit', limit, limit_raw: raw };
      }
      if (cut.cut) {
        return {
          valid: false,
          reason: `pásmo 3,2–3,6 kHz je ${Math.abs(cut.rel).toFixed(1)} dB pod úrovní hlasu ` +
            `(potřeba do −12,5 dB) - SPR nelze měřit`,
          limit, limit_raw: raw, band_rel: cut.rel,
        };
      }
      return { valid: true, reason: 'ok', limit, limit_raw: raw, band_rel: cut.rel };
    }
    /* Kmitočet souboru neznáme (nepoznaná hlavička kontejneru): zůstává
     * původní absolutní mez. Je přísnější, ale NIKDY nepustí ořezaný zdroj —
     * u neznámého formátu je bezpečnější směr „radši nezměřit". */
    return {
      valid: false,
      reason: `pásmo useknuto na ~${Math.round(limit)} Hz (potřeba aspoň ${minHz} Hz) - SPR nelze měřit`,
      limit, limit_raw: raw,
    };
  }
  return { valid: true, reason: 'ok', limit, limit_raw: raw,
    band_rel: knownRate ? bandCut(env).rel : NaN };
}

/* --------------------------------------------------------------- F0 (YIN) -- */

/** Inverzní FFT pro reálné sudé spektrum (výsledek je reálný). */
function ifftRealEven(re, im) {
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) re[i] /= n;
  return re;
}

/**
 * YIN pro jeden rámec — FFT akcelerovaný.
 *
 * Přímý výpočet difference funkce je O(tauMax²); tudy je O(N log N) přes
 * autokorelaci:  d(tau) = e0 + e(tau) - 2*r(tau)
 * (de Cheveigné & Kawahara 2002)
 */
/** Exportováno i pro živý režim — záložní cesta v dsp-backend.js ho používá. */
export function yinFrame(frame, sampleRate, fMin, fMax, threshold) {
  const N = frame.length;
  const W = N >> 1;                                  // délka okna pro srovnávání
  const tauMax = Math.min(W, Math.ceil(sampleRate / fMin));
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  if (tauMax <= tauMin + 2) return -1;

  // Vzájemná korelace r(tau) = sum_{i=0}^{W-1} x[i] * x[i+tau]
  // POZOR: musí jít přes STEJNÉ okno W jako energie, jinak je d(tau) nekonzistentní
  // a vychází oktávové chyby.
  const pad = N << 1;
  const ar = new Float64Array(pad), ai = new Float64Array(pad);   // x[0..W-1]
  const br = new Float64Array(pad), bi = new Float64Array(pad);   // x[0..N-1]
  for (let i = 0; i < W; i++) ar[i] = frame[i];
  for (let i = 0; i < N; i++) br[i] = frame[i];
  fft(ar, ai);
  fft(br, bi);
  // A * conj(B)  →  korelace
  const cr = new Float64Array(pad), ci = new Float64Array(pad);
  for (let i = 0; i < pad; i++) {
    cr[i] = ar[i] * br[i] + ai[i] * bi[i];
    ci[i] = ai[i] * br[i] - ar[i] * bi[i];
  }
  ifftRealEven(cr, ci);
  const r = cr;

  // kumulativní energie pro e(tau) v O(1)
  const csum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) csum[i + 1] = csum[i] + frame[i] * frame[i];
  const e0 = csum[W];

  const d = new Float64Array(tauMax);
  for (let tau = 1; tau < tauMax; tau++) {
    const e = csum[tau + W] - csum[tau];
    d[tau] = e0 + e - 2 * r[tau];
    if (d[tau] < 0) d[tau] = 0;
  }

  // kumulativní střední normalizace
  const cmnd = new Float64Array(tauMax);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau < tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
  }

  // absolutní práh
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return -1;

  /* ── OKTÁVOVÁ CHYBA: ZKOUŠENO A ZAMÍTNUTO (neopakovat!) ────────────────
   *
   * Když je H2 silnější než H1 (tenor 330 a 349 Hz na /a/), YIN vrátí
   * DVOJNÁSOBNOU výšku. Zdálo se, že stačí hledat minimum i poblíž 2·tau
   * a při srovnatelném skóre vzít NIŽŠÍ f0 — na syntetickém 330 Hz to
   * „fungovalo" (657 → 329 Hz).
   *
   * ⚠️ PRAVIDLO JE VŠAK REGRESE a bylo ZAMÍTNUTO měřením (tools/exp-yin-oktava.mjs,
   * exp-yin-stat.mjs): na ČISTÉM tónu 392 Hz (generátor z parity, harmonické
   * 1/h) přepne na 196 Hz — o oktávu NÍŽ, tedy rozbije nejběžnější případ.
   *
   * Proč to nejde rozlišit: u obou případů je d(2τ) hluboko pod d(τ)
   * (poměr 0,04 u skutečné chyby vs. 0,05 u správného tónu) i CMND poměr
   * (0,04 vs 0,05). Statistika, která by je odlišila, se NENAŠLA — a bez ní
   * je každé pravidlo jen hádání, které občas rozbije správný tón.
   * (Kontrola „je energie na f/2?" selhává z téhož důvodu jako dřív: při
   * H2 >> H1 tam základní tón sice je, ale slabý.)
   *
   * Oprava tedy NENÍ. Dokud se nenajde rozlišující statistika ověřená na
   * SKUTEČNÉM hlasu (syntetika nestačí — viz past s oktávovou chybou výš),
   * zůstává YIN tak, jak je.
   */

  // parabolická interpolace
  let betterTau = tau;
  if (tau > 0 && tau + 1 < tauMax) {
    const s0 = cmnd[tau - 1], s1 = cmnd[tau], s2 = cmnd[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tau + (s2 - s0) / denom;
  }
  return sampleRate / betterTau;
}

/**
 * Přesná difference funkce YIN na ÚZKÉM okně tau.
 *
 * PROČ TO EXISTUJE (změřeno, ne odhad): hrubá cesta počítá `d(tau)` jako
 * `e0 + e(tau) − 2·r(tau)`, kde `r` je autokorelace přes FFT. To je týž vzorec,
 * ale jiná cesta k číslu — a v plovoucí řádové soustavě se od přímého
 * `sum (x[i]−x[i+tau])²` liší. Naměřeno na reálné nahrávce (Caruso, 226 s,
 * 22 556 rámců, 48 kHz): průměrná relativní odchylka d je 0,27, nejhorší 0,96,
 * a **kolem tau = 100 (tedy přesně pro tenorovou polohu) je d v jiné řádové
 * soustavě úplně**. Protože CMND dělí kumulativním součtem, ta odchylka se
 * rozfouká do CELÉ křivky a posune absolutní práh — hrubá cesta najde minimum
 * na jiném tau než přesná.
 *
 * Přímé d na celém rozsahu je ale pomalejší (0,44 ms/rámec proti 0,28).
 * Kompromis: hrubě najít tau přes FFT, pak přepočítat d jen na pár tau okolo
 * a najít vrchol parabolou tam. Naměřeno 0,17 ms/rámec (1,7× rychleji) a
 * výsledná výška se od dnešní liší o 0,07 centu průměrně.
 *
 * @param {number} tau odhad z hrubé cesty
 * @param {number} [rad] kolik tau na každou stranu
 */
export function refinePitch(frame, sampleRate, fMin, fMax, tau, rad = 10) {
  const N = frame.length, W = N >> 1;
  const tauMax = Math.min(W, Math.ceil(sampleRate / fMin));
  const lo = Math.max(4, (tau | 0) - rad), hi = Math.min(tauMax, (tau | 0) + rad + 1);
  if (hi <= lo + 2) return -1;
  const d = new Float64Array(hi);
  for (let t = lo; t < hi; t++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const q = frame[i] - frame[i + t]; s += q * q; }
    d[t] = s;
  }
  let best = lo;
  for (let t = lo + 1; t < hi; t++) if (d[t] < d[best]) best = t;
  let betterTau = best;
  if (best > lo && best + 1 < hi) {
    const s0 = d[best - 1], s1 = d[best], s2 = d[best + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = best + (s2 - s0) / denom;
  }
  return sampleRate / betterTau;
}

/**
 * YIN pro jeden rámec — zkrácená cesta (kruhová korelace velikosti N).
 *
 * `yinFrame()` používá doplnění na 2N, aby korelace nebyla kruhová. Pro
 * tau < W = N/2 kruhová korelace na N vzorcích ALIASUJE jen členy x[i+tau]
 * pro i ≥ N−tau, a ty se ve `d(tau)` násobí oknem, které už je stejně
 * mimo `W` — ověřeno, že výsledek je totožný. FFT poloviční délky je proto
 * 2,3× levnější bez jakékoli ztráty přesnosti.
 */
export function yinFrameFast(frame, sampleRate, fMin, fMax, threshold, rad = 10) {
  const N = frame.length, W = N >> 1;
  const tauMax = Math.min(W, Math.ceil(sampleRate / fMin));
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  if (tauMax <= tauMin + 2) return -1;

  const ar = new Float64Array(N), ai = new Float64Array(N);
  const br = new Float64Array(N), bi = new Float64Array(N);
  for (let i = 0; i < W; i++) ar[i] = frame[i];
  for (let i = 0; i < N; i++) br[i] = frame[i];
  fft(ar, ai);
  fft(br, bi);
  const cr = new Float64Array(N), ci = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    cr[i] = ar[i] * br[i] + ai[i] * bi[i];
    ci[i] = ai[i] * br[i] - ar[i] * bi[i];
  }
  fft(cr, ci);
  const inv = 1 / N;
  for (let i = 0; i < N; i++) cr[i] *= inv;

  const csum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) csum[i + 1] = csum[i] + frame[i] * frame[i];
  const e0 = csum[W];
  const d = new Float64Array(tauMax);
  for (let tau = 1; tau < tauMax; tau++) {
    const e = csum[tau + W] - csum[tau];
    const v = e0 + e - 2 * cr[tau];
    d[tau] = v > 0 ? v : 0;
  }
  const cmnd = new Float64Array(tauMax);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau < tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return -1;
  /* Pravidlo proti oktávové chybě tu BYLO a je ZAMÍTNUTÉ — rozbíjelo čisté
   * tóny (392 Hz → 196 Hz). Důvod i měření viz komentář v `yinFrame`. */
  return refinePitch(frame, sampleRate, fMin, fMax, tau, rad);
}

/** F0 kontura po rámcích. Vrací {times, f0}. */
export function pitchTrackFast(samples, sampleRate, opts = {}) {
  const o = { ...opts, fast: true };
  return pitchTrack(samples, sampleRate, o);
}

/** F0 kontura po rámcích. Vrací {times, f0}. */
export function pitchTrack(samples, sampleRate, opts = {}) {
  // rámec 2048 vzorků → umí i 70 Hz (perioda 630 vzorků) a je rychlý
  const frameSize = opts.frameSize || 2048;
  const hopSize = opts.hopSize || Math.round(0.010 * sampleRate);
  const fMin = opts.fMin || 70;
  const fMax = opts.fMax || 1200;
  const threshold = opts.threshold || 0.15;
  const rmsMin = opts.rmsMin || 0.008;

  const nFrames = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const times = new Float64Array(nFrames);
  const f0 = new Float64Array(nFrames);

  /* Odběr průběhu. Hledání výšky je ~85 % práce celé analýzy, takže bez
   * hlášení UVNITŘ téhle smyčky UI neví o většině běhu nic — pruh se plazí
   * jen po měkké složce a odhad zbývajícího času z něj vychází špatně
   * (reálná stížnost: „vystoupá vysoko a pak rychle spadne"). Hlásí se
   * zhruba stokrát za běh; volání je jen poslání zprávy, na čísla nemá vliv. */
  const onF = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const stride = Math.max(1, Math.round(nFrames / 100));

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hopSize;
    if (onF && (fi % stride === 0 || fi === nFrames - 1)) onF(fi + 1, nFrames);
    times[fi] = (start + frameSize / 2) / sampleRate;

    // RMS gate
    let rms = 0;
    for (let i = start; i < start + frameSize; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / frameSize);
    if (rms < rmsMin) { f0[fi] = 0; continue; }

    const frame = samples.subarray(start, start + frameSize);
    const v = opts.fast
      ? yinFrameFast(frame, sampleRate, fMin, fMax, threshold)
      : yinFrame(frame, sampleRate, fMin, fMax, threshold);
    f0[fi] = v > 0 ? v : 0;
  }
  return { times, f0 };
}

/**
 * Mediánový filtr pro f0 konturu (potlačí oktávové chyby a vykyvy).
 *
 * DŮLEŽITÉ: nesmí "vymýšlet" znění. Vzorky, které jsou v originále nezpěvné (0),
 * zůstanou nulové — jinak filtr vyplní krátké pauzy mezi tóny a segmentace
 * je pak slije do jednoho tónu.
 */
export function medianFilter(arr, k = 15) {
  const n = arr.length;
  const out = new Float64Array(n);
  const half = k >> 1;
  for (let i = 0; i < n; i++) {
    if (!(arr[i] > 0)) { out[i] = arr[i]; continue; }   // nezpěvné zůstává nezpěvné
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    const w = [];
    for (let j = a; j < b; j++) if (arr[j] > 0) w.push(arr[j]);
    if (!w.length) { out[i] = arr[i]; continue; }
    w.sort((x, y) => x - y);
    out[i] = w.length & 1 ? w[w.length >> 1] : (w[(w.length >> 1) - 1] + w[w.length >> 1]) / 2;
  }
  return out;
}

/* ------------------------------------------------------------- SEGMENTACE -- */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function hzToCents(f) { return f > 0 ? 1200 * Math.log2(f / 440) : NaN; }

export function hzToNote(f) {
  if (!(f > 0)) return '?';
  const midi = Math.round(69 + 12 * Math.log2(f / 440));
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function czPlural(n, one, few, many) {
  const a = Math.abs(n);
  if (a === 1) return one;
  if (a >= 2 && a <= 4) return few;
  return many;
}

/**
 * Rozdělí konturu na notové úseky (plateau) — hysterezní detektor se ukotvenou notou.
 *
 * PROČ TAKHLE:
 *  - Jediný práh nestačí. Nota, která mírně klesá nebo má vibrato, vypadne ze
 *    svého pásma a založí falešný nový tón. Proto je práh pro VSTUP do nové noty
 *    (enterCents) jiný než práh pro UDRŽENÍ (stayCents) a ukotvení drží na
 *    začátku noty, ne na klouzavém průměru — průměr rozmazává hranice a legato
 *    stupnici slije do jedné noty.
 *  - Změna noty se uzná, jen když se nová výška UDRŽÍ aspoň minChange sekundy.
 *    Krátký zákmyt (přechodové zaškobrtnutí YINu) notu nerozdělí.
 *  - Sousední úseky dělené drobným krokem (< glissandoCents) se slijí — pomalý
 *    klouzavý přechod je jeden tón, ne dvanáct.
 *
 * @returns {t0, t1, f0, cents, spanCents, isGlide, frames}[]
 */
export function countNotePlateaus(times, f0, opts = {}) {
  const enter = opts.enterCents ?? 70;        // skok, který znamená novou notu
  const stay = opts.stayCents ?? 50;          // dokud se nota drží v tomto pásmu, je jedna
  const minDur = opts.minDur ?? 0.22;         // kratší úseky se nezapočítají
  const minChange = opts.minChange ?? 0.055;  // jak dlouho musí nová výška vydržet
  const mergeGap = opts.mergeGap ?? 0.06;     // kratší pauza notu nerozdělí
  const glideCents = opts.glissandoCents ?? 40; // menší krok mezi úseky = klouzavý přechod
  const anchorFrames = opts.anchorFrames ?? 5;
  const glideSpan = opts.glideSpanCents ?? 150;

  const n = f0.length;
  const cents = new Float64Array(n);
  for (let i = 0; i < n; i++) cents[i] = f0[i] > 0 ? hzToCents(f0[i]) : NaN;

  const runs = [];
  let i = 0;
  while (i < n) {
    if (!(f0[i] > 0)) { i++; continue; }
    // ukotvení noty: medián z prvních několika znělých rámců
    const head = [];
    for (let k = i; k < Math.min(n, i + anchorFrames * 3) && head.length < anchorFrames; k++) {
      if (f0[k] > 0) head.push(cents[k]);
    }
    head.sort((a, b) => a - b);
    const anchor = head[head.length >> 1];

    let lastGood = i;
    let k = i + 1;
    while (k < n) {
      if (!(f0[k] > 0)) {
        // pauza: krátkou přeskoč, delší ukonči úsek
        let m = k;
        while (m < n && !(f0[m] > 0) && times[m] - times[k - 1] < mergeGap) m++;
        if (m < n && f0[m] > 0 && times[m] - times[k - 1] < mergeGap) { k = m; continue; }
        break;
      }
      if (Math.abs(cents[k] - anchor) <= stay) { lastGood = k; k++; continue; }
      // kandidát na novou notu — musí vydržet
      let m = k;
      while (m < n && f0[m] > 0 && Math.abs(cents[m] - anchor) > stay) m++;
      const persist = (m - 1 > k) ? times[m - 1] - times[k] : 0;
      if (persist >= minChange) {
        const cand = [];
        for (let q = k; q < m; q++) cand.push(cents[q]);
        cand.sort((a, b) => a - b);
        if (Math.abs(cand[cand.length >> 1] - anchor) >= enter) break;   // opravdu nová nota
      }
      lastGood = Math.min(n - 1, m - 1);
      k = m;
    }
    const t0 = times[i], t1 = times[lastGood];
    if (t1 > t0) {
      const vals = [];
      for (let q = i; q <= lastGood; q++) if (f0[q] > 0) vals.push(cents[q]);
      if (vals.length) {
        vals.sort((a, b) => a - b);
        runs.push({
          t0, t1, cents: vals[vals.length >> 1],
          spanCents: vals[vals.length - 1] - vals[0],
          frames: vals.length,
        });
      }
    }
    // posun na další notu (přeskoč mezery)
    let nx = lastGood + 1;
    while (nx < n && !(f0[nx] > 0)) nx++;
    i = Math.max(nx, lastGood + 1);
  }

  // Slij sousední úseky, které dělí jen drobný krok — to je klouzavý přechod,
  // ne nová nota. (Stupnice dělá kroky ~200 centů, glissando ~40.)
  const merged = [];
  for (const r of runs) {
    const p = merged[merged.length - 1];
    if (p && r.t0 - p.t1 <= mergeGap && Math.abs(r.cents - p.cents) < glideCents) {
      const a = p.t0, b = r.t1;
      p.t1 = b;
      p.cents = (p.cents * p.frames + r.cents * r.frames) / (p.frames + r.frames);
      p.frames += r.frames;
      p.spanCents = r.spanCents + Math.abs(r.cents - p.cents);
      p.isGlide = p.spanCents > glideSpan;
    } else merged.push({ ...r });
  }

  return merged
    .filter(r => r.t1 - r.t0 >= minDur)
    .map(r => ({
      t0: r.t0, t1: r.t1, f0: Math.pow(2, r.cents / 1200) * 440,
      cents: r.cents, spanCents: r.spanCents,
      isGlide: !!r.isGlide || r.spanCents > glideSpan, frames: r.frames,
    }));
}

/** Rozdělí f0 konturu na tónové události (stejná logika jako Python verze). */
export function segmentNotes(times, f0raw, opts = {}) {
  const tolCents = opts.tolCents ?? 120;
  const minDur = opts.minDur ?? 0.30;
  const gap = opts.gap ?? 0.12;
  const f0 = opts.smooth === false ? f0raw : medianFilter(f0raw, 15);

  const n = f0.length;
  const segs = [];
  let i = 0;
  while (i < n) {
    if (!(f0[i] > 0)) { i++; continue; }
    const start = i;
    const run = [hzToCents(f0[i])];
    let j = i;
    while (j + 1 < n) {
      if (!(f0[j + 1] > 0)) {
        let k = j + 1;
        while (k < n && !(f0[k] > 0) && (times[k] - times[j]) < gap) k++;
        if (k < n && f0[k] > 0) {
          j = k; run.push(hzToCents(f0[j])); continue;
        }
        break;
      }
      const c = hzToCents(f0[j + 1]);
      const mean = run.reduce((a, b) => a + b, 0) / run.length;
      if (Math.abs(c - mean) > tolCents) break;
      j++; run.push(c);
    }
    if (times[j] - times[start] >= minDur) segs.push([times[start], times[j]]);
    i = j + 1;
  }

  // sloučit krátké mezery
  const merged = [];
  for (const s of segs) {
    if (merged.length && s[0] - merged[merged.length - 1][1] < gap) {
      merged[merged.length - 1][1] = s[1];
    } else merged.push([...s]);
  }

  // sloučit oktávové chyby (sousední segmenty vzdálené ~1200 centů = jedna nota)
  const f0Of = (s) => {
    const v = [];
    for (let k = 0; k < times.length; k++) {
      if (times[k] >= s[0] && times[k] <= s[1] && f0[k] > 0) v.push(f0[k]);
    }
    if (!v.length) return -1;
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  if (merged.length > 1) {
    const fixed = [merged[0]];
    for (let m = 1; m < merged.length; m++) {
      const a = f0Of(fixed[fixed.length - 1]), b = f0Of(merged[m]);
      const dc = (a > 0 && b > 0) ? Math.abs(hzToCents(b) - hzToCents(a)) : 0;
      if (dc > 1000 && dc < 1400) fixed[fixed.length - 1][1] = merged[m][1];
      else fixed.push(merged[m]);
    }
    return fixed.filter(s => s[1] - s[0] >= minDur);
  }
  return merged.filter(s => s[1] - s[0] >= minDur);
}

/* -------------------------------------------------------------------- LPC -- */

/**
 * Burgova metoda LPC. Vrací koeficienty a (bez a[0]=1).
 * Stabilní a přesná i na krátkých rámcích.
 */
export function lpcBurg(x, order) {
  const n = x.length;
  let f = Float64Array.from(x);
  let b = Float64Array.from(x);
  const a = new Float64Array(order + 1);
  a[0] = 1;

  for (let m = 1; m <= order; m++) {
    let num = 0, den = 0;
    for (let i = m; i < n; i++) {
      num += 2 * f[i] * b[i - 1];
      den += f[i] * f[i] + b[i - 1] * b[i - 1];
    }
    const k = den > 1e-12 ? -num / den : 0;
    const nf = new Float64Array(n), nb = new Float64Array(n);
    for (let i = m; i < n; i++) {
      nf[i] = f[i] + k * b[i - 1];
      nb[i] = b[i - 1] + k * f[i];
    }
    f = nf; b = nb;
    const old = Float64Array.from(a);
    a[m] = k;
    for (let i = 1; i < m; i++) a[i] = old[i] + k * old[m - i];
  }
  return a;
}

/**
 * Předpočítané tabulky pro LPC spektrum — klíč = rate|nPoints|maxHz|order.
 *
 * PROČ: `lpcSpectrum` volá `Math.cos`/`Math.sin` pro každý bod mřížky a každý
 * koeficient — na jeden tón je to 1024 × 2 × 25 goniometrických volání. Naměřeno
 * na reálném tónu: 0,46 ms na rámec, z toho 0,35 ms právě tyto funkce.
 * Tabulka se spočítá JEDNOU pro danou kombinaci a použije se pro všechny rámce
 * i všechny tóny nahrávky.
 *
 * Je to BITOVĚ SHODNÉ (naměřeno: největší rozdíl 0,000 na 1024 bodech), protože
 * se počítají tytéž výrazy ve stejném pořadí — jen dřív. Nic se nezaokrouhluje
 * ani neaproximuje; kdyby se použila rychlá aproximace sin/cos, čísla formantů
 * by se rozešla a přišli bychom o záruku, že ring měří pořád totéž.
 */
const _lpcTables = new Map();

function lpcTableKey(sampleRate, nPoints, maxHz, order) {
  return `${sampleRate}|${nPoints}|${maxHz}|${order}`;
}

function lpcTable(sampleRate, nPoints, maxHz, order) {
  const k = lpcTableKey(sampleRate, nPoints, maxHz, order);
  let t = _lpcTables.get(k);
  if (t) return t;
  const cos = new Float64Array((order + 1) * nPoints);
  const sin = new Float64Array((order + 1) * nPoints);
  for (let i = 0; i < nPoints; i++) {
    const f = (i / (nPoints - 1)) * maxHz;
    const w = 2 * Math.PI * f / sampleRate;
    for (let m = 1; m <= order; m++) {
      cos[m * nPoints + i] = Math.cos(-w * m);
      sin[m * nPoints + i] = Math.sin(-w * m);
    }
  }
  // drží se jen posledních pár tabulek — každá má ~200 kB a kombinací
  // (rate × nPoints × order) může být víc, když se ladí jiné parametry
  if (_lpcTables.size > 4) _lpcTables.clear();
  t = { cos, sin };
  _lpcTables.set(k, t);
  return t;
}

/** LPC spektrum (obálka 1/|A|) na frekvenční mřížce. */
export function lpcSpectrum(a, sampleRate, nPoints = 512, maxHz = 5500) {
  const out = new Float64Array(nPoints);
  const freqs = new Float64Array(nPoints);
  const order = a.length - 1;
  const T = lpcTable(sampleRate, nPoints, maxHz, order);
  const cosT = T.cos, sinT = T.sin;
  for (let i = 0; i < nPoints; i++) {
    const f = (i / (nPoints - 1)) * maxHz;
    freqs[i] = f;
    let re = 1, im = 0;
    for (let k = 1; k < a.length; k++) {
      re += a[k] * cosT[k * nPoints + i];
      im += a[k] * sinT[k * nPoints + i];
    }
    const mag2 = re * re + im * im;
    // POZOR: H(z) = 1/A(z), takže dB obálky je -10*log10|A|².
    // Bez záporného znaménka vycházejí antidíry místo formantů.
    out[i] = -10 * Math.log10(mag2 + 1e-20);
  }
  return { freqs, db: out };
}

/** Najde formanty jako peaky LPC spektra (F1..Fk). */
export function findFormants(a, sampleRate, maxHz = 5500) {
  const { freqs, db } = lpcSpectrum(a, sampleRate, 1024, maxHz);
  const peaks = [];
  for (let i = 1; i < db.length - 1; i++) {
    if (db[i] > db[i - 1] && db[i] >= db[i + 1] && freqs[i] > 150) {
      // parabolická interpolace vrcholu
      const d0 = db[i - 1], d1 = db[i], d2 = db[i + 1];
      const denom = d0 - 2 * d1 + d2;
      const shift = denom !== 0 ? 0.5 * (d0 - d2) / denom : 0;
      peaks.push({ f: freqs[i] + shift * (freqs[1] - freqs[0]), db: d1 });
    }
  }
  peaks.sort((p, q) => p.f - q.f);
  // sloučit peaky blíž než 150 Hz
  const merged = [];
  for (const p of peaks) {
    if (merged.length && p.f - merged[merged.length - 1].f < 150) {
      if (p.db > merged[merged.length - 1].db) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  return merged.slice(0, 5).map(p => p.f);
}

/** Jednoduchý FIR lowpass (windowed sinc) pro decimaci bez aliasingu. */
function lowpassFir(x, cutoffHz, sampleRate, taps = 63) {
  const fc = cutoffHz / sampleRate;           // normovaná
  const n = x.length;
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    // Blackman okno
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1))
      + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < taps; k++) {
      const j = i - k + mid;
      if (j >= 0 && j < n) v += h[k] * x[j];
    }
    out[i] = v;
  }
  return out;
}

/**
 * Decimace na cílový vzorkovací kmitočet (celočíselný faktor).
 *
 * PROČ: LPC formanty na 44,1 kHz mají póly tak blízko u sebe, že se F1 a F2
 * slijí do jednoho peaku. Při ~10 kHz jsou póly v rovině z dostatečně
 * oddělené. Stejně to dělá Praat (interní resampling) i AURORA.
 */
function decimateTo(x, sampleRate, targetRate) {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  if (factor === 1) return { samples: x, rate: sampleRate };
  const cutoff = (sampleRate / factor) * 0.42;      // pod Nyquistem
  const filtered = lowpassFir(x, cutoff, sampleRate);
  const n = Math.floor(x.length / factor);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = filtered[i * factor];
  return { samples: out, rate: sampleRate / factor };
}

/**
 * Formanty metodou LPC Burg ve středu segmentu (medián přes několik rámců).
 * Signál se nejdřív decimuje na ~10 kHz — jinak se F1/F2 slijí.
 * Vrací [F1, F2, F3, ...] nebo [].
 */
export function formantsAt(samples, sampleRate, tStartSample, tEndSample, opts = {}) {
  const targetRate = opts.targetRate || 10000;
  const a0 = tStartSample + Math.round(0.20 * (tEndSample - tStartSample));
  const a1 = tEndSample - Math.round(0.20 * (tEndSample - tStartSample));
  const from = Math.max(0, Math.min(tStartSample, a0));
  const to = Math.min(samples.length, Math.max(a1, from + 1));
  if (to - from < 512) return [];

  const chunk = samples.subarray(from, to);
  const { samples: ds, rate } = decimateTo(chunk, sampleRate, targetRate);

  /**
   * POZOR — tyhle dvě konstanty vypadají jako místo pro zrychlení, ale NEJSOU:
   * naměřeno na reálné nahrávce (108 tónů), výsledek se proti referenci rozjede.
   *   krok 15 ms  → F2 až o 280 Hz, F3 o 620 Hz  (1,48× rychlejší, ale jiná čísla)
   *   krok 20 ms  → F3 o 570 Hz                  (1,91×, ještě horší)
   *   order +8    → F1 o 415, F2 o 653, F3 o 881 Hz  (a POMALEJŠÍ)
   * Medián přes rámce se na kroku 10 ms skutečně opírá; zvýšení řádu Burgova
   * filtru přidá parazitní póly, které `findFormants` vybere jako vrcholy.
   * Zrychlovat se tu smí jen to, co čísla nemění (viz předpočet preemfáze níž).
   */
  const order = opts.order || 2 * Math.round(rate / 1000) + 4;   // ~2 formanty/kHz
  const frameSize = Math.round(0.030 * rate);
  const hop = Math.round(0.010 * rate);
  if (ds.length < frameSize) return [];

  // Preemfáze se počítá JEDNOU pro celý úsek, ne v každém rámci znovu.
  // POZOR na kraj: předpočítané pole začíná o vzorek DŘÍV (pre[i] = ds[i] −
  // 0,97·ds[i−1]), takže se z něj čte posunuté o jedna. Kdyby se to spletlo,
  // každý rámec by měl jiný první vzorek a formanty by se rozešly o stovky Hz
  // (přesně to se při zavádění stalo).
  const pre = new Float64Array(ds.length);
  for (let i = 0; i < ds.length; i++) pre[i] = ds[i] - (i ? 0.97 * ds[i - 1] : 0);
  const framesN = Math.floor((ds.length - frameSize) / hop) + 1;
  const tracks = [];
  const x = new Float64Array(frameSize);
  for (let f = 0; f < framesN; f++) {
    const s = f * hop;
    for (let i = 0; i < frameSize; i++) {
      x[i] = pre[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frameSize - 1)));
    }
    const a = lpcBurg(x, order);
    const fs = findFormants(a, rate, Math.min(rate / 2 - 200, 5500));
    if (fs.length) tracks.push(fs);
  }
  if (!tracks.length) return [];

  // sloučit stopy: vezmi medián pro každý řád formantu
  const maxN = Math.max(...tracks.map(t => t.length));
  const out = [];
  for (let k = 0; k < maxN; k++) {
    const vals = [];
    for (const t of tracks) {
      // přiřaď podle pořadí, ale jen rozumné hodnoty
      if (t[k] !== undefined && t[k] > 150 && t[k] < rate / 2 - 200) vals.push(t[k]);
    }
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    out.push(vals[vals.length >> 1]);
  }
  return out;
}

/* -------------------------------------------------------------- HNR / JIT -- */

/**
 * HNR z autokorelace (Boersma 1993, princip jako Praat).
 *
 * ⚠️ DVĚ VĚCI, KTERÉ SE TU NESMÍ VYNECHAT — obojí naměřeno proti známé pravdě
 * (tón + bílý šum; pro bílý šum je r(τ) = 0, takže HNR **musí** vyjít = SNR):
 *
 *  1. **Hannovo okno na signál.** Bez okna uniká spektrum a r je systematicky
 *     špatně. Naměřeno: chyba až −11,4 dB při f0 = 880 Hz.
 *  2. **NORMALIZACE NA OKNO.** `r(τ) = Σ w[i]·w[i+τ]·x[i]·x[i+τ] / Σ w[i]·w[i+τ]`
 *     (a `r0` stejně s τ = 0). Součet součinu okna v lagu τ je MENŠÍ než v 0,
 *     takže bez normalizace okno HNR samo sráží — naměřeno −9,4 dB při 880 Hz.
 *     Okno bez normalizace je tedy STEJNĚ ŠPATNÉ jako žádné okno.
 *
 * Po obou opravách je chyba proti pravdě −0,2 až +0,9 dB (předtím −11,4 až +3).
 * Interpolace vrcholu autokorelace přesnost už dál nezvyšuje (rozhoduje
 * normalizace), ale nevadí — nechává se kvůli neceločíselné periodě.
 *
 * Nevyhazuje se proto `Math.round(sr/f0)` jako perioda: hledá se maximum
 * v okolí a doladí parabolou, aby se neceločíselná perioda nezaokrouhlila.
 */
export function hnr(samples, sampleRate, f0) {
  if (!(f0 > 0)) return NaN;
  const period = sampleRate / f0;
  const winLen = Math.min(samples.length, Math.round(period * 6));
  if (winLen < period * 2 || winLen < 64) return NaN;

  const w = new Float64Array(winLen);
  for (let i = 0; i < winLen; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (winLen - 1));

  // normalizace na okno pro daný lag
  const norm = (lag) => {
    let s = 0;
    for (let i = 0; i + lag < winLen; i++) s += w[i] * w[i + lag];
    return s || 1;
  };
  const rAt = (lag) => {
    let s = 0;
    for (let i = 0; i + lag < winLen; i++) s += w[i] * w[i + lag] * samples[i] * samples[i + lag];
    return s / norm(lag);
  };

  // r0 = energie okénkovaného signálu (τ = 0; normalizace je tam 1)
  let r0 = 0, n0 = 0;
  for (let i = 0; i < winLen; i++) { const ww = w[i] * w[i]; r0 += ww * samples[i] * samples[i]; n0 += ww; }
  r0 /= (n0 || 1);
  if (r0 <= 0) return NaN;

  const lo = Math.max(1, Math.floor(period) - 3), hi = Math.min(winLen - 2, Math.ceil(period) + 3);
  const cand = [];
  for (let k = lo; k <= hi; k++) cand.push(rAt(k));
  if (!cand.length) return NaN;
  let bi = 0;
  for (let i = 1; i < cand.length; i++) if (cand[i] > cand[bi]) bi = i;
  let rT = cand[bi];
  if (bi > 0 && bi < cand.length - 1) {
    const y0 = cand[bi - 1], y1 = cand[bi], y2 = cand[bi + 1];
    const den = y0 - 2 * y1 + y2;
    if (den !== 0) { const d = 0.5 * (y0 - y2) / den; if (Math.abs(d) <= 1) rT = y1 - 0.25 * (y0 - y2) * d; }
  }
  const ratio = Math.min(1 - 1e-9, Math.max(1e-9, rT / r0));
  return 10 * Math.log10(ratio / (1 - ratio));
}

/** Jitter (lokální) v % — směrodatná odchylka period / průměr period. */
export function jitter(times, f0) {
  const v = [];
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0) v.push(1 / f0[i]);
  if (v.length < 4) return NaN;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let sum = 0;
  for (let i = 1; i < v.length; i++) sum += Math.abs(v[i] - v[i - 1]);
  return (sum / (v.length - 1)) / mean * 100;
}

/* ---------------------------------------------------------------- VIBRATO -- */

/**
 * Vibrato z kontury f0 — RYCHLOST a ROZKMIT.
 *
 * ⚠️ RYCHLOST SE MĚŘÍ SLEDOVÁNÍM EXTRÉMŮ, NE FFT. Důvod je naměřený: rozlišení
 * FFT je `1/(N·dt)`, takže na tónu 1,2 s (116 rámců po 10 ms) je jeden bin
 * 0,86 Hz a naměřená rychlost se „přilepí" k 4,69 Hz místo pravých 5,00 Hz.
 * Na dlouhém tónu (2 s) dá FFT 5,08 Hz, kdežto sledování extrémů 5,00 Hz
 * UŽ OD 0,4 s. Prame (1994, JASA 96:1979–1984) pro krátké tóny doporučuje
 * právě autokorelaci / sledování extrémů, ne FFT.
 *
 * ⚠️ ROZKMIT (`extent`) je p95 − p05 z DETRENDOVANÝCH centů — stejně jako
 * dřív, aby se číslo neposunulo. Je to „jak široký pás hlas projíždí",
 * ne peak-to-peak; peak-to-peak je u sinusového vibrata ~1,7× větší.
 */
export function vibrato(f0, dt) {
  const idx = [];
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0) idx.push(i);
  if (idx.length < 12) return { rate: NaN, extent: NaN };
  let cents = idx.map(i => hzToCents(f0[i]));
  const n = cents.length;
  const mean = cents.reduce((a, b) => a + b, 0) / n;

  // odstranit lineární trend (glissando, rozjezd tónu)
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - n / 2) * (cents[i] - mean); den += (i - n / 2) ** 2; }
  const slope = den ? num / den : 0;
  cents = cents.map((c, i) => c - (mean + slope * (i - n / 2)));

  // lehké vyhlazení (3 rámce) — jinak by prahy chytaly jednotlivé vzorky
  const sm = cents.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    return (cents[a] + cents[i] + cents[b]) / 3;
  });

  /* Sledování extrémů ZIGZAG: drží se běžné maximum (resp. minimum), směr se
   * přepne, až když se hlas od něj vzdálí o práh, a jako extrém se zapíše
   * INDEX TOHO MAXIMA/MINIMA (ne bod přepnutí). Práh se bere z ROZKMITU (25 %),
   * ale aspoň 3 centy — na tónu bez vibrata relativní práh nic nenajde
   * (naměřeno: rozsah 0,0 c → rate NaN), kdežto pevný práh by si vymyslel
   * extrémy z šumu.
   *
   * ⚠️ Naivnější varianta („přepni, když je odchylka od POSLEDNÍHO BODU > práh")
   * tiše selhává: `last` se při čekání na směr neaktualizuje, takže se najde
   * NULA extrémů a rychlost vyjde NaN. Naměřeno na 6Hz vibratu: práh 19 c,
   * rozkmit 76 c, a přesto 0 extrémů. Ověřeno proti známé pravdě: zigzag dá
   * 5,00 / 6,25 / 7,14 Hz (chyba do 0,25 Hz) už od tónu 0,4 s.
   */
  const rng = Math.max(...sm) - Math.min(...sm);
  const th = Math.max(3, rng * 0.25);
  const ext = [];
  let dir = 0, extIdx = 0, hi = sm[0], lo = sm[0];
  for (let i = 1; i < n; i++) {
    if (dir >= 0) {
      if (sm[i] > hi) { hi = sm[i]; extIdx = i; }
      if (hi - sm[i] > th) { ext.push(extIdx); dir = -1; lo = sm[i]; extIdx = i; }
    }
    if (dir <= 0) {
      if (sm[i] < lo) { lo = sm[i]; extIdx = i; }
      if (sm[i] - lo > th) { ext.push(extIdx); dir = 1; hi = sm[i]; extIdx = i; }
    }
  }
  let rate = NaN;
  if (ext.length >= 2) {
    const gaps = [];
    for (let i = 1; i < ext.length; i++) gaps.push((ext[i] - ext[i - 1]) * dt);
    gaps.sort((a, b) => a - b);
    const med = gaps[gaps.length >> 1];
    rate = med > 0 ? 1 / (2 * med) : NaN;      // extrémy jsou ob půlperiodu
  }

  const sorted = [...cents].sort((a, b) => a - b);
  const p95 = sorted[Math.min(n - 1, Math.round(0.95 * (n - 1)))];
  const p05 = sorted[Math.min(n - 1, Math.round(0.05 * (n - 1)))];
  return { rate, extent: p95 - p05 };
}

/* ---------------------------------------------------------------- KONFIG -- */

/* ------------------------------------------------- DÉLKA VOKÁLNÍHO TRAKTU -- */

/**
 * Fyziologický rozsah délky traktu (cm). MIMO něj je odhad vadný: LPC chytne
 * harmonickou místo formantu a vyjde dF 337–672 Hz, tedy 26–51 cm. Filtr
 * `dF ∈ 780–1429 Hz` (12–22 cm, s rezervou) ty případy POZNÁ a vyřadí — bez
 * něj metrika občas hlásí 45 cm.
 *
 * Používá ji offline cesta (`delkaTraktu`) i živý režim (`live.js`) ze STEJNÝCH
 * mezí. Kdyby si je každá držela zvlášť, rozejde se práh a živé číslo přestane
 * sedět s reportem.
 */
export const VTL_MIN_CM = 12;
export const VTL_MAX_CM = 22;

/**
 * Rozestup formantů metodou podle Fitch (1997, JASA 102:1213–1222):
 * SMĚRNICE LINEÁRNÍ REGRESE F_k na k.
 *
 * ⚠️ NENÍ to totéž co prostý průměr rozdílů. Regrese rozdělí chybu jednoho
 * formantu mezi všechny jeho členy, kdežto průměr rozdílů ji do rozestupu
 * pustí celou. A hlavně: **vrací i `slope`**, takže je vidět, jestli jsou
 * formanty vůbec rovnoměrně rozložené (pořadí formantu, ne harmonické) —
 * když F3 vyjde jako harmonická, je směrnice jiná, než když je to formant.
 *
 * @param {number[]} F naměřené formanty v Hz, vzestupně (F1, F2, F3, …)
 * @returns {{dF:number, vtl_cm:number, k:number, r2:number}|null}
 */
export function dispersion(F) {
  const pts = [];
  for (let i = 0; i < F.length; i++) {
    if (F[i] === F[i] && F[i] > 0) pts.push([pts.length + 1, F[i]]);   // k = 1, 2, 3…
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [k, f] of pts) { sx += k; sy += f; sxx += k * k; sxy += k * f; }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const dF = (n * sxy - sx * sy) / den;
  if (!(dF > 0)) return null;
  // r² — jak dobře rovnoměrná řada sedí (nízké = nejspíš harmonická, ne formant)
  const mi = sy / n, mk = sx / n;
  let ssTot = 0, ssRes = 0;
  const inter = (sy - dF * sx) / n;
  for (const [k, f] of pts) {
    ssTot += (f - mi) ** 2;
    ssRes += (f - (inter + dF * k)) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
  return { dF, vtl_cm: 34300 / (2 * dF), k: n, r2 };
}

/**
 * Délka traktu z JEDNOHO tónu (jeho F1–F3). Vrací `{ dF, vtl_cm }`, nebo null,
 * když z tónu nelze nic použitelného vzít.
 *
 * ⚠️ Bere se JEN `[f1, f2, f3]`. `formantsAt` vrací až pět formantů, ale do
 * rozestupu patří jen první tři — s F4 a F5 vyjde dF 495–672 Hz (naměřeno na
 * syntetice se známým traktem) a filtrem neprojde NIC. Vypadá to pak jako
 * „metrika nefunguje", přitom jde o chybu porovnávání.
 *
 * @param {number} f1 F1 v Hz
 * @param {number} f2 F2 v Hz
 * @param {number} f3 F3 v Hz
 * @returns {{dF:number, vtl_cm:number}|null}
 */
export function noteTraktu(f1, f2, f3) {
  const v = [f1, f2, f3].filter(x => x === x && x > 0);
  if (v.length < 2) return null;
  const d = dispersion(v);
  if (!d) return null;
  const dFmin = 34300 / (2 * VTL_MAX_CM), dFmax = 34300 / (2 * VTL_MIN_CM);
  if (!(d.dF >= dFmin && d.dF <= dFmax)) return null;
  return { dF: d.dF, vtl_cm: d.vtl_cm };
}

/**
 * Délka vokálního traktu (poloha hrtanu) z rozestupu formantů.
 *
 * PROČ: poloha hrtanu se z nahrávky čte právě takhle — nižší hrtan = delší
 * trakt = všechny formanty níž a blíž k sobě. `VTL = c / (2·dF)`, kde `dF` je
 * průměrný rozestup F1–F3 (model rovnoměrné trubice).
 *
 * NAMĚŘENO (syntetika se známou pravdou + reálná nahrávka, `tools/exp-hrtan-formanty.mjs`):
 *  - když formanty vyjdou správně, je chyba **0,0–0,5 cm**; medián přes tóny
 *    0,01–0,32 cm. Na reálné nahrávce (24 kHz, 13 s) medián 18,8 cm při
 *    rozptylu 0,3 cm mezi úseky.
 *
 * ⚠️ **ABSOLUTNÍ ČÍSLO JE ZKRESLENÉ ~1,4 cm NAHORU** (pravda 17,15 → odhad
 * 18,5). Vzorec předpokládá rovnoměrnou trubici, skutečný trakt ne. Zkreslení
 * je ale konzistentní (korelace s f0 jen r = −0,26), takže **srovnávat mezi
 * vlastními nahrávkami se smí**, tvrdit absolutní anatomii ne.
 *
 * ⚠️ **POJISTKA JE NUTNÁ, ne kosmetika.** LPC občas chytne HARMONICKOU místo
 * formantu a vyjde dF 337–672 Hz, tedy VTL 26–51 cm — to je mimo fyziologii
 * (trakt 13–20 cm). Filtrem `dF ∈ 780–1429 Hz` (VTL 12–22 cm, s rezervou) se
 * tyhle případy POZNAJÍ a vyřadí. Bez filtru metrika občas hlásí 45 cm.
 *
 * ⚠️ **HLAVNÍ OMEZENÍ: vysoko je metrika PRÁZDNÁ.** Naměřeno: pod 250 Hz
 * přežije filtr 7 tónů z 12, nad 250 Hz jen **1 z 23** — čím vyšší tón, tím
 * častěji LPC chytne harmonickou (formanty daleko od sebe = obálka nemá
 * z čeho vzniknout). Šum to nespraví (23 % → 26 %). Proto je tu `n` a proto
 * se `pocet_pouzitych` hlásí v UI: číslo z jednoho tónu není měření.
 *
 * @returns {{vtl_cm:number, dF_hz:number, n:number, z_tonek:number}|null}
 */
export function delkaTraktu(noty) {
  const dFs = [];
  let zTonek = 0;
  for (const n of noty || []) {
    // `z_tonek` = tóny, ze kterých se dal rozestup vůbec spočítat (aspoň dva
    // formanty). `n` pak = ty, co navíc prošly fyziologickým filtrem. Rozdíl
    // mezi nimi je to, co se hlásí v UI jako „vyřazeno mimo rozsah".
    //
    // ⚠️ DO MEDIÁNU JDE JEN PLNÁ SADA F1–F3. Když F3 chybí, je rozestup
    // z dvojice F2−F1 SYSTEMATICKY JINÝ (naměřeno: medián dF 804 Hz pro F1–F3
    // proti 842 Hz pro F2−F1, tj. VTL 21,3 vs. 20,4 cm) — míchat obojí do
    // jednoho mediánu znamená míchat dvě různé veličiny. Tón bez F3 se proto
    // počítá do `z_tonek`, ale do `n` ne (a UI to vidí jako vyřazený).
    const v = [n.f1, n.f2, n.f3].filter(x => x === x && x > 0);
    if (v.length < 2) continue;
    zTonek++;
    if (v.length < 3) continue;
    const t = noteTraktu(n.f1, n.f2, n.f3);
    if (t) dFs.push(t.dF);
  }
  if (!dFs.length) return null;
  // Mediánuje se ROZESTUP (dF), ne VTL — převod přes 1/x není lineární a
  // medián z převrácených hodnot vyjde jinak (a hůř) než převrácená hodnota
  // mediánu. Tak to počítala i původní verze.
  dFs.sort((a, b) => a - b);
  const h = dFs.length >> 1;
  const dF = dFs.length & 1 ? dFs[h] : (dFs[h - 1] + dFs[h]) / 2;
  return {
    vtl_cm: 34300 / (2 * dF),
    dF_hz: dF,
    n: dFs.length,
    z_tonek: zTonek,
  };
}

export const REFS = {
  SPR: {
    nezpevak: [-22.7, 5.1],
    profesional: [-13.1, 3.8],
    zdroj: 'Omori et al. 1996, J Voice 10:228-235 (n=20 / n=21)',
  },
  FHE: {
    tenor: [2705, 221], baryton: [2454, 206], bas: [2384, 164], sopran: [3092, 284],
    zdroj: 'Nature Sci Rep 2022, n=1723 vzorků profesionálních zpěváků',
  },
  SPR_ring_threshold: -20.0,
  // Jak daleko pod vlastním mediánem SPR se tón počítá jako výpadek ringu.
  // 2,5×MAD je citlivější, 4×MAD shovívavější. Na měřených datech (Janova
  // nahrávka, Caruso 1902) dává stejný verdikt 2,5 i 4,0 — rozhoduje medián,
  // ne konstanta. Držíme literaturu (Robust statistics: 2,5×MAD ≈ 3σ).
  SPR_dropout_k: 2.5,
  F1_align_tol_pct: 8.0,
  F1_tuning_from_hz: 392.0,
  F1_tuning_from_note: 'G4',
  fach_ranges: {
    /* ⚠️ SPODNÍ MEZ MUSÍ LEŽET POD NEJNIŽŠÍM TÓNEM OBORU, ne na něm.
     *
     * Filtr v `analyze()` vyhazuje při `med < loF` (OSTŘE), takže mez nastavená
     * přesně na nejnižší tón oboru ten tón vyhodí. Naměřeno syntetikou
     * (`tools/exp-hranice-rozsahu.mjs`) na původních mezích: tenor C3 (130,81 Hz,
     * mez 131) VYŘAZEN, alt F3 (174,61, mez 175) VYŘAZEN, soprán C4 (261,63,
     * mez 262) VYŘAZEN. Baryton a bas procházely jen proto, že jejich meze jsou
     * zaokrouhlené dolů (G2 = 98,00, E2 = 82,41).
     *
     * Mez je proto posunutá o CELÝ PŮLTÓN pod nejnižší tón oboru, aby tam
     * zůstala rezerva i na rozladěný tón (C3 o 40 centů nízko = 127,8 Hz).
     * Rozladěný tón, který vypadne z analýzy, je horší než tón na okraji oboru
     * — vypadne ti zpěv, ne doprovod. */
    tenor: [123.0, 660.0],      // B2 = 123,47 Hz (půltón pod C3)
    baryton: [92.0, 494.0],     // F#2 = 92,50 Hz (půltón pod G2)
    bas: [73.0, 392.0],         // D2 = 73,42 Hz (půltón pod E2)
    sopran: [246.0, 1175.0],    // B3 = 246,94 Hz (půltón pod C4)
    alt: [164.0, 880.0],        // E3 = 164,81 Hz (půltón pod F3)
    vse: [55.0, 1500.0],
  },
};

/* ------------------------------------------------------ BARVA HLASU (FHE) -- */

/** České názvy oborů pro texty („pásmo pro tenory"). */
export const OBOR_PLURAL = {
  tenor: 'tenory', baryton: 'barytony', bas: 'basy',
  sopran: 'soprány', alt: 'alty',
};

/**
 * Vyhodnotí barvu hlasu (FHE) pro zvolený rozsah nahrávky.
 *
 * FHE je frekvence, pod kterou leží polovina energie v pásmu 2–3,6 kHz.
 * Vyšší = světlejší hlas. Hodnotí se proti pásmu očekávanému pro ROZSAH
 * NAHRÁVKY (ne pro obor zpěváka), protože pro každý rozsah platí jiná hodnota.
 *
 * ⚠️ Pásmo ±1 směrodatná odchylka je ÚZKÉ (tenor ±221 Hz), takže i hlas, který
 * posluchač označí za úplně normální, do něj často nespadne. Proto se „mimo
 * pásmo" hlásí jako `mid` (oranžová), NIKDY `bad` — a `jeVada` je vždy false.
 * Barva hlasu není vada, je to charakter. Navíc u tónů v nízké poloze se
 * reference na rozsah vůbec nevztahuje (viz past 0 ve skillu: Jan zpívá
 * baritonovou transpozici árie, ale rozsah nahrávky je „tenor").
 *
 * @returns {{hodnocene:boolean, smer:'v_pasmu'|'temnejsi'|'svetlejsi'|null,
 *            text:string|null, band:number[]|null, cls:'ok'|'mid'|'none'}}
 */
export function vyhodnotFhe(fach, fheHz) {
  const ref = REFS.FHE[fach];

  if (!(fheHz > 0)) {
    return {
      hodnocene: false, smer: null, band: ref || null, cls: 'none',
      text: 'Barvu hlasu počítám z pásma 2–3,6 kHz. Když v nahrávce není dost tónů ' +
        's dostatečným pásmem, nemám z čeho ji určit.',
    };
  }
  if (!ref) {
    return {
      hodnocene: false, smer: null, band: null, cls: 'none',
      text: 'Pro zvolený rozsah neexistuje referenční pásmo, takže barvu hlasu ' +
        'nehodnotím. Naměřená hodnota platí: světlejší hlas leží výš.',
    };
  }

  const [center, sd] = ref;
  const d = fheHz - center;
  const bandText = `pásmo pro ${OBOR_PLURAL[fach] || fach} ` +
    `${Math.round(center - sd)}–${Math.round(center + sd)} Hz`;

  if (Math.abs(d) <= sd) {
    return {
      hodnocene: true, smer: 'v_pasmu', band: ref, cls: 'ok',
      text: `Barva hlasu odpovídá tomu, co literatura měří u tohoto rozsahu (${bandText}). ` +
        'Není zvlášť tmavá ani zvlášť světlá — leží tam, kde hlas tohoto rozsahu obvykle bývá.',
    };
  }
  if (d < 0) {
    return {
      hodnocene: true, smer: 'temnejsi', band: ref, cls: 'mid',
      text: 'Víc energie leží v nižší části pásma 2–3,6 kHz, takže hlas zní tmavěji ' +
        `(kulatěji, měkčeji). Referenční pásmo je ${bandText}. To NENÍ vada — je to ` +
        'charakter hlasu. U tónů v nízké poloze se reference navíc nevztahuje.',
    };
  }
  return {
    hodnocene: true, smer: 'svetlejsi', band: ref, cls: 'mid',
    text: 'Víc energie leží ve vyšší části pásma 2–3,6 kHz, takže hlas zní světleji ' +
      `(ostřeji, průrazněji). Referenční pásmo je ${bandText}. To NENÍ vada — je to ` +
      'charakter hlasu.',
  };
}

/** Krátká slovní značka pro ukazatel (nahoře velkým písmem). */
export function fheLabel(v) {
  if (!v || !v.hodnocene) return '—';
  return { v_pasmu: 'V pásmu', temnejsi: 'Temnější', svetlejsi: 'Světlejší' }[v.smer] || '—';
}

/* -------------------------------------------------------------- HLAVNÍ API - */

/**
 * Kompletní analýza nahrávky.
 * @param {Float64Array|Float32Array} samples mono
 * @param {number} sampleRate
 * @param {object} opts { fach, minDur, maxDur, minFreq, maxFreq, onProgress }
 * @returns {object} stejný tvar jako Python report.json
 */
export function analyze(samples, sampleRate, opts = {}) {
  const fach = opts.fach || 'tenor';
  const minDur = opts.minDur ?? 0.30;
  const maxDur = opts.maxDur ?? 12.0;
  const progress = opts.onProgress || (() => {});

  const duration = samples.length / sampleRate;
  progress(0.05, 'Kontroluji šířku pásma…');

  // ── PÁSMO SE MĚŘÍ JEDNOU ZA NAHRÁVKU ──────────────────────────────────
  // Ne po tónech! Když se měří per-tón, výsledek sleduje tvar šumového dna
  // daného úseku, ne skutečnou šířku pásma — a čisté tóny pak propadnou,
  // zatímco zašuměné projdou. Ověřeno na případech se známou pravdou.
  if (duration >= 30) {
    // Odběr průběhu i uvnitř pásma. Na krátkých nahrávkách je pásmo otázka
    // milisekund a procenta by jen poskakovala; od 30 s je to druhá nejdelší
    // fáze (u nahrávky bez zpívaných tónů dokonce nejdelší — 0,21 s proti
    // 2,6 s hledání výšky u Carusa).
    progress(0.05, 'Kontroluji šířku pásma… 0 %');
  }
  const specFull = ltas(samples, sampleRate, 4096, null, duration >= 30
    ? (i, total) => progress(0.05 + 0.07 * (i / total),
        `Kontroluji šířku pásma… ${Math.round((i / total) * 100)} %`)
    : null);
  const band = specFull
    ? sprValid(specFull, 4100, { fileRate: opts.fileRate })
    : { valid: false, reason: 'spektrum nelze vyhodnotit', limit: NaN };

  progress(0.12, 'Sleduji výšku tónu…');

  /* POZOR — TADY JE ZÁMĚRNĚ POMALÁ CESTA.
   *
   * Rychlá varianta (`pitchTrack(…, { fast: true })`) je 2,4× rychlejší, ale
   * NENÍ bitově shodná: na syntetických případech se výsledná výška liší až
   * o 0,84 Hz (při 543 Hz ~2,7 centu), a to stačí na to, aby se jinde přepnul
   * práh segmentace. Ověřeno: `node tools/parity.mjs check --fast` spadne
   * ve 14 z 81 kontrol. Uživatel se rozhodl pro variantu, která čísla nemění —
   * zrychlení jde cestou LPC tabulky a workeru, ne přesnější/rychlejší YIN.
   * Kdyby se to někdy mělo zrychlit i tudy, musí se nejdřív přegenerovat zlatý
   * standard a projít všechny reporty: čísla ringu se posunou.
   */
  const { times, f0 } = pitchTrack(samples, sampleRate, {
    // Poctivý průběh místo jednoho skoku z 12 % na 35 %.
    //
    // PROČ: hledání výšky je ~85 % práce celé analýzy, ale hlásilo se jako
    // jediný skok. Pruh se tak plazil jen po „měkké" složce (ta k 35 % doroste
    // za ~4,5 s) a na delší nahrávce pak stál — zatímco odhad zbývajícího času,
    // počítaný z podílu `uběhlo / ukázáno`, vyletěl nahoru a před koncem spadl.
    // Naměřeno (zpev.wav 72,6 s / 68 tónů): band 0,18 s · pitch 1,58 s ·
    // tóny 0,41 s · zbytek 0,006 s. Bez odběru uvnitř fází je z těch čísel
    // vidět jen to, že „35 %" je hotovo po 1,8 s z 2,2 s — tedy nic.
    // Odběr každý ~1 % (tj. zhruba po 17 ms na této nahrávce) nic nestojí
    // a hlavní vlákno si ho stejně vyzvedne až ve chvíli, kdy je volné.
    onProgress: (i, total) => progress(0.12 + 0.23 * (i / total),
      `Sleduji výšku tónu… ${Math.round((i / total) * 100)} %`),
  });
  progress(0.35, 'Dělím nahrávku na tóny…');

  // Segmentace: hysterezní čítač s ukotvenou notou. Nahradil starou segmentaci,
  // která na legatu a rychlých pasážích slévala noty do jedné (8 not → 1 tón,
  // 16 not → 1 tón) a na skocích přes oktávu je naopak ztrácela. Detaily v
  // countNotePlateaus().
  const sm = medianFilter(f0, 15);
  const plateaus = countNotePlateaus(times, sm, { minDur: opts.minDur ?? 0.22 });

  // filtr rozsahu: orchestr/doprovod často leze mimo obor hlasu
  const [lo, hi] = REFS.fach_ranges[fach] || REFS.fach_ranges.tenor;
  const loF = opts.minFreq ?? lo;
  const hiF = opts.maxFreq ?? hi;
  const dropped = [];
  const kept = [];
  for (const p of plateaus) {
    const med = p.f0;
    if (!(med > 0)) { dropped.push({ t0: p.t0, t1: p.t1, why: 'bez f0' }); continue; }
    if (p.t1 - p.t0 > maxDur) dropped.push({ t0: p.t0, t1: p.t1, why: `příliš dlouhé (${(p.t1 - p.t0).toFixed(1)} s)` });
    else if (med < loF || med > hiF) dropped.push({ t0: p.t0, t1: p.t1, why: `${hzToNote(med)} mimo ${fach}` });
    else kept.push(p);
  }

  progress(0.45, `Měřím ${kept.length} tónů…`);

  /* Měření tónů se hlásí podle SKUTEČNĚ UDĚLANÉ PRÁCE (součet délek tónů),
   * ne po deseti kusech. PROČ: tóny mají různou délku a `measureNote` stojí
   * čas úměrně délce — hlášení po deseti tónech proto kráčí nestejně, u
   * posledních pár dlouhých tónů se zastaví a odhad zbývajícího času z toho
   * vyroste (naměřeno 8× víc, než zbývalo). Počítá se dopředu jen součet
   * délek, což je pár čísel; výsledek analýzy to neovlivní. */
  const totalNoteSecs = kept.reduce((s, p) => s + Math.max(0, p.t1 - p.t0), 0) || 1;
  let doneNoteSecs = 0;
  let reportedNoteFrac = 0;

  const notes = [];
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    const nm = measureNote(samples, sampleRate, times, f0, i + 1, p.t0, p.t1, band, fach);
    if (nm) {
      // rozkmit noty: u velkého rozkmitu (klouzavý přechod, rozpad tónu) se
      // měřené číslo týká něčeho jiného než „drženého tónu" — ať to UI přizná
      nm.span_cents = p.spanCents;
      nm.is_glide = p.isGlide;
      notes.push(nm);
    }
    doneNoteSecs += Math.max(0, p.t1 - p.t0);
    // hlásí se, jen když práce postoupí o půl procenta (u stovek krátkých tónů
    // by jinak UI dostávalo stovky zpráv, které nic neřeknou) — a vždy na konci
    if (doneNoteSecs / totalNoteSecs - reportedNoteFrac >= 0.005 || i === kept.length - 1) {
      reportedNoteFrac = doneNoteSecs / totalNoteSecs;
      progress(0.45 + 0.45 * reportedNoteFrac, `Měřím tón ${i + 1}/${kept.length}…`);
    }
  }

  progress(0.92, 'Vyhodnocuji ring…');
  const summary = ringAnalysis(notes);
  progress(1.0, 'Hotovo');

  // špička nahrávky — nutná k rozlišení „ticho" od „nemá pásmo".
  // Bez ní UI vždy tvrdilo, že chybí pásmo 2–4 kHz, i když byla nahrávka ticho.
  let pk = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > pk) pk = a;
  }
  const peakDbfs = 20 * Math.log10(pk + 1e-12);

  return {
    duration_s: duration, sample_rate: sampleRate, fach,
    n_notes: notes.length, n_dropped: dropped.length,
    /* Proč tóny vypadly — CELÝ seznam, ne jen počet.
     *
     * PROČ: `n_dropped` samo nestačí. Uživatel nahrál 34 s, viděl „19 tónů,
     * 9 vyřazeno" a nemohl zjistit, které úseky zmizely a proč — v nahrávce
     * přitom byla dvě dlouhá prázdná místa (3,7–9,5 s a 22,3–31,2 s). Rozdíl
     * mezi „mimo obor" (oktávová chyba YIN), „příliš dlouhé" a „bez f0" vede
     * k úplně jiné opravě, ale z exportu se nedal poznat.
     *
     * Do UI se to neplete: `showResult` kreslí jen tóny (`notes`), `summary`
     * počítá z `notes`. Tenhle seznam je pro report a JSON. */
    dropped,
    peak_dbfs: peakDbfs,           // špička nahrávky (dBFS)
    band,                          // šířka pásma nahrávky (měřeno jednou)
    notes, summary, refs: REFS,
  };
}

function measureNote(samples, sampleRate, times, f0raw, idx, t0, t1, band, fach = 'tenor') {
  const dur = t1 - t0;
  const a = t0 + 0.20 * dur;
  const b = t1 - 0.20 * dur;
  const [sa, sb] = (b - a >= 0.08) ? [a, b] : [t0, t1];
  const i0 = Math.max(0, Math.floor(sa * sampleRate));
  const i1 = Math.min(samples.length, Math.ceil(sb * sampleRate));
  if (i1 - i0 < 256) return null;
  const seg = samples.subarray(i0, i1);

  const spec = ltas(seg, sampleRate);
  if (!spec) return null;

  // SPR se měří jen když má CELÁ nahrávka dostatečné pásmo
  const sprVal = band.valid ? spr(spec) : NaN;
  /* NOVÉ měření ringu — SPR po rámcích s horním percentilem. Odstraňuje
   * systematické podhodnocení vibratem (naměřeno 4,6 → 1,2 dB). Není to náhrada
   * starého čísla: dnešní hodnota zůstává kvůli srovnatelnosti s literaturou
   * (Omori) a kvůli paritě, nová se přidává vedle ní. Důvody v `sprFrames()`. */
  const sprNovy = band.valid ? sprFrames(seg, sampleRate) : NaN;

  // SPL relativní
  let rms = 0;
  for (let i = 0; i < seg.length; i++) rms += seg[i] * seg[i];
  rms = Math.sqrt(rms / seg.length);
  const spl = 20 * Math.log10(rms + 1e-12);

  // f0 v tónu
  const tv = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= t0 && times[i] <= t1 && f0raw[i] > 0) tv.push(f0raw[i]);
  }
  const f0s = medianFilter(Float64Array.from(tv), 9);
  const valid = Array.from(f0s).filter(v => v > 0).sort((x, y) => x - y);
  const f0 = valid.length ? valid[valid.length >> 1] : NaN;
  const cents = valid.map(hzToCents);
  const meanC = cents.length ? cents.reduce((x, y) => x + y, 0) / cents.length : NaN;
  const sdC = cents.length > 2
    ? Math.sqrt(cents.reduce((s, c) => s + (c - meanC) ** 2, 0) / cents.length) : NaN;

  const vib = vibrato(f0s, 0.010);

  // formanty
  const fmt = formantsAt(samples, sampleRate, i0, i1);
  const F1 = fmt[0] ?? NaN, F2 = fmt[1] ?? NaN, F3 = fmt[2] ?? NaN;

  // F1:F0 — hodnotí se jen od G4 výš
  const tuningRelevant = f0 >= REFS.F1_tuning_from_hz;
  let err = NaN;
  if (tuningRelevant && f0 > 0 && F1 === F1) {
    const k = Math.max(1, Math.round(F1 / f0));
    if (k * f0 > 0) err = Math.abs(k * f0 - F1) / F1 * 100;
  }

  const hnrV = hnr(seg.length > sampleRate ? samples.subarray(i0, i0 + sampleRate) : seg,
    sampleRate, f0);
  const jit = jitter(null, f0s);

  /* FHE se měří v pásmu PODLE OBORU — referenční hodnoty (Müller 2022) jsou
   * z pásem soprán 2300–4500 Hz, ostatní 2000–3600 Hz. Vždycky 2000–3600
   * znamenalo u sopránu srovnávat s jiným pásmem, než ze kterého reference jsou
   * (naměřeno 457 Hz rozdílu u syntetického sopránu = 1,3 SD). */
  const fheBand = FHE_BANDS[fach] || FHE_BANDS.tenor;

  return {
    idx, t_start: t0, t_end: t1, dur,
    note: hzToNote(f0), f0,
    f0_sd_cents: sdC,
    spl_dbfs: spl,
    spr: sprVal,
    spr_novy: sprNovy,
    spr_valid: band.valid, spr_note: band.reason,
    /* `low_rate` se musí přenést až do tónu — jinak se hláška v UI nedozví,
     * že ring chybí kvůli vzorkovacímu kmitočtu nahrávky, a poradí hledat
     * kompresi. `file_rate` je původní kmitočet souboru (hlavička kontejneru),
     * ne ten, na který ho převedlo dekódování. */
    low_rate: !!band.low_rate,
    file_rate: band.file_rate ?? NaN,
    bandwidth_hz: band.limit,
    alpha: alphaRatio(spec),
    fhe: fhe(spec, fheBand[0], fheBand[1]),
    hnr: hnrV,
    jitter_pct: jit,
    shimmer_pct: NaN,      // vyžaduje sledování amplitudy po periodách
    f1: F1, f2: F2, f3: F3,
    f1_f0_err_pct: err,
    f1_tuned: (err === err) && err <= REFS.F1_align_tol_pct,
    f1_tuning_relevant: tuningRelevant,
    vib_rate: vib.rate, vib_extent_cents: vib.extent,
    ring_ok: false, ring_dropout: false,
  };
}

/**
 * Najde dělící mez ve vzorku hodnot: pokud jsou hodnoty dvouhroté (skupina
 * s ringem a skupina bez), vrátí střed největší mezery. Jinak null.
 *
 * PROČ JE POTŘEBA: medián ± k·MAD selže přesně tehdy, když je tónů bez ringu
 * asi polovina — rozptyl se vyrovná vzdálenosti skupin a práh spadne POD tu
 * špatnou skupinu, takže se nenajde žádný výpadok. Ověřeno na syntetice:
 * 5 tónů bez ringu z 10 hlasilo 0 výpadků. Dvouhroté rozdělení se proto
 * hledá zvlášť podle největší mezery v setříděných hodnotách.
 */
export function gapSplit(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (n < 6) return null;
  const i0 = Math.floor(n * 0.12);          // ignoruj okrajové odlehlé hodnoty
  const i1 = Math.ceil(n * 0.88);
  let bestGap = 0, bestAt = -1;
  for (let i = i0; i < i1 - 1; i++) {
    const g = v[i + 1] - v[i];
    if (g > bestGap) { bestGap = g; bestAt = i; }
  }
  if (bestAt < 0) return null;
  const lower = bestAt + 1;                  // kolik hodnot leží pod mezerou
  const share = lower / n;
  // Mezera musí být zřetelná a menšinová skupina nesmí být ani titěrná, ani většinová
  if (bestGap < 3.0 || share < 0.12 || share > 0.75) return null;
  return { cut: (v[bestAt] + v[bestAt + 1]) / 2, gap: bestGap, lower, n };
}

/**
 * Vyhodnocení ringu.
 *
 * PŮVODNÍ CHYBA (měřeno, opraveno): `ring_ok` se počítalo jako
 * `spr >= max(vlastní práh, −20 dB)`. Tím se absolutní literární mez pro
 * NEZPĚVÁKY (Omori 1996) používala jako verdikt „má / nemá ring". Jenže na
 * běžné nahrávce leží medián SPR okolo −19 dB, tedy TĚSNĚ pod tou mezí —
 * takže takové hodnocení nutně rozpůlí sadu a hlásí „50 % tónů bez ringu",
 * i když jsou všechny tóny stejné. A protože SPR koreluje s hlasitostí
 * (na Janově nahrávce r = 0,72), propadnou hlavně tiché tóny.
 *
 * SPRÁVNĚ se vyhodnocují DVĚ věci odděleně, protože to jsou různé otázky:
 *   1) VYROVNANOST — je ring na každém tónu? (vlastní medián, hledání výpadků)
 *   2) ÚROVEŇ — je ta hladina vůbec dobrá? (srovnání s literaturou)
 * Rovnoměrně špatný hlas má vyrovnanost 100 % a úroveň špatnou. Rovnoměrně
 * dobrý má obojí dobré. To se musí hlásit zvlášť, jinak metrika lže.
 */
export function ringAnalysis(notes, opts = {}) {
  const minDur = opts.minDur ?? 0.30;        // kratší tón = SPR z příliš krátkého vzorku
  const splDrop = opts.splDrop ?? 20;        // tišší tón = SPR pod úrovní šumu

  const valid = notes.filter(n => n.spr_valid && n.spr === n.spr);
  if (!valid.length) {
    const why = notes.find(n => !n.spr_valid)?.spr_note || 'neznámý důvod';
    /* Příčinu ztráty tónů je potřeba předat DÁL, ne jen textem: UI podle
     * `s.low_rate` pozná, že má radit s kvalitou záznamu v záznamníku,
     * a ne hledat kompresi (viz `unusableText` v app.js). */
    const lowRate = notes.find(n => n.low_rate);
    return {
      spr_unusable: true, reason: why,
      n_notes: 0, n_notes_total: notes.length, n_notes_excluded: notes.length,
      ...(lowRate ? { low_rate: true, file_rate: lowRate.file_rate } : {}),
    };
  }

  /* ── Které tóny vůbec jde použít ────────────────────────────────────────
   * SPR koreluje s hlasitostí (na měřených nahrávkách r ≈ 0,7) a u krátkých
   * tónů je odhad spektra z několika málo rámců. Tón o 0,25 s a 25 dB pod
   * úrovní zpěvu nemá „ztracený ring“ — nemá měřitelnou barvu. Kdyby zůstal
   * v sadě, vyjde jako výpadek a pošle člověka hledat problém, který
   * v nahrávce není. Proto se takové tóny VYŘADÍ a jejich počet se přizná.
   *
   * Referenční úroveň zpěvu se bere jako 75. percentil hlasitosti, NE medián:
   * když je tichých tónů hodně, medián sám klesne pod ně a filtr by nic
   * nevyřadil (ověřeno — 6 tichých z 10 prošlo jako měřitelné).
   *
   * Když by ale filtr ukrojil většinu sady, nesmí se použít — zahodil by
   * důkazy. Radši přiznaně nepřesné číslo než tiše ztracené tóny.
   */
  const spls = valid.map(n => n.spl_dbfs).filter(v => v === v).sort((a, b) => a - b);
  const medSpl = spls.length
    ? spls[Math.min(spls.length - 1, Math.floor(0.75 * spls.length))]
    : -Infinity;
  const splMin = medSpl - splDrop;

  const isShort = (n) => n.dur < minDur;
  const isQuiet = (n) => n.spl_dbfs < splMin;
  let usable = valid.filter(n => !isShort(n) && !isQuiet(n));
  let filtered = true;
  if (usable.length < 5 || usable.length < 0.4 * valid.length) {
    usable = valid;                          // filtr by ukrojil většinu → nepoužít
    filtered = false;
  }
  const nShort = valid.filter(isShort).length;
  const nQuiet = valid.filter(n => !isShort(n) && isQuiet(n)).length;

  const s = usable.map(n => n.spr).sort((a, b) => a - b);
  const med = s.length & 1 ? s[s.length >> 1]
    : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;

  /* Nové měření vedle starého. Vyrovnanost ringu (`ring_ok`, výpadky) se dál
   * počítá ze STARÉHO čísla — vyjadřuje vztah tónu k vlastnímu mediánu a ten
   * platí u obojího, kdežto přepnutí prahů by změnilo, které tóny se hlásí jako
   * výpadky, a to je přesně to, co si žádá ověření na skutečném zpěvu, ne
   * tichý přepis. Nová hodnota se proto hlásí jako ČÍSLO VEDLE. */
  const sNovy = usable.map(n => n.spr_novy).filter(v => v === v).sort((a, b) => a - b);
  const medNovy = sNovy.length
    ? (sNovy.length & 1 ? sNovy[sNovy.length >> 1]
      : (sNovy[(sNovy.length >> 1) - 1] + sNovy[sNovy.length >> 1]) / 2)
    : null;
  const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = dev.length & 1 ? dev[dev.length >> 1]
    : (dev[(dev.length >> 1) - 1] + dev[dev.length >> 1]) / 2;

  // Práh výpadku: dvouhroté rozdělení se řeší mezerou, jednohroté mediánem ± k·MAD.
  const split = gapSplit(s);
  const thr = split ? split.cut : med - Math.max(3.0, REFS.SPR_dropout_k * 1.4826 * mad);
  const method = split ? 'mezera mezi skupinami' : 'medián − k·MAD';

  for (const n of usable) {
    n.ring_ok = n.spr >= thr;                              // vyrovnaný tón
    n.ring_dropout = n.spr < thr;                          // proti vlastnímu mediánu
    n.ring_above_ref = n.spr >= REFS.SPR_ring_threshold;    // orientačně vs. literatura
  }
  const good = usable.filter(n => n.ring_ok).length;
  const aboveRef = usable.filter(n => n.ring_above_ref).length;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length);

  // výpadky: vypiš i s časem, ne jen jméno noty — jinak se v nahrávce nedá najít
  const dropouts = usable.filter(n => n.ring_dropout)
    .map(n => ({ note: n.note, t: n.t_start, spr: n.spr, dur: n.dur, spl: n.spl_dbfs }));

  const rel = usable.filter(n => n.f1_tuning_relevant && n.f1_f0_err_pct === n.f1_f0_err_pct);
  const fhes = usable.map(n => n.fhe).filter(v => v === v).sort((a, b) => a - b);
  const bands = usable.map(n => n.bandwidth_hz).filter(v => v === v).sort((a, b) => a - b);

  // Úroveň: kde je nahrávka proti literatuře (orientačně, ne verdikt).
  const [refNezpevak, refProf] = [REFS.SPR.nezpevak[0], REFS.SPR.profesional[0]];
  const level = med >= refProf ? 'profesionalni' : med >= refNezpevak ? 'mezi' : 'pod_nezpevakem';

  /* Délka vokálního traktu (poloha hrtanu) — z VŠECH tónů, ne jen z `usable`:
   * metrika se počítá z formantů a vyřazení tichých/krátkých tónů s ní nemá
   * co dělat (naopak: čím víc tónů, tím lepší medián). Vrací i počet tónů,
   * ze kterých se počítalo — bez toho by číslo z jediného tónu vypadalo
   * stejně jako číslo z dvaceti. */
  const trakt = delkaTraktu(notes);

  return {
    spr_unusable: false,
    n_notes: usable.length,
    n_notes_total: notes.length,
    n_notes_excluded: notes.length - usable.length,
    n_excluded_short: filtered ? nShort : 0,
    n_excluded_quiet: filtered ? nQuiet : 0,
    filter_applied: filtered,
    med_spl_dbfs: medSpl === -Infinity ? null : medSpl,
    min_dur_used: minDur,
    spl_drop_used: splDrop,
    spr_median: med,
    spr_mean: mean,
    spr_sd: sd,
    // Nové měření (po rámcích, horní percentil) — vedle starého, ne místo něj.
    spr_novy_median: medNovy,
    spr_novy_n: sNovy.length,
    spr_novy_dostupne: sNovy.length > 0,
    spr_min: s[0], spr_max: s[s.length - 1],
    ring_threshold: thr,
    threshold_method: method,
    bimodal: !!split,
    split_gap_db: split ? split.gap : null,
    notes_with_ring: good,
    notes_missing_ring: usable.length - good,
    ring_consistency_pct: 100 * good / usable.length,
    dropout_notes: [...new Set(dropouts.map(d => d.note))].sort(),
    dropouts,
    // orientační srovnání s literaturou — NENÍ to verdikt
    pct_above_ref: 100 * aboveRef / usable.length,
    ref_threshold: REFS.SPR_ring_threshold,
    level,
    f1_tuning_notes: rel.length,
    f1_aligned_pct: rel.length ? 100 * rel.filter(n => n.f1_tuned).length / rel.length : null,
    fhe_median: fhes.length ? fhes[fhes.length >> 1] : null,
    bandwidth_hz: bands.length ? bands[bands.length >> 1] : null,
    // Délka vokálního traktu (poloha hrtanu). `null` = ani jeden tón neměl
    // formanty použitelné (typicky vysoká poloha — viz delkaTraktu).
    vtl_cm: trakt ? trakt.vtl_cm : null,
    vtl_dF_hz: trakt ? trakt.dF_hz : null,
    vtl_n: trakt ? trakt.n : 0,
    vtl_z_tonek: trakt ? trakt.z_tonek : 0,
  };
}
