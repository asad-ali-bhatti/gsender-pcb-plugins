// Serves plugins inside tests/mock-host.html, a fake gSender host that answers
// the plugin bridge and simulates Grbl probing a warped board.
//
// The plugin SDK ships inside gSender, so it is extracted from a local install:
//   GSENDER_APP=/path/to/gSender.app node scripts/mock-server.mjs
import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8765);
const CACHE = path.join(ROOT, '.cache');
const SDK = path.join(CACHE, 'plugin-sdk', 'index.js');

async function ensureSdk() {
    try { await access(SDK); return; } catch { /* extract below */ }
    const app = process.env.GSENDER_APP || ['/Applications/gSender Edge.app', '/Applications/gSender.app'].find((p) => {
        try { execFileSync('test', ['-d', p]); return true; } catch { return false; }
    });
    if (!app) throw new Error('gSender not found; set GSENDER_APP to the gSender.app path');
    await mkdir(CACHE, { recursive: true });
    const asar = path.join(app, 'Contents/Resources/app.asar');
    execFileSync('npx', ['-y', '@electron/asar', 'extract-file', asar, 'plugin-sdk/index.js'], { cwd: CACHE });
    await mkdir(path.dirname(SDK), { recursive: true });
    execFileSync('mv', [path.join(CACHE, 'index.js'), SDK]);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

await ensureSdk();
createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file;
    if (url === '/fixtures/demo.pcbcam.json') {
        // A reviewed demo project for Project Runner (tests/fixtures/demo-project.mjs).
        const { demoDoc, withHashes } = await import('../tests/fixtures/demo-project.mjs');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await withHashes(demoDoc())));
        return;
    }
    if (url === '/' || url === '/host.html') file = path.join(ROOT, 'tests/mock-host.html');
    else if (url === '/plugin-sdk/index.js') file = SDK;
    else {
        const m = /^\/plugins\/([\w-]+)\/(.*)$/.exec(url);
        if (m) file = path.join(ROOT, 'plugins', m[1], 'ui', m[2] || 'index.html');
    }
    if (!file || !file.startsWith(ROOT)) { res.writeHead(404).end(); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
        res.writeHead(404).end();
    }
}).listen(PORT, () => console.log(`mock gSender host: http://localhost:${PORT}/`));
