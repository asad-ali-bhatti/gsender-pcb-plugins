// A small grblHAL simulator on TCP, for testing gSender plugins without a
// machine: gSender connects to it as a network controller (IP 127.0.0.1).
//
//   node scripts/grblhal-sim.mjs [--port 2323] [--speed 10] [--homing] [--trace]
//
// It answers $I, $$, $#, $G, status reports and realtime commands, plans
// G0/G1/G2/G3/G4 moves in simulated time (--speed multiplies the clock), probes
// a board with G38.2, and keeps work offsets (G10 L2/L20, G92).
// A control HTTP server on port+1 injects faults:
//   GET /state            current state as JSON
//   GET /disconnect       drop the TCP client; the machine keeps running (?hold=1: feed hold, like the bridge)
//   GET /reset            soft reset (Ctrl-X): ALARM:3 if moving
//   GET /powercycle       drop the client, forget position and offsets set by G92
//   GET /limit?axis=X     hard limit trip (ALARM:1)
//   GET /probe?ms=1000    probe input on for a while (the screwdriver touch test)
// The banner and $I carry "SIM" so a client can tell it from a real controller.
import net from 'node:net';
import http from 'node:http';

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
};
const PORT = Number(arg('port', 2323));
const SPEED = Number(arg('speed', 10));
const HOMING = !!arg('homing', false);
const TRACE = !!arg('trace', false);       // log every line received
const TRAVEL = { x: 300, y: 200, z: 60 };     // 3020 envelope; homed at max, so MPos runs negative
const SURFACE_Z = -40;                         // machine Z of the copper at the board centre
const PLANNER = 100;
const RX = 1024;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function freshMachine() {
    return {
        state: 'Idle', sub: null,          // Idle | Run | Hold | Alarm | Home | Jog
        alarm: null,
        pos: { x: 0, y: 0, z: 0 },          // machine position
        wcs: { G54: { x: 0, y: 0, z: 0 } }, // persisted offsets (like grblHAL NVS)
        g92: { x: 0, y: 0, z: 0 },
        modal: { motion: 'G0', abs: true, units: 'G21', wcs: 'G54', feed: 0, spindle: 'M5', rpm: 0 },
        tool: 0,
        planner: [],                       // blocks waiting or running
        waiting: [],                       // lines received but not yet planned (planner full)
        prb: { x: 0, y: 0, z: 0, ok: 0 },
        homed: false,
        probeTouch: false,
        syncing: false,                    // a G38.x or G4 holds its ok (and later lines) until it is done
        reportCount: 0,
    };
}
let m = freshMachine();
if (HOMING) m.state = 'Alarm', m.alarm = 11; // grblHAL: homing required after power-up
let wcsSaved = structuredClone(m.wcs);     // survives power cycles
let client = null;

const send = (s) => { if (client && !client.destroyed) client.write(s + '\r\n'); };
const fmt = (n) => n.toFixed(3);
const wco = () => {
    const o = m.wcs[m.modal.wcs] ?? { x: 0, y: 0, z: 0 };
    return { x: o.x + m.g92.x, y: o.y + m.g92.y, z: o.z + m.g92.z };
};
const surfaceAt = (x, y) => SURFACE_Z + 0.05 * Math.sin(x / 20) * Math.cos(y / 15);

function status() {
    const st = m.state === 'Hold' ? `Hold:${m.sub ?? 0}` : m.state === 'Alarm' ? 'Alarm' : m.state;
    const free = PLANNER - m.planner.length;
    const cur = m.planner[0];
    let s = `<${st}|MPos:${fmt(m.pos.x)},${fmt(m.pos.y)},${fmt(m.pos.z)}|Bf:${free},${RX}|FS:${cur?.feed && m.state === 'Run' ? Math.round(cur.feed) : 0},${m.modal.spindle === 'M5' ? 0 : m.modal.rpm}`;
    const pins = (m.probeTouch ? 'P' : '');
    if (pins) s += `|Pn:${pins}`;
    if (m.reportCount++ % 10 === 0) { const o = wco(); s += `|WCO:${fmt(o.x)},${fmt(o.y)},${fmt(o.z)}`; }
    return s + '>';
}

