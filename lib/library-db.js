// OneShot Redux: the Library store (IndexedDB, local to this browser profile).
// Shared by the editor, the quick-copy renderer and the Library page.
(() => {
  'use strict';

  const DB_NAME = 'oneshot-redux-library';
  const STORE = 'cards';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const s = db.createObjectStore(STORE, { keyPath: 'id' });
            s.createIndex('updatedAt', 'updatedAt');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const req2p = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  const Library = {
    get: (id) => tx('readonly', (s) => req2p(s.get(id))),
    all: () => tx('readonly', (s) => req2p(s.getAll())).then((list) =>
      (list || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))),
    put: (entry) => tx('readwrite', (s) => req2p(s.put(entry))),
    remove: (id) => tx('readwrite', (s) => req2p(s.delete(id))),
    // Keep only the newest `keep` cards (0 = keep everything). Returns how many were removed.
    prune: async (keep) => {
      if (!keep || keep < 1) return 0;
      const list = await Library.all();
      const extra = list.slice(keep);
      for (const e of extra) await Library.remove(e.id);
      return extra.length;
    },
    // Merge fields into an existing entry (no-op if it was deleted meanwhile).
    patch: (id, fields) => tx('readwrite', async (s) => {
      const cur = await req2p(s.get(id));
      if (cur) await req2p(s.put({ ...cur, ...fields }));
    })
  };

  self.OSRLibrary = Library;
})();
