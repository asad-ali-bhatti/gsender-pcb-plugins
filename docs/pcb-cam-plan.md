# PCB CAM plugin: Gerber → G-code, MCP-first

## Context
This is a new plugin, **PCB CAM**: one place for the complete PCB fabrication process in gSender. It turns Gerber and Excellon files into G-code for isolation routing, drilling, cutout and copper clearing, using a shared tool database and board geometry tools. It has nothing to do with Autoleveler, which stays a separate plugin, and it doesn't depend on Autoleveler.

It has to be MCP-friendly from the start, so an AI agent can run the whole conversion. That includes jobs that split the board by region, for example a fine V-bit around a QFN and a coarser bit everywhere else, all in one job.

The AI only generates G-code. It never loads, jogs, probes or runs anything. A human reviews the G-code in the plugin and loads it.

Findings that shape the design (from inspecting gSender Edge 1.7's plugin loader):
- **Plugins are UI-only.** The manifest accepts only `id`, `version`, `engine`, `ui` (entry plus contributions in the slots `tools-page`, `tools-tab` and `visualizer-overlay`), `permissions`, `capabilities` and `parsers`. `parsers` entries are declarative specs, not code. The UI runs in a sandboxed iframe (`allow-scripts allow-forms allow-same-origin`) that talks to gSender only through SDK request types.
- **No process control.** A plugin can't spawn a process, run Node code, or listen on a port, and gSender has no MCP host.
- **Consequence:** the plugin can't launch its own server. The CAM engine has to be a pure JS library that runs both in the iframe and in Node.
- **Who starts the MCP server:** the AI client (Claude Code, Claude Desktop, etc.) starts it on demand as a stdio subprocess, which is standard MCP behavior. The user adds one config entry and never runs anything by hand.
- **Full-page UI:** the `tools-page` slot gives the plugin a full page, which suits a complete CAM workspace better than an overlay panel.
- **Tool changes:** gSender handles `M6` tool changes (`file:toolchanges`). One job with several tools can be one file with `M6 T<n>`.

### How "the plugin launches its server" is covered
1. **Now (no gSender changes):**
   - The AI client launches `pcb-cam-mcp` itself. The plugin's Settings tab shows a copy-paste MCP config snippet and the link status.
   - The plugin is fully functional without the server. All CAM runs in the iframe.
   - The server only exists so agents can drive the same engine and project.
2. **Later (optional upstream):** propose a gSender plugin `server` entry point, a Node module the gSender server runs, and contribute it. If it's accepted, the same `mcp/` code becomes that backend. The plugin could then host MCP over HTTP from inside gSender with no client-side config. The design keeps this a packaging change, not a rewrite.

## Architecture

```
            ┌───────────────────────── cam-core (pure ESM, Node + browser) ─────────────────────────┐
            │ import: gerber, excellon → geometry (polygons w/ holes, clipper-lib)                    │
            │ project model + JSON schema + validate      tool DB      regions                       │
            │ ops: isolation, drilling, cutout, clearing → toolpaths → plan (order, tool groups)     │
            │ gcode emitter (grbl/grblHAL)      analysis (min gaps, uncut copper)    svg render      │
            └──────────────▲─────────────────────────────────────────────────▲────────────────────────┘
                           │                                                 │
     gSender plugin UI (iframe, tools-page)                      MCP server (Node, stdio — spawned by the AI client)
     full CAM workspace + 3D preview                             AI agent tools/resources
     "Load into gSender" button  ◄──── live link (localhost WS, token) ──── project push
                           ▲                                                 ▲
                           └──────────── same *.pcbcam.json project file ────┘
```

**Key idea: one declarative project document.** The plugin UI and the MCP tools both edit the same JSON project and nothing else. Generating output is a pure function: `generate(project, inputFiles, toolDB) → { toolpaths, gcode, warnings }`. Because of that, anything an agent does can be reviewed, diffed, re-run and edited by hand, and the reverse is also true. The output is deterministic, so golden tests work.

### Project document (`board.pcbcam.json`)
The authoritative definition is `PROJECT_SCHEMA` in `plugins/pcb-cam/ui/core/project.js`. A trimmed example:
```jsonc
{
  "version": 1, "name": "demo",
  "inputs": [ {"id":"top","file":"demo-F_Cu.gtl","role":"copper","side":"top"},
              {"id":"drill","file":"demo-PTH.drl","role":"drill","side":null,"plated":true},
              {"id":"edge","file":"demo-Edge_Cuts.gm1","role":"outline","side":null} ],
  "setup":  { "stockThickness":1.6, "safeZ":5, "travelZ":1, "origin":"gerber", "material":"FR1" },
  "regions": [
    {"id":"fine", "shape":{"kind":"component","ref":"U3","margin":1.5}},   // pads with X2 %TO.P,U3
    {"id":"box",  "shape":{"kind":"rect","rect":[10,10,30,25]}},
    {"id":"rest", "shape":{"kind":"remainder"}}                            // layer minus other regions used on it
  ],                                                                       // also: polygon, net
  "operations": [
    {"id":"iso-fine","type":"isolation","enabled":true,"input":"top","region":"fine","tool":"vbit-20-0.1",
     "depth":0.05,"passes":3,"overlap":0.4,"direction":"climb"},
    {"id":"iso-rest","type":"isolation","enabled":true,"input":"top","region":"rest","tool":"vbit-30-0.2",
     "depth":0.05,"passes":2,"overlap":0.4,"direction":"climb"},
    {"id":"drill","type":"drilling","enabled":true,"input":"drill","tool":"drill-1.0","holes":"all","breakthrough":0.2,"peck":0},
    {"id":"cut","type":"cutout","enabled":true,"input":"edge","tool":"em-0.8","breakthrough":0.2,"side":"outside",
     "tabs":{"count":4,"width":2,"height":0.6}}
  ],                                                                       // also: clearing (depth, overlap, rest)
  "tools": [ /* snapshots of the tool database entries the operations use */ ],
  "output": { "dialect":"grbl", "toolChange":"m6" /* or "split" */, "decimals":4 }
}
```
Operation parameters beyond those above (drill-to-mill, clearing strategy) are settled in Phase 2.

### Tool database
gSender has no tool database. Its `workspace.tools` is only a fixed list of five end-mill diameters for the Probe widget's dropdown, and plugins can't write to the workspace. So PCB CAM keeps its own.

- **One master copy, in the plugin.** It's stored with the plugin's gSender `storage` (persisted in gSender's settings file under `state.plugins.<id>.data`) and edited in the plugin's Tools tab.
- **The MCP server never reads gSender's files.** It may run on another machine. It gets the database **on request over the agent link**:
  - When an agent calls `tools_list`, the server sends a `tools:get` request to the connected plugin. The plugin replies with the current database and a revision number.
  - The server keeps that reply only as a session cache, labelled with its revision and an `asOf` time.
  - If no plugin is connected, `tools_list` returns the cached copy marked `stale: true`. If there's no cache, it returns an error asking the user to open PCB CAM, or to paste an export (Tools → Export JSON) through `tools_import`, which is read-only for that session.
- **Agents propose and the human decides.** `tools_propose` sends an add or change to the plugin, which shows it for accept or reject. Only the plugin writes the database.
- **Projects are self-contained.** A project embeds a snapshot of every tool it uses, so it regenerates the same G-code without the database or a link.


Tool types:
- `vbit {tipDiameter, angle}`: effective width is computed from cut depth.
- `endmill {diameter}`
- `drill {diameter}`

Every tool also carries `feed`, `plunge`, `rpm`, `stepdown` and `toolNumber`.

### Region semantics (the multi-tool case)
- A region is a 2D mask. It can be a rect, a polygon, a component (refdes plus margin, using X2 attributes), a net, a selection of pads, or `remainder`.
- An operation works on its input layer intersected with its region.
- **Isolation is computed on the whole layer, then the toolpaths are clipped to the region.** Offsets near a region's edge then still respect copper outside the region.
- **Seams:** each operation's paths extend past the region edge by a seam margin (about 1 tool width), so no copper slivers are left where two regions meet.
- **Validation:**
  - Reports any spot where an operation's tool is wider than the copper gap it has to cut. Each report includes the location, the measured gap and the tool width.
  - Reports copper that the planned operations leave uncut. The agent iterates on these reports.
- **`suggest_regions` analysis:** finds clusters of gaps narrower than a given tool and proposes region polygons. This lets an agent ask "where do I need the fine bit?" and get a direct answer.

### MCP server (`mcp/`)
A Node server built on `@modelcontextprotocol/sdk`. It supports **stdio** (the AI client launches it on the same machine) and **Streamable HTTP** (it runs on another machine or in the cloud). The tools are coarse-grained, use JSON-schema inputs, return structured output and work on a project file path.

| Tool | Purpose |
|---|---|
| `project_create` | From a folder or file list. Detects layer roles from KiCad/Altium naming and X2 `FileFunction`. |
| `board_inspect` | Layers, bounds, components and nets (X2), drill-size histogram, min trace/gap per layer. |
| `tools_list`, `tools_propose`, `tools_import` | Fetch the database from the plugin on request (cached copy marked stale when the plugin is offline), propose changes for human approval, or load a pasted export. |
| `region_set`, `region_remove`, `regions_suggest` | Region editing and the narrow-gap analysis. |
| `operation_set`, `operation_remove`, `operations_reorder` | Operation editing. |
| `project_validate` | Errors/warnings with coordinates: tool too wide, uncut copper, unmapped drills, region overlaps, cut outside stock. |
| `toolpaths_generate` | Per-op stats: path length, tool changes, time estimate. |
| `preview_render` | PNG (image content) of copper, toolpaths and problem spots, optionally zoomed to a region or bbox. This lets the agent see its own result. |
| `gcode_export` | Writes `.nc` (one file, or one per tool) and returns paths and a summary. |
| `live_push` | Sends the project to the open gSender plugin for human review. Never loads or runs anything. |

Resources: the project JSON, the tool DB, the project JSON schema and a short "how to CAM a KiCad board" guide. One prompt, `mill_board`, walks through the standard workflow.

No MCP tool touches the controller.

### gSender plugin (`plugins/pcb-cam/`)
- It's a `tools-page` contribution: a full-page CAM workspace. A small `visualizer-overlay` entry is used only to toggle the toolpath preview on the 3D view.
- The UI is an editor for the same project document, with tabs:
  - Inputs: file picker for Gerber, Excellon and project files.
  - Tools: the tool DB.
  - Regions: drawn on a 2D board view, or picked on the visualizer with `viewer:pick`.
  - Operations.
  - Preview: toolpaths shown with `viewer:overlay:set`, and validation warnings shown as markers.
  - Output.
  - Settings: units, dialect, MCP config snippet and link status.
- **Load into gSender** uses `gcode:load:to:visualizer`. It's always a human click.
- **Agent link:**
  - **The plugin always dials out to the MCP server.** The server URL and a token go in Settings: `ws://127.0.0.1:<port>` when local, or `ws://<host>:<port>` / `wss://…` when the server is on another machine. Dialling out means gSender never has to accept incoming connections.
  - The server shows the token when it starts. It checks the token on every connection, and the origin as well when local.
  - The link is request/response with typed messages, plus `hello` carrying versions and capabilities:
    - `tools:get` (server → plugin) returns the tool database.
    - `tools:propose` and `project:push` (server → plugin) create proposals the human accepts or rejects.
    - `project:get` (server → plugin) returns the project currently open, so an agent can work on what the human has loaded.
  - Pushed projects appear with a diff summary. The human accepts, edits or rejects them.
  - Without a link, the agent writes `board.pcbcam.json` and the user opens it with the file picker. Tools come from the project's embedded snapshots or a pasted export.
- It follows this repo's plugin conventions: plain ES modules with no build step, SDK functions imported by name, no `confirm()`/downloads, and a small `h()` DOM helper. Its code is separate from Autoleveler.

### Repo layout
```
plugins/pcb-cam/gsender-plugin.json
plugins/pcb-cam/ui/index.html, assets/index.js, assets/index.css
plugins/pcb-cam/ui/core/            ← cam-core lives here, so the plugin stays self-contained with no build step
    geometry.js  schema.js  tools.js  project.js  inspect.js  index.js        (Phase 1)
    import/ gerber.js excellon.js detect.js index.js                          (Phase 1)
    regions.js ops/ plan.js gcode/ analysis/ render/                          (Phase 2+)
plugins/pcb-cam/ui/vendor/          ← clipper-lib 6.4.2 (Boost) wrapped as ESM; the only third-party code
mcp/package.json, mcp/src/server.js ← imports ../plugins/pcb-cam/ui/core directly
tests/cam/*.test.mjs, tests/fixtures/<board>/ (KiCad gerbers + golden .nc)
```
Changes to existing files:
- `scripts/package.sh` already zips `plugins/*`. Add an `mcp` tarball/npm-pack step.
- `.github/workflows/release.yml` attaches both outputs.
- Root `package.json` tests cover `tests/**`. Add `npm run mcp`.
- Add `.mcp.json` for local Claude Code use.
- README: add a PCB CAM section and MCP setup.

## Phases
**Priority: build the CAM tool first; MCP comes later.** The tool is built so MCP can be added without restructuring. Concretely, from Phase 1 on:
- **Every change goes through commands.** All edits to a project (add a region, set an operation, change a tool) are named commands with JSON-schema inputs, applied by one function, `applyCommand(project, cmd) → { project, result | error }`. The UI calls these commands and never mutates state directly. A later MCP server exposes the same commands as tools.
- **Read-only queries are pure functions.** `inspectBoard`, `validate`, `generate`, `renderSvg` and the gap analysis return plain JSON or SVG with coordinates. Nothing depends on the DOM or the SDK, so the same code runs headless in Node.
- **State lives in the project document.** It's saved to and loaded from `board.pcbcam.json`. The UI holds no hidden state beyond view settings such as zoom and the selected tab.
- **Errors and warnings are structured data:** `{ code, message, severity, at: [x, y], opId }`, not just strings, so an agent can act on them later.

0. **Spikes (de-risk):** done; see Phase 0 findings below.
1. **Core import and geometry:** done (2026-10-16).
   - **Gerber parser and plotter, our own.** tracespace was dropped: it strips spaces from attribute values and turns any command it doesn't know into an `unimplemented` node, so missing geometry would go unnoticed. Ours handles:
     - Apertures C/R/O/P with holes, and macros (all primitives, variables, expressions, exposure).
     - Strokes, including convex non-circular pens, and G74/G75 arcs.
     - Regions with cut-ins, polarity, step & repeat, aperture blocks, LR/LS, and X2 attributes (also as `G04 #@!` comments).
     - Anything unsupported or ambiguous (LM, IPNEG, a clear-flashed block, overlapping SR with clear) becomes an `error` issue rather than a guess.
   - **Our own Excellon parser:** decimal, LZ/TZ/keep formats, KiCad's `FORMAT={a:b}` comment, inch/metric, G85 and routed slots, repeat, incremental, and per-tool X2 plating.
   - **Layer detection:** X2 first, then KiCad, Protel/Altium, Eagle and EasyEDA naming, then content.
   - **Geometry:** a wrapper over `clipper-lib` with 0.1 µm integer units, which keeps KiCad page coordinates on clipper's fast path.
   - **Project:** JSON-Schema project and tool schemas, the command layer (`applyCommand`, `COMMANDS`), `validateProject`, and `inspectBoard` (layers, board size from the outline centreline, components, nets, drill histogram).
   - **Verification:**
     - 47 unit tests (Node 22 and 24).
     - 572 KiCad Gerbers and 60 drill files parse with no issues.
     - 16 KiCad drill-format variants of one board agree to 1.44 µm.
     - 10 copper layers from 5 KiCad demo boards match KiCad's own SVG plot pixel for pixel at 80 px/mm (12.5 µm). The comparator was confirmed to catch one dropped pad and a 50 µm shift.
     - The core gives identical results in Chrome and Node.
2. **Operations and G-code:**
   - Isolation (multi-pass, V-bit width from depth, climb/conventional) with region clipping and seams.
   - Drilling (tool mapping, mill oversize holes, peck).
   - Cutout (tabs).
   - Clearing (rest machining).
   - Planner for ordering, tool grouping and nearest-neighbour travel.
   - Grbl/grblHAL emitter: `M6 T<n>` or split files, with a warning when the tool-change option is `Ignore`.
   - Analysis: narrow gaps, uncut copper, region suggestions.
3. **Plugin UI (the usable product):**
   - `tools-page` workspace with tabs for inputs, tools, regions, operations, preview and output.
   - 2D board view (SVG) with region drawing.
   - 3D preview on the visualizer, and Load into gSender.
   - Tool database stored in plugin storage, with JSON export/import.
   - Save/open `.pcbcam.json`.
4. **Release v1 of PCB CAM** (packaging and README; first install needs a gSender restart).
5. **Later — MCP:**
   - MCP server exposing the commands and queries as tools, over stdio and Streamable HTTP.
   - Agent link: the plugin dials out to the server, which fetches the tool database and project on request; agent changes arrive as proposals.
   - PNG preview rendering for agents.

## Phase 0 findings (2026-10-16, gSender 1.7.0-Edge-2, KiCad 10.0.5 fixtures)
A throwaway spike plugin was run inside gSender's plugin page (served by the gSender server, opened in Chrome). It talked to a localhost Node server.

| Question | Result | Consequence |
|---|---|---|
| `tools-page` full page? | Yes. Route `/#/tools/plugin/<route>` gives a full-size iframe (1077×694 here) with sandbox `allow-scripts allow-forms allow-same-origin`. | Use `tools-page` for the CAM workspace. |
| New plugin install | Listed right away, but its files 404 until gSender restarts. Static routes are mounted at startup. Updating an already-installed plugin hot-reloads. | README: the first install needs a restart. |
| ESM file types | `.mjs` is served as `application/octet-stream`, which browsers reject for modules. `.js` is served as `application/javascript`. | All plugin modules, vendored ones included, use `.js`. |
| Vendored libs in iframe | `@tracespace/parser` + `moo` (UMD wrapped as ESM) and `clipper-lib` load and give the same results as in Node. KiCad F.Cu parses in about 14 ms. | Same core code runs in both places. |
| Polygon library | `clipper2-js` 1.2.4 produces **wrong offsets**: miter joins give a lopsided shape, and the area is off by about 20%. `clipper-lib` 6.4.2 is exact (53.031 mm² vs 53.031 expected). | Use `clipper-lib`, behind our own geometry wrapper so it can be swapped later. |
| Gerber parser | (Superseded in Phase 1 by our own parser.) tracespace parses graphics, apertures, macros and regions. X2 attributes (`%TO.P/N/C`, `%TA`, `%TF`) come through as `unimplemented` nodes with whitespace stripped, but with source offsets. | Read X2 attributes by slicing the raw source at those offsets. Refdes for component regions is in `%TO.P` (82 components on the test board). |
| Excellon parser | tracespace **drops all holes** in KiCad drill files (`FMAT,2`, decimal) and has no `G85` slot support. | Write our own Excellon parser: decimal and fixed formats, inch/metric, `G85` slots, X2 comments. |
| Localhost link | `fetch` and `WebSocket` to `127.0.0.1:<port>` both work from the plugin iframe. Requests carry `Origin: http://127.0.0.1:<gSender port>`. gSender's port is random per launch. | Live link is viable. The MCP server checks for a loopback origin on any port plus a token. |
| Tool changes | Plugins can read `workspace.toolChangeOption` via `getWorkspaceState()`. The default is **`Ignore`**, which means `M6` does nothing. Other values: Pause, Standard Re-zero, Flexible Re-zero, Fixed Tool Sensor, Code, plus ATC passthrough. gSender shows a per-tool timeline from the `M6 T<n>` events in a loaded file. | Output options: a single file with `M6 T<n>` when tool changes are enabled, or split files per tool. The plugin warns if the job has more than one tool and the option is `Ignore`. |
| SDK extras | `/plugin-sdk/react.js` (`useWorkspaceState`, `useParsed`, `useVisualizerPick`) and `/plugin-sdk/viewer.js` (React/three G-code viewer: `GCodeVisualizer`, `GCodeViewer`, `GCodeSVGVisualizer`). The workspace also exposes a `tools` table. | Optional: an in-page 3D G-code preview through the SDK viewer, which needs vendored React as in gSender's Basic CAM sample. Importing gSender's tool table into the tool DB is possible later. |

The checks were repeated in the gSender Edge Electron window (viewport 1592×835) with identical results, including the localhost WebSocket echo. All Phase 0 questions are resolved.

## Verification
- **Unit and golden tests:** `npm test` covers geometry, offsets and region clipping. Each fixture project → `.nc` is compared against a golden file. A G-code sanity checker confirms there are no cuts below max depth, every move is inside the stock, and tool changes match the operations.
- **Headless (from Phase 1, keeps MCP-readiness honest):** tests drive whole jobs through `applyCommand` only, with no UI. For example: create a project from fixtures, add a "fine" region around a component, set two isolation ops, generate and check.
- **MCP (later phase):**
  - Use `npx @modelcontextprotocol/inspector node mcp/src/server.js` to exercise each tool.
  - Then run Claude Code with `.mcp.json` on a fixture board: "fine 20° V-bit around U3, 0.2 mm V-bit elsewhere, drill, cutout with 4 tabs."
  - Check that validation reports zero uncut copper and the preview PNG looks right.
- **Plugin:**
  - Run `npm run dev` (mock host) to open a project pushed by the agent, preview it and load it.
  - In real gSender, air-cut 5 mm above the stock, then do a real cut on scrap FR-1.
