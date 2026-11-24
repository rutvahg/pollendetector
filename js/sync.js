// Sync samples to your own Google Drive folder and Google Sheet through an Apps Script web app.

const RETRY_MINUTES = [1, 5, 30, 120];
const MAX_TRANSIENT_ATTEMPTS = 6;
const PERMANENT = new Set(['unauthorized', 'bad_url', 'not_found', 'bad_request']);

export class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function isConfigured(s) {
  return !!(s.syncUrl && s.syncSecret);
}

export function validateUrl(url) {
  const ok = /^https:\/\/script\.google\.com\/(macros|a\/macros\/[^/]+)\/s\/[A-Za-z0-9_-]+\/exec$/.test((url || '').trim());
  if (!ok) throw new SyncError('bad_url', 'The URL should look like https://script.google.com/macros/s/…/exec');
}

async function post(url, body) {
  let res;
  try {
    // text/plain keeps this a "simple" request, so the browser skips the CORS pre-check
    // that Apps Script can't answer.
    res = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch {
    if (!navigator.onLine) throw new SyncError('offline', "You're offline – will retry.");
    throw new SyncError('unreachable', "Couldn't reach the script. Check the URL and that it's deployed with access set to Anyone.");
  }
  if (res.status === 404) throw new SyncError('not_found', 'Script URL not found – check the deployment.');
  let data;
  try { data = await res.json(); } catch {
    throw new SyncError('bad_response', "The script didn't answer with JSON. Make sure the URL ends in /exec and the latest version is deployed.");
  }
  if (!data || !data.ok) {
    if (data && data.error === 'unauthorized') throw new SyncError('unauthorized', 'Wrong secret key.');
    throw new SyncError((data && data.error) || 'server_error', (data && data.message) || 'The script reported an error.');
  }
  return data;
}

export async function testConnection(url, secret) {
  validateUrl(url);
  if (!secret) throw new SyncError('unauthorized', 'Enter the secret key first.');
  return post(url, { action: 'ping', secret });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export async function shrinkToBase64(blob, maxSide = 2048, quality = 0.8) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const out = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
  return blobToBase64(out);
}

async function buildPayload(entry, settings, appVersion) {
  const r = entry.result || {};
  const payload = {
    action: 'sync',
    secret: settings.syncSecret,
    id: entry.id,
    capturedAt: entry.capturedAt,
    source: entry.source,
    level: r.level,
    grainCount: r.grainCount,
    grainsPerCm2: r.grainsPerCm2,
    confidence: r.confidence,
    dominantType: r.dominantType || '',
    breakdown: r.breakdown || null,
    appVersion,
  };
  if (settings.includeLocation && entry.location) {
    payload.lat = entry.location.lat;
    payload.lng = entry.location.lng;
  }
  if (settings.includePhotos && entry.photo) {
    payload.photo = await shrinkToBase64(entry.photo);
  }
  return payload;
}

/** Sync one entry; saves the new sync status with `save(entry)`. Never throws. */
export async function syncOne(entry, settings, appVersion, save) {
  const prev = entry.sync || {};
  try {
    validateUrl(settings.syncUrl);
    const payload = await buildPayload(entry, settings, appVersion);
    const data = await post(settings.syncUrl, payload);
    entry.sync = {
      status: 'synced',
      attempts: (prev.attempts || 0) + 1,
      syncedAt: new Date().toISOString(),
      photoUrl: data.photoUrl || '',
      row: data.row || null,
    };
    await save(entry);
    return { ok: true, data };
  } catch (err) {
    const error = err instanceof SyncError ? err : new SyncError('error', err.message || String(err));
    const attempts = (prev.attempts || 0) + 1;
    const permanent = PERMANENT.has(error.code);
    const giveUp = permanent || attempts >= MAX_TRANSIENT_ATTEMPTS;
    const delay = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
    entry.sync = {
      ...prev,
      status: giveUp ? 'failed' : 'waiting',
      attempts,
      lastError: error.message,
      nextAttemptAt: giveUp ? null : new Date(Date.now() + delay * 60000).toISOString(),
    };
    await save(entry);
    return { ok: false, error };
  }
}
