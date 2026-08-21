import json,glob,os,re,collections
WRITE_TOOLS={"write","edit","patch","create"}
def classify(path):
    proc=[]; under=[]; target=[]; reads=0; bash=0
    for line in open(path):
        line=line.strip()
        if not line: continue
        try: d=json.loads(line)
        except: continue
        if d.get("t")!="tool": continue
        tool=(d.get("tool") or "").lower()
        args=d.get("args") or ""
        if tool in ("read","list","glob","grep"): reads+=1
        if tool=="bash": bash+=1
        # file writes via write/edit tools
        fp=""
        m=re.search(r'"filePath"\s*:\s*"([^"]+)"',args)
        if m: fp=m.group(1)
        wrote = tool in WRITE_TOOLS and fp
        # bash heredoc / redirect writes
        if tool=="bash":
            for m2 in re.finditer(r'>\s*([^\s;|&"\']+\.(?:md|txt|json|csv|log|c|h|py))',args):
                fp2=m2.group(1); wrote=True; fp=fp2
        if not wrote: continue
        base=os.path.basename(fp).lower()
        if base.endswith(("image.c",)) or base=="image.c": target.append(fp)
        elif base.endswith((".md",".txt",".json",".csv",".log")): under.append(fp)
        elif base.endswith((".py",".sh",".c",".h",".cpp")): proc.append(fp)
        else: proc.append(fp)
    return proc,under,target,reads,bash

rows=[]
for f in sorted(glob.glob(".kkamak/global/candidates/v20/traj/bench-*.ndjson")):
    task=os.path.basename(f).replace("bench-","").rsplit("-",2)[0]
    p,u,t,r,b=classify(f)
    rows.append((task,os.path.basename(f)[-17:-7],len(p),len(u),len(t),r,b,u[:3]))
print(f"{'task':34} {'traj':10} {'proc':>4} {'under':>5} {'targ':>4} {'read':>4} {'bash':>4}  understanding-files")
for t,i,p,u,tg,r,b,ul in rows:
    print(f"{t:34} {i:10} {p:4} {u:5} {tg:4} {r:4} {b:4}  {ul if ul else ''}")
print()
tot_u=sum(x[3] for x in rows); tot_p=sum(x[2] for x in rows); tot_t=sum(x[4] for x in rows)
print(f"TOTALS across {len(rows)} trajectories: process={tot_p}  understanding={tot_u}  target={tot_t}")
