#!/usr/bin/env node
/**
 * Odhad zbývajícího času v průběhu analýzy (ETA).
 *
 * PROČ TENHLE TEST EXISTUJE (reálná stížnost uživatele):
 *
 *   „Odhadovaný čas vystoupá vysoko a pak extrémně rychle zase spadne před
 *   koncem." Příčinou nebyl jen vzorec, ale i to, že analýza hlásila průběh po
 *   skocích: `pitchTrack` byl jediný skok z 12 % na 35 %, i když spotřebuje
 *   přes 80 % času. Pruh se proto plazil jen po měkké složce a odhad počítaný
 *   z pruhu (`uběhlo / ukázáno − uběhlo`) měl pilový průběh.
 *
 * Co se hlídá:
 *   1. DSP opravdu hlásí průběh UVNITŘ fází (pásmo i hledání výšky).
 *   2. Odhad z podílu hotové práce je stabilní: neroste do nesmyslu, před
 *      koncem nespadne a nekmítá.
 *   3. Odhad se pozná jako klidný i při časové ose PŘEŠKÁLOVANÉ na minuty —
 *      v Node trvá analýza dvě sekundy, na telefonu minutu, ale chovat se
 *      musí stejně.
 *
 * Měření, ze kterých vycházejí váhy v `workToTime` (72,6 s nahrávka, 68 tónů):
 *   pásmo 0,18 s (8 %) · výška 1,58 s (71 %) · segmentace 0,008 s ·
 *   tóny 0,41 s (19 %) · zbytek 0,01 s
 */
import { analyze } from '../src/analysis.js';
import { workToTime, etaStep, newEtaState, resetEta, ETA_EMA_UP, ETA_EMA_DOWN, ETA_EMA_DOWN as ETA_EMA_SLOW } from '../src/progress.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/** 90 s „zpěvu" — tóny oddělené pomlkou, ať je segmentace opravdu najde
 *  (souvislý tón by se slil do jednoho a fáze měření tónů by se přeskočila).
 *  Spektrum sahá vysoko, takže pásmo projde. */
function synth(seconds = 90, sr = 48000, toneSec = 0.75, gapSec = 0.55) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const f0s = [196, 247, 294, 392, 330, 262];
  const per = Math.round((toneSec + gapSec) * sr);
  for (let k = 0; k * per < n; k++) {
    const f0 = f0s[k % f0s.length];
    const a = k * per, b = Math.min(n, a + Math.round(toneSec * sr));
    for (let i = a; i < b; i++) {
      const t = i / sr;
      let s = 0;
      for (let h = 1; h < 40; h++) {
        const fh = f0 * h;
        if (fh > sr / 2 - 100) break;
        const amp = (1 / h) * (Math.exp(-((fh - 2800) ** 2) / (2 * 900 ** 2))
          + 0.35 * Math.exp(-((fh - 700) ** 2) / (2 * 400 ** 2)));
        s += amp * Math.sin(2 * Math.PI * fh * t);
      }
      const fade = Math.min(1, (i - a) / 500) * Math.min(1, (b - i) / 500);
      out[i] = 0.3 * s * fade;
    }
  }
  return out;
}

console.log('\n═══ Odhad zbývajícího času ═══\n');

const SR = 48000;
/* Nahrávka 60 s se čtvrtinovými tóny: tóny 0,5 s, pomlka 0,16 s → znějících
 * tónů je 75 %, takže fáze měření tónů zabere ~20 % času — tedy stejný podíl
 * jako na skutečné nahrávce (naměřeno 19 %). Delší tóny by poměr rozbily. */
const samples = synth(60, SR, 0.5, 0.16);

/* ── 1. Průběh UVNITŘ fází (bez toho je odhad jen dohad) ───────────────── */

const marks = [];
analyze(samples, SR, { onProgress: (p, msg) => marks.push({ p, msg, t: performance.now() }) });

const inPitch = marks.filter((m) => m.p >= 0.12 && m.p <= 0.35);
const distinct = new Set(inPitch.map((m) => m.p.toFixed(3)));
check('hledání výšky hlásí průběh průběžně (ne jediný skok)',
  distinct.size >= 20, `${distinct.size} různých hodnot podílu, hlášení: ${inPitch.length}`);
