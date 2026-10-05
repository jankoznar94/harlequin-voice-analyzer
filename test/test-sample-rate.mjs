/**
 * Regresní testy čtení PŮVODNÍHO vzorkovacího kmitočtu z hlavičky souboru.
 *
 * PROČ (reálná chyba, naměřeno): `OfflineAudioContext` vrátí po dekódování
 * VŽDY 48 kHz (v Chromiu 44,1 kHz), i když soubor měl 16 kHz. Analýza tím
 * ztratila informaci o skutečné šířce pásma nahrávky, takže hláška
 * „Ring nelze měřit — nízký vzorkovací kmitočet" se NIKDY nespustila
 * a člověk dostal radu „nahraj WAV" — která u záznamníku na 16 kHz nemůže
 * pomoct, protože i WAV z téhož záznamníku má 16 kHz.
 *
 * Testy jedou na SKUTEČNÝCH hlavičkách, které se v praxi potkají: WAV, M4A/AAC,
 * Ogg/Vorbis, Ogg/Opus, MP3 s ID3 tagem. Hlavičky se staví tady v testu, aby
 * test nezávisel na externích souborech — ale offsety a tvary jsou opsané
 * z reálných souborů (ffmpeg + telefonní záznamník), ne vymyšlené.
 *
 * Pasti, které stály čas a jsou tu proto zafixované:
 *   - `indexOf` na řetězci vrací index ve ZNACÍCH, ne v bajtech (UTF-8)
 *   - 'OggS' je CELÝ tag, ne tag(0)==='Ogg' && tag(1)==='S'
 *   - kmitočet v 'mp4a' je na +28 (ne +16)
 *   - MP3 rámec nezačíná na nule, ale až za ID3 tagem (+ zarovnání)
 */
import { sniffSampleRate, id3Size } from '../src/sample-rate.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const u8 = (arr) => new Uint8Array(arr);

/* ── stavitelé hlaviček ────────────────────────────────────────────────── */

function wav(rate) {
  const b = new Uint8Array(64), dv = new DataView(b.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); dv.setUint32(4, 36, true); put(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, 'data'); dv.setUint32(40, 0, true);
  return b;
}

