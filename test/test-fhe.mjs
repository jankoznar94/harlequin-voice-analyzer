#!/usr/bin/env node
/**
 * Test vyhodnocení barvy hlasu (FHE).
 *
 * Hlídá jednu věc, která se dá snadno potichu pokazit a která by uživatele
 * poškodila nejvíc: že se barva hlasu NIKDY nevyhodnotí jako vada.
 *
 * Referenční pásmo je ±1 směrodatná odchylka (tenor ±221 Hz), tedy ÚZKÉ —
 * i hlas, který posluchač označí za úplně normální, do něj často nespadne.
 * Kdyby se „mimo pásmo" hlásilo jako chyba, aplikace by odrazovala lidi
 * s naprosto v pořádku hlasem. Proto: mimo pásmo = `mid`, nikdy `bad`.
 *
 * Použití: node test/test-fhe.mjs
 */
import { vyhodnotFhe, fheLabel, REFS, OBOR_PLURAL } from '../src/analysis.js';

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('\n1. Nikdy nehlásit barvu hlasu jako vadu\n');
{
  // projdi celé pásmo 2–3,6 kHz po 10 Hz pro všechny obory, které mají referenci
  let bad = 0, checked = 0;
  for (const fach of ['tenor', 'baryton', 'bas', 'sopran']) {
    for (let f = 2000; f <= 3600; f += 10) {
      const v = vyhodnotFhe(fach, f);
      checked++;
      if (v.cls === 'bad') { bad++; console.log(`     ${fach} ${f} Hz → cls=bad`); }
    }
  }
  ok(`barva hlasu nikdy není 'bad' (${checked} hodnot)`, bad === 0, `${bad} případů`);
}

console.log('\n2. Směr je správný\n');
{
  const t = REFS.FHE.tenor;                  // [2705, 221] → pásmo 2484–2926
  const vys = vyhodnotFhe('tenor', t[0] + t[1] + 100);
  const niz = vyhodnotFhe('tenor', t[0] - t[1] - 100);
  const stred = vyhodnotFhe('tenor', t[0]);

  ok('vysoká FHE → světlejší', vys.smer === 'svetlejsi', vys.smer);
  ok('nízká FHE → temnější', niz.smer === 'temnejsi', niz.smer);
  ok('střed pásma → v pásmu', stred.smer === 'v_pasmu', stred.smer);
  ok('v pásmu má zelenou', stred.cls === 'ok', stred.cls);
  ok('mimo pásmo má oranžovou (ne červenou)', vys.cls === 'mid' && niz.cls === 'mid',
    `${vys.cls}, ${niz.cls}`);

  ok('slovní značka sedí', fheLabel(vys) === 'Světlejší' && fheLabel(niz) === 'Temnější'
    && fheLabel(stred) === 'V pásmu',
    `${fheLabel(vys)}, ${fheLabel(niz)}, ${fheLabel(stred)}`);
}

console.log('\n3. Hranice pásma jsou přesně ±1 směrodatná odchylka\n');
{
  const t = REFS.FHE.tenor;
  const presne = vyhodnotFhe('tenor', t[0] + t[1]);
  const tesne = vyhodnotFhe('tenor', t[0] + t[1] + 1);
  ok('na hranici ještě v pásmu', presne.smer === 'v_pasmu', presne.smer);
  ok('kousek za hranicí už mimo', tesne.smer === 'svetlejsi', tesne.smer);
}

console.log('\n4. Texty přiznávají, že mimo pásmo to není vada\n');
{
  const niz = vyhodnotFhe('tenor', 2200);
  const vys = vyhodnotFhe('tenor', 3400);
  ok('temnější text říká „NENÍ vada"', /NENÍ vada/.test(niz.text), '');
  ok('světlejší text říká „NENÍ vada"', /NENÍ vada/.test(vys.text), '');
  ok('temnější text zmiňuje nízkou polohu (kde reference neplatí)',
    /nízké poloze/.test(niz.text), '');
  ok('text nikde netvrdí, že je hlas špatný nebo dobrý',
    !/špatn|dobr|vadn/i.test(niz.text.replace('NENÍ vada', '')) &&
    !/špatn|dobr|vadn/i.test(vys.text.replace('NENÍ vada', '')), '');
}

console.log('\n5. Chybějící hodnota a rozsah bez reference\n');
{
  const chybi = vyhodnotFhe('tenor', NaN);
  ok('žádná hodnota → nehodnoceno', !chybi.hodnocene && chybi.cls === 'none', chybi.cls);
  ok('žádná hodnota → text to vysvětlí', /nemám z čeho/i.test(chybi.text), '');

  const vse = vyhodnotFhe('vse', 2705);
  ok('rozsah „bez filtru" → nehodnoceno (nemá referenci)',
    !vse.hodnocene && vse.cls === 'none', vse.cls);
  ok('rozsah „bez filtru" → text přizná, že se nehodnotí', /nehodnotím/i.test(vse.text), '');
  ok('rozsah „bez filtru" → značka je pomlčka', fheLabel(vse) === '—', fheLabel(vse));
}

console.log('\n6. Názvy oborů v textech\n');
{
  const t = vyhodnotFhe('tenor', 2200);
  ok('text zmiňuje „tenory" (množné číslo, ne „tenor")', /tenory/.test(t.text), '');
  ok('všechny obory mají český název v množném čísle',
    ['tenor', 'baryton', 'bas', 'sopran', 'alt'].every(k => typeof OBOR_PLURAL[k] === 'string' && OBOR_PLURAL[k].length > 2),
    Object.values(OBOR_PLURAL).join(', '));
  const b = vyhodnotFhe('bas', 2100);
  ok('text pro bas zmiňuje „basy"', /basy/.test(b.text), '');
}

console.log(`\n═══ BARVA HLASU: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
