// Generates the field and operation icons shared by both plugins:
//   node scripts/build-icons.mjs
// writes plugins/pcb-cam/ui/assets/icons.js and plugins/autoleveler/ui/assets/icons.js.
//
// Views (every icon is a 48 x 40 viewBox):
//   block (b-*)   isometric copper-clad block
//   side  (s-*)   cross-section through the board
//   close (c-*)   top-down close-up of tool passes
//   tool  (t-*)   a bit beside the cut profile it makes
// Colour language (CSS variables --ic-*, defined by each plugin's CSS):
//   materials   --ic-cu / -hi / -dk copper, --ic-fr4 / -l / -r laminate (section, block sides),
//               --ic-spoil spoilboard, --ic-hole through-cuts, --ic-edge outlines.
//               Milled copper shows the laminate underneath: cleared paths are --ic-fr4.
//   tools       --ic-bit grey, --ic-bit-hi light-grey flutes, --ic-bit-edge outline.
//   indicators  --ic-dim blue for the value a field sets, --ic-line lighter blue for guides,
//               arrows, --ic-case casing under them, --ic-void behind the icon. Probe points use
//               the visualizer's height colours (blue low, red high).

import { writeFileSync } from 'node:fs';

const n = (v) => (Math.round(v * 100) / 100).toString();
const pt = (p) => `${n(p[0])} ${n(p[1])}`;
const poly = (ps) => `M${ps.map(pt).join(' L')} Z`;
const line = (ps) => `M${ps.map(pt).join(' L')}`;
const R = 'stroke-linecap="round" stroke-linejoin="round"';
// A milled groove: laminate showing through, with darker copper edges.
const groove = (d, w = 2) => `<path d="${d}" fill="none" stroke="var(--ic-cu-dk)" stroke-width="${w + 0.9}" ${R}/><path d="${d}" fill="none" stroke="var(--ic-fr4)" stroke-width="${w}" ${R}/>`;
const throughCut = (d, w = 1.8) => `<path d="${d}" fill="none" stroke="var(--ic-fr4-l)" stroke-width="${w + 1.2}" ${R}/><path d="${d}" fill="none" stroke="var(--ic-hole)" stroke-width="${w}" ${R}/>`;
const mark = (d, w = 1.4) => `<path d="${d}" fill="none" stroke="var(--ic-dim)" stroke-width="${w}" ${R}/>`;

// --- block view -------------------------------------------------------------
const P1 = [4, 15], P2 = [24, 5], P3 = [44, 15], P4 = [24, 25], T = 7;
const at = (u, v) => [P1[0] + 20 * u + 20 * v, P1[1] - 10 * u + 10 * v];
const ellipse = (cu, cv, r, k = 24) => poly([...Array(k)].map((_, i) => at(cu + r * Math.cos((2 * Math.PI * i) / k), cv + r * Math.sin((2 * Math.PI * i) / k))));
function rrect(u0, u1, v0, v1, r, k = 6) {
    const ps = [];
    for (const [cu, cv, a0] of [[u1 - r, v0 + r, -90], [u1 - r, v1 - r, 0], [u0 + r, v1 - r, 90], [u0 + r, v0 + r, 180]]) {
        for (let i = 0; i <= k; i++) { const a = ((a0 + (90 * i) / k) * Math.PI) / 180; ps.push(at(cu + r * Math.cos(a), cv + r * Math.sin(a))); }
    }
    return poly(ps);
}
const slab = () => `<path d="${poly([P1, P4, [P4[0], P4[1] + T], [P1[0], P1[1] + T]])}" fill="var(--ic-fr4-l)" stroke="var(--ic-edge)" stroke-width=".8" stroke-linejoin="round"/>`
    + `<path d="${poly([P4, P3, [P3[0], P3[1] + T], [P4[0], P4[1] + T]])}" fill="var(--ic-fr4-r)" stroke="var(--ic-edge)" stroke-width=".8" stroke-linejoin="round"/>`
    + `<path d="${poly([P1, P2, P3, P4])}" fill="var(--ic-cu)" stroke="var(--ic-edge)" stroke-width=".8" stroke-linejoin="round"/>`;
