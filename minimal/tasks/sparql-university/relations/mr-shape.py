import os, sys
import rdflib

artifact = os.environ["ARTIFACT"]
appdir = os.environ["APPDIR"]
g = rdflib.Graph()
g.parse(os.path.join(appdir, "university_graph.ttl"), format="turtle")
try:
    res = g.query(open(artifact).read())
except Exception as e:
    print(f"relation mr-shape violated: query does not parse/execute: {e}")
    sys.exit(1)
vars_ = sorted(str(v) for v in res.vars)
if vars_ != ["countries", "professorName"]:
    print(f"relation mr-shape violated: result variables {vars_} != ['countries', 'professorName'] (instruction-stated SELECT shape)")
    sys.exit(1)
