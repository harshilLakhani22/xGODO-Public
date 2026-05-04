#!/bin/bash
set -e
JOBFILE=scripts/demo-job.json

echo "Running demo job from: $JOBFILE"
# Adjust the runner command to match your project
node dist/main.js --job "$JOBFILE"
