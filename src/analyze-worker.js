/**
 * Analýza nahrávky ve Web Workeru.
 *
 * PROČ TO EXISTUJE: `analyze()` je synchronní a na čtyřminutové nahrávce trvá
 * desítky sekund. Když běží v hlavním vlákně, prohlížeč nemůže překreslit
 * progress bar ani posunout spinner — intervaly ani animace se za tu dobu
 * vůbec nespustí, takže se aplikace tváří zaseknutá (přesně to uživatel hlásil).
 * Worker běží ve vlastním vlákně, takže hlavní vlákno zůstane volné a průběh se
 * dá kreslit plynule celou dobu.
 *
 * Posílá se jen mono pole vzorků (transferable, žádná kopie), původní blob
 * (aby se nemusel vytahovat z uzavřeného rozsahu jen kvůli přehrávači) a zpět
 * výsledek — ten je z obyčejných objektů a polí, takže se dá přenést beze změny.
 */
import { analyze } from './analysis.js';

self.onmessage = (e) => {
  const { samples, sampleRate, blob, opts } = e.data || {};
  try {
    const res = analyze(samples, sampleRate, {
      fach: opts.fach,
      fileRate: opts.fileRate,
      onProgress: (p, msg) => self.postMessage({ type: 'progress', p, msg }),
    });
    self.postMessage({ type: 'done', res, blob });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
