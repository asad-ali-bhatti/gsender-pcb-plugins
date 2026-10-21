// Starting tool database and the "standard job" builder. Values are
// conservative for a hobby router (trim-router spindle, ER11 collet) milling
// FR4; every number is editable in the Tools tab.

export const DEFAULT_TOOLS = [
    {
        id: 'vbit-30-0.2', name: 'V-bit 30° 0.2 mm', type: 'vbit', toolNumber: 1, tipDiameter: 0.2, angle: 30, maxDepth: 0.5,
        cutting: { feed: 200, plunge: 40, rpm: 24000, stepdown: 0.2 },
        notes: 'General isolation bit; tolerates collet runout better than 0.1 mm tips.',
    },
    {
        id: 'vbit-20-0.1', name: 'V-bit 20° 0.1 mm', type: 'vbit', toolNumber: 2, tipDiameter: 0.1, angle: 20, maxDepth: 0.3,
        cutting: { feed: 150, plunge: 30, rpm: 28000, stepdown: 0.15 },
        notes: 'Fine pitch only (fragile). Keep feed ≈ RPM × 0.006 mm.',
    },
    {
        id: 'vbit-15-0.1', name: 'V-bit 15° 0.1 mm', type: 'vbit', toolNumber: 7, tipDiameter: 0.1, angle: 15, maxDepth: 0.3,
        cutting: { feed: 120, plunge: 25, rpm: 28000, stepdown: 0.1 },
        notes: 'Finest isolation: width grows slowly with depth, so uneven boards change it least. Very fragile; level the board first.',
    },
    {
        id: 'em-0.8', name: 'End mill 0.8 mm', type: 'endmill', toolNumber: 3, diameter: 0.8, maxDepth: 4,
        cutting: { feed: 150, plunge: 40, rpm: 24000, stepdown: 0.4 },
        notes: 'Holes ≥ 0.8 mm (plunged or helix-milled) and board cutout.',
    },
    {
        id: 'em-2.0', name: 'End mill 2.0 mm', type: 'endmill', toolNumber: 4, diameter: 2, maxDepth: 8,
        cutting: { feed: 300, plunge: 60, rpm: 24000, stepdown: 0.6 },
        notes: 'Copper clearing and faster cutouts.',
    },
    {
        id: 'drill-0.8', name: 'Drill 0.8 mm', type: 'drill', toolNumber: 5, diameter: 0.8, maxDepth: 6,
        cutting: { feed: 100, plunge: 60, rpm: 24000, stepdown: 2 },
    },
    {
        id: 'drill-1.0', name: 'Drill 1.0 mm', type: 'drill', toolNumber: 6, diameter: 1, maxDepth: 8,
        cutting: { feed: 100, plunge: 60, rpm: 24000, stepdown: 2 },
    },
];

/** Default fields for a new operation of `type` (id, input and tool filled in by the caller). */
export function operationDefaults(type) {
    switch (type) {
        case 'isolation': return { type, enabled: true, depth: 0.1, passes: 2, overlap: 0.25, direction: 'climb' };
        case 'drilling': return { type, enabled: true, holes: 'all', breakthrough: 0.2, peck: 0 };
        case 'cutout': return { type, enabled: true, breakthrough: 0.2, side: 'outside', tabs: { count: 4, width: 2, height: 0.6 } };
        case 'clearing': return { type, enabled: true, depth: 0.1, overlap: 0.4, rest: true };
        default: throw new Error(`Unknown operation type ${type}`);
    }
}

export const OP_INPUT_ROLE = { isolation: 'copper', clearing: 'copper', drilling: 'drill', cutout: 'outline' };
export const OP_TOOL_TYPES = { isolation: ['vbit', 'endmill'], clearing: ['endmill', 'vbit'], drilling: ['drill', 'endmill'], cutout: ['endmill'] };

/** First tool in `tools` usable for `type`, preferring `preferId`. */
export function pickTool(tools, type, preferId) {
    const ok = tools.filter((t) => OP_TOOL_TYPES[type].includes(t.type));
    return ok.find((t) => t.id === preferId) ?? ok[0] ?? null;
}

/**
 * Commands that set up a standard job for the loaded inputs: isolation on each
 * copper layer, drilling, cutout. Existing operations are kept.
 * @returns {{ name: string, args: object }[]}
 */
export function standardJob(project, tools) {
    const cmds = [];
    const have = new Set(project.tools.map((t) => t.id));
    const useTool = (t) => {
        if (t && !have.has(t.id)) { cmds.push({ name: 'tool.set', args: { tool: t } }); have.add(t.id); }
        return t;
    };
    const ids = new Set(project.operations.map((o) => o.id));
    const opId = (base) => { let id = base; for (let n = 2; ids.has(id); n++) id = `${base}-${n}`; ids.add(id); return id; };
    const already = (type, input) => project.operations.some((o) => o.type === type && o.input === input);

    for (const inp of project.inputs.filter((i) => i.role === 'copper')) {
        if (already('isolation', inp.id)) continue;
        const t = useTool(pickTool(tools, 'isolation', 'vbit-30-0.2'));
        if (t) cmds.push({ name: 'operation.set', args: { operation: { ...operationDefaults('isolation'), id: opId(`iso-${inp.side ?? inp.id}`), input: inp.id, tool: t.id } } });
    }
    for (const inp of project.inputs.filter((i) => i.role === 'drill')) {
        if (already('drilling', inp.id)) continue;
        const t = useTool(pickTool(tools, 'drilling', 'em-0.8'));
        if (t) cmds.push({ name: 'operation.set', args: { operation: { ...operationDefaults('drilling'), id: opId('drill'), input: inp.id, tool: t.id } } });
    }
    const outline = project.inputs.find((i) => i.role === 'outline');
    if (outline && !already('cutout', outline.id)) {
        const t = useTool(pickTool(tools, 'cutout', 'em-0.8'));
        if (t) cmds.push({ name: 'operation.set', args: { operation: { ...operationDefaults('cutout'), id: opId('cutout'), input: outline.id, tool: t.id } } });
    }
    return cmds;
}
