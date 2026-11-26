// IndexedDB 저장소: 프로젝트 메타데이터, 셀(프레임×레이어 그림) 이미지, 소리 파일을 보관한다.
const DB_NAME = 'animate';
const DB_VER = 2;
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects');
        if (!d.objectStoreNames.contains('cels')) d.createObjectStore('cels');
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const range = (pid) => IDBKeyRange.bound(pid + '|', pid + '|￿');

export async function listProjects() {
  const d = await openDB();
  const all = await req(d.transaction('projects').objectStore('projects').getAll());
  return all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export async function loadProject(pid) {
  const d = await openDB();
  const t = d.transaction(['projects', 'cels', 'audio']);
  const metaR = t.objectStore('projects').get(pid);
  const celsR = t.objectStore('cels').getAll(range(pid));
  const audioR = t.objectStore('audio').getAll(range(pid));
  const [meta, cels, audio] = await Promise.all([req(metaR), req(celsR), req(audioR)]);
  return { meta, cels, audio };
}

// puts: [{key, fid, lid, x, y, blob}], dels: [key]
export async function saveProject(meta, puts, dels) {
  const d = await openDB();
  const t = d.transaction(['projects', 'cels'], 'readwrite');
  t.objectStore('projects').put(meta, meta.id);
  const c = t.objectStore('cels');
  for (const p of puts) c.put(p, p.key);
  for (const k of dels) c.delete(k);
  return done(t);
}

export async function putMeta(meta) {
  const d = await openDB();
  const t = d.transaction('projects', 'readwrite');
  t.objectStore('projects').put(meta, meta.id);
  return done(t);
}

export async function putAudio(rec) {
  const d = await openDB();
  const t = d.transaction('audio', 'readwrite');
  t.objectStore('audio').put(rec, rec.key);
  return done(t);
}

export async function deleteAudio(key) {
  const d = await openDB();
  const t = d.transaction('audio', 'readwrite');
  t.objectStore('audio').delete(key);
  return done(t);
}

export async function deleteProject(pid) {
  const d = await openDB();
  const t = d.transaction(['projects', 'cels', 'audio'], 'readwrite');
  t.objectStore('projects').delete(pid);
  t.objectStore('cels').delete(range(pid));
  t.objectStore('audio').delete(range(pid));
  return done(t);
}

export async function duplicateProject(pid, newId, newName) {
  const { meta, cels, audio } = await loadProject(pid);
  const d = await openDB();
  const t = d.transaction(['projects', 'cels', 'audio'], 'readwrite');
  t.objectStore('projects').put({ ...meta, id: newId, name: newName, updated: Date.now() }, newId);
  const c = t.objectStore('cels');
  for (const cel of cels) {
    const key = newId + '|' + cel.fid + '|' + cel.lid;
    c.put({ ...cel, key }, key);
  }
  const a = t.objectStore('audio');
  for (const rec of audio) {
    const key = newId + '|' + rec.cid;
    a.put({ ...rec, key }, key);
  }
  return done(t);
}

export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* 무시 */ }
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
