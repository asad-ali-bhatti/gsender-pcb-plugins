import assert from 'node:assert/strict';
const L = await import(new URL("../plugins/autoleveler/ui/assets/leveling.js", import.meta.url));

// grid + serpentine
const g = { xmin: 0, xmax: 20, ymin: 0, ymax: 10, nx: 3, ny: 2 };
const pts = L.gridPoints(g);
assert.deepEqual(pts.map(p => [p.x, p.y]), [[0,0],[10,0],[20,0],[20,10],[10,10],[0,10]]);
assert.deepEqual(L.validateGrid({ ...g, nx: 1 }).length, 1);

// tilted plane z = 0.01x + 0.02y + 0.1 -> bilinear must be exact
const m = L.createHeightMap(g);
for (const p of pts) m.z[p.idx] = 0.01 * p.x + 0.02 * p.y + 0.1;
assert.ok(L.isComplete(m));
const h = L.heightAt(m, 7, 3);
assert.ok(Math.abs(h.z - (0.07 + 0.06 + 0.1)) < 1e-12 && !h.outside);
assert.ok(L.heightAt(m, 25, 3).outside);

// PRB
assert.deepEqual(L.parsePRB(['ok', '[PRB:-10.000,-20.500,-33.125:1]']), { x: -10, y: -20.5, z: -33.125, ok: true });
assert.equal(L.parsePRB(['[PRB:1,2,3,4:0]']).ok, false);
assert.equal(L.parsePRB(['ok']), null);

// level a file: relative to first point (z00 = 0.1)
const src = `G21 G90
G0 Z5
G0 X0 Y0
G1 Z-0.1 F100 (plunge)
G1 X10 Y0 F300
G2 X20 Y0 I5 J0
X20 Y10
G91 G0 Z1
G90 G53 G0 Z-1
M5`;
const r = L.levelGcode(src, m, { segment: 2.5, reference: 'first' });
const out = r.gcode.split('\n');
// plunge at 0,0: offset 0 -> Z-0.1
assert.ok(out.includes('G1 X0 Y0 Z-0.1 F100'), r.gcode);
// G1 0,0 -> 10,0 split into 4 segments; last at x=10 offset 0.1
assert.ok(out.includes('G1 X2.5 Y0 Z-0.075 F300'));
assert.ok(out.includes('G1 X10 Y0 Z0'));
// arc ends at 20,0 offset 0.2
assert.ok(out.includes('G1 X20 Y0 Z0.1'));
// modal continuation after arc gets explicit G2 -> we treat as arc again (center from I/J missing => I0 J0 -> r=0 -> passthrough with prefix)
assert.ok(r.gcode.includes('G2 X20 Y10') || out.some(l => l.startsWith('G1 X20 Y10')), r.gcode);
// G91 passthrough with warning, G53 untouched
assert.ok(out.includes('G91 G0 Z1') && out.includes('G90 G53 G0 Z-1'));
assert.ok(r.warnings.some(w => w.includes('G91')));
// arc points lie on circle radius 5 around (15,0) (uncompensated XY)
const arcPts = L.linearizeArc({x:10,y:0,z:0},{x:20,y:0,z:0},true,{I:5,J:0,seg:0.5});
for (const p of arcPts) assert.ok(Math.abs(Math.hypot(p.x-15,p.y)-5) < 1e-9);
assert.ok(arcPts.every(p => p.y >= -1e-9), 'CW from (10,0) to (20,0) about (15,0) goes over the top');
// R-format arc equals IJ arc
const rp = L.linearizeArc({x:10,y:0,z:0},{x:20,y:0,z:0},true,{R:5,seg:0.5});
assert.equal(rp.length, arcPts.length);
// full circle
const fc = L.linearizeArc({x:0,y:0,z:0},{x:0,y:0,z:-1},false,{I:1,J:0,seg:0.1});
assert.ok(fc.length > 60 && Math.abs(fc.at(-1).z + 1) < 1e-12);
// inch file: offsets converted to inch
const ri = L.levelGcode('G20 G90\nG0 X0 Y0 Z0\nG1 X0.3937 Y0 F10', m, { segment: 100 });
assert.ok(ri.gcode.includes('G1 X0.3937 Y0 Z0.00394'), ri.gcode);
console.log('all tests passed');
