import { test } from 'node:test';
import assert from 'node:assert/strict';
const core = (p) => import(new URL(`../../plugins/pcb-cam/ui/core/${p}`, import.meta.url));
const { validate } = await core('schema.js');
const T = await core('tools.js');
const P = await core('project.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);
const cut = { feed: 120, plunge: 60, rpm: 12000, stepdown: 0.1 };
const vbit20 = { id: 'vbit-20-0.1', name: '20° V-bit 0.1 mm', type: 'vbit', toolNumber: 1, tipDiameter: 0.1, angle: 20, cutting: cut };
const vbit30 = { id: 'vbit-30-0.2', name: '30° V-bit 0.2 mm', type: 'vbit', toolNumber: 2, tipDiameter: 0.2, angle: 30, cutting: cut };
const em08 = { id: 'em-0.8', name: '0.8 mm end mill', type: 'endmill', toolNumber: 3, diameter: 0.8, cutting: { ...cut, stepdown: 0.4 }, materials: { FR1: { feed: 200 } } };
const drill1 = { id: 'drill-1.0', name: '1.0 mm drill', type: 'drill', toolNumber: 4, diameter: 1, cutting: { ...cut, stepdown: 2 } };

test('schema validator subset', () => {
    const s = {
        $defs: { pos: { type: 'number', exclusiveMinimum: 0 } },
        type: 'object', additionalProperties: false, required: ['a'],
        properties: {
            a: { $ref: '#/$defs/pos' },
            b: { enum: ['x', null] },
            c: { type: 'array', items: { type: 'integer' }, minItems: 1 },
            d: { type: 'string', pattern: '^[a-z]+$' },
            e: { oneOf: [{ type: 'object', required: ['k'], properties: { k: { const: 'one' }, v: { type: 'number' } } }, { type: 'object', required: ['k'], properties: { k: { const: 'two' }, w: { type: 'string' } } }] },
        },
    };
    assert.deepEqual(validate(s, { a: 1, b: null, c: [1], d: 'ab', e: { k: 'two', w: 'x' } }), []);
    const paths = (v) => validate(s, v).map((e) => e.path).sort();
    assert.deepEqual(paths({}), ['/a']);
    assert.deepEqual(paths({ a: 0 }), ['/a']);
    assert.deepEqual(paths({ a: 1, z: 1 }), ['/z']);
    assert.deepEqual(paths({ a: 1, b: 'y' }), ['/b']);
    assert.deepEqual(paths({ a: 1, c: [] }), ['/c']);
    assert.deepEqual(paths({ a: 1, c: [1.5] }), ['/c/0']);
    assert.deepEqual(paths({ a: 1, d: 'A' }), ['/d']);
    assert.deepEqual(paths({ a: 1, e: { k: 'one', v: 'no' } }), ['/e/v'], 'discriminated branch errors');
    assert.deepEqual(paths({ a: 1, e: { k: 'three' } }), ['/e/k']);
    assert.deepEqual(paths({ a: NaN }), ['/a'], 'NaN rejected');
    assert.deepEqual(paths({ a: Infinity }), ['/a'], 'Infinity rejected');
    assert.equal(validate({ type: 'number' }, 3)[0], undefined, 'integers are numbers');
    assert.equal(validate({ type: 'integer' }, 3.5).length, 1);
});

test('tool schema and geometry', () => {
    for (const t of [vbit20, vbit30, em08, drill1]) assert.deepEqual(T.validateTool(t), [], t.id);
    assert.ok(T.validateTool({ ...vbit20, diameter: 1 }).some((e) => e.path === '/diameter'), 'V-bit has no diameter');
    assert.ok(T.validateTool({ ...em08, angle: 30 }).some((e) => e.path === '/angle'));
    assert.ok(T.validateTool({ ...vbit20, angle: 180 }).length);
    assert.ok(T.validateTool({ ...vbit20, type: 'laser' }).some((e) => e.path === '/type'));
    assert.ok(T.validateTool({ ...vbit20, cutting: { feed: 1 } }).length, 'cutting fields required');
    assert.ok(T.validateTool({ ...vbit20, id: 'has space' }).some((e) => e.path === '/id'));

    // 20° V-bit with 0.1 mm tip at 0.05 mm: 0.1 + 2·0.05·tan(10°)
    near(T.widthAtDepth(vbit20, 0.05), 0.1 + 0.1 * Math.tan(Math.PI / 18), 1e-12);
    near(T.widthAtDepth(vbit30, 0), 0.2, 1e-12);
    assert.equal(T.widthAtDepth(em08, 1), 0.8);
    near(T.depthForWidth(vbit20, T.widthAtDepth(vbit20, 0.07)), 0.07, 1e-12, 'inverse');
    assert.equal(T.depthForWidth(vbit20, 0.05), null, 'narrower than the tip');
    assert.equal(T.depthForWidth(em08, 0.8), null);
    assert.throws(() => T.widthAtDepth(vbit20, -1));

    assert.deepEqual(T.cuttingFor(em08, 'FR1'), { ...em08.cutting, feed: 200 });
    assert.deepEqual(T.cuttingFor(em08, 'FR4'), em08.cutting);
    assert.deepEqual(T.cuttingFor(em08), em08.cutting);
});

test('tool database: revision, replace in place, unique T numbers', () => {
    let db = T.createToolDb();
    assert.deepEqual(T.validateTool(vbit20), []);
    db = T.setTool(db, vbit20);
    db = T.setTool(db, em08);
    assert.equal(db.revision, 2);
    db = T.setTool(db, { ...vbit20, name: 'renamed' });
    assert.deepEqual(db.tools.map((t) => t.id), ['vbit-20-0.1', 'em-0.8'], 'replaced in place');
    assert.equal(T.findTool(db, 'vbit-20-0.1').name, 'renamed');
    assert.throws(() => T.setTool(db, { ...vbit30, toolNumber: 1 }), (e) => e.errors[0].path === '/toolNumber');
    assert.throws(() => T.setTool(db, { ...vbit30, angle: -1 }), (e) => e.errors.length > 0);
    db = T.removeTool(db, 'em-0.8');
    assert.equal(db.revision, 4);
    assert.throws(() => T.removeTool(db, 'em-0.8'));
    assert.deepEqual(validate(T.TOOL_DB_SCHEMA, db), []);
});

/** Applies commands in order, failing the test on the first rejection. */
function run(project, ...commands) {
    let p = project;
    for (const c of commands) {
        const r = P.applyCommand(p, c);
        assert.ok(r.ok, `${c.name}: ${JSON.stringify(r.error)}`);
        p = r.project;
    }
    return p;
}

const iso = (id, region, tool, extra = {}) => ({ name: 'operation.set', args: { operation: { id, type: 'isolation', enabled: true, input: 'top', region, tool, depth: 0.05, passes: 2, overlap: 0.4, direction: 'climb', ...extra } } });

test('a whole job through commands only (fine bit around U3, coarse elsewhere)', () => {
    const start = P.createProject('demo');
    assert.deepEqual(P.validateProject(start), []);
    const p = run(start,
        { name: 'input.add', args: { file: 'demo-F_Cu.gtl', role: 'copper', side: 'top' } },
        { name: 'input.add', args: { file: 'demo-PTH.drl', role: 'drill', side: null, plated: true } },
        { name: 'input.add', args: { file: 'demo-Edge_Cuts.gm1', role: 'outline', side: null } },
        { name: 'setup.update', args: { stockThickness: 1.5, material: 'FR1' } },
        { name: 'tool.set', args: { tool: vbit20 } },
        { name: 'tool.set', args: { tool: vbit30 } },
        { name: 'tool.set', args: { tool: em08 } },
        { name: 'tool.set', args: { tool: drill1 } },
        { name: 'region.set', args: { id: 'fine', shape: { kind: 'component', ref: 'U3', margin: 1.5 } } },
        { name: 'region.set', args: { id: 'rest', shape: { kind: 'remainder' } } },
        iso('iso-fine', 'fine', 'vbit-20-0.1', { passes: 3 }),
        iso('iso-rest', 'rest', 'vbit-30-0.2'),
        { name: 'operation.set', args: { operation: { id: 'drill', type: 'drilling', enabled: true, input: 'drill', tool: 'drill-1.0', holes: 'all', breakthrough: 0.2, peck: 0 } } },
        { name: 'operation.set', args: { operation: { id: 'cut', type: 'cutout', enabled: true, input: 'outline', tool: 'em-0.8', breakthrough: 0.2, side: 'outside', tabs: { count: 4, width: 2, height: 0.6 } } } },
        { name: 'operation.move', args: { id: 'drill', index: 0 } },
    );
    assert.deepEqual(p.inputs.map((i) => i.id), ['copper-top', 'drill', 'outline']);
    assert.deepEqual(p.operations.map((o) => o.id), ['drill', 'iso-fine', 'iso-rest', 'cut']);
    assert.equal(p.setup.material, 'FR1');
    assert.equal(p.setup.safeZ, 5, 'partial update keeps other fields');
    // inputs got ids from role+side, but the isolation ops say input "top": validation catches it
    assert.deepEqual(P.validateProject(p).map((i) => i.code), ['missing-input', 'missing-input']);
    const p2 = run(P.createProject('demo'),
        { name: 'input.add', args: { id: 'top', file: 'demo-F_Cu.gtl', role: 'copper', side: 'top' } },
        { name: 'tool.set', args: { tool: vbit20 } },
        iso('iso', null, 'vbit-20-0.1'));
    assert.deepEqual(P.validateProject(p2), []);
});

test('commands never mutate their input and reject bad changes', () => {
    const p = run(P.createProject('x'),
        { name: 'input.add', args: { id: 'top', file: 'a.gtl', role: 'copper', side: 'top' } },
        { name: 'tool.set', args: { tool: vbit20 } },
        { name: 'region.set', args: { id: 'r', shape: { kind: 'rect', rect: [0, 0, 10, 10] } } },
        iso('iso', 'r', 'vbit-20-0.1'));
    const before = JSON.stringify(p);
    const reject = (cmd, code) => {
        const r = P.applyCommand(p, cmd);
        assert.equal(r.ok, false, cmd.name);
        assert.equal(r.error.code, code, `${cmd.name}: ${JSON.stringify(r.error)}`);
    };
    reject({ name: 'nope' }, 'unknown-command');
    reject({ name: 'input.add', args: { file: 'a.gtl', role: 'copper' } }, 'invalid-args');
    reject({ name: 'input.add', args: { id: 'top', file: 'b.gtl', role: 'copper', side: 'top' } }, 'duplicate-id');
    reject({ name: 'input.remove', args: { id: 'top' } }, 'in-use');
    reject({ name: 'region.remove', args: { id: 'r' } }, 'in-use');
    reject({ name: 'tool.remove', args: { id: 'vbit-20-0.1' } }, 'in-use');
    reject({ name: 'input.remove', args: { id: 'missing' } }, 'not-found');
    reject({ name: 'operation.move', args: { id: 'iso', index: 5 } }, 'bad-index');
    reject({ name: 'setup.update', args: { stockThickness: -1 } }, 'invalid-args');
    reject({ name: 'setup.update', args: { bogus: 1 } }, 'invalid-args');
    reject({ name: 'operation.set', args: { operation: { id: 'iso', type: 'isolation', enabled: true, input: 'top', tool: 'vbit-20-0.1', depth: 0.05, passes: 0, overlap: 0.4, direction: 'climb' } } }, 'invalid-args');
    reject({ name: 'region.set', args: { id: 'r2', shape: { kind: 'polygon', points: [[0, 0], [1, 1]] } } }, 'invalid-args');
    reject({ name: 'tool.set', args: { tool: { ...vbit20, angle: 0 } } }, 'invalid-args');
    assert.equal(JSON.stringify(p), before, 'input project untouched');
    // a successful command returns a new object and leaves the old one alone
    const r = P.applyCommand(p, { name: 'project.rename', args: { name: 'y' } });
    assert.equal(r.project.name, 'y');
    assert.equal(p.name, 'x');
});

test('validation: references, tool types, numbers, depths', () => {
    const base = run(P.createProject('v'),
        { name: 'input.add', args: { id: 'top', file: 'a.gtl', role: 'copper', side: 'top' } },
        { name: 'input.add', args: { id: 'edge', file: 'e.gm1', role: 'outline', side: null } },
        { name: 'tool.set', args: { tool: { ...vbit20, maxDepth: 0.1 } } },
        { name: 'tool.set', args: { tool: { ...drill1, toolNumber: 1 } } },
        iso('iso', 'nowhere', 'vbit-20-0.1', { depth: 0.2 }),
        { name: 'operation.set', args: { operation: { id: 'cut', type: 'cutout', enabled: true, input: 'top', tool: 'drill-1.0', breakthrough: 0.2, side: 'outside', tabs: { count: 0, width: 1, height: 0 } } } },
    );
    const codes = P.validateProject(base).map((i) => i.code).sort();
    assert.deepEqual(codes, ['beyond-tool-depth', 'duplicate-tool-number', 'missing-region', 'wrong-input-role', 'wrong-tool-type']);
    assert.deepEqual(P.validateProject({ ...base, version: 2 })[0].code, 'schema');
});

test('validation with loaded layers: missing files, parse errors, unknown components', () => {
    const p = run(P.createProject('l'),
        { name: 'input.add', args: { id: 'top', file: 'a.gtl', role: 'copper', side: 'top' } },
        { name: 'input.add', args: { id: 'drill', file: 'a.drl', role: 'drill', side: null } },
        { name: 'region.set', args: { id: 'u1', shape: { kind: 'component', ref: 'U1' } } },
        { name: 'region.set', args: { id: 'gnd', shape: { kind: 'net', net: 'GND', margin: 0.5 } } });
    const top = { format: 'gerber', issues: [], objects: [{ attrs: { '.P': ['U1', '1'], '.N': ['VCC'] } }] };
    const codes = (layers) => P.validateProject(p, { layers }).map((i) => i.code).sort();
    assert.deepEqual(codes({ top }), ['input-not-loaded', 'unknown-net']);
    assert.deepEqual(codes({ top, drill: { format: 'gerber', issues: [{ severity: 'error', message: 'x' }] } }), ['input-has-errors', 'unknown-net', 'wrong-format']);
    const withGnd = { ...top, objects: [...top.objects, { attrs: { '.N': ['GND'] } }] };
    assert.deepEqual(codes({ top: withGnd, drill: { format: 'excellon', issues: [] } }), []);
    assert.equal(P.componentOf({ attrs: { '.C': ['R5'] } }), 'R5');
    assert.equal(P.netOf({ attrs: { '.N': [''] } }), null);
});

test('command catalogue is self-describing JSON Schema', () => {
    assert.ok(P.COMMANDS.length >= 12);
    for (const c of P.COMMANDS) {
        assert.match(c.name, /^[a-z]+\.[a-z]+$/);
        assert.ok(c.description.length > 10, c.name);
        assert.equal(c.input.type, 'object', c.name);
        assert.ok(c.input.$defs.tool, `${c.name} carries $defs`);
    }
    // every command's schema validates its own example through the generic validator
    const tool = P.COMMANDS.find((c) => c.name === 'tool.set');
    assert.deepEqual(validate(tool.input, { tool: vbit20 }), []);
    assert.ok(validate(tool.input, { tool: { ...vbit20, angle: 200 } }).length);
});
