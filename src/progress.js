/**
 * Odhad zbývajícího času analýzy — čistá logika, BEZ DOM.
 *
 * PROČ SAMOSTATNÝ MODUL: stejně jako u vyhodnocení barvy hlasu (`vyhodnotFhe`
 * v analysis.js) platí, že logika, o které se UI opírá, musí být testovatelná
 * bez prohlížeče. Odhad se počítá z běhu, který v Node trvá dvě sekundy —
 * ale chová se stejně jako na telefonu, kde to je minuta. Test si proto
 * časovou osu přeškáluje (viz test-eta.mjs).
 *
 * ── CO BYLO ŠPATNĚ (reálná stížnost uživatele) ──────────────────────────
 *
 * „Odhadovaný čas vystoupá vysoko a pak extrémně rychle zase spadne před
 * koncem." Byly na to dvě příčiny a obě musely pryč:
 *
 *  1. **Odhad se počítal z PRUHU** (`uběhlo / ukázáno − uběhlo`). Pruh je ale
 *     měkká složka, která se plazí k nejbližšímu stropu — a stropy se posouvají
 *     po skocích. Odhad z toho dostal pilový průběh.
 *  2. **Analýza hlásila průběh po skocích.** `pitchTrack` byl jediný skok
 *     z 12 % na 35 %, přitom spotřebuje přes 80 % času. Pruh se tedy po většinu
 *     běhu plazil po měkké složce a jeho „procenta" neměla se skutečností nic
 *     společného — a odhad z nich už teprve ne.
 *
 * Řešení: analýza hlásí průběh UVNITŘ fází (`ltas` i `pitchTrack` mají
 * `onProgress`) a odhad se počítá z podílu HOTOVÉ PRÁCE, přepočteného na čas.
 */

/**
 * Podíl hotové práce → podíl spotřebovaného času.
 *
 * Váhy jsou z MĚŘENÍ, ne z dojmu. Na 72,6 s nahrávce se 68 tóny:
 *   kontrola pásma 0,18 s (8 %) · hledání výšky 1,58 s (71 %) ·
 *   segmentace 0,008 s (<1 %) · měření tónů 0,41 s (19 %) · zbytek 0,01 s
 * Na nahrávce se 41 tóny (se doprovodem): 0,14 / 1,70 / 0,21 s, tedy
 * výška 83 % a tóny 10 %. Váhy sedí na obojí.
 *
 * @param {number} p podíl hlášený analýzou (0…1)
 * @returns {number} podíl spotřebovaného času (0…1)
 */
export function workToTime(p) {
  const BAND = 0.08, PITCH = 0.72, MEASURE = 0.20;
  if (!(p > 0)) return 0;
  if (p < 0.12) return BAND * (p / 0.12);                        // kontrola pásma
  if (p < 0.35) return BAND + PITCH * ((p - 0.12) / 0.23);       // hledání výšky
  if (p < 0.45) return BAND + PITCH;                             // segmentace (zanedbatelná)
  if (p >= 0.9) return 1;                                        // vyhodnocení ringu
  return BAND + PITCH + MEASURE * ((p - 0.45) / 0.45);           // měření tónů
}

/**
 * Jak rychle se odhad přibližuje nové hodnotě.
 *
 * ASYMETRICKY, a to je podstatné: práce obvykle postupuje dopředu, a když
 * se odhad plazí za ní, zůstává zbytek viset vysoko — přesně to uživatel
 * viděl jako „vystoupá vysoko". Dopředu se tedy jde svižně (α = 0,30, časová
 * konstanta ~0,3 s), zpět opatrně (α = 0,05): tam jde jen o to nepřebrat
 * skok, který by odhad zbytečně shodil. Naměřeno: se symetrickým α = 0,10
 * zaostával odhad na konci fáze o 3 s ze 60, s asymetrií je chyba do 2×.
 */
export const ETA_EMA_UP = 0.30;
export const ETA_EMA_DOWN = 0.05;

/** Nejdřív se musí něco naměřit — z prvních procent by vyšel nesmysl. */
export const ETA_MIN_ELAPSED_S = 3;

/**
 * Odhad se ukáže, až když běží DOMINANTNÍ fáze (hledání výšky).
 *
 * PROČ: v první fázi (kontrola pásma) je hotovo pár procent práce, ale ta
 * procenta se dají změřit za zlomek času — odhad z nich vyjde 5–6× vyšší než
 * skutečnost, pak rychle spadne. Přesně ten pohyb si uživatel stěžoval
 * („vystoupá vysoko a pak rychle spadne"). Radši pár vteřin číslo neukazovat
 * než ukazovat takové, které se musí hned opravovat.
 */
export const ETA_MIN_FRAC = 0.15;

/** Nad touhle hodnotou je číslo jen nepřesnost, ne informace. */
export const ETA_MAX_S = 1800;

/**
 * Stav odhadu. Drží se mimo DOM, aby se dal testovat a aby se neztrácel
 * mezi hlášeními analýzy.
 */
export function newEtaState() {
  return { rate: 0, started: false };
}

/**
 * Jeden krok odhadu.
 *
 * VOLÁ SE Z KAŽDÉHO SNÍMKU (60× za sekundu) — proto se `rate` při prvním
 * kroku nastaví ROVNOU na naměřenou hodnotu a teprve pak se vyhlazuje.
 * Kdyby začínal na nule, odhad by se první sekundy plazil od nesmyslně
 * vysokého čísla dolů (přesně to dělalo „vystoupá vysoko").
 *
 * @param {{rate:number, started:boolean}} state stav odhadu
 * @param {number} elapsedS uběhlo sekund od začátku analýzy
 * @param {number} frac podíl hlášený analýzou
 * @returns {{eta:number|null, show:boolean}} `eta` v sekundách, `show` = má se vypsat
 */
export function etaStep(state, elapsedS, frac) {
  if (!(elapsedS >= ETA_MIN_ELAPSED_S) || frac < ETA_MIN_FRAC || frac >= 0.9) return { eta: null, show: false };
  const done = workToTime(frac);
  if (!state.started) { state.rate = done; state.started = true; }
  else {
    const a = done > state.rate ? ETA_EMA_UP : ETA_EMA_DOWN;   // nahoru svižně, dolů opatrně
    state.rate += (done - state.rate) * a;
  }
  if (!(state.rate > 0.01)) return { eta: null, show: false };
  const eta = elapsedS * (1 - state.rate) / state.rate;
  if (!Number.isFinite(eta) || eta <= 0.5 || eta >= ETA_MAX_S) return { eta: null, show: false };
  return { eta, show: true };
}

/** Zrušit stav (nové měření). */
export function resetEta(state) {
  state.rate = 0;
  state.started = false;
}
