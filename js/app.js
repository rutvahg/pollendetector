import * as db from './db.js';
import * as cam from './camera.js';
import { analyzeImage, computeResult, makeThumbnail, ANALYSIS_DEFAULTS } from './analysis.js';
import * as sync from './sync.js';
import * as forecast from './forecast.js';

const APP_VERSION = '0.1.0';
const GUIDE_FRACTION = 0.7;
const FORECAST_MAX_AGE_MIN = 60;

const DEFAULTS = {
  // sync
  syncUrl: '', syncSecret: '', autoSync: true, includePhotos: true, includeLocation: false,
  lastSyncAt: null, connectionOk: null, lastSyncError: '', folderUrl: '', sheetUrl: '',
  // forecast
  forecastEnabled: false, forecastKey: '', forecastCache: null,
  // camera
  cameraGranted: false,
  // analysis
  ...ANALYSIS_DEFAULTS,
};

let settings = { ...DEFAULTS };
let pending = null;          // photo waiting on the review screen
let current = { view: 'capture', arg: null };
let syncRunning = false;
let objectUrls = { history: [], result: [], review: [] };

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

function svg(path, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = path; // static, trusted icon paths only
  return s;
}
const ICON_CLOUD_OK = '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12.5 3.5 3.5 0 0 0 6 19z"/><path d="M9 14l2 2 4-4"/>';
const ICON_CLOUD = '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12.5 3.5 3.5 0 0 0 6 19z"/>';
const ICON_CHECK = '<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>';
const ICON_ALERT = '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>';