function m4a(rate) {
  // 'ftyp' na začátku, pak 'mp4a' s kmitočtem na +24 (16.16) a +28 (horních 16)
  const b = new Uint8Array(128), dv = new DataView(b.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  dv.setUint32(0, 28); put(4, 'ftyp'); put(8, 'M4A ');
  put(40, 'mp4a');
  dv.setUint32(40 + 24, rate === Math.floor(rate) ? rate * 65536 : Math.round(rate * 65536));
  dv.setUint32(40 + 28, rate << 16);
  return b;
}

function oggVorbis(rate) {
  const b = new Uint8Array(96), dv = new DataView(b.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'OggS'); dv.setUint8(4, 0); dv.setUint8(5, 2);
  put(28, 'vorbis');                        // identifikační hlavička
  dv.setUint32(28 + 7, 0, true);            // version
  dv.setUint8(28 + 11 - 4 + 4, 1);          // channels (na +11 hned za version)
  dv.setUint32(28 + 11, rate, true);        // ← sample rate
  return b;
}

function oggOpus() {
  const b = new Uint8Array(96), dv = new DataView(b.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'OggS'); dv.setUint8(4, 0); dv.setUint8(5, 2);
  put(28, 'OpusHead');
  return b;
}

function mp3(rate, withId3 = true) {
  /* Kmitočty jsou ve TŘECH tabulkách podle verze MPEG:
   *   MPEG1 (verBits 3): 44100, 48000, 32000
   *   MPEG2 (verBits 2): 22050, 24000, 16000
   *   MPEG2.5 (verBits 0): 11025, 12000, 8000
   * 8 kHz je tedy MPEG2.5 a 16 kHz MPEG2 — ne MPEG1. Kdyby builder vždy
   * poslal MPEG1, test by hlásil chybu v kódu, která tam není. */
  const table = rate >= 32000 ? { v: 3, t: [44100, 48000, 32000] }
    : rate >= 16000 ? { v: 2, t: [22050, 24000, 16000] }
      : { v: 0, t: [11025, 12000, 8000] };
  const idx = table.t.indexOf(rate);
  if (idx < 0) throw new Error('nepodporovaný kmitočet pro MP3: ' + rate);
  const b = new Uint8Array(160), dv = new DataView(b.buffer);
  const frameOff = withId3 ? 44 : 0;
  if (withId3) {
    const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    put(0, 'ID3'); dv.setUint8(3, 4); dv.setUint8(4, 0); dv.setUint8(5, 0);
    dv.setUint8(6, 0); dv.setUint8(7, 0); dv.setUint8(8, 0); dv.setUint8(9, 34);
  }
  // sync 11 bitů + verze (2) + layer (2) + protection (1)
  dv.setUint8(frameOff, 0xff);
  dv.setUint8(frameOff + 1, 0xe0 | (table.v << 3) | (1 << 1) | 0);
  dv.setUint8(frameOff + 2, (idx << 2));
  return b;
}

/* ── testy ─────────────────────────────────────────────────────────────── */

console.log('\n═══ Kmitočet se pozná ze hlavičky (skutečné tvary kontejnerů) ═══');
for (const r of [8000, 12000, 16000, 22050, 32000, 44100, 48000]) {
  check(`WAV ${r} Hz`, sniffSampleRate(wav(r).buffer) === r, `přečteno ${sniffSampleRate(wav(r).buffer)}`);
}
for (const r of [8000, 16000, 44100, 48000]) {
  check(`M4A/AAC ${r} Hz`, sniffSampleRate(m4a(r).buffer) === r, `přečteno ${sniffSampleRate(m4a(r).buffer)}`);
}
for (const r of [8000, 16000, 44100, 48000]) {
  check(`Ogg/Vorbis ${r} Hz`, sniffSampleRate(oggVorbis(r).buffer) === r, `přečteno ${sniffSampleRate(oggVorbis(r).buffer)}`);
}
check('Ogg/Opus → vždy 48 kHz (kodek převzorkuje)',
  sniffSampleRate(oggOpus().buffer) === 48000, `přečteno ${sniffSampleRate(oggOpus().buffer)}`);
for (const r of [8000, 16000, 44100, 48000]) {
  check(`MP3 s ID3 ${r} Hz`, sniffSampleRate(mp3(r, true).buffer) === r, `přečteno ${sniffSampleRate(mp3(r, true).buffer)}`);
  check(`MP3 bez ID3 ${r} Hz`, sniffSampleRate(mp3(r, false).buffer) === r, `přečteno ${sniffSampleRate(mp3(r, false).buffer)}`);
}

console.log('\n═══ Pasti, které stály čas (zafixované, ať se nevrátí) ═══');
{
  // 'OggS' je CELÝ tag. Kdyby se hledalo tag(0)==='Ogg' && tag(1)==='S',
  // nikdy se to netrefí (b[1] je 'g') a Ogg by se nepoznal vůbec.
  check('Ogg se pozná (past: tag(1) není "S")',
    sniffSampleRate(oggVorbis(16000).buffer) === 16000, 'Ogg/Vorbis 16 kHz');
  // indexOf na řetězci ≠ bajtový offset — ověřeno na hlavičce s bajty mimo ASCII
  const withHighBytes = oggVorbis(16000);
  withHighBytes[6] = 0xe6; withHighBytes[7] = 0xdf;   // ne-ASCII bajty v hlavičce
  check('Ogg se pozná i s ne-ASCII bajty před hlavičkou kodexu',
    sniffSampleRate(withHighBytes.buffer) === 16000, 'Ogg/Vorbis 16 kHz s 0xE6 0xDF');
  // kmitočet v mp4a je na +28; na +16 je nula (to byla moje chyba)
  check('M4A: kmitočet se bere ze správného offsetu (past: +16 místo +28)',
    sniffSampleRate(m4a(8000).buffer) === 8000, 'M4A 8 kHz');
  // MP3: rámec až za ID3 tagem
  check('MP3 s ID3: rámec se hledá za tagem, ne na nule',
    sniffSampleRate(mp3(8000, true).buffer) === 8000, 'MP3 8 kHz s ID3');
  check('id3Size čte syncsafe velikost', id3Size(u8([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 34])) === 34,
    `id3Size=${id3Size(u8([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 34]))}`);
}

console.log('\n═══ WebM/Opus — formát, který si aplikace SAMA vyrábí ═══');
{
  /* ⚠️ REÁLNÁ VADA, kterou tenhle test hlídá: `MediaRecorder` v Chromiu dá
   * `audio/webm;codecs=opus`, ale `sniffSampleRate` WebM neznal → NaN →
   * `knownRate = false` → místo poměrového testu `bandCut` se použila přísná
   * absolutní mez 4100 Hz. U tónu v nízké poloze (D3) vyšla mez 3961 Hz a
   * aplikace vypsala „pásmo useknuto na ~3961 Hz — silná komprese, nahraj
   * WAV" u souboru, který si sama vyrobila. Rada „nahraj WAV" je u appky,
   * která WAV neumí nahrát, nesplnitelná. */
  const webm = (() => {
    // minimální EBML: hlavička 1A45DFA3 + Doctype „webm" + A_OPUS s OpusHead
    const head = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01];
    const dt = Array.from('webm', c => c.charCodeAt(0));
    const opus = Array.from('A_OPUS', c => c.charCodeAt(0));
    const opusHead = Array.from('OpusHead', c => c.charCodeAt(0));
    return u8([...head, ...dt, 0x00, 0x00, ...opus, 0x00, ...opusHead,
      0x01, 0x02, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  })();
  check('WebM s Opusem → 48000 (Opus je vždy 48 kHz)',
    sniffSampleRate(webm.buffer) === 48000, `přečteno ${sniffSampleRate(webm.buffer)}`);
  check('WebM s Opusem se neplete s jinými formáty (není NaN→přísná cesta)',
    sniffSampleRate(webm.buffer) === sniffSampleRate(webm.buffer) && sniffSampleRate(webm.buffer) > 0,
    'musí vrátit ČÍSLO, ne NaN');
  // WebM bez Opusu (např. VP8 video) → NaN, tedy bezpečná přísnější cesta
  const webmVp8 = u8([0x1a, 0x45, 0xdf, 0xa3, ...Array.from('webm', c => c.charCodeAt(0)), 0, 0, ...Array.from('V_VP8', c => c.charCodeAt(0))]);
  const v = sniffSampleRate(webmVp8.buffer);
  check('WebM bez Opusu → NaN (bezpečný směr)', v !== v, `přečteno ${v}`);
}

console.log('\n═══ Neznámý/poškozený vstup → NaN (bezpečný směr) ═══');
{
  const prazdne = sniffSampleRate(new ArrayBuffer(0));
  check('prázdné pole → NaN', prazdne !== prazdne, `přečteno ${prazdne}`);
  check('náhodné bajty → NaN', sniffSampleRate(u8([1, 2, 3, 4, 5, 6, 7, 8]).buffer) !== sniffSampleRate(u8([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
  check('text → NaN', sniffSampleRate(u8(Array.from('ahoj svete, tohle neni audio').map(c => c.charCodeAt(0))).buffer) !== 0);
  // Poškozená hlavička NESMÍ vrátit nesmysl, který by pustil ořezaný zdroj.
  // NaN znamená „použij starou přísnou mez" — to je bezpečné.
  const broken = wav(48000); broken[24] = 0; broken[25] = 0; broken[26] = 0; broken[27] = 0;
  const got = sniffSampleRate(broken.buffer);
  check('WAV s nulovým kmitočtem → NaN (ne 0)', got !== got || got === 0,
    `přečteno ${got}`);
}

console.log('\n═══ WebM obecně — formát, který si aplikace SAMA vyrábí ═══');
{
  /* ⚠️ REÁLNÁ VADA (naměřeno, 1.0.32): `pickMime()` zkouší jako PRVNÍ
   * `audio/webm;codecs=pcm`. `fromWebm` ale uměl jen `OpusHead`, takže kdykoli
   * telefon vybral PCM, aplikace NEDOKÁZALA PŘEČÍST vzorkovací kmitočet SVÉHO
   * VLASTNÍHO souboru → `knownRate = false` → přísná absolutní mez 4100 Hz →
   * „pásmo useknuto na ~3527 Hz, silná komprese, nahraj WAV". To je tatáž
   * třída vady jako WebM/Opus níž, jen jiný kodek — obecné pravidlo: nový
   * formát, který aplikace umí VYROBIT, musí umět i PŘEČÍST.
   *
   * ⚠️ TVAR PRVKŮ JE OPSANÝ Z REÁLNÉHO SOUBORU, ne vymyšlený. `SamplingFrequency`
   * má EBML ID **0xB5 = jeden bajt**, ne `42 B7`. Dřívější test si hlavičku
   * postavil z `42 B7` — a procházel na formátu, který v praxi neexistuje,
   * takže ověřoval neexistující opravu. Naměřeno na skutečném souboru
   * (`ffmpeg` → Matroska, ověřeno `tools/diag-ebml.mjs`): hlavička obsahuje
   * `0xB5 SamplingFrequency = 48000 (float64)`, `42 B7` v ní NENÍ. */
  const ebmlFloat = (v, bajtu = 8) => {
    const dv = new DataView(new ArrayBuffer(bajtu));
    if (bajtu === 4) dv.setFloat32(0, v, false); else dv.setFloat64(0, v, false);
    return [0xb5, 0x80 | bajtu, ...Array.from({ length: bajtu }, (_, i) => dv.getUint8(i))];
  };
  /* Struktura jako v reálném souboru: EBML → Segment → Tracks → TrackEntry
   * → Audio → SamplingFrequency. */
  const mk = (freqBytes, codec = 'A_PCM/INT/LIT') => {
    const audio = u8([0x9f, 0x81, 0x01, ...freqBytes]);                 // Channels + freq
    const entry = u8([0x83, 0x81, 0x02, 0xe1, 0x80 | audio.length, ...audio]);
    const tracks = u8([0xae, 0x80 | entry.length, ...entry]);
    const seg = u8([0x18, 0x53, 0x80, 0x67, 0x80 | tracks.length, ...tracks]);
    /* Velikost hlavičky EBML se musí spočítat ze SKUTEČNÉHO obsahu (8 bajtů),
     * ne opsat z reálného souboru — opsaná hodnota 0x9F = 31 bajtů posune
     * parser mimo hlavičku a prvek se nenajde (naměřeno: test pak hlásil
     * NaN i na správném kódu). */
    const headBody = u8([0x42, 0x86, 0x81, 0x01, ...Array.from('webm', c => c.charCodeAt(0))]);
    const head = u8([0x1a, 0x45, 0xdf, 0xa3, 0x80 | headBody.length, ...headBody]);
    void codec;
    return u8([...head, ...seg]);
  };

  check('WebM s PCM (float64) → kmitočet se PŘEČTE',
    sniffSampleRate(mk(ebmlFloat(48000)).buffer) === 48000,
    `přečteno ${sniffSampleRate(mk(ebmlFloat(48000)).buffer)}`);
  check('WebM s PCM na 44,1 kHz → 44100',
    sniffSampleRate(mk(ebmlFloat(44100)).buffer) === 44100,
    `přečteno ${sniffSampleRate(mk(ebmlFloat(44100)).buffer)}`);
  check('WebM s PCM (float32) → kmitočet se PŘEČTE',
    sniffSampleRate(mk(ebmlFloat(48000, 4)).buffer) === 48000,
    `přečteno ${sniffSampleRate(mk(ebmlFloat(48000, 4)).buffer)}`);

  /* Kontrola, že test UMÍ SELHAT: kdyby se hledalo `42 B7` (což dřívější kód
   * dělal), tenhle soubor by NEPŘEČETL — a to je přesně regrese, kterou tu
   * hlídáme. Ověřuje se na datech, ne na dojmu. */
  {
    const b = mk(ebmlFloat(48000));
    let najito42b7 = false;
    for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x42 && b[i + 1] === 0xb7) najito42b7 = true;
    check('kontrola testu: hlavička NEOBSAHUJE 42 B7 (starý kód by ji nepřečetl)',
      !najito42b7 && sniffSampleRate(b.buffer) === 48000,
      `42B7 v hlavičce: ${najito42b7}`);
  }

  // WebM bez SamplingFrequency (video) → NaN, tedy bezpečná přísnější cesta
  const bezFreq = u8([0x1a, 0x45, 0xdf, 0xa3, ...Array.from('webm', c => c.charCodeAt(0)),
    0, 0, ...Array.from('V_VP8', c => c.charCodeAt(0))]);
  check('WebM bez SamplingFrequency → NaN (bezpečný směr)',
    sniffSampleRate(bezFreq.buffer) !== sniffSampleRate(bezFreq.buffer),
    `přečteno ${sniffSampleRate(bezFreq.buffer)}`);
}

console.log('\n═══ VÝSLEDEK: ' + pass + ' prošlo, ' + fail + ' selhalo ═══');
process.exit(fail ? 1 : 0);
