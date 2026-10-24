// Follows one attempt of a job through gSender's controller events and decides
// how it ended. Pure module: the page feeds it normalised events.
//
// gSender ends a job the same way whether it finished or the user pressed
// Stop: workflow:state goes to 'idle' and the sender rewinds (received = 0).
// A job finished only if, just before that, every line was acknowledged and
// the machine stood Idle (gSender itself waits for 500 ms of Idle before it
// stops a finished job). finishTime alone is not enough: it is set when the
// last line enters the planner, seconds before the machine gets there.

/**
 * @param {string} file name the job was loaded under in gSender
 * @param {{ total?: number }} [opts] lines gSender counted for the file
 */
export function createTracker(file, { total = 0 } = {}) {
    return { file, phase: 'armed', received: 0, total, finishTime: 0, activeState: null };
}

/**
 * Feeds one event. Events:
 *   { type: 'workflow', state: 'idle' | 'running' | 'paused' }
 *   { type: 'sender', status }          gSender's sender:status
 *   { type: 'controller', activeState } from controller:state
 *   { type: 'close' }                   serialport:close
 *   { type: 'startup' }                 the controller restarted
 * @returns {null | { kind: 'started' | 'paused' | 'resumed' }
 *   | { kind: 'progress', line: number }
 *   | { kind: 'end', result: 'done' | 'cancelled' | 'failed', line: number, note: string | null }}
 */
export function track(t, ev) {
    if (t.phase === 'ended') return null;
    const live = t.phase === 'running' || t.phase === 'paused';
    const end = (result, note = null) => {
        t.phase = 'ended';
        return { kind: 'end', result, line: t.received, note };
    };
    switch (ev.type) {
        case 'sender': {
            const s = ev.status;
            if (!s || s.name !== t.file) return null;
            if (Number(s.total) > 0) t.total = Number(s.total);
            if (Number(s.finishTime) > 0) t.finishTime = Number(s.finishTime);
            const r = Number(s.received) || 0;
            if (live && r > t.received) {
                t.received = r;
                return { kind: 'progress', line: r };
            }
            return null;
        }
        case 'controller': {
            t.activeState = ev.activeState ?? t.activeState;
            if (live && /^Alarm/i.test(t.activeState ?? '')) {
                return end('failed', 'The machine raised an alarm and stopped. Check the bit and the board before doing anything else.');
            }
            return null;
        }
        case 'workflow':
            if (ev.state === 'running') {
                if (t.phase === 'armed') { t.phase = 'running'; return { kind: 'started' }; }
                if (t.phase === 'paused') { t.phase = 'running'; return { kind: 'resumed' }; }
                return null;
            }
            if (ev.state === 'paused' && t.phase === 'running') { t.phase = 'paused'; return { kind: 'paused' }; }
            if (ev.state === 'idle' && live) {
                const allSent = t.total > 0 && (t.received >= t.total || t.finishTime > 0);
                if (allSent && t.activeState === 'Idle') return end('done');
                return end('cancelled', 'Stopped before the end.');
            }
            return null;
        case 'close':
            return live ? end('failed', 'The connection to the machine was lost during this job.') : null;
        case 'startup':
            return live ? end('failed', 'The controller restarted during this job, so its position may be lost.') : null;
        default:
            return null;
    }
}