function revoke(group) {
  objectUrls[group].forEach((u) => URL.revokeObjectURL(u));
  objectUrls[group] = [];
}
function objectUrl(group, blob) {
  const u = URL.createObjectURL(blob);
  objectUrls[group].push(u);
  return u;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function confirmDialog(title, text, okLabel = 'Delete') {
  const d = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  if (typeof d.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.returnValue = '';
    d.showModal();
  });
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`;
}
function fmtTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : fmtWhen(iso);
}

async function saveSettings(patch) {
  Object.assign(settings, patch);
  await db.setSetting('app', settings);
}

function syncLabel(entry) {
  const s = entry.sync?.status || 'not_synced';
  if (s === 'synced') return { text: '✓ Synced', cls: 's-synced' };
  if (s === 'waiting') return { text: '↻ Waiting to sync', cls: 's-waiting' };
  if (s === 'failed') return { text: '! Sync failed', cls: 's-failed' };
  return { text: 'Not synced', cls: 's-none' };
}

// ---------- routing ----------
const VIEWS = ['capture', 'review', 'result', 'history', 'settings'];
const TAB_VIEWS = ['capture', 'history', 'settings'];

function route() {
  const m = (location.hash || '#/capture').match(/^#\/([a-z]+)(?:\/(.+))?$/);
  let view = m && VIEWS.includes(m[1]) ? m[1] : 'capture';
  const arg = m ? m[2] || null : null;
  if (view === 'review' && !pending) { location.replace('#/capture'); return; }

  if (current.view === 'capture' && view !== 'capture') stopCamera();
  if (current.view === 'result' && view !== 'result') revoke('result');
  current = { view, arg };

  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.body.classList.toggle('no-tabbar', !TAB_VIEWS.includes(view));
  document.querySelectorAll('#tabbar a').forEach((a) => {
    if (a.dataset.tab === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);

  if (view === 'capture') showCapture();
  else if (view === 'review') showReview();
  else if (view === 'result') showResult(arg);
  else if (view === 'history') renderHistory();
  else if (view === 'settings') renderSettings();
}

// ---------- capture ----------
function setCameraState(state, info = {}) {
  const live = state === 'live';
  $('#video').hidden = !live;
  $('#guide').hidden = !live;
  $('#guide-text').hidden = !live;
  $('#live-tag').hidden = !live;
  $('#camera-start').hidden = state !== 'idle';
  $('#camera-error').hidden = state !== 'error';
  $('#shutter').disabled = !live;
  const torch = $('#torch');
  torch.style.visibility = live && info.torch ? 'visible' : 'hidden';
  torch.setAttribute('aria-pressed', 'false');
  $('#torch-caption').hidden = !(live && info.torch);
  if (live) sizeGuide();
}

function sizeGuide() {
  const vp = $('#viewport');
  const side = Math.min(vp.clientWidth, vp.clientHeight) * GUIDE_FRACTION;
  const g = $('#guide');
  g.style.width = `${side}px`;
  g.style.height = `${side}px`;
}

function cameraHelpSteps() {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) return [
    'In Safari, tap the aA button in the address bar, then Website Settings › Camera › Allow.',
    'Or open the Settings app › Apps › Safari › Camera and choose Ask or Allow.',
    'Come back here and tap Try again.',
  ];
  if (/Android/.test(ua)) return [
    'Tap the icon to the left of the address bar.',
    'Choose Permissions (or Site settings) › Camera › Allow.',
    'Come back here and tap Try again.',
  ];
  return [
    'Click the icon to the left of the address bar.',
    'Set Camera to Allow for this site.',
    'Click Try again.',
  ];
}

function showCameraError(kind) {
  const title = $('#camera-error-title');
  const text = $('#camera-error-text');
  const help = $('#camera-help');
  help.replaceChildren();
  if (kind === 'NotAllowedError' || kind === 'PermissionDeniedError') {
    title.textContent = 'Camera access is off';
    text.textContent = 'Pollen Check needs the camera to photograph your sample. To turn it on:';
    cameraHelpSteps().forEach((s) => help.append(el('li', { text: s })));
  } else if (kind === 'insecure') {
    title.textContent = 'This page needs HTTPS';
    text.textContent = 'Browsers only allow the camera on secure (https://) pages. Open the app from its https:// address.';
  } else if (kind === 'unsupported') {
    title.textContent = 'Live camera not supported';
    text.textContent = "This browser can't show a live camera here. You can still upload a photo or take one with your phone's camera app.";
  } else if (kind === 'NotReadableError' || kind === 'TrackStartError') {
    title.textContent = 'Camera is busy';
    text.textContent = 'Another app may be using the camera. Close it and try again.';
  } else {
    title.textContent = 'No camera found';
    text.textContent = "We couldn't find a camera on this device. You can still upload a photo.";
  }
  setCameraState('error');
}

async function startCamera() {
  if (!window.isSecureContext) return showCameraError('insecure');
  if (!cam.cameraSupported()) return showCameraError('unsupported');
  try {
    const caps = await cam.startCamera($('#video'));
    if (current.view !== 'capture') { cam.stopCamera(); return; }
    setCameraState('live', caps);
    if (!settings.cameraGranted) saveSettings({ cameraGranted: true });
  } catch (err) {
    showCameraError(err && err.name);
  }
}

function stopCamera() {
  cam.stopCamera();
  $('#video').srcObject = null;
  setCameraState('idle');
}

function showCapture() {
  if (cam.isRunning()) return;
  setCameraState('idle');
  if (settings.cameraGranted) startCamera();
  updateForecastChip();
}

async function updateForecastChip() {
  const chip = $('#forecast-chip');
  if (!settings.forecastEnabled || !settings.forecastKey) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = 'Area forecast…';
  try {
    const f = await getForecast();
    chip.textContent = f.level ? `Area forecast: ${f.level}` : 'Area forecast: no data';
  } catch {
    chip.textContent = 'Area forecast unavailable';
  }
}

async function getForecast(knownLocation) {
  const loc = knownLocation || await forecast.getLocation();
  const c = settings.forecastCache;
  const fresh = c && (Date.now() - Date.parse(c.data.fetchedAt)) < FORECAST_MAX_AGE_MIN * 60000
    && Math.abs(c.lat - loc.lat) < 0.05 && Math.abs(c.lng - loc.lng) < 0.05;
  if (fresh) return c.data;
  const data = await forecast.fetchForecast(settings.forecastKey, loc.lat, loc.lng);
  await saveSettings({ forecastCache: { lat: loc.lat, lng: loc.lng, data } });
  return data;
}

async function takePicture() {
  const shutter = $('#shutter');
  shutter.disabled = true;
  try {
    const { blob, crop, lowRes } = await cam.capturePhoto($('#video'), GUIDE_FRACTION);
    await prepareReview(blob, crop, 'camera', lowRes);
  } catch (err) {
    toast(`Couldn't take the picture: ${err.message}`);
  } finally {
    shutter.disabled = !cam.isRunning();
  }
}