const trace = () => `<path d="${rrect(0.18, 0.82, 0.42, 0.58, 0.08)}" fill="var(--ic-cu-hi)" stroke="var(--ic-cu-dk)" stroke-width=".6"/>`;
const dot = (u, v, r = 1.2) => { const [x, y] = at(u, v); return `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="var(--ic-line)"/>`; };
// Probe points coloured like the Autoleveler's visualizer map: blue low → red high.
const HEAT = ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'];
const heatDot = (u, v, t, r = 1.35) => { const [x, y] = at(u, v); return `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${HEAT[Math.round(t * 4)]}" stroke="var(--ic-edge)" stroke-width=".6"/>`; };
const heatGrid = (us, r) => us.flatMap((u, i) => us.map((v, j) => heatDot(u, v, (i + j) / ((us.length - 1) * 2), r))).join('');
// The tool in block view: a grey line coming down onto a point, tip at (x, tip).
const toolLine = (x, tip, len = 14) => `<path d="M${n(x)} ${n(tip - len)} V${n(tip)}" fill="none" stroke="var(--ic-bit-edge)" stroke-width="2.4" stroke-linecap="round"/><path d="M${n(x)} ${n(tip - len)} V${n(tip)}" fill="none" stroke="var(--ic-bit)" stroke-width="1.3" stroke-linecap="round"/>`;
const H = at(0.5, 0.5);

const icons = {};
// A small circuit on the block: two pads joined by a bent trace.
const PADS = [[0.24, 0.3], [0.76, 0.7]];
const TRACE = line([[0.24, 0.3], [0.52, 0.3], [0.76, 0.54], [0.76, 0.7]].map(([u, v]) => at(u, v)));
const padShape = (r, fill, extra = '') => PADS.map(([u, v]) => `<path d="${ellipse(u, v, r)}" fill="${fill}"${extra}/>`).join('');
// Circuit grown by `g` (screen units for the trace, block units for the pads), drawn in one colour.
const grown = (g, colour) => `<path d="${TRACE}" fill="none" stroke="${colour}" stroke-width="${n(2.2 + 2 * g)}" ${R}/>` + padShape(0.11 + g * 0.045, colour);
const circuit = () => grown(0.55, 'var(--ic-cu-dk)') + grown(0, 'var(--ic-cu-hi)');
// Isolation groove around the circuit: laminate showing, with darker copper at its outer edge.
const isoGroove = (g) => grown(g + 0.5, 'var(--ic-cu-dk)') + grown(g, 'var(--ic-fr4)');
// Faint parallel passes across a cleared area.
const passLines = [0.12, 0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92].map((v) => `<path d="${line([at(0.04, v), at(0.96, v)])}" stroke="var(--ic-fr4-l)" stroke-width=".7"/>`).join('');
const clearedTop = `<path d="${poly([P1, P2, P3, P4])}" fill="var(--ic-fr4)" stroke="var(--ic-edge)" stroke-width=".8" stroke-linejoin="round"/>`;

icons['b-isolation'] = slab() + isoGroove(2.2) + circuit();
icons['b-passes'] = slab() + isoGroove(3.6) + grown(2, 'var(--ic-fr4-l)') + grown(1.7, 'var(--ic-fr4)') + circuit();
icons['b-clearing'] = slab() + clearedTop + passLines + circuit();
icons['b-drill'] = slab() + `<path d="${ellipse(0.5, 0.5, 0.09)}" fill="var(--ic-hole)"/>` + toolLine(H[0], H[1], 16);
icons['b-millhole'] = slab() + `<path d="${ellipse(0.5, 0.5, 0.2)}" fill="var(--ic-hole)"/>`
    + `<path d="${ellipse(0.5, 0.5, 0.13)}" fill="none" stroke="var(--ic-line)" stroke-width="1" stroke-dasharray="1.6 1.3"/>` + toolLine(H[0] + 2.6, H[1] - 0.3, 15);
