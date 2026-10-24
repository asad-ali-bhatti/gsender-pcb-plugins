// Files on disk through the File System Access API (the manifest's
// "fileSystem" permission). The run file's handle is kept in IndexedDB, which
// lasts until gSender quits: its server port, and so this page's origin,
// changes every launch, so after a restart the run file is opened again.

export const fileApi = typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function';

const TYPES = [{ description: 'PCB CAM project or run', accept: { 'application/json': ['.json'] } }];

/** Asks for a project or run file; null when cancelled. */
export async function pickOpen() {
    try {
        const [h] = await window.showOpenFilePicker({ types: TYPES, id: 'project-runner', multiple: false });
        return h ?? null;
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}

/** Asks where to save the run file; null when cancelled. */
export async function pickSave(suggestedName) {
    try {
        return await window.showSaveFilePicker({ suggestedName, types: TYPES, id: 'project-runner' });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}

/** 'granted' | 'prompt' | 'denied'; asks (needs a click) when `request` is set. */
export async function writePermission(handle, request = false) {
    try {
        const opts = { mode: 'readwrite' };
        let p = await handle.queryPermission(opts);
        if (p === 'prompt' && request) p = await handle.requestPermission(opts);
        return p;
    } catch {
        return 'denied';
    }
}

export async function writeText(handle, text) {
    // Written to a swap file; the real file is only replaced by close().
    const w = await handle.createWritable();
    try {
        await w.write(text);
    } catch (e) {
        await w.abort().catch(() => {});
        throw e;
    }
    await w.close();
}

export const readText = async (handle) => (await handle.getFile()).text();

function idb() {
    return new Promise((resolve, reject) => {
        const req = window.indexedDB.open('project-runner', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function kv(mode, fn) {
    const db = await idb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('kv', mode);
            const req = fn(tx.objectStore('kv'));
            tx.oncomplete = () => resolve(req?.result);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}
export const savedHandle = {
    get: () => kv('readonly', (s) => s.get('runFile')).catch(() => null),
    set: (h) => kv('readwrite', (s) => (h ? s.put(h, 'runFile') : s.delete('runFile'))).catch(() => {}),
};
