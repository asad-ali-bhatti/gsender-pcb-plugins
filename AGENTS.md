# Project guide for agents

## Goal (read this first)
**A novice who has just got into the hobby imports their board files and starts milling, and gets a working PCB.** Everything in this repo serves that goal. The way to get there is to **remove chances for human error**, not to add expert options.

Rules that follow from it:
- **Defaults must work as shipped, for the tools and materials a beginner can actually buy.** Base them on what's readily available on the market:
  - Machines: 3018/3020-class hobby routers on GRBL or grblHAL, with a trim router or 775 spindle and an ER11 collet.
  - Stock: single-sided FR4 or FR1 copper-clad, 1.6 mm thick, 35 µm copper.
  - Bits from common kits (3.175 mm shank): 20° and 30° V-bits with 0.1–0.2 mm tips, 0.8 and 1.0 mm carbide drills, and 0.8–2 mm end mills or corn cutters.
  - Probing: a probe clip on the bit, with the board copper as the touch plate.
  Never require a tool, sensor or material that a beginner wouldn't have.
- **Every setting has a safe default,** and the common path needs no settings at all. Advanced options can exist, but they are never required and never shown first.
- **Prevent mistakes instead of documenting them.** Examples: tie each job to its bit, level automatically, refuse a job that's out of date, warn before a cut that is too deep, block Start when the coordinates can't be trusted. Warnings are structured (`{ code, message, severity, at }`) and say what to do next.
- **Explain in plain words.** No jargon without a short explanation. Messages name the bit, the job and the next physical action ("Insert the 0.8 mm drill, then click Zero Z").
- **A human confirms every machine motion.** Plugins never start moving the machine on their own. AI agents (MCP) only generate G-code. They never load, jog, probe or run anything.
- **Safety and reliability beat features.** A crash or a lost line during a job ruins a board and can break a bit.

## Plugins
| Plugin | Folder | Role |
|---|---|---|
| Autoleveler | `plugins/autoleveler` | Standalone: probe a height map, level the loaded G-code. Must keep working without the other plugins. |
| PCB CAM | `plugins/pcb-cam` | One place for CAM: Gerber/Excellon → G-code, FlatCAM-style UI. Plan: `docs/pcb-cam-plan.md`. |
| Project Runner | `plugins/project-runner` (planned) | Runs a PCB CAM project on the machine: job queue, bit changes, Z zeroing, built-in levelling, resume, history. Plan: `docs/project-runner-plan.md`. |

## Hard constraints (gSender 1.7 plugin host)
- Plugins are UI-only sandboxed iframes. There's no backend, no process spawning and no listening ports.
- Use `.js` modules, never `.mjs` (gSender serves `.mjs` with the wrong MIME type). There's no build step.
- A `tools-page` iframe is unloaded when the user leaves the page. A `visualizer-overlay` iframe stays loaded.
- Plugin storage is gSender's settings file, rewritten whole on every write, with a 256 KB limit per write. Keep only small data there. sessionStorage is lost when gSender quits. Durable data goes in files on disk (File System Access, `fileSystem` permission).
- **Memory safety is mandatory:** gSender's session recorder records DOM mutations, and a leak crashed gSender mid-job.
  - Set `ph-no-capture` on the page and the frame.
  - Use canvas, not large re-rendered SVG.
  - Keep overlays small and clear them when they're no longer needed.
  - Keep logs bounded.
  - Before calling a UI change done, check that the heap stays flat in the real app.
- Machine logic that doesn't need the SDK (geometry, G-code generation and rewriting, scan planning) lives in pure modules with Node unit tests.

## Working in the repo
- `npm test`: unit and golden tests. `npm run dev`: mock gSender host at http://localhost:8765 (simulated Grbl).
- Installed plugins are copies in gSender's plugin folder. Re-run `npm run install-plugins` after editing, or you'll test stale code. A new plugin or a manifest change needs a gSender restart.
