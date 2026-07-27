import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])
from headless_terminal import HeadlessTerminal

out = os.path.join(tempfile.gettempdir(), "mh_mr_ctrlc.txt")
if os.path.exists(out):
    os.remove(out)
t = HeadlessTerminal()
t.send_keystrokes("sleep 300")
t.send_keystrokes("\n", wait_sec=1)
t.send_keystrokes("\x03", wait_sec=1)  # Ctrl-C must interrupt the sleep
t.send_keystrokes(f"echo mh_after_int > {out}")
t.send_keystrokes("\n", wait_sec=3)
if not (os.path.exists(out) and open(out).read().strip() == "mh_after_int"):
    print("relation mr-ctrlc violated: after \\x03 the shell did not accept the next command (sleep 300 survived the interrupt)")
    sys.exit(1)
