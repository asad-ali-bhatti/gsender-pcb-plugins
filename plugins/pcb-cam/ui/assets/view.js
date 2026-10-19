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
    const drills = [];
    for (const c of op.cuts) {
        if (c.kind === 'drill') { drills.push([fx(c.x), fy(c.y)]); continue; }
        c.points.forEach(([x, y], i) => (i ? lines.lineTo(fx(x), fy(y)) : lines.moveTo(fx(x), fy(y))));
    }
    return { lines, drills };
}

export function createView(container, { onClick, onRect, onMove } = {}) {
    const canvas = document.createElement('canvas');
    container.append(canvas);
    const ctx = canvas.getContext('2d');
    let scene = { layers: [], regions: [], toolpaths: [], markers: [], highlight: null, pick: null };
    let view = null; // { x, y, w, h } in mm, y up
    let mode = 'pan';
    let drawing = null;
    let frame = 0;

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

        world();
        for (const l of scene.layers) {
            if (!l.visible) continue;
            ctx.globalAlpha = l.opacity ?? 0.85;
            if (l.layer.format === 'gerber') {
                ctx.fillStyle = l.color;
                ctx.fill(cached(l.layer.image, () => shapePath(l.layer.image)), 'nonzero');
            } else {
                const d = drillPaths(l.layer);
                ctx.fillStyle = l.color;
                ctx.fill(d.holes);
                ctx.strokeStyle = l.color;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                for (const s of d.slots) { ctx.lineWidth = s.width; ctx.stroke(s.p); }
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
        }

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
        const toScreen = (x, y) => [ox + (x - view.x) * k, oy + (view.y + view.h - y) * k];
        for (const m of scene.markers) {
            const [sx, sy] = toScreen(m.at[0], m.at[1]);
            ctx.beginPath();
            ctx.arc(sx, sy, m.selected ? 9 : 6, 0, Math.PI * 2);
            ctx.fillStyle = m.severity === 'error' ? 'rgba(255, 107, 107, 0.85)' : 'rgba(227, 179, 65, 0.85)';
            ctx.fill();
            ctx.lineWidth = m.selected ? 3 : 1.5;
            ctx.strokeStyle = '#000';
            ctx.stroke();
        }
        if (scene.pick) {
            const [sx, sy] = toScreen(scene.pick.x, scene.pick.y);
            ctx.beginPath();
            ctx.arc(sx, sy, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

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
        if (drag && !drag.moved) onClick?.(toWorld(e));
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
