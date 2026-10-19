// Where the workspace is kept outside gSender's settings file:
//  - session: the browser's sessionStorage. It survives leaving the CAM page
//    (gSender unloads this iframe) and is gone when gSender quits. gSender's
//    page shares it, so our use is capped well below the browser's quota.
//  - project file: a file on disk the user picked, written through the File
//    System Access API (needs the "fileSystem" permission in the manifest,
//    which gSender grants to Electron's permission requests). The handle is
//    kept in IndexedDB so it survives leaving the page; gSender's server port,
//    and so this page's origin, changes every launch, so after a restart the
//    file has to be opened again.

const PREFIX = 'com.asadalibhatti.pcb-cam:';
export const SESSION_LIMIT = 3 * 1024 * 1024; // characters, all our keys together

export const session = {
    get(key) {
        try {
            const v = window.sessionStorage.getItem(PREFIX + key);
            return v === null ? null : JSON.parse(v);
        } catch {
            return null;
        }
    },
    /** Stores `value`; false when it doesn't fit (the old value is removed then). */
    set(key, value) {
        try {
            const text = JSON.stringify(value);
            let used = 0;
            for (let i = 0; i < window.sessionStorage.length; i++) {
                const k = window.sessionStorage.key(i);
                if (k.startsWith(PREFIX) && k !== PREFIX + key) used += window.sessionStorage.getItem(k).length;
            }
            if (used + text.length > SESSION_LIMIT) {
                window.sessionStorage.removeItem(PREFIX + key);
                return false;
            }
            window.sessionStorage.setItem(PREFIX + key, text);
            return true;
        } catch {
            try { window.sessionStorage.removeItem(PREFIX + key); } catch { /* unavailable */ }
            return false;
        }
    },
};

// ---------------------------------------------------------------------------
// Project file handle, kept in IndexedDB for this gSender session
// ---------------------------------------------------------------------------

function idb() {
    return new Promise((resolve, reject) => {
        const req = window.indexedDB.open('pcb-cam', 1);
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
    get: () => kv('readonly', (s) => s.get('projectFile')).catch(() => null),
    set: (h) => kv('readwrite', (s) => (h ? s.put(h, 'projectFile') : s.delete('projectFile'))).catch(() => {}),
};

export const fileApi = typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function';
const TYPES = [{ description: 'PCB CAM project', accept: { 'application/json': ['.json'] } }];

/** Asks for a file to save to; null when cancelled. */
export async function pickSaveFile(suggestedName) {
    try {
        return await window.showSaveFilePicker({ suggestedName, types: TYPES, id: 'pcb-cam-project' });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}
/** Asks for a project file to open; null when cancelled. */
export async function pickOpenFile() {
    try {
        const [h] = await window.showOpenFilePicker({ types: TYPES, id: 'pcb-cam-project', multiple: false });
        return h ?? null;
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
export async function writeFile(handle, text) {
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
export const readFile = async (handle) => (await handle.getFile()).text();
