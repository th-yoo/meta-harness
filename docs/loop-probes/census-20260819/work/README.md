# Staged inputs (gitignored)

Reconstruct from the sibling TB2 checkout (~/z2/terminal-bench-2):
- gcode/:  cp instruction.md; gunzip text.gcode.gz -> text.gcode
- extract-elf/: cp instruction.md; gcc task-deps/hi.c -o a.out
- feal/:  cp instruction.md, feal.py

Not tracked: benchmark environment data (canary GUIDs), large + reproducible.
Audit outputs (../out-*.json) already quote all evidence used in verdict.md.