function settingsList() {
    const s = {
        0: 5, 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 10: 511, 11: 0.01, 12: 0.002, 13: 0,
        20: 0, 21: 0, 22: HOMING ? 1 : 0, 23: 0, 24: 100, 25: 1000, 26: 250, 27: 2,
        100: 800, 101: 800, 102: 800, 110: 3000, 111: 3000, 112: 1000,
        120: 200, 121: 200, 122: 200, 130: TRAVEL.x, 131: TRAVEL.y, 132: TRAVEL.z,
    };
    return Object.entries(s).map(([k, v]) => `$${k}=${v}`);
}

function alarm(code, why) {
    m.state = 'Alarm'; m.alarm = code; m.sub = null;
    m.planner = []; m.waiting = []; m.syncing = false;
    send(`ALARM:${code}`);
    log(`ALARM:${code} ${why}`);
}

function softReset() {
    const moving = m.state === 'Run' || m.state === 'Jog' || (m.state === 'Hold' && m.sub === 1);
    m.planner = []; m.waiting = []; m.syncing = false; m.g92 = { x: 0, y: 0, z: 0 };
    m.modal = { ...m.modal, motion: 'G0', spindle: 'M5', feed: 0 };
    m.probeTouch = false;
    if (moving) { m.homed = false; alarm(3, 'reset while moving'); }
    else if (m.state !== 'Alarm') { m.state = 'Idle'; m.sub = null; }
    send("GrblHAL 1.1f ['$' or '$HELP' for help] SIM");
    if (m.state === 'Alarm') send(`[MSG:'$H'|'$X' to unlock]`);
}

// --- G-code -----------------------------------------------------------------

function words(line) {
    const out = [];
    const re = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
    let w;
    while ((w = re.exec(line))) out.push([w[1], Number(w[2])]);
    return out;
}

