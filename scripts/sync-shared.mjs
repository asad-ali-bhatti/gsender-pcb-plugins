// Copies the pure modules Project Runner shares with the other plugins into
// plugins/project-runner/ui. gSender serves each plugin on its own, with no
// build step, so the Runner carries copies. tests/shared.test.mjs fails when a
// copy differs from its source: edit the source, then run
//   node scripts/sync-shared.mjs
import { cpSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** [source, copy], relative to the repo root; directories are copied whole. */
export const SHARED = [
    ['plugins/pcb-cam/ui/core', 'plugins/project-runner/ui/core'],
    ['plugins/pcb-cam/ui/vendor/clipper-lib.js', 'plugins/project-runner/ui/vendor/clipper-lib.js'],
    ['plugins/pcb-cam/ui/vendor/LICENSE-clipper-lib.txt', 'plugins/project-runner/ui/vendor/LICENSE-clipper-lib.txt'],
    ['plugins/autoleveler/ui/assets/leveling.js', 'plugins/project-runner/ui/vendor/autoleveler/leveling.js'],
];

/** Relative paths of every file under `dir` (or [''] for a file). */
export function listFiles(p) {
    if (!statSync(p).isDirectory()) return [''];
    return readdirSync(p, { recursive: true }).filter((f) => statSync(path.join(p, f)).isFile() && !f.endsWith('.DS_Store')).sort();
}

/** Pairs whose copy is missing or differs: [{ source, copy, file }]. */
export function differences() {
    const out = [];
    for (const [src, dst] of SHARED) {
        const a = path.join(ROOT, src);
        const b = path.join(ROOT, dst);
        let bFiles = [];
        try { bFiles = listFiles(b); } catch { /* missing */ }
        const files = new Set([...listFiles(a), ...bFiles]);
        for (const f of files) {
            let same = false;
            try { same = readFileSync(path.join(a, f)).equals(readFileSync(path.join(b, f))); } catch { /* one side missing */ }
            if (!same) out.push({ source: src, copy: dst, file: f });
        }
    }
    return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    for (const [src, dst] of SHARED) {
        rmSync(path.join(ROOT, dst), { recursive: true, force: true });
        cpSync(path.join(ROOT, src), path.join(ROOT, dst), { recursive: true });
        console.log(`${src} -> ${dst}`);
    }
}
