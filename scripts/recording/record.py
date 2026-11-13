"""Run a command in a real pseudo-terminal and save timestamped output chunks (JSON) for later replay.

usage: record.py OUT.json COLS ROWS -- command...
example: python3 scripts/recording/record.py capture.json 128 36 -- node scripts/showcase.mjs
"""
import base64, fcntl, json, os, pty, select, struct, subprocess, sys, termios, time

out, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
cmd = sys.argv[sys.argv.index("--") + 1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows))
env.pop("NO_COLOR", None)
t0 = time.monotonic()
p = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
os.close(slave)
chunks = []
while True:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        chunks.append([round(time.monotonic() - t0, 4), base64.b64encode(data).decode()])
    elif p.poll() is not None:
        # drain anything left, then stop
        r, _, _ = select.select([master], [], [], 0.2)
        if not r:
            break
code = p.wait()
json.dump({"cols": cols, "rows": rows, "exit": code, "duration": round(time.monotonic() - t0, 3), "chunks": chunks}, open(out, "w"))
print(f"exit={code} duration={time.monotonic() - t0:.1f}s chunks={len(chunks)} bytes={sum(len(base64.b64decode(c[1])) for c in chunks)}")
