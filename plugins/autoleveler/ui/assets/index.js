import { machine, viewer, gcode, storage, getReduxState } from '@sienci/gsender-plugin-sdk';
import {
    gridPoints, createHeightMap, validateGrid, isComplete, mapStats, heightAt, parsePRB, levelGcode, fmt,
} from './leveling.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULTS = {
    xmin: 0, xmax: 50, ymin: 0, ymax: 30, nx: 5, ny: 4,
    margin: 1,
    clearance: 2,      // work Z for travel between points
    depth: -2,         // lowest work Z the probe may reach before failing
    feed: 60,          // first (fast) probe feed, mm/min
    slowFeed: 15,      // second probe feed, 0 disables
    backoff: 0.5,      // retract before second probe
    zeroFirst: true,   // G10 L20 Z0 at the first point
    segment: 1,        // max segment length when levelling
    reference: 'first',
    showOverlay: true,
    showLabels: true,
    showMesh: true,
};

const state = {
    tab: 'setup',
    s: { ...DEFAULTS },
    map: null,
    scanning: false,
    abort: false,
    current: null,
    msg: null,
    log: [],
    connected: false,
    file: null,
    confirmApply: false,
};

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'className') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const saveSettings = debounce(() => storage.set('settings', state.s).catch(() => {}), 300);
const saveMap = () => storage.set('map', state.map).catch((e) => log(`Could not save map: ${e.message}`));

function setMsg(kind, text) { state.msg = text ? { kind, text } : null; renderMsg(); }
function log(line) {
    const t = new Date().toLocaleTimeString();
    state.log.push(`${t}  ${line}`);
    if (state.log.length > 300) state.log.shift();
    const el = $('#log');
    if (el) { el.textContent = state.log.join('\n'); el.scrollTop = el.scrollHeight; }
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const gridOf = (s) => ({ xmin: s.xmin, xmax: s.xmax, ymin: s.ymin, ymax: s.ymax, nx: s.nx, ny: s.ny });
const sameGrid = (a, b) => a && b && ['xmin', 'xmax', 'ymin', 'ymax', 'nx', 'ny'].every((k) => a[k] === b[k]);

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const STOPS = [[44, 123, 182], [171, 217, 233], [255, 255, 191], [253, 174, 97], [215, 25, 28]];
function colorRGB(t) {
    t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
    const f = t * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(f));
    const u = f - i;
    return STOPS[i].map((c, k) => Math.round(c + (STOPS[i + 1][k] - c) * u));
}
const colorCss = (t) => `rgb(${colorRGB(t).join(',')})`;
const gradientCss = () => `linear-gradient(90deg, ${STOPS.map((c) => `rgb(${c.join(',')})`).join(',')})`;

const refZ = () => (state.s.reference === 'absolute' || !state.map || !Number.isFinite(state.map.z[0]) ? 0 : state.map.z[0]);

// ---------------------------------------------------------------------------
// Visualizer overlay
// ---------------------------------------------------------------------------

