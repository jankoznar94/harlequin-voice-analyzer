/**
 * Zápis nahrávky jako zvukový soubor — WAV (PCM 16 bit, mono).
 *
 * PROČ: uživatel nahrává přímo v aplikaci, ale soubor nikdy nedostane — zůstane
 * jen v prohlížeči (a v paměti do zavření stránky). Nemůže si tedy nahrávku
 * poslat, porovnat s jinou, ani ji dát k ruce, když chce poradit s hlasem.
 *
 * PROČ PRÁVĚ WAV a ne původní blob z MediaRecorderu:
 *  1. WAV je formát, o kterém aplikace sama radí („nahraj WAV nebo ve vysokém
 *     datovém toku“) a který **umí přečíst** (`sniffSampleRate`) — u blobu se
 *     kodek liší podle telefonu (webm/opus, webm/pcm, m4a…), takže by se mohlo
 *     stát, že soubor, který aplikace vyrobila, sama nepřečte. To je past,
 *     kterou v tomhle projektu už jednou řešily (viz „formát, který aplikace
 *     VYRÁBÍ, musí umět i PŘEČÍST“).
 *  2. Vzorky se berou z DEKÓDOVANÉHO audia — tedy přesně to, co se analyzovalo
 *     (mono mix). Soubor proto dává stejná čísla jako report.
 *
 * ⚠️ Mono: původní nahrávka může být stereo, ale analýza i přehrávač v aplikaci
 * jedou na mono mixu. Ukládá se tedy mono — jinak by soubor neodpovídal tomu,
 * co je v reportu.
 */

/**
 * @param {ArrayLike<number>} samples vzorky v rozsahu −1…1 (Float32/Float64)
 * @param {number} sampleRate vzorkovací kmitočet v Hz
 * @returns {Uint8Array} obsah souboru .wav
 */
export function encodeWav(samples, sampleRate) {
  const n = samples?.length || 0;
  const rate = Math.round(sampleRate) || 48000;
  const bytes = 44 + n * 2;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);            // délka bloku fmt
  view.setUint16(20, 1, true);             // 1 = PCM (nekomprimované)
  view.setUint16(22, 1, true);             // 1 kanál (mono)
  view.setUint32(24, rate, true);          // vzorků za sekundu
  view.setUint32(28, rate * 2, true);      // bajtů za sekundu (mono × 16 bit)
  view.setUint16(32, 2, true);             // zarovnání bloku
  view.setUint16(34, 16, true);            // bitů na vzorek
  str(36, 'data'); view.setUint32(40, n * 2, true);

  let off = 44;
  for (let i = 0; i < n; i++) {
    let v = samples[i];
    if (!(v === v)) v = 0;                 // NaN (nemělo by nastat) → ticho, ne odpad
    v = v > 1 ? 1 : v < -1 ? -1 : v;
    // 32767 (ne 32768): kladné maximum musí zůstat v rozsahu Int16
    view.setInt16(off, Math.round(v * 32767), true);
    off += 2;
  }
  return new Uint8Array(buf);
}

/** Jméno souboru s časem měření — ať se dvě nahrávky v telefonu nepřebijí. */
export function wavFileName(date = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `nahravka-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}.wav`;
}
