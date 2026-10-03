# Analýza zpěvního hlasu

Webová aplikace pro akustickou analýzu zpěvního hlasu. Nahráš tón nebo frázi a
dostaneš měření, podle kterých se dá posoudit kvalita tónu, barva hlasu a obor —
a hlavně **kde přesně se ztrácí zpěvácký formant (ring)**.

Vše se počítá **lokálně v prohlížeči**. Nahrávky se nikam neposílají, neexistuje
žádný server ani účet. Funguje offline.

## Co to měří

| Metrika | Význam | Reference |
|---|---|---|
| **SPR** | Singing Power Ratio = vrchol 2–4 kHz − vrchol 0–2 kHz. Míra ringu. | nezpěváci −22,7 ± 5,1 dB · profesionálové −13,1 ± 3,8 dB (Omori 1996) |
| **FHE** | Frequency of Half Energy — barva hlasu nezávislá na výšce tónu. | tenor 2705 ± 221 · baryton 2454 ± 206 · bas 2384 ± 164 · soprán 3092 ± 284 Hz (Sci Rep 2022) |
| **F1–F3** | Formanty — tvar vokálního traktu, samohláska. | LPC Burg, decimace na 10 kHz |
| **F1:F0** | Naladění prvního formantu na tón. Hodnotí se **až od G4 výš**. | tolerance 8 % |
| **HNR** | Poměr harmonických k šumu — čistota uzávěru hlasivek. | |
| **Jitter / vibrato** | Stabilita výšky, rychlost a rozsah vibrata. | klasický zpěv ~5–7 Hz |
| **SPL** | Relativní hladina (dBFS). Absolutní dB vyžaduje kalibrovaný mikrofon. | |
| **Spektrogram** | Vizuální otisk — harmonické a pásmo ringu. | |

## Klíčový princip: ring musí být všudypřítomný

Aplikace **neprůměruje přes frázi**. Rozdělí nahrávku na jednotlivé tóny a hodnotí
každý zvlášť, proti vlastnímu mediánu. Hledá **výpadky** a vrací procento tónů, kde
ring drží. Cíl je 100 %.

Průměr totiž schová přesně ten tón, kde se to zlomí.

## Důležitá omezení

- **Absolutní hodnoty jsou srovnatelné jen stejným mikrofonem, vzdáleností a vstupem.**
  Srovnávat s cizí nahrávkou nemá smysl. Smysl má srovnávat sám sebe v čase.
- **Rozdíly pod 2 dB nejsou signál.** S čistým WAV a fixní vzdáleností je rozptyl
  měření ±1,3 dB, s komprimovaným audiem ±2,5 dB, při různé vzdálenosti ±3,5 dB.
- **Nekvalitní pásmo = žádné měření.** Nahrávky se spektrem useknutým pod 4,1 kHz
  (staré snímky, telefonní záznamy, silná komprese) jsou automaticky odmítnuty,
  místo aby vyrobily nesmyslné číslo.
- **F1:F0 se hodnotí až od G4.** Níž je první formant záměrně vysoko (jiná
  strategie, ne vada).
- **Co z mikrofonu měřit nelze:** subglotický tlak, míru dovření hlasivek, polohu
  hrtanu. Žádná metrika nenahradí ucho lektora.

## Instalace a spuštění

Nic se neinstaluje — aplikace nemá žádné závislosti.

```bash
# vývojový server (service worker vyžaduje http, ne file://)
node serve.mjs
# → http://localhost:8123/

# nebo jakýkoli jiný statický server
python3 -m http.server 8123
```

Nasazení: stačí zkopírovat celý adresář na jakýkoli statický hosting
(GitHub Pages, Netlify, Cloudflare Pages…). Není potřeba build krok.

## Živý režim

Tlačítko **Živě** zpracovává zvuk z mikrofonu po blocích a ukazuje průběžně
výšku, ladění, SPR, úroveň a barvu hlasu. Zpětná vazba je do ~50 ms.

Omezení, která se nedají obejít (nejsou to vady aplikace):

- **Prohlížeč utlumí zvuk**, když přepneš na jinou kartu nebo zhasne displej.
  Nativní aplikace na pozadí jede dál, web ne. UI to přizná hláškou.
- **Vyrovnanost ringu živě změřit nelze.** Na to je potřeba segmentovat tóny
  z celé nahrávky a porovnat je mezi sebou. Živý indikátor proto ukazuje jen
  SPR proti literatuře — a neříká z něj „má/nemá ring".
- **iOS Safari** má pro audio vlastní pravidla a je největší zdroj překvapení.

## Výkon

Živý rámec (blok 20 ms, okno 2048 vzorků @48 kHz), měřeno na jednom jádře:

| cesta | medián | p99 | rezerva na 20ms blok |
|---|---|---|---|
| čistý JS | 0,41 ms | 0,53 ms | 49× |
| WASM | **0,13 ms** | 0,16 ms | **154×** |