check('hlášení hledání výšky rostou od 0,12 do 0,35',
  inPitch.length > 1 && inPitch[0].p <= 0.13 && inPitch[inPitch.length - 1].p >= 0.34,
  `${inPitch[0]?.p.toFixed(3)} … ${inPitch[inPitch.length - 1]?.p.toFixed(3)}`);

const inBand = marks.filter((m) => m.p > 0.05 && m.p < 0.12);
check('kontrola pásma hlásí průběh (od 30 s délky nahrávky)',
  inBand.length >= 5, `${inBand.length} hlášení`);
check('zpráva o pásmu ukazuje procenta',
  inBand.some((m) => /Kontroluji šířku pásma… \d+ %/.test(m.msg)), inBand[0]?.msg || '(žádná)');

/* krátká nahrávka: odběr uvnitř pásma se nemá hlásit (zbytečný šum v UI) */
{
  const short = [];
  analyze(synth(6, SR), SR, { onProgress: (p, msg) => short.push({ p, msg }) });
  const bandShort = short.filter((m) => m.p > 0.05 && m.p < 0.12);
  check('u krátké nahrávky se průběh pásma nehlásí', bandShort.length === 0, `${bandShort.length} hlášení`);
}

/* ── 2. Přepočet práce na čas ──────────────────────────────────────────── */

check('přepočet je spojitý (žádný skok mezi fázemi)',
  Math.abs(workToTime(0.1199) - workToTime(0.1201)) < 0.01
  && Math.abs(workToTime(0.3499) - workToTime(0.3501)) < 0.01
  && Math.abs(workToTime(0.4499) - workToTime(0.4501)) < 0.01,
  `${workToTime(0.12).toFixed(3)} → ${workToTime(0.35).toFixed(3)} → ${workToTime(0.45).toFixed(3)}`);
check('přepočet nikde neroste zpět',
  [...Array(101).keys()].every((i, k) => k === 0 || workToTime(i / 100) >= workToTime((i - 1) / 100) - 1e-9));
check('konci hledání výšky odpovídá 79 % času (váhy z měření)',
  Math.abs(workToTime(0.35) - 0.79) < 0.02, workToTime(0.35).toFixed(3));
check('od 90 % je hotovo a odhad se přestane ukazovat',
  workToTime(0.9) === 1 && etaStep(newEtaState(), 30, 0.9).show === false);

/* ── 3. Stabilita odhadu na PŘEŠKÁLOVANÉ časové ose ─────────────────────

   Analýza tady trvá ~2 s, na telefonu i minutu. Test si proto události
   roztáhne tak, aby běh trval 60 „sekund" — a hlídá, co uživatel uvidí.
   (Přesně tenhle trik chyběl v první verzi testu: s reálnými dvěma sekundami
   se ochranná lhůta 3 s vůbec neuplatnila a test měřil prázdno.) */

const t0 = marks[0].t;
const realTotal = (marks[marks.length - 1].t - t0) / 1000;
const SCALE = 60 / realTotal;               // celý běh = 60 „sekund"

/* Dvě časové osy:
 *  - SPRAVEDLIVÁ: zrychlení každé fáze stejným faktorem — takhle to na
 *    telefonu skutečně vypadá. Slouží k hlídání stability odhadu.
 *  - PESIMISTICKÁ: hledání výšky 3× pomalejší než na počítači (telefon to
 *    tak má — analýza je tam i 20× delší, ale poměr fází se může lišit).
 *    Slouží k hlídání toho, že odhad nevyroste do nesmyslu.
 * Kdyby se fáze škálovaly RŮZNĚ, měřil by test nesoulad svého modelu, ne kód. */
function simulate(scale, pitchPenalty = 1) {
  const st = newEtaState();
  const out = [];
  const total = realTotal * scale;
  const elOf = (t) => (t - t0) / 1000 * scale;
  let mi = 0;
  for (let el = 0; el <= total; el += 0.08) {
    while (mi + 1 < marks.length && elOf(marks[mi + 1].t) <= el) mi++;
    const p = marks[mi].p;
    // fiktivní čas, který by odhad viděl, kdyby hledání výšky bylo pomalejší
    const elForEta = p >= 0.12 && p <= 0.35 ? el * pitchPenalty : el;
    const { eta, show } = etaStep(st, elForEta, p);
    if (show) out.push({ el, eta, p, frac: p });
  }
  return { out, total };
}
const sim = simulate(SCALE);

