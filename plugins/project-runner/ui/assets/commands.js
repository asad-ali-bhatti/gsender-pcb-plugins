// Steps the user adds before or after a job: a bit change, a pause with a
// message, or a few lines of G-code. Pure module: G-code goes out through
// `io` (as in zeroz.js), so it runs against a simulated controller in tests.
//
// G-code steps are for small things (coolant or a dust shoe on an M-code, a
// move out of the way). Anything that would change the coordinates, the
// controller settings or the program flow is refused, because the Runner has
// a guided step for each of those or they would leave the run in doubt.

export const COMMAND_TYPES = {
    bit: { label: 'Bit change + zero Z', short: 'Bit change', glyph: '⇄' },
    note: { label: 'Pause with a message', short: 'Pause', glyph: '⏸' },
    gcode: { label: 'G-code', short: 'G-code', glyph: '›' },
};

export const GCODE_MAX_LINES = 20;
export const NOTE_MAX_LENGTH = 200;

/** A command as kept in the setup and the run file. */
export const makeCommand = (type, text, id) => ({ id, type, text: type === 'bit' ? '' : String(text ?? '').trim() });

/** Number words as a regular expression: word('M', '0?6') matches M6 and M06 but not M60. */
const word = (letter, nums) => new RegExp(`${letter}0*(?:${nums})(?![0-9.])`, 'i');

const REFUSED = [
    [/^\$(?!H$)/i, (l) => `"${l}" is a setting. Use gSender's Config page.`],
    [/[!~?\x18\x80-\xff]/, (l) => `"${l}" has a control character. Use gSender's buttons.`],
    [word('M', '6'), () => 'No M6. Add a Bit change step.'],
    [word('M', '0|1|2|30'), () => 'No M0/M1/M2/M30. Add a Pause step.'],
    [word('G', '38\\.[2-5]'), () => 'No probing here. The Bit change step zeroes Z.'],
    [word('G', '10|92'), () => 'No G10/G92: changing coordinates would misplace the jobs.'],
    [word('G', '91'), () => 'No G91. Use absolute moves (G53 for machine coordinates).'],
];

const MOVES = [word('G', '0|1|2|3|28|30'), /^\$H$/i];
const SPINDLE_ON = word('M', '3|4');

/**
 * Checks G-code the user typed.
 * @returns {{ ok: true, lines: string[], moves: boolean, spindle: boolean } | { ok: false, message: string }}
 */
export function checkGcode(text) {
    const lines = String(text ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim())
        .filter(Boolean);
    if (!lines.length) return { ok: false, message: 'Type at least one line.' };
    if (lines.length > GCODE_MAX_LINES) return { ok: false, message: `At most ${GCODE_MAX_LINES} lines.` };
    for (const l of lines) {
        for (const [re, msg] of REFUSED) if (re.test(l)) return { ok: false, message: msg(l) };
    }
    return { ok: true, lines, moves: lines.some((l) => MOVES.some((re) => re.test(l))), spindle: lines.some((l) => SPINDLE_ON.test(l)) };
}

/** Checks a command before it is added. @returns {string|null} what is wrong, in plain words */
export function commandProblem(cmd) {
    if (!COMMAND_TYPES[cmd?.type]) return 'Pick what to add.';
    if (cmd.type === 'note') {
        if (!cmd.text) return 'Type the message to show.';
        if (cmd.text.length > NOTE_MAX_LENGTH) return `At most ${NOTE_MAX_LENGTH} characters.`;
    }
    if (cmd.type === 'gcode') {
        const r = checkGcode(cmd.text);
        if (!r.ok) return r.message;
    }
    return null;
}

const FAIL_RE = /^(error:|ALARM:)/;

/**
 * Sends the lines one by one, then waits for the motion to finish (G4 P0 is
 * answered once the planner is empty). Stops at the first refusal.
 * @param {{ send(cmd, opts): Promise<string[]>, aborted(): boolean, status?(text): void }} io
 */
export async function runGcode(io, text) {
    const r = checkGcode(text);
    if (!r.ok) throw new Error(r.message);
    for (const [n, line] of [...r.lines, 'G4 P0'].entries()) {
        if (io.aborted()) throw new Error('Stopped.');
        if (n < r.lines.length) io.status?.(`Sending line ${n + 1} of ${r.lines.length}: ${line}`);
        else io.status?.('Waiting for the machine to finish…');
        const replies = await io.send(line, { timeout: n < r.lines.length ? 10000 : 120000 });
        const bad = replies.find((l) => FAIL_RE.test(String(l).trim()));
        if (bad) throw new Error(`The machine refused "${line}" (${bad}). Stopped there.`);
    }
}