icons['b-cutout'] = slab() + throughCut(line([at(0.35, 1.06), at(-0.06, 1.06), at(-0.06, -0.06), at(1.06, -0.06), at(1.06, 1.06), at(0.62, 1.06)]));
const pv = at(0.18, 0.18);
icons['b-probe'] = slab() + heatGrid([0.18, 0.5, 0.82]) + toolLine(pv[0], pv[1] - 1.4, 13);
// Margin: the intended board in the middle; the probe area reaches past it by the margin
// (shaded), with probe points on the outer edge and the margin width dimensioned.
const quad = (u0, u1, v0, v1) => poly([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]);
icons['b-margin'] = slab()
    + `<path d="${quad(0.1, 0.9, 0.1, 0.9)}" fill="var(--ic-line)" fill-opacity=".28" stroke="var(--ic-line)" stroke-width=".9" stroke-dasharray="2 1.4"/>`
    + `<path d="${quad(0.3, 0.7, 0.3, 0.7)}" fill="var(--ic-cu-hi)" stroke="var(--ic-cu-dk)" stroke-width=".8"/>`
    + `<path d="${line([at(0.38, 0.42), at(0.52, 0.42), at(0.62, 0.56)])}" fill="none" stroke="var(--ic-cu-dk)" stroke-width="1" ${R}/>`
    + heatGrid([0.1, 0.5, 0.9], 1.1)
    + mark(line([at(0.7, 0.5), at(0.9, 0.5)]), 1.3) + mark(line([at(0.7, 0.45), at(0.7, 0.55)]), 1.3) + mark(line([at(0.9, 0.45), at(0.9, 0.55)]), 1.3);
icons['b-level'] = slab() + [0.3, 0.55, 0.8].map((v) => groove(line([...Array(17)].map((_, i) => { const u = (i + 2) / 20; return at(u, v + 0.05 * Math.sin(u * 3 * Math.PI)); })), 1.8)).join('');

// --- side view --------------------------------------------------------------
const board = (top, bot, x0 = 3, x1 = 45) => `<rect x="${x0}" y="${top}" width="${x1 - x0}" height="${bot - top}" fill="var(--ic-fr4)" stroke="var(--ic-edge)" stroke-width=".8"/>`
    + `<rect x="${x0}" y="${top - 2}" width="${x1 - x0}" height="2" fill="var(--ic-cu)" stroke="var(--ic-edge)" stroke-width=".6"/>`;
function spoil(top, bot, gap) {
    let s = `<rect x="3" y="${top}" width="42" height="${bot - top}" fill="var(--ic-spoil)" stroke="var(--ic-edge)" stroke-width=".8"/>`;
    for (let x = 5; x < 41; x += 6) if (!(gap && x > gap[0] - 6 && x < gap[1])) s += `<path d="M${x} ${bot} L${x + Math.min(5, bot - top)} ${top}" stroke="var(--ic-edge)" stroke-opacity=".35" stroke-width=".6"/>`;
    return s;
}
const voidR = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--ic-void)"/>`;
function endmill(x, w, top, tip, extra = '') {
    let s = `<rect x="${x}" y="${top}" width="${w}" height="${tip - top}" rx=".6" fill="var(--ic-bit)" stroke="var(--ic-bit-edge)" stroke-width=".6"${extra}/>`;
    for (let y = tip - 3; y > top + 2; y -= 5) s += `<path d="M${x} ${y - 2.5} L${x + w} ${y}" stroke="var(--ic-bit-hi)" stroke-width=".8"${extra}/>`;
    return s;
}
const vbit = (xc, top, cone, tip, w = 6) => `<path d="M${xc - w / 2} ${top} H${xc + w / 2} V${cone} L${xc} ${tip} L${xc - w / 2} ${cone} Z" fill="var(--ic-bit)" stroke="var(--ic-bit-edge)" stroke-width=".6" stroke-linejoin="round"/>`
    + `<path d="M${xc - w / 2} ${top + 4} L${xc + w / 2} ${top + 6.5} M${xc - w / 2} ${top + 9} L${xc + w / 2} ${top + 11.5}" stroke="var(--ic-bit-hi)" stroke-width=".8"/>`;
const ext = (x0, x1, y) => `<path d="M${x0} ${y} H${x1}" stroke="var(--ic-line)" stroke-width=".7" stroke-dasharray="1.2 1.2"/>`;
const dimv = (x, y0, y1) => `<path d="M${x} ${y0} V${y1} M${x - 1.6} ${y0} H${x + 1.6} M${x - 1.6} ${y1} H${x + 1.6}" fill="none" stroke="var(--ic-dim)" stroke-width="1.6" stroke-linecap="round"/>`;
const arrow = (x, y0, y1) => { const d = y1 < y0 ? -1 : 1; return `<path d="M${x} ${y0} V${y1} M${x - 2.3} ${y1 - 2.3 * d} L${x} ${y1} L${x + 2.3} ${y1 - 2.3 * d}" fill="none" stroke="var(--ic-line)" stroke-width="1.3" ${R}/>`; };
const arrow2 = (x, y0, y1) => `<path d="M${x} ${y0} V${y1} M${x - 2.3} ${y0 + 2.3} L${x} ${y0} L${x + 2.3} ${y0 + 2.3} M${x - 2.3} ${y1 - 2.3} L${x} ${y1} L${x + 2.3} ${y1 - 2.3}" fill="none" stroke="var(--ic-line)" stroke-width="1.3" ${R}/>`;

