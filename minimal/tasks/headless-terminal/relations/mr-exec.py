import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])
from headless_terminal import HeadlessTerminal

out = os.path.join(tempfile.gettempdir(), "mh_mr_exec.txt")
if os.path.exists(out):
    os.remove(out)
t = HeadlessTerminal()
t.send_keystrokes(f"echo mh_exec_ok > {out}")
t.send_keystrokes("\n", wait_sec=3)
if not (os.path.exists(out) and open(out).read().strip() == "mh_exec_ok"):
    print(f"relation mr-exec violated: typed command + Enter did not execute (expected '{out}' containing mh_exec_ok)")
    sys.exit(1)
