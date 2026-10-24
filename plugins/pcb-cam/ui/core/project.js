// The PCB CAM project document and the only way to change it: named commands
// with JSON-schema inputs, applied by `applyCommand`. The plugin UI and (later)
// MCP tools both go through these commands.

import { validate } from './schema.js';
import { ID_PATTERN, TOOL_SCHEMA } from './tools.js';

const id = { type: 'string', pattern: ID_PATTERN };
const num = (extra) => ({ type: 'number', ...extra });
const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };

const REGION_SHAPE = {
    oneOf: [
        {
            type: 'object', additionalProperties: false, required: ['kind', 'rect'],
            properties: { kind: { const: 'rect' }, rect: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[xmin, ymin, xmax, ymax] in mm' } },
        },
        {
            type: 'object', additionalProperties: false, required: ['kind', 'points'],
            properties: { kind: { const: 'polygon' }, points: { type: 'array', items: point, minItems: 3 } },
        },
        {
            type: 'object', additionalProperties: false, required: ['kind', 'ref'],
            properties: { kind: { const: 'component' }, ref: { type: 'string', minLength: 1 }, margin: num({ minimum: 0, maximum: 50 }) },
        },
        {
            type: 'object', additionalProperties: false, required: ['kind', 'net'],
            properties: { kind: { const: 'net' }, net: { type: 'string', minLength: 1 }, margin: num({ minimum: 0, maximum: 50 }) },
        },
        {
            type: 'object', additionalProperties: false, required: ['kind'],
            properties: { kind: { const: 'remainder' } },
        },
    ],
};

const opBase = {
    id,
    name: { type: 'string', maxLength: 100 },
    enabled: { type: 'boolean' },
    input: id,
    region: { type: ['string', 'null'], pattern: ID_PATTERN },
    tool: id,
    multiDepth: { type: 'boolean', description: 'Cut in several passes of at most the tool stepdown; false cuts the full depth in one pass. Default: on for cutout and drilling, off for isolation and clearing' },
    face: { enum: ['top', 'bottom'], description: 'Board side facing up while this operation runs; bottom mirrors X about the board centre. Default: the copper input\'s side; drilling and cutout follow the copper operations when they are all on the bottom, else top' },
};
const opRequired = ['id', 'type', 'enabled', 'input', 'tool'];

const OPERATION = {
    oneOf: [
        {
            type: 'object', additionalProperties: false, required: [...opRequired, 'depth', 'passes', 'overlap', 'direction'],
            properties: {
                ...opBase,
                type: { const: 'isolation' },
                depth: num({ exclusiveMinimum: 0, maximum: 2, description: 'Cut depth below the copper surface, mm' }),
                passes: { type: 'integer', minimum: 1, maximum: 20 },
                overlap: num({ minimum: 0, maximum: 0.9, description: 'Fraction of the cut width each pass overlaps the previous one' }),
                direction: { enum: ['climb', 'conventional'] },
            },
        },
        {
            type: 'object', additionalProperties: false, required: [...opRequired, 'holes', 'breakthrough'],
            properties: {
                ...opBase,
                type: { const: 'drilling' },
                method: { enum: ['drill', 'mill'], description: "drill: plunge every hole straight down whatever its size; mill: plunge holes the tool's size, helix-mill bigger holes and slots (end mills only). Default: drill for drill bits, mill for end mills" },
                holes: { enum: ['all', 'plated', 'nonplated'] },
                minDiameter: num({ minimum: 0 }),
                maxDiameter: num({ exclusiveMinimum: 0 }),
                breakthrough: num({ minimum: 0, maximum: 5, description: 'Depth below the stock bottom, mm' }),
                peck: num({ minimum: 0, maximum: 10, description: 'Peck depth, mm: lift out to clear chips after each this much depth, for drilled and helix-milled holes; 0 = no pecking' }),
            },
        },
        {
            type: 'object', additionalProperties: false, required: [...opRequired, 'breakthrough', 'side', 'tabs'],
            properties: {
                ...opBase,
                type: { const: 'cutout' },
                breakthrough: num({ minimum: 0, maximum: 5 }),
                side: { enum: ['outside', 'inside', 'on'] },
                direction: { enum: ['climb', 'conventional'] },
                tabs: {
                    type: 'object', additionalProperties: false, required: ['count', 'width', 'height'],
                    properties: { count: { type: 'integer', minimum: 0, maximum: 64 }, width: num({ exclusiveMinimum: 0, maximum: 20 }), height: num({ minimum: 0, maximum: 5 }) },
                },
            },
        },
        {
            type: 'object', additionalProperties: false, required: [...opRequired, 'depth', 'overlap', 'rest'],
            properties: {
                ...opBase,
                type: { const: 'clearing' },
                depth: num({ exclusiveMinimum: 0, maximum: 2 }),
                overlap: num({ minimum: 0, maximum: 0.9 }),
                rest: { type: 'boolean', description: 'Only clear where earlier operations did not' },
            },
        },
    ],
};

const INPUT = {
    type: 'object', additionalProperties: false, required: ['id', 'file', 'role', 'side'],
    properties: {
        id,
        file: { type: 'string', minLength: 1, maxLength: 260 },
        role: { enum: ['copper', 'outline', 'drill', 'other'] },
        side: { enum: ['top', 'bottom', null] },
        plated: { type: ['boolean', 'null'] },
    },
};

const SETUP = {
    type: 'object', additionalProperties: false, required: ['stockThickness', 'safeZ', 'travelZ', 'origin'],
    properties: {
        material: { type: 'string', maxLength: 40, description: 'Selects per-material tool settings' },
        stockThickness: num({ exclusiveMinimum: 0, maximum: 20 }),
        safeZ: num({ exclusiveMinimum: 0, maximum: 100, description: 'Z for rapid moves between operations, mm' }),
        travelZ: num({ exclusiveMinimum: 0, maximum: 100, description: 'Z for short moves within an operation, mm' }),
        origin: { enum: ['gerber', 'board-lower-left'] },
    },
};

const OUTPUT = {
    type: 'object', additionalProperties: false, required: ['dialect', 'toolChange', 'decimals'],
    properties: {
        dialect: { enum: ['grbl'] },
        toolChange: { enum: ['m6', 'split'], description: 'One file with M6 tool changes, or one file per tool' },
        decimals: { type: 'integer', minimum: 3, maximum: 5 },
        spindleDelay: num({ minimum: 0, maximum: 30, description: 'Seconds to wait after starting the spindle; default 2' }),
    },
};

export const PROJECT_SCHEMA = {
    $defs: { tool: TOOL_SCHEMA },
    type: 'object',
    additionalProperties: false,
    required: ['version', 'name', 'inputs', 'setup', 'regions', 'operations', 'tools', 'output'],
    properties: {
        version: { const: 1 },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        inputs: { type: 'array', items: INPUT },
        setup: SETUP,
        regions: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false, required: ['id', 'shape'],
                properties: { id, name: { type: 'string', maxLength: 100 }, shape: REGION_SHAPE },
            },
        },
        operations: { type: 'array', items: OPERATION },
        tools: { type: 'array', items: { $ref: '#/$defs/tool' } },
        output: OUTPUT,
    },
};

