import os, sys, time
sys.path.insert(0, os.environ["APPDIR"])
from _mr_common import marker, wait_for
from headless_terminal import HeadlessTerminal

start = marker("mh_mr_ctrlc_start.txt")
out = marker("mh_mr_ctrlc.txt")
t = HeadlessTerminal()
# Compound line: the start marker proves the shell reached this statement —
# `sleep 300` is the very next command on the same line, so once the marker
# exists the sleep is (about to be) the foreground process.
t.send_keystrokes(f"echo mh_start > {start}; sleep 300")
t.send_keystrokes("\n")
if not wait_for(start, contains="mh_start"):
    print("relation mr-ctrlc violated: shell never executed the sleep command line")
    sys.exit(1)
time.sleep(0.5)  # grace: let the shell advance from echo to sleep
t.send_keystrokes("\x03", wait_sec=0.5)  # Ctrl-C must interrupt the sleep
t.send_keystrokes(f"echo mh_after_int > {out}")
t.send_keystrokes("\n")
if not wait_for(out, contains="mh_after_int"):
    print("relation mr-ctrlc violated: after \\x03 the shell did not accept the next command (sleep 300 survived the interrupt)")
    sys.exit(1)
