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
- Each `ok` / `error:` frees the oldest line; a soft reset or controller
  restart clears everything in flight.
- error: and ALARM: replies are logged with the line that caused them.
- The serial port is opened once and kept open, so the board isn't reset
  when a client connects/disconnects. One TCP client at a time; a new client
  kicks the old one.
"""
import argparse
import collections
import socket
import threading
import time

import serial

REALTIME = {0x18, ord("?"), ord("!"), ord("~")}
MARGIN = 16  # bytes kept free in the controller's receive buffer


def is_realtime(b):
    return b in REALTIME or b >= 0x80


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM3")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--tcp", type=int, default=23)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--rx", type=int, default=512,
                    help="controller receive buffer in bytes (2nd number after the planner size in $I [OPT:...])")
    args = ap.parse_args()
    limit = args.rx - MARGIN

    ser = serial.Serial(args.port, args.baud, timeout=0.05)
    print(f"Opened {args.port} @ {args.baud}; keeping at most {limit} bytes in the controller")

    lock = threading.Condition()
    client = {"sock": None}
    pending = collections.deque()    # complete lines from the client, not yet sent
    inflight = collections.deque()   # lines sent, waiting for ok/error
    used = [0]                       # bytes of inflight lines

    def log(msg):
        print(time.strftime("%H:%M:%S"), msg, flush=True)

    def clear_queues(why):
        with lock:
            if pending or inflight:
                log(f"{why}: dropped {len(pending)} queued and {len(inflight)} unacknowledged line(s)")
            pending.clear()
            inflight.clear()
            used[0] = 0
            lock.notify_all()

    # Sends queued lines whenever the controller has room.
    def feeder():
        while True:
            with lock:
                while not (pending and used[0] + len(pending[0]) <= limit) and not (pending and not inflight):
                    lock.wait()
                line = pending.popleft()
                inflight.append(line)
                used[0] += len(line)
            try:
                ser.write(line)
            except serial.SerialException as e:
                log(f"serial write failed: {e}")

    # Everything the controller sends goes to the current client; ok/error free buffer space.
    def serial_to_tcp():
        buf = b""
        while True:
            try:
                data = ser.read(ser.in_waiting or 1)
            except serial.SerialException as e:
                log(f"serial read failed: {e}")
                time.sleep(1)
                continue
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
                    log(line)
                elif line.startswith("Grbl") or line.startswith("GrblHAL"):
                    clear_queues("controller restarted")

    threading.Thread(target=feeder, daemon=True).start()
    threading.Thread(target=serial_to_tcp, daemon=True).start()

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.bind, args.tcp))
    srv.listen(1)
    # Short timeout so Ctrl-C is noticed on Windows (accept() otherwise blocks it).
    srv.settimeout(0.5)
    print(f"Listening on {args.bind}:{args.tcp}  (Ctrl-C to stop)")

    while True:
        try:
            conn, addr = srv.accept()
        except socket.timeout:
            continue
        conn.settimeout(None)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        # Swap in the new client, kick the old one
        with lock:
            old = client["sock"]
            client["sock"] = conn
        if old:
            try:
                old.close()
            except OSError:
                pass
            print("Previous client kicked")
        clear_queues("new client")
        print(f"Client connected: {addr[0]}:{addr[1]}")

        # Per client: real-time bytes go straight out, lines go through the feeder.
        def tcp_to_serial(c=conn, a=addr):
            partial = b""
            try:
                while True:
                    data = c.recv(4096)
                    if not data:
                        break
                    rt = bytes(b for b in data if is_realtime(b))
                    if rt:
                        ser.write(rt)
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
            except OSError:
                pass
            finally:
                with lock:
                    if client["sock"] is c:
                        client["sock"] = None
                try:
                    c.close()
                except OSError:
                    pass
                print(f"Client disconnected: {a[0]}:{a[1]}")

        threading.Thread(target=tcp_to_serial, daemon=True).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
