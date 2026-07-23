#!/bin/sh
# Scorer for hello-fs. Runs INSIDE the container, copied in only AFTER the
# agent's attempt (invariant 1: Scorer -> Agent = empty set at runtime).
[ "$(cat /app/greeting.txt 2>/dev/null)" = "hello kernel" ]
