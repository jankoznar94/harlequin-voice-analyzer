/**
 * Analýza zpěvního hlasu — hlavní logika aplikace.
 * Nahrávání/načtení → analýza v prohlížeči → výsledky → historie.
 */
import { analyze, REFS, czPlural, vyhodnotFhe, fheLabel } from './analysis.js';
import {
  drawSpr, drawF1, drawSpec, drawTrend, fmt,
  sprGeom, specGeom, f1Geom, f1Notes,
  drawSpecHead, drawSprHead, drawF1Head, clearHead,
  SPR_H, SPEC_H, F1_H, sprNeededWidth,
} from './charts.js';
import { initLive } from './live-ui.js';
import { sniffSampleRate } from './sample-rate.js';

const $ = (id) => document.getElementById(id);
const HIST_KEY = 'vocal-lab.history.v1';
const MAX_HIST = 60;

let current = null;      // { result, samples, sampleRate, label, date, buffer, url }
let recorder = null, recChunks = [], recStream = null, recTimer = null, recStart = 0;
let audioCtx = null, analyser = null, levelRaf = 0, cancelled = false;
let player = null;       // { el, url, raf, loopNote, seeking }

/* ═══════════════════════════════════════ nahrávání */

async function startRecord() {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // vypnout automatické zásahy — kazí spektrum
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    alert('Mikrofon se nepodařilo otevřít: ' + (e.message || e.name) +
      '\n\nZkontroluj povolení v prohlížeči.');
    return;
  }

  // měřič úrovně
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(recStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
    $('rec-level').style.setProperty('--lvl', Math.min(100, peak * 140) + '%');
    levelRaf = requestAnimationFrame(tick);
  };
  tick();

  recChunks = [];
  const mime = pickMime();
  recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => finishRecord();
  recorder.start(250);

  recStart = Date.now();
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);

  $('panel-input').classList.add('hidden');
  $('rec-bar').classList.remove('hidden');
}

