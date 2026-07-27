import os, sys
import rdflib
from rdflib import Literal

artifact = os.environ["ARTIFACT"]
appdir = os.environ["APPDIR"]
query = open(artifact).read()

g = rdflib.Graph()
g.parse(os.path.join(appdir, "university_graph.ttl"), format="turtle")
try:
    base = {str(row[0]) for row in g.query(query)}
except Exception as e:
    print(f"relation mr-rename violated: query does not execute: {e}")
    sys.exit(1)
if not base:
    sys.exit(0)  # vacuous: no results to rename — other checks own emptiness

target = sorted(base)[0]
SUFFIX = "_MHRENAME"
g2 = rdflib.Graph()
for s, p, o in g:
    if isinstance(o, Literal) and str(o) == target:
        o = Literal(str(o) + SUFFIX, datatype=o.datatype, lang=o.language)
    g2.add((s, p, o))
renamed = {str(row[0]) for row in g2.query(query)}
expected = {(n + SUFFIX if n == target else n) for n in base}
if renamed != expected:
    print(
        "relation mr-rename violated: renaming professor "
        f"'{target}' in the graph did not rename it in the results.\n"
        f"expected names: {sorted(expected)}\ngot: {sorted(renamed)}\n"
        "(a correct query tracks the data; hardcoded names or brittle matching break this)"
    )
    sys.exit(1)