icons['s-cutdepth'] = board(18, 32) + '<path d="M20 16 L28 16 L24 23 Z" fill="var(--ic-void)"/>' + vbit(24, 0, 12, 23) + ext(28, 37, 16) + ext(25, 37, 23) + dimv(35, 16, 23);
icons['s-stepdown'] = board(12, 36) + voidR(20, 10, 8, 14) + '<path d="M20 24 h8 v6 h-8 Z M20 30 h8 v6 h-8 Z" fill="none" stroke="var(--ic-line)" stroke-width=".7" stroke-dasharray="1.4 1.1"/>'
    + '<path d="M20 18 H28" stroke="var(--ic-line)" stroke-width=".7" stroke-dasharray="1.2 1.2"/>' + endmill(20, 8, 0, 24) + ext(29, 38, 18) + ext(29, 38, 24) + dimv(36, 18, 24);
// Peck: the faded bit at the bottom of the hole and the solid one lifted out, with an up/down arrow.
icons['s-peck'] = board(16, 34) + voidR(21, 14, 6, 17) + '<path d="M21 23 H27" stroke="var(--ic-line)" stroke-width=".7" stroke-dasharray="1.2 1.2"/>'
    + endmill(21, 6, 13, 31, ' opacity=".35"') + endmill(21, 6, 0, 10) + arrow2(14, 3, 29) + ext(28, 37, 23) + ext(28, 37, 31) + dimv(35, 23, 31);
icons['s-breakthrough'] = spoil(27, 37, [20, 28]) + board(13, 27) + voidR(21, 11, 6, 23) + endmill(21, 6, 0, 34) + ext(28, 37, 27) + ext(28, 37, 34) + dimv(35, 27, 34);
icons['s-height'] = board(28, 36) + endmill(20, 6, 0, 10) + ext(27, 37, 10) + ext(27, 37, 26) + dimv(35, 10, 26);
icons['s-probeheight'] = board(28, 36) + endmill(20, 6, 0, 10) + '<path d="M26 4 C33 4 32 16 40 18" fill="none" stroke="var(--ic-line)" stroke-width="1" stroke-linecap="round"/>'
    + '<circle cx="23" cy="26" r="1.3" fill="var(--ic-line)"/>' + ext(14, 22, 10) + ext(14, 22, 26) + dimv(16, 10, 26);
icons['s-maxbelow'] = '<path d="M3 14 L45 20 L45 36 L3 36 Z" fill="var(--ic-fr4)" stroke="var(--ic-edge)" stroke-width=".8"/><path d="M3 12 L45 18 L45 20 L3 14 Z" fill="var(--ic-cu)" stroke="var(--ic-edge)" stroke-width=".6"/>'
    + '<circle cx="7" cy="12.6" r="1.4" fill="var(--ic-line)"/><path d="M3 12.6 H45" stroke="var(--ic-line)" stroke-width=".7" stroke-dasharray="1.2 1.2"/>'
    + '<path d="M3 26 H45" stroke="var(--ic-dim)" stroke-width=".9" stroke-dasharray="2 1.4"/>' + endmill(28, 6, 0, 14.5) + dimv(40, 12.6, 26);
icons['s-backoff'] = board(24, 34) + endmill(20, 6, 0, 16) + arrow(14, 20, 10) + arrow(32, 10, 20) + ext(27, 42, 16) + ext(27, 42, 22) + dimv(40, 16, 22);

