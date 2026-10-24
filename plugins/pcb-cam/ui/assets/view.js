// 2D board view on a <canvas> (mm, y up). Canvas pixels aren't DOM, so
// gSender's session recorder never sees redraws; geometry is turned into
// Path2D objects once and reused for every frame.

import { geometry as G } from '../core/index.js';

const SCALE = G.SCALE;

/** Path2D for a clipper shape (paths of {X, Y} in clipper units), in mm. */
function shapePath(shape) {
    const p = new Path2D();
    for (const path of shape) {
        if (!path.length) continue;
        p.moveTo(path[0].X / SCALE, path[0].Y / SCALE);
        for (let i = 1; i < path.length; i++) p.lineTo(path[i].X / SCALE, path[i].Y / SCALE);
        p.closePath();
    }
    return p;
}

const pathCache = new WeakMap();
function cached(key, build) {
    let v = pathCache.get(key);
    if (!v) pathCache.set(key, (v = build()));
    return v;
}

function drillPaths(layer) {
    return cached(layer, () => {
        const holes = new Path2D();
        for (const h of layer.holes) {
            holes.moveTo(h.x + h.diameter / 2, h.y);
            holes.arc(h.x, h.y, h.diameter / 2, 0, Math.PI * 2);
        }
        const slots = layer.slots.map((s) => {
            const p = new Path2D();
            s.path.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
            return { p, width: s.diameter };
        });
        return { holes, slots };
    });
}

/** Path2D of one operation's cuts, mapped back from machine to file coordinates. */
export function toolpathPath(op, transform) {
    const { mirrorX = 0, shift = [0, 0] } = transform ?? {};
    const bottom = op.face === 'bottom';
    const fx = (x) => (bottom ? mirrorX - (x - shift[0]) : x - shift[0]);
    const fy = (y) => y - shift[1];
    const lines = new Path2D();
    const travel = new Path2D();
    const drills = [];
    const starts = []; // where each cut begins, in machine order (repeated depths counted once)
    let last = [fx(0), fy(0)];
    const reach = (x, y) => {
        if (Math.hypot(x - last[0], y - last[1]) < 0.01) return;
        travel.moveTo(last[0], last[1]);
        travel.lineTo(x, y);
        starts.push([x, y]);
    };
    for (const c of op.cuts) {
        if (c.kind === 'drill') {
            const at = [fx(c.x), fy(c.y)];
            reach(...at);
            drills.push(at);
            last = at;
            continue;
        }
        if (!c.points.length) continue;
        reach(fx(c.points[0][0]), fy(c.points[0][1]));
        c.points.forEach(([x, y], i) => (i ? lines.lineTo(fx(x), fy(y)) : lines.moveTo(fx(x), fy(y))));
        const end = c.points[c.points.length - 1];
        last = [fx(end[0]), fy(end[1])];
    }
    const marks = (op.marks ?? []).map((k) => ({ ...k, x: fx(k.x), y: fy(k.y) }));
    return { lines, drills, marks, travel, starts };
}

/** `hex` (#rrggbb) moved toward white by `t` (0..1). */
function lighten(hex, t) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * t));
    return `rgb(${c.join(',')})`;
}

/** Smallest of 1, 2, 5 × 10^n that is at least `min`. */
function niceStep(min) {
    const p = 10 ** Math.floor(Math.log10(min));
    return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= min * 0.9999);
}

const RULER_W = 38;
const RULER_H = 20;