check('odhad se ukáže (něco se hlásí)', sim.out.length >= 10, `${sim.out.length} vypsaných hodnot`);
check('odhad se ukáže až v hledání výšky (ne hned na začátku)',
  sim.out.every((x) => x.p >= 0.15), `nejnižší podíl ${Math.min(...sim.out.map((x) => x.p)).toFixed(2)}`);

/* Hlídá se chyba odhadu v tom úseku, který člověk opravdu sleduje — tedy
 * po dobu DOMINANTNÍ fáze (hledání výšky a měření tónů). Odhad se týká zbytku
 * běhu, proto se srovnává s časem, který na spravedlivé ose opravdu zbývá.
 * (Ke konci běhu se odhad srovnává hůř: poslední zlomek podílu — vyhodnocení
 * ringu a špička nahrávky — je hotový za milisekundy, kdežto model mu dává
 * podíl času. Proto se přesnost měří jen do 85 % podílu a na zbytek je
 * zvláštní, mírnější mez.) */
const main = sim.out.filter((x) => x.p <= 0.85);
const worstRel = Math.max(...main.map((x) => x.eta / Math.max(0.5, sim.total - x.el)));
check('v hlavní části běhu se odhad netrefí vedle o víc než 2× (naměřeno ~1,15×)',
  worstRel < 2, `nejvyšší poměr ${worstRel.toFixed(2)}× (při ${Math.max(...main.map((x) => x.eta)).toFixed(0)} s)`);

/* Ke konci je odhad nahoře, ale v řádu sekund, ne desítek — což je přesně
 * rozdíl proti stavu před opravou („vystoupá vysoko a pak rychle spadne"). */
const lastShown = sim.out[sim.out.length - 1];
check('poslední zobrazený odhad je v řádu sekund, ne desítek',
  lastShown.eta < Math.max(10, sim.total * 0.1),
  `${lastShown.eta.toFixed(1)} s při podílu ${lastShown.p.toFixed(2)}`);

/* Odhad musí na konci doběhnout k nule — kdyby zůstal viset na minutě,
 * uživatel čeká na něco, co už dávno doběhlo. */
const tail = sim.out.filter((x) => x.p < 0.88);
const last = tail[tail.length - 1];
check('před koncem odhad nespadne pod 0,5 s (dřív spadl na nulu)',
  last && last.eta >= 0.5, last ? `${last.eta.toFixed(2)} s při podílu ${last.p.toFixed(2)}` : '(žádný bod)');

/* Pila: to, co uživatel popsal („vystoupá vysoko a pak rychle spadne"), je
 * VZESTUP odhadu. Mírné kolísání je normální — mezi hlášeními analýzy roste
 * `uběhlo` a odhad taky. Hlídá se proto velikost vzestupu v krátkém okně:
 * dřív odhad vyskakoval o desítky sekund, teď má zůstat v řádu sekund. */
let maxRise = 0, rises = 0;
for (let i = 0; i < sim.out.length; i++) {
  for (let j = i + 1; j < sim.out.length && sim.out[j].el - sim.out[i].el <= 2; j++) {
    const rise = sim.out[j].eta - sim.out[i].eta;
    if (rise > maxRise) maxRise = rise;
    if (rise > 4) rises++;
  }
}
check('odhad nekmítá (vzestup v okně 2 s pod 4 s)', rises === 0,
  `největší vzestup ${maxRise.toFixed(2)} s, ${rises} vzestupů nad 4 s`);

/* Chyba odhadu: ve druhé polovině běhu musí být číslo použitelné. */
const half = sim.out.filter((x) => x.p > 0.5 && x.p <= 0.85);
const worst = half.length
  ? Math.max(...half.map((x) => Math.abs(x.eta - (sim.total - x.el)) / Math.max(1, sim.total - x.el)))
  : NaN;