async function onFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image file.'); return; }
  try {
    await prepareReview(file, null, 'upload', false);
  } catch (err) {
    toast(`Couldn't open that photo: ${err.message}`);
  }
}

async function prepareReview(blob, crop, source, lowRes) {
  toast('Checking photo…');
  const analysis = await analyzeImage(blob, crop, settings);
  pending = { blob, crop, source, lowRes, analysis };
  $('#toast').hidden = true;
  location.hash = '#/review';
}

// ---------- review ----------
function showReview() {
  revoke('review');
  $('#review-img').src = objectUrl('review', pending.blob);
  const q = pending.analysis.quality;
  const box = $('#review-quality');
  box.textContent = q.reason;
  box.className = `notice ${q.ok ? 'ok' : 'bad'}`;
  $('#review-lowres').hidden = !pending.lowRes;
  const analyze = $('#analyze');
  analyze.textContent = q.ok ? 'Analyze' : 'Analyze anyway';
  analyze.className = `btn ${q.ok ? 'btn-primary' : 'btn-secondary'}`;
  $('#retake').className = `btn ${q.ok ? 'btn-secondary' : 'btn-primary'}`;
}

async function saveAnalysis() {
  if (!pending) return;
  const btn = $('#analyze');
  btn.disabled = true;
  try {
    const { blob, crop, source, analysis } = pending;
    const photo = blob.type === 'image/jpeg' ? blob : await reencodeJpeg(blob);
    const entry = {
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      source,
      photo,
      thumb: await makeThumbnail(photo),
      width: analysis.width,
      height: analysis.height,
      crop: crop || null,
      grains: analysis.grains,
      quality: analysis.quality,
      sharpness: analysis.sharpness,
      brightness: analysis.brightness,
      result: computeResult(analysis, settings),
      location: null,
      forecast: null,
      sync: { status: 'not_synced', attempts: 0 },
    };
    await db.putEntry(entry);
    pending = null;
    revoke('review');
    requestPersistentStorage();
    location.hash = `#/result/${entry.id}`;
    afterSave(entry.id);
  } catch (err) {
    toast(`Couldn't save the result: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function reencodeJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
}

async function afterSave(id) {
  const entry = await db.getEntry(id);
  if (!entry) return;
  const wantForecast = settings.forecastEnabled && settings.forecastKey;
  if (settings.includeLocation || wantForecast) {
    try {
      const loc = await forecast.getLocation();
      if (settings.includeLocation) entry.location = loc;
      if (wantForecast) {
        try { entry.forecast = await getForecast(loc); } catch { /* forecast optional */ }
      }
    } catch { /* location optional */ }
  }
  if (sync.isConfigured(settings) && settings.autoSync) entry.sync = { status: 'waiting', attempts: 0 };
  await db.putEntry(entry);
  if (current.view === 'result' && current.arg === id) {
    renderResultExtras(entry);
  }
  if (entry.sync.status === 'waiting') runSync({ ids: [id] });
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* optional */ }
}

// ---------- result ----------
async function showResult(id) {
  const entry = id && await db.getEntry(id);
  if (!entry) { toast('That sample was not found.'); location.replace('#/history'); return; }
  revoke('result');
  const r = entry.result;
  $('#result-when').textContent = `${fmtWhen(entry.capturedAt)} · ${entry.source === 'upload' ? 'Uploaded photo' : 'Camera'}`;

  const card = $('#level-card');
  card.dataset.level = r.level;
  $('#level-text').textContent = r.level;
  const note = $('#level-note');
  if (r.level === 'Unclear') {
    note.hidden = false;
    note.textContent = `${entry.quality?.reason || 'The photo was hard to read.'} Try a new photo.`;
  } else {
    note.hidden = true;
  }
  $('#count-chip').textContent = `${r.grainCount} grains · ${Math.round(r.grainsPerCm2)} per cm²`;
  $('#conf-chip').textContent = `Confidence: ${r.confidence}`;

  const dl = $('#download-photo');
  dl.href = objectUrl('result', entry.photo);
  dl.download = `pollen_${entry.capturedAt.slice(0, 19).replace(/[:T]/g, '-')}.jpg`;

  await drawResultPhoto(entry);
  renderResultExtras(entry);
}

async function drawResultPhoto(entry) {
  const canvas = $('#result-canvas');
  const bmp = await createImageBitmap(entry.photo);
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  if (!$('#show-grains').checked) return;
  const W = canvas.width, H = canvas.height, minSide = Math.min(W, H);
  const lw = Math.max(2, minSide / 300);
  if (entry.crop) {
    ctx.setLineDash([lw * 4, lw * 3]);
    ctx.strokeStyle = 'rgba(242,245,238,0.9)';
    ctx.lineWidth = lw;
    ctx.strokeRect(entry.crop.x * W, entry.crop.y * H, entry.crop.w * W, entry.crop.h * H);
    ctx.setLineDash([]);
  }
  // Dark outline under a yellow ring, so circles show on light and dark backgrounds.
  for (const [color, width] of [['rgba(20,24,19,0.85)', lw * 2.6], ['#FFD21F', lw * 1.3]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const g of entry.grains || []) {
      ctx.beginPath();
      ctx.arc(g.x * W, g.y * H, Math.max(g.r * minSide * 1.6, lw * 4), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function renderResultExtras(entry) {
  const fRow = $('#result-forecast');
  if (entry.forecast && entry.forecast.label) {
    fRow.hidden = false;
    $('#result-forecast-value').textContent = entry.forecast.label;
  } else {
    fRow.hidden = true;
  }

  const row = $('#result-sync');
  row.hidden = false;
  row.replaceChildren();
  const status = entry.sync?.status || 'not_synced';
  if (!sync.isConfigured(settings) && status !== 'synced') {
    row.append(
      el('span', { class: 'sync-label s-none' }, svg(ICON_CLOUD), 'Back up to Google Drive'),
      el('a', { class: 'btn btn-secondary', href: '#/settings', text: 'Set up' }),
    );
    return;
  }
  const lab = syncLabel(entry);
  if (status === 'synced') {
    row.append(el('span', { class: 'sync-label s-synced' }, svg(ICON_CLOUD_OK), 'Synced to Drive & Sheet'));
    const link = settings.sheetUrl || entry.sync.photoUrl;
    if (link) row.append(el('a', { class: 'text-btn', href: link, target: '_blank', rel: 'noopener', text: settings.sheetUrl ? 'View in Sheet' : 'View photo' }));
  } else if (status === 'waiting') {
    row.append(el('span', { class: `sync-label ${lab.cls}` }, svg(ICON_CLOUD), syncRunning ? 'Syncing…' : 'Waiting to sync'));
  } else {
    const text = status === 'failed' ? (entry.sync.lastError || 'Sync failed') : 'Not synced yet';
    row.append(
      el('span', { class: `sync-label ${lab.cls}` }, svg(status === 'failed' ? ICON_ALERT : ICON_CLOUD), text),
      el('button', {
        class: 'btn btn-secondary', type: 'button', text: status === 'failed' ? 'Retry' : 'Sync',
        onclick: async () => {
          entry.sync = { ...entry.sync, status: 'waiting', nextAttemptAt: null };
          await db.putEntry(entry);
          renderResultExtras(entry);
          runSync({ ids: [entry.id] });
        },
      }),
    );
  }
}

async function deleteCurrentResult() {
  const entry = current.arg && await db.getEntry(current.arg);
  if (!entry) return;
  const extra = entry.sync?.status === 'synced' ? ' Its photo and Sheet row stay in your Google account.' : '';
  const ok = await confirmDialog('Delete this sample?', `It will be removed from this phone.${extra}`);
  if (!ok) return;
  await db.deleteEntry(entry.id);
  toast('Sample deleted.');
  location.hash = '#/history';
}

// ---------- history ----------
async function renderHistory() {
  revoke('history');
  const entries = await db.allEntries();
  const list = $('#history-list');
  list.replaceChildren();
  $('#history-empty').hidden = entries.length > 0;
  $('#clear-all').hidden = entries.length === 0;
  const showSync = sync.isConfigured(settings);

  for (const e of entries) {
    const r = e.result;
    const lab = syncLabel(e);
    const thumb = e.thumb
      ? el('img', { src: objectUrl('history', e.thumb), alt: '' })
      : el('div', { class: 'thumb-ph', 'aria-hidden': 'true' });
    list.append(el('li', { class: 'history-item' },
      el('a', { href: `#/result/${e.id}` },
        thumb,
        el('div', { class: 'meta' },
          el('span', { class: 'date', text: fmtWhen(e.capturedAt) }),
          el('span', { class: 'type', text: `${r.grainCount} grains · ${Math.round(r.grainsPerCm2)} per cm²` }),
          (showSync || e.sync?.status === 'synced') ? el('span', { class: `sync-state ${lab.cls}`, text: lab.text }) : null,
        ),
        el('span', { class: `pill pill-${r.level}`, text: r.level }),
      ),
    ));
  }
  renderSyncBar(entries);
}

