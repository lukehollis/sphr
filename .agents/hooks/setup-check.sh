#!/bin/bash
# Runs at session start. Stdout is injected into Claude's context.

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")/../.."

echo "SPHR Next project: $(pwd)"

if [ ! -f package.json ]; then
  echo "⚠️  package.json not found. Run SPHR workflows from sphr-next."
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "⚠️  node_modules missing. Run npm install before dev/build verification."
fi

if [ -f public/demo/garden_demo.spark.splat ]; then
  BYTES=$(wc -c < public/demo/garden_demo.spark.splat | tr -d ' ')
  echo "Default Spark splat: public/demo/garden_demo.spark.splat (${BYTES} bytes)"
else
  echo "⚠️  Default Spark splat missing: public/demo/garden_demo.spark.splat"
fi

if [ -f public/demo/garden_scene_splats_tour.jpg ]; then
  echo "Default loading image present: public/demo/garden_scene_splats_tour.jpg"
fi

if [ -f lib/data/garden-tour.json ]; then
  echo "Garden tour data present: lib/data/garden-tour.json"
fi

if [ -d public/datasets/matterport ]; then
  MATTERPORT=$(find public/datasets/matterport -maxdepth 2 -name manifest.json 2>/dev/null | sort | tr '\n' ' ')
  [ -n "$MATTERPORT" ] && echo "Matterport packages: $MATTERPORT"
fi

if [ -f ../data/pipelines/requirements-matterport.txt ]; then
  MATTERPORT_PY="${SPHR_MATTERPORT_PYTHON:-}"
  if [ -z "$MATTERPORT_PY" ] && [ -x ../.venv-matterport/bin/python ]; then
    MATTERPORT_PY="../.venv-matterport/bin/python"
  fi
  MATTERPORT_PY="${MATTERPORT_PY:-python3}"
  if ! "$MATTERPORT_PY" - <<'PY' >/dev/null 2>&1
import numpy, pye57, open3d, trimesh
PY
  then
    echo "Matterport converter Python deps missing for ${MATTERPORT_PY}. Install ../data/pipelines/requirements-matterport.txt or set SPHR_MATTERPORT_PYTHON."
  else
    echo "Matterport converter Python deps available via ${MATTERPORT_PY}."
  fi
fi

if lsof -i :3000 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Dev server appears to be listening on http://localhost:3000"
else
  echo "No dev server detected on port 3000. Start with npm run dev -- --port 3000 when browser verification is needed."
fi

echo "Django is optional for data/admin. Next.js renders SPHR scenes directly."

if [ -d input ]; then
  FILES=$(find input -maxdepth 2 -type f ! -name '.DS_Store' 2>/dev/null | sort | tr '\n' ' ')
  [ -n "$FILES" ] && echo "Staged in input/: $FILES"
fi

exit 0