const drawOverlay = debounce(() => {
    const s = state.s;
    if (!s.showOverlay) { viewer.setOverlay([]).catch(() => {}); return; }
    // The stored map is only shown while it matches the Setup grid; otherwise the
    // Setup grid is drawn as the points a new scan would probe.
    const setupGrid = validateGrid(gridOf(s)).length ? null : gridOf(s);
    const map = state.map && (state.scanning || sameGrid(state.map, setupGrid)) ? state.map : null;
    const grid = map ?? setupGrid;
    if (!grid) { viewer.setOverlay([]).catch(() => {}); return; }

    const markers = [];
    const st = map ? mapStats(map) : null;
    const ref = refZ();
    const norm = (z) => (st && st.range > 0 ? (z - st.min) / st.range : 0.5);

    if (map && isComplete(map) && s.showMesh) {
        // Interpolated dots along every grid line give a wire-mesh impression.
        // The host redraws every marker each frame, so keep the mesh to ~350 dots.
        const segments = (grid.nx - 1) * grid.ny + grid.nx * (grid.ny - 1);
        const per = Math.max(2, Math.floor(350 / segments));
        const addLine = (x0, y0, x1, y1) => {
            for (let k = 1; k < per; k++) {
                const x = x0 + ((x1 - x0) * k) / per;
                const y = y0 + ((y1 - y0) * k) / per;
                const z = heightAt(map, x, y).z;
                markers.push({ x, y, z: z - ref, color: colorCss(norm(z)), size: 1.4 });
            }
        };
        for (let j = 0; j < grid.ny; j++) {
            const y = grid.ymin + ((grid.ymax - grid.ymin) * j) / (grid.ny - 1);
            for (let i = 0; i < grid.nx - 1; i++) {
                addLine(grid.xmin + ((grid.xmax - grid.xmin) * i) / (grid.nx - 1), y, grid.xmin + ((grid.xmax - grid.xmin) * (i + 1)) / (grid.nx - 1), y);
            }
        }
        for (let i = 0; i < grid.nx; i++) {
            const x = grid.xmin + ((grid.xmax - grid.xmin) * i) / (grid.nx - 1);
            for (let j = 0; j < grid.ny - 1; j++) {
                addLine(x, grid.ymin + ((grid.ymax - grid.ymin) * j) / (grid.ny - 1), x, grid.ymin + ((grid.ymax - grid.ymin) * (j + 1)) / (grid.ny - 1));
            }
        }
    }

    for (const p of gridPoints(grid)) {
        const z = map?.z[p.idx];
        if (Number.isFinite(z)) {
            markers.push({
                x: p.x, y: p.y, z: z - ref, shape: 'circle', size: 4, color: colorCss(norm(z)),
                label: s.showLabels ? fmt(z - ref, 3) : undefined,
            });
        } else {
            markers.push({ x: p.x, y: p.y, z: 0, shape: 'ring', size: 4, color: '#9aa1a9' });
        }
    }
    if (state.current) markers.push({ x: state.current.x, y: state.current.y, z: 0, shape: 'cross', size: 9, color: '#0ef6ae' });
    viewer.setOverlay(markers).catch(() => {});
}, 60);

/**
 * gSender draws overlay markers on a full-window SVG (z-index 10) appended to
 * <body>, which paints over this panel. The plugin is served same-origin, so
 * clip a hole in that SVG where the panel sits. Best effort: silently does
 * nothing if the host page isn't reachable.
 */
function clipOverlayAroundPanel() {
    let pdoc, frame;
    try {
        pdoc = window.parent.document;
        frame = window.frameElement;
    } catch {
        return;
    }
    if (!pdoc || !frame || pdoc === document) return;

    // The floating panel is the first absolutely positioned ancestor of our iframe.
    let panel = frame;
    for (let el = frame.parentElement; el && el !== pdoc.body; el = el.parentElement) {
        if (pdoc.defaultView.getComputedStyle(el).position === 'absolute') { panel = el; break; }
    }

    const STYLE_ID = 'autoleveler-overlay-clip';
    let last = '';
    const update = () => {
        if (!panel.isConnected) return;
        const r = panel.getBoundingClientRect();
        const W = pdoc.documentElement.clientWidth;
        const H = pdoc.documentElement.clientHeight;
        const key = [r.left, r.top, r.width, r.height, W, H].map(Math.round).join(',');
        if (key === last) return;
        last = key;
        let style = pdoc.getElementById(STYLE_ID);
        if (!style) {
            style = pdoc.createElement('style');
            style.id = STYLE_ID;
            pdoc.head.append(style);
        }
        const [x, y, w, h] = [r.left, r.top, r.width, r.height].map(Math.round);
        style.textContent = `body > svg[style*="pointer-events: none"][style*="z-index: 10"] {
  clip-path: path(evenodd, "M0 0H${W}V${H}H0Z M${x} ${y}h${w}v${h}h${-w}Z");
}`;
    };
    update();
    const timer = setInterval(update, 400);
    window.addEventListener('pagehide', () => {
        clearInterval(timer);
        pdoc.getElementById(STYLE_ID)?.remove();
    });
}

