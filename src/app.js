/**
 * Analýza zpěvního hlasu — hlavní logika aplikace.
 * Nahrávání/načtení → analýza v prohlížeči → výsledky → historie.
 */
import { analyze, REFS, czPlural } from './analysis.js';
import { drawSpr, drawF1, drawSpec, drawTrend, fmt } from './charts.js';

const $ = (id) => document.getElementById(id);
const HIST_KEY = 'vocal-lab.history.v1';
const MAX_HIST = 60;

let current = null;      // { result, samples, sampleRate, label, date }
let recorder = null, recChunks = [], recStream = null, recTimer = null, recStart = 0;
let audioCtx = null, analyser = null, levelRaf = 0, cancelled = false;

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

async function handleBlob(blob, label) {
  showProgress(0.02, 'Dekóduji zvuk…');
  try {
    const ab = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(ab.slice(0));
    await ctx.close();
    const mono = toMono(audio);
    runAnalysis(mono, audio.sampleRate, label);
  } catch (e) {
    console.error(e);
    // fallback: MediaRecorder často vyrobí webm/opus, který decodeAudioData
    // v některých prohlížečích nepřečte — zkus přes <audio> element
    try {
      const mono = await decodeViaElement(blob);
      if (mono) return runAnalysis(mono.samples, mono.sampleRate, label);
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

function runAnalysis(samples, sampleRate, label) {
  cancelled = false;
  const fach = $('fach').value;
  showProgress(0.05, 'Spouštím analýzu…');

  // nechat prohlížeči vykreslit progress bar
  setTimeout(() => {
    if (cancelled) return;
    const t0 = performance.now();
    let res;
    try {
      res = analyze(samples, sampleRate, {
        fach,
        onProgress: (p, msg) => { if (!cancelled) showProgress(p, msg); },
      });
    } catch (e) {
      console.error(e);
      alert('Analýza selhala: ' + e.message);
      hideProgress();
      $('panel-input').classList.remove('hidden');
      return;
    }
    const secs = (performance.now() - t0) / 1000;
    console.log(`[i] analýza ${samples.length / sampleRate | 0} s audia za ${secs.toFixed(1)} s`);
    if (cancelled) return;

    current = { result: res, samples, sampleRate, label, date: new Date().toISOString() };
    showResult(res, samples, sampleRate, label, secs);
  }, 40);
}

/* ═══════════════════════════════════════ UI: průběh */

function showProgress(p, msg) {
  $('panel-input').classList.add('hidden');
  $('panel-result').classList.add('hidden');
  $('panel-progress').classList.remove('hidden');
  $('prog-fill').style.width = Math.round(p * 100) + '%';
  $('prog-text').textContent = msg;
}

function hideProgress() {
  $('panel-progress').classList.add('hidden');
}

/* ═══════════════════════════════════════ UI: výsledek */

function showResult(res, samples, sampleRate, label, secs) {
  hideProgress();
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
    $('r-unusable').innerHTML =
      `<strong>SPR nelze měřit.</strong><br>${escapeHtml(s.reason)}<br><br>` +
      'Nahrávka nemá dostatečné pásmo pro oblast 2–4 kHz. Typicky jde o silně ' +
      'komprimovaný zvuk (m4a, opus, telefonní záznam) nebo historickou nahrávku. ' +
      'Zkus nahrát znovu, ideálně jako WAV.';
    $('r-body').classList.add('hidden');
    return;
  }
  $('r-unusable').classList.add('hidden');
  $('r-body').classList.remove('hidden');

  // KPI
  const ringPct = s.ring_consistency_pct;
  setKpi('k-ring', ringPct.toFixed(0) + ' %',
    `${s.notes_with_ring}/${s.n_notes} ${czPlural(s.n_notes, 'tón', 'tóny', 'tónů')}`,
    ringPct >= 95 ? 'ok' : ringPct >= 80 ? 'mid' : 'bad');

  setKpi('k-spr', fmt(s.spr_median, 1), `± ${fmt(s.spr_sd, 1)} (rozptyl)`,
    s.spr_median >= -15 ? 'ok' : s.spr_median >= -20 ? 'mid' : 'bad');

  const fheRef = REFS.FHE[res.fach];
  setKpi('k-fhe', s.fhe_median ? Math.round(s.fhe_median) : '—',
    fheRef ? `ref. ${res.fach} ${fheRef[0]} Hz` : 'bez reference',
    'none');

  if (s.f1_aligned_pct === null) {
    setKpi('k-f1', '—', 'žádný tón od G4 výš', 'none');
  } else {
    setKpi('k-f1', s.f1_aligned_pct.toFixed(0) + ' %',
      `z ${s.f1_tuning_notes} ${czPlural(s.f1_tuning_notes, 'tónu', 'tónů', 'tónů')} od G4`,
      s.f1_aligned_pct >= 80 ? 'ok' : s.f1_aligned_pct >= 50 ? 'mid' : 'bad');
  }

  // verdikt
  $('r-verdict').innerHTML = verdict(res);

  // výpadky
  const dw = $('r-dropouts');
  if (s.dropout_notes.length) {
    dw.classList.remove('hidden');
    dw.innerHTML = `<strong>Výpadky ringu na tónech:</strong> ` +
      `${escapeHtml(s.dropout_notes.join(', '))}. ` +
      `To jsou místa, kde se ring ztrácí — přesně tam má smysl se vracet.`;
  } else {
    dw.classList.add('hidden');
  }

  // grafy
  requestAnimationFrame(() => {
    drawSpr($('c-spr'), res.notes, s);
    drawF1($('c-f1'), res.notes, $('hint-f1'));
    drawSpec($('c-spec'), samples, sampleRate, res.notes);
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
    tr.append(
      cell(n.idx),
      Object.assign(document.createElement('td'), { textContent: n.note }),
      cell(n.f0, 1),
      cell(n.dur, 2),
      cell(n.spr, 1),
    );
    const ring = document.createElement('td');
    ring.textContent = n.ring_ok ? 'ANO' : 'NE';
    ring.className = n.ring_ok ? 'ok' : 'bad';
    tr.append(ring, cell(n.f1), cell(n.f2),
      cell(n.f1_f0_err_pct, 1),
      cell(n.hnr, 1),
      cell(n.vib_rate, 1));
    tb.append(tr);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setKpi(id, value, sub, cls) {
  const el = $(id);
  el.textContent = value;
  el.className = 'kpi-v' + (cls && cls !== 'none' ? ' ' + cls : '');
  $(id + '-s').textContent = sub;
}

function verdict(res) {
  const s = res.summary;
  const parts = [];
  const ringPct = s.ring_consistency_pct;

  if (ringPct >= 95) {
    parts.push(`<strong>Ring drží na ${ringPct.toFixed(0)} % tónů.</strong> ` +
      'To je přesně ten cíl — všudypřítomný ring, ne jen na pár dobrých tónech.');
  } else if (ringPct >= 80) {
    parts.push(`<strong>Ring drží na ${ringPct.toFixed(0)} % tónů.</strong> ` +
      'Většinou ano, ale najdou se místa, kde se ztrácí — viz výpady níž.');
  } else {
    parts.push(`<strong>Ring je přítomný jen na ${ringPct.toFixed(0)} % tónů.</strong> ` +
      'Není všudypřítomný — hledej, co mají výpadky společného (výška, samohláska).');
  }

  if (s.spr_median >= -13.1) {
    parts.push(`Medián SPR ${fmt(s.spr_median, 1)} dB je v pásmu profesionálů ` +
      '(−13,1 dB).');
  } else if (s.spr_median >= -20) {
    parts.push(`Medián SPR ${fmt(s.spr_median, 1)} dB je lepší než nezpěváci ` +
      '(−22,7 dB), ale pod profesionály (−13,1 dB).');
  } else {
    parts.push(`Medián SPR ${fmt(s.spr_median, 1)} dB je v pásmu nezpěváků ` +
      '(−22,7 dB).');
  }

  if (s.spr_sd > 6) {
    parts.push(`Rozptyl je ale vysoký (± ${fmt(s.spr_sd, 1)} dB) — ` +
      'ring není stabilní, jednou je a jednou ne.');
  }

  if (s.f1_aligned_pct !== null && s.f1_aligned_pct < 60) {
    parts.push(`Nad G4 se první formant trefuje jen v ${s.f1_aligned_pct.toFixed(0)} % — ` +
      'tam se rozpadá ladění. To je místo pro modifikaci samohlásky.');
  }

  parts.push('<em>Připomínka: absolutní hodnoty jsou srovnatelné jen stejným ' +
    'mikrofonem a vzdáleností. Rozdíly pod 2 dB nejsou signál.</em>');
  return parts.join(' ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
      td(r.fach),
      td(r.spr_unusable ? '—' : (r.ring_pct != null ? r.ring_pct.toFixed(0) + ' %' : '—')),
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

/* ═══════════════════════════════════════ exporty */

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
  L.push('## Ring konzistence');
  if (s.spr_unusable) {
    L.push(`**SPR nelze měřit:** ${s.reason}`);
  } else {
    L.push(`- Tónů s ringem: **${s.notes_with_ring}/${s.n_notes}** (${s.ring_consistency_pct.toFixed(1)} %)`);
    L.push(`- SPR medián **${fmt(s.spr_median, 2)} dB**, rozptyl ± ${fmt(s.spr_sd, 2)} dB`);
    L.push(`- Rozsah ${fmt(s.spr_min, 1)} až ${fmt(s.spr_max, 1)} dB`);
    if (s.dropout_notes.length) L.push(`- **Výpadky na tónech: ${s.dropout_notes.join(', ')}**`);
    else L.push('- Beze výpadků.');
    L.push(`- FHE (barva hlasu): ${s.fhe_median ? Math.round(s.fhe_median) : '—'} Hz`);
    L.push(`- F1 laděno: ${s.f1_aligned_pct === null ? '—' : s.f1_aligned_pct.toFixed(1) + ' %'}`);
  }
  L.push('', '## Po tónech', '');
  L.push('| # | tón | f0 Hz | délka | SPR dB | ring | F1 | F2 | F1:F0 % | HNR | vibr. Hz |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const n of r.notes) {
    const v = (x, d2 = 0) => (x === x && x !== null ? (d2 ? x.toFixed(d2) : Math.round(x)) : '—');
    L.push(`| ${n.idx} | ${n.note} | ${v(n.f0, 1)} | ${v(n.dur, 2)} | ${v(n.spr, 1)} | ` +
      `${n.ring_ok ? 'ANO' : 'NE'} | ${v(n.f1)} | ${v(n.f2)} | ${v(n.f1_f0_err_pct, 1)} | ` +
      `${v(n.hnr, 1)} | ${v(n.vib_rate, 1)} |`);
  }
  L.push('', '## Omezení', '');
  L.push('- Absolutní hodnoty závisí na mikrofonu, vzdálenosti a ekvalizaci nahrávky. ' +
    'Srovnatelné je jen měření stejným řetězcem.');
  L.push('- Rozdíly menší než 2 dB nejsou signál.');
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

  $('file-input').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await handleBlob(f, f.name.replace(/\.[^.]+$/, ''));
    e.target.value = '';
  };

  $('fach').onchange = () => {
    const [lo, hi] = REFS.fach_ranges[$('fach').value];
    $('fach-hint').textContent =
      `Tóny mimo rozsah ${lo.toFixed(0)}–${hi.toFixed(0)} Hz se vyřadí — brání tomu, ` +
      'aby analýza chytala doprovod nebo orchestr.';
  };

  renderHist();

  // Service worker (offline)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
