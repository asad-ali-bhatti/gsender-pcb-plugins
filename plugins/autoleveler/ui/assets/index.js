import { machine, viewer, gcode, storage, getReduxState } from '@sienci/gsender-plugin-sdk';
import { installIcons, icon } from './icons.js';
import {
    gridPoints, createHeightMap, validateGrid, isComplete, mapStats, heightAt, parsePRB, levelGcode, fmt, anchorIdx, zeroHeight, ZERO_AT, centerPoint, probeOrder, cutPaths,
} from './leveling.js';
import { runScan, validateScanSettings } from './scan.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULTS = {
    xmin: 0, xmax: 50, ymin: 0, ymax: 30, nx: 5, ny: 4,
    margin: 1,
    fileBbox: null,    // job bounds last used by "Use loaded file bounds"
    clearance: 2,      // travel height above the first point's surface, mm
    maxBelow: 1,       // how far below the first point's surface later probes may go, mm
    firstTravel: 10,   // how far the first probe may travel down from the start height, mm
    probeTest: true,   // ask for a touch test of the probe input before moving
    feed: 60,          // first (fast) probe feed, mm/min
    slowFeed: 15,      // second probe feed, 0 disables
    backoff: 0.5,      // retract before second probe
    zeroFirst: true,   // G10 L20 Z0 at the first point
    segment: 1,        // max segment length when levelling
    zeroAt: 'origin',  // where work Z0 is set for the job: origin (X0 Y0) | scan | absolute
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
    probeOn: null,     // probe input triggered (live), null when unknown
    file: null,
    // Last un-levelled file we levelled, kept in memory only, so pressing Apply
    // again (e.g. after a new scan) re-levels the original, never the output.
    source: null,      // { name, content, leveledName }
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

// gSender's storage.set deep-merges into the stored value (arrays index by
// index), so a smaller map would keep stale heights. Delete first to replace.
const replaceStored = async (key, value) => { await storage.delete(key); await storage.set(key, value); };
const saveSettings = debounce(() => replaceStored('settings', state.s).catch(() => {}), 300);
const saveMap = () => replaceStored('map', state.map).catch((e) => log(`Could not save map: ${e.message}`));

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

const refZ = () => {
    if (!state.map) return 0;
    const z = zeroHeight(state.map, state.s.zeroAt).z; // NaN until the cells around X0 Y0 are probed
    return Number.isFinite(z) ? z : 0;
};

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

const REPLY_RE = /^(ok|error:\d+|ALARM:\d+)/;

/**
 * Sends one command and returns its reply lines. A probe reply is captured up
 * to the `ok` after `[PRB:]`, so no stray `ok` is left for the next query; if
 * a stray `ok` from elsewhere ended the capture before the PRB report, a
 * `G4 P0` (waits for motion to finish) collects the rest.
 */
async function sendLine(cmd, { probe = false, timeout = 10000 } = {}) {
    const r = await machine.query(cmd, { timeout, until: REPLY_RE, maxLines: 50 });
    let lines = r.lines;
    if (probe && !parsePRB(lines) && !lines.some((l) => /^(error:|ALARM:)/.test(l))) {
        // The probe was acknowledged before it finished: G4 P0 waits for it, so
        // its reply holds the [PRB:] line and ends with its own ok (none left over).
        const more = await machine.query('G4 P0', { timeout, until: REPLY_RE, maxLines: 50 });
        lines = lines.concat(more.lines);
    }
    if (!r.complete && !lines.some((l) => REPLY_RE.test(l))) throw new Error(`${cmd}: no response (${r.reason})`);
    return lines;
}

/**
 * Work Z offset (machine Z of work Z0) from the WCO the controller reports in
 * its status, without sending $ commands. Waits until the machine is Idle and
 * the value is steady; with `atCurrent` (Z0 was just set here) also until the
 * reported work Z reads 0, so a stale WCO from before G10 is never used.
 */
