import os, sys
sys.path.insert(0, os.environ["APPDIR"])
from _mr_common import marker, wait_for

out = marker("mh_mr_bashrc.txt")
rc = os.path.expanduser("~/.bashrc")
mark_line = "export MH_RC_MARK=mh_rc_ok  # mh-relation-probe\n"
with open(rc, "a") as f:
    f.write(mark_line)
ok = False
try:
    from headless_terminal import HeadlessTerminal  # constructed AFTER the marker exists
    t = HeadlessTerminal()
    t.send_keystrokes(f"echo $MH_RC_MARK > {out}")
    t.send_keystrokes("\n")
    ok = wait_for(out, contains="mh_rc_ok")
finally:
    lines = open(rc).readlines()
    with open(rc, "w") as f:
        f.writelines(l for l in lines if "mh-relation-probe" not in l)
if not ok:
    print("relation mr-bashrc violated: a fresh terminal did not see a variable exported from ~/.bashrc (startup files not sourced)")
    sys.exit(1)
