// Region masks: the 2D area an operation is limited to.

import * as G from './geometry.js';
import { componentOf, netOf } from './project.js';

const DEFAULT_MARGIN = 0.5;
/** How far past all loaded layers a "remainder" mask reaches, mm. */
const WORLD_MARGIN = 100;

/**
 * Mask Shape for a region used by `op`, or null for "everywhere" (no region).
 * @param {object} project
 * @param {object} op operation using the region
 * @param {Record<string, object>} layers input id → parsed layer
 */
export function regionMask(project, op, layers) {
    if (op.region == null) return null;
    const region = project.regions.find((r) => r.id === op.region);
    if (!region) return [];
    if (region.shape.kind !== 'remainder') return shapeMask(region.shape, layers, op.input);
    // Everything not covered by the other regions that operations of the same
    // type use on the same input.
    const others = new Set(project.operations
        .filter((o) => o.enabled && o.type === op.type && o.input === op.input && o.region != null && o.region !== op.region)
        .map((o) => o.region));
    const covered = project.regions
        .filter((r) => others.has(r.id) && r.shape.kind !== 'remainder')
        .map((r) => shapeMask(r.shape, layers, op.input));
    return G.difference(worldRect(layers), G.union(...covered));
}

function worldRect(layers) {
    const b = G.mergeBounds(...Object.values(layers).map((l) => l.bounds)) ?? { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
    const m = WORLD_MARGIN;
    return G.normalize([G.toPath([[b.xmin - m, b.ymin - m], [b.xmax + m, b.ymin - m], [b.xmax + m, b.ymax + m], [b.xmin - m, b.ymax + m]])]);
}

/** Mask for a non-remainder region shape. */
export function shapeMask(shape, layers, inputId) {
    switch (shape.kind) {
        case 'rect': {
            const [x0, y0, x1, y1] = shape.rect;
            return G.normalize([G.toPath([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])]);
        }
        case 'polygon':
            return G.normalize([G.toPath(shape.points)]);
        case 'component': {
            // Convex hull of the component's pads on every loaded Gerber, so the
            // area under the part (between its pads) is included.
            const pts = [];
            for (const layer of Object.values(layers)) {
                if (layer.format !== 'gerber') continue;
                for (const o of layer.objects) {
                    if ((o.kind === 'flash' || o.kind === 'region') && componentOf(o) === shape.ref) {
                        for (const path of o.shape) for (const p of path) pts.push([p.X / G.SCALE, p.Y / G.SCALE]);
                    }
                }
            }
            if (pts.length < 3) return [];
            return G.offset(G.normalize([G.toPath(G.convexHull(pts))]), shape.margin ?? DEFAULT_MARGIN);
        }
        case 'net': {
            const layer = layers[inputId];
            const parts = (layer?.objects ?? []).filter((o) => netOf(o) === shape.net && o.polarity === 'dark').map((o) => o.shape);
            if (!parts.length) return [];
            return G.offset(G.union(...parts), shape.margin ?? DEFAULT_MARGIN);
        }
        default:
            throw new Error(`Unknown region kind ${shape.kind}`);
    }
}
