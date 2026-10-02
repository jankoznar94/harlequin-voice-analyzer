/**
 * Analýza zpěvního hlasu — hlavní logika aplikace.
 * Nahrávání/načtení → analýza v prohlížeči → výsledky → historie.
 */
import { analyze, REFS, czPlural } from './analysis.js';
import {
  drawSpr, drawF1, drawSpec, drawTrend, fmt,
  sprGeom, drawSpecHead, drawSprHead, clearHead, SPR_H, SPEC_H,
} from './charts.js';

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

    current = {
      result: res, samples, sampleRate, label, date: new Date().toISOString(),
      buffer: blob,               // originál — přehrávač si ho přehraje, ne dekódované vzorky
      url: URL.createObjectURL(blob),
    };
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
      `<strong>Ring nelze změřit.</strong><br>${escapeHtml(s.reason)}<br><br>` +
      'Nahrávka nemá dostatečné pásmo pro oblast 2–4 kHz. Typicky jde o silně ' +
      'komprimovaný zvuk (m4a, opus, telefonní záznam) nebo historickou nahrávku. ' +
      'Zkus nahrát znovu, ideálně jako WAV.';
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

  /* ── ukazatel 2: síla ringu (proti literatuře, orientační) ─────────── */
  const lvl = {
    profesionalni: ['Silný', 'ok',
      'Tato hladina odpovídá tomu, co literatura měří u profesionálních zpěváků.'],
    mezi: ['Střední', 'mid',
      'Mezi nezpěváky a profesionály. Prostor na zlepšení je v hlasitosti a opoře — ' +
      'síla ringu jde nahoru s hlasitostí, ne s tlačením na hlas.'],
    pod_nezpevakem: ['Slabý', 'bad',
      'Hladina je pod tím, co literatura měří i u nezpěváků. Bývá to malá hlasitost ' +
      'nebo mikrofon daleko od úst — zkontroluj vzdálenost, než začneš soudit hlas.'],
  }[s.level] || ['—', 'none', ''];
  setKpi('k-level', lvl[0], `SPR ${fmt(s.spr_median, 1)} dB (medián)`, lvl[1], 'k-level-d', lvl[2]);

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

  // grafy — drawSpr vrací geometrii, kterou používá klik do grafu i přehrávač
  requestAnimationFrame(() => {
    sprGeomRef = drawSpr($('c-spr'), res.notes, s);
    drawF1($('c-f1'), res.notes, $('hint-f1'));
    drawSpec($('c-spec'), samples, sampleRate, res.notes);
    setupPlayer();
    updatePlayheadUI();
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
    const ring = document.createElement('td');
    ring.textContent = n.ring_ok ? 'ANO' : 'NE';
    ring.className = n.ring_ok ? 'ok' : 'bad';
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
    profesionalni: 'Síla ringu odpovídá profesionálům.',
    mezi: 'Síla ringu je mezi nezpěváky a profesionály — prostor je v opoře a hlasitosti.',
    pod_nezpevakem: 'Síla ringu je pod úrovní nezpěváků. Nejdřív zkontroluj vzdálenost mikrofonu a hlasitost.',
  }[s.level] || '';
  parts.push(lvlText);

  if (s.dropouts && s.dropouts.length) {
    parts.push(`Vrátit se na ${s.dropouts.length} ${czPlural(s.dropouts.length, 'místo', 'místa', 'míst')} — najdeš ${czPlural(s.dropouts.length, 'ho', 'je', 'je')} v grafu níž podle času.`);
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

/* ═══════════════════════════════════════ přehrávač + ukazatel */

let sprGeomRef = null;     // geometrie grafu ringu (z drawSpr) — pro klik a ukazatel
let lastHeadT = -1;        // poslední vykreslený čas, ať se nekreslí pořád totéž

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
  $('c-spr').onclick = onChartClick;
  $('c-spec').onclick = onChartClick;
  updatePlayheadUI();
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

/** Klepnutí do grafu = přeskoč na to místo v nahrávce. */
function onChartClick(e) {
  if (!player) return;
  const cv = e.currentTarget;
  const px = e.clientX - cv.getBoundingClientRect().left;
  let t;
  if (cv.id === 'c-spr') {
    if (!sprGeomRef) return;
    t = sprGeomRef.timeAtX(px);
  } else {
    const w = cv.clientWidth, plotW = w - 42 - 12;
    if (plotW <= 0) return;
    t = ((px - 42) / plotW) * (current.result.duration_s || 1);
  }
  t = Math.max(0, Math.min(t, player.el.duration || current.result.duration_s || 0));
  player.el.currentTime = t;
  // smyčka se váže na tón — po přesunu je potřeba ji přepočítat
  if (player.loopNote) player.loopNote = noteAt(t);
  updatePlayheadUI();
}

/**
 * Překreslí ukazatel (a při přesunu i čísla) podle aktuálního času.
 *
 * Vlastní kresba ukazatele jde do rAF smyčky, protože `timeupdate` chodí jen
 * ~4× za sekundu — s ním by čára poskakovala. rAF se sám zastaví, když se nic
 * nezměnilo (pauza), takže na pozadí nic nežere.
 */
function updatePlayheadUI() {
  if (!player) return;
  const el = player.el;
  const d = el.duration || current?.result?.duration_s || 0;
  const t = el.currentTime || 0;

  const pm = Math.floor(t / 60), ps = Math.floor(t % 60);
  const dm = Math.floor(d / 60), ds = Math.floor(d % 60);
  $('play-time').textContent =
    `${pm}:${String(ps).padStart(2, '0')} / ${dm}:${String(ds).padStart(2, '0')}`;
  if (!player.seeking && d > 0) $('seek').value = String(Math.round((t / d) * 1000));

  paintHeads(t);

  if (!el.paused) {
    cancelAnimationFrame(player.raf);
    player.raf = requestAnimationFrame(() => updatePlayheadUI());
  }
}

/** Vykreslí čáru na oba grafy; přeskočí, když se čas nezměnil. */
function paintHeads(t) {
  if (Math.abs(t - lastHeadT) < 0.004) return;
  lastHeadT = t;
  const s = current?.result?.summary;
  if (s) drawSprHead($('c-spr-head'), current.result.notes, s, t);
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
    L.push(`- Úroveň (proti literatuře): **${s.level}**, SPR medián **${fmt(s.spr_median, 2)} dB** ` +
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
    clearHead($('c-spr-head'), SPR_H);
    clearHead($('c-spec-head'), SPEC_H);
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

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2600);
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
      showToast('Máš nejnovější verzi.');
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
    if (swReg.waiting) {
      const onControl = () => {
        if (reloading) return;
        reloading = true;
        showToast('Aktualizováno, načítám…');
        setTimeout(() => location.reload(), 250);
      };
      navigator.serviceWorker.addEventListener('controllerchange', onControl);
      swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // Nic nečeká na kontrolu (první instalace) — reload může hned.
      reloading = true;
      showToast('Aktualizováno, načítám…');
      setTimeout(() => location.reload(), 250);
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
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