function renderSyncBar(entries) {
  const bar = $('#sync-bar');
  bar.replaceChildren();
  if (!sync.isConfigured(settings)) {
    bar.append(
      el('div', { class: 'left' }, svg(ICON_CLOUD, 24),
        el('div', {}, el('strong', { text: 'Back up to Google Drive & Sheets' }), el('small', { text: 'Optional – set up once in Settings' }))),
      el('a', { class: 'btn btn-secondary', href: '#/settings', text: 'Set up' }),
    );
    return;
  }
  const waiting = entries.filter((e) => e.sync?.status !== 'synced').length;
  const btn = el('button', {
    class: 'btn btn-primary', type: 'button', text: syncRunning ? 'Syncing…' : 'Sync now',
    disabled: syncRunning || waiting === 0,
    onclick: () => manualSync(btn),
  });
  bar.append(
    el('div', { class: 'left' }, svg(ICON_CLOUD_OK, 24),
      el('div', {}, el('strong', { text: 'Google Drive & Sheets' }),
        el('small', { text: `Last synced ${fmtTime(settings.lastSyncAt)} · ${waiting} waiting` }))),
    btn,
  );
}

async function clearAll() {
  const ok = await confirmDialog('Clear all history?',
    'Every sample will be removed from this phone. Anything already synced stays in your Google Drive and Sheet.', 'Clear all');
  if (!ok) return;
  await db.clearEntries();
  toast('History cleared.');
  renderHistory();
}

