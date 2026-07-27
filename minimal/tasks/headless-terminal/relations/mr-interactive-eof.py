import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])
from headless_terminal import HeadlessTerminal

out = os.path.join(tempfile.gettempdir(), "mh_mr_eof.txt")
if os.path.exists(out):
    os.remove(out)
t = HeadlessTerminal()
t.send_keystrokes(f"cat > {out}")
t.send_keystrokes("\n", wait_sec=1)
t.send_keystrokes("mh_interactive_line")
t.send_keystrokes("\n", wait_sec=1)
t.send_keystrokes("\x04", wait_sec=2)  # Ctrl-D: end interactive cat
if not (os.path.exists(out) and "mh_interactive_line" in open(out).read()):
    print(f"relation mr-interactive-eof violated: interactive `cat > file` + Ctrl-D did not capture typed input in {out}")
    sys.exit(1)
