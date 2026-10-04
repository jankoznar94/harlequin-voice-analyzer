#!/usr/bin/env node
/**
 * EXPERIMENT 3: POLOHA HRTANU (délka traktu) z formantů, které aplikace UŽ měří.
 *
 * PROČ tenhle experiment a ne předešlý: `exp-spad-zdroje.mjs` zkusil
 * „spád zdroje s odečtenou obálkou" — a naměřil, že to NEFUNGUJE: metrika
 * vyjde pořád stejně bez ohledu na skutečný zdroj (odečtení obálky z téhož
 * spektra smaže přesně to, co hledáme). Tady se proto testuje druhá věc:
 * dá se z formantů (LPC Burg, které `formantsAt` počítá pro každý tón)
 * odečíst DÉLKA VOKÁLNÍHO TRAKTU — tedy poloha hrtanu?
 *
 * Dvě otázky, bez kterých to nemá cenu:
 *   1. TREfí PRAVDU? (trakt škáluji, takže pravda je daná z definice)
 *   2. PŘEžIJE SAMOHLÁSKU? (falešný poplach: stejný trakt, jiný vokál —
 *      když se odhad hne, měřidlo měří vokál, ne hrtan)
 *
 * Používá SE SKUTEČNÝ `formantsAt` z `src/analysis.js` — testovat odhad
 * vlastním opisem by jen opakovalo chybu, kterou hledám.
 *
 * Použití: node tools/exp-hrtan-formanty.mjs
 */
import { formantsAt } from '../src/analysis.js';

const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const fmt = (v, d = 2) => (v === v && v !== null && v !== undefined ? v.toFixed(d) : '—');
const SR = 48000;

function traktGain(f, F = [500, 1500, 2500], sirky = [120, 180, 220]) {
  const res = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
  return res(F[0], sirky[0], 1.0) + res(F[1], sirky[1], 0.45)
       + res(F[2], sirky[2], 0.30) + res(3000, 250, 0.22) + res(3500, 300, 0.10);
}

/** Držený tón: zdroj 1/h^p pod rezonanční obálkou traktu. Fáze se integruje. */
function ton(f0, sekund = 1.6, { zdrojSpad = 1.0, F = [500, 1500, 2500] } = {}) {
  const n = Math.round(sekund * SR);
  const out = new Float64Array(n);
  let fi = 0;
  for (let i = 0; i < n; i++) {
    fi += 2 * Math.PI * f0 / SR;
    let s = 0;
    for (let h = 1; h * f0 < 6000; h++) s += (traktGain(h * f0, F) / h ** zdrojSpad) * Math.sin(h * fi);
    const fade = Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
    out[i] = 0.25 * s * fade;
  }
  return out;
}

/** Formanty ze SKUTEČNÉHO `formantsAt` (LPC Burg, decimace na 10 kHz). */
function formanty(samples) {
  const f = formantsAt(samples, SR, 0, samples.length);
  return [f[0], f[1], f[2]];
}

/* ── odhad délky traktu ─────────────────────────────────────────────────── */

/** dF = průměrný rozestup formantů; VTL = c/(2·dF). */
const dF = (F) => {
  const v = F.filter(x => x === x && x > 0);
  if (v.length < 2) return NaN;
  const r = [];
  for (let i = 1; i < v.length; i++) r.push(v[i] - v[i - 1]);
  return mean(r);
};
const vtl = (F) => 34300 / (2 * dF(F));

/* ══ 1. TREFE PRAVDU? ═══════════════════════════════════════════════════ */