// Parse one block into zero or more planner blocks; returns an error code or 0.
function execLine(raw) {
    const line = raw.toUpperCase().replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim();
    if (!line || line === '%') return 0;
    if (line.startsWith('$')) return dollar(line);
    if (m.state === 'Alarm') return 9;
    const ws = words(line);
    const has = (l) => ws.some(([k]) => k === l);
    const val = (l) => ws.find(([k]) => k === l)?.[1];
    const g = ws.filter(([k]) => k === 'G').map(([, v]) => v);
    const mc = ws.filter(([k]) => k === 'M').map(([, v]) => v);
    const scale = m.modal.units === 'G20' ? 25.4 : 1;
    if (g.includes(20)) m.modal.units = 'G20';
    if (g.includes(21)) m.modal.units = 'G21';
    if (g.includes(90)) m.modal.abs = true;
    if (g.includes(91)) m.modal.abs = false;
    for (const n of [54, 55, 56, 57, 58, 59]) if (g.includes(n)) { m.modal.wcs = `G${n}`; m.wcs[m.modal.wcs] ??= { x: 0, y: 0, z: 0 }; }
    if (has('F')) m.modal.feed = val('F') * scale;
    if (has('S')) m.modal.rpm = val('S');
    if (has('T')) m.tool = val('T');
    const axes = ['X', 'Y', 'Z'].filter(has);
    // Position the planner will be at after the queued blocks.
    const at = m.planner.length ? { ...m.planner.at(-1).to } : { ...m.pos };
    const o = wco();
    const target = { ...at };
    for (const a of axes) {
        const k = a.toLowerCase();
        const v = val(a) * scale;
        target[k] = m.modal.abs ? v + o[k] : at[k] + v;
    }
    if (g.includes(10)) {
        const L = val('L'), P = val('P') || 1;
        const key = `G${53 + P}`;
        const cur = m.wcs[key] ?? { x: 0, y: 0, z: 0 };
        for (const a of axes) {
            const k = a.toLowerCase(), v = val(a) * scale;
            cur[k] = L === 20 ? (m.planner.length ? at[k] : m.pos[k]) - v : v;
        }
        m.wcs[key] = cur; wcsSaved = structuredClone(m.wcs);
        return 0;
    }
    if (g.includes(92)) {
        for (const a of axes) { const k = a.toLowerCase(); m.g92[k] = m.pos[k] - (m.wcs[m.modal.wcs][k]) - val(a) * scale; }
        return 0;
    }
    // Like Grbl, G4 and G38.x wait for the planner to empty and answer ok only when they are done.
    if (g.includes(4)) { m.planner.push({ kind: 'dwell', t: (val('P') || 0) * 1000, to: at, line: raw, sync: true }); m.syncing = true; return -1; }
    for (const n of [0, 1, 2, 3]) if (g.includes(n)) m.modal.motion = `G${n}`;
    const probe = g.find((v) => v >= 38.2 && v <= 38.5);
    if (probe) {
        if (!m.modal.feed) return 22;
        m.planner.push({ kind: 'probe', from: at, to: target, feed: m.modal.feed, line: raw, sync: true });
        m.syncing = true;
        return -1;
    }
    if (g.includes(28) || g.includes(30)) {
        m.planner.push({ kind: 'move', from: at, to: { ...at, z: 0 }, feed: 3000, line: raw });
        return 0;
    }
    if (g.includes(53) && axes.length) {
        const t = { ...at };
        for (const a of axes) t[a.toLowerCase()] = val(a) * scale;
        m.planner.push({ kind: 'move', from: at, to: t, feed: m.modal.motion === 'G0' ? 3000 : m.modal.feed, line: raw });
        return 0;
    }
    for (const n of mc) {
        if (n === 3 || n === 4) m.modal.spindle = `M${n}`;
        if (n === 5) m.modal.spindle = 'M5';
        if (n === 0 || n === 1) m.planner.push({ kind: 'pause', to: at, line: raw });
        if (n === 2 || n === 30) m.planner.push({ kind: 'end', to: at, line: raw });
    }
    if (axes.length) {
        const motion = m.modal.motion;
        if (motion !== 'G0' && !m.modal.feed) return 22;
        let len = Math.hypot(target.x - at.x, target.y - at.y, target.z - at.z);
        if (motion === 'G2' || motion === 'G3') len *= 1.3; // rough arc length; only timing depends on it
        m.planner.push({ kind: 'move', from: at, to: target, len, feed: motion === 'G0' ? 3000 : m.modal.feed, line: raw });
    }
    return 0;
}

function dollar(line) {
    if (line === '$I') {
        send('[VER:1.1f.20260928:SIM]');
        send('[OPT:VNDSL,100,512]');
        send('[NEWOPT:ENUMS,RT+,HOME,TC,SED]');
        send('[FIRMWARE:grblHAL]');
        send('[DRIVER:SIM]');
        return 0;
    }
    if (line === '$$') { settingsList().forEach(send); return 0; }
    if (line === '$#') {
        for (const n of [54, 55, 56, 57, 58, 59]) { const o = m.wcs[`G${n}`] ?? { x: 0, y: 0, z: 0 }; send(`[G${n}:${fmt(o.x)},${fmt(o.y)},${fmt(o.z)}]`); }
        send(`[G28:0.000,0.000,0.000]`); send(`[G30:0.000,0.000,0.000]`);
        send(`[G92:${fmt(m.g92.x)},${fmt(m.g92.y)},${fmt(m.g92.z)}]`);
        send('[TLO:0.000]');
        send(`[PRB:${fmt(m.prb.x)},${fmt(m.prb.y)},${fmt(m.prb.z)}:${m.prb.ok}]`);
        return 0;
    }
    if (line === '$G') {
        const md = m.modal;
        send(`[GC:${md.motion} ${md.wcs} G17 ${md.units} ${md.abs ? 'G90' : 'G91'} G94 G49 G98 G50 ${md.spindle} M9 T${m.tool} F${md.feed} S${md.rpm}]`);
        return 0;
    }
    if (line === '$X') {
        if (m.state === 'Alarm') { m.state = 'Idle'; m.alarm = null; send('[MSG:Caution: Unlocked]'); }
        return 0;
    }
    if (line === '$H') {
        if (!HOMING) return 5;
        m.state = 'Home';
        setTimeout(() => { m.pos = { x: 0, y: 0, z: 0 }; m.homed = true; m.state = 'Idle'; m.alarm = null; send('ok'); log('homed'); }, 3000 / SPEED);
        return -1; // ok is sent when homing finishes
    }
    if (line.startsWith('$J=')) {
        if (m.state === 'Alarm') return 9;
        const save = { ...m.modal };
        m.modal.abs = !line.includes('G91');
        const err = execLine(line.slice(3));
        m.modal = { ...save, feed: save.feed };
        if (!err && m.planner.length) m.planner.at(-1).jog = true;
        return err;
    }
    return 0; // other $ commands: accept
}

