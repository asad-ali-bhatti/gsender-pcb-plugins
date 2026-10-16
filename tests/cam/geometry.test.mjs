import { test } from 'node:test';
import assert from 'node:assert/strict';
const G = await import(new URL('../../plugins/pcb-cam/ui/core/geometry.js', import.meta.url));

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);
const shape = (...rings) => G.normalize(rings.map(G.toPath));

test('units round-trip at 0.1 µm resolution', () => {
    assert.equal(G.SCALE, 1e4);
    assert.equal(G.toUnits(1.23456), 12346);
    assert.equal(G.toMm(G.toUnits(-0.00004)), 0, 'no negative zero');
    assert.deepEqual(G.fromPath(G.toPath([[1.5, -2.25]])), [[1.5, -2.25]]);
});

test('primitive constructors have the right area and orientation', () => {
    near(G.area(shape(G.rect(0, 0, 10, 5))), 50, 1e-9, 'rect');
    // Inscribed polygons lose at most perimeter × tolerance of area.
    const loss = (perimeter) => perimeter * G.ARC_TOLERANCE;
    const circleArea = G.area(shape(G.circle(3, 4, 2)));
    assert.ok(circleArea <= Math.PI && Math.PI - circleArea <= loss(2 * Math.PI), `circle ${circleArea}`);
    // obround 4×2: rectangle 2×2 + two half discs r=1
    near(G.area(shape(G.obround(0, 0, 4, 2))), 4 + Math.PI, loss(2 * Math.PI), 'obround horizontal');
    near(G.area(shape(G.obround(0, 0, 2, 4))), 4 + Math.PI, loss(2 * Math.PI), 'obround vertical');
    near(G.area(shape(G.obround(0, 0, 3, 3))), (Math.PI * 9) / 4, loss(3 * Math.PI), 'obround square = circle');
    // regular hexagon, circumradius 1: 3√3/2
    near(G.area(shape(G.regularPolygon(0, 0, 2, 6))), (3 * Math.sqrt(3)) / 2, 1e-3, 'hexagon (vertices rounded to 0.1 µm)');
    for (const pts of [G.rect(0, 0, 1, 1), G.circle(0, 0, 1), G.obround(0, 0, 2, 1), G.obround(0, 0, 1, 2), G.regularPolygon(0, 0, 1, 5)]) {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
            a += x1 * y2 - x2 * y1;
        }
        assert.ok(a > 0, 'constructed rings are CCW');
    }
});

test('circle approximation stays within tolerance', () => {
    const r = 5, tol = 0.001;
    const pts = G.circle(0, 0, 2 * r, tol);
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        const mid = Math.hypot((x1 + x2) / 2, (y1 + y2) / 2);
        assert.ok(r - mid <= tol + 1e-12, 'chord sagitta within tolerance');
    }
});

test('arcPoints: quarter arc ends exactly at end and stays on the circle', () => {
    const pts = G.arcPoints([1, 0], [0, 1], [0, 0], Math.PI / 2, 0.0001);
    assert.deepEqual(pts[pts.length - 1], [0, 1]);
    for (const [x, y] of pts) near(Math.hypot(x, y), 1, 1e-12);
    // clockwise sweep goes the long way round
    const cw = G.arcPoints([1, 0], [0, 1], [0, 0], -1.5 * Math.PI, 0.0001);
    assert.ok(cw.some(([x, y]) => x < -0.9 && Math.abs(y) < 0.2), 'passes through (-1, 0)');
});

test('convex hull', () => {
    const hull = G.convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 0.5]]);
    assert.equal(hull.length, 4);
    near(G.area(shape(hull)), 4, 1e-9);
});

test('normalize and fillEach handle orientation', () => {
    const ccw = G.rect(0, 0, 2, 2);
    const cw = [...G.rect(0, 0, 2, 2)].reverse();
    near(G.area(G.normalize([G.toPath(cw)])), 4, 1e-9, 'a lone CW ring is filled');
    // nested rings with opposite orientation make a hole under non-zero
    near(G.area(G.normalize([G.toPath(G.rect(0, 0, 4, 4)), G.toPath(cw)])), 12, 1e-9, 'hole');
    // fillEach fills each independently: no hole
    near(G.area(G.fillEach([G.toPath(G.rect(0, 0, 4, 4)), G.toPath(cw)])), 16, 1e-9, 'fillEach');
    assert.ok(G.area(G.normalize([G.toPath(ccw)])) > 0);
});

