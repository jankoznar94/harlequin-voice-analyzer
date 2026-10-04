#!/usr/bin/env node
/**
 * Délka vokálního traktu (poloha hrtanu) — metrika musí SEDĚT NA PRAVDĚ.
 *
 * ⚠️ Test nehlídá jen „funkce něco vrátí". Špatné číslo je horší než žádné,
 * takže se ověřuje proti ZNÁMÉ PRAVDĚ: syntetický hlas se staví s pevně
 * danými formanty, takže délka traktu je spočitatelná dopředu.
 *
 * Tři věci, které musí platit (jinak metrika lže):
 *   1. PŘESNOST — když formanty vyjdou, je chyba do ~0,5 cm
 *   2. POJISTKA — fyzikálně nemožné hodnoty (LPC chytí harmonickou) se vyřadí,
 *      neohlásí se jako 45 cm trakt
 *   3. POČET TÓNŮ — vysoko je metrika prázdná, takže se to musí POZNAT
 *      (`n` musí odpovídat tomu, co skutečně prošlo)
 */
import { delkaTraktu } from '../src/analysis.js';

const fmt = (v, d = 2) => (v === v && v !== null && v !== undefined ? v.toFixed(d) : '—');
const SR = 48000;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/* ── syntetický hlas s PŘEDEPSANÝMI formanty ────────────────────────────── */

function ton(f0, F, sekund = 1.4) {
  const n = Math.round(sekund * SR);
  const out = new Float64Array(n);
  const res = (fc, bw, a) => a / (1 + ((f0 * 0 - fc) / bw) ** 2);
  const gain = (f) => {
    const r = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
    return r(F[0], 120, 1.0) + r(F[1], 180, 0.45) + r(F[2], 220, 0.30)
         + r(3000, 250, 0.22) + r(3500, 300, 0.10);
  };
  let fi = 0;
  for (let i = 0; i < n; i++) {
    fi += 2 * Math.PI * f0 / SR;
    let s = 0;
    for (let h = 1; h * f0 < 6000; h++) s += (gain(h * f0) / h) * Math.sin(h * fi);
    const fade = Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
    out[i] = 0.25 * s * fade;
  }
  return out;
}

/* ══ 1. PŘESNOST proti známé pravdě ═════════════════════════════════════ */

console.log('\n═══ 1. Přesnost: trakt se škáluje, pravda je daná ═══');
{
  const F0 = [500, 1500, 2500];
  const vtlPrava = (F) => 34300 / (2 * (((F[1] - F[0]) + (F[2] - F[1])) / 2));
  for (const k of [0.85, 0.9, 1.0, 1.1, 1.15]) {
    const F = F0.map(x => x * k);
    // ⚠️ Skutečný `delkaTraktu` bere TÓNY s formanty, ne audio. Formanty se
    // musí vzít ze stejného místa jako v aplikaci — přes `formantsAt`.
    const { formantsAt } = await import('../src/analysis.js');
    const noty = [];
    for (const f0 of [110, 131, 147, 175, 196, 220, 247, 262]) {
      const s = ton(f0, F);
      const fm = formantsAt(s, SR, 0, s.length);
      noty.push({ f0, f1: fm[0], f2: fm[1], f3: fm[2] });
    }
    const r = delkaTraktu(noty);
    const pravda = vtlPrava(F);
    if (!r) { check(`k=${fmt(k, 2)}: metrika vrátila číslo`, false, 'null'); continue; }
    const chyba = r.vtl_cm - pravda;
    check(`k=${fmt(k, 2)}: chyba do 1,0 cm`, Math.abs(chyba) < 1.0,
      `odhad ${fmt(r.vtl_cm)} cm vs pravda ${fmt(pravda)} cm → chyba ${fmt(chyba)} cm (z ${r.n} tónů)`);
  }
}

/* ══ 2. POJISTKA: nesmysly se vyřadí ═══════════════════════════════════ */