/**
 * gSender rebuilds the overlay SVG on every animation frame. When usage data
 * collection is on, PostHog's session recorder keeps each of those DOM
 * mutations (~14 MB/s with a full map) until the renderer runs out of memory.
 * `ph-no-capture` makes the recorder skip the element; the SVG is recreated
 * whenever the marker list goes from empty to non-empty, so watch for it.
 */
function excludeOverlayFromRecording() {
    let pdoc;
    try {
        pdoc = window.parent.document;
    } catch {
        return;
    }
    if (!pdoc || pdoc === document) return;
    const mark = () => {
        for (const el of pdoc.querySelectorAll('body > svg[style*="pointer-events: none"][style*="z-index: 10"]')) {
            el.classList.add('ph-no-capture');
        }
    };
    mark();
    const observer = new pdoc.defaultView.MutationObserver(mark);
    observer.observe(pdoc.body, { childList: true });
    window.addEventListener('pagehide', () => observer.disconnect());
}

// ---------------------------------------------------------------------------
// Machine I/O
// ---------------------------------------------------------------------------

const FAIL_RE = /^(error:|ALARM:)/;

async function q(cmd, timeout = 10000) {
    log(`> ${cmd}`);
    const r = await machine.query(cmd, { timeout, until: /^(ok|error:\d+|ALARM:\d+)/ });
    const bad = r.lines.find((l) => FAIL_RE.test(l));
    if (bad) throw new Error(`${cmd} → ${bad}`);
    if (!r.complete) throw new Error(`${cmd}: no response (${r.reason})`);
    return r;
}

