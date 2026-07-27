import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])

out = os.path.join(tempfile.gettempdir(), "mh_mr_bashrc.txt")
if os.path.exists(out):
    os.remove(out)
rc = os.path.expanduser("~/.bashrc")
marker = "export MH_RC_MARK=mh_rc_ok  # mh-relation-probe\n"
with open(rc, "a") as f:
    f.write(marker)
try:
    from headless_terminal import HeadlessTerminal  # constructed AFTER the marker exists
    t = HeadlessTerminal()
    t.send_keystrokes(f"echo $MH_RC_MARK > {out}")
    t.send_keystrokes("\n", wait_sec=3)
    ok = os.path.exists(out) and open(out).read().strip() == "mh_rc_ok"
finally:
    lines = open(rc).readlines()
    with open(rc, "w") as f:
        f.writelines(l for l in lines if "mh-relation-probe" not in l)
if not ok:
    print("relation mr-bashrc violated: a fresh terminal did not see a variable exported from ~/.bashrc (startup files not sourced)")
    sys.exit(1)