console.log('\n═══ 2. Pojistka: fyzikálně nemožné hodnoty se vyřadí ═══');
{
  // Formanty, kde LPC v praxi chytne harmonické (naměřeno 337–672 Hz rozestup)
  const spatne = [
    { f1: 303, f2: 593, f3: 1042 },   // dF = 369 Hz → bez filtru VTL 46 cm
    { f1: 331, f2: 666, f3: 1321 },   // dF = 495 Hz → 35 cm
    { f1: 347, f2: 692, f3: 1020 },   // dF = 337 Hz → 51 cm
  ];
  for (const s of spatne) {
    const r = delkaTraktu([s]);
    check(`nesmysl (dF ${fmt((s.f2 - s.f1 + s.f3 - s.f2) / 2, 0)} Hz) se NEOHLÁSÍ`,
      r === null, r ? `ohlášeno ${fmt(r.vtl_cm)} cm` : 'správně vyřazeno');
  }
  // A dobré formanty naopak projít MUSÍ
  const dobre = { f1: 537, f2: 1467, f3: 2503 };  // dF 983 Hz → 17,4 cm
  const r = delkaTraktu([dobre]);
  check('správné formanty se naopak použijí', r !== null && r.vtl_cm > 12 && r.vtl_cm < 22,
    r ? `${fmt(r.vtl_cm)} cm` : 'vyřazeno (chyba!)');
}

/* ══ 3. POČET TÓNŮ: vysoko je metrika prázdná a musí to přiznat ═════════ */

console.log('\n═══ 3. Počet tónů: metrika musí přiznat, z kolika počítala ═══');
{
  const { formantsAt } = await import('../src/analysis.js');
  const F = [500, 1500, 2500];
  const nizke = [], vysoke = [];
  for (const f0 of [110, 131, 147, 175, 196]) {
    const s = ton(f0, F);
    const fm = formantsAt(s, SR, 0, s.length);
    nizke.push({ f0, f1: fm[0], f2: fm[1], f3: fm[2] });
  }
  for (const f0 of [270, 294, 330, 349, 392, 440]) {
    const s = ton(f0, F);
    const fm = formantsAt(s, SR, 0, s.length);
    vysoke.push({ f0, f1: fm[0], f2: fm[1], f3: fm[2] });
  }
  const rN = delkaTraktu(nizke), rV = delkaTraktu(vysoke);
  console.log(`    nízké tóny (110–196 Hz): ${rN ? `${rN.n}/${rN.z_tonek} použitelných` : 'null'}`);
  console.log(`    vysoké tóny (270–440 Hz): ${rV ? `${rV.n}/${rV.z_tonek} použitelných` : 'null'}`);
  check('z nízkých tónů se počítá (aspoň 3)', rN !== null && rN.n >= 3,
    rN ? `${rN.n} tónů` : 'null');
  check('vysoké tóny dají MÍŇ použitelných než nízké (naměřeno: metrika tam je prázdná)',
    (rV ? rV.n : 0) < (rN ? rN.n : 0),
    `${rV ? rV.n : 0} vs ${rN ? rN.n : 0}`);
  check('`z_tonek` odpovídá počtu vstupních tónů',
    rN !== null && rN.z_tonek === nizke.length, rN ? `${rN.z_tonek} vs ${nizke.length}` : '');
}

/* ══ 4. Prázdný vstup ═══════════════════════════════════════════════════ */

console.log('\n═══ 4. Prázdný / neúplný vstup nesmí spadnout ═══');
{
  check('bez tónů vrátí null', delkaTraktu([]) === null);
  check('undefined vrátí null', delkaTraktu(undefined) === null);
  check('tón bez formantů (NaN) vrátí null',
    delkaTraktu([{ f1: NaN, f2: NaN, f3: NaN }]) === null);
  check('tón s jediným formantem vrátí null',
    delkaTraktu([{ f1: 500, f2: NaN, f3: NaN }]) === null);
}

console.log(`\n═══ ${pass} prošlo, ${fail} selhalo ═══`);
if (fail) console.log('\nDélka traktu by v aplikaci hlásila nesmysly.');
process.exitCode = fail ? 1 : 0;