WASM jádro (`wasm/src/dsp.ts`, 10 kB) se používá pro živý režim. Přínos není
jen rychlost — hlavně **nealokuje za běhu**, takže nekmitá garbage collector
a indikátor neškube. Když se `.wasm` nepodaří načíst, živý režim spadne na JS
a funguje dál, jen pomaleji.

Kompilace: `npm run build:wasm` (potřebuje AssemblyScript; skript si ho doinstaluje).

## Testy

```bash
npm run test:all              # všechno (10 sad)
node test/test-dsp.mjs        # DSP jádro na syntetických signálech
node test/test-pipeline.mjs   # celá pipeline na reálném WAV
node test/test-live-wiring.mjs  # živý režim: ID, importy, cache
node test/test-live-render.mjs  # živý indikátor: skutečné pixely v Chromiu
node test/test-smoke-browser.mjs # načte se celá aplikace včetně WASM?
node test/verify.mjs audio.wav report.json   # srovnání s Python nástrojem
```

`test-dsp.mjs` ověřuje jádro proti **známé pravdě**: F0 se musí trefit na 0,0 centu,
SPR musí rozeznat tón s ringem od tónu bez, LPC musí najít zadané formanty.

### Nástroje pro ověření (tools/)

```bash
node tools/parity.mjs check    # jádro dává stejná čísla jako před optimalizací
node tools/wasm-parity.mjs     # WASM vs JS rámec po rámci
node tools/live-check.mjs      # živé SPR == offline SPR, výška == pitchTrack
node tools/bench.mjs           # kolik rezervy je na živou analýzu
node tools/bench-wasm.mjs      # JS vs WASM na živém rámci
```

`parity.mjs check` je záchranná síť při zásahu do DSP: když se čísla pohnou,
pozná se to dřív, než to uvidí uživatel. `live-check.mjs` ověřuje to podstatné —
že živý indikátor neukazuje jiné číslo, než jaké pak vyjde z analýzy nahrávky.

## Struktura

```
index.html              UI
manifest.webmanifest    PWA
sw.js                   offline cache
icon.svg
src/analysis.js         DSP jádro (FFT, YIN, LPC, SPR, FHE, segmentace)
src/charts.js           vykreslování na canvas
src/app.js              logika aplikace, historie, exporty
src/live.js             živá zpětná vazba — čistá logika (bez DOM)
src/live-charts.js      vykreslování živého indikátoru
src/live-run.js         mikrofon → AudioWorklet → jádro
src/live-ui.js          ovládání živého režimu a propojení s UI
src/dsp-backend.js      WASM jádro + záložní JS cesta
wasm/src/dsp.ts         WASM jádro (AssemblyScript)
wasm/build.sh           překlad jádra
serve.mjs               vývojový server
test/                   testy
tools/                  měření, parita, ověřování
```

## Jak to funguje uvnitř

- **F0** — YIN (de Cheveigné & Kawahara 2002), FFT-akcelerovaný přes vzájemnou
  korelaci. Přesnost na syntetice: **0,0–0,7 centu**.
- **Segmentace tónů** — mediánové vyhlazení f0, sledování stability výšky,
  sloučení oktávových chyb. Nezpěvné vzorky zůstávají nezpěvné (filtr nesmí
  „vymýšlet" znění, jinak slitne pauzy).
- **Formanty** — LPC Burg na signálu **decimovaném na ~10 kHz**. Při 44,1 kHz jsou
  póly tak blízko, že se F1 a F2 slijí do jednoho vrcholu; decimace je nutná.
  Koeficienty: `H(z) = 1/A(z)`, proto se obálka počítá jako `−10·log10|A|²`.
- **Kontrola pásma** — SPR se měří, jen když spektrum sahá aspoň k 4,1 kHz.

## Shoda s referenční implementací

Vývoj probíhal proti nezávislému Python nástroji (Praat engine). Výsledky na
stejném audiu (Caruso, *Amor ti vieta*, 1902):

| | JS (tato appka) | Python (Praat) | rozdíl |
|---|---|---|---|
| SPR medián | −10,84 dB | −12,00 dB | 1,16 dB |
| FHE | 2637,8 Hz | 2638,0 Hz | **0,18 Hz** |
| ring | 100 % | 100 % | 0 % |

## Licence a zdroje

Kód: MIT.

Metriky vycházejí z publikované literatury:
- Omori et al. (1996), *Singing power ratio: quantitative evaluation of singing
  voice quality*, Journal of Voice 10:228–235 — SPR.
- *New objective timbre parameters for classification of voice type and fach in
  professional opera singers*, Scientific Reports 2022 — FHE, n = 1723 vzorků.
- de Cheveigné & Kawahara (2002) — YIN.
- Bozeman, *Practical Vocal Acoustics* — strategie ladění F1 u mužských hlasů.
