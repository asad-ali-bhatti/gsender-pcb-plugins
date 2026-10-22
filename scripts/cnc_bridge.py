"""
TCP <-> serial bridge for a Grbl / grblHAL CNC, with flow control.

Usage (Windows, Raspberry Pi, ...):
    pip install pyserial
    python cnc_bridge.py --port COM3 --baud 115200 --tcp 23 --rx 512

Then connect from another machine (gSender "Ethernet") to <this-ip>:<tcp>.

Why flow control: gSender streams G-code by counting characters in the
controller's receive buffer. Its grblHAL driver assumes a 724-byte buffer,
but small boards (e.g. STM32F103, [OPT:...,512]) only have 512. When gSender
over-fills it, the extra characters are silently dropped on a UART link:
moves go missing (the tool cuts straight to the next point), the broken line
returns error: (gSender pauses), and the job never finishes (the lost line's
`ok` never comes). This bridge holds lines back so that never more than
--rx minus a margin bytes are waiting in the controller.

- Real-time commands (? ! ~ Ctrl-X, bytes >= 0x80) are passed through at once.
- Each `ok` / `error:` frees the oldest line; a soft reset, an ALARM or a
  controller restart clears everything in flight.
- error: and ALARM: replies are logged with the line that caused them.
- The serial port is opened once and kept open, so the board isn't reset
  when a client connects/disconnects. One TCP client at a time; a new client
  kicks the old one.
- A serial error (e.g. a USB glitch when the spindle switches on) never drops
  the TCP client: the port is reopened, and a running job is feed-held.
- Everything is also appended to cnc_bridge.log next to this script (--log),
  rotated to cnc_bridge.log.1 at 5 MB.
- If the client goes away mid-job (lines still queued or unacknowledged), the
  bridge sends a feed hold (!) so the machine stops instead of cutting the
  already-sent lines unattended. Resume or reset from the sender afterwards.
"""
import argparse
import collections
import os
import socket
import threading
import time
import traceback

import serial

REALTIME = {0x18, ord("?"), ord("!"), ord("~")}
MARGIN = 16  # bytes kept free in the controller's receive buffer
OPEN_REMINDER_S = 300  # while the port is missing, log a reminder this often
LOG_MAX_BYTES = 5_000_000  # the log is moved to <log>.1 when it grows past this
ALARMS = {
    "1": "hard limit switch triggered",
    "2": "move beyond soft limits",
    "3": "reset while moving",
    "4": "probe not open at start",
    "5": "probe did not trigger",
    "8": "homing could not clear the switch",
    "9": "homing switch not found",
}


PINS = {"X": "limit X", "Y": "limit Y", "Z": "limit Z", "A": "limit A", "P": "probe",
        "D": "door", "H": "feed hold", "R": "reset", "S": "cycle start", "E": "E-stop",
        "T": "tool setter", "O": "optional stop", "B": "block delete", "L": "lock"}


def pin_names(pn):
    return ", ".join(PINS.get(c, c) for c in pn) or "none"


def is_realtime(b):
    return b in REALTIME or b >= 0x80


