import * as THREE from "three";
import type { TilesRenderer } from "3d-tiles-renderer/three";
import type { EarthPlace } from "@/lib/experience/types";
import { earthYaw } from "@/lib/three/earth";

/** Where the site's key for Google's map tiles comes from. */
const KEY_URL = "/api/earth";
const GOOGLE_LOGO = "https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png";

/**
 * Google's photorealistic 3D map under and around a space. The map is placed
 * so the place's latitude and longitude sit on its anchor location and north
 * falls where the place's heading says, then raised or lowered so the map's
 * ground meets the floor where the visitor takes off and lands. It loads only
 * when a tour has a stop above the map, and fades in and out with the flights.
 */
export class EarthLayer {
  /** Puts the map at the anchor location and turns it to the place's heading. */
  readonly group = new THREE.Group();
  /** Raises or lowers the map so its ground meets the floor. */
  private readonly lift = new THREE.Group();
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  /** The capture's locations as dots over the map, to see where the tour goes and to line the map up. */
  private readonly path: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private tiles: TilesRenderer | null = null;
  private reorient: { transformLatLonHeightToOrigin(lat: number, lon: number, height?: number): void } | null = null;
  private loading: Promise<boolean> | null = null;
  private readonly materials = new Set<THREE.Material>();
  private readonly preloadCamera = new THREE.PerspectiveCamera(50, 1, 1, 40000);
  private preloading = false;
  /** How much of the map the tour asks for. */
  private target = 0;
  /** How much shows: nothing until its ground is matched to the floor. */
  private shown = -1;
  private place: EarthPlace;
  private readonly focus = new THREE.Vector3();
  /** The map's ground has been matched to the floor at least once for this place. */
  private grounded = false;
  /** Match it again: the focus or the place changed. */
  private stale = false;
  private lastGroundCheck = 0;
  private disposed = false;
  private failed = false;

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: THREE.WebGLRenderer, place: EarthPlace, anchor: THREE.Vector3) {
    this.place = place;
    this.group.name = "earth";
    this.group.visible = false;
    this.group.add(this.lift);
    this.sky = createSky();
    this.path = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      color: 0xffc94a, size: 6, sizeAttenuation: false, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false
    }));
    this.path.name = "earth-path";
    this.path.renderOrder = 20;
    this.path.frustumCulled = false;
    this.path.visible = false;
    this.scene.add(this.group, this.sky, this.path);
    this.setPlace(place, anchor);
  }

  get ready() { return Boolean(this.tiles) && !this.failed; }
  get visible() { return this.target > 0.001; }
  get opacity() { return this.target; }

  /** Put the map back where the builder or the tour says the space is. */
  setPlace(place: EarthPlace, anchor: THREE.Vector3) {
    const same = JSON.stringify(place) === JSON.stringify(this.place) && anchor.distanceToSquared(this.group.position) < 1e-6;
    if (same && this.tiles) return;
    const moved = place.lat !== this.place.lat || place.lon !== this.place.lon;
    this.place = place;
    const scale = place.scale ?? 1;
    this.group.position.copy(anchor);
    this.group.rotation.set(0, earthYaw(place), 0);
    this.group.scale.setScalar(scale);
    this.group.updateMatrixWorld(true);
    if (moved && this.tiles?.root) this.reorient?.transformLatLonHeightToOrigin(THREE.MathUtils.degToRad(place.lat), THREE.MathUtils.degToRad(place.lon), 0);
    if (moved) this.grounded = false;
    this.stale = true;
    this.show();
  }

  /** The capture's locations, in the space's coordinates. */
  setPath(points: THREE.Vector3[]) {
    this.path.geometry.setFromPoints(points.map((point) => point.clone().add(new THREE.Vector3(0, 0.5, 0))));
    this.path.geometry.computeBoundingSphere();
  }

  /** The floor point where the visitor takes off or lands; the map's ground is matched to it while hidden. */
  setFocus(point: THREE.Vector3) {
    if (this.focus.distanceToSquared(point) > 0.01) this.stale = true;
    this.focus.copy(point);
  }

  /** Start fetching the map, once. Resolves false when the site has no key or the map cannot load. */
  load(): Promise<boolean> {
    this.loading ??= this.create().catch((error) => {
      console.warn("The 3D map could not load.", error);
      this.failed = true;
      return false;
    });
    return this.loading;
  }

  /** Fetch the map as seen from a pose the tour is about to fly to. */
  preload(pose: { position: THREE.Vector3; target: THREE.Vector3; fov: number } | null) {
    this.preloading = Boolean(pose);
    if (!pose) {
      this.tiles?.deleteCamera(this.preloadCamera);
      return;
    }
    this.preloadCamera.position.copy(pose.position);
    this.preloadCamera.fov = pose.fov;
    this.preloadCamera.aspect = this.camera.aspect;
    this.preloadCamera.lookAt(pose.target);
    this.preloadCamera.updateProjectionMatrix();
    this.preloadCamera.updateMatrixWorld(true);
    if (this.tiles && !this.tiles.hasCamera(this.preloadCamera)) {
      this.tiles.setCamera(this.preloadCamera);
      this.tiles.setResolutionFromRenderer(this.preloadCamera, this.renderer);
    }
  }

  setOpacity(value: number) {
    this.target = THREE.MathUtils.clamp(value, 0, 1);
    this.sky.visible = this.visible;
    this.sky.material.uniforms.opacity.value = this.target;
    // The dots come in only once the camera is well above the ground.
    this.path.material.opacity = THREE.MathUtils.smoothstep(this.target, 0.6, 1) * 0.95;
    this.path.visible = this.path.material.opacity > 0.01;
    this.show();
  }

  private show() {
    const shown = this.grounded ? this.target : 0;
    if (Math.abs(shown - this.shown) < 1e-4) return;
    this.shown = shown;
    this.group.visible = shown > 0.001;
    for (const material of this.materials) this.applyOpacity(material);
  }

  update() {
    const tiles = this.tiles;
    if (!tiles || this.disposed) return;
    this.sky.position.copy(this.camera.position);
    if (!this.visible && !this.preloading) return;
    this.camera.updateMatrixWorld();
    tiles.setResolutionFromRenderer(this.camera, this.renderer);
    if (this.preloading) tiles.setResolutionFromRenderer(this.preloadCamera, this.renderer);
    tiles.update();
    // Refine the ground while the map is hidden or still faint, so it never jumps in view.
    const now = performance.now();
    if ((!this.grounded || this.stale || !this.visible) && now - this.lastGroundCheck > 400) {
      this.lastGroundCheck = now;
      this.matchGround();
    }
  }

  /** The data providers Google asks to credit while the map is in view. */
  credits() {
    if (!this.tiles || !this.visible) return "";
    const lines = this.tiles.getAttributions().filter((item) => item.type === "string").map((item) => String(item.value)).filter(Boolean);
    return lines.join("; ");
  }

  static logo() { return GOOGLE_LOGO; }

  dispose() {
    this.disposed = true;
    this.tiles?.dispose();
    this.tiles = null;
    this.materials.clear();
    this.scene.remove(this.group, this.sky, this.path);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.path.geometry.dispose();
    this.path.material.dispose();
  }

  private async create() {
    const response = await fetch(KEY_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) return false;
    const { key } = await response.json() as { key?: string };
    if (!key || this.disposed) return false;
    const [{ TilesRenderer }, { GoogleCloudAuthPlugin, ReorientationPlugin, TilesFadePlugin, UnloadTilesPlugin, GLTFExtensionsPlugin }, { DRACOLoader }] = await Promise.all([
      import("3d-tiles-renderer/three"),
      import("3d-tiles-renderer/plugins"),
      import("three/examples/jsm/loaders/DRACOLoader.js")
    ]);
    if (this.disposed) return false;
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    const reorient = new ReorientationPlugin({ lat: THREE.MathUtils.degToRad(this.place.lat), lon: THREE.MathUtils.degToRad(this.place.lon), height: 0, recenter: true });
    tiles.registerPlugin(reorient);
    this.reorient = reorient;
    tiles.registerPlugin(new TilesFadePlugin());
    tiles.registerPlugin(new UnloadTilesPlugin());
    tiles.addEventListener("load-model", ({ scene }) => {
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          // The photographs are already in display colors; the viewer's exposure would wash them out.
          material.toneMapped = false;
          this.materials.add(material);
          this.applyOpacity(material);
        }
      });
    });
    tiles.addEventListener("dispose-model", ({ scene }) => {
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.materials.delete(material);
      });
    });
    tiles.setCamera(this.camera);
    tiles.setResolutionFromRenderer(this.camera, this.renderer);
    if (this.preloading) {
      tiles.setCamera(this.preloadCamera);
      tiles.setResolutionFromRenderer(this.preloadCamera, this.renderer);
    }
    this.lift.add(tiles.group);
    this.tiles = tiles;
    return true;
  }

  private applyOpacity(material: THREE.Material) {
    const opacity = Math.max(0, this.shown);
    const transparent = opacity < 0.999;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
    material.opacity = opacity;
  }

  /** Raise or lower the map so its surface under the focus meets the floor there. */
  private matchGround() {
    const tiles = this.tiles;
    if (!tiles) return;
    this.group.updateMatrixWorld(true);
    const scale = this.place.scale ?? 1;
    const ray = new THREE.Raycaster(this.focus.clone().add(new THREE.Vector3(0, 12000 * scale, 0)), new THREE.Vector3(0, -1, 0), 0, 30000 * scale);
    const hit = ray.intersectObject(tiles.group, true)[0];
    if (!hit) return;
    // Heights in the map's own meters: its surface under the focus, and the floor there.
    const ground = this.lift.worldToLocal(hit.point.clone()).y;
    const floor = this.group.worldToLocal(this.focus.clone()).y;
    this.lift.position.y = floor - ground + (this.place.elevation ?? 0);
    this.lift.updateMatrixWorld(true);
    this.grounded = true;
    this.stale = false;
    this.show();
  }
}

/** A plain sky behind the map: pale at the horizon, deeper overhead. */
function createSky() {
  const material = new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0 } },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float opacity;
      varying vec3 vDirection;
      void main() {
        float up = clamp(vDirection.y, -0.2, 1.0);
        vec3 horizon = vec3(0.80, 0.86, 0.92);
        vec3 zenith = vec3(0.33, 0.52, 0.78);
        vec3 color = mix(horizon, zenith, smoothstep(0.0, 0.6, up));
        gl_FragColor = vec4(color, opacity);
      }`,
    side: THREE.BackSide,
    // Drawn after the opaque map, so it fills only where no ground is in front.
    depthWrite: false,
    transparent: true,
    toneMapped: false
  });
  // Inside the camera's far plane, past anything the map shows clearly.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(18000, 32, 16), material);
  sky.name = "earth-sky";
  // Behind the photograph as it fades, so the sky never washes over it.
  sky.renderOrder = -30;
  sky.frustumCulled = false;
  sky.visible = false;
  return sky;
}
