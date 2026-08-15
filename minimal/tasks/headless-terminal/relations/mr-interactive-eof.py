import os, sys, time
sys.path.insert(0, os.environ["APPDIR"])
from _mr_common import marker, wait_for
from headless_terminal import HeadlessTerminal

start = marker("mh_mr_eof_start.txt")
out = marker("mh_mr_eof.txt")
t = HeadlessTerminal()
# Start marker proves the shell reached this line; `cat > out` is the next
# command on it, so typed input lands in cat, not a still-pending prompt.
t.send_keystrokes(f"echo mh_start > {start}; cat > {out}")
t.send_keystrokes("\n")
if not wait_for(start, contains="mh_start"):
    print("relation mr-interactive-eof violated: shell never executed the cat command line")
    sys.exit(1)
time.sleep(0.5)  # grace: let the shell advance from echo to cat
t.send_keystrokes("mh_interactive_line")
t.send_keystrokes("\n", wait_sec=0.5)
t.send_keystrokes("\x04")  # Ctrl-D: end interactive cat
if not wait_for(out, contains="mh_interactive_line"):
    print(f"relation mr-interactive-eof violated: interactive `cat > file` + Ctrl-D did not capture typed input in {out}")
    sys.exit(1)