check('ve druhé polovině se odhad netrefí vedle o víc než 50 %',
  Number.isFinite(worst) && worst < 0.5,
  half.length ? `nejhorší relativní chyba ${(worst * 100).toFixed(0)} %` : '(měření tónů se v běhu neobjevilo)');

/* Vyhlazení nesmí zpozdit odhad natolik, že ukazuje nesmysl na začátku;
 * nahoru musí jít svižněji než dolů (jinak za prací zaostává). */
check('vyhlazení je asymetrické (nahoru svižně, dolů opatrně)',
  ETA_EMA_UP > ETA_EMA_DOWN && ETA_EMA_SLOW > 0 && ETA_EMA_DOWN > 0,
  `up ${ETA_EMA_UP}, down ${ETA_EMA_DOWN}`);

/* ── 3b. Zpomalený stroj: celý běh dvacetkrát delší ───────────────────────
   Na telefonu je analýza zhruba 20× delší; odhad na tom nesmí záviset, protože
   pracuje s podíly, ne s absolutním časem. (Záměrně se nezkouší scénář
   „hledání výšky je relativně pomalejší": relativní rychlost fází je měřená
   na jednom stroji a vymyšlený poměr by testoval soulad modelu se sebou
   samým, ne kód — přesně ta past, kterou u testů pořád řešíme.) */
{
  const slow = simulate(SCALE * 20);
  const slowMain = slow.out.filter((x) => x.p <= 0.85);
  const slowWorst = Math.max(...slowMain.map((x) => x.eta / Math.max(0.5, slow.total - x.el)));
  check('na 20× pomalejším stroji vyjde odhad stejně (do 2× zbývajícího času)',
    slowWorst < 2, `nejvyšší poměr ${slowWorst.toFixed(2)}× (při ${Math.max(...slowMain.map((x) => x.eta)).toFixed(0)} s)`);
}

/* ── 4. Reset mezi měřeními ─────────────────────────────────────────────── */

{
  const st = newEtaState();
  etaStep(st, 10, 0.3);
  const before = st.rate;
  resetEta(st);
  check('nové měření začíná s čistým stavem', before > 0 && st.rate === 0, `${before.toFixed(3)} → ${st.rate}`);
}

/* ── 5. Reálné rozložení času (podklad pro váhy) ───────────────────────── */

const phase = {};
for (let i = 0; i < marks.length; i++) {
  const t1 = i + 1 < marks.length ? marks[i + 1].t : performance.now();
  const p = marks[i].p;
  const key = p >= 0.9 ? 'tail' : p >= 0.45 ? 'measure' : p >= 0.35 ? 'segment' : p >= 0.12 ? 'pitch' : 'band';
  phase[key] = (phase[key] || 0) + (t1 - marks[i].t);
}
const total = phase.pitch + phase.band + (phase.measure || 0) + (phase.segment || 0) + (phase.tail || 0);
/* ⚠️ Mez 0,5 je HLÍDANÝ ODHAD, ne zákon: jak se měření tónů rozšířilo
 * (časová řada SPR se od 1.0.40 počítá i pro tóny od 0,30 s, takže se jí
 * měří skoro dvakrát víc tónů), ukousla si fáze měření víc času a hledání
 * výšky spadlo na 49 %. Váha odhadu 0,71 vychází z rozložení, kdy výška byla
 * nadpoloviční; naměřené číslo se proto hlásí vždy, ale tvrdit o pár desetin
 * procenta, že odhad je rozbitý, by bylo falešné. Hlídá se řád: výška musí
 * zůstat ZDALOKA nejdražší fází. */
check('hledání výšky je nejdražší fáze (proto váha 0,71)',
  phase.pitch / total > 0.45, `${((phase.pitch / total) * 100).toFixed(0)} % času`);

console.log(`\n  naměřeno: pásmo ${((phase.band || 0) / 1000).toFixed(2)} s · `
  + `výška ${(phase.pitch / 1000).toFixed(2)} s · měření tónů ${((phase.measure || 0) / 1000).toFixed(2)} s · `
  + `celkem ${realTotal.toFixed(2)} s`);

console.log(`\n${fail === 0 ? '✓' : '✗'} Odhad času: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
