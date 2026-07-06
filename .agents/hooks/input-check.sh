#!/bin/bash
# Injects staged SPHR inputs and likely scene files before every prompt.

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")/../.."

if [ -d input ]; then
  FILES=$(find input -maxdepth 2 -type f ! -name '.DS_Store' 2>/dev/null | sort | tr '\n' ' ')
  [ -n "$FILES" ] && echo "Staged in input/: $FILES"
fi

if [ -d configs ]; then
  CONFIGS=$(find configs -maxdepth 2 -type f \( -name '*.json' -o -name '*.jsonc' \) 2>/dev/null | sort | tr '\n' ' ')
  [ -n "$CONFIGS" ] && echo "SPHR config files: $CONFIGS"
fi

if [ -d public/datasets/matterport ]; then
  MATTERPORT=$(find public/datasets/matterport -maxdepth 2 -name manifest.json 2>/dev/null | sort | tr '\n' ' ')
  [ -n "$MATTERPORT" ] && echo "Matterport packages: $MATTERPORT"
fi

if [ -d ../data ]; then
  E57S=$(find ../data -maxdepth 4 -type f \( -name '*.e57' -o -name '*e57*.zip' \) 2>/dev/null | sort | tr '\n' ' ')
  [ -n "$E57S" ] && echo "Matterport/E57 source candidates: $E57S"
fi

exit 0
