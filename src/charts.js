/**
 * Vykreslování grafů na canvas — bez závislostí.
 * Tmavě neutrální paleta, žádný glow.
 */

const COL = {
  bg: '#231f1c', grid: '#3a3330', text: '#a89f97', textDim: '#7d746d',
  ok: '#6a9e6a', bad: '#b5675e', accent: '#b8894f', ref: '#6d7f9c',
};

/** Připraví canvas na HiDPI a vrátí kontext + rozměry v CSS px. */
function setup(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const h = cssHeight || canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  return { ctx, w, h };
}

function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

function fmt(v, d = 1) {
  if (v === null || v === undefined || v !== v) return '—';
  return v.toFixed(d);
}

/* ─────────────────────────────────────────── SPR po tónech */

/**
 * Graf ringu. Osa X je ČAS v nahrávce, ne index tónu — jinak se v grafu nedá
 * najít, kde konkrétně se ring ztrácí, a graf je k ničemu.
 */
export function drawSpr(canvas, notes, summary) {
  const H = 230;
  const { ctx, w, h } = setup(canvas, H);
  const padL = 46, padR = 12, padT = 14, padB = 34;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const meas = notes.filter(n => n.spr === n.spr);
  const vals = meas.map(n => n.spr);
  if (!vals.length) {
    ctx.fillStyle = COL.textDim;
    ctx.fillText(summary?.reason || 'Ring nelze měřit', padL, h / 2);
    return;
  }
  let lo = Math.min(...vals, summary.ring_threshold), hi = Math.max(...vals);
  const pad = Math.max(2, (hi - lo) * 0.12);
  lo -= pad; hi += pad;

  const t0 = 0;
  const t1 = Math.max(...notes.map(n => n.t_end), 1);
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  // mřížka + osa Y
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  ctx.fillStyle = COL.text;
  for (const t of niceTicks(lo, hi, 5)) {
    const yy = Math.round(y(t)) + 0.5;
    if (yy < padT || yy > padT + plotH) continue;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillText(t.toFixed(0), 6, yy + 4);
  }
  ctx.fillText('dB', 6, padT - 3);

  // mřížka po čase
  ctx.fillStyle = COL.textDim;
  const tStep = niceTicks(0, t1, 6).filter(v => v > 0);
  for (const tv of tStep) {
    const xx = Math.round(x(tv)) + 0.5;
    if (xx < padL || xx > w - padR) continue;
    ctx.strokeStyle = COL.grid;
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + plotH); ctx.stroke();
    ctx.fillText(fmtClock(tv), xx - 12, h - padB + 14);
  }

  // pásmo ringu (nad hranicí) jemně zvýraznit
  if (summary.ring_threshold > lo) {
    ctx.fillStyle = 'rgba(106,158,106,.07)';
    ctx.fillRect(padL, y(hi), plotW, y(summary.ring_threshold) - y(hi));
  }

  // sloupce: šířka podle skutečné délky tónu, takže mezery v nahrávce jsou vidět
  const bottom = y(lo);
  for (const n of meas) {
    if (n.spr !== n.spr) continue;
    const xa = x(n.t_start), xb = x(n.t_end);
    const bw = Math.max(2, Math.min(18, xb - xa));
    const yy = y(n.spr);
    ctx.fillStyle = n.ring_ok ? COL.ok : COL.bad;
    ctx.fillRect(xa + (xb - xa - bw) / 2, Math.min(yy, bottom), bw, Math.abs(bottom - yy));
  }

  // referenční čáry
  const refLines = [
    [summary.ring_threshold, COL.bad, `hranice ringu ${fmt(summary.ring_threshold)} dB`],
    [-13.1, COL.ref, 'profesionálové −13,1 dB'],
    [-22.7, COL.ref, 'nezpěváci −22,7 dB'],
  ];
  ctx.setLineDash([4, 3]);
  for (const [v, c, label] of refLines) {
    if (v < lo || v > hi) continue;
    const yy = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = c; ctx.beginPath();
    ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
  }
  ctx.setLineDash([]);

  // legenda
  let ly = padT + 10;
  for (const [v, c, label] of refLines) {
    if (v < lo || v > hi) continue;
    ctx.strokeStyle = c; ctx.beginPath();
    ctx.moveTo(w - padR - 150, ly - 4); ctx.lineTo(w - padR - 132, ly - 4); ctx.stroke();
    ctx.fillStyle = COL.textDim;
    ctx.fillText(label, w - padR - 128, ly);
    ly += 13;
  }
}

