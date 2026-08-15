import os, sys
sys.path.insert(0, os.environ["APPDIR"])
from _mr_common import marker, wait_for
from headless_terminal import HeadlessTerminal

out = marker("mh_mr_exec.txt")
t = HeadlessTerminal()
t.send_keystrokes(f"echo mh_exec_ok > {out}")
t.send_keystrokes("\n")
if not wait_for(out, contains="mh_exec_ok"):
    print(f"relation mr-exec violated: typed command + Enter did not execute (expected '{out}' containing mh_exec_ok)")
    sys.exit(1)
