// A small PCB CAM project file for tests and the mock host: a 30 × 20 mm board
// with isolation (V-bit), drilling (0.8 mm drill) and cutout (1 mm end mill)
// jobs, plus the gcodeHash PCB CAM writes when it generates a job.
const core = await import(new URL('../../plugins/pcb-cam/ui/core/index.js', import.meta.url));

const c = (v) => String(Math.round(v * 1e6));
const xy = (x, y) => `X${c(x)}Y${c(y)}`;

export const TOP = `%TF.FileFunction,Copper,L1,Top*%
%FSLAX46Y46*%
%MOMM*%
%LPD*%
%ADD10R,1.6X1.6*%
%ADD11C,0.4*%
D10*
${xy(8, 10)}D03*
${xy(22, 10)}D03*
D11*
${xy(8, 10)}D02*
${xy(22, 10)}D01*
M02*
`;
export const EDGE = `%TF.FileFunction,Profile,NP*%
%FSLAX46Y46*%
%MOMM*%
%ADD10C,0.1*%
D10*
${xy(0, 0)}D02*
${xy(30, 0)}D01*
${xy(30, 20)}D01*
${xy(0, 20)}D01*
${xy(0, 0)}D01*
M02*
`;
export const DRILL = `M48
METRIC
T1C0.800
%
G90
G05
T1
X8.0Y10.0
X22.0Y10.0
M30
`;

const cut = { feed: 120, plunge: 60, rpm: 12000, stepdown: 0.1 };
export const TOOLS = [
    { id: 'v30', name: 'V-bit 30° 0.2 mm', type: 'vbit', toolNumber: 1, tipDiameter: 0.2, angle: 30, cutting: cut },
    { id: 'd08', name: 'Drill 0.8 mm', type: 'drill', toolNumber: 2, diameter: 0.8, cutting: { ...cut, stepdown: 2 } },
    { id: 'em1', name: 'End mill 1.0 mm', type: 'endmill', toolNumber: 3, diameter: 1, cutting: { ...cut, feed: 300, stepdown: 0.6 } },
];
export const OPS = [
    { id: 'iso-top', type: 'isolation', enabled: true, input: 'top', tool: 'v30', depth: 0.05, passes: 1, overlap: 0.4, direction: 'climb' },
    { id: 'drill', type: 'drilling', enabled: true, input: 'drill', tool: 'd08', holes: 'all', breakthrough: 0.2, peck: 0 },
    { id: 'cutout', type: 'cutout', enabled: true, input: 'edge', tool: 'em1', breakthrough: 0.2, side: 'outside', tabs: { count: 2, width: 2, height: 0.6 } },
];

/** The project file document, without gcodeHash (as an older PCB CAM saved it). */
export function demoDoc({ output = {} } = {}) {
    let p = core.createProject('Demo board');
    const cmds = [
        { name: 'input.add', args: { id: 'top', file: 'demo-F_Cu.gtl', role: 'copper', side: 'top' } },
        { name: 'input.add', args: { id: 'edge', file: 'demo-Edge_Cuts.gm1', role: 'outline', side: null } },
        { name: 'input.add', args: { id: 'drill', file: 'demo.drl', role: 'drill', side: null } },
        { name: 'setup.update', args: { stockThickness: 1.6 } },
        { name: 'output.update', args: output },
        ...TOOLS.map((tool) => ({ name: 'tool.set', args: { tool } })),
        ...OPS.map((operation) => ({ name: 'operation.set', args: { operation } })),
    ];
    for (const cmd of cmds) {
        const r = core.applyCommand(p, cmd);
        if (!r.ok) throw new Error(`${cmd.name}: ${JSON.stringify(r.error)}`);
        p = r.project;
    }
    return {
        format: core.PROJECT_FORMAT, version: 1, project: p,
        boardFiles: { 'demo-F_Cu.gtl': TOP, 'demo-Edge_Cuts.gm1': EDGE, 'demo.drl': DRILL },
        jobs: [
            { id: 'iso', name: 'iso-top_cnc', ops: ['iso-top'], hadResult: true },
            { id: 'drill', name: 'drill_cnc', ops: ['drill'], hadResult: true },
            { id: 'cutout', name: 'cutout_cnc', ops: ['cutout'], hadResult: true },
        ],
    };
}

/** Adds gcodeHash to every job, as PCB CAM does when it generates them. */
export async function withHashes(doc) {
    for (const job of doc.jobs) {
        const r = core.generateJob(doc, job.id);
        if (r.ok) Object.assign(job, { gcodeHash: await core.gcodeHash(r.files), coreVersion: core.CORE_VERSION });
    }
    return doc;
}
