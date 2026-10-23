// Loads one fabrication file: sniffs the format, parses it, and guesses its role.

import { parseGerber } from './gerber.js';
import { parseExcellon } from './excellon.js';
import { detectLayer, sniffFormat } from './detect.js';

/**
 * @param {string} name file name
 * @param {string} text file contents
 * @returns {{ name: string, layer: object|null, guess: object }} `layer` is null when the format is not recognised
 */
export function loadFile(name, text) {
    const format = sniffFormat(text);
    let layer = null;
    if (format === 'gerber') layer = parseGerber(text);
    else if (format === 'excellon') layer = parseExcellon(text);
    const guess = detectLayer(name, { text, parsed: layer ?? undefined });
    return { name, layer, guess };
}

export { parseGerber, parseExcellon, detectLayer, sniffFormat };