// ---------- sync engine ----------
async function runSync({ force = false, ids = null, onProgress } = {}) {
  if (syncRunning || !sync.isConfigured(settings)) return null;
  syncRunning = true;
  refreshSyncViews();
  const summary = { synced: 0, failed: 0, total: 0, lastError: null };
  try {
    const entries = await db.allEntries();
    const now = Date.now();
    const todo = entries.filter((e) => {
      const s = e.sync || {};
      if (s.status === 'synced') return false;
      if (ids) return ids.includes(e.id);
      if (force) return true;
      return s.status === 'waiting' && (!s.nextAttemptAt || Date.parse(s.nextAttemptAt) <= now);
    }).reverse(); // oldest first
    summary.total = todo.length;
    for (let i = 0; i < todo.length; i++) {
      if (onProgress) onProgress(i + 1, todo.length);
      const res = await sync.syncOne(todo[i], settings, APP_VERSION, db.putEntry);
      if (res.ok) {
        summary.synced++;
        await saveSettings({ lastSyncAt: new Date().toISOString(), connectionOk: true, lastSyncError: '' });
      } else {
        summary.failed++;
        summary.lastError = res.error;
        if (['unauthorized', 'bad_url', 'not_found'].includes(res.error.code)) {
          await saveSettings({ connectionOk: false, lastSyncError: res.error.message });
          break;
        }
        if (res.error.code === 'offline') break;
      }
    }
  } finally {
    syncRunning = false;
    refreshSyncViews();
  }
  return summary;
}