/** mm:ss z sekund pro popisky osy. */
function fmtClock(t) {
  const m = Math.floor(t / 60), s = Math.round(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ─────────────────────────────────────────── F1:F0 ladění */

export function drawF1(canvas, notes, hintEl) {
  const H = 200;
  const { ctx, w, h } = setup(canvas, H);
  const padL = 42, padR = 12, padT = 14, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const rel = notes.filter(n => n.f1_tuning_relevant && n.f1_f0_err_pct === n.f1_f0_err_pct);
  const nBelow = notes.length - rel.length;

  if (hintEl) {
    hintEl.textContent = rel.length
      ? `Hodnoceno ${rel.length} tónů od G4 výš. ${nBelow} tónů níž se nehodnotí — ` +
        'tam je první formant záměrně vysoko (jiná strategie, ne vada).'
      : 'V této nahrávce není žádný tón od G4 výš, takže ladění F1 nelze hodnotit. ' +
        'Nad G4 se teprve pozná, kde se formant rozpadá.';
  }
  if (!rel.length) {
    ctx.fillStyle = COL.textDim;
    ctx.fillText('Žádný tón od G4 výš — nelze hodnotit', padL, h / 2);
    return;
  }

  const maxV = Math.max(20, ...rel.map(n => Math.min(n.f1_f0_err_pct, 60)));
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  const x = (i) => padL + (rel.length <= 1 ? plotW / 2
    : (i / (rel.length - 1)) * plotW);

  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  ctx.fillStyle = COL.text;
  for (const t of niceTicks(0, maxV, 4)) {
    const yy = Math.round(y(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillText(t.toFixed(0), 6, yy + 4);
  }
  ctx.fillText('%', 6, padT - 3);

  // tolerance
  const yt = Math.round(y(8)) + 0.5;
  ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.accent;
  ctx.beginPath(); ctx.moveTo(padL, yt); ctx.lineTo(w - padR, yt); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COL.textDim;
  ctx.fillText('tolerance 8 %', w - padR - 96, yt - 4);

  const bw = Math.max(3, Math.min(18, plotW / Math.max(1, rel.length) * 0.7));
  rel.forEach((n, i) => {
    const v = Math.min(n.f1_f0_err_pct, 60);
    ctx.fillStyle = n.f1_tuned ? COL.ok : COL.bad;
    ctx.fillRect(x(i) - bw / 2, y(v), bw, padT + plotH - y(v));
    ctx.save();
    ctx.translate(x(i), h - padB + 12);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = COL.textDim;
    ctx.fillText(n.note, 0, 0);
    ctx.restore();
  });
}

/* ─────────────────────────────────────────── Spektrogram */

export function drawSpec(canvas, samples, sampleRate, notes) {
  const H = 300;
  const { ctx, w, h } = setup(canvas, H);
  const padL = 42, padR = 12, padT = 12, padB = 26;
  const plotW = Math.round(w - padL - padR), plotH = Math.round(h - padT - padB);

  const nfft = 1024;
  const hop = Math.max(1, Math.floor(samples.length / plotW));
  const maxHz = 6000;
  const binHz = sampleRate / nfft;
  const maxBin = Math.min(nfft / 2 - 1, Math.ceil(maxHz / binHz));

  // Hannovo okno
  const win = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (nfft - 1));

  // připrav FFT pro každý sloupec
  const img = ctx.createImageData(plotW, plotH);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);

  for (let col = 0; col < plotW; col++) {
    const start = Math.min(samples.length - nfft, col * hop);
    for (let i = 0; i < nfft; i++) { re[i] = (samples[start + i] || 0) * win[i]; im[i] = 0; }
    fftLocal(re, im);
    // převeď na dB a ulož do sloupce
    for (let row = 0; row < plotH; row++) {
      const frac = 1 - row / plotH;
      const bin = Math.min(maxBin, Math.round(frac * maxBin));
      const p = re[bin] * re[bin] + im[bin] * im[bin];
      const db = 10 * Math.log10(p + 1e-20);
      // mapuj -100..-10 dB na 0..255 (teplé tmavé tóny)
      let t = (db + 100) / 90;
      t = Math.max(0, Math.min(1, t));
      const idx = (row * plotW + col) * 4;
      img.data[idx]     = 26 + t * 190;          // R
      img.data[idx + 1] = 22 + t * 130;          // G
      img.data[idx + 2] = 20 + t * 60;           // B
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, padL, padT);

  // pásmo singer's formantu
  const yFor = (hz) => padT + plotH - (hz / maxHz) * plotH;
  ctx.strokeStyle = 'rgba(120,190,190,.45)';
  ctx.setLineDash([4, 3]);
  for (const hz of [2500, 3200]) {
    const yy = Math.round(yFor(hz)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(180,220,220,.8)';
  ctx.fillText("singer's formant 2,5–3,2 kHz", padL + plotW - 168, yFor(3200) - 5);

  // osy
  ctx.fillStyle = COL.text;
  ctx.strokeStyle = COL.grid;
  for (const hz of [0, 1000, 2000, 3000, 4000, 5000, 6000]) {
    const yy = Math.round(yFor(hz)) + 0.5;
    ctx.fillText(String(hz), 6, yy + 4);
  }
  ctx.fillText('Hz', 6, padT - 2);

  // hranice tónů
  const total = samples.length / sampleRate;
  ctx.fillStyle = COL.textDim;
  for (const n of notes) {
    const xx = Math.round(padL + (n.t_start / total) * plotW) + 0.5;
    if (xx < padL || xx > padL + plotW) continue;
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + plotH); ctx.stroke();
  }
  for (let s = 0; s <= total; s += Math.max(1, Math.round(total / 8))) {
    const xx = Math.round(padL + (s / total) * plotW);
    ctx.fillStyle = COL.textDim;
    ctx.fillText(`${s}s`, xx + 2, h - 8);
  }
}

/* ─────────────────────────────────────────── Trend v čase */

export function drawTrend(canvas, rows) {
  const H = 260;
  const { ctx, w, h } = setup(canvas, H);
  const padL = 46, padR = 14, padT = 16, padB = 46;
  const plotW = w - padL - padR;
  const half = (plotW - 24) / 2;

  const use = rows.filter(r => !r.spr_unusable);
  if (!use.length) {
    ctx.fillStyle = COL.textDim;
    ctx.fillText('Žádné měřitelné měření', padL, h / 2);
    return;
  }

  // levý graf: SPR medián v čase
  const vals = use.map(r => r.spr_median);
  let lo = Math.min(...vals, -22), hi = Math.max(...vals, -10);
  const pd = Math.max(2, (hi - lo) * 0.15); lo -= pd; hi += pd;
  const yL = (v) => padT + (h - padT - padB) - ((v - lo) / (hi - lo)) * (h - padT - padB);
  const xL = (i) => padL + (use.length <= 1 ? half / 2 : (i / (use.length - 1)) * half);

  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.fillStyle = COL.text;
  for (const t of niceTicks(lo, hi, 4)) {
    const yy = Math.round(yL(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + half, yy); ctx.stroke();
    ctx.fillText(t.toFixed(0), 6, yy + 4);
  }
  ctx.fillText('SPR dB', 6, padT - 4);

  // pásmo rozptylu
  ctx.fillStyle = 'rgba(184,137,79,.16)';
  ctx.beginPath();
  use.forEach((r, i) => { const yy = yL(Math.min(hi, r.spr_median + r.spr_sd)); i ? ctx.lineTo(xL(i), yy) : ctx.moveTo(xL(i), yy); });
  for (let i = use.length - 1; i >= 0; i--) ctx.lineTo(xL(i), yL(Math.max(lo, use[i].spr_median - use[i].spr_sd)));
  ctx.closePath(); ctx.fill();

  // referenční čáry
  ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.ref;
  for (const [v, lab] of [[-13.1, 'profesionálové'], [-22.7, 'nezpěváci']]) {
    if (v < lo || v > hi) continue;
    const yy = Math.round(yL(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + half, yy); ctx.stroke();
    ctx.fillStyle = COL.textDim; ctx.fillText(lab, padL + 4, yy - 3);
  }
  ctx.setLineDash([]);

  // spojnice
  ctx.strokeStyle = COL.accent; ctx.lineWidth = 2; ctx.beginPath();
  use.forEach((r, i) => { i ? ctx.lineTo(xL(i), yL(r.spr_median)) : ctx.moveTo(xL(i), yL(r.spr_median)); });
  ctx.stroke();
  ctx.fillStyle = COL.accent;
  use.forEach((r, i) => { ctx.beginPath(); ctx.arc(xL(i), yL(r.spr_median), 3.5, 0, 7); ctx.fill(); });

  // pravý graf: % tónů s ringem
  const xR0 = padL + half + 24;
  const yR = (v) => padT + (h - padT - padB) - (v / 100) * (h - padT - padB);
  const xR = (i) => xR0 + (use.length <= 1 ? half / 2 : (i / (use.length - 1)) * half);

  ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text;
  for (const t of [0, 25, 50, 75, 100]) {
    const yy = Math.round(yR(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(xR0, yy); ctx.lineTo(xR0 + half, yy); ctx.stroke();
    ctx.fillText(t + ' %', xR0 - 34, yy + 4);
  }
  ctx.fillText('ring', xR0 - 34, padT - 4);

  const bw = Math.max(4, Math.min(26, half / Math.max(1, use.length) * 0.6));
  use.forEach((r, i) => {
    ctx.fillStyle = COL.ok;
    ctx.fillRect(xR(i) - bw / 2, yR(r.ring_consistency_pct), bw,
      padT + (h - padT - padB) - yR(r.ring_consistency_pct));
  });
  // 100 % cíl
  ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.textDim;
  const y100 = Math.round(yR(100)) + 0.5;
  ctx.beginPath(); ctx.moveTo(xR0, y100); ctx.lineTo(xR0 + half, y100); ctx.stroke();
  ctx.setLineDash([]);
}

/** Lokální FFT (aby modul nezávisel na analysis.js kvůli velikosti). */
function fftLocal(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; const u = im[i]; im[i] = im[j]; im[j] = u; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

export { fmt };