console.log('\n══ 1. DÉLKA TRAKTU vs PRAVDA (škáluji všechny formanty) ══');
console.log('   (VTL = 34300 / (2·dF); základ traktu F=[500,1500,2500] → 17,15 cm)');
console.log('   k     f0   formanty (LPC)          dF     VTL odhad  VTL pravda  chyba');
{
  const F0 = [500, 1500, 2500];
  for (const k of [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15]) {
    const F = F0.map(x => x * k);
    const pravda = vtl(F);
    const chyby = [];
    for (const f0 of [131, 175, 220, 262]) {
      const zm = formanty(ton(f0, 1.6, { F }));
      const v = vtl(zm);
      chyby.push(v - pravda);
      console.log(`   ${fmt(k, 2)}  ${String(f0).padStart(3)}   ${zm.map(x => (x === x ? Math.round(x) : '—')).join('/').padEnd(22)} ` +
        `${String(fmt(dF(zm), 0)).padStart(5)}  ${String(fmt(v)).padStart(9)}  ${String(fmt(pravda)).padStart(10)}  ${String(fmt(v - pravda)).padStart(5)}`);
    }
    console.log(`          → chyba odhadu: medián ${fmt(chyby.sort((a, b) => a - b)[chyby.length >> 1])} cm, rozptyl ${fmt(Math.max(...chyby) - Math.min(...chyby))} cm`);
  }
}

/* ══ 2. PŘEŽIJE SAMOHLÁSKU? (falešný poplach) ══════════════════════════ */

console.log('\n══ 2. FALEŠNÝ POPLACH — stejný trakt, jen jiná samohláska ══');
console.log('   (pravda pro VŠECHNY je stejná: trakt se nemění)');
{
  const sam = {
    'á': [500, 1500, 2500], 'é': [400, 2000, 2600], 'í': [300, 2300, 3000],
    'ó': [450, 900, 2400], 'ú': [350, 800, 2300], 'ə': [500, 1500, 2500],
  };
  console.log('   f0    ' + Object.keys(sam).map(n => n.padStart(7)).join('') + '   rozptyl   rozptyl_skut/ne');
  for (const f0 of [131, 175, 220, 262]) {
    const odhady = [];
    const radky = [];
    for (const [n, F] of Object.entries(sam)) {
      const v = vtl(formanty(ton(f0, 1.6, { F })));
      odhady.push(v);
      radky.push(v);
    }
    const rozp = Math.max(...odhady) - Math.min(...odhady);
    const pravaRozp = vtl(sam['í']) - vtl(sam['ú']);
    console.log(`   ${String(f0).padStart(3)}   ${radky.map(v => fmt(v, 1).padStart(7)).join('')}` +
      `   ${String(fmt(rozp, 2)).padStart(6)}    ${fmt(rozp - pravaRozp, 2)}`);
  }
  console.log('   (poslední sloupec = o kolik VÍC se odhad hne, než odpovídá skutečné');
  console.log('    změně traktu mezi vokály; velké číslo = měřidlo čte vokál, ne hrtan)');
}

/* ══ 3. ODOLNOST: f0 a rozsah tónů ═════════════════════════════════════ */

console.log('\n══ 3. CITLIVOST NA VÝŠKU TÓNU (trakt se nemění, pravda 17,15 cm) ══');
{
  const F = [500, 1500, 2500];
  const odhady = [];
  for (const f0 of [110, 131, 147, 175, 196, 220, 247, 262, 294, 330, 349, 392]) {
    const zm = formanty(ton(f0, 1.6, { F }));
    const v = vtl(zm);
    odhady.push(v);
    console.log(`   f0 ${String(f0).padStart(3)} Hz   formanty ${zm.map(x => (x === x ? Math.round(x) : '—')).join('/').padEnd(22)} VTL ${fmt(v)} cm`);
  }
  const ok = odhady.filter(x => x === x);
  console.log(`   → rozptyl přes všechny tóny: ${fmt(Math.max(...ok) - Math.min(...ok))} cm (pravda se nemění!)`);
}

/* ══ 4. POJISTKA: fyzikálně nemožné hodnoty se dají vyřadit ══════════════ */