export function createView(container, { onClick, onRect, onMove } = {}) {
    const canvas = document.createElement('canvas');
    // Cursor readout (FlatCAM's top-left box): text-only updates on pointer move.
    const readout = document.createElement('div');
    readout.className = 'readout';
    readout.style.display = 'none';
    container.append(canvas, readout);
    let anchor = { x: 0, y: 0 }; // Dx/Dy are measured from the last click
    const ctx = canvas.getContext('2d');
    let scene = { layers: [], regions: [], toolpaths: [], markers: [], highlight: null, pick: null };
    let view = null; // { x, y, w, h } in mm, y up
    let mode = 'pan';
    let drawing = null;
    let frame = 0;

    // Drilling preview: + plunged, dashed circle milled to size, red slash skipped.
    const drawHoleMarks = (marks, color, px) => {
        ctx.lineWidth = 1.5 * px;
        for (const k of marks) {
            const r = k.d / 2;
            ctx.beginPath();
            if (k.how === 'plunged') {
                ctx.strokeStyle = color;
                const c = r * 0.7;
                ctx.moveTo(k.x - c, k.y); ctx.lineTo(k.x + c, k.y);
                ctx.moveTo(k.x, k.y - c); ctx.lineTo(k.x, k.y + c);
                ctx.stroke();
            } else if (k.how === 'milled') {
                ctx.strokeStyle = color;
                ctx.setLineDash([3 * px, 2 * px]);
                ctx.arc(k.x, k.y, r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            } else {
                ctx.strokeStyle = '#e5534b';
                ctx.arc(k.x, k.y, r, 0, Math.PI * 2);
                const c = r * Math.SQRT1_2;
                ctx.moveTo(k.x - c, k.y - c); ctx.lineTo(k.x + c, k.y + c);
                ctx.stroke();
            }
        }
    };

    const size = () => {
        const r = canvas.getBoundingClientRect();
        return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    };
    // mm → CSS px: one scale, centred (like SVG "meet")
    const xf = () => {
        const { w, h } = size();
        const k = Math.min(w / view.w, h / view.h);
        return { k, ox: (w - view.w * k) / 2, oy: (h - view.h * k) / 2, w, h };
    };
    const toWorld = (e) => {
        const r = canvas.getBoundingClientRect();
        const { k, ox, oy } = xf();
        return { x: view.x + (e.clientX - r.left - ox) / k, y: view.y + view.h - (e.clientY - r.top - oy) / k };
    };

    function contentBounds() {
        const boxes = [];
        if (scene.board) boxes.push(scene.board);
        for (const l of scene.layers) if (l.visible && l.layer.bounds) boxes.push(l.layer.bounds);
        return boxes.length ? G.mergeBounds(...boxes) : null;
    }

    function fit() {
        const b = contentBounds();
        if (!b) { view = null; invalidate(); return; }
        const { w, h } = size();
        const aspect = w / h;
        const pad = Math.max(b.xmax - b.xmin, b.ymax - b.ymin) * 0.05 + 1;
        let vw = b.xmax - b.xmin + 2 * pad;
        let vh = b.ymax - b.ymin + 2 * pad;
        if (vw / vh < aspect) vw = vh * aspect; else vh = vw / aspect;
        view = { x: (b.xmin + b.xmax) / 2 - vw / 2, y: (b.ymin + b.ymax) / 2 - vh / 2, w: vw, h: vh };
        invalidate();
    }

    function zoom(factor, at) {
        if (!view) return;
        const c = at ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
        view = { x: c.x - (c.x - view.x) * factor, y: c.y - (c.y - view.y) * factor, w: view.w * factor, h: view.h * factor };
        invalidate();
    }

    function centerOn(x, y, width) {
        if (!view) return;
        const f = width ? width / view.w : 1;
        view = { x: x - (view.w * f) / 2, y: y - (view.h * f) / 2, w: view.w * f, h: view.h * f };
        invalidate();
    }

    function invalidate() {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; draw(); });
    }

    function draw() {
        const dpr = window.devicePixelRatio || 1;
        const { w, h } = size();
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!view) return;
        const { k, ox, oy } = xf();
        // world (mm, y up) → device pixels
        const world = () => ctx.setTransform(k * dpr, 0, 0, -k * dpr, (ox - view.x * k) * dpr, (oy + (view.y + view.h) * k) * dpr);
        const px = 1 / k; // one CSS pixel in mm

        const { w: cw, h: ch } = size();
        // Visible world rectangle (the view is centred, so it may extend past `view`).
        const vx0 = view.x - ox / k;
        const vy1 = view.y + view.h + oy / k;
        const sx = (x) => ox + (x - view.x) * k;
        const sy = (y) => oy + (view.y + view.h - y) * k;
        const minor = niceStep(10 / k);
        const major = niceStep(Math.max(70 / k, minor * 4.99));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const gridLines = (step, color) => {
            ctx.beginPath();
            for (let x = Math.ceil(vx0 / step) * step; x <= vx0 + cw / k; x += step) { const X = Math.round(sx(x)) + 0.5; ctx.moveTo(X, 0); ctx.lineTo(X, ch); }
            for (let y = Math.floor(vy1 / step) * step; y >= vy1 - ch / k; y -= step) { const Y = Math.round(sy(y)) + 0.5; ctx.moveTo(0, Y); ctx.lineTo(cw, Y); }
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.stroke();
        };
        gridLines(minor, 'rgba(255, 255, 255, 0.045)');
        gridLines(major, 'rgba(255, 255, 255, 0.11)');
        // Origin axes
        ctx.beginPath();
        const X0 = Math.round(sx(0)) + 0.5;
        const Y0 = Math.round(sy(0)) + 0.5;
        ctx.moveTo(X0, 0); ctx.lineTo(X0, ch);
        ctx.moveTo(0, Y0); ctx.lineTo(cw, Y0);
        ctx.strokeStyle = 'rgba(229, 83, 75, 0.55)';
        ctx.stroke();

        world();
        for (const l of scene.layers) {
            if (!l.visible) continue;
            ctx.globalAlpha = l.opacity ?? 0.85;
            // Translucent fill with a solid, lighter edge, as FlatCAM plots objects.
            const edge = lighten(l.color, 0.35);
            if (l.layer.format === 'gerber') {
                const p = cached(l.layer.image, () => shapePath(l.layer.image));
                ctx.fillStyle = l.color;
                ctx.fill(p, 'nonzero');
                ctx.globalAlpha = 1;
                ctx.strokeStyle = edge;
                ctx.lineWidth = 1 * px;
                ctx.stroke(p);
            } else {
                const d = drillPaths(l.layer);
                ctx.fillStyle = l.color;
                ctx.fill(d.holes);
                ctx.strokeStyle = l.color;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                for (const s of d.slots) { ctx.lineWidth = s.width; ctx.stroke(s.p); }
                ctx.globalAlpha = 1;
                ctx.strokeStyle = edge;
                ctx.lineWidth = 1 * px;
                ctx.stroke(d.holes);
            }
        }
        ctx.globalAlpha = 1;

        for (const r of scene.regions) {
            const p = r.path ?? cached(r.shape, () => shapePath(r.shape));
            ctx.fillStyle = r.color;
            ctx.globalAlpha = r.active ? 0.22 : 0.08;
            ctx.fill(p, 'nonzero');
            ctx.globalAlpha = 1;
            ctx.strokeStyle = r.color;
            ctx.lineWidth = (r.active ? 2 : 1) * px;
            ctx.setLineDash([6 * px, 4 * px]);
            ctx.stroke(p);
            ctx.setLineDash([]);
        }

        for (const t of scene.toolpaths) {
            if (!t.visible) continue;
            const { lines, drills } = t.path;
            if (t.width) {
                ctx.strokeStyle = t.color;
                ctx.globalAlpha = 0.25;
                ctx.lineWidth = t.width;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke(lines);
            }
            ctx.globalAlpha = 1;
            ctx.strokeStyle = t.color;
            ctx.lineWidth = 1 * px;
            ctx.stroke(lines);
            if (drills.length) {
                const r = (t.diameter ?? 0.8) / 2;
                ctx.lineWidth = 1.5 * px;
                ctx.beginPath();
                for (const [x, y] of drills) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
                ctx.stroke();
            }
            if (t.path.marks?.length) drawHoleMarks(t.path.marks, t.color, px);
        }

        // Travel moves of CNC jobs, after every cut so no tool band hides them.
        ctx.lineWidth = 1.25 * px;
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        for (const t of scene.toolpaths) if (t.visible && t.travel) ctx.stroke(t.path.travel);
        ctx.setLineDash([]);

        if (scene.highlight) {
            const b = scene.highlight;
            ctx.strokeStyle = '#0ef6ae';
            ctx.lineWidth = 2 * px;
            ctx.setLineDash([6 * px, 4 * px]);
            ctx.strokeRect(b.xmin, b.ymin, b.xmax - b.xmin, b.ymax - b.ymin);
            ctx.setLineDash([]);
        }

        if (drawing) {
            const [x0, y0, x1, y1] = drawing;
            ctx.fillStyle = 'rgba(14, 246, 174, 0.15)';
            ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
            ctx.strokeStyle = '#0ef6ae';
            ctx.lineWidth = 1.5 * px;
            ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        }

        // Markers and labels in screen space so they keep their size.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Cut order numbers on CNC jobs; a number that would overlap one already drawn is skipped.
        ctx.font = '11px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillStyle = '#7fe9ff';
        const taken = [];
        for (const t of scene.toolpaths) {
            const starts = t.travel && t.visible ? t.path.starts : null;
            if (!starts || starts.length > 2000) continue;
            starts.forEach(([x, y], i) => {
                const X = sx(x) + 3;
                const Y = sy(y) - 2;
                if (X < -20 || Y < 0 || X > cw || Y > ch + 12) return;
                if (taken.length >= 600 || taken.some(([a, b]) => Math.abs(a - X) < 16 && Math.abs(b - Y) < 12)) return;
                taken.push([X, Y]);
                ctx.strokeText(String(i + 1), X, Y);
                ctx.fillText(String(i + 1), X, Y);
            });
        }
        for (const m of scene.markers) {
            const mx = sx(m.at[0]), my = sy(m.at[1]);
            ctx.beginPath();
            ctx.arc(mx, my, m.selected ? 9 : 6, 0, Math.PI * 2);
            ctx.fillStyle = m.severity === 'error' ? 'rgba(255, 107, 107, 0.85)' : 'rgba(227, 179, 65, 0.85)';
            ctx.fill();
            ctx.lineWidth = m.selected ? 3 : 1.5;
            ctx.strokeStyle = '#000';
            ctx.stroke();
        }
        if (scene.pick) {
            const mx = sx(scene.pick.x), my = sy(scene.pick.y);
            ctx.beginPath();
            ctx.arc(mx, my, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Rulers: mm along the left and bottom edges.
        const dec = Math.max(0, -Math.floor(Math.log10(major) + 1e-9));
        ctx.fillStyle = 'rgba(10, 12, 14, 0.82)';
        ctx.fillRect(0, 0, RULER_W, ch);
        ctx.fillRect(RULER_W, ch - RULER_H, cw - RULER_W, RULER_H);
        ctx.beginPath();
        for (let x = Math.ceil(vx0 / minor) * minor; x <= vx0 + cw / k; x += minor) {
            const X = Math.round(sx(x)) + 0.5;
            if (X < RULER_W) continue;
            const big = Math.abs(x / major - Math.round(x / major)) < 1e-6;
            ctx.moveTo(X, ch - RULER_H); ctx.lineTo(X, ch - RULER_H + (big ? 7 : 3));
        }
        for (let y = Math.floor(vy1 / minor) * minor; y >= vy1 - ch / k; y -= minor) {
            const Y = Math.round(sy(y)) + 0.5;
            if (Y > ch - RULER_H) continue;
            const big = Math.abs(y / major - Math.round(y / major)) < 1e-6;
            ctx.moveTo(RULER_W - (big ? 7 : 3), Y); ctx.lineTo(RULER_W, Y);
        }
        ctx.moveTo(RULER_W + 0.5, 0); ctx.lineTo(RULER_W + 0.5, ch - RULER_H);
        ctx.moveTo(RULER_W, ch - RULER_H + 0.5); ctx.lineTo(cw, ch - RULER_H + 0.5);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        const label = (v) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(dec);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        for (let x = Math.ceil(vx0 / major) * major; x <= vx0 + cw / k; x += major) {
            const X = sx(x);
            if (X > RULER_W + 12) ctx.fillText(label(x), X, ch - 2);
        }
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let y = Math.floor(vy1 / major) * major; y >= vy1 - ch / k; y -= major) {
            const Y = sy(y);
            if (Y < ch - RULER_H - 8 && Y > 6) ctx.fillText(label(y), RULER_W - 9, Y);
        }
    }

    const showReadout = (p) => {
        readout.style.display = '';
        const f = (v) => v.toFixed(4).padStart(9);
        readout.textContent = `Dx: ${f(p.x - anchor.x)} mm\nDy: ${f(p.y - anchor.y)} mm\n\nX:  ${f(p.x)} mm\nY:  ${f(p.y)} mm`;
    };

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (view) zoom(Math.exp(e.deltaY * 0.0015), toWorld(e));
    }, { passive: false });

    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
        if (!view) return;
        canvas.setPointerCapture(e.pointerId);
        if (mode === 'rect') {
            const p = toWorld(e);
            drawing = [p.x, p.y, p.x, p.y];
            return;
        }
        drag = { x: e.clientX, y: e.clientY, view: { ...view }, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!view) return;
        const p = toWorld(e);
        onMove?.(p);
        showReadout(p);
        if (drawing) { drawing[2] = p.x; drawing[3] = p.y; invalidate(); return; }
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        canvas.classList.add('panning');
        const { k } = xf();
        view = { ...drag.view, x: drag.view.x - dx / k, y: drag.view.y + dy / k };
        invalidate();
    });
    canvas.addEventListener('pointerup', (e) => {
        if (drawing) {
            const [x0, y0, x1, y1] = drawing;
            drawing = null;
            invalidate();
            if (Math.abs(x1 - x0) > 0.05 && Math.abs(y1 - y0) > 0.05) onRect?.([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)].map((v) => Math.round(v * 1000) / 1000));
            return;
        }
        if (drag && !drag.moved) {
            const p = toWorld(e);
            anchor = p;
            showReadout(p);
            onClick?.(p);
        }
        drag = null;
        canvas.classList.remove('panning');
    });

    const ro = new ResizeObserver(() => invalidate());
    ro.observe(container);

    return {
        setScene(next, { fit: refit = false } = {}) {
            scene = { ...scene, ...next };
            if (refit || !view) fit(); else invalidate();
        },
        fit,
        zoom,
        centerOn,
        setMode(m) { mode = m; canvas.style.cursor = m === 'rect' ? 'crosshair' : ''; },
        get mode() { return mode; },
        get hasView() { return !!view; },
        /** Size of one CSS pixel in mm at the current zoom. */
        pxSize() { return view ? 1 / xf().k : 1; },
        getView() { return view && { ...view }; },
        /** Restores a view from getView(); false when `v` is not a usable one. */
        setView(v) {
            if (!v || ![v.x, v.y, v.w, v.h].every(Number.isFinite) || v.w <= 0 || v.h <= 0) return false;
            view = { x: v.x, y: v.y, w: v.w, h: v.h };
            invalidate();
            return true;
        },
    };
}
