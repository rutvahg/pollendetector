// Local storage for samples and settings (IndexedDB, on this device only).

const DB_NAME = 'pollen-check';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('capturedAt', 'capturedAt');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function putEntry(entry) {
  return done((await store('entries', 'readwrite')).put(entry));
}

export async function getEntry(id) {
  return done((await store('entries', 'readonly')).get(id));
}

export async function allEntries() {
  const list = await done((await store('entries', 'readonly')).getAll());
  return list.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)); // newest first
}

export async function deleteEntry(id) {
  return done((await store('entries', 'readwrite')).delete(id));
}

export async function clearEntries() {
  return done((await store('entries', 'readwrite')).clear());
}

export async function getSetting(key, fallback = null) {
  const value = await done((await store('settings', 'readonly')).get(key));
  return value === undefined ? fallback : value;
}

export async function setSetting(key, value) {
  return done((await store('settings', 'readwrite')).put(value, key));
}
