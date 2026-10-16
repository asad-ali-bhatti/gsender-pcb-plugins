# gSender PCB Plugins

Plugins for [gSender](https://github.com/Sienci-Labs/gsender) that turn a hobby CNC into a PCB mill: probe and level the board, then (planned) generate isolation, drilling and cutout toolpaths without leaving gSender. The aim is to bring the PCB features of [FlatCAM](http://flatcam.org/) into gSender, one plugin per feature.

> Requires gSender **1.6+** with plugin support (tested against 1.7.0 Edge). Grbl and grblHAL controllers.

## Plugins

| Plugin | Status | What it does |
|---|---|---|
| [Autoleveler](plugins/autoleveler) | Beta | Probes a height-map grid, draws it on the 3D visualizer, and levels the loaded G-code to it. |

### Autoleveler

Opens as a panel on the visualizer (▦ **Autolevel** button).

- **Setup**: probe area in work coordinates, or fit it to the loaded job's bounds plus a margin. Choose points per axis, travel height, probe depth, probe feed and an optional slow second probe. Can set work Z0 at the first point.
- **Probe**: serpentine `G38.2` scan. Points appear live on the visualizer, colored by height, with optional labels and an interpolated mesh. The panel shows a hoverable heat map with min / max / range. If a scan stops, the points probed so far are kept and **Resume** finishes the rest.
- **Apply**: rewrites the loaded job so Z follows the board and loads it as `<name>_leveled.nc`. It splits long moves into short segments, linearises `G2`/`G3` arcs, and handles mm and inch files. Heights are relative to the first point, so you can change bits and re-zero there.
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

## Roadmap: FlatCAM features as plugins

| Planned plugin | FlatCAM equivalent |
|---|---|
| Gerber isolation routing | Isolation tool: V-bit width from tip and angle, multi-pass, overlap, climb/conventional |
| Excellon drilling | Drilling tool: tool table, drill / mill-hole, peck drilling, tool-change grouping |
| Board cutout | Cutout tool: rectangular or freeform, holding tabs (gaps) |
| Copper clearing | NCC tool: rest machining around isolated tracks |
| Double-sided alignment | Double-Sided tool: mirror axis and alignment-hole drilling |
| Tool database | Tools DB: shared bit library (V-bits with measured tip and angle) used by all plugins |
| Paste / solder-mask stencils | Solder Paste tool |

Each will reuse the Autoleveler height map, so generated jobs can be levelled in one step.

## License

MIT. See [LICENSE](LICENSE). gSender is GPL-3.0 and is not included here; the plugins talk to it only through its plugin API.
