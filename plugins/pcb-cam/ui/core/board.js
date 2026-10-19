// Board shape from an outline (Edge.Cuts / profile) Gerber: the stroke
// centrelines are chained into closed loops and filled even-odd, so cut-outs
// inside the board become holes.

import * as G from './geometry.js';

/** Endpoints closer than this are joined when chaining outline segments, mm. */
const JOIN_TOL = 0.01;

/**
 * @param {object} layer parsed outline Gerber
 * @returns {{ shape: object[], loops: number[][][], issues: { severity, code, message, at }[] }}
 */
export function boardFromOutline(layer) {
    const issues = [];
    const pieces = [];
    for (const o of layer.objects) {
        if (o.polarity !== 'dark') continue;
        const pts = o.kind === 'stroke' ? o.path : o.kind === 'region' ? o.contour : null;
        if (pts && pts.length >= 2) pieces.push(pts.map(([x, y]) => [x, y]));
    }
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= JOIN_TOL;
    const loops = [];
    const open = pieces.slice();
    while (open.length) {
        let chain = open.pop();
        let grew = true;
        while (grew && !(chain.length > 2 && near(chain[0], chain[chain.length - 1]))) {
            grew = false;
            const end = chain[chain.length - 1];
            const start = chain[0];
            for (let i = 0; i < open.length; i++) {
                const p = open[i];
                if (near(end, p[0])) chain = chain.concat(p.slice(1));
                else if (near(end, p[p.length - 1])) chain = chain.concat([...p].reverse().slice(1));
                else if (near(start, p[p.length - 1])) chain = p.concat(chain.slice(1));
                else if (near(start, p[0])) chain = [...p].reverse().concat(chain.slice(1));
                else continue;
                open.splice(i, 1);
                grew = true;
                break;
            }
        }
        if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) {
            loops.push(chain.slice(0, -1));
        } else {
            const at = chain[chain.length - 1];
            issues.push({ severity: 'error', code: 'outline-open', message: `Board outline has a gap near (${at[0].toFixed(3)}, ${at[1].toFixed(3)})`, at });
        }
    }
    if (!loops.length && !issues.length) issues.push({ severity: 'error', code: 'outline-empty', message: 'Outline layer has no closed board edge' });
    return { shape: G.fillEvenOdd(loops.map(G.toPath)), loops, issues };
}