console.log('\n══ 4. POJISTKA — fyziologicky možný rozsah VTL ══');
console.log('   Lidský trakt je 13–20 cm, tedy dF 858–1319 Hz. Když LPC chytí');
console.log('   harmonické místo formantů, vyjde dF mimo rozsah (naměřeno 369–672 Hz).');
{
  const F0 = [500, 1500, 2500];
  const VTL_MIN = 12, VTL_MAX = 22;
  const dFmin = 34300 / (2 * VTL_MAX), dFmax = 34300 / (2 * VTL_MIN);
  console.log(`   (VTL ${VTL_MIN}-${VTL_MAX} cm -> dF ${fmt(dFmin, 0)}-${fmt(dFmax, 0)} Hz)`);
  for (const f0 of [110, 131, 147, 175, 196, 220, 247, 262, 294, 330, 349, 392]) {
    const zm = formanty(ton(f0, 1.6, { F: F0 }));
    const d = dF(zm);
    const v = 34300 / (2 * d);
    const ok = d >= dFmin && d <= dFmax;
    console.log(`   f0 ${String(f0).padStart(3)}  formanty ${zm.map(x => (x === x ? Math.round(x) : '—')).join('/').padEnd(22)} dF ${String(fmt(d, 0)).padStart(5)}  VTL ${String(fmt(v)).padStart(6)} cm  ${ok ? 'POUZITO' : 'vyrazeno (mimo fyziologii)'}`);
  }
  console.log('\n   Median pres POUZITELNE tony vs pravda (trakt se v cele sade nemeni):');
  for (const k of [0.85, 0.9, 1.0, 1.1, 1.15]) {
    const F = F0.map(x => x * k);
    const pouz = [];
    for (const f0 of [110, 131, 147, 175, 196, 220, 247, 262, 294, 330, 349, 392]) {
      const d = dF(formanty(ton(f0, 1.6, { F })));
      const v = 34300 / (2 * d);
      if (d >= dFmin && d <= dFmax) pouz.push(v);
    }
    const med = pouz.slice().sort((a, b) => a - b)[pouz.length >> 1];
    console.log(`   k=${fmt(k, 2)}  pouzitelnych ${String(pouz.length).padStart(2)}/12  median VTL ${String(fmt(med)).padStart(6)} cm  pravda ${String(fmt(vtl(F))).padStart(6)} cm  chyba ${fmt(med - vtl(F))} cm`);
  }
}

/* ══ 5. KOLIK TÓNŮ VŮBEC PŘEŽIJE + co je vyřazuje ════════════════════════ */

console.log('\n══ 5. KOLIK TONU PREZIJE A PROC (realny dopad na metriku) ══');
{
  const F0 = [500, 1500, 2500];
  const dFmin = 34300 / (2 * 22), dFmax = 34300 / (2 * 12);
  const vsechnyF0 = [];
  for (let f = 110; f <= 520; f += 12) vsechnyF0.push(Math.round(f));
  let pouz = 0, odmitnuto = 0;
  const odmitleF0 = [];
  for (const f0 of vsechnyF0) {
    const d = dF(formanty(ton(f0, 1.4, { F: F0 })));
    if (d >= dFmin && d <= dFmax) pouz++; else { odmitnuto++; odmitleF0.push(f0); }
  }
  console.log(`   pres vsechny tony 110-520 Hz (n=${vsechnyF0.length}): pouzito ${pouz}, odmitnuto ${odmitnuto} (${Math.round(100*odmitnuto/vsechnyF0.length)} %)`);
  // rozdeleni podle polohy
  const nizke = vsechnyF0.filter(f => f < 250), vysoke = vsechnyF0.filter(f => f >= 250);
  const ok = (arr) => arr.filter(f0 => { const d = dF(formanty(ton(f0, 1.4, { F: F0 }))); return d >= dFmin && d <= dFmax; }).length;
  console.log(`   pod 250 Hz: ${ok(nizke)}/${nizke.length} pouzito`);
  console.log(`   250 Hz a vys: ${ok(vysoke)}/${vysoke.length} pouzito`);
  console.log(`   (vysoke tony maji formanty daleko od sebe a LPC chytne harmonickou)`);
}