export function createProject(name = 'Untitled board') {
    return {
        version: 1,
        name,
        inputs: [],
        setup: { stockThickness: 1.6, safeZ: 5, travelZ: 1, origin: 'gerber' },
        regions: [],
        operations: [],
        tools: [],
        output: { dialect: 'grbl', toolChange: 'm6', decimals: 4 },
    };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

class CommandError extends Error {
    constructor(code, message, errors) {
        super(message);
        this.code = code;
        this.errors = errors;
    }
}

const fail = (code, message, errors) => { throw new CommandError(code, message, errors); };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const partial = (schema) => ({ ...schema, required: [] });

function indexOf(list, key, what) {
    const i = list.findIndex((x) => x.id === key);
    if (i < 0) fail('not-found', `No ${what} "${key}"`);
    return i;
}

function uniqueId(list, base) {
    const slug = String(base).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
    const used = new Set(list.map((x) => x.id));
    if (!used.has(slug)) return slug;
    for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

function usedBy(project, field, key) {
    return project.operations.filter((op) => op[field] === key).map((op) => op.id);
}

const COMMAND_LIST = [
    {
        name: 'project.rename',
        description: 'Rename the project.',
        input: obj({ name: PROJECT_SCHEMA.properties.name }, ['name']),
        apply(p, a) { p.name = a.name; },
    },
    {
        name: 'input.add',
        description: 'Add a fabrication file (Gerber or Excellon) to the project. The id defaults to a slug of the role and side.',
        input: obj({ ...INPUT.properties, id }, ['file', 'role', 'side']),
        apply(p, a) {
            const input = { ...a, id: a.id ?? uniqueId(p.inputs, [a.role, a.side].filter(Boolean).join('-')) };
            if (p.inputs.some((x) => x.id === input.id)) fail('duplicate-id', `Input "${input.id}" already exists`);
            p.inputs.push(input);
            return { id: input.id };
        },
    },
    {
        name: 'input.update',
        description: 'Change an input\'s file name, role, side or plating.',
        input: obj({ id, file: INPUT.properties.file, role: INPUT.properties.role, side: INPUT.properties.side, plated: INPUT.properties.plated }, ['id']),
        apply(p, a) {
            const i = indexOf(p.inputs, a.id, 'input');
            p.inputs[i] = { ...p.inputs[i], ...a };
        },
    },
    {
        name: 'input.remove',
        description: 'Remove an input. Fails while an operation uses it.',
        input: obj({ id }, ['id']),
        apply(p, a) {
            const i = indexOf(p.inputs, a.id, 'input');
            const users = usedBy(p, 'input', a.id);
            if (users.length) fail('in-use', `Input "${a.id}" is used by ${users.join(', ')}`);
            p.inputs.splice(i, 1);
        },
    },
    {
        name: 'setup.update',
        description: 'Change stock and machine setup (thickness, safe and travel heights, origin, material).',
        input: partial(SETUP),
        apply(p, a) { p.setup = { ...p.setup, ...a }; },
    },
    {
        name: 'region.set',
        description: 'Create or replace a region: a rectangle, polygon, component (refdes + margin), net (+ margin), or "remainder" (everything not covered by the other regions that operations of the same type use on the same input).',
        input: obj({ id, name: { type: 'string', maxLength: 100 }, shape: REGION_SHAPE }, ['id', 'shape']),
        apply(p, a) {
            const i = p.regions.findIndex((r) => r.id === a.id);
            if (i < 0) p.regions.push({ ...a });
            else p.regions[i] = { ...a };
        },
    },
    {
        name: 'region.remove',
        description: 'Remove a region. Fails while an operation uses it.',
        input: obj({ id }, ['id']),
        apply(p, a) {
            const i = indexOf(p.regions, a.id, 'region');
            const users = usedBy(p, 'region', a.id);
            if (users.length) fail('in-use', `Region "${a.id}" is used by ${users.join(', ')}`);
            p.regions.splice(i, 1);
        },
    },
    {
        name: 'operation.set',
        description: 'Create or replace an operation (isolation, drilling, cutout or clearing). New operations are appended; operations run in list order.',
        input: obj({ operation: OPERATION }, ['operation']),
        apply(p, a) {
            const op = a.operation;
            const i = p.operations.findIndex((o) => o.id === op.id);
            if (i < 0) p.operations.push(structuredClone(op));
            else p.operations[i] = structuredClone(op);
        },
    },
    {
        name: 'operation.remove',
        description: 'Remove an operation.',
        input: obj({ id }, ['id']),
        apply(p, a) { p.operations.splice(indexOf(p.operations, a.id, 'operation'), 1); },
    },
    {
        name: 'operation.move',
        description: 'Move an operation to a new position (0 = first).',
        input: obj({ id, index: { type: 'integer', minimum: 0 } }, ['id', 'index']),
        apply(p, a) {
            const i = indexOf(p.operations, a.id, 'operation');
            if (a.index >= p.operations.length) fail('bad-index', `Index ${a.index} is past the end (${p.operations.length} operations)`);
            const [op] = p.operations.splice(i, 1);
            p.operations.splice(a.index, 0, op);
        },
    },
    {
        name: 'tool.set',
        description: 'Add or replace a tool in the project (a snapshot of a tool database entry).',
        input: obj({ tool: { $ref: '#/$defs/tool' } }, ['tool']),
        apply(p, a) {
            const i = p.tools.findIndex((t) => t.id === a.tool.id);
            if (i < 0) p.tools.push(structuredClone(a.tool));
            else p.tools[i] = structuredClone(a.tool);
        },
    },
    {
        name: 'tool.remove',
        description: 'Remove a tool from the project. Fails while an operation uses it.',
        input: obj({ id }, ['id']),
        apply(p, a) {
            const i = indexOf(p.tools, a.id, 'tool');
            const users = usedBy(p, 'tool', a.id);
            if (users.length) fail('in-use', `Tool "${a.id}" is used by ${users.join(', ')}`);
            p.tools.splice(i, 1);
        },
    },
    {
        name: 'output.update',
        description: 'Change G-code output settings.',
        input: partial(OUTPUT),
        apply(p, a) { p.output = { ...p.output, ...a }; },
    },
];

/** Command catalogue: name, description and JSON-schema input (with `$defs` inlined for `$ref`s). */
export const COMMANDS = COMMAND_LIST.map(({ name, description, input }) => ({
    name,
    description,
    input: { $defs: PROJECT_SCHEMA.$defs, ...input },
}));

const BY_NAME = new Map(COMMAND_LIST.map((c) => [c.name, c]));

/**
 * Applies one command. Never mutates `project`.
 * @returns {{ ok: true, project: object, result?: object } | { ok: false, error: { code: string, message: string, errors?: object[] } }}
 */
export function applyCommand(project, command) {
    const def = BY_NAME.get(command?.name);
    if (!def) return { ok: false, error: { code: 'unknown-command', message: `Unknown command "${command?.name}"` } };
    const args = command.args ?? {};
    const argErrors = validate(def.input, args, { $defs: PROJECT_SCHEMA.$defs });
    if (argErrors.length) return { ok: false, error: { code: 'invalid-args', message: `Invalid arguments for ${def.name}`, errors: argErrors } };
    const next = structuredClone(project);
    let result;
    try {
        result = def.apply(next, structuredClone(args));
    } catch (e) {
        if (e instanceof CommandError) return { ok: false, error: { code: e.code, message: e.message, errors: e.errors } };
        throw e;
    }
    const errors = validate(PROJECT_SCHEMA, next);
    if (errors.length) return { ok: false, error: { code: 'invalid-project', message: `${def.name} would make the project invalid`, errors } };
    return result === undefined ? { ok: true, project: next } : { ok: true, project: next, result };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const OP_INPUT_ROLE = { isolation: 'copper', clearing: 'copper', drilling: 'drill', cutout: 'outline' };
const OP_TOOL_TYPES = { isolation: ['vbit', 'endmill'], clearing: ['endmill', 'vbit'], drilling: ['drill', 'endmill'], cutout: ['endmill'] };

/**
 * Structural and cross-reference checks. With `layers` (input id → parsed
 * file), also checks that inputs are loaded, parse cleanly, and that
 * component / net regions exist on the board.
 * @returns {{ severity: 'error'|'warning', code: string, message: string, path: string }[]}
 */
export function validateProject(project, { layers } = {}) {
    const issues = [];
    const add = (severity, code, message, path) => issues.push({ severity, code, message, path });
    for (const e of validate(PROJECT_SCHEMA, project)) add('error', 'schema', `${e.path} ${e.message}`, e.path);
    if (issues.length) return issues;

    for (const key of ['inputs', 'regions', 'operations', 'tools']) {
        const seen = new Set();
        project[key].forEach((x, i) => {
            if (seen.has(x.id)) add('error', 'duplicate-id', `Duplicate id "${x.id}" in ${key}`, `/${key}/${i}/id`);
            seen.add(x.id);
        });
    }
    const numbers = new Map();
    project.tools.forEach((t, i) => {
        if (numbers.has(t.toolNumber)) add('error', 'duplicate-tool-number', `T${t.toolNumber} is used by "${numbers.get(t.toolNumber)}" and "${t.id}"`, `/tools/${i}/toolNumber`);
        numbers.set(t.toolNumber, t.id);
    });
    project.inputs.forEach((inp, i) => {
        if (inp.role === 'drill' && inp.side !== null) add('warning', 'drill-side', `Drill input "${inp.id}" should not have a side`, `/inputs/${i}/side`);
        if (inp.role === 'copper' && inp.side === null) add('error', 'copper-side', `Copper input "${inp.id}" needs a side (top or bottom)`, `/inputs/${i}/side`);
    });
    if (project.regions.filter((r) => r.shape.kind === 'remainder').length > 1) {
        add('warning', 'multiple-remainders', 'More than one "remainder" region; they are all the same area', '/regions');
    }

    const inputs = new Map(project.inputs.map((x) => [x.id, x]));
    const regions = new Map(project.regions.map((x) => [x.id, x]));
    const tools = new Map(project.tools.map((x) => [x.id, x]));
    project.operations.forEach((op, i) => {
        const path = `/operations/${i}`;
        const inp = inputs.get(op.input);
        if (!inp) add('error', 'missing-input', `Operation "${op.id}" uses missing input "${op.input}"`, `${path}/input`);
        else if (inp.role !== OP_INPUT_ROLE[op.type]) add('error', 'wrong-input-role', `${op.type} needs a ${OP_INPUT_ROLE[op.type]} input, "${inp.id}" is ${inp.role}`, `${path}/input`);
        if (op.region != null && !regions.has(op.region)) add('error', 'missing-region', `Operation "${op.id}" uses missing region "${op.region}"`, `${path}/region`);
        const tool = tools.get(op.tool);
        if (!tool) {
            add('error', 'missing-tool', `Operation "${op.id}" uses missing tool "${op.tool}"`, `${path}/tool`);
            return;
        }
        if (!OP_TOOL_TYPES[op.type].includes(tool.type)) add('error', 'wrong-tool-type', `${op.type} cannot use a ${tool.type} ("${tool.id}")`, `${path}/tool`);
        if ((op.type === 'isolation' || op.type === 'clearing') && op.depth > project.setup.stockThickness) {
            add('error', 'too-deep', `Operation "${op.id}" is deeper than the stock`, `${path}/depth`);
        }
        if (tool.maxDepth !== undefined) {
            const depth = op.depth ?? project.setup.stockThickness + (op.breakthrough ?? 0);
            if (depth > tool.maxDepth) add('warning', 'beyond-tool-depth', `"${op.id}" cuts ${depth} mm deep; tool "${tool.id}" is rated for ${tool.maxDepth} mm`, path);
        }
        if (op.type === 'drilling' && op.minDiameter !== undefined && op.maxDiameter !== undefined && op.minDiameter > op.maxDiameter) {
            add('error', 'bad-range', `Operation "${op.id}" has minDiameter > maxDiameter`, path);
        }
    });

    if (layers) {
        project.inputs.forEach((inp, i) => {
            const layer = layers[inp.id];
            if (!layer) return add('error', 'input-not-loaded', `File for input "${inp.id}" (${inp.file}) is not loaded`, `/inputs/${i}`);
            const errs = layer.issues.filter((x) => x.severity === 'error');
            if (errs.length) add('error', 'input-has-errors', `${inp.file}: ${errs.length} error(s), first: ${errs[0].message}`, `/inputs/${i}`);
            const expect = inp.role === 'drill' ? 'excellon' : 'gerber';
            if (layer.format !== expect) add('error', 'wrong-format', `Input "${inp.id}" is ${inp.role} but the file is ${layer.format}`, `/inputs/${i}`);
        });
        project.regions.forEach((r, i) => {
            const { kind } = r.shape;
            if (kind !== 'component' && kind !== 'net') return;
            const want = kind === 'component' ? r.shape.ref : r.shape.net;
            const found = Object.values(layers).some((l) => l.format === 'gerber' && (l.objects ?? []).some((o) => (kind === 'component' ? componentOf(o) : netOf(o)) === want));
            if (!found) add('error', `unknown-${kind}`, `Region "${r.id}": no ${kind} "${want}" on any loaded layer`, `/regions/${i}/shape`);
        });
    }
    return issues;
}

/** Component reference of a Gerber object (X2 .P pin or .C component attribute). */
export function componentOf(o) {
    return o.attrs?.['.P']?.[0] ?? o.attrs?.['.C']?.[0] ?? null;
}

export function netOf(o) {
    const n = o.attrs?.['.N']?.[0];
    return n === undefined || n === '' || n === 'N/C' ? null : n;
}
