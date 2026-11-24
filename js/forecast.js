// Location and the Google Pollen API area forecast.

export function getLocation({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Location is not available in this browser.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: Math.round(pos.coords.latitude * 1e5) / 1e5,
        lng: Math.round(pos.coords.longitude * 1e5) / 1e5,
      }),
      (err) => reject(new Error(err.code === 1 ? 'Location permission was denied.' : 'Could not get your location.')),
      { enableHighAccuracy: false, timeout, maximumAge: 30 * 60 * 1000 },
    );
  });
}

const TYPE_NAMES = { TREE: 'Tree', GRASS: 'Grass', WEED: 'Weed' };

/**
 * Universal Pollen Index: 0 None, 1 Very low, 2 Low, 3 Moderate, 4 High, 5 Very high.
 * Mapped to the app's three levels: 0–2 Low, 3 Medium, 4–5 High.
 */
export async function fetchForecast(apiKey, lat, lng) {
  const url = new URL('https://pollen.googleapis.com/v1/forecast:lookup');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('location.latitude', String(lat));
  url.searchParams.set('location.longitude', String(lng));
  url.searchParams.set('days', '1');
  url.searchParams.set('plantsDescription', 'false');
  const res = await fetch(url, { cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error(data?.error?.message || `Forecast request failed (${res.status}).`);
  const types = (data?.dailyInfo?.[0]?.pollenTypeInfo || []).filter((t) => t.indexInfo);
  if (!types.length) return { level: null, type: null, label: 'No data', fetchedAt: new Date().toISOString() };
  const top = types.reduce((a, b) => (b.indexInfo.value > a.indexInfo.value ? b : a));
  const v = top.indexInfo.value;
  const level = v >= 4 ? 'High' : v === 3 ? 'Medium' : 'Low';
  const type = v > 0 ? (TYPE_NAMES[top.code] || top.displayName) : null;
  return {
    level, type, index: v, category: top.indexInfo.category,
    label: type ? `${level} · ${type}` : level,
    fetchedAt: new Date().toISOString(),
  };
}
