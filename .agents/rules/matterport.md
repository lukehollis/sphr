# SPHR Matterport Imports

- Keep Matterport exports as data packages under `public/datasets/matterport/<slug>`.
- Keep raw E57/zips and processing scratch files outside `sphr-next/public`, normally in `../data` or `data/processed`.
- Use `../data/pipelines/matterport_e57_to_sphr.py` through `.claude/scripts/matterport/e57-to-sphr.mjs`; do not create one-off conversion scripts in the Next app.
- Install converter dependencies from `../data/pipelines/requirements-matterport.txt` in an isolated Python environment, or set `SPHR_MATTERPORT_PYTHON` to an environment that imports `numpy`, `pye57`, `open3d`, and `trimesh`.
- Each Matterport package must include `bootstrap.json`, `manifest.json`, six cube faces per scan node, and a reduced GLB mesh near 50k triangles.
- `manifest.json` must record `imageManifest.faceTransforms`; Matterport skybox face `0` rotates 90 degrees counter-clockwise into SPHR top face `0`, and skybox face `5` rotates 270 degrees counter-clockwise into SPHR bottom face `5`.
- `bootstrap.json` must remain compatible with the generic `spaces` panorama runtime and `sceneGraph` model loader.
- Node rotations must target the production SPHR EnvCube convention: runtime applies `(x, -y, z)` plus a fixed 180 degree Z cube basis.
- Matterport validation must include cube pole seam checks, not just screenshots, so rotated top/bottom faces fail automatically.
- Matterport work is complete only after package validation plus browser verification of Start, tour navigation, and visible in-scene marker navigation when a marker is available.