/* ══ 6. JE 77 % ODMITNUTI ARTEFAKT SYNTEZY? (reálny hlas má šum) ═════════ */

console.log('\n══ 6. VPLYV SUMU — realistickejsi hlas (aspirace mezi harmonickymi) ══');
console.log('   Synteticky ton bez sumu ma jen diskretni harmonicke, mezi nimi nic,');
console.log('   takze LPC nema z ceho obalku poskladat. Realny hlas sumi (aspirace).');
{
  const F0 = [500, 1500, 2500];
  const dFmin = 34300 / (2 * 22), dFmax = 34300 / (2 * 12);
  function tonSeSumem(f0, sekund = 1.4, sumDb = -45) {
    const n = Math.round(sekund * SR);
    const out = new Float64Array(n);
    let fi = 0, rnd = 12345;
    const rand = () => (rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296;
    const amp = 10 ** (sumDb / 20);
    for (let i = 0; i < n; i++) {
      fi += 2 * Math.PI * f0 / SR;
      let s = 0;
      for (let h = 1; h * f0 < 6000; h++) s += (traktGain(h * f0, F0) / h) * Math.sin(h * fi);
      const fade = Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
      out[i] = 0.25 * s * fade + amp * (rand() * 2 - 1) * fade;
    }
    return out;
  }
  for (const [nazev, db] of [['bez sumu', null], ['sum -60 dB', -60], ['sum -45 dB', -45], ['sum -35 dB', -35]]) {
    let pouz = 0, celkem = 0, chyby = [];
    for (let f0 = 110; f0 <= 520; f0 += 12) {
      celkem++;
      const s = db === null ? ton(f0, 1.4, { F: F0 }) : tonSeSumem(f0, 1.4, db);
      const d = dF(formanty(s));
      const v = 34300 / (2 * d);
      if (d >= dFmin && d <= dFmax) { pouz++; chyby.push(v - 17.15); }
    }
    const med = chyby.length ? chyby.slice().sort((a, b) => a - b)[chyby.length >> 1] : NaN;
    console.log(`   ${nazev.padEnd(12)} pouzito ${String(pouz).padStart(2)}/${celkem} (${String(Math.round(100*pouz/celkem)).padStart(2)} %)   median chyby VTL ${fmt(med)} cm`);
  }
}

/* ══ 7. REALNA NAHRAVKA — nejdulezitejsi test ════════════════════════════ */

// Pouziti: WAV=soubor.wav node tools/exp-hrtan-formanty.mjs
{
  const WAV = process.env.WAV;
  if (!WAV) {
    console.log('\n══ 7. REALNA NAHRAVKA — preskoceno (spust s WAV=soubor.wav) ══');
  } else {
    console.log(`\n══ 7. REALNA NAHRAVKA: ${WAV} ══`);
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(WAV);
    // minimalni WAV parser: najdi fmt (kanaly, SR, bity) a data
    let pos = 12, ch = 1, sr = 48000, bits = 16, data = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') { ch = buf.readUInt16LE(pos + 10); sr = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
      else if (id === 'data') { data = buf.subarray(pos + 8, pos + 8 + size); break; }
      pos += 8 + size + (size % 2);
    }
    if (!data) { console.log('   WAV nema data'); }
    else {
      const n = Math.floor(data.length / (ch * (bits / 8)));
      const mono = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < ch; c++) {
          const o = (i * ch + c) * (bits / 8);
          sum += bits === 16 ? data.readInt16LE(o) / 32768 : data.readFloatLE(o);
        }
        mono[i] = sum / ch;
      }
      console.log(`   ${n} vzorku, ${sr} Hz, ${ch} kanalu, ${(n / sr).toFixed(1)} s`);
      // najdi useky, kde je dost energie (drzene tony)
      const okno = Math.round(0.6 * sr);
      const useky = [];
      for (let s = 0; s + okno < n; s += Math.round(0.3 * sr)) {
        let e = 0;
        for (let i = s; i < s + okno; i++) e += mono[i] * mono[i];
        useky.push({ s, rms: Math.sqrt(e / okno) });
      }
      const rmsMax = Math.max(...useky.map(u => u.rms));
      const silne = useky.filter(u => u.rms > 0.3 * rmsMax);
      console.log(`   useku celkem ${useky.length}, dost silnych ${silne.length}`);
      const dFmin = 34300 / (2 * 22), dFmax = 34300 / (2 * 12);
      const odhady = [], formantyVse = [];
      for (const u of silne) {
        const seg = mono.subarray(u.s, u.s + okno);
        const f = formantsAt(seg, sr, 0, seg.length);
        const F = [f[0], f[1], f[2]];
        formantyVse.push(F.map(x => (x === x ? Math.round(x) : null)));
        const d = dF(F);
        const v = 34300 / (2 * d);
        if (d >= dFmin && d <= dFmax) odhady.push(v);
      }
      console.log(`   formanty (prvnich 10 useku): ${formantyVse.slice(0, 10).map(f => f.join('/')).join('  ')}`);
      console.log(`   pouzitelnych useku ${odhady.length}/${silne.length}`);
      if (odhady.length) {
        const s = odhady.slice().sort((a, b) => a - b);
        const med = s[s.length >> 1];
        const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
        console.log(`   VTL median ${fmt(med)} cm   (10.-90. percentil ${fmt(q(0.1))}-${fmt(q(0.9))} cm)`);
        console.log(`   rozptyl pres useky: ${fmt(q(0.9) - q(0.1))} cm`);
        console.log(`   POZOR: jeden clovek ma JEDNU delku traktu — rozptyl je chyba,`);
        console.log(`   pokud mezi useky nemenil hrtan (coz v nahravce nepoznam).`);
      } else {
        console.log('   zadny pouzitelny usek — LPC chytil harmonicke vsude');
      }
    }
  }
}