// --- close-up: top-down tool passes between copper -----------------------------
// Laminate where the copper is cleared; copper drawn raised (lit top edge, dark lower edge).
const field = '<rect x="2" y="2" width="40" height="36" rx="1" fill="var(--ic-fr4)" stroke="var(--ic-edge)" stroke-width=".7"/>';
const copper = (y, h) => `<rect x="2" y="${y}" width="40" height="${h}" fill="var(--ic-cu)"/>`
    + `<path d="M2 ${y + 0.5} H42" stroke="var(--ic-cu-hi)" stroke-width="1"/><path d="M2 ${y + h - 0.5} H42" stroke="var(--ic-cu-dk)" stroke-width="1"/>`;
const pass = (y, w) => `<rect x="4" y="${n(y)}" width="36" height="${n(w)}" rx="${n(w / 2)}" fill="none" stroke="var(--ic-line)" stroke-width=".8"/>`;
const lap = (y, h) => `<rect x="8" y="${n(y)}" width="28" height="${n(h)}" fill="var(--ic-line)" fill-opacity=".4"/>`;
// The cutter seen from above: a grey disc with light flutes (also used by the milling-direction icons).
const cutter = (cx, cy, r) => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="var(--ic-bit)" stroke="var(--ic-bit-edge)" stroke-width=".7"/>`
    + `<path d="M${n(cx - 0.6 * r)} ${n(cy - 0.52 * r)} L${n(cx + 0.6 * r)} ${n(cy + 0.52 * r)} M${n(cx + 0.6 * r)} ${n(cy - 0.52 * r)} L${n(cx - 0.6 * r)} ${n(cy + 0.52 * r)}" stroke="var(--ic-bit-hi)" stroke-width=".8"/>`;
// Overlapping passes filling the gap between copper above (y < top) and below (y > bot):
// the first pass touches the upper copper, the last the lower; overlaps are lighter and the
// first one is dimensioned. The cutter sits at the end of the last pass.
function overlapIcon(top, bot, count, ov) {
    const w = (bot - top + (count - 1) * ov) / count;
    const ys = [...Array(count)].map((_, i) => top + i * (w - ov));
    let s = field + copper(2, top - 2) + copper(bot, 38 - bot);
    for (const y of ys.slice(1)) s += lap(y, ov);
    for (const y of ys) s += pass(y, w);
    return s + cutter(34, ys[count - 1] + w / 2, w / 2) + dimv(45, ys[1], ys[1] + ov);
}
icons['c-isolation'] = overlapIcon(11, 29, 2, 3);
icons['c-clearing'] = overlapIcon(8, 32, 3, 2.5);

// Milling direction, seen from above with the spindle turning clockwise (M3): climb on the
// left, conventional on the right. The trace runs along the top; ahead of the cutter the copper
// is still there, behind it the groove shows laminate. The feed arrow is the value the field
// sets; the selected panel is drawn solid and the other faded.
function directionPanel(ox, feed) {
    const cx = ox + 11, cy = 16, r = 5;
    const ahead = feed < 0 ? [ox + 1, cx] : [cx, ox + 23];
    let s = `<rect x="${ox + 1}" y="2" width="22" height="36" rx="1" fill="var(--ic-fr4)" stroke="var(--ic-edge)" stroke-width=".7"/>`
        + `<rect x="${ahead[0]}" y="11" width="${ahead[1] - ahead[0]}" height="10" fill="var(--ic-cu)"/>`
        + `<rect x="${ox + 1}" y="2" width="22" height="9" fill="var(--ic-cu)"/>`
        + `<path d="M${ox + 1} 10.5 H${ox + 23}" stroke="var(--ic-cu-dk)" stroke-width="1"/>`
        + cutter(cx, cy, r);
    // Clockwise rotation arrow under the cutter, from 25° round to 155°.
    const rr = 7.6, a0 = (25 * Math.PI) / 180, a1 = (155 * Math.PI) / 180;
    const p0 = [cx + rr * Math.cos(a0), cy + rr * Math.sin(a0)], p1 = [cx + rr * Math.cos(a1), cy + rr * Math.sin(a1)];
    const tx = -Math.sin(a1), ty = Math.cos(a1); // direction of travel at the end
    const hx = p1[0] - 2.2 * tx, hy = p1[1] - 2.2 * ty;
    s += `<path d="M${n(p0[0])} ${n(p0[1])} A${rr} ${rr} 0 0 1 ${n(p1[0])} ${n(p1[1])} M${n(hx - 1.6 * ty)} ${n(hy + 1.6 * tx)} L${n(p1[0])} ${n(p1[1])} L${n(hx + 1.6 * ty)} ${n(hy - 1.6 * tx)}" fill="none" stroke="var(--ic-line)" stroke-width="1.1" ${R}/>`;
    // Feed arrow
    const [x0, x1] = feed < 0 ? [ox + 19, ox + 4] : [ox + 4, ox + 19];
    s += `<path d="M${x0} 32 H${x1} M${x1 - 3 * feed} 29 L${x1} 32 L${x1 - 3 * feed} 35" fill="none" stroke="var(--ic-dim)" stroke-width="1.6" ${R}/>`;
    return s;
}
const faded = (svg) => `<g opacity=".3">${svg}</g>`;
icons['c-climb'] = directionPanel(0, -1) + faded(directionPanel(24, 1));
icons['c-conventional'] = faded(directionPanel(0, -1)) + directionPanel(24, 1);

// Tabs: top-down close-up of a board corner. The cut channel runs round the board; copper
// bridges (tabs) keep it attached to the rest of the sheet. The tab width is dimensioned.
const ch = 4;  // channel width
icons['c-tabs'] = '<rect x="2" y="2" width="44" height="36" rx="1" fill="var(--ic-cu)" stroke="var(--ic-edge)" stroke-width=".7"/>'
    + `<path d="M2 10 H32 Q36 10 36 14 V38" fill="none" stroke="var(--ic-fr4-l)" stroke-width="${ch + 1.2}"/>`
    + `<path d="M2 10 H32 Q36 10 36 14 V38" fill="none" stroke="var(--ic-hole)" stroke-width="${ch}"/>`
    + '<rect x="2" y="12" width="32" height="26" fill="var(--ic-cu-hi)" fill-opacity=".55"/>'
    + `<rect x="13" y="${10 - ch / 2 - 0.6}" width="6" height="${ch + 1.2}" fill="var(--ic-cu)"/>`
    + `<rect x="${36 - ch / 2 - 0.6}" y="24" width="${ch + 1.2}" height="6" fill="var(--ic-cu)"/>`
    + `<path d="M13 4.2 H19 M13 2.9 V5.5 M19 2.9 V5.5" fill="none" stroke="var(--ic-dim)" stroke-width="1.3" ${R}/>`;
// Tab height: looking along the cut. The cutter goes through the board except over the tab,
// where a bridge is left standing up from the bottom; its height is dimensioned.
icons['s-tabheight'] = '<rect x="3" y="12" width="42" height="18" fill="none" stroke="var(--ic-line)" stroke-width=".7" stroke-dasharray="1.6 1.2"/>'
    + '<rect x="18" y="22" width="12" height="8" fill="var(--ic-fr4)" stroke="var(--ic-edge)" stroke-width=".8"/>'
    + `<path d="M8 31 H16.5 V21 H31.5 V31 H44" fill="none" stroke="var(--ic-line)" stroke-width=".9" stroke-dasharray="1.8 1.3" ${R}/>`
    + endmill(5, 6, 4, 31) + ext(31, 40, 22) + ext(31, 40, 30) + dimv(38, 22, 30);

// --- tools: bit beside the profile it cuts ----------------------------------
const stock = '<rect x="18" y="20" width="27" height="15" fill="var(--ic-fr4)" stroke="var(--ic-edge)" stroke-width=".8"/><rect x="18" y="18" width="27" height="2" fill="var(--ic-cu)" stroke="var(--ic-edge)" stroke-width=".6"/>';
icons['t-vbit'] = vbit(9, 3, 22, 32) + stock + '<path d="M27 18 L36 18 L31.5 28 Z" fill="var(--ic-void)"/>' + mark('M27 18 L31.5 28 L36 18');
icons['t-endmill'] = endmill(6, 6, 3, 32) + stock + voidR(28, 18, 7, 10) + mark('M28 18 V28 H35 V18');
icons['t-drill'] = '<path d="M6 3 H12 V29 L9 32 L6 29 Z" fill="var(--ic-bit)" stroke="var(--ic-bit-edge)" stroke-width=".6" stroke-linejoin="round"/>'
    + '<path d="M6 10 L12 13 M6 16 L12 19 M6 22 L12 25" stroke="var(--ic-bit-hi)" stroke-width=".8"/>'
    + stock + '<path d="M28.5 18 H34.5 V29 L31.5 31.5 L28.5 29 Z" fill="var(--ic-void)"/>' + mark('M28.5 18 V29 L31.5 31.5 L34.5 29 V18');

// Casing: blue indicator strokes get a wider --ic-case stroke under them (as maps draw
// roads) so they read on copper, laminate and background alike; blue dots get an outline.
function cased(svg) {
    return svg
        .replace(/<path d="([^"]+)" fill="none" stroke="var\(--ic-dim\)" stroke-width="([\d.]+)"([^>]*)\/>/g,
            (m, d, w, rest) => `<path d="${d}" fill="none" stroke="var(--ic-case)" stroke-width="${n(Number(w) + 1.4)}"${rest.replace(/ stroke-dasharray="[^"]*"/, '')}/>${m}`)
        .replace(/<circle ([^>]*)fill="var\(--ic-line\)"\/>/g, '<circle $1fill="var(--ic-line)" stroke="var(--ic-case)" stroke-width=".7" paint-order="stroke"/>');
}
for (const k of Object.keys(icons)) icons[k] = cased(icons[k]);