async function readWcoZ({ atCurrent = false } = {}) {
    let last = null;
    for (let waited = 0; waited < 5000; waited += 250) {
        const st = (await getReduxState())?.controller?.state?.status ?? {};
        const wco = Number(st.wco?.z);
        const wz = Number(st.wpos?.z);
        const ready = st.activeState === 'Idle' && Number.isFinite(wco) && (!atCurrent || Math.abs(wz) < 0.005);
        if (ready && last !== null && Math.abs(wco - last) < 1e-4) return wco;
        last = ready ? wco : null;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Could not read the work offset (WCO) from the controller status.');
}

async function probePin() {
    const rs = await getReduxState();
    return !!rs?.controller?.state?.status?.pinState?.P;
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
    state.confirmClear = false;
    const s = state.s;
    const grid = gridOf(s);
    const errs = [...validateGrid(grid), ...validateScanSettings(s)];
    if (errs.length) { setMsg('err', errs.join('\n')); return; }

    let m;
    try {
        m = await readMachine();
    } catch (e) {
        setMsg('err', e.message);
        return;
    }
    if (!m.connected) { setMsg('err', 'Connect to the machine first.'); return; }
    if (m.activeState !== 'Idle') { setMsg('err', `Machine is ${m.activeState}. It must be Idle (unlock / home first).`); return; }

    if (!(resume && state.map && sameGrid(state.map, grid) && !isComplete(state.map) && Number.isFinite(state.map.z[anchorIdx(state.map)]))) {
        state.map = createHeightMap(grid);
        resume = false;
    }
    const map = state.map;

    state.scanning = true;
    state.abort = false;
    setMsg('info', resume ? 'Resuming scan…' : `Scanning ${map.z.length} points…`);
    render();

    const io = {
        send: sendLine,
        probePin,
        readWcoZ,
        readWorkZ: async () => {
            const st = (await getReduxState())?.controller?.state?.status ?? {};
            const z = Number(st.wpos?.z);
            return st.activeState === 'Idle' && Number.isFinite(z) ? z : null;
        },
        aborted: () => state.abort,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log,
        status: (text) => { setMsg('info', text); machine.setBusy(true, 'Autolevel scan').catch(() => {}); },
        onPoint: (p, zw) => {
            state.current = p;
            log(`#${p.idx} X${fmt(p.x, 3)} Y${fmt(p.y, 3)} → Z${fmt(zw)}`);
            saveMap();
            updateProgress();
            renderHeat();
            drawOverlay();
        },
    };

    try {
        await machine.setBusy(true, 'Autolevel scan');
        await runScan(io, s, map, gridPoints(grid), { resume, touchTest: s.probeTest });
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
        updateShadow();
    } catch (e) {
        state.file = null;
        setMsg('err', e.message);
    }
    render();
}

/**
 * The loaded job's cutting moves as one Path2D in mm, drawn under the probe
 * preview. Rebuilt only when the loaded file changes.
 */
function updateShadow() {
    const f = state.file;
    const key = f ? `${f.name}:${f.content.length}` : null;
    if (state.shadow?.key === key) return;
    if (!f) { state.shadow = null; return; }
    const path = new Path2D();
    for (const pl of cutPaths(f.content)) {
        pl.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    }
    state.shadow = { key, path };
}

/** The probe area was set from the file bounds (plus margin) and hasn't been edited since. */
function usingFileBounds() {
    const b = state.s.fileBbox;
    if (!b) return false;
    const f = fileBoundsWith(state.s.margin || 0);
    return ['xmin', 'xmax', 'ymin', 'ymax'].every((k) => Math.abs(state.s[k] - f[k]) < 1e-6);
}

function fileBoundsWith(m) {
    const b = state.s.fileBbox;
    return { xmin: round3(b.xmin - m), xmax: round3(b.xmax + m), ymin: round3(b.ymin - m), ymax: round3(b.ymax + m) };
}

function applyFileBounds() {
    Object.assign(state.s, fileBoundsWith(state.s.margin || 0));
}

/** Re-applies a changed margin, but only while the area is still the one the file bounds produced. */
function onMarginChange(oldMargin) {
    if (!state.s.fileBbox) return;
    const prev = fileBoundsWith(oldMargin || 0);
    if (!['xmin', 'xmax', 'ymin', 'ymax'].every((k) => Math.abs(state.s[k] - prev[k]) < 1e-6)) return;
    applyFileBounds();
    saveSettings();
    render();
}

async function useFileBounds() {
    try {
        const { file } = await readMachine();
        if (!file?.fileLoaded) { setMsg('err', 'No G-code file is loaded.'); return; }
        const { min, max } = file.bbox;
        state.s.fileBbox = { xmin: min.x, xmax: max.x, ymin: min.y, ymax: max.y };
        applyFileBounds();
        saveSettings();
        setMsg('info', `Grid set to file bounds ±${state.s.margin || 0} mm.`);
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
    let src = f;
    if (f.content.includes('(Autoleveled by')) {
        if (!state.source || state.source.leveledName.toLowerCase() !== String(f.name).toLowerCase()) {
            setMsg('err', `${f.name} is already levelled. Levelling it again would apply the height map twice. Load the original G-code file and press Apply.`);
            render();
            return;
        }
        src = state.source;
    }
    try {
        const r = levelGcode(src.content, state.map, { segment: state.s.segment, zeroAt: state.s.zeroAt });
        const name = String(src.name || 'job.nc').replace(/(\.[^.]+)?$/, (ext) => `_leveled${ext || '.nc'}`);
        await gcode.loadToVisualizer(r.gcode, name);
        state.source = { name: src.name, content: src.content, leveledName: name };
        const w = r.warnings.length ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : '';
        setMsg(r.warnings.length ? 'warn' : 'ok', `${src === f ? '' : `Re-levelled the original ${src.name}. `}Loaded ${name}: ${r.stats.levelled} levelled moves (${r.stats.arcs} arcs linearised).${w}`);
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

/** Small "?" marker that shows `tip` on hover. */
const tipMark = (tip) => (tip ? h('span', { className: 'q', 'data-tip': tip, onClick: (e) => e.preventDefault() }, '?') : null);
/** Label text with help: an icon that shows large with the tip on hover, or a "?" mark. */
const tipLabel = (text, tip, ic) => (ic ? h('span', { className: 'lt' }, icon(ic, tip ?? ''), text) : h('span', {}, text, tipMark(tip)));

function num(key, label, { step = 'any', min, int = false, tip, after, icon: ic } = {}) {
    return h('label', { className: 'f' }, tipLabel(label, tip, ic),
        h('input', {
            type: 'number', step, min, value: state.s[key], disabled: state.scanning,
            onChange: (e) => {
                const old = state.s[key];
                const v = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
                if (Number.isFinite(v)) { state.s[key] = v; saveSettings(); after?.(old); }
                else e.target.value = state.s[key];
                updateDerived();
                drawOverlay();
            },
        }));
}

function chk(key, label, after, tip) {
    return h('label', { className: 'chk' },
        h('input', { type: 'checkbox', checked: !!state.s[key], onChange: (e) => { state.s[key] = e.target.checked; saveSettings(); after?.(); } }),
        tipLabel(label, tip));
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
    const perPoint = (s.clearance + s.maxBelow / 2) / s.feed * 60 + (s.slowFeed > 0 ? (s.backoff * 2) / s.slowFeed * 60 : 0) + 2;
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

/** What the "Z0 set at" choice means for this map, with X0 Y0's height when known. */
function zeroNote(map) {
    const z = state.s.zeroAt;
    if (z === 'absolute') return 'Keep the work Z0 the scan used. Don\'t re-zero Z before running the levelled job.';
    if (z === 'scan') {
        const p = map && gridPoints(map).find((q) => q.idx === anchorIdx(map));
        return `After a bit change, zero Z on the copper at the grid's middle point${p ? `, X${fmt(p.x, 2)} Y${fmt(p.y, 2)}` : ''} (where the scan probed first).`;
    }
    let extra = '';
    if (map && isComplete(map)) {
        const h = zeroHeight(map, 'origin');
        extra = h.beyond > 0.01
            ? ` ⚠ X0 Y0 is outside the probed area: probe an area that includes it.`
            : ` Copper at X0 Y0 is ${fmt(h.z - map.z[anchorIdx(map)], 3)} mm from the grid's middle point.`;
    }
    return `After a bit change, zero Z on the copper at X0 Y0 (gSender's probe, plate thickness 0 on the board copper). A scan that sets Z0 also moves it to X0 Y0 when it finishes.${extra}`;
}

function renderHeat() {
    const box = $('#heat');
    if (!box) return;
    box.replaceChildren();
    // Same rule as the visualizer: the stored map while it matches the Setup
    // grid (or a scan is running), otherwise the points a new scan would probe.
    const setupGrid = validateGrid(gridOf(state.s)).length ? null : gridOf(state.s);
    const map = state.map && (state.scanning || !setupGrid || sameGrid(state.map, setupGrid)) ? state.map : null;
    const grid = map ?? setupGrid;
    if (!grid) { box.append(h('div', { className: 'note' }, 'No height map yet. Set a valid probe area in Setup to preview the points.')); return; }

    const st = map ? mapStats(map) : null;
    const ref = map ? refZ() : 0;
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
    const aspect = (grid.ymax - grid.ymin) / (grid.xmax - grid.xmin);
    const cssH = Math.max(80, Math.min(240, cssW * aspect));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, pad = 12 * dpr;
    const toPx = (x, y) => [pad + ((x - grid.xmin) / (grid.xmax - grid.xmin)) * (W - 2 * pad), H - pad - ((y - grid.ymin) / (grid.ymax - grid.ymin)) * (H - 2 * pad)];
    const norm = (z) => (st && st.range > 0 ? (z - st.min) / st.range : 0.5);
    const css = getComputedStyle(document.documentElement);
    const textC = css.getPropertyValue('--text').trim() || '#1f2328';
    const haloC = css.getPropertyValue('--panel').trim() || '#f4f5f7';
    const accentC = css.getPropertyValue('--accent').trim() || '#0a9e78';

    if (map && isComplete(map)) {
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

    // The job's footprint when the area comes from the file bounds: its
    // outline box, and the cutting moves of the loaded file.
    if (usingFileBounds()) {
        const b = state.s.fileBbox;
        const [x0, y0] = toPx(b.xmin, b.ymax), [x1, y1] = toPx(b.xmax, b.ymin);
        ctx.save();
        ctx.fillStyle = textC;
        ctx.globalAlpha = 0.07;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = textC;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        if (state.shadow) {
            const sx = (W - 2 * pad) / (grid.xmax - grid.xmin), sy = (H - 2 * pad) / (grid.ymax - grid.ymin);
            ctx.translate(pad - grid.xmin * sx, H - pad + grid.ymin * sy);
            ctx.scale(sx, -sy);
            ctx.lineWidth = dpr / Math.min(sx, sy);
            ctx.globalAlpha = 0.5;
            ctx.stroke(state.shadow.path);
        }
        ctx.restore();
    }

    // Probe order: the anchor (first probe, sets Z0) then the serpentine.
    const pts = gridPoints(grid);
    const measured = map && Number.isFinite(map.z[anchorIdx(map)]);
    const anchor = measured ? pts.find((p) => p.idx === anchorIdx(map)) : centerPoint(pts);
    const order = probeOrder(pts, anchor);

    ctx.save();
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = textC;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    order.forEach((p, i) => { const [px, py] = toPx(p.x, p.y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.stroke();
    ctx.restore();

    for (const p of pts) {
        const z = map ? map.z[p.idx] : NaN;
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
    // X0 Y0, where you zero Z for the job (default "Z0 set at").
    if (grid.xmin <= 0 && grid.xmax >= 0 && grid.ymin <= 0 && grid.ymax >= 0) {
        const [ox, oy] = toPx(0, 0);
        ctx.beginPath();
        ctx.arc(ox, oy, 3.5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#e5484d';
        ctx.fill();
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.stroke();
    }

    const [ax, ay] = toPx(anchor.x, anchor.y);
    ctx.beginPath();
    ctx.arc(ax, ay, 6.5 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = accentC;
    ctx.stroke();

    // Numbers, when the points are far enough apart to read them; the first
    // and last always.
    const gap = Math.min(
        grid.nx > 1 ? (W - 2 * pad) / (grid.nx - 1) : Infinity,
        grid.ny > 1 ? (H - 2 * pad) / (grid.ny - 1) : Infinity);
    const all = gap >= 18 * dpr;
    ctx.font = `600 ${9 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    order.forEach((p, i) => {
        if (!all && i !== 0 && i !== order.length - 1) return;
        const [px, py] = toPx(p.x, p.y);
        const label = String(i + 1);
        const tw = ctx.measureText(label).width;
        const tx = Math.min(px + 4 * dpr, W - tw - 1), ty = Math.max(py - 3 * dpr, 10 * dpr);
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = haloC;
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = i === 0 ? accentC : textC;
        ctx.fillText(label, tx, ty);
    });

    canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
        const x = grid.xmin + ((px - pad) / (W - 2 * pad)) * (grid.xmax - grid.xmin);
        const y = grid.ymin + ((H - pad - py) / (H - 2 * pad)) * (grid.ymax - grid.ymin);
        if (x < grid.xmin || x > grid.xmax || y < grid.ymin || y > grid.ymax) { tip.style.display = 'none'; return; }
        let text = `X${fmt(x, 2)} Y${fmt(y, 2)}`;
        if (map && isComplete(map)) text += `  Z${fmt(heightAt(map, x, y).z - ref, 3)}`;
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
    box.append(h('div', { className: 'note' },
        `Numbers are the probe order. Ringed: probed first, sets Z0${state.s.zeroFirst && state.s.zeroAt === 'origin' ? ' (moved to X0 Y0 when the scan finishes)' : ''}. Red dot: X0 Y0 (zero Z here).${usingFileBounds() ? ' Shaded: the loaded job.' : ''}`));
}

function tabSetup() {
    const s = state.s;
    return [
        h('div', { className: 'section' },
            h('h4', {}, 'Probe area (work coordinates, mm)'),
            h('div', { className: 'grid2' },
                num('xmin', 'X min', { tip: 'Left edge of the probed area (work X, mm).' }),
                num('xmax', 'X max', { tip: 'Right edge of the probed area (work X, mm).' }),
                num('ymin', 'Y min', { tip: 'Front edge of the probed area (work Y, mm).' }),
                num('ymax', 'Y max', { tip: 'Back edge of the probed area (work Y, mm).' }),
                num('nx', 'X points', { step: 1, min: 2, int: true, tip: 'Probe points across X, including both edges. More points = finer map, longer scan.' }),
                num('ny', 'Y points', { step: 1, min: 2, int: true, tip: 'Probe points across Y, including both edges. More points = finer map, longer scan.' })),
            h('div', { className: 'row' },
                h('button', { className: 'b', disabled: state.scanning, onClick: useFileBounds }, 'Use loaded file bounds'),
                tipMark('Set the probe area to the loaded G-code outline, expanded by Margin on every side.'),
                h('div', { style: 'width:104px' }, num('margin', 'Margin', {
                    after: onMarginChange,
                    icon: 'b-margin',
                    tip: 'Extra mm added around the job when using file bounds. Changing it updates the area while it still matches the file bounds. 0 or negative keeps probes on the board when the job runs to its edge.',
                }))),
            h('div', { className: 'note', id: 'derived' })),
        h('div', { className: 'section' },
            h('h4', {}, 'Probing'),
            h('div', { className: 'grid2' },
                num('clearance', 'Travel height', { icon: 's-probeheight', tip: 'How far (mm) above the copper at the middle point (the first probe) the bit travels between points (0.5–10). Must clear clamps.' }),
                num('maxBelow', 'Max depth below middle point', { icon: 's-maxbelow', tip: 'How far (mm) below the copper at the middle point any later probe may go before the scan stops (0.1–3). A board is never off by more than this.' }),
                num('firstTravel', 'First probe max travel', { tip: 'The first probe searches down at most this far (mm) from where the bit starts (1–25). Start with the bit a few mm above the board.' }),
                num('feed', 'Probe feed', { min: 1, tip: 'Feed (mm/min) of the first, fast probe move.' }),
                num('slowFeed', 'Slow re-probe feed (0 = off)', { min: 0, tip: 'After contact, back off and probe again at this slower feed (mm/min) for a more accurate reading. 0 skips it.' }),
                num('backoff', 'Re-probe back-off', { icon: 's-backoff', tip: 'How far (mm) to lift after the first contact before the slow re-probe.' })),
            chk('zeroFirst', 'Zero Z during the scan', null, 'The scan zeroes Z on the copper at its first probe, the grid point nearest the middle. With "Z0 set at: Job origin X0 Y0" (Levelling), it then moves Z0 to the copper at X0 Y0 when it finishes, so the scanning bit can cut without re-zeroing. Off: work Z0 is left as it was.'),
            chk('probeTest', 'Touch-test the probe before scanning', null, 'Before anything moves, wait until you touch the probe lead to the bit, so a broken probe circuit is caught first.'),
            h('div', { className: 'note' }, 'Jog the bit a few mm above the board and clip the probe lead to the board copper. The scan probes the middle of the grid first (always on the board, even when the margin isn\'t), then the rest. Heights are measured from that middle point; where Z0 has to be for the job is set under Levelling.')),
        h('div', { className: 'section' },
            h('h4', {}, 'Visualizer'),
            chk('showOverlay', 'Show grid / map on visualizer', drawOverlay, 'Draw probe points (or the probed heights) in the gSender visualizer.'),
            chk('showLabels', 'Show height labels', drawOverlay, 'Show each point\'s measured height next to it.'),
            chk('showMesh', 'Show interpolated mesh', drawOverlay, 'Draw interpolated lines between points of a complete map.'),
            h('div', { className: 'row' },
                h('button', { className: 'b', onClick: () => viewer.camera.set('top').catch(() => {}) }, 'Top view'),
                h('button', { className: 'b', onClick: () => viewer.camera.set('3d').catch(() => {}) }, '3D view'))),
    ];
}

/** Clearing deletes probed data, so it asks first (inline: the iframe has no confirm()). */
function askClear() { state.confirmClear = true; render(); }

function clearConfirm() {
    const n = state.map ? state.map.z.filter(Number.isFinite).length : 0;
    return h('div', { className: 'confirm' },
        h('div', {}, h('b', {}, 'Clear the height map? '),
            `The ${n} probed point${n === 1 ? '' : 's'} will be deleted and can't be restored (export it first if you may need it). A levelled job already loaded in gSender is not changed.`),
        h('div', { className: 'row' },
            h('button', {
                className: 'b danger',
                onClick: () => {
                    state.map = null;
                    state.confirmClear = false;
                    storage.delete('map').catch(() => {});
                    setMsg('info', 'Height map cleared.');
                    render();
                    drawOverlay();
                },
            }, 'Clear map'),
            h('button', { className: 'b', onClick: () => { state.confirmClear = false; render(); } }, 'Cancel')));
}

function tabProbe() {
    const canResume = state.map && !isComplete(state.map) && sameGrid(state.map, gridOf(state.s)) && state.map.z.some(Number.isFinite);
    const stale = state.map && !sameGrid(state.map, gridOf(state.s));
    return [
        h('div', { className: 'row' },
            state.scanning
                ? h('button', { className: 'b danger', onClick: stopScan }, '■ Stop')
                : h('button', { className: 'b primary withic', onClick: () => startScan() }, icon('b-probe'), state.map ? 'New scan' : 'Start scan'),
            !state.scanning && canResume ? h('button', { className: 'b', onClick: () => startScan({ resume: true }) }, 'Resume') : null,
            !state.scanning && state.map ? h('button', { className: 'b grow0', onClick: askClear }, 'Clear') : null),
        state.confirmClear ? clearConfirm() : null,
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
        const beyond = Math.max(map.xmin - min.x, max.x - map.xmax, map.ymin - min.y, max.y - map.ymax);
        if (beyond > 0.01) {
            coverage = h('div', { className: 'msg warn' },
                `Job (X${fmt(min.x, 2)}..${fmt(max.x, 2)} Y${fmt(min.y, 2)}..${fmt(max.y, 2)}) reaches up to ${fmt(beyond, 2)} mm past the probed area `
                + `(X${fmt(map.xmin, 2)}..${fmt(map.xmax, 2)} Y${fmt(map.ymin, 2)}..${fmt(map.ymax, 2)}); the nearest edge heights are used there. `
                + 'Fine for a cutout or drilling. For copper jobs, probe again with Margin set to at least that distance.');
        }
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
                num('segment', 'Max segment (mm)', { min: 0.1, tip: 'Long moves are split into pieces no longer than this so Z can follow the surface. Smaller = more accurate, larger file.' }),
                h('label', { className: 'f' }, tipLabel('Z0 set at', 'Where work Z0 is on the copper when the levelled job runs. The map is shifted so that spot cuts at the programmed depth.'),
                    h('select', {
                        onChange: (e) => { state.s.zeroAt = e.target.value; saveSettings(); render(); drawOverlay(); },
                    },
                    h('option', { value: 'origin', selected: state.s.zeroAt === 'origin' }, 'Job origin X0 Y0'),
                    h('option', { value: 'scan', selected: state.s.zeroAt === 'scan' }, 'Grid middle (first probe)'),
                    h('option', { value: 'absolute', selected: state.s.zeroAt === 'absolute' }, 'Z0 used during the scan')))),
            h('div', { className: 'note' }, zeroNote(map)),
            h('div', { className: 'row' },
                h('button', { className: 'b primary withic', disabled: !isComplete(map) || state.scanning, onClick: applyLevel }, icon('b-level'), 'Apply & load levelled G-code'))),
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
            state.confirmClear ? clearConfirm() : h('div', { className: 'row' },
                h('button', { className: 'b', disabled: !map || state.scanning, onClick: askClear }, 'Clear map'))),
    ];
}

function render() {
    const root = $('#root');
    const status = h('div', { className: 'conn', id: 'conn' });
    const tabs = h('div', { className: 'tabs' },
        ...[['setup', 'Setup'], ['probe', 'Probe'], ['apply', 'Apply']].map(([id, label]) =>
            h('button', { className: state.tab === id ? 'active' : '', onClick: () => { state.tab = id; state.confirmClear = false; if (id !== 'setup') refreshFile(); else render(); } }, label)));
    const body = state.tab === 'setup' ? tabSetup() : state.tab === 'probe' ? tabProbe() : tabApply();
    root.replaceChildren(tabs, status, h('div', { id: 'msg' }), ...body.filter(Boolean));
    renderConn();
    renderMsg();
    updateDerived();
    updateProgress();
    renderHeat();
    const lg = $('#log');
    if (lg) lg.scrollTop = lg.scrollHeight;
}

/**
 * Hover help for elements with `data-tip`, shown after a 1 s hover. Native
 * `title` tooltips don't show inside gSender's plugin iframe, so one shared
 * element is positioned on mouseover only (no per-move work).
 */
function setupTips() {
    const tip = h('div', { className: 'hovertip' });
    document.body.append(tip);
    let cur = null;
    let timer = 0;
    const show = (el) => {
        if (!el.isConnected) return;
        tip.textContent = el.dataset.tip;
        tip.style.display = 'block';
        const r = el.getBoundingClientRect();
        const w = tip.offsetWidth, ht = tip.offsetHeight;
        const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        tip.style.left = `${Math.max(4, Math.min(r.left, vw - w - 4))}px`;
        tip.style.top = `${r.bottom + 4 + ht > vh ? Math.max(4, r.top - ht - 4) : r.bottom + 4}px`;
    };
    const hide = () => { clearTimeout(timer); tip.style.display = 'none'; };
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest?.('[data-tip]');
        if (el === cur) return;
        cur = el;
        hide();
        if (el) timer = setTimeout(() => show(el), 1000);
    });
    document.addEventListener('mouseleave', () => { cur = null; hide(); });
}

async function pollConnection() {
    try {
        const ctx = await machine.getContext();
        const c = !!ctx?.connected;
        if (c !== state.connected) {
            state.connected = c;
            renderConn();
        }
    } catch { /* bridge not ready */ }
}

/** Machine connection and live probe input, under the tabs. */
function renderConn() {
    const el = $('#conn');
    if (!el) return;
    const probe = !state.connected || state.probeOn === null
        ? h('span', { className: 'pin' }, '○ Probe')
        : state.probeOn ? h('span', { className: 'pin on' }, '● Probe touching') : h('span', { className: 'pin' }, '○ Probe open');
    el.replaceChildren(h('span', { className: state.connected ? 'on' : '' }, state.connected ? '● Connected' : '○ Not connected'), probe);
}

// The panel is a visualizer overlay, loaded on every gSender page; read the
// probe input (from gSender's machine state, ~30 KB a read) only while the
// panel is on screen and the machine is connected.
function panelVisible() {
    if (document.hidden) return false;
    try {
        const f = window.frameElement;
        return !f || f.getClientRects().length > 0;
    } catch {
        return true;
    }
}
async function pollProbe() {
    let next = 1000;
    try {
        if (state.connected && panelVisible()) {
            next = 250;
            const on = await probePin();
            if (on !== state.probeOn) { state.probeOn = on; renderConn(); }
        } else if (state.probeOn !== null) {
            state.probeOn = null;
            renderConn();
        }
    } catch { /* bridge not ready */ }
    setTimeout(pollProbe, next);
}

async function init() {
    try {
        const saved = await storage.get('settings', null);
        if (saved && typeof saved === 'object') {
        // `reference` ('first' | 'absolute') became `zeroAt`; 'first' moves to the job origin.
        const { reference, ...rest } = saved;
        state.s = { ...DEFAULTS, ...rest };
        if (!ZERO_AT[state.s.zeroAt]) state.s.zeroAt = reference === 'absolute' ? 'absolute' : 'origin';
    }
        const map = await storage.get('map', null);
        if (map && Array.isArray(map.z)) state.map = map;
    } catch (e) {
        state.msg = { kind: 'err', text: `Storage unavailable: ${e.message}` };
    }
    if (state.map) state.tab = isComplete(state.map) ? 'apply' : 'probe';
    render();
    setupTips();
    installIcons();
    if (state.tab !== 'setup') refreshFile();
    clipOverlayAroundPanel();
    excludeOverlayFromRecording();
    drawOverlay();
    pollConnection();
    setInterval(pollConnection, 2000);
    pollProbe();
    window.addEventListener('resize', debounce(renderHeat, 150));
}

init();
