/**
 * PŮVODNÍ vzorkovací kmitočet ze hlavičky souboru.
 *
 * PROČ TENHLE MODUL EXISTUJE (reálná chyba, naměřeno):
 * `decodeAudio` dekóduje přes `OfflineAudioContext` a ta po dekódování vrátí
 * VŽDY 48000 (v Chromiu 44100), bez ohledu na to, jaký kmitočet soubor měl.
 * Analýza tedy dostala 48 kHz i u souboru, který měl 16 kHz, a nemohla poznat,
 * že pásmo 2–4 kHz je useknuté SAMOTNÝM kmitočtem nahrávky. Hláška „Ring
 * nelze měřit — nízký vzorkovací kmitočet" se tím NIKDY nespustila: její
 * podmínka `band.limit > 0,75·(sr/2)` s `sr = 48000` nemůže vyjít. Propadlo
 * se vždy na poslední větev s radou „nahraj WAV" — což je rada, která
 * u 16kHz záznamníku nemůže pomoct, protože i WAV z téhož záznamníku má
 * 16 kHz. Přesně ta chyba, kterou jsme už jednou opravovali u hlášky o WAV:
 * tvrdit příčinu, kterou kód nezná.
 *
 * Je to SAMOSTATNÝ modul (ne funkce v app.js), aby se dal testovat přímo,
 * bez mocku prohlížeče — je to čistá práce s bajty a nic víc.
 *
 * Vrací kmitočet v Hz, nebo NaN, když hlavičku nepozná. NaN je bezpečná
 * odpověď: volající pak použije starou přísnější cestu, která ořezaný zdroj
 * nikdy nepustí.
 */

const TAGS = {
  'RIFF': 'wav',
  'OggS': 'ogg',
};

/** Přečte kmitočet z RIFF/WAVE (fmt chunk). */
function fromWav(b, dv) {
  let off = 12;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    const sz = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      const rate = dv.getUint32(off + 8 + 4, true);
      if (rate > 0 && rate < 1e7) return rate;
    }
    if (sz <= 0 || off + 8 + sz > b.length) break;      // ochrana před smyčkou
    off += 8 + sz + (sz & 1);
  }
  return NaN;
}

/**
 * Přečte kmitočet z MP4/M4A (atom 'mp4a' v 'stsd').
 * Kmitočet je 16.16 fixed-point na offsetu +16 od začátku jména 'mp4a';
 * hodnota přes 65535 znamená zlomek (např. 44100 → 0xAC440000).
 */
function fromMp4(b, dv) {
  for (let i = 4; i + 32 < b.length; i++) {
    if (b[i] === 0x6d && b[i + 1] === 0x70 && b[i + 2] === 0x34 && b[i + 3] === 0x61) {
      /* Ověřeno na skutečných souborech (ffmpeg i telefon): 'mp4a' má na +24
       * sample rate jako 16.16 fixed-point a na +28 zrcadlově tentýž údaj
       * v horních 16 bitech. 48000 → 0xBB800000, 8000 → 0x1F400000.
       * `>>> 16` je tedy správná hodnota a je robustní i pro 44100. */
      const v = dv.getUint32(i + 28);
      const rate = v >>> 16;
      if (rate >= 1000 && rate <= 384000) return rate;
    }
  }
  return NaN;
}

