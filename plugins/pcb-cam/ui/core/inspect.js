// Read-only board summary: layers, board size, components, nets and drill
// sizes. Plain JSON, so the UI and (later) agents can use it directly.

import * as G from './geometry.js';
import { componentOf, netOf } from './project.js';
import { isPlated } from './import/excellon.js';

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const roundBox = (b) => (b ? { xmin: round(b.xmin), ymin: round(b.ymin), xmax: round(b.xmax), ymax: round(b.ymax) } : null);
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * @param {Record<string, object>} layers input id → parsed Gerber/Excellon result
 * @param {{ inputs?: { id: string, role: string, side: string|null }[] }} [project] roles from the project, if known
 */
export function inspectBoard(layers, project) {
    const roles = new Map((project?.inputs ?? []).map((i) => [i.id, i]));
    const out = { layers: [], board: null, components: [], nets: { named: [], unconnected: 0 }, drills: [] };

    let outline = null;
    let copper = null;
    const comps = new Map();
    const nets = new Map();
    const drills = new Map();

    for (const [id, layer] of Object.entries(layers)) {
        const role = roles.get(id)?.role ?? null;
        const errors = layer.issues.filter((i) => i.severity === 'error').length;
        const summary = { id, format: layer.format, role, units: layer.units, errors, warnings: layer.issues.length - errors };
        if (layer.format === 'gerber') {
            const counts = { flash: 0, stroke: 0, region: 0 };
            for (const o of layer.objects) counts[o.kind]++;
            Object.assign(summary, {
                fileFunction: layer.fileAttributes['.FileFunction'] ?? null,
                objects: counts,
                bounds: roundBox(layer.bounds),
                extent: roundBox(layer.extent),
                copperArea: role === 'copper' ? round(G.area(layer.image), 3) : undefined,
            });
            if (role === 'outline') outline = G.mergeBounds(outline, centrelineBounds(layer));
            if (role === 'copper') {
                copper = G.mergeBounds(copper, layer.bounds);
                collectComponents(layer, id, comps, nets);
            }
        } else if (layer.format === 'excellon') {
            Object.assign(summary, {
                fileFunction: layer.fileAttributes['.FileFunction'] ?? null,
                tools: Object.keys(layer.tools).length,
                holes: layer.holes.length,
                slots: layer.slots.length,
                bounds: roundBox(layer.bounds),
            });
            for (const item of [...layer.holes, ...layer.slots]) {
                const key = `${round(item.diameter, 3)}|${isPlated(item, layer)}`;
                const d = drills.get(key) ?? { diameter: round(item.diameter, 3), plated: isPlated(item, layer), holes: 0, slots: 0 };
                if (item.path) d.slots++;
                else d.holes++;
                drills.set(key, d);
            }
        }
        out.layers.push(summary);
    }

    const box = outline ?? copper;
    if (box) {
        out.board = { ...roundBox(box), width: round(box.xmax - box.xmin), height: round(box.ymax - box.ymin), from: outline ? 'outline' : 'copper' };
    }
    out.components = [...comps.values()]
        .map((c) => ({ ref: c.ref, pads: c.pads, layers: [...c.layers], bounds: roundBox(c.bounds) }))
        .sort((a, b) => natural(a.ref, b.ref));
    for (const [name, count] of nets) {
        if (name.startsWith('unconnected-')) out.nets.unconnected += count;
        else out.nets.named.push({ name, objects: count });
    }
    out.nets.named.sort((a, b) => natural(a.name, b.name));
    out.drills = [...drills.values()].sort((a, b) => a.diameter - b.diameter || Number(b.plated) - Number(a.plated));
    return out;
}

/** Bounds of stroke centrelines and region contours: the board edge, not the pen's outer side. */
function centrelineBounds(layer) {
    let b = null;
    for (const o of layer.objects) {
        for (const [x, y] of o.path ?? o.contour ?? []) {
            b = b
                ? { xmin: Math.min(b.xmin, x), ymin: Math.min(b.ymin, y), xmax: Math.max(b.xmax, x), ymax: Math.max(b.ymax, y) }
                : { xmin: x, ymin: y, xmax: x, ymax: y };
        }
    }
    return b ?? layer.extent;
}

function collectComponents(layer, id, comps, nets) {
    for (const o of layer.objects) {
        const ref = componentOf(o);
        if (ref && (o.kind === 'flash' || o.kind === 'region')) { // custom pads are regions
            const c = comps.get(ref) ?? { ref, pads: 0, layers: new Set(), bounds: null };
            c.pads++;
            c.layers.add(id);
            c.bounds = G.mergeBounds(c.bounds, G.bounds(o.shape));
            comps.set(ref, c);
        }
        const net = netOf(o);
        if (net) nets.set(net, (nets.get(net) ?? 0) + 1);
    }
}
