// Cutting tools: schema, geometry (V-bit width at depth) and the tool database
// document. The database is owned by the plugin; projects embed snapshots of
// the tools they use so they regenerate identically without it.

import { validate } from './schema.js';

export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';

const cutting = {
    type: 'object',
    additionalProperties: false,
    properties: {
        feed: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: 'XY feed, mm/min' },
        plunge: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: 'Z plunge feed, mm/min' },
        rpm: { type: 'number', minimum: 0, maximum: 100000, description: 'Spindle speed; 0 leaves the spindle untouched' },
        stepdown: { type: 'number', exclusiveMinimum: 0, maximum: 50, description: 'Max depth per pass, mm' },
    },
};

const common = {
    id: { type: 'string', pattern: ID_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    toolNumber: { type: 'integer', minimum: 1, maximum: 999, description: 'T number used for M6 tool changes' },
    cutting: { ...cutting, required: ['feed', 'plunge', 'rpm', 'stepdown'] },
    materials: {
        type: 'object',
        description: 'Per-material overrides of `cutting`, keyed by material name (e.g. FR4, FR1)',
        additionalProperties: cutting,
    },
    notes: { type: 'string', maxLength: 2000 },
};
const commonRequired = ['id', 'name', 'type', 'toolNumber', 'cutting'];

export const TOOL_SCHEMA = {
    oneOf: [
        {
            type: 'object',
            additionalProperties: false,
            required: [...commonRequired, 'tipDiameter', 'angle'],
            properties: {
                ...common,
                type: { const: 'vbit' },
                tipDiameter: { type: 'number', minimum: 0, maximum: 5, description: 'Flat tip width, mm' },
                angle: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 180, description: 'Included angle, degrees' },
                maxDepth: { type: 'number', exclusiveMinimum: 0, maximum: 50, description: 'Usable cutting depth, mm' },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: [...commonRequired, 'diameter'],
            properties: {
                ...common,
                type: { const: 'endmill' },
                diameter: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
                maxDepth: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: [...commonRequired, 'diameter'],
            properties: {
                ...common,
                type: { const: 'drill' },
                diameter: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
                maxDepth: { type: 'number', exclusiveMinimum: 0, maximum: 50 },
            },
        },
    ],
};

export const TOOL_DB_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'revision', 'tools'],
    properties: {
        version: { const: 1 },
        revision: { type: 'integer', minimum: 0 },
        tools: { type: 'array', items: TOOL_SCHEMA },
    },
};

/** Schema errors for one tool (empty when valid). */
export function validateTool(tool) {
    return validate(TOOL_SCHEMA, tool);
}

/**
 * Cutting width at `depth` mm below the surface: a V-bit widens with depth,
 * other tools cut their diameter.
 */
export function widthAtDepth(tool, depth) {
    if (!(depth >= 0)) throw new Error('depth must be ≥ 0');
    if (tool.type === 'vbit') {
        return tool.tipDiameter + 2 * depth * Math.tan((tool.angle * Math.PI) / 360);
    }
    return tool.diameter;
}

/** Depth at which a V-bit cuts `width`; null when the tool cannot (narrower than the tip, or not a V-bit). */
export function depthForWidth(tool, width) {
    if (tool.type !== 'vbit') return null;
    if (width < tool.tipDiameter) return null;
    const t = Math.tan((tool.angle * Math.PI) / 360);
    return (width - tool.tipDiameter) / (2 * t);
}

/** Cutting parameters for a material: the tool's defaults with that material's overrides. */
export function cuttingFor(tool, material) {
    return { ...tool.cutting, ...(material ? tool.materials?.[material] : undefined) };
}

// ---------------------------------------------------------------------------
// Tool database document
// ---------------------------------------------------------------------------

export function createToolDb(tools = []) {
    return { version: 1, revision: 0, tools: structuredClone(tools) };
}

export function findTool(db, id) {
    return db.tools.find((t) => t.id === id) ?? null;
}

/** Adds or replaces a tool by id. Returns a new database (revision + 1) or throws with `errors`. */
export function setTool(db, tool) {
    const errors = validateTool(tool);
    const clash = db.tools.find((t) => t.id !== tool.id && t.toolNumber === tool.toolNumber);
    if (clash) errors.push({ path: '/toolNumber', message: `T${tool.toolNumber} is already used by "${clash.name}"` });
    if (errors.length) throw Object.assign(new Error('Invalid tool'), { errors });
    const tools = db.tools.filter((t) => t.id !== tool.id);
    const idx = db.tools.findIndex((t) => t.id === tool.id);
    tools.splice(idx < 0 ? tools.length : idx, 0, structuredClone(tool));
    return { ...db, revision: db.revision + 1, tools };
}

export function removeTool(db, id) {
    if (!findTool(db, id)) throw Object.assign(new Error(`No tool "${id}"`), { errors: [{ path: '/id', message: 'not found' }] });
    return { ...db, revision: db.revision + 1, tools: db.tools.filter((t) => t.id !== id) };
}