const out = `// Generated by scripts/build-icons.mjs; do not edit by hand.
// Inner SVG of each 48 x 40 icon. Colours come from the --ic-* CSS variables.

export const ICONS = ${JSON.stringify(icons, null, 0).replace(/","/g, '",\n"')};

const NS = 'http://www.w3.org/2000/svg';
let popover = null;

/**
 * Adds the icon sprite and one shared hover popover to the document. Elements
 * with data-icon show it large with their data-cap text after a short hover
 * (native title tooltips don't show inside gSender's plugin iframe).
 */
export function installIcons(doc = document) {
    if (doc.getElementById('ic-sprite')) return;
    const sprite = doc.createElementNS(NS, 'svg');
    sprite.id = 'ic-sprite';
    sprite.setAttribute('aria-hidden', 'true');
    sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    sprite.innerHTML = Object.entries(ICONS).map(([k, v]) => \`<symbol id="ic-\${k}" viewBox="0 0 48 40">\${v}</symbol>\`).join('');
    doc.body.prepend(sprite);
    popover = doc.createElement('div');
    popover.className = 'icpop';
    popover.innerHTML = '<svg viewBox="0 0 48 40"><use/></svg><div></div>';
    doc.body.append(popover);
    let cur = null;
    let timer = 0;
    const hide = () => { clearTimeout(timer); popover.style.display = 'none'; };
    const show = (el) => {
        if (!el.isConnected) return;
        popover.querySelector('use').setAttribute('href', \`#ic-\${el.dataset.icon}\`);
        // First line of the caption is the title, the rest the description.
        const [title, ...rest] = (el.dataset.cap ?? '').split('\\n');
        const text = popover.lastChild;
        text.textContent = '';
        if (rest.length) text.append(Object.assign(doc.createElement('strong'), { textContent: title }), rest.join('\\n'));
        else text.textContent = title;
        popover.style.display = 'block';
        const r = el.getBoundingClientRect();
        const w = popover.offsetWidth, ht = popover.offsetHeight;
        const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
        popover.style.left = \`\${Math.max(4, Math.min(r.left, vw - w - 4))}px\`;
        popover.style.top = \`\${r.bottom + 4 + ht > vh ? Math.max(4, r.top - ht - 4) : r.bottom + 4}px\`;
    };
    doc.addEventListener('mouseover', (e) => {
        const el = e.target.closest?.('.ic[data-icon]');
        if (el === cur) return;
        cur = el;
        hide();
        if (el) timer = setTimeout(() => show(el), 350);
    });
    doc.addEventListener('mouseleave', () => { cur = null; hide(); });
}

/** A small icon element; \`cap\` is shown with the large view: a title line, then the description. */
export function icon(name, cap = '', doc = document) {
    const el = doc.createElement('span');
    el.className = 'ic';
    el.dataset.icon = name;
    if (cap) el.dataset.cap = cap;
    el.innerHTML = \`<svg viewBox="0 0 48 40" aria-hidden="true"><use href="#ic-\${name}"/></svg>\`;
    return el;
}
`;
for (const p of ['plugins/pcb-cam/ui/assets/icons.js', 'plugins/autoleveler/ui/assets/icons.js']) writeFileSync(new URL(`../${p}`, import.meta.url), out);
console.log(`${Object.keys(icons).length} icons, ${out.length} bytes`);