test('boolean ops', () => {
    const a = shape(G.rect(1, 1, 2, 2)); // 0..2
    const b = shape(G.rect(2, 2, 2, 2)); // 1..3
    near(G.area(G.union(a, b)), 7, 1e-9, 'union');
    near(G.area(G.intersection(a, b)), 1, 1e-9, 'intersection');
    near(G.area(G.difference(a, b)), 3, 1e-9, 'difference');
    assert.deepEqual(G.difference([], b), []);
    assert.deepEqual(G.union(), []);
    assert.deepEqual(G.normalize([G.toPath([[0, 0], [1, 1]])]), [], 'degenerate input');
    assert.equal(G.difference(a, []), a);
    assert.deepEqual(G.intersection(a, []), []);
});

test('offset: grow and shrink, holes move the right way', () => {
    const r = shape(G.rect(5, 2.5, 10, 5));
    near(G.area(G.offset(r, 0.1)), 50 + 30 * 0.1 + Math.PI * 0.01, 0.001, 'round grow');
    near(G.area(G.offset(r, 0.1, { join: 'miter' })), 10.2 * 5.2, 1e-6, 'miter grow');
    near(G.area(G.offset(r, -1)), 8 * 3, 1e-6, 'shrink');
    assert.deepEqual(G.offset(r, -3), [], 'shrinks away');
    // square ring 10×10 with 6×6 hole; growing by 1 shrinks the hole to 4×4
    const ring = G.normalize([G.toPath(G.rect(0, 0, 10, 10)), G.toPath([...G.rect(0, 0, 6, 6)].reverse())]);
    near(G.area(ring), 64, 1e-9);
    near(G.area(G.offset(ring, 1, { join: 'miter' })), 144 - 16, 1e-6, 'ring grows outwards and inwards');
    assert.equal(G.islands(G.offset(ring, 1, { join: 'miter' }))[0].holes.length, 1);
});

test('stroke: round, square and butt caps; single point', () => {
    near(G.area(G.stroke([[0, 0], [10, 0]], 1)), 10 + Math.PI / 4, 0.002, 'round');
    near(G.area(G.stroke([[0, 0], [10, 0]], 1, { cap: 'square' })), 11, 1e-6, 'square');
    near(G.area(G.stroke([[0, 0], [10, 0]], 1, { cap: 'butt' })), 10, 1e-6, 'butt');
    near(G.area(G.stroke([[3, 3]], 2)), Math.PI, 2 * Math.PI * G.ARC_TOLERANCE, 'dot');
    near(G.area(G.stroke([[3, 3], [3, 3]], 2)), Math.PI, 2 * Math.PI * G.ARC_TOLERANCE, 'zero-length segment is a dot');
    assert.deepEqual(G.stroke([[0, 0], [1, 0]], 0), []);
    // L-shaped polyline, width 1: two 10×1 bars overlapping a 1×1 corner
    near(G.area(G.stroke([[0, 0], [10, 0], [10, 10]], 1, { cap: 'butt', join: 'miter' })), 10.5 + 10.5 - 1, 1e-6, 'polyline');
});

test('bounds, islands, containsPoint', () => {
    const s = G.union(shape(G.rect(0, 0, 2, 2)), shape(G.rect(10, 0, 2, 2)));
    assert.deepEqual(G.bounds(s), { xmin: -1, ymin: -1, xmax: 11, ymax: 1 });
    assert.equal(G.bounds([]), null);
    assert.equal(G.islands(s).length, 2);
    const ring = G.normalize([G.toPath(G.rect(0, 0, 10, 10)), G.toPath([...G.rect(0, 0, 6, 6)].reverse())]);
    assert.equal(G.containsPoint(ring, 4, 0), true, 'in copper');
    assert.equal(G.containsPoint(ring, 0, 0), false, 'in hole');
    assert.equal(G.containsPoint(ring, 20, 0), false, 'outside');
    assert.equal(G.containsPoint(ring, 5, 0), true, 'on boundary');
    assert.deepEqual(G.mergeBounds(null, { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, { xmin: -1, ymin: 0.5, xmax: 0.5, ymax: 2 }), { xmin: -1, ymin: 0, xmax: 1, ymax: 2 });
});

test('large coordinates use clipper big-integer path correctly', () => {
    // 6 m from the origin: beyond clipper's ±47,453,132-unit fast range
    const a = shape(G.rect(6000, 6000, 2, 2));
    const b = shape(G.rect(6001, 6001, 2, 2));
    near(G.area(G.union(a, b)), 7, 1e-6);
    near(G.area(G.offset(a, 0.5, { join: 'miter' })), 9, 1e-6);
});