function runAutoSync() {
  if (settings.autoSync && navigator.onLine) runSync();
}

async function manualSync(button) {
  if (!navigator.onLine) { toast("You're offline. Sync will run when you're back online."); return; }
  const label = button.textContent;
  button.disabled = true;
  const summary = await runSync({ force: true, onProgress: (i, n) => { button.textContent = `Syncing ${i} of ${n}…`; } });
  button.textContent = label;
  button.disabled = false;
  if (!summary) return;
  if (!summary.total) toast('Everything is already synced.');
  else if (!summary.failed) toast(`Synced ${summary.synced} sample${summary.synced === 1 ? '' : 's'}.`);
  else toast(`Synced ${summary.synced} of ${summary.total}. ${summary.lastError ? summary.lastError.message : ''}`);
}

async function refreshSyncViews() {
  if (current.view === 'history') renderHistory();
  else if (current.view === 'settings') renderSyncStatus();
  else if (current.view === 'result' && current.arg) {
    const e = await db.getEntry(current.arg);
    if (e) renderResultExtras(e);
  }
}

// ---------- settings ----------
async function renderSettings() {
  $('#sync-url').value = settings.syncUrl;
  $('#sync-secret').value = settings.syncSecret;
  $('#auto-sync').checked = settings.autoSync;
  $('#include-photos').checked = settings.includePhotos;
  $('#include-location').checked = settings.includeLocation;
  $('#forecast-enabled').checked = settings.forecastEnabled;
  $('#forecast-key').value = settings.forecastKey;
  $('#field-area').value = settings.fieldAreaMm2;
  $('#min-sharpness').value = settings.minSharpness;
  $('#low-max').value = settings.lowMax;
  $('#medium-max').value = settings.mediumMax;
  $('#min-diam').value = settings.minDiamPct;
  $('#max-diam').value = settings.maxDiamPct;
  $('#polarity').value = settings.polarity;
  $('#test-result').textContent = '';
  renderSyncStatus();
  renderStorageStatus();
}

