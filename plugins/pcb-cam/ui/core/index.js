// Public API of the PCB CAM core. Pure ES modules: no DOM, no gSender SDK.

export * as geometry from './geometry.js';
export { loadFile, parseGerber, parseExcellon, detectLayer, sniffFormat } from './import/index.js';
export { isPlated } from './import/excellon.js';
export { validate } from './schema.js';
export { TOOL_SCHEMA, TOOL_DB_SCHEMA, validateTool, widthAtDepth, depthForWidth, cuttingFor, createToolDb, findTool, setTool, removeTool } from './tools.js';
export { PROJECT_SCHEMA, COMMANDS, createProject, applyCommand, validateProject, componentOf, netOf } from './project.js';
export { inspectBoard } from './inspect.js';
