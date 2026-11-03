// Save snapshots in the browser's IndexedDB.
const DB_NAME = 'digital-mirror';
const STORE = 'snapshots';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// Put the newest snapshots first.
export async function listSnapshots() {
  const all = await run('readonly', (store) => store.getAll());
  return all.reverse();
}

// Save a snapshot and return its new ID with the record.
export async function addSnapshot(blob) {
  const record = { blob, createdAt: Date.now() };
  const id = await run('readwrite', (store) => store.add(record));
  return { ...record, id };
}

export function deleteSnapshot(id) {
  return run('readwrite', (store) => store.delete(id));
}
