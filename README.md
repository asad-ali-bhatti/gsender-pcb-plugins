<p align="center">
  <img src="docs/images/logo.jpg" alt="PCB CAM, plugin for gSender" width="420">
</p>

# gSender PCB Plugins

Plugins for [gSender](https://github.com/Sienci-Labs/gsender) that turn a hobby CNC into a PCB mill: probe and level the board, then (planned) generate isolation, drilling and cutout toolpaths without leaving gSender. Two independent plugins: **Autoleveler** for probing and levelling, and **PCB CAM** (planned), one place for the whole fabrication process from Gerber files to G-code, bringing the PCB features of [FlatCAM](http://flatcam.org/) into gSender.

**Goal:** someone new to the hobby imports their board files, clicks through the prompts, and mills a working board. Every default is chosen for tools and materials that are easy to buy: 3018/3020-class machines, single-sided FR4/FR1 copper-clad, and V-bits, drills and end mills from common kits. The plugins are built to prevent mistakes rather than document them.

> Requires gSender **1.6+** with plugin support (tested against 1.7.0 Edge). Grbl and grblHAL controllers.

## Plugins

| Plugin | Status | What it does |
|---|---|---|
| [Autoleveler](plugins/autoleveler) | Beta | Probes a height-map grid, draws it on the 3D visualizer, and levels the loaded G-code to it. |

### Autoleveler

Opens as a panel on the visualizer (▦ **Autolevel** button).

- **Setup**: probe area in work coordinates, or fit it to the loaded job's bounds plus a margin. Choose points per axis, travel height, probe depth, probe feed and an optional slow second probe. Can set work Z0 at the first point.
- **Probe**: serpentine `G38.2` scan. Points appear live on the visualizer, colored by height, with optional labels and an interpolated mesh. The panel shows a hoverable heat map with min / max / range. If a scan stops, the points probed so far are kept and **Resume** finishes the rest.
- **Apply**: rewrites the loaded job so Z follows the board and loads it as `<name>_leveled.nc`. It splits long moves into short segments, linearises `G2`/`G3` arcs, and handles mm and inch files. The map is shifted to where you zero Z for the job: by default the copper at **X0 Y0**, so after a bit change you re-zero there with gSender's probe. Work Z0 set by the scan is moved to X0 Y0 when it finishes. Keep X0 Y0 inside the probed area (the margin does that for a job that starts at the origin).
- Import and export height maps as JSON.

Before a real job, do a dry run of a small 3×3 scan with a hand on the e-stop. Probe coordinates are expected in mm (`$13=0`).

## Install

**From a release zip:** download `autoleveler-x.y.z.zip` from [Releases](../../releases) or the CI artifacts, then install it from gSender's plugin manager.

**From source:**

```sh
git clone https://github.com/asad-ali-bhatti/gsender-pcb-plugins.git
cd gsender-pcb-plugins
npm run install-plugins          # copies plugins/* into gSender's plugin folder
```

gSender watches its plugin folder, so re-running the install while gSender is open reloads the plugin. Override the destination with `GSENDER_PLUGINS_DIR=...`.

## Development

Plugins are plain ES modules with no build step. Each one is a folder with a `gsender-plugin.json` manifest and a `ui/` directory that gSender serves into a sandboxed iframe. The UI talks to gSender through `@sienci/gsender-plugin-sdk`, mapped by an import map to `/plugin-sdk/index.js`.

```sh
npm test            # unit tests for the pure toolpath / height-map code
npm run dev         # mock gSender host at http://localhost:8765 (simulated Grbl + warped board)
npm run package     # dist/<plugin>-<version>.zip
```

`npm run dev` pulls the plugin SDK out of your local gSender install (`GSENDER_APP=/path/to/gSender.app` if it's not in `/Applications`).

Conventions:

- Keep machine-independent logic (geometry, G-code generation and rewriting) in pure modules like `leveling.js` and unit-test it under Node.
- Import SDK functions by name (`import { machine, viewer } from '@sienci/gsender-plugin-sdk'`). gSender's installer scans those imports to decide what the plugin may access.
- The plugin iframe has no `allow-downloads` or `allow-modals`. Use the clipboard or text areas for export, and use inline confirmations instead of `confirm()`.

## Roadmap: PCB CAM plugin

A single full-featured plugin that turns Gerber and Excellon files into G-code. It is designed MCP-first: an AI agent can drive the whole conversion (for example a fine V-bit in one region of the board and a coarser bit elsewhere, in one job) through an MCP server that ships with it. The agent only generates G-code; loading and running it stays with you.

| Planned feature | FlatCAM equivalent |
|---|---|
| Gerber isolation routing | Isolation tool: V-bit width from tip and angle, multi-pass, overlap, climb/conventional |
| Excellon drilling | Drilling tool: tool table, drill / mill-hole, peck drilling, tool-change grouping |
| Board cutout | Cutout tool: rectangular or freeform, holding tabs (gaps) |
| Copper clearing | NCC tool: rest machining around isolated tracks |
| Double-sided alignment | Double-Sided tool: mirror axis and alignment-hole drilling |
| Tool database | Tools DB: shared bit library (V-bits with measured tip and angle) used by every tool |
| Paste / solder-mask stencils | Solder Paste tool |

## Roadmap: Project Runner plugin

Runs a whole PCB CAM project on the machine: open the project file, pick the jobs, and follow the prompts. It inserts a bit change wherever the bit changes and walks you through zeroing Z after each one. It probes one height map per project and levels each job that needs it, exactly once. It tracks every job (done, cancelled, failed) and resumes after a lost connection or a power cut, with guidance when the machine coordinates can't be trusted. Plan: [docs/project-runner-plan.md](docs/project-runner-plan.md).

Status: Phases 1–2 are in `plugins/project-runner` (▶ **Run** on the visualizer). A wizard opens a project file, checks each job against what was reviewed in PCB CAM, and lets you pick and order the jobs, with pauses or G-code steps in between. The run starts with Set X0 Y0. Bit changes are added for you: Raise Z, swap the bit, then a guided Zero Z on the copper at X0 Y0. Each job runs through gSender, and status and history are kept in a `.pcbrun.json` file. Levelling and resume come in later phases.

## License

MIT. See [LICENSE](LICENSE). gSender is GPL-3.0 and is not included here; the plugins talk to it only through its plugin API.

This project is not affiliated with or endorsed by Sienci Labs. gSender is a trademark of Sienci Labs.