async function renderSyncStatus() {
  const card = $('#sync-status');
  card.replaceChildren();
  const entries = await db.allEntries();
  const waiting = entries.filter((e) => e.sync?.status !== 'synced').length;
  let cls = '', icon = ICON_CLOUD, title, detail;
  if (!sync.isConfigured(settings)) {
    title = 'Not set up';
    detail = 'Paste your Apps Script URL and secret key below.';
  } else if (settings.connectionOk === false) {
    cls = 'bad'; icon = ICON_ALERT; title = "Can't connect";
    detail = settings.lastSyncError || 'Check the URL and secret key.';
  } else if (settings.connectionOk === true) {
    cls = 'ok'; icon = ICON_CHECK; title = 'Connected';
    detail = `Last synced ${fmtTime(settings.lastSyncAt)} · ${waiting} waiting`;
  } else {
    title = 'Not tested yet';
    detail = 'Tap Test connection to check the setup.';
  }
  card.className = `status-card ${cls}`;
  card.append(svg(icon, 28), el('div', {}, el('strong', { text: title }), el('span', { text: detail })));
  const syncBtn = $('#sync-now');
  syncBtn.disabled = !sync.isConfigured(settings) || syncRunning;
  if (!syncRunning) syncBtn.textContent = waiting ? `Sync now (${waiting} waiting)` : 'Sync now';
  const links = $('#google-links');
  links.hidden = !(settings.folderUrl || settings.sheetUrl);
  $('#open-folder').href = settings.folderUrl || '#';
  $('#open-folder').hidden = !settings.folderUrl;
  $('#open-sheet').href = settings.sheetUrl || '#';
  $('#open-sheet').hidden = !settings.sheetUrl;
}

async function renderStorageStatus() {
  const p = $('#storage-status');
  const parts = [];
  try {
    if (navigator.storage && navigator.storage.persisted) {
      parts.push(await navigator.storage.persisted()
        ? 'History is protected from automatic clearing.'
        : 'The browser may clear history if space runs low or the app goes unused. Adding the app to your home screen helps.');
    }
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.usage != null) parts.push(`Using about ${(est.usage / 1048576).toFixed(1)} MB.`);
    }
  } catch { /* optional */ }
  const count = (await db.allEntries()).length;
  parts.unshift(`${count} sample${count === 1 ? '' : 's'} saved on this phone.`);
  p.textContent = parts.join(' ');
}