/** Runs G38.2 and returns the contact point in machine coordinates. */
async function probe(targetZ, feed, timeout) {
    const cmd = `G38.2 Z${fmt(targetZ)} F${fmt(feed, 1)}`;
    log(`> ${cmd}`);
    // Stop on the PRB report itself so a stray `ok` from another sender can't end the capture early.
    const r = await machine.query(cmd, { timeout, until: /^(\[PRB:|ALARM:|error:)/, maxLines: 50 });
    const prb = parsePRB(r.lines);
    const bad = r.lines.find((l) => FAIL_RE.test(l));
    if (bad && !prb) throw new Error(`Probe failed: ${bad}`);
    if (!prb) throw new Error(`Probe gave no result (${r.reason}). Check probe wiring.`);
    if (!prb.ok) throw new Error(`Probe did not touch before Z${fmt(targetZ)}. Lower "Probe to Z" or zero Z closer to the surface.`);
    log(`< PRB Z${fmt(prb.z)}`);
    return prb;
}

async function readMachine() {
    const rs = await getReduxState();
    return {
        connected: !!rs?.connection?.isConnected,
        activeState: rs?.controller?.state?.status?.activeState ?? 'Unknown',
        file: rs?.file ?? null,
    };
}

async function startScan({ resume = false } = {}) {
    const s = state.s;
    const grid = gridOf(s);
    const errs = validateGrid(grid);
    if (s.depth >= s.clearance) errs.push('"Probe to Z" must be below the travel height');
    if (!(s.feed > 0)) errs.push('Probe feed must be > 0');
    if (errs.length) { setMsg('err', errs.join('\n')); return; }

    let m, ctx;
    try {
        m = await readMachine();
        ctx = await machine.getContext();
    } catch (e) {
        setMsg('err', e.message);
        return;
    }
    if (!m.connected) { setMsg('err', 'Connect to the machine first.'); return; }
    if (m.activeState !== 'Idle') { setMsg('err', `Machine is ${m.activeState}. It must be Idle (unlock / home first).`); return; }

    const mpos = ctx.position, wpos = ctx.workPosition;
    if (!mpos || !wpos) { setMsg('err', 'Machine position is unknown.'); return; }
    let wcoZ = Number(mpos.z) - Number(wpos.z);

    if (!(resume && state.map && sameGrid(state.map, grid) && !isComplete(state.map))) {
        state.map = createHeightMap(grid);
        resume = false;
    }
    const map = state.map;
    const pts = gridPoints(grid).filter((p) => !Number.isFinite(map.z[p.idx]));
    const total = map.z.length;

    state.scanning = true;
    state.abort = false;
    setMsg('info', resume ? `Resuming: ${pts.length} point(s) left` : `Scanning ${total} points…`);
    render();
    const probeTimeout = 120000 + (Math.abs(s.clearance - s.depth) / s.feed) * 60000;

    try {
        await machine.setBusy(true, 'Autolevel scan');
        await q('G21');
        await q('G90');
        await q(`G0 Z${fmt(s.clearance)}`);
        for (const p of pts) {
            if (state.abort) throw new Error('Scan stopped by user.');
            state.current = p;
            updateProgress();
            drawOverlay();
            machine.setBusy(true, 'Autolevel scan').catch(() => {});

            await q(`G0 X${fmt(p.x)} Y${fmt(p.y)}`);
            let prb = await probe(s.depth, s.feed, probeTimeout);
            if (s.slowFeed > 0) {
                const zc = prb.z - wcoZ;
                await q(`G0 Z${fmt(zc + s.backoff)}`);
                prb = await probe(zc - s.backoff - 1, s.slowFeed, probeTimeout);
            }
            let zw = prb.z - wcoZ;
            if (p.idx === 0 && s.zeroFirst) {
                await q('G10 L20 P0 Z0');
                wcoZ = prb.z;
                zw = 0;
                log('Work Z zeroed at first point');
            }
            map.z[p.idx] = zw;
            log(`#${p.idx} X${fmt(p.x, 3)} Y${fmt(p.y, 3)} → Z${fmt(zw)}`);
            await q(`G0 Z${fmt(s.clearance)}`);
            saveMap();
            updateProgress();
            renderHeat();
            drawOverlay();
        }
        const st = mapStats(map);
        setMsg('ok', `Scan complete. Range ${fmt(st.range, 3)} mm (min ${fmt(st.min, 3)}, max ${fmt(st.max, 3)}).`);
        log('Scan complete');
    } catch (e) {
        setMsg('err', `${e.message}\nThe map keeps all points probed so far; fix the issue and press Resume.`);
        log(`! ${e.message}`);
    } finally {
        state.scanning = false;
        state.current = null;
        machine.setBusy(false).catch(() => {});
        saveMap();
        render();
    }
}

async function stopScan() {
    state.abort = true;
    log('! Stop requested: feed hold + soft reset');
    try {
        await machine.command('feedhold');
        setTimeout(() => machine.command('reset').catch(() => {}), 400);
    } catch (e) {
        log(`! ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// G-code
// ---------------------------------------------------------------------------

async function refreshFile() {
    try {
        const { file } = await readMachine();
        state.file = file?.fileLoaded && file.content ? file : null;
    } catch (e) {
        state.file = null;
        setMsg('err', e.message);
    }
    render();
}

async function useFileBounds() {
    try {
        const { file } = await readMachine();
        if (!file?.fileLoaded) { setMsg('err', 'No G-code file is loaded.'); return; }
        const { min, max } = file.bbox;
        const m = state.s.margin || 0;
        Object.assign(state.s, {
            xmin: round3(min.x - m), xmax: round3(max.x + m), ymin: round3(min.y - m), ymax: round3(max.y + m),
        });
        saveSettings();
        setMsg('info', `Grid set to file bounds ±${m} mm.`);
        render();
        drawOverlay();
    } catch (e) {
        setMsg('err', e.message);
    }
}
const round3 = (v) => Math.round(v * 1000) / 1000;

async function applyLevel() {
    if (!isComplete(state.map)) { setMsg('err', 'Probe a complete height map first.'); return; }
    await refreshFile();
    const f = state.file;
    if (!f) { setMsg('err', 'Load the G-code job first, then apply.'); return; }
    if (f.content.includes('(Autoleveled by') && !state.confirmApply) {
        state.confirmApply = true;
        setMsg('warn', 'This file is already levelled. Click Apply again to level it a second time.');
        render();
        return;
    }
    state.confirmApply = false;
    try {
        const r = levelGcode(f.content, state.map, { segment: state.s.segment, reference: state.s.reference });
        const name = String(f.name || 'job.nc').replace(/(\.[^.]+)?$/, (ext) => `_leveled${ext || '.nc'}`);
        await gcode.loadToVisualizer(r.gcode, name);
        const w = r.warnings.length ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : '';
        setMsg(r.warnings.length ? 'warn' : 'ok', `Loaded ${name}: ${r.stats.levelled} levelled moves (${r.stats.arcs} arcs linearised).${w}`);
        log(`Applied map → ${name}`);
        setTimeout(refreshFile, 1500);
    } catch (e) {
        setMsg('err', e.message);
    }
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

function exportMap() {
    if (!state.map) { setMsg('err', 'No height map to export.'); return; }
    const ta = $('#io');
    ta.value = JSON.stringify(state.map);
    ta.select();
    try { document.execCommand('copy'); setMsg('ok', 'Height map JSON copied to the clipboard.'); } catch { setMsg('info', 'Copy the JSON from the box.'); }
}

function importMap(text) {
    try {
        const m = JSON.parse(text);
        const errs = validateGrid(m);
        if (errs.length || !Array.isArray(m.z) || m.z.length !== m.nx * m.ny) throw new Error(errs[0] || 'z array size does not match nx × ny');
        m.z = m.z.map((v) => (v === null ? null : Number(v)));
        state.map = m;
        Object.assign(state.s, gridOf(m));
        saveSettings();
        saveMap();
        setMsg('ok', `Imported ${m.nx}×${m.ny} map${isComplete(m) ? '' : ' (incomplete, press Resume to finish)'}.`);
        render();
        drawOverlay();
    } catch (e) {
        setMsg('err', `Import failed: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function num(key, label, { step = 'any', min, int = false } = {}) {
    return h('label', { className: 'f' }, label,
        h('input', {
            type: 'number', step, min, value: state.s[key], disabled: state.scanning,
            onChange: (e) => {
                const v = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
                if (Number.isFinite(v)) { state.s[key] = v; saveSettings(); }
                else e.target.value = state.s[key];
                state.confirmApply = false;
                updateDerived();
                drawOverlay();
            },
        }));
}

function chk(key, label, after) {
    return h('label', { className: 'chk' },
        h('input', { type: 'checkbox', checked: !!state.s[key], onChange: (e) => { state.s[key] = e.target.checked; saveSettings(); after?.(); } }),
        label);
}

function renderMsg() {
    const el = $('#msg');
    if (!el) return;
    el.replaceChildren();
    if (state.msg) el.append(h('div', { className: `msg ${state.msg.kind}` }, state.msg.text));
}

function updateDerived() {
    const el = $('#derived');
    if (!el) return;
    const s = state.s;
    const errs = validateGrid(gridOf(s));
    if (errs.length) { el.textContent = errs[0]; return; }
    const dx = (s.xmax - s.xmin) / (s.nx - 1);
    const dy = (s.ymax - s.ymin) / (s.ny - 1);
    const n = s.nx * s.ny;
    const perPoint = (Math.abs(s.clearance - s.depth) / 2) / s.feed * 60 + (s.slowFeed > 0 ? (s.backoff * 2) / s.slowFeed * 60 : 0) + 2;
    el.textContent = `${n} points, spacing ${fmt(dx, 2)} × ${fmt(dy, 2)} mm, ≈ ${Math.ceil((n * perPoint) / 60)} min`;
}

function updateProgress() {
    const bar = $('#bar');
    const txt = $('#progtxt');
    if (!bar || !state.map) return;
    const done = state.map.z.filter(Number.isFinite).length;
    bar.style.width = `${(100 * done) / state.map.z.length}%`;
    txt.textContent = `${done} / ${state.map.z.length} points${state.current ? ` — probing X${fmt(state.current.x, 2)} Y${fmt(state.current.y, 2)}` : ''}`;
}

function renderHeat() {
    const box = $('#heat');
    if (!box) return;
    box.replaceChildren();
    const map = state.map;
    if (!map) { box.append(h('div', { className: 'note' }, 'No height map yet.')); return; }

    const st = mapStats(map);
    const ref = refZ();
    if (st) {
        box.append(h('div', { className: 'stats' },
            h('div', {}, h('b', {}, fmt(st.min - ref, 3)), h('span', {}, 'min mm')),
            h('div', {}, h('b', {}, fmt(st.max - ref, 3)), h('span', {}, 'max mm')),
            h('div', {}, h('b', {}, fmt(st.range, 3)), h('span', {}, 'range mm'))));
    }

    const wrap = h('div', { className: 'heat' });
    const canvas = h('canvas');
    const tip = h('div', { className: 'tip', style: 'display:none' });
    wrap.append(canvas, tip);
    box.append(wrap);

    const cssW = box.clientWidth || 280;
    const aspect = (map.ymax - map.ymin) / (map.xmax - map.xmin);
    const cssH = Math.max(80, Math.min(240, cssW * aspect));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, pad = 8 * dpr;
    const toPx = (x, y) => [pad + ((x - map.xmin) / (map.xmax - map.xmin)) * (W - 2 * pad), H - pad - ((y - map.ymin) / (map.ymax - map.ymin)) * (H - 2 * pad)];
    const norm = (z) => (st && st.range > 0 ? (z - st.min) / st.range : 0.5);

    if (isComplete(map)) {
        const img = ctx.createImageData(W, H);
        for (let py = 0; py < H; py++) {
            for (let px = 0; px < W; px++) {
                const x = map.xmin + ((px - pad) / (W - 2 * pad)) * (map.xmax - map.xmin);
                const y = map.ymin + ((H - pad - py) / (H - 2 * pad)) * (map.ymax - map.ymin);
                const o = (py * W + px) * 4;
                if (x < map.xmin || x > map.xmax || y < map.ymin || y > map.ymax) continue;
                const [r, g, b] = colorRGB(norm(heightAt(map, x, y).z));
                img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    for (const p of gridPoints(map)) {
        const z = map.z[p.idx];
        const [px, py] = toPx(p.x, p.y);
        ctx.beginPath();
        ctx.arc(px, py, 3.5 * dpr, 0, Math.PI * 2);
        if (Number.isFinite(z)) {
            ctx.fillStyle = colorCss(norm(z));
            ctx.fill();
            ctx.lineWidth = 1 * dpr;
            ctx.strokeStyle = 'rgba(0,0,0,.6)';
            ctx.stroke();
        } else {
            ctx.lineWidth = 1 * dpr;
            ctx.strokeStyle = '#9aa1a9';
            ctx.stroke();
        }
    }

    canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
        const x = map.xmin + ((px - pad) / (W - 2 * pad)) * (map.xmax - map.xmin);
        const y = map.ymin + ((H - pad - py) / (H - 2 * pad)) * (map.ymax - map.ymin);
        if (x < map.xmin || x > map.xmax || y < map.ymin || y > map.ymax) { tip.style.display = 'none'; return; }
        let text = `X${fmt(x, 2)} Y${fmt(y, 2)}`;
        if (isComplete(map)) text += `  Z${fmt(heightAt(map, x, y).z - ref, 3)}`;
        tip.textContent = text;
        tip.style.display = 'block';
        tip.style.left = `${Math.min(e.clientX - r.left + 10, r.width - 130)}px`;
        tip.style.top = `${e.clientY - r.top + 10}px`;
    });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

    if (st) {
        box.append(h('div', { className: 'legend' },
            h('span', {}, fmt(st.min - ref, 3)),
            h('div', { className: 'bar', style: `background:${gradientCss()}` }),
            h('span', {}, fmt(st.max - ref, 3))));
    }
}

function tabSetup() {
    const s = state.s;
    return [
        h('div', { className: 'section' },
            h('h4', {}, 'Probe area (work coordinates, mm)'),
            h('div', { className: 'grid2' },
                num('xmin', 'X min'), num('xmax', 'X max'),
                num('ymin', 'Y min'), num('ymax', 'Y max'),
                num('nx', 'X points', { step: 1, min: 2, int: true }), num('ny', 'Y points', { step: 1, min: 2, int: true })),
            h('div', { className: 'row' },
                h('button', { className: 'b', disabled: state.scanning, onClick: useFileBounds }, 'Use loaded file bounds'),
                h('div', { style: 'width:70px' }, num('margin', 'Margin'))),
            h('div', { className: 'note', id: 'derived' })),
        h('div', { className: 'section' },
            h('h4', {}, 'Probing'),
            h('div', { className: 'grid2' },
                num('clearance', 'Travel Z'), num('depth', 'Probe to Z'),
                num('feed', 'Probe feed', { min: 1 }), num('slowFeed', 'Slow re-probe feed (0 = off)', { min: 0 }),
                num('backoff', 'Re-probe back-off')),
            chk('zeroFirst', 'Set work Z0 at first point'),
            h('div', { className: 'note' }, 'Zero Z roughly on the surface and attach the probe clip before scanning. Travel and probe heights are work coordinates.')),
        h('div', { className: 'section' },
            h('h4', {}, 'Visualizer'),
            chk('showOverlay', 'Show grid / map on visualizer', drawOverlay),
            chk('showLabels', 'Show height labels', drawOverlay),
            chk('showMesh', 'Show interpolated mesh', drawOverlay),
            h('div', { className: 'row' },
                h('button', { className: 'b', onClick: () => viewer.camera.set('top').catch(() => {}) }, 'Top view'),
                h('button', { className: 'b', onClick: () => viewer.camera.set('3d').catch(() => {}) }, '3D view'))),
    ];
}

function tabProbe() {
    const canResume = state.map && !isComplete(state.map) && sameGrid(state.map, gridOf(state.s)) && state.map.z.some(Number.isFinite);
    const stale = state.map && !sameGrid(state.map, gridOf(state.s));
    return [
        h('div', { className: 'row' },
            state.scanning
                ? h('button', { className: 'b danger', onClick: stopScan }, '■ Stop')
                : h('button', { className: 'b primary', onClick: () => startScan() }, state.map ? '▶ New scan' : '▶ Start scan'),
            !state.scanning && canResume ? h('button', { className: 'b', onClick: () => startScan({ resume: true }) }, 'Resume') : null),
        stale ? h('div', { className: 'note' }, 'Setup grid differs from the stored map. A new scan will use the Setup grid.') : null,
        h('div', { className: 'progress' }, h('div', { id: 'bar', style: 'width:0%' })),
        h('div', { className: 'note', id: 'progtxt' }, state.map ? '' : 'Ready.'),
        h('div', { className: 'section', id: 'heat' }),
        h('div', { className: 'section' }, h('h4', {}, 'Log'), h('div', { className: 'log', id: 'log' }, state.log.join('\n'))),
    ];
}

function tabApply() {
    const f = state.file;
    const map = state.map;
    let coverage = null;
    if (f && map) {
        const { min, max } = f.bbox;
        const out = min.x < map.xmin - 0.01 || max.x > map.xmax + 0.01 || min.y < map.ymin - 0.01 || max.y > map.ymax + 0.01;
        if (out) coverage = h('div', { className: 'msg warn' }, `Job (X${fmt(min.x, 2)}..${fmt(max.x, 2)} Y${fmt(min.y, 2)}..${fmt(max.y, 2)}) extends past the probed area; edge heights will be used there.`);
    }
    return [
        h('div', { className: 'section' },
            h('h4', {}, 'Loaded job'),
            h('div', { className: 'note' }, f ? `${f.name} (${(f.content.length / 1024).toFixed(0)} KB)` : 'No file loaded.'),
            coverage,
            h('button', { className: 'b', onClick: refreshFile }, 'Refresh')),
        h('div', { className: 'section' },
            h('h4', {}, 'Levelling'),
            h('div', { className: 'grid2' },
                num('segment', 'Max segment (mm)', { min: 0.1 }),
                h('label', { className: 'f' }, 'Z reference',
                    h('select', {
                        onChange: (e) => { state.s.reference = e.target.value; saveSettings(); renderHeat(); drawOverlay(); },
                    },
                    h('option', { value: 'first', selected: state.s.reference === 'first' }, 'First point'),
                    h('option', { value: 'absolute', selected: state.s.reference === 'absolute' }, 'Absolute work Z')))),
            h('div', { className: 'note' }, 'First point: heights are relative to the first probe point, so you can change bits and re-zero Z there. Absolute: keep the Z0 used during the scan.'),
            h('div', { className: 'row' },
                h('button', { className: 'b primary', disabled: !isComplete(map) || state.scanning, onClick: applyLevel }, 'Apply & load levelled G-code'))),
        h('div', { className: 'section' },
            h('h4', {}, 'Height map file'),
            h('textarea', { id: 'io', placeholder: 'Paste height map JSON here to import' }),
            h('div', { className: 'row' },
                h('button', { className: 'b', onClick: exportMap, disabled: !map }, 'Export / copy'),
                h('button', { className: 'b', onClick: () => importMap($('#io').value) }, 'Import text'),
                h('button', { className: 'b', onClick: () => $('#file').click() }, 'Open file…')),
            h('input', {
                type: 'file', id: 'file', accept: '.json,application/json', style: 'display:none',
                onChange: async (e) => { const file = e.target.files?.[0]; if (file) importMap(await file.text()); e.target.value = ''; },
            }),
            h('div', { className: 'row' },
                h('button', {
                    className: 'b', disabled: !map || state.scanning,
                    onClick: () => { state.map = null; storage.delete('map').catch(() => {}); setMsg('info', 'Height map cleared.'); render(); drawOverlay(); },
                }, 'Clear map'))),
    ];
}

function render() {
    const root = $('#root');
    const status = h('div', { className: 'note', id: 'conn' }, state.connected ? '● Connected' : '○ Not connected');
    const tabs = h('div', { className: 'tabs' },
        ...[['setup', 'Setup'], ['probe', 'Probe'], ['apply', 'Apply']].map(([id, label]) =>
            h('button', { className: state.tab === id ? 'active' : '', onClick: () => { state.tab = id; if (id === 'apply') refreshFile(); else render(); } }, label)));
    const body = state.tab === 'setup' ? tabSetup() : state.tab === 'probe' ? tabProbe() : tabApply();
    root.replaceChildren(tabs, status, h('div', { id: 'msg' }), ...body.filter(Boolean));
    renderMsg();
    updateDerived();
    updateProgress();
    renderHeat();
    const lg = $('#log');
    if (lg) lg.scrollTop = lg.scrollHeight;
}

async function pollConnection() {
    try {
        const ctx = await machine.getContext();
        const c = !!ctx?.connected;
        if (c !== state.connected) {
            state.connected = c;
            const el = $('#conn');
            if (el) el.textContent = c ? '● Connected' : '○ Not connected';
        }
    } catch { /* bridge not ready */ }
}

async function init() {
    try {
        const saved = await storage.get('settings', null);
        if (saved && typeof saved === 'object') state.s = { ...DEFAULTS, ...saved };
        const map = await storage.get('map', null);
        if (map && Array.isArray(map.z)) state.map = map;
    } catch (e) {
        state.msg = { kind: 'err', text: `Storage unavailable: ${e.message}` };
    }
    if (state.map) state.tab = isComplete(state.map) ? 'apply' : 'probe';
    render();
    if (state.tab === 'apply') refreshFile();
    clipOverlayAroundPanel();
    excludeOverlayFromRecording();
    drawOverlay();
    pollConnection();
    setInterval(pollConnection, 2000);
    window.addEventListener('resize', debounce(renderHeat, 150));
}

init();
