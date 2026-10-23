// Where the workspace is kept outside gSender's settings file:
//  - projects folder: a folder the user picked; every project is a file in it,
//    written through the File System Access API (needs the "fileSystem"
//    permission in the manifest, which gSender grants to Electron's permission
//    requests). Folder and file handles are kept in IndexedDB so they survive
//    leaving the page. gSender's server port, and so this page's origin,
//    changes every launch, so after a restart the folder has to be picked
//    again; a marker file in it tells us it is the same folder.
//  - session: the browser's sessionStorage. It survives leaving the CAM page
//    (gSender unloads this iframe) and is gone when gSender quits. gSender's
//    page shares it, so our use is capped well below the browser's quota.

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
const savedKey = (key) => ({
    get: () => kv('readonly', (s) => s.get(key)).catch(() => null),
    set: (h) => kv('readwrite', (s) => (h ? s.put(h, key) : s.delete(key))).catch(() => {}),
});
export const savedHandle = savedKey('projectFile');
export const savedFolder = savedKey('projectsFolder');

export const fileApi = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
    && typeof window.showOpenFilePicker === 'function' && typeof window.showDirectoryPicker === 'function';
const TYPES = [{ description: 'PCB CAM project', accept: { 'application/json': ['.json'] } }];

/** Asks for a file to save to; null when cancelled. */
export async function pickSaveFile(suggestedName, startIn) {
    try {
        return await window.showSaveFilePicker({ suggestedName, types: TYPES, id: 'pcb-cam-project', ...(startIn ? { startIn } : {}) });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}
/** Asks for a project file to open; null when cancelled. */
export async function pickOpenFile(startIn) {
    try {
        const [h] = await window.showOpenFilePicker({ types: TYPES, id: 'pcb-cam-project', multiple: false, ...(startIn ? { startIn } : {}) });
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

// ---------------------------------------------------------------------------
// Projects folder
// ---------------------------------------------------------------------------

export const PROJECT_EXT = '.pcbcam.json';
const MARKER = '.pcbcam-workspace.json';

/** Asks for the projects folder (read and write); null when cancelled. */
export async function pickFolder() {
    try {
        return await window.showDirectoryPicker({ id: 'pcb-cam-projects', mode: 'readwrite', startIn: 'documents' });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}

/** The folder's id from its marker file; null when it has none. */
export async function folderId(dir) {
    try {
        const doc = JSON.parse(await readFile(await dir.getFileHandle(MARKER)));
        return typeof doc?.id === 'string' ? doc.id : null;
    } catch {
        return null;
    }
}
/** Gives the folder a marker file with a new id; returns the id. */
export async function markFolder(dir) {
    const id = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(await dir.getFileHandle(MARKER, { create: true }), JSON.stringify({ format: 'pcb-cam-workspace', id }));
    return id;
}

/** The project file `name` in the folder; null when it isn't there. */
export async function folderFile(dir, name) {
    try {
        return await dir.getFileHandle(name);
    } catch {
        return null;
    }
}
/** True when `handle` is a file directly inside the folder. */
export async function inFolder(dir, handle) {
    try {
        const path = await dir.resolve(handle);
        return Array.isArray(path) && path.length === 1;
    } catch {
        return false;
    }
}
/** Creates a new, empty project file named after `base`, never replacing one. */
export async function createProjectFile(dir, base) {
    const names = new Set();
    for await (const name of dir.keys()) names.add(name.toLowerCase());
    return dir.getFileHandle(projectFileName(base, names), { create: true });
}

/** `<base>.pcbcam.json`, or `<base>-2.pcbcam.json`… when the name is taken (`taken`: lower-case names). */
export function projectFileName(base, taken) {
    const slug = String(base).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 64) || 'board';
    for (let n = 1; ; n++) {
        const name = `${slug}${n > 1 ? `-${n}` : ''}${PROJECT_EXT}`;
        if (!taken.has(name.toLowerCase())) return name;
    }
}

/**
 * A project name from a board file's name: "blinky-F_Cu.gbr" → "blinky".
 * Empty for names that only say which layer it is (EasyEDA's "Gerber_TopLayer.GTL").
 */
export function boardName(fileName) {
    const name = String(fileName).replace(/\.[^.]+$/, '')
        .replace(/[-_.](F|B|In\d+)[._](Cu|Mask|SilkS|Silkscreen|Paste|Fab|CrtYd|Adhes)$/i, '')
        .replace(/[-_.](Edge[._]Cuts|PTH|NPTH|drl|drill|job|top|bottom|outline)$/i, '')
        .trim();
    return /^(gerber|drill)([-_ ]|$)/i.test(name) ? '' : name;
}