// --- motion -------------------------------------------------------------------

/** A block left the planner: a synchronous one (G4, G38.x) gets its ok now. */
function done(b) {
    if (b?.sync) { m.syncing = false; send('ok'); }
}

let last = Date.now();
setInterval(() => {
    const now = Date.now();
    let dt = (now - last) * SPEED; // simulated ms
    last = now;
    if (m.state === 'Alarm' || m.state === 'Home') return;
    if (m.state === 'Hold') { m.sub = 0; return; }
    while (dt > 0 && m.planner.length) {
        const b = m.planner[0];
        if (m.state !== 'Run' && m.state !== 'Jog') m.state = b.jog ? 'Jog' : 'Run';
        if (b.kind === 'dwell') {
            b.t -= dt; dt = 0;
            if (b.t <= 0) { dt = -b.t; done(m.planner.shift()); }
            continue;
        }
        if (b.kind === 'pause') { m.planner.shift(); m.state = 'Hold'; m.sub = 0; send('[MSG:Pgm Pause]'); return; }
        if (b.kind === 'end') { m.planner.shift(); m.modal.spindle = 'M5'; m.modal.wcs = 'G54'; m.g92 = { x: 0, y: 0, z: 0 }; continue; }
        // move or probe: advance along the segment
        b.done ??= 0;
        b.len ??= Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y, b.to.z - b.from.z);
        const step = (b.feed / 60000) * dt; // mm in dt
        const remain = b.len - b.done;
        const adv = Math.min(step, remain);
        b.done += adv;
        dt -= remain > 0 ? (adv / step) * dt : dt;
        const f = b.len ? b.done / b.len : 1;
        m.pos = { x: b.from.x + (b.to.x - b.from.x) * f, y: b.from.y + (b.to.y - b.from.y) * f, z: b.from.z + (b.to.z - b.from.z) * f };
        if (b.kind === 'probe' && m.pos.z <= surfaceAt(m.pos.x, m.pos.y)) {
            m.pos.z = surfaceAt(m.pos.x, m.pos.y);
            m.prb = { ...m.pos, ok: 1 };
            m.probeTouch = true;
            setTimeout(() => { m.probeTouch = false; }, 300);
            send(`[PRB:${fmt(m.pos.x)},${fmt(m.pos.y)},${fmt(m.pos.z)}:1]`);
            done(m.planner.shift());
            // Following queued blocks were planned from the old end point; restart them from here.
            if (m.planner[0]?.from) m.planner[0].from = { ...m.pos }, m.planner[0].len = undefined, m.planner[0].done = 0;
            continue;
        }
        if (b.done >= b.len) {
            if (b.kind === 'probe') { m.prb = { ...m.pos, ok: 0 }; send(`[PRB:${fmt(m.pos.x)},${fmt(m.pos.y)},${fmt(m.pos.z)}:0]`); alarm(5, 'probe did not trigger'); return; }
            done(m.planner.shift());
        }
        for (const k of ['x', 'y', 'z']) {
            const lo = -TRAVEL[k], hi = 0;
            if (m.pos[k] < lo - 1 || m.pos[k] > hi + 1) { alarm(1, `hard limit ${k.toUpperCase()}`); return; }
        }
    }
    // Lines held back while the planner was full get their ok now.
    while (m.waiting.length && m.planner.length < PLANNER && !m.syncing) {
        const raw = m.waiting.shift();
        const err = execLine(raw);
        if (err >= 0) send(err ? `error:${err}` : 'ok');
    }
    if (!m.planner.length && (m.state === 'Run' || m.state === 'Jog')) m.state = 'Idle';
}, 10);

