// Grain detection and pollen level.
//
// This is a classic image-processing detector, not a trained model: it finds small,
// roughly round spots that stand out from the local background and counts them.
// It works best on a clean sticky slide photographed through a clip-on microscope lens
// with even lighting. Phase 2 (pollen type) needs a trained model and is not included.

export const ANALYSIS_DEFAULTS = {
  fieldAreaMm2: 10,   // area of the sample covered by the framing box at your magnification
  lowMax: 50,         // grains per cm² – placeholder until calibrated
  mediumMax: 200,     // grains per cm² – placeholder until calibrated
  minDiamPct: 0.8,    // smallest grain, % of the frame's shorter side
  maxDiamPct: 12,     // largest grain, % of the frame's shorter side
  minSharpness: 15,   // 99.9th percentile of |Laplacian| at 1024 px
  polarity: 'auto',   // 'auto' | 'dark' | 'light'
};

const MAX_ANALYSIS_SIDE = 1024;
const MAX_STORED_GRAINS = 1500;

/**
 * Core detector on raw RGBA pixels. Pure function (no DOM), so it can be tested anywhere.
 */
export function analyzePixels(data, w, h, opts = {}) {
  const o = { ...ANALYSIS_DEFAULTS, ...opts };
  const n = w * h;
  const gray = new Float32Array(n);
  let sum = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const g = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    gray[i] = g;
    sum += g;
  }
  const brightness = sum / n;

  // Sharpness: strength of the crispest edges (99.9th percentile of |Laplacian|).
  // A clean slide is mostly flat background, so an average would call sharp photos blurry.
  const lapHist = new Uint32Array(1025);
  let lc = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]);
      lapHist[Math.min(1024, Math.floor(l))]++;
      lc++;
    }
  }
  let sharpness = 0;
  if (lc) {
    const target = lc * 0.999;
    let run = 0;
    for (let b = 0; b <= 1024; b++) { run += lapHist[b]; if (run >= target) { sharpness = b; break; } }
  }

  const ref = Math.min(w, h);
  const minD = Math.max(2, (o.minDiamPct / 100) * ref);
  const maxD = Math.max(minD + 1, (o.maxDiamPct / 100) * ref);
  const minArea = Math.PI * (minD / 2) ** 2;
  const maxArea = Math.PI * (maxD / 2) ** 2;

  // Local background with a box blur (integral image), larger than the biggest grain.
  const R = Math.max(6, Math.round(maxD * 1.5));
  const W1 = w + 1;
  const integ = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
    }
  }
  const diff = new Float32Array(n);
  const hist = new Uint32Array(512); // |diff| in 0.5 steps, for a robust noise estimate
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1);
      const area = (x1 - x0) * (y1 - y0);
      const s = integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
      const i = y * w + x;
      const d = gray[i] - s / area;
      diff[i] = d;
      hist[Math.min(511, Math.floor(Math.abs(d) * 2))]++;
    }
  }
  // Median absolute deviation → robust noise level (not inflated by the grains themselves).
  let acc = 0, mad = 0;
  for (let b = 0; b < 512; b++) {
    acc += hist[b];
    if (acc >= n / 2) { mad = (b + 0.5) / 2; break; }
  }
  const noise = 1.4826 * mad;
  const threshold = Math.max(12, 3.5 * noise);

  let polarity = o.polarity;
  if (polarity !== 'dark' && polarity !== 'light') {
    let dark = 0, light = 0;
    for (let i = 0; i < n; i++) {
      if (diff[i] < -threshold) dark++;
      else if (diff[i] > threshold) light++;
    }
    polarity = dark >= light ? 'dark' : 'light';
  }
  const sign = polarity === 'dark' ? -1 : 1;

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (sign * diff[i] > threshold) mask[i] = 1;

  // Connected components (8-connected).
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const grains = [];
  let components = 0;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0, area = 0, sx = 0, sy = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const p = stack[--top];
      const px = p % w, py = (p - px) / w;
      area++; sx += px; sy += py;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
        }
      }
    }
    if (area >= 3) components++;
    if (area < minArea || area > maxArea) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const aspect = Math.max(bw, bh) / Math.min(bw, bh);
    if (fill < 0.4 || aspect > 3) continue;
    grains.push({ x: sx / area, y: sy / area, r: Math.sqrt(area / Math.PI) });
  }

  const noisy = components > 1500 || (components > 40 && grains.length / components < 0.1);
  return { grains, grainCount: grains.length, components, brightness, sharpness, noise, polarity, noisy };
}

export function assessQuality(r, opts = {}) {
  const o = { ...ANALYSIS_DEFAULTS, ...opts };
  if (r.brightness < 35) return { ok: false, reason: 'Too dark – add light or turn on the flashlight.' };
  if (r.brightness > 235) return { ok: false, reason: 'Too bright – the photo is overexposed.' };
  if (r.sharpness < o.minSharpness) return { ok: false, reason: 'Too blurry – hold steady and refocus.' };
  if (r.noisy) return { ok: false, reason: 'Too much texture or dust to count grains reliably – try a cleaner area.' };
  return { ok: true, reason: 'Looks good – sharp and well lit.' };
}

/** Turn a raw count into a level using the current thresholds. */
export function computeResult(analysis, opts = {}) {
  const o = { ...ANALYSIS_DEFAULTS, ...opts };
  const areaCm2 = Math.max(0.0001, o.fieldAreaMm2 / 100);
  const grainsPerCm2 = analysis.grainCount / areaCm2;
  let confidence = 'High';
  if (!analysis.quality.ok) confidence = 'Low';
  else if (analysis.sharpness < 2 * o.minSharpness) confidence = 'Medium';
  let level;
  if (confidence === 'Low') level = 'Unclear';
  else if (grainsPerCm2 <= o.lowMax) level = 'Low';
  else if (grainsPerCm2 <= o.mediumMax) level = 'Medium';
  else level = 'High';
  return {
    level,
    confidence,
    grainCount: analysis.grainCount,
    grainsPerCm2: Math.round(grainsPerCm2 * 10) / 10,
    dominantType: null,  // Phase 2
    breakdown: null,     // Phase 2
    settingsUsed: { fieldAreaMm2: o.fieldAreaMm2, lowMax: o.lowMax, mediumMax: o.mediumMax },
  };
}

/** Browser wrapper: decode, crop to the framing box, scale down, detect. */
export async function analyzeImage(blob, crop, opts = {}) {
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.round(c.x * W), sy = Math.round(c.y * H);
  const sw = Math.max(1, Math.round(c.w * W)), sh = Math.max(1, Math.round(c.h * H));
  const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  const r = analyzePixels(data, w, h, opts);
  const minSide = Math.min(W, H);
  const grains = r.grains.slice(0, MAX_STORED_GRAINS).map((g) => ({
    x: (sx + g.x / scale) / W,
    y: (sy + g.y / scale) / H,
    r: g.r / scale / minSide,
  }));
  const analysis = {
    width: W, height: H, crop: c,
    grainCount: r.grainCount, grains,
    brightness: Math.round(r.brightness), sharpness: Math.round(r.sharpness * 10) / 10,
    polarity: r.polarity, noisy: r.noisy,
  };
  analysis.quality = assessQuality(analysis, opts);
  return analysis;
}

export async function makeThumbnail(blob, size = 160) {
  const bmp = await createImageBitmap(blob);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  if (bmp.close) bmp.close();
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
}