function bindSettings() {
  $('#sync-url').addEventListener('change', (e) => {
    saveSettings({ syncUrl: e.target.value.trim(), connectionOk: null, lastSyncError: '' }).then(renderSyncStatus);
  });
  $('#sync-secret').addEventListener('change', (e) => {
    saveSettings({ syncSecret: e.target.value.trim(), connectionOk: null, lastSyncError: '' }).then(renderSyncStatus);
  });
  $('#auto-sync').addEventListener('change', (e) => saveSettings({ autoSync: e.target.checked }));
  $('#include-photos').addEventListener('change', (e) => saveSettings({ includePhotos: e.target.checked }));
  $('#include-location').addEventListener('change', async (e) => {
    if (e.target.checked) {
      try { await forecast.getLocation(); } catch (err) {
        e.target.checked = false;
        toast(err.message);
        return;
      }
    }
    saveSettings({ includeLocation: e.target.checked });
  });
  $('#forecast-enabled').addEventListener('change', async (e) => {
    if (e.target.checked) {
      try { await forecast.getLocation(); } catch (err) {
        e.target.checked = false;
        toast(err.message);
        return;
      }
      if (!settings.forecastKey) toast('Add your Google Pollen API key below.');
    }
    saveSettings({ forecastEnabled: e.target.checked, forecastCache: null });
  });
  $('#forecast-key').addEventListener('change', (e) => saveSettings({ forecastKey: e.target.value.trim(), forecastCache: null }));

  $('#test-connection').addEventListener('click', async () => {
    const out = $('#test-result');
    const btn = $('#test-connection');
    await saveSettings({ syncUrl: $('#sync-url').value.trim(), syncSecret: $('#sync-secret').value.trim() });
    btn.disabled = true;
    out.className = 'status-text';
    out.textContent = 'Testing…';
    try {
      const data = await sync.testConnection(settings.syncUrl, settings.syncSecret);
      await saveSettings({ connectionOk: true, lastSyncError: '', folderUrl: data.folderUrl || '', sheetUrl: data.sheetUrl || '' });
      out.className = 'status-text ok';
      out.textContent = 'Works';
    } catch (err) {
      await saveSettings({ connectionOk: false, lastSyncError: err.message });
      out.className = 'status-text bad';
      out.textContent = err.message;
    } finally {
      btn.disabled = false;
      renderSyncStatus();
    }
  });
  $('#sync-now').addEventListener('click', (e) => manualSync(e.currentTarget));

  const num = (id, key, { min = 0 } = {}) => {
    $(id).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v < min) { e.target.value = settings[key]; toast('Please enter a valid number.'); return; }
      if (key === 'lowMax' && v >= settings.mediumMax) { e.target.value = settings[key]; toast('Low must be smaller than Medium.'); return; }
      if (key === 'mediumMax' && v <= settings.lowMax) { e.target.value = settings[key]; toast('Medium must be larger than Low.'); return; }
      if (key === 'minDiamPct' && v >= settings.maxDiamPct) { e.target.value = settings[key]; toast('Smallest grain must be smaller than largest.'); return; }
      if (key === 'maxDiamPct' && v <= settings.minDiamPct) { e.target.value = settings[key]; toast('Largest grain must be bigger than smallest.'); return; }
      saveSettings({ [key]: v });
    });
  };
  num('#field-area', 'fieldAreaMm2', { min: 0.01 });
  num('#min-sharpness', 'minSharpness');
  num('#low-max', 'lowMax');
  num('#medium-max', 'mediumMax');
  num('#min-diam', 'minDiamPct', { min: 0.05 });
  num('#max-diam', 'maxDiamPct', { min: 0.1 });
  $('#polarity').addEventListener('change', (e) => saveSettings({ polarity: e.target.value }));
  $('#reset-analysis').addEventListener('click', async () => {
    await saveSettings({ ...ANALYSIS_DEFAULTS });
    renderSettings();
    toast('Analysis settings reset.');
  });

  $('#export-history').addEventListener('click', async () => {
    const entries = await db.allEntries();
    const data = entries.map(({ photo, thumb, ...rest }) => rest);
    const blob = new Blob([JSON.stringify({ app: 'Pollen Check', version: APP_VERSION, exportedAt: new Date().toISOString(), entries: data }, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `pollen-history-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
}

// ---------- wiring ----------
function bindCapture() {
  $('#start-camera').addEventListener('click', startCamera);
  $('#retry-camera').addEventListener('click', startCamera);
  $('#shutter').addEventListener('click', takePicture);
  $('#upload-btn').addEventListener('click', () => $('#file-input').click());
  $('#error-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', onFileChosen);
  $('#torch').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    if (await cam.setTorch(on)) btn.setAttribute('aria-pressed', String(on));
    else toast("The flashlight isn't available in this browser.");
  });
  window.addEventListener('resize', () => { if (cam.isRunning()) sizeGuide(); });
}

function bindReview() {
  $('#retake').addEventListener('click', () => { pending = null; revoke('review'); location.hash = '#/capture'; });
  $('#analyze').addEventListener('click', saveAnalysis);
}

function bindResult() {
  $('#result-delete').addEventListener('click', deleteCurrentResult);
  $('#show-grains').addEventListener('change', async () => {
    const e = current.arg && await db.getEntry(current.arg);
    if (e) drawResultPhoto(e);
  });
}

function bindHistory() {
  $('#clear-all').addEventListener('click', clearAll);
}

async function init() {
  try {
    const stored = await db.getSetting('app', null);
    if (stored) settings = { ...DEFAULTS, ...stored };
  } catch (err) {
    toast("This browser can't save data here (private browsing?). History won't be kept.");
  }
  $('#app-version').textContent = APP_VERSION;
  bindCapture(); bindReview(); bindResult(); bindHistory(); bindSettings();

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (cam.isRunning()) stopCamera();
    } else {
      if (current.view === 'capture' && settings.cameraGranted) startCamera();
      runAutoSync();
    }
  });
  window.addEventListener('online', runAutoSync);
  setInterval(() => { if (!document.hidden) runAutoSync(); }, 60000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline mode unavailable */ });
  }
  route();
  runAutoSync();
}

init();