function pickMime() {
  const want = ['audio/webm;codecs=pcm', 'audio/wav', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const m of want) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function stopRecord() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function finishRecord() {
  clearInterval(recTimer);
  cancelAnimationFrame(levelRaf);
  if (recStream) recStream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  $('rec-bar').classList.add('hidden');

  const blob = new Blob(recChunks, { type: recorder?.mimeType || 'audio/webm' });
  const secs = Math.round((Date.now() - recStart) / 1000);
  console.log('[i] nahráno', (blob.size / 1024).toFixed(0), 'kB za', secs, 's');

  if (blob.size < 2048) {
    alert('Nahrávka je prázdná — zkus to znovu.');
    $('panel-input').classList.remove('hidden');
    return;
  }
  await handleBlob(blob, 'Nahrávka ' + new Date().toLocaleString('cs-CZ'));
}

/* ═══════════════════════════════════════ dekódování */

/**
 * Dekóduje zvuk na PŮVODNÍM vzorkovacím kmitočtu souboru.
 *
 * PROČ OfflineAudioContext a ne AudioContext (reálná chyba, ověřeno):
 * AudioContext je vázaný na zvukový HARDWARE. Když telefon zrovna běží na
 * nízkém kmitočtu (Bluetooth handsfree profil, úsporný režim, jiná aplikace
 * drží zvuk), dekóduje klidně na 16 nebo 12 kHz. Pásmo 2–4 kHz, ze kterého
 * se měří ring, je pak useknuté a aplikace to vyhlásila jako vadu NAHRÁVKY
 * („Ring nelze měřit — silná komprese, nahraj WAV"), i když byla nahrávka
 * v pořádku. Naměřeno: při 12 kHz vyjde mez pásma ~3747 Hz → hláška
 * „pásmo useknuto"; při 48 kHz totéž audio dá 4406 Hz → měřitelné.
 * OfflineAudioContext na hardware vázaný není a dekódoval vždy 48 kHz.
 */
async function decodeAudio(blob) {
  const ab = await blob.arrayBuffer();
  const fileRate = sniffSampleRate(ab);          // PŮVODNÍ kmitočet souboru, ne dekódovaný
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (OAC) {
    try {
      const off = new OAC(1, 1, 48000);
      return { audio: await off.decodeAudioData(ab.slice(0)), fileRate };
    } catch (e) {
      console.warn('[i] OfflineAudioContext nedekódoval, zkouším AudioContext', e);
    }
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return { audio: await ctx.decodeAudioData(ab.slice(0)), fileRate };
  } finally {
    try { await ctx.close(); } catch {}
  }
}

async function handleBlob(blob, label) {
  showProgress(0.02, 'Dekóduji zvuk…');
  try {
    const { audio, fileRate } = await decodeAudio(blob);
    const mono = toMono(audio);
    runAnalysis(mono, audio.sampleRate, label, blob, fileRate);
  } catch (e) {
    console.error(e);
    // fallback: MediaRecorder často vyrobí webm/opus, který decodeAudioData
    // v některých prohlížečích nepřečte — zkus přes <audio> element
    try {
      const mono = await decodeViaElement(blob);
      if (mono) return runAnalysis(mono.samples, mono.sampleRate, label, blob, NaN);
    } catch (e2) { console.error(e2); }
    alert('Zvuk se nepodařilo přečíst. Zkus nahrát ve formátu WAV, nebo použij ' +
      '"Načíst soubor".');
    hideProgress();
    $('panel-input').classList.remove('hidden');
  }
}

function toMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const n = audioBuffer.length;
  const out = new Float64Array(n);
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

async function decodeViaElement(blob) {
  const url = URL.createObjectURL(blob);
  const el = new Audio();
  el.src = url;
  await new Promise((res, rej) => {
    el.onloadedmetadata = res; el.onerror = () => rej(new Error('nelze přečíst'));
    setTimeout(() => rej(new Error('timeout')), 8000);
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const ab = await (await fetch(url)).arrayBuffer();
  const audio = await ctx.decodeAudioData(ab);
  await ctx.close();
  URL.revokeObjectURL(url);
  return { samples: toMono(audio), sampleRate: audio.sampleRate };
}

/* ═══════════════════════════════════════ analýza */

function runAnalysis(samples, sampleRate, label, blob, fileRate = NaN) {
  cancelled = false;
  /* Přehrávač potřebuje PŮVODNÍ blob — a to i tehdy, když analýzu spočítá
   * Worker (blob se proto posílá tam a vrací se zpět s výsledkem). Kdyby se
   * cesta zkazila, `validBlob` je null a přehrávač se prostě nezapne; dřív tu
   * stálo `buffer: blob` s nedefinovaným `blob` a skript spadl na ReferenceError
   * až PO analýze, takže UI zůstalo viset na „Hotovo" bez výsledku. */
  const validBlob = (blob && typeof blob.slice === 'function' && blob.size > 0) ? blob : null;
  const fach = $('fach').value;
  showProgress(0.05, 'Spouštím analýzu…', 0);

  const t0 = performance.now();
  const showResultSafe = (res, secs) => {
    try { showResult(res, samples, sampleRate, label, secs); }
    catch (e) { console.error('vykreslení výsledku selhalo', e); }
  };

  const done = (res, wBlob = null) => {
    if (cancelled) return;
    const secs = (performance.now() - t0) / 1000;
    console.log(`[i] analýza ${samples.length / sampleRate | 0} s audia za ${secs.toFixed(1)} s`);
    // Přehrávač potřebuje PŮVODNÍ blob (zvuk musí být přesně to, co se
    // analyzovalo). Když se blob nepodařilo poslat workerem, radši přehrávač
    // vůbec nezapínáme — dřív by tu spadlo `blob is not defined`.
    const buf = (wBlob && typeof wBlob.slice === 'function' && wBlob.size > 0)
      ? wBlob : validBlob;
    current = {
      result: res, samples,
      sampleRate, label, date: new Date().toISOString(),
      buffer: buf,
      url: buf ? URL.createObjectURL(buf) : null,
    };
    showResultSafe(res, secs);
  };
  const failed = (msg) => {
    alert('Analýza selhala: ' + msg);
    hideProgress();
    $('panel-input').classList.remove('hidden');
  };

  /* Analýza běží ve WORKERU.
   *
   * PROČ: je synchronní a na čtyřminutové nahrávce trvá desítky sekund. V hlavním
   * vlákně se za tu dobu nespustí ani intervaly, ani animace — progress bar
   * zůstane stát a aplikace se tváří zaseknutá. (Dřív tu bylo `setTimeout(…, 40)`
   * s domněnkou, že to stačí na vykreslení lišty; na 40 ms se lišta sice
   * vykreslila, ale pak už se nic nehýbalo — a hlavně se během analýzy nedalo
   * vůbec nic dělat, ani stisknout „Zrušit".)
   *
   * Worker dostane vzorky přes transfer (žádná kopie) a posílá zpět průběh.
   * Když worker nejde spustit (starý prohlížeč, `file://`), spadne se na
   * původní běh v hlavním vlákně — analýza musí proběhnout vždy. */
  let worker = null;
  try {
    worker = new Worker(new URL('./analyze-worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    console.warn('[i] Worker nejde spustit, analyzuji v hlavním vlákně', e);
  }

  if (!worker) {
    setTimeout(() => {
      if (cancelled) return;
      try {
        done(analyze(samples, sampleRate, {
          fach, fileRate,
          onProgress: (p, msg) => { if (!cancelled) showProgress(p, msg); },
        }));
      } catch (e) {
        console.error(e);
        failed(e.message);
      }
    }, 40);
    return;
  }

  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (cancelled) { worker.terminate(); worker = null; return; }
    if (m.type === 'progress') { showProgress(m.p, m.msg); return; }
    worker.terminate();
    worker = null;
    if (m.type === 'error') { failed(m.message); return; }
    done(m.res, m.blob || validBlob);
  };
  worker.onerror = (ev) => {
    console.warn('[i] Worker selhal, analyzuji v hlavním vlákně', ev.message);
    if (worker) { worker.terminate(); worker = null; }
    if (cancelled) return;
    try {
      done(analyze(samples, sampleRate, {
        fach, fileRate,
        onProgress: (p, msg) => { if (!cancelled) showProgress(p, msg); },
      }));
    } catch (e) { failed(e.message); }
  };

  const copy = Float64Array.from(samples);          // vzorky jdou do workeru
  worker.postMessage({
    samples: copy, sampleRate, blob,
    opts: { fach, fileRate },
  }, [copy.buffer]);
}

/* ═══════════════════════════════════════ UI: průběh */

/**
 * Průběh analýzy.
 *
 * Dvě věci, které se nesmí pokazit:
 *  1. **Pruh se nikdy nesmí zastavit.** Analýza hlásí fáze, ale mezi fázemi
 *     (`Měřím tóny…`) se hlásí jen každý desátý tón — na pomalém telefonu je to
 *     klidně několik sekund a pruh stojí. Proto má pruh i „měkkou" složku, která
 *     po dobu fáze pomalu roste k jejímu konci. Uživatel tak vždycky vidí, že se
 *     něco děje.
 *  2. **Musí být vidět, jak dlouho to běží a jak dlouho to ještě potrvá.** Bez
 *     času nemá člověk jak poznat rozdíl mezi „počítá" a „zatuhlo".
 */
let progAnim = null;
let progStart = 0;
let progFrac = 0;        // tvrdá hodnota z analýzy
let progSoft = 0;        // měkká (dorůstající) hodnota, ze které se kreslí
let progCeil = 0.05;     // kam smí měkká hodnota dorůst

function fmtDur(s) {
  if (!(s >= 0)) return '—';
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return `${m}:${String(x).padStart(2, '0')}`;
}

function showProgress(p, msg, elapsedS = null) {
  $('panel-input').classList.add('hidden');
  $('panel-result').classList.add('hidden');
  $('panel-progress').classList.remove('hidden');

  const first = progAnim === null;
  if (first) { progStart = performance.now(); progSoft = 0; progCeil = 0.05; }
  if (typeof p === 'number' && p >= progFrac) {
    progFrac = p;
    // strop pro měkkou hodnotu: kousek před dalším hlášením
    progCeil = Math.min(0.995, p + Math.max(0.02, (1 - p) * 0.25));
  }
  $('prog-text').textContent = msg;
  const el = elapsedS === null ? (performance.now() - progStart) / 1000 : elapsedS;
  $('prog-elapsed').textContent = 'Uběhlo ' + fmtDur(el);
  $('prog-eta').textContent = '';

  if (first) startProgAnim();
}

/**
 * Měkce dorůstající pruh + odhad zbývajícího času.
 * Běží, dokud je panel průběhu viditelný — zastaví se sám, aby nic nežral
 * na pozadí.
 */
function startProgAnim() {
  cancelAnimationFrame(progAnim);
  const step = () => {
    if ($('panel-progress').classList.contains('hidden')) { progAnim = null; return; }
    const el = (performance.now() - progStart) / 1000;
    // k tvrdé hodnotě se blíží pomalu, aby pruh nikdy nestál
    progSoft += Math.max(0, progCeil - progSoft) * 0.02;
    const shown = Math.max(progFrac, Math.min(progSoft, progCeil));
    $('prog-fill').style.width = (shown * 100).toFixed(1) + '%';
    $('prog-elapsed').textContent = 'Uběhlo ' + fmtDur(el);
    /* Odhad zbývajícího času se ukáže až po pár sekundách a jen dokud neběží
     * poslední fáze — z odhadu z prvních dvou procent by vyšel nesmysl
     * (typicky „zbývá 40 minut") a v poslední fázi už je zbytečný. */
    if (el > 3 && shown > 0.10 && progFrac < 0.9) {
      const eta = el / shown - el;
      $('prog-eta').textContent = ' · zbývá asi ' + fmtDur(eta);
    } else {
      $('prog-eta').textContent = '';
    }
    progAnim = requestAnimationFrame(step);
  };
  progAnim = requestAnimationFrame(step);
}

function hideProgress() {
  cancelAnimationFrame(progAnim);
  progAnim = null;
  progFrac = 0; progSoft = 0;
  $('panel-progress').classList.add('hidden');
}

/* ═══════════════════════════════════════ UI: výsledek */

function showResult(res, samples, sampleRate, label, secs, blob) {
  hideProgress();
  // Graf ladění i spektrogram si při novém měření potřebují přepočítat plátno
  // (předchozí nahrávka mohla být delší) — viz layoutAll.
  lastChartLayout = '';
  lastPane = '';
  $('panel-result').classList.remove('hidden');
  $('r-title').textContent = label;
  const dur = res.duration_s;
  $('r-meta').textContent =
    `${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')} · ` +
    `${res.notes.length} tónů · obor ${res.fach} · ` +
    `${res.n_dropped} vyřazeno · výpočet ${secs.toFixed(1)} s`;

  const s = res.summary;

  if (s.spr_unusable) {
    $('r-unusable').classList.remove('hidden');
    $('r-unusable').innerHTML = unusableText(res);
    $('r-body').classList.add('hidden');
    return;
  }
  $('r-unusable').classList.add('hidden');
  $('r-body').classList.remove('hidden');

  /* ── ukazatel 1: vyrovnanost ringu ─────────────────────────────────── */
  const ringPct = s.ring_consistency_pct;
  setKpi('k-ring', ringPct.toFixed(0) + ' %',
    `${s.notes_with_ring} z ${s.n_notes} ${czPlural(s.n_notes, 'tónu', 'tónů', 'tónů')}`,
    ringPct >= 95 ? 'ok' : ringPct >= 85 ? 'mid' : 'bad',
    'k-ring-d',
    ringPct >= 95
      ? 'Na všech tónech zní barva stejně. To je cíl — ring není jen na pár povedených tónech, ale na každém.'
      : ringPct >= 85
        ? 'Většinou ano, ale najdou se tóny, kde se barva láme. Podívej se níž, na kterých místech to je.'
        : 'Ring se na mnoha tónech láme. Hledej, co ty tóny mají společného — výšku, hlasitost nebo samohlásku.');

  /* ── ukazatel 2: síla hlasu (proti literatuře, orientační) ─────────── */
  const lvl = {
    profesionalni: ['Silná', 'ok',
      'Síla hlasu odpovídá tomu, co literatura měří u profesionálních zpěváků.'],
    mezi: ['Střední', 'mid',
      'Mezi nezpěváky a profesionály. Prostor na zlepšení je v opoře a hlasitosti — ' +
      'síla jde nahoru s hlasitostí, ne s tlačením na hlas.'],
    pod_nezpevakem: ['Slabá', 'bad',
      'Síla je pod tím, co literatura měří i u nezpěváků. Bývá to malá hlasitost ' +
      'nebo mikrofon daleko od úst — zkontroluj vzdálenost, než začneš soudit hlas.'],
  }[s.level] || ['—', 'none', ''];
  setKpi('k-level', lvl[0], `SPR ${fmt(s.spr_median, 1)} dB (medián)`, lvl[1], 'k-level-d', lvl[2]);

  /* ── ukazatel 2b: barva hlasu (FHE) ────────────────────────────────── */
  setFheKpi(res.fach, s.fhe_median);

  /* ── ukazatel 3: ladění vysokých tónů ──────────────────────────────── */
  if (s.f1_aligned_pct === null) {
    setKpi('k-f1', '—', 'v nahrávce nejsou tóny od G4 výš', 'none', 'k-f1-d',
      'Nad G4 se pozná, kde se rozpadá ladění. Bez takových tónů to hodnotit nelze — ' +
      'zazpívej i něco vyššího.');
  } else {
    const p = s.f1_aligned_pct;
    setKpi('k-f1', p.toFixed(0) + ' %',
      `${czPlural(s.f1_tuning_notes, 'z 1 tónu', `ze ${s.f1_tuning_notes} tónů`, `z ${s.f1_tuning_notes} tónů`)} od G4`,
      p >= 80 ? 'ok' : p >= 50 ? 'mid' : 'bad', 'k-f1-d',
      p >= 80
        ? 'První formant sedí na harmonickou tónu. Výška a barva drží spolu, tón nezní rozladěně.'
        : p >= 50
          ? 'Na části vysokých tónů formant nesedí na harmonickou — tón pak zní rozladěně, i když je výška správně. Pomáhá mírně upravit samohlásku.'
          : 'Formant většinou nesedí. Na vysokých tónech se rozpadá vazba mezi výškou a barvou. To je místo pro modifikaci samohlásky.');
  }

  /* ── ukazatel 4: kolik tónů se změřilo ─────────────────────────────── */
  const exc = [];
  if (s.n_excluded_short) exc.push(`${s.n_excluded_short} ${czPlural(s.n_excluded_short, 'útržek', 'útržky', 'útržků')} pod ${s.min_dur_used.toFixed(2)} s`);
  if (s.n_excluded_quiet) exc.push(`${s.n_excluded_quiet} příliš tichých`);
  setKpi('k-count', String(s.n_notes),
    exc.length ? `${exc.join(' a ')} vyřazeno` : 'vše měřitelné',
    'none', 'k-count-d',
    exc.length
      ? 'Vyřazené tóny byly tak krátké nebo tak tiché, že se z nich barva hlasu změřit nedá — na takových by „výpadek ringu" nic neznamenal. Nejde o chybu ve zpěvu.'
      : 'Všechny nalezené tóny měly dostatečnou délku i hlasitost, takže se z nich barva hlasu změřit dá.');

  // verdikt
  $('r-verdict').innerHTML = verdict(res);

  // výpadky — vypiš s časem, ne jen jménem noty
  const dw = $('r-dropouts');
  if (s.dropouts && s.dropouts.length) {
    dw.classList.remove('hidden');
    const list = s.dropouts.slice(0, 8).map(d => {
      const m = Math.floor(d.t / 60), sec = Math.round(d.t % 60);
      return `${escapeHtml(d.note)} v ${m}:${String(sec).padStart(2, '0')}`;
    }).join(', ');
    const more = s.dropouts.length > 8 ? ` a další ${s.dropouts.length - 8}` : '';
    dw.innerHTML = `<strong>${s.dropouts.length} ${czPlural(s.dropouts.length, 'tón', 'tóny', 'tónů')}, kde ring nedrží:</strong> ` +
      `${list}${more}. To jsou přesná místa v nahrávce, kam se vrátit.`;
  } else {
    dw.classList.add('hidden');
  }

  // grafy — rozměření i kresba jde jedním místem (layoutCharts), aby se
  // skrytá plátna nevykreslovala do nulové šířky
  requestAnimationFrame(() => {
    layoutCharts(true);
    // Zobrazení je hotové, teprve teď má smysl rozdělit práci a nechat
    // prohlížeč překreslit: analýza ve workeru jinak nechá výsledek stát
    // až do úplného konce (na dlouhé nahrávce i desítky sekund).
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => setupPlayer(), { timeout: 1500 });
    else setTimeout(() => setupPlayer(), 50);
  });

  // tabulka
  const tb = $('t-notes').querySelector('tbody');
  tb.innerHTML = '';
  for (const n of res.notes) {
    const tr = document.createElement('tr');
    if (n.ring_dropout) tr.className = 'dropout';
    const cell = (v, d = 0, cls = '') => {
      const td = document.createElement('td');
      td.textContent = v === v && v !== null ? (d ? v.toFixed(d) : Math.round(v)) : '—';
      if (cls) td.className = cls;
      return td;
    };
    // Vyřazený tón (moc krátký / moc tichý) NENÍ výpadek — v tabulce se to musí
    // poznat stejně jako v grafu, jinak si obojí odporuje.
    const ring = document.createElement('td');
    ring.textContent = n.ring_dropout ? 'NE' : n.ring_ok ? 'ANO' : '—';
    ring.className = n.ring_dropout ? 'bad' : n.ring_ok ? 'ok' : 'excl';
    tr.append(
      cell(n.idx),
      Object.assign(document.createElement('td'), { textContent: n.note }),
      Object.assign(document.createElement('td'), { textContent: fmtTime(n.t_start) }),
      cell(n.f0, 1),
      cell(n.dur, 2),
      cell(n.spr, 1),
      ring,
      cell(n.f1),
      cell(n.f2),
      cell(n.f1_f0_err_pct, 1),
      cell(n.hnr, 1),
      cell(n.vib_rate, 1),
    );
    tb.append(tr);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** mm:ss z sekund. */
function fmtTime(t) {
  if (!(t >= 0)) return '—';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setKpi(id, value, sub, cls, descId, desc) {
  const el = $(id);
  el.textContent = value;
  el.className = 'kpi-v' + (cls && cls !== 'none' ? ' ' + cls : '');
  $(id + '-s').textContent = sub;
  if (descId) {
    const d = $(descId);
    if (d) d.textContent = desc || '';
  }
}

/**
 * Ukazatel barvy hlasu (FHE).
 *
 * Vlastní vyhodnocení je v analysis.js (`vyhodnotFhe`) — tam se dá testovat
 * bez prohlížeče. Tady se jen předá do UI. Důvod: logika, která rozhoduje
 * o barvě hlasu, nesmí být schovaná v app.js, kam se testy nedostanou.
 */
function setFheKpi(fach, fhe) {
  const v = vyhodnotFhe(fach, fhe);
  const sub = fhe > 0 ? `FHE ${Math.round(fhe)} Hz` : 'v nahrávce se barva hlasu změřit nedala';
  setKpi('k-fhe', fheLabel(v), sub, v.cls, 'k-fhe-d', v.text);
}

function verdict(res) {
  const s = res.summary;
  const parts = [];
  const ringPct = s.ring_consistency_pct;

  // 1) je ring rovnoměrný?
  if (ringPct >= 95) {
    parts.push('<strong>Ring drží na každém tónu.</strong> ');
  } else if (ringPct >= 85) {
    parts.push(`<strong>Ring drží na ${ringPct.toFixed(0)} % tónů.</strong> `);
  } else {
    parts.push(`<strong>Ring se láme na ${(100 - ringPct).toFixed(0)} % tónů.</strong> `);
  }

  // 2) je ta hladina vůbec dobrá? (jiná otázka než 1)
  const lvlText = {
    profesionalni: 'Síla hlasu odpovídá profesionálům.',
    mezi: 'Síla hlasu je mezi nezpěváky a profesionály — prostor je v opoře a hlasitosti.',
    pod_nezpevakem: 'Síla hlasu je pod úrovní nezpěváků. Nejdřív zkontroluj vzdálenost mikrofonu a hlasitost.',
  }[s.level] || '';
  parts.push(lvlText);

  if (s.dropouts && s.dropouts.length) {
    parts.push(`Vrátit se na ${s.dropouts.length} ${czPlural(s.dropouts.length, 'místo', 'místa', 'míst')} — najdeš ${czPlural(s.dropouts.length, 'ho', 'je', 'je')} v grafu níž podle času.`);
  }

  // Barva hlasu — jen popis směru, NIKDY soud o kvalitě hlasu. Mimo referenční
  // pásmo to není vada (pásmo je ±1 směrodatná odchylka, tedy úzké).
  const fheRefs = { tenor: [2705, 221], baryton: [2454, 206], bas: [2384, 164], sopran: [3092, 284] };
  const fr = fheRefs[res.fach];
  if (fr && s.fhe_median > 0) {
    const dBand = s.fhe_median - fr[0];
    parts.push(Math.abs(dBand) <= fr[1]
      ? 'Barva hlasu leží v pásmu obvyklém pro tento rozsah.'
      : `Barva hlasu je ${dBand < 0 ? 'temnější' : 'světlejší'}, než je pro tento rozsah obvyklé — to je charakter hlasu, ne vada.`);
  }

  if (s.f1_aligned_pct !== null && s.f1_aligned_pct < 60) {
    parts.push(`Nad G4 se první formant trefuje jen v ${s.f1_aligned_pct.toFixed(0)} % — tam se rozpadá ladění. To je místo pro modifikaci samohlásky.`);
  }

  parts.push('<em>Srovnávej jen sám sebe, stejným mikrofonem a vzdáleností. Rozdíly pod 2 dB nejsou signál.</em>');
  return parts.join(' ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Proč nelze změřit ring — konkrétně podle příčiny.
 *
 * PŮVODNÍ CHYBA: hláška vždy tvrdila „nahrávka nemá dostatečné pásmo pro oblast
 * 2–4 kHz, zkus WAV". Jenže `spr_unusable` vzniká i tehdy, když analýza nenajde
 * ANI JEDEN TÓN (ticho, moc tichý záznam). Uživatel pak hledal vadu ve formátu,
 * která tam není — a rada „nahraj to jako WAV" nemohla nikdy pomoct.
 */
function unusableText(res) {
  const s = res.summary;
  const peak = res.peak_dbfs;
  const quiet = peak === peak && peak < -30;         // špička pod −30 dBFS = ticho

  if (s.n_notes_total === 0 && quiet) {
    return '<strong>Nahrávka je ticho.</strong><br>' +
      `Špička nahrávky je ${fmt(peak, 0)} dBFS — hluboko pod úrovní, ze které jde měřit hlas. ` +
      'Zkontroluj, že mikrofon opravdu snímá (indikátor úrovně při nahrávání se musí hýbat), ' +
      'že není ztlumený systémový vstup a že máš vybrané správné vstupní zařízení.';
  }
  if (s.n_notes_total === 0) {
    return '<strong>V nahrávce nejsou žádné zpívané tóny.</strong><br>' +
      `Špička je ${fmt(peak, 0)} dBFS, takže zvuk tam je — ale analýza v něm nenašla ` +
      'udržené tóny hlasu. Bývá to řeč, šum, doprovod bez zpěvu, nebo nahrávka kratší než ~2 s. ' +
      'Nahraj souvislý zpívaný tón nebo frázi.';
  }
  /* Nízký vzorkovací kmitočet NAHRÁVKY — výš než Nyquist v ní fyzicky není.
   *
   * PROČ SE TO SEM PŘIDALO (reálná chyba, naměřeno): tenhle případ dřív
   * propadal do poslední větve s radou „nahraj WAV nebo ve vysokém datovém
   * toku". U záznamníku v telefonu je to rada, která nemůže pomoct — i WAV
   * z téhož záznamníku má 16 kHz a ring z něj měřit nelze. Člověk pak hledá
   * vadu v datovém toku, která tam není (přesně ta chyba, kterou jsme už
   * jednou opravovali u hlášky o WAV).
   *
   * `s.low_rate` je spočítané z PŮVODNÍHO kmitočtu souboru — dekódování ho
   * přepíše na 48 kHz, takže `res.sample_rate` o skutečné šířce pásma nic
   * neříká (viz `sniffSampleRate` v app.js). */
  if (s.low_rate) {
    const fr = s.file_rate;
    return '<strong>Ring nelze změřit — nahrávka má nízký vzorkovací kmitočet.</strong><br>' +
      `Zvuk je uložený na ${Math.round(fr / 1000)} kHz, takže v nahrávce nejsou žádné ` +
      `kmitočty nad ${Math.round(fr / 2)} Hz. Pásmo 2–4 kHz, ze kterého se ring měří, ` +
      'je tím useknuté.<br><br>' +
      'Tohle NENÍ vada zpěvu ani souboru a nemá to nic společného s datovým tokem — ' +
      'takhle záznam uložil záznamník (bývá to nastavení „kvalita záznamu“ nebo úsporný ' +
      'režim). Zkus v záznamníku nastavit kvalitu na 44,1 nebo 48 kHz, nebo nahrávej ' +
      'tlačítkem <strong>Nahrávat</strong> přímo v této aplikaci.';
  }
  return '<strong>Ring nelze změřit.</strong><br>' + escapeHtml(s.reason) + '<br><br>' +
    'Rozsah 2–4 kHz, kde se ring měří, je v této nahrávce potlačený. To dělá ' +
    'silná komprese (nízký datový tok) nebo historický záznam. ' +
    'Nahrávej WAV nebo ve vysokém datovém toku.';
}

/* ═══════════════════════════════════════ historie */

function loadHist() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; }
}

function saveHist(rows) {
  localStorage.setItem(HIST_KEY, JSON.stringify(rows.slice(0, MAX_HIST)));
}

function addToHistory() {
  if (!current) return;
  const s = current.result.summary;
  const rows = loadHist();
  rows.unshift({
    date: current.date,
    label: current.label,
    fach: current.result.fach,
    n_notes: current.result.n_notes,
    spr_unusable: !!s.spr_unusable,
    reason: s.reason || null,
    spr_median: s.spr_median ?? null,
    spr_sd: s.spr_sd ?? null,
    ring_pct: s.ring_consistency_pct ?? null,
    fhe: s.fhe_median ?? null,
  });
  saveHist(rows);
  renderHist();
  $('btn-save').textContent = 'Uloženo ✓';
  $('btn-save').disabled = true;
  setTimeout(() => { $('btn-save').textContent = 'Uložit do historie'; $('btn-save').disabled = false; }, 1600);
}

/**
 * Uloží živé měření do historie.
 *
 * Tvar záznamu je ZÁMĚRNĚ stejný jako u analýzy nahrávky, aby tabulka i trend
 * fungovaly bez dalších změn. Dvě věci se ale liší a musí být vidět:
 *   live: true  — v tabulce se pozná, že nejde o analýzu celé nahrávky
 *   ring_pct    — živý režim vyrovnanost ringu ZMĚŘIT NEUMÍ (na to je potřeba
 *                 segmentovat tóny z celé nahrávky), takže zůstává prázdné
 */
function addLiveToHistory(s) {
  const rows = loadHist();
  rows.unshift({
    date: new Date().toISOString(),
    label: 'Živé měření',
    fach: s.fach,
    n_notes: s.voicedFrames,
    spr_unusable: !Number.isFinite(s.sprMedian),
    reason: Number.isFinite(s.sprMedian) ? null : 'málo zpívaných rámců',
    spr_median: Number.isFinite(s.sprMedian) ? s.sprMedian : null,
    spr_sd: Number.isFinite(s.centsSpread) ? s.centsSpread : null,
    ring_pct: null,
    fhe: Number.isFinite(s.fheMedian) ? s.fheMedian : null,
    live: true,
    seconds: s.seconds,
    peak_dbfs: Number.isFinite(s.peakDbfs) ? s.peakDbfs : null,
  });
  saveHist(rows);
  renderHist();
  showToast('Živé měření uloženo.');
}

function renderHist() {
  const rows = loadHist();
  const empty = $('hist-empty'), tbl = $('t-hist'), cv = $('c-trend');
  if (!rows.length) {
    empty.classList.remove('hidden');
    tbl.classList.add('hidden'); cv.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbl.classList.remove('hidden'); cv.classList.remove('hidden');

  const tb = tbl.querySelector('tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const td = (t, cls) => { const e = document.createElement('td'); e.textContent = t; if (cls) e.className = cls; return e; };
    tr.append(
      td(new Date(r.date).toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
      td(r.live ? r.fach + ' (živě)' : r.fach),
      td(r.live ? '—' : (r.spr_unusable ? '—' : (r.ring_pct != null ? r.ring_pct.toFixed(0) + ' %' : '—'))),
      td(r.spr_unusable ? 'nelze' : (r.spr_median != null ? r.spr_median.toFixed(1) : '—')),
      td(String(r.n_notes)),
      td(r.fhe ? Math.round(r.fhe) : '—'),
      td(''),
    );
    tr.lastChild.innerHTML = `<button class="link" data-del="${r.date}">smazat</button>`;
    tb.append(tr);
  }
  tb.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = () => {
      const d = b.getAttribute('data-del');
      saveHist(loadHist().filter(x => x.date !== d));
      renderHist();
    };
  });
  requestAnimationFrame(() => drawTrend(cv, rows));
}

/* ═══════════════════════════════════════ přehrávač + ukazatel */

let sprGeomRef = null;     // geometrie grafu ringu (z drawSpr) — pro klik a ukazatel
let lastHeadT = -1;        // poslední vykreslený čas, ať se nekreslí pořád totéž
let lastPane = '';         // která záložka je vidět (měření a kresba se přes ni ladí)
let lastChartLayout = '';  // '' = vynutit překreslení; jinak `width|dpr|pane`

/* ── záložky grafů ──────────────────────────────────────────────────────────
 * Grafy bývaly pod sebou (ring, spektrogram, ladění) a uživatel mezi nimi musel
 * vertikálně posouvat — a posouváním se mu ztratil přehrávač i ukazatel času.
 * Teď je nahoře přepínač a vidět je vždy JEDEN graf; přehrávač zůstává na místě.
 *
 * Přepínat se dá i za přehrávání: rAF smyčka jede dál, ukazatel se kreslí od
 * začátku (viz paintHeads/CHART_HEADS) a čas se bere z přehrávače, takže po
 * přepnutí čára stojí tam, kde má — nic se neresetuje.
 */
const CHART_TABS = ['spr', 'spec', 'f1'];

function activePane() {
  const shown = CHART_TABS.find(c => !$('pane-' + c)?.classList.contains('hidden'));
  return shown || (lastPane || 'spr');
}

function selectChart(which) {
  if (!CHART_TABS.includes(which)) return;
  lastPane = which;
  for (const c of CHART_TABS) {
    const pane = $('pane-' + c), tab = $('tab-' + c);
    if (pane) pane.classList.toggle('hidden', c !== which);
    if (tab) tab.setAttribute('aria-selected', c === which ? 'true' : 'false');
  }
  // Plátno, které je celou dobu skryté, nemá `clientWidth` — graf by se vykreslil
  // do šířky 0 a po přepnutí by zůstal prázdný. Proto se kreslí až tady.
  layoutCharts(true);
  /* Ukazatel se musí dokreslit do nově viditelného grafu. Když se čas mezitím
   * nezměnil, `lastHeadT` by kresbu přeskočilo — ale plátno je vyčištěné
   * překreslením grafu, takže by čára po přepnutí zmizela. Vynutit. */
  paintHeads(player?.el?.currentTime || 0, true);
}

/** Klik na záložku. Posluchače navěsit před prvním kreslením grafu. */
function bindChartTabs() {
  for (const c of CHART_TABS) {
    const tab = $('tab-' + c);
    if (tab) tab.onclick = () => selectChart(c);
  }
}

/* ── kresba grafů ──────────────────────────────────────────────────────────
 * Kreslit se smí jen viditelné plátno. Tři pasti, které to jinak tiše rozbije:
 *  1. **Skryté plátno nemá `clientWidth`.** Spektrogram se kreslí z bufferu
 *     o šířce plotW zjištěné z layoutu — na skrytém plátně vyjde šířka 0 a graf
 *     je prázdný, i když je zdroj dat správný.
 *  2. **Změna šířky/DIP vyžaduje překreslení.** Buffer se nastavuje podle
 *     `devicePixelRatio`; když se změní (přechod na jiný displej), starý buffer
 *     má špatnou velikost. Spektrogram se proto sám obnoví (jeho buffer si
 *     drží obraz), graf ringu stačí překreslit.
 *  3. **Uložený posun (`sprScroll.offX`) ukazuje do prázdna.** Po opětovném
 *     zapnutí posuvu na krátké nahrávce by zůstal nenulový a čára i sloupce by
 *     jely mimo. Resetuje se, když se posuv vypne.
 */

/** Vykreslí graf ringu s respektem k uloženému posuvu. */
function sprDrawGeom() {
  sprGeomRef = drawSpr($('c-spr'), current.result.notes, current.result.summary, null, sprDrawOpts());
  return sprGeomRef;
}

function drawSpecPane() {
  if (!current) return;
  const pane = $('pane-spec');
  if (pane && pane.classList.contains('hidden')) return;   // na skrytém plátně nemá cenu kreslit
  drawSpec($('c-spec'), current.samples, current.sampleRate, current.result.notes);
}

/** Rozměří a překreslí graf té záložky, která je vidět. */
function layoutCharts(force = false) {
  if (!current) return;
  const which = activePane();
  lastPane = which;
  const cv = $(which === 'spr' ? 'c-spr' : which === 'spec' ? 'c-spec' : 'c-f1');
  const dpr = window.devicePixelRatio || 1;
  const key = `${Math.round(cv?.clientWidth || 0)}|${dpr}|${which}`;
  if (!force && key === lastChartLayout) return;
  lastChartLayout = key;

  if (which === 'spr') layoutSpr();
  else if (which === 'spec') drawSpecPane();
  else drawF1($('c-f1'), current.result.notes, $('hint-f1'));
}

/** Když se plátno rozměří jinak (jiný displej, otočení, jiná šířka okna),
 *  musí se graf překreslit — buffer má jinou velikost. Spektrogram se navíc
 *  musí vykreslit CELÝ znovu, ne jen jinak rozměřit: jeho obraz je zapsaný
 *  v bufferu, který se nastavením `canvas.width` smaže. */
function watchChartLayout() {
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => layoutCharts(false));
    for (const c of CHART_TABS) {
      const el = $(c === 'spr' ? 'c-spr' : c === 'spec' ? 'c-spec' : 'c-f1');
      if (el) ro.observe(el);
    }
  }
  window.addEventListener('resize', () => layoutCharts(false));
}

/**
 * Posuvné plátno grafu ringu.
 *
 * PROČ: na 4minutové nahrávce se sto tónů nalepí na ~700 px, takže ze sloupců
 * je jednolitá plocha a nejde poznat, který tón má ring a který ne. Graf proto
 * dostane takovou šířku, aby každý tón měl aspoň 6 px, a jezdí se po něm
 * vodorovně. Graf se posouvá jen tehdy, když je potřeba (do šířky telefonu se
 * vejde málo tónů) — krátké nahrávky se chovají jako dřív, bez posuvu.
 *
 * Průhledné plátno s ukazatelem musí mít stejnou šířku i stejný posuv, jinak
 * by čára jela jinde než graf pod ní (přesně tahle past se u ukazatele už
 * jednou řešila).
 */
const sprScroll = { width: 0, offX: 0 };

function sprDrawOpts() {
  return { width: sprScroll.width, offX: sprScroll.offX };
}

function layoutSpr() {
  const chart = $('c-spr'), head = $('c-spr-head');
  if (!chart || !current) return;
  const avail = chart.parentElement?.clientWidth || chart.clientWidth || 600;
  const need = sprNeededWidth(avail, current.result.notes, current.result.duration_s);
  sprScroll.width = need;
  /* Když se posuv vypne (kratší nahrávka než minule), uložený posun ukazuje do
   * prázdna — sloupce i čára by jely mimo, protože geometrie by odečítala
   * scrollLeft, který už neexistuje. Proto se při vypnutí posuvu vynuluje. */
  if (!need) { sprScroll.offX = 0; const w = chart.parentElement; if (w && w.scrollLeft) w.scrollLeft = 0; }
  chart.style.width = need ? need + 'px' : '';
  if (head) head.style.width = need ? need + 'px' : '';
  const wrap = chart.parentElement;
  if (wrap) {
    wrap.classList.toggle('scrollable', !!need);
    // ukazatel se drží ve viditelném okně, aby nebyl mimo obrazovku
    if (need) {
      const g = sprGeomRef;
      const t = player?.el?.currentTime || 0;
      if (g && typeof g.pxAtTime === 'function') {
        const x = g.pxAtTime(t);
        const view = wrap.scrollLeft;
        if (x < view + 60 || x > view + wrap.clientWidth - 60) {
          wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2);
          sprScroll.offX = wrap.scrollLeft;
        }
      }
    }
  }
  sprDrawGeom();
  paintHeads(player?.el?.currentTime || 0, true);
}

function onSprScroll() {
  const wrap = $('c-spr')?.parentElement;
  if (!wrap) return;
  sprScroll.offX = wrap.scrollLeft;
  if (!current) return;
  sprDrawGeom();
  paintHeads(player?.el?.currentTime || 0, true);
}

/**
 * Nastaví přehrávač na právě změřenou nahrávku.
 *
 * Přehrává se PŮVODNÍ blob, ne dekódované vzorky — zvuk je pak přesně to, co
 * uživatel nahrál (a co se analyzovalo), bez přehrávání přes Web Audio.
 */
function setupPlayer() {
  teardownPlayer();
  if (!current) return;

  lastHeadT = -1;   // nová nahrávka → ukazatel se musí překreslit i na stejném čase
  if (!current.url) {
    // Bez původního blobu není co přehrát (viz runAnalysis). Tlačítka proto
    // zůstanou bez akce a rovnou se to řekne — mrtvé tlačítko je horší.
    showToast('Přehrávač nejde zapnout — k nahrávce se nedostal původní soubor.');
    setPlayIcon(false);
    return;
  }
  const el = new Audio();
  el.src = current.url;
  el.preload = 'metadata';

  player = { el, url: current.url, raf: 0, loopNote: null, seeking: false };

  el.addEventListener('loadedmetadata', () => updatePlayheadUI());
  el.addEventListener('timeupdate', () => { if (!player.seeking) updatePlayheadUI(); });
  el.addEventListener('ended', () => {
    // Smyčka tónu: po dojetí tónu skoč zpět na jeho začátek a hraj dál.
    if (player.loopNote) { el.currentTime = player.loopNote.t_start; el.play().catch(() => {}); }
    else { setPlayIcon(false); updatePlayheadUI(); }
  });

  setPlayIcon(false);
  setLoopPressed(false);
  $('btn-play').onclick = togglePlay;
  $('btn-loop').onclick = toggleLoop;
  $('seek').oninput = onSeekInput;
  // Klik do kteréhokoli grafu = skok v nahrávce, stejně jako když se sáhne na
  // lištu přehrávače. Každý graf má vlastní převod pixelu na čas.
  $('c-spr').onclick = onChartClick;
  $('c-spec').onclick = onChartClick;
  const f1cv = $('c-f1');
  if (f1cv) f1cv.onclick = onChartClick;
  // posuvné plátno ringu: klik do grafu i ukazatel musí počítat s posuvem
  const sprWrap = $('c-spr').parentElement;
  if (sprWrap) {
    sprWrap.onscroll = onSprScroll;
    sprScroll.offX = 0;
  }
  layoutSpr();
  const hintScroll = $('hint-scroll');
  if (hintScroll) hintScroll.classList.toggle('hidden', !sprScroll.width);
  updatePlayheadUI(true);
}

function teardownPlayer() {
  if (!player) return;
  cancelAnimationFrame(player.raf);
  if (player.url) URL.revokeObjectURL(player.url);
  if (player.el) { player.el.pause(); player.el.removeAttribute('src'); }
  player = null;
}

function togglePlay() {
  if (!player) return;
  if (player.el.paused) player.el.play().catch(e => console.warn('přehrávání', e));
  else player.el.pause();
  setPlayIcon(!player.el.paused);
  updatePlayheadUI();
}

function setPlayIcon(playing) {
  const ic = $('play-icon');
  if (!ic) return;
  ic.innerHTML = playing
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4h4v16H7zM13 4h4v16h-4z"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>';
  $('btn-play').setAttribute('aria-label', playing ? 'Pozastavit nahrávku' : 'Přehrát nahrávku');
}

function setLoopPressed(on) {
  const b = $('btn-loop');
  if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/** Najde tón, do kterého spadá daný čas — pro smyčku i pro zvýraznění. */
function noteAt(t) {
  const notes = current?.result?.notes || [];
  return notes.find(n => t >= n.t_start && t < n.t_end) || null;
}

function toggleLoop() {
  if (!player) return;
  if (player.loopNote) { player.loopNote = null; setLoopPressed(false); return; }
  const n = noteAt(player.el.currentTime);
  if (!n) { showToast('V tomto místě není změřený tón — přesuň se na tón.'); return; }
  player.loopNote = n;
  setLoopPressed(true);
  if (player.el.currentTime < n.t_start || player.el.currentTime >= n.t_end) {
    player.el.currentTime = n.t_start;
  }
  player.el.play().catch(() => {});
  setPlayIcon(true);
  updatePlayheadUI();
}

function onSeekInput() {
  if (!player) return;
  const d = player.el.duration || current?.result?.duration_s || 0;
  player.seeking = true;
  player.el.currentTime = ($('seek').value / 1000) * d;
  updatePlayheadUI();
  clearTimeout(onSeekInput._t);
  onSeekInput._t = setTimeout(() => { if (player) player.seeking = false; }, 220);
}

/**
 * Klepnutí do grafu = přeskočení na to místo v nahrávce (totéž co táhnout
 * lištou přehrávače). Každý graf má vlastní měřítko, proto se čas počítá
 * podle toho, do kterého se kliklo:
 *
 *  - **ring** — osa je čas, ale graf se dá odscrollovat, takže se k pixelu
 *    přičítá `sprScroll.offX` (jinak klik po odscrollování hledá o kus vedle)
 *  - **spektrogram** — vlastní geometrie (`specGeom`), čas na ose X
 *  - **ladění F1** — osa je čas, ale kreslí se jen tóny od G4 výš; klik proto
 *    trefí čas přímo a skočí na něj (stejně jako u ostatních grafů)
 */
function onChartClick(e) {
  if (!player) return;
  const cv = e.currentTarget;
  const rect = cv.getBoundingClientRect();
  const px = e.clientX - rect.left + (cv.id === 'c-spr' ? sprScroll.offX : 0);
  let t;
  if (cv.id === 'c-spr') {
    if (!sprGeomRef) return;
    t = sprGeomRef.timeAtX(px);
  } else if (cv.id === 'c-f1') {
    const g = f1Geom(cv.clientWidth, F1_H, f1Notes(current?.result?.notes));
    if (!g) return;
    t = g.timeAtX(px);
  } else {
    const g = specGeom(cv.clientWidth, SPEC_H, current.result.duration_s || 1);
    t = g.timeAtX(px);
  }
  if (!Number.isFinite(t)) return;
  t = Math.max(0, Math.min(t, player.el.duration || current.result.duration_s || 0));
  player.el.currentTime = t;
  // smyčka se váže na tón — po přesunu je potřeba ji přepočítat
  if (player.loopNote) player.loopNote = noteAt(t);
  updatePlayheadUI(true);
}

/**
 * Překreslí ukazatel (a při přesunu i čísla) podle aktuálního času.
 *
 * Vlastní kresba ukazatele jde do rAF smyčky, protože `timeupdate` chodí jen
 * ~4× za sekundu — s ním by čára poskakovala. rAF se sám zastaví, když se nic
 * nezměnilo (pauza), takže na pozadí nic nežere.
 */
function updatePlayheadUI(force = false) {
  if (!player) return;
  const el = player.el;
  const d = el.duration || current?.result?.duration_s || 0;
  const t = el.currentTime || 0;

  const pm = Math.floor(t / 60), ps = Math.floor(t % 60);
  const dm = Math.floor(d / 60), ds = Math.floor(d % 60);
  $('play-time').textContent =
    `${pm}:${String(ps).padStart(2, '0')} / ${dm}:${String(ds).padStart(2, '0')}`;
  if (!player.seeking && d > 0) $('seek').value = String(Math.round((t / d) * 1000));

  /* Při přehrávání se posouvá jen graf ringu — a jen když je zrovna vidět.
   * Když je otevřená jiná záložka, `followSprScroll` by posouval skrytou
   * posuvnou plochu (a měnil `offX`, se kterým se pak musí počítat klik). */
  if (sprScroll.width && !player.seeking && lastPane === 'spr') followSprScroll(t);
  paintHeads(t, force);

  if (!el.paused) {
    cancelAnimationFrame(player.raf);
    player.raf = requestAnimationFrame(() => updatePlayheadUI());
  }
}

/** Drží ukazatel v okně posuvného grafu ringu. */
function followSprScroll(t) {
  const wrap = $('c-spr')?.parentElement;
  if (!wrap || !sprGeomRef?.pxAtTime) return;
  const x = sprGeomRef.pxAtTime(t);
  const view = wrap.scrollLeft;
  const w = wrap.clientWidth;
  if (x < view + 40 || x > view + w - 40) {
    const target = Math.max(0, x - w / 2);
    wrap.scrollLeft = target;
    sprScroll.offX = target;
  }
}

/**
 * Vykreslí ukazatel do VŠECH grafů, ne jen do toho viditelného.
 *
 * PROČ: přepnutí záložky je okamžité a nesmí se u toho nic dopočítávat. Kdyby
 * se čára kreslila jen do viditelného grafu, po přepnutí by na novém plátně
 * chvíli (nebo navždy, když se čas nezměnil) chyběla. Kresba čáry je pár tahů,
 * takže se dá dělat do všech tří — grafy samotné se kvůli tomu NEPŘEKRESLUJÍ.
 *
 * `lastHeadT` drží poslední vykreslený čas, aby se při 60 snímcích za sekundu
 * nekreslilo pořád totéž. Po přepnutí záložky se volá s `force`, protože plátno
 * je čisté a čára se musí dokreslit i na nezměněném čase.
 */
function paintHeads(t, force = false) {
  if (!force && Math.abs(t - lastHeadT) < 0.004) return;
  lastHeadT = t;
  const s = current?.result?.summary;
  if (!s) return;
  const notes = current.result.notes;
  // Ring a ladění: bez měřitelných tónů se nic nekreslí (kresba to sama přeskočí).
  drawSprHead($('c-spr-head'), notes, s, t, sprDrawOpts());
  drawF1Head($('c-f1-head'), notes, t);
  const dur = current?.result?.duration_s;
  if (dur) drawSpecHead($('c-spec-head'), dur, t);
}


function download(name, text, mime = 'text/plain') {
  const b = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function makeMarkdown() {
  const r = current.result, s = r.summary, d = new Date(current.date);
  const L = [];
  L.push(`# Analýza: ${current.label}`, '');
  L.push(`${d.toLocaleString('cs-CZ')} · ${r.duration_s.toFixed(1)} s · ` +
    `${r.notes.length} tónů · obor ${r.fach}`, '');
  L.push('## Ring');
  if (s.spr_unusable) {
    L.push(`**Ring nelze měřit:** ${s.reason}`);
  } else {
    L.push(`- Vyrovnanost: **${s.notes_with_ring}/${s.n_notes}** tónů ` +
      `(${s.ring_consistency_pct.toFixed(1)} %) — na kolika tónech se barva neláme`);
    L.push(`- Síla hlasu (proti literatuře): **${s.level}**, SPR medián **${fmt(s.spr_median, 2)} dB** ` +
      `(${s.pct_above_ref.toFixed(0)} % tónů nad ${s.ref_threshold} dB)`);
    L.push(`- Rozptyl ± ${fmt(s.spr_sd, 2)} dB, rozsah ${fmt(s.spr_min, 1)} až ${fmt(s.spr_max, 1)} dB`);
    L.push(`- Práh výpadku ${fmt(s.ring_threshold, 1)} dB (${s.threshold_method})`);
    if (s.dropouts.length) {
      const list = s.dropouts.map(x => `${x.note} v ${fmtTime(x.t)}`).join(', ');
      L.push(`- **Výpadky (${s.dropouts.length}): ${list}**`);
    } else L.push('- Beze výpadků.');
    L.push(`- FHE (barva hlasu): ${s.fhe_median ? Math.round(s.fhe_median) : '—'} Hz`);
    if (s.fhe_median && res.fach === 'tenor' && s.fhe_median < 2480) {
      L.push('  (Pozor: referenční hodnota pro tenor je 2705 ± 221 Hz. Nižší ' +
        'naměřená hodnota u nahrávky v nízké — např. baritonové — poloze není ' +
        'vada hlasu, jen se na tóny v této poloze reference nevztahuje.)');
    }
    L.push(`- Ladění od G4: ${s.f1_aligned_pct === null ? '—' : s.f1_aligned_pct.toFixed(1) + ' %'}`);
  }
  L.push('', '## Po tónech', '');
  L.push('| # | tón | čas | f0 Hz | délka | SPR dB | ring | F1 | F2 | F1:F0 % | HNR | vibr. Hz |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const n of r.notes) {
    const v = (x, d2 = 0) => (x === x && x !== null ? (d2 ? x.toFixed(d2) : Math.round(x)) : '—');
    L.push(`| ${n.idx} | ${n.note} | ${fmtTime(n.t_start)} | ${v(n.f0, 1)} | ${v(n.dur, 2)} | ${v(n.spr, 1)} | ` +
      `${n.ring_ok ? 'ANO' : 'NE'} | ${v(n.f1)} | ${v(n.f2)} | ${v(n.f1_f0_err_pct, 1)} | ` +
      `${v(n.hnr, 1)} | ${v(n.vib_rate, 1)} |`);
  }
  L.push('', '## Omezení', '');
  L.push('- Absolutní hodnoty závisí na mikrofonu, vzdálenosti a ekvalizaci nahrávky. ' +
    'Srovnatelné je jen měření stejným řetězcem.');
  L.push('- Rozdíly menší než 2 dB nejsou signál.');
  L.push('- Vyrovnanost a úroveň jsou dvě různé věci: rovnoměrně slabý hlas má ' +
    'vyrovnanost vysokou, ale úroveň nízkou.');
  L.push('- Z mikrofonu nelze měřit subglotický tlak, míru dovření hlasivek ani polohu hrtanu.');
  return L.join('\n');
}

/* ═══════════════════════════════════════ start */

function init() {
  $('btn-record').onclick = startRecord;
  $('btn-stop').onclick = stopRecord;
  $('btn-cancel').onclick = () => {
    cancelled = true;
    hideProgress();
    $('panel-input').classList.remove('hidden');
  };
  $('btn-new').onclick = () => {
    teardownPlayer();
    lastHeadT = -1;
    lastChartLayout = ''; lastPane = '';
    sprScroll.width = 0; sprScroll.offX = 0;
    const w = $('c-spr')?.parentElement;
    if (w) { w.classList.remove('scrollable'); w.onscroll = null; }
    clearHead($('c-spr-head'), SPR_H);
    clearHead($('c-spec-head'), SPEC_H);
    clearHead($('c-f1-head'), F1_H);
    if (current?.url) URL.revokeObjectURL(current.url);
    current = null;
    $('panel-result').classList.add('hidden');
    $('panel-input').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  $('btn-save').onclick = addToHistory;
  $('btn-md').onclick = () => download('analyza.md', makeMarkdown(), 'text/markdown');
  $('btn-json').onclick = () => download('analyza.json',
    JSON.stringify(current.result, (k, v) => (v === undefined ? null : v), 2), 'application/json');
  $('btn-clear').onclick = () => {
    if (confirm('Smazat všechna uložená měření? Tuto akci nelze vrátit.')) {
      localStorage.removeItem(HIST_KEY);
      renderHist();
    }
  };

  // Živý režim — ovládání si drží live-ui.js, sem se předává jen ukládání.
  initLive(addLiveToHistory);

  $('file-input').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await handleBlob(f, f.name.replace(/\.[^.]+$/, ''));
    e.target.value = '';
  };

  $('fach').onchange = () => {
    const [lo, hi] = REFS.fach_ranges[$('fach').value];
    $('fach-hint').textContent =
      `Tóny mimo rozsah ${lo.toFixed(0)}–${hi.toFixed(0)} Hz se vyřadí — analýza pak ` +
      'nechytá doprovod ani orchestr. Vyber podle toho, kde nahrávka leží, ' +
      'ne podle svého oboru.';
  };

  renderHist();

  // záložky grafů nad přehrávačem + překreslení po změně rozměru/DIP
  bindChartTabs();
  watchChartLayout();

  // Service worker (offline) + tlačítko pro kontrolu nové verze
  registerSW();
}

/* ═══════════════════════════════════════ aktualizace aplikace */

/**
 * Registrace service workeru a tlačítko „zkontrolovat novou verzi".
 *
 * Service worker sám drží staré assety, dokud se neaktivuje nový — proto se
 * aplikace po nasazení může tvářit nezměněná. Tlačítko v hlavičce proto
 * vynutí `registration.update()`, počká, až se nový worker skutečně stáhne
 * (spinner běží celou dobu), a teprve pak dá reload.
 *
 * Dvě věci, které se snadno pokazí a jsou tady proto ošetřené:
 *  1. `registration.update()` se vrátí dřív, než se nový worker vůbec objeví
 *     (instalace assetů běží asynchronně). Čtení `registration.installing`
 *     hned po `update()` proto vrací null — musí se počkat na `updatefound`.
 *  2. Nový worker se aktivuje, teprve když ten starý uvolní kontrolu. Až se
 *     tak stane, `controllerchange` vyvolá reload. Bez čekání na `installed`
 *     by se stránka reloadovala zbytečně dvakrát.
 */
let swReg = null;
let swChecking = false;
let reloading = false;

/**
 * Zjistí, jaká verze aplikace právě běží.
 *
 * Proč to není jen konstanta v app.js: po aktualizaci se mění `sw.js`, ne
 * `app.js`. Když se verze bere z běžícího skriptu, po aktualizaci se číslo
 * nezmění a uživatel nemá jak poznat, že se něco stalo. Proto se verze čte
 * ze SERVERU (`sw.js`, přes `cache: 'no-store'`) a porovnává se s verzí
 * aktivního service workeru.
 *
 * Vrací { server, aktivni } — chybí, když se to nepodaří zjistit.
 */
async function fetchVersionOf(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const t = await r.text();
    const m = t.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function showVersions() {
  const el = $('app-ver');
  if (!el) return;
  const aktivni = await fetchVersionOf('sw.js');   // co obsluhuje stránku
  const server = aktivni;                          // bez cache je totožné s nasazeným
  el.textContent = aktivni || '—';
  el.title = server ? `Běží verze ${aktivni}.` : '';
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

/** Ukáže hlášku, která NEMÁ zmizet sama — u výsledku aktualizace to jinak
    blikne a uživatel si není jistý, co se stalo. */

function showToastSticky(msg, ms = 9000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function setUpdating(on) {
  $('btn-update').disabled = on;
  const ic = $('upd-icon');
  ic.innerHTML = on
    ? '<span class="spinner"></span>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>';
}

/**
 * Počká, než se nový worker doinstaluje. Vrací true/false — bez časového
 * limitu by tlačítko viselo ve spinneru navždy, kdyby stahování uvázlo.
 */
function waitForInstalled(worker, timeoutMs = 20000) {
  const ready = () => worker.state === 'installed' || worker.state === 'activated';
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onState = () => { if (ready()) done(true); };
    const done = (ok) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', onState);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    worker.addEventListener('statechange', onState);
  });
}

async function checkForUpdate() {
  if (swChecking) return;

  // Bez service workeru (vývoj přes http, starý prohlížeč) není co aktualizovat.
  if (!swReg) {
    showToast('Aktualizaci nelze zkontrolovat — aplikace neběží jako PWA.');
    return;
  }

  swChecking = true;
  setUpdating(true);
  try {
    await swReg.update();

    // `updatefound` vyletí, jakmile prohlížeč zjistí, že je na serveru jiný
    // sw.js. Když nic nového není, nevyletí vůbec a žádný signál „hotovo, nic
    // není" neexistuje — proto se čeká jen krátce. Delší čekání by znamenalo
    // spinner navíc u každého kliknutí, kdy je aplikace aktuální.
    //
    // ALE: stejně krátká doba znamená, že u aktuální aplikace spinner blikne
    // a zmizí — uživatel nabude dojmu, že tlačítko nic nedělá. Proto se
    // spinner drží ještě MINIMÁLNÍ dobu, aby byl klik vůbec vidět.
    const t0 = Date.now();
    const minSpinnerMs = 900;
    let worker = swReg.waiting || swReg.installing;
    if (!worker) {
      worker = await new Promise((resolve) => {
        const done = (w) => {
          clearTimeout(timer);
          swReg.removeEventListener('updatefound', onFound);
          resolve(w || null);
        };
        const onFound = () => done(swReg.installing);
        swReg.addEventListener('updatefound', onFound);
        const timer = setTimeout(() => done(swReg.installing), 3000);
      });
    }

    if (!worker) {
      const zbývá = minSpinnerMs - (Date.now() - t0);
      if (zbývá > 0) await new Promise(r => setTimeout(r, zbývá));
      const v = await fetchVersionOf('sw.js');
      showToastSticky(v ? `Máš nejnovější verzi (${v}).` : 'Máš nejnovější verzi.');
      return;
    }

    // Počkat, až se assety skutečně stáhnou — teprve pak má cenu reloadovat.
    if (worker.state === 'installing' || worker.state === 'installed') {
      const ok = await waitForInstalled(worker);
      if (!ok) {
        showToast('Stahování nové verze trvá příliš dlouho. Zkus to znovu.');
        return;
      }
    }

    // Reload až ve chvíli, kdy nový worker převezme kontrolu. Kdyby se
    // reloadovalo dřív, stránku by ještě obsluhoval starý worker a uživatel
    // by viděl pořád tu samou verzi.
    //
    // POZOR: `finally` níže sundá spinner i při reloadu, takže uživatel
    // u rychlé aktualizace nevidí skoro nic. Proto se před reloadem ukáže
    // POTVRZENÍ, které chvíli drží — a v patičce je vidět číslo verze,
    // takže je dohledatelné i zpětně, že se verze změnila.
    if (swReg.waiting) {
      const onControl = () => {
        if (reloading) return;
        reloading = true;
        setUpdating(false);
        showToastSticky('Aktualizováno na novou verzi, načítám…', 1200);
        setTimeout(() => location.reload(), 1200);
      };
      navigator.serviceWorker.addEventListener('controllerchange', onControl);
      swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // Nic nečeká na kontrolu (první instalace) — reload může hned.
      reloading = true;
      setUpdating(false);
      showToastSticky('Aktualizováno na novou verzi, načítám…', 1200);
      setTimeout(() => location.reload(), 1200);
    }
  } catch (e) {
    console.warn('Kontrola aktualizace selhala', e);
    showToast('Kontrolu aktualizace se nepodařilo dokončit.');
  } finally {
    swChecking = false;
    setUpdating(false);
  }
}

function registerSW() {
  if (!('serviceWorker' in navigator)) {
    // Tlačítko nechat funkční, ať uživatel dostane vysvětlení, ne mrtvý prvek.
    $('btn-update').onclick = checkForUpdate;
    return;
  }
  navigator.serviceWorker.register('sw.js')
    .then((reg) => { swReg = reg; })
    .catch((e) => console.warn('Service worker se nepodařilo zaregistrovat', e));
  $('btn-update').onclick = checkForUpdate;
  showVersions();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
