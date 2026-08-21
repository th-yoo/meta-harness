import random, subprocess, sys, json, math
from pathlib import Path
# regenerate the quartet fixture under different seeds / noise, count anchors
src = Path("term-bench2/probe-tasks/raman-quartet-report/make-data.py").read_text()
out = Path("/tmp/claude-1001/robust.dat")
PEAKS = [("D",1350.00,28.40,3100.00),("G",1580.30,9.06,8382.69),("Dp",1620.00,12.10,2400.00),("2D",2670.08,17.52,12314.42)]
BASELINE=5561.03; NM_LO,NM_HI,N=3500.0,7700.0,3000
def gen(seed, sigma):
    random.seed(seed); rows=[]
    for i in range(N):
        nm = NM_LO+(NM_HI-NM_LO)*i/(N-1); shift=1e7/nm
        y=BASELINE+sum(a*g*g/((shift-x0)**2+g*g) for _,x0,g,a in PEAKS)+random.gauss(0,sigma)
        rows.append((nm,y))
    out.write_text("\n".join(f"{nm:.6f}\t{y:.6f}" for nm,y in rows)+"\n")
for sigma in (15.0, 30.0, 60.0):
    for seed in (42, 7, 1234, 99):
        gen(seed, sigma)
        r=subprocess.run(["bun","/tmp/claude-1001/count.ts"],capture_output=True,text=True)
        print(f"sigma={sigma:5.1f} seed={seed:5d} -> {r.stdout.strip() or r.stderr.strip()[:60]}")