class SerialLink:
    """The controller's serial port, kept alive through USB glitches.

    A failed read or write (e.g. interference when the spindle switches on)
    closes the port and reopens it once the device is back, instead of the
    error escaping into the TCP side and dropping the sender's connection.
    """

    def __init__(self, port, baud, log, on_reopen):
        self.port, self.baud, self.log, self.on_reopen = port, baud, log, on_reopen
        self.lock = threading.Lock()
        self.gen = 0
        self.ser = self._open()

    # Retries every second, but logs only the first failure and then a reminder
    # every OPEN_REMINDER_S, so a machine left unplugged doesn't fill the log.
    def _open(self):
        tries = 0
        while True:
            try:
                ser = serial.Serial(self.port, self.baud, timeout=0.05)
                if tries:
                    self.log(f"{self.port} is back after {tries} failed attempt(s)")
                return ser
            except Exception as e:   # termios.error too: a USB adapter in a bad state
                if tries % OPEN_REMINDER_S == 0:
                    still = f" (still missing after {tries} s)" if tries else ""
                    self.log(f"cannot open {self.port}{still}: {e}; retrying every second"
                             "  -> is the machine on? unplug the USB cable, plug it back in (check the port name)")
                tries += 1
                time.sleep(1)

    def _reopen(self, gen, what, err):
        with self.lock:
            if gen != self.gen:      # another thread already reopened it (or is doing so)
                time.sleep(0.05)
                return
            self.log(f"SERIAL {what} FAILED: {err}; reopening {self.port}")
            try:
                self.ser.close()
            except Exception:
                pass
            time.sleep(0.5)
            self.ser = self._open()
            self.gen += 1
            self.log(f"{self.port} reopened")
        self.on_reopen()

    # Any exception counts: pyserial on Windows also raises AttributeError and
    # the like when the port is closed under a read by another thread's reopen.
    def write(self, data):
        ser, gen = self.ser, self.gen
        try:
            ser.write(data)
            return True
        except Exception as e:
            self._reopen(gen, "write", e)
            return False

    def read(self):
        ser, gen = self.ser, self.gen
        try:
            return ser.read(ser.in_waiting or 1)
        except Exception as e:
            self._reopen(gen, "read", e)
            return b""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM3")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--tcp", type=int, default=23)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--rx", type=int, default=512,
                    help="controller receive buffer in bytes (2nd number after the planner size in $I [OPT:...])")
    ap.add_argument("--log", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "cnc_bridge.log"),
                    help="file the log is also appended to (default: cnc_bridge.log next to this script)")
    args = ap.parse_args()
    limit = args.rx - MARGIN

    logfile = open(args.log, "a", encoding="utf-8", buffering=1)
    log_lock = threading.Lock()

    def log(msg):
        nonlocal logfile
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
        with log_lock:
            print(line[11:], flush=True)
            if logfile.tell() > LOG_MAX_BYTES:   # keep one old log, drop the one before
                logfile.close()
                os.replace(args.log, args.log + ".1")
                logfile = open(args.log, "a", encoding="utf-8", buffering=1)
            logfile.write(line + "\n")

    lock = threading.Condition()
    client = {"sock": None}
    pending = collections.deque()    # complete lines from the client, not yet sent
    inflight = collections.deque()   # lines sent, waiting for ok/error
    used = [0]                       # bytes of inflight lines
    last_status = [""]               # latest <...> report, logged when something goes wrong
    last_pins = [""]                 # active input pins (Pn:) in the latest report

    def clear_queues(why):
        with lock:
            if pending or inflight:
                log(f"{why}: dropped {len(pending)} queued and {len(inflight)} unacknowledged line(s)")
            pending.clear()
            inflight.clear()
            used[0] = 0
            lock.notify_all()

    # A client gone mid-job: stop the machine instead of letting it cut the lines
    # already sent with nobody watching. Lines not yet sent belong to the dead
    # client and are dropped; lines in the controller stay counted, since they
    # are still there (they get their ok after a resume, or vanish on a reset).
    def hold_if_busy(why):
        with lock:
            busy = bool(pending or inflight)
            dropped = len(pending)
            pending.clear()
            lock.notify_all()
        if busy:
            ser.write(b"!")
            log(f"{why} during a job: FEED HOLD sent, dropped {dropped} unsent line(s). "
                "Resume (~) or reset from the sender after reconnecting.")

    # After a serial glitch, bytes may have been lost in either direction: stop the
    # job and start counting afresh (the controller may also have reset).
    def serial_reopened():
        hold_if_busy("Serial link lost")
        clear_queues("serial port reopened")

    ser = SerialLink(args.port, args.baud, log, serial_reopened)
    log(f"Opened {args.port} @ {args.baud}; keeping at most {limit} bytes in the controller; log: {args.log}")

    # Sends queued lines whenever the controller has room.
    def feeder():
        while True:
            with lock:
                while not (pending and used[0] + len(pending[0]) <= limit) and not (pending and not inflight):
                    lock.wait()
                line = pending.popleft()
                inflight.append(line)
                used[0] += len(line)
            ser.write(line)

    # Everything the controller sends goes to the current client; ok/error free buffer space.
    def serial_to_tcp():
        buf = b""
        while True:
            data = ser.read()
            if not data:
                continue
            with lock:
                s = client["sock"]
            if s:
                try:
                    s.sendall(data)
                except OSError as e:
                    log(f"send to client failed: {e}")
            buf += data
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.strip().decode("ascii", "replace")
                if line.startswith("ok") or line.startswith("error:"):
                    with lock:
                        sent = inflight.popleft() if inflight else b""
                        used[0] -= len(sent)
                        lock.notify_all()
                    if line.startswith("error:"):
                        log(f"{line} on: {sent.decode('ascii', 'replace').strip()}")
                elif line.startswith("ALARM:"):
                    log(f"{line} ({ALARMS.get(line[6:], 'see grblHAL alarm codes')})")
                    # The controller aborts and discards its receive buffer: those lines
                    # never get an ok. Without this, the count stays full and nothing
                    # (not even $X) is forwarded again until the client reconnects.
                    clear_queues("alarm")
                elif line.startswith("Grbl") or line.startswith("GrblHAL"):
                    log(f"controller restarted: {line}")
                    clear_queues("controller restarted")
                elif line.startswith("<"):
                    last_status[0] = line
                    # Log every change of the input pins: a limit / reset / E-stop
                    # input that flickers while the spindle runs shows up here.
                    fields = line.strip("<>").split("|")
                    pn = next((f[3:] for f in fields if f.startswith("Pn:")), "")
                    if pn != last_pins[0]:
                        on = "".join(c for c in pn if c not in last_pins[0])
                        off = "".join(c for c in last_pins[0] if c not in pn)
                        change = "; ".join(x for x in (on and f"ON: {pin_names(on)}", off and f"off: {pin_names(off)}") if x)
                        log(f"inputs {change} (state {fields[0]})")
                        last_pins[0] = pn
                elif line.startswith("[MSG:"):
                    log(line)

    # A worker that dies silently stops the bridge while the client stays connected,
    # so log any unexpected error and carry on.
    def keep_running(name, fn):
        def run():
            while True:
                try:
                    fn()
                except Exception:
                    log(f"{name} crashed, restarting it:")
                    with log_lock:
                        traceback.print_exc()
                        traceback.print_exc(file=logfile)
                    time.sleep(0.2)
        threading.Thread(target=run, name=name, daemon=True).start()

    keep_running("feeder", feeder)
    keep_running("serial reader", serial_to_tcp)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.bind, args.tcp))
    srv.listen(1)
    # Short timeout so Ctrl-C is noticed on Windows (accept() otherwise blocks it).
    srv.settimeout(0.5)
    log(f"Listening on {args.bind}:{args.tcp}  (Ctrl-C to stop)")

    while True:
        try:
            conn, addr = srv.accept()
        except socket.timeout:
            continue
        conn.settimeout(None)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        # Keepalive so a vanished client (Wi-Fi drop, sleep) is noticed in ~20 s
        # instead of never.
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "SIO_KEEPALIVE_VALS"):  # Windows: on, 10 s idle, 3 s interval
            conn.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 10000, 3000))
        else:
            for opt, v in (("TCP_KEEPIDLE", 10), ("TCP_KEEPINTVL", 3), ("TCP_KEEPCNT", 3)):
                try:
                    conn.setsockopt(socket.IPPROTO_TCP, getattr(socket, opt), v)
                except (AttributeError, OSError):
                    pass

        # Swap in the new client, kick the old one
        with lock:
            old = client["sock"]
            client["sock"] = conn
        if old:
            try:
                old.close()
            except OSError:
                pass
            log("Previous client kicked")
            hold_if_busy("Client replaced")
        with lock:
            busy = bool(inflight)
        if not busy:
            clear_queues("new client")
        log(f"Client connected: {addr[0]}:{addr[1]}")

        # Per client: real-time bytes go straight out, lines go through the feeder.
        def tcp_to_serial(c=conn, a=addr):
            partial = b""
            why = "connection lost"
            try:
                while True:
                    data = c.recv(4096)
                    if not data:
                        break
                    rt = bytes(b for b in data if is_realtime(b))
                    if rt:
                        ser.write(rt)   # serial errors are handled by SerialLink, never here
                        if 0x18 in rt:
                            clear_queues("soft reset")
                            partial = b""
                    partial += bytes(b for b in data if not is_realtime(b))
                    lines = []
                    while b"\n" in partial:
                        line, partial = partial.split(b"\n", 1)
                        lines.append(line + b"\n")
                    if lines:
                        with lock:
                            pending.extend(lines)
                            lock.notify_all()
                why = "closed by the client"
            except OSError as e:
                why = f"connection lost: {e}"
            except Exception as e:
                why = f"bridge error: {e!r}"
                with log_lock:
                    traceback.print_exc(file=logfile)
            finally:
                with lock:
                    current = client["sock"] is c
                    if current:
                        client["sock"] = None
                try:
                    c.close()
                except OSError:
                    pass
                log(f"Client disconnected: {a[0]}:{a[1]} ({why if current else 'replaced by a new client'}); "
                    f"last status: {last_status[0] or 'none'}")
                if current:
                    hold_if_busy("Client disconnected")

        threading.Thread(target=tcp_to_serial, daemon=True).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
