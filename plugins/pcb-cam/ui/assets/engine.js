// Runs generation in a module worker so a big board doesn't freeze the page.
// Falls back to the main thread when workers are unavailable.

import { loadFile, generate, analyzeProject, suggestRegions } from '../core/index.js';

export function createEngine() {
    let worker = null;
    try {
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
        console.warn('PCB CAM: no worker, generating on the main thread', e);
    }

    if (worker) {
        let seq = 0;
        const pending = new Map();
        worker.onmessage = (e) => {
            const { id, ok, value, error } = e.data;
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            if (ok) p.resolve(value);
            else p.reject(new Error(error));
        };
        worker.onerror = (e) => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'Worker failed'));
            pending.clear();
        };
        const call = (msg) => new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            worker.postMessage({ id, ...msg });
        });
        return {
            threaded: true,
            load: (inputId, name, text) => call({ type: 'load', inputId, name, text }),
            remove: (inputId) => call({ type: 'remove', inputId }),
            clear: () => call({ type: 'clear' }),
            generate: (project, toolChangeOption, { only, analyze = true } = {}) => call({ type: 'generate', project, toolChangeOption, only, analyze }),
            suggest: (inputId, tool, depth, margin) => call({ type: 'suggest', inputId, tool, depth, margin }),
        };
    }

    const layers = {};
    return {
        threaded: false,
        load: async (id, name, text) => {
            const l = loadFile(name, text).layer;
            if (l) layers[id] = l;
            return { ok: !!l };
        },
        remove: async (id) => { delete layers[id]; return { ok: true }; },
        clear: async () => { for (const k of Object.keys(layers)) delete layers[k]; return { ok: true }; },
        generate: async (project, toolChangeOption, { only, analyze = true } = {}) => {
            await new Promise((r) => setTimeout(r, 30)); // let the "Generating…" status paint
            const result = generate(project, layers, { toolChangeOption, only });
            return { result, analysis: result.ok && analyze ? analyzeProject(project, layers, { only }) : [] };
        },
        suggest: async (inputId, tool, depth, margin) => {
            if (!layers[inputId]) throw new Error('File not loaded');
            return suggestRegions(layers[inputId], tool, depth, { margin });
        },
    };
}