/** Přečte kmitočet z Ogg (Vorbis 'vorbis' hlavička, nebo OpusHead). */
function fromOgg(b, dv) {
  /* Hledá se podle BAJTŮ, ne podle převedeného textu: `indexOf` na řetězci
   * vrací index ve ZNACÍCH, což u UTF-8 s vícebajtovými znaky nesedí na
   * bajtový offset v souboru (a v hlavičce Ogg jsou bajty mimo ASCII). */
  const findBytes = (needle) => {
    const n = needle.length;
    outer: for (let i = 0; i + n <= b.length; i++) {
      for (let j = 0; j < n; j++) if (b[i + j] !== needle.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  };
  const opus = findBytes('OpusHead');
  if (opus >= 0) {
    /* Opus JE vždy 48 kHz — kodek pracuje na 48 kHz a při dekódování
     * převzorkuje. Zapsaný „original rate" v OpusHead je jen informativní
     * a prohlížeč ho ignoruje (naměřeno: 16kHz zdroj v .opus se dekódoval
     * na 48 kHz a pásmo měl plné). Tvrdit u něj nižší kmitočet by vyřadilo
     * nahrávku, která je v pořádku. */
    return 48000;
  }
  const vorbis = findBytes('vorbis');
  if (vorbis >= 0) {
    /* Struktura identifikační hlavičky Vorbis (ověřeno na skutečném souboru):
     *   'vorbis'(6) | version u32(4) | channels u8(1) | sample rate u32(4) ...
     * kmitočet je tedy na +6 (za 'vorbis') +4 (version) +1 (channels) = +11. */
    const o = vorbis + 11;
    if (o + 4 <= b.length) {
      const rate = dv.getUint32(o, true);
      if (rate >= 1000 && rate <= 384000) return rate;
    }
  }
  return NaN;
}

/** Přečte kmitočet z ADTS proudu (AAC bez kontejneru). */
function fromAdts(b) {
  if (b.length < 4 || b[0] !== 0xff || (b[1] & 0xf0) !== 0xf0) return NaN;
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = (b[2] >> 2) & 0x0f;
  return rates[idx] ?? NaN;
}

/**
 * Přečte ID3 hlavičku na začátku MP3 (velikost bloku ze syncsafe integeru).
 * Používá se k tomu, aby se ADTS detekce nepletla s jinými formáty.
 */
export function id3Size(b) {
  if (b.length < 10) return 0;
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  return ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
}

/**
 * Přečte kmitočet z MPEG audio rámce (MP3, MP2) — hlavička 0xFFEx.
 * Vrací NaN, když první rámec není na začátku (např. za ID3 tagem).
 */
function fromMpegAudio(b) {
  if (b.length < 4 || b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) return NaN;
  const verBits = (b[1] >> 3) & 0x03;                   // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const rateIdx = (b[2] >> 2) & 0x03;
  const table = verBits === 3
    ? [44100, 48000, 32000]
    : verBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  return table[rateIdx] ?? NaN;
}

/**
 * Hlavní vstup: přečte vzorkovací kmitočet z hlavičky kontejneru.
 *
 * Zkouší se v pořadí podle jednoznačnosti signatur. Když se nic nepozná,
 * vrací NaN — volající se pak chová jako dřív (přísnější mez pásma),
 * což je bezpečný směr: radši nezměřit než pustit ořezaný zdroj.
 */
export function sniffSampleRate(ab) {
  const b = new Uint8Array(ab);
  const dv = new DataView(ab);
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  try {
    if (b.length > 44 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      const r = fromWav(b, dv);
      if (r === r) return r;
    }
    if (b.length > 12 && tag(4) === 'ftyp') {
      const r = fromMp4(b, dv);
      if (r === r) return r;
    }
    if (tag(0) === 'OggS') {
      const r = fromOgg(b, dv);
      if (r === r) return r;
    }
    /* MP3/MP2 s ID3 tagem: rámec nezačíná na nule, ale až za tagem — a mezi
     * koncem ID3 a prvním rámcem bývá ještě zarovnání. Naměřeno na skutečném
     * souboru: hlavička ID3 hlásí 34 bajtů, první rámec 0xFFE3 je na offsetu
     * 44. Proto se po synchronizaci hledá v rozumném okně, ne na pevném místě. */
    const id3 = id3Size(b);
    if (id3 > 0) {
      for (let off = id3; off < Math.min(b.length - 4, id3 + 512); off++) {
        const r = fromMpegAudio(b.subarray(off));
        if (r === r) return r;
      }
      for (let off = id3; off < Math.min(b.length - 4, id3 + 512); off++) {
        const a = fromAdts(b.subarray(off));
        if (a === a) return a;
      }
    }
    const r = fromMpegAudio(b);
    if (r === r) return r;
    const a = fromAdts(b);
    if (a === a) return a;
  } catch { /* nepoznáno — vrátíme NaN */ }
  return NaN;
}
