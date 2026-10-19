// Generation worker: keeps its own parsed copy of every input file (sent once
// as text) and runs generate + analysis off the page's main thread.

import { loadFile, generate, analyzeProject, suggestRegions } from '../core/index.js';

const layers = {};

function run(msg) {
    switch (msg.type) {
        case 'load': {
            const loaded = loadFile(msg.name, msg.text);
            if (loaded.layer) layers[msg.inputId] = loaded.layer;
            return { ok: !!loaded.layer };
        }
        case 'remove':
            delete layers[msg.inputId];
            return { ok: true };
        case 'clear':
            for (const k of Object.keys(layers)) delete layers[k];
            return { ok: true };
        case 'generate': {
            const result = generate(msg.project, layers, { toolChangeOption: msg.toolChangeOption, only: msg.only });
            const analysis = result.ok && msg.analyze ? analyzeProject(msg.project, layers, { only: msg.only }) : [];
            return { result, analysis };
        }
        case 'suggest':
            if (!layers[msg.inputId]) throw new Error('File not loaded');
            return suggestRegions(layers[msg.inputId], msg.tool, msg.depth, { margin: msg.margin });
        default:
            throw new Error(`Unknown message ${msg.type}`);
    }
}

self.onmessage = (e) => {
    const { id, ...msg } = e.data;
    try {
        self.postMessage({ id, ok: true, value: run(msg) });
    } catch (err) {
        self.postMessage({ id, ok: false, error: err.message, stack: err.stack });
    }
};