/* ══ 8. ZKRESLENI PODLE f0 — da se opravit? ═════════════════════════════ */

console.log('\n══ 8. SYSTEMATICKE ZKRESLENI PODLE f0 (trakt porad 17,15 cm) ══');
{
  const F0 = [500, 1500, 2500];
  const dFmin = 34300 / (2 * 22), dFmax = 34300 / (2 * 12);
  const radky = [];
  for (let f0 = 110; f0 <= 400; f0 += 10) {
    const d = dF(formanty(ton(f0, 1.4, { F: F0 })));
    const v = 34300 / (2 * d);
    if (d >= dFmin && d <= dFmax) radky.push({ f0, chyba: v - 17.15 });
  }
  console.log('   f0: chyba VTL (cm)   — jen pouzitelne tony');
  console.log('   ' + radky.map(r => `${r.f0}:${fmt(r.chyba, 2)}`).join('  '));
  if (radky.length) {
    const ch = radky.map(r => r.chyba);
    console.log(`   median chyby ${fmt(ch.slice().sort((a,b)=>a-b)[ch.length>>1])} cm, rozsah ${fmt(Math.min(...ch))} az ${fmt(Math.max(...ch))} cm`);
    // je chyba zavisla na f0? korelace
    const mf = mean(radky.map(r => r.f0)), mc = mean(ch);
    let num = 0, df = 0, dc = 0;
    for (const r of radky) { num += (r.f0 - mf) * (r.chyba - mc); df += (r.f0 - mf) ** 2; dc += (r.chyba - mc) ** 2; }
    console.log(`   korelace chyby s f0: r = ${fmt(num / Math.sqrt(df * dc), 3)}  (0 = nezavisla, |1| = systematicka)`);
  }
}