// --- TCP --------------------------------------------------------------------

const server = net.createServer((sock) => {
    if (client) { log('new client replaces the old one'); client.destroy(); }
    client = sock;
    sock.setNoDelay(true);
    log(`client connected ${sock.remoteAddress}:${sock.remotePort}`);
    send("GrblHAL 1.1f ['$' or '$HELP' for help] SIM");
    if (m.state === 'Alarm' && m.alarm === 11) send(`[MSG:'$H'|'$X' to unlock]`);
    let buf = '';
    sock.on('data', (data) => {
        for (const byte of data) {
            if (byte === 0x3f) { send(status()); continue; }                // ?
            if (byte === 0x21) { if (m.state === 'Run') { m.state = 'Hold'; m.sub = 1; } continue; } // !
            if (byte === 0x7e) { if (m.state === 'Hold') { m.state = m.planner.length ? 'Run' : 'Idle'; m.sub = null; } continue; } // ~
            if (byte === 0x18) { buf = ''; softReset(); continue; }        // Ctrl-X
            if (byte === 0x85) { if (m.state === 'Jog') { m.planner = []; m.state = 'Idle'; } continue; } // jog cancel
            if (byte >= 0x80) continue;                                    // overrides etc.
            if (byte === 0x0a || byte === 0x0d) {
                const line = buf; buf = '';
                if (!line.trim()) continue;
                if (TRACE) log('<<', line.trim());
                // Like Grbl, nothing is read past a full planner or a running G4/G38.x, '$' lines included,
                // so replies stay in order (gSender polls $G every 500 ms).
                if (m.planner.length >= PLANNER || m.syncing || m.waiting.length) { m.waiting.push(line); continue; }
                const err = execLine(line);
                if (err >= 0) send(err ? `error:${err}` : 'ok');
                continue;
            }
            buf += String.fromCharCode(byte);
        }
    });
    const gone = (why) => { if (client === sock) { client = null; log(`client gone (${why}); machine state ${m.state}`); } };
    sock.on('close', () => gone('close'));
    sock.on('error', (e) => gone(e.message));
});
server.listen(PORT, '127.0.0.1', () => log(`grblHAL simulator on 127.0.0.1:${PORT} (speed ×${SPEED}${HOMING ? ', homing on' : ''}); control on http://127.0.0.1:${PORT + 1}/`));

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    switch (url.pathname) {
        case '/state':
            return reply({ state: m.state, sub: m.sub, alarm: m.alarm, pos: m.pos, wco: wco(), wcs: m.wcs, planner: m.planner.length, waiting: m.waiting.length, current: m.planner[0]?.line ?? null, homed: m.homed, connected: !!client, modal: m.modal });
        case '/disconnect': {
            // ?hold=1 also feed-holds a running job, as scripts/cnc_bridge.py does when its client goes away.
            const hold = url.searchParams.get('hold') === '1' && m.state === 'Run';
            if (hold) { m.state = 'Hold'; m.sub = 1; }
            client?.destroy(); client = null; log(`control: client dropped${hold ? ', job feed-held' : ''}`);
            return reply({ ok: true, held: hold });
        }
        case '/reset':
            softReset(); return reply({ ok: true, state: m.state });
        case '/limit':
            alarm(1, `hard limit ${url.searchParams.get('axis') ?? 'X'} (injected)`); return reply({ ok: true });
        case '/probe': {
            const ms = Number(url.searchParams.get('ms') ?? 1000);
            m.probeTouch = true;
            setTimeout(() => { m.probeTouch = false; }, ms);
            log(`control: probe input on for ${ms} ms`);
            return reply({ ok: true });
        }
        case '/powercycle': {
            client?.destroy(); client = null;
            m = freshMachine(); m.wcs = structuredClone(wcsSaved);
            if (HOMING) m.state = 'Alarm', m.alarm = 11;
            log('control: power cycled (position lost, G54 kept)');
            return reply({ ok: true });
        }
        default:
            res.writeHead(404).end();
    }
}).listen(PORT + 1, '127.0.0.1');
