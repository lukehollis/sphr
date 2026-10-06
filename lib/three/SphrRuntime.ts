import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { activeTourPoint, normalizeTour } from "@/lib/bootstrap";
import type {
  CameraRotation,
  IiifConfig,
  LoadingState,
  NodeData,
  RuntimeCallbacks,
  RuntimeState,
  SceneGraphNode,
  SphrBootstrap,
  SplatConfig,
  TourPoint
} from "@/lib/types";
import { TextureCache } from "@/lib/three/TextureCache";
import { prefersLight } from "@/lib/three/light";
import { ktx2Loader } from "@/lib/three/ktx2";
import { AudioController } from "@/lib/three/AudioController";
import { AnnotationLayer } from "@/lib/three/layers/AnnotationLayer";
import { CursorLayer } from "@/lib/three/layers/CursorLayer";
import { NavigationLayer } from "@/lib/three/layers/NavigationLayer";
import { SceneGraphLayer } from "@/lib/three/layers/SceneGraphLayer";
import { ObjectLayer } from "@/lib/three/layers/ObjectLayer";
import { EffectsLayer } from "@/lib/three/layers/EffectsLayer";
import { ExperienceAudio } from "@/lib/experience/audio";
import { answersCue } from "@/lib/experience/registry";
import { SkyboxLayer } from "@/lib/three/layers/SkyboxLayer";
import { TourSkyLayer } from "@/lib/three/layers/TourSkyLayer";
import { EarthLayer } from "@/lib/three/layers/EarthLayer";
import { ReconstructionLayer } from "@/lib/three/layers/ReconstructionLayer";
import { earthNear, earthPose } from "@/lib/three/earth";
import { IiifImageLayer } from "@/lib/three/renderers/IiifImageLayer";
import { LookPass, lookKey, type LookHost } from "@/lib/three/looks/LookPass";
import { PanoramaLayer, panoramaPixelDirection } from "@/lib/three/renderers/PanoramaLayer";
import { SparkSplatLayer } from "@/lib/three/renderers/SparkSplatLayer";
import { freeMoveDirection, selectDirectionalTarget, selectNavigationTarget, selectSpotTarget, standingSpot } from "@/lib/three/navigation";
import { panoramaOverviewBounds } from "@/lib/three/overview";
import { cameraDirection, vectorFromLike } from "@/lib/three/math";
import { createTween, type Tween } from "@/lib/three/tween";
import type { StartView } from '@/lib/scene-edits';
import type { EarthPlace, EffectInstance, ExperienceKind, PlacedObject, StopLook, StopSky, StopView, Vec3 } from "@/lib/experience/types";

export type GizmoMode = "translate" | "rotate" | "scale";
/** A pixel in a panorama face (agents) or in the current view (editor), as 0..1 fractions from the top left. */
export type PixelAnchor = { nodeId?: string; face?: number; x: number; y: number; camera?: ViewCamera };
/** A camera pose remembered with a captured view, so later placements aim from where it was taken. */
export type ViewCamera = { position: Vec3; quaternion: [number, number, number, number]; fov: number; aspect: number };
/** Live edits from the builder. A `standalone` tour's points replace the stops even when there are none. */
export type ExperienceUpdate = { kind: ExperienceKind; objects: PlacedObject[]; effects: EffectInstance[]; points: TourPoint[]; finale?: string; look?: StopLook; sky?: StopSky; place?: EarthPlace; standalone?: boolean };

type CameraPose = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
};

type ViewMode = "FPV" | "ORBIT";
/** A spot on the splats under the pointer, with the slope found around it and the ray that found it. */
type SplatSurface = { point: THREE.Vector3; normal: THREE.Vector3; direction: THREE.Vector3; distance: number };
/** How the reconstruction shows: the model, the sky behind it, the photographs it hides and the capture it replaces. */
type ReconstructionDisplay = { model: number; sky: number; veil: number; capture: number };

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const NEAR = 0.02;
// Flights up to the map and back down take longer than a step between panoramas.
const EARTH_CLIMB_MS = 4200;
const EARTH_DIVE_MS = 3800;
const EARTH_GLIDE_MS = 3000;
// The reconstruction fades in or out when the visitor turns it on or off.
const RECONSTRUCTION_FADE_MS = 700;
// It loads this long after the space opens, so the dollhouse already has it.
const RECONSTRUCTION_DELAY_MS = 1500;
// With a model in view, the near plane moves out a little for depth precision kilometers away.
const RECONSTRUCTION_NEAR = 0.1;
const KEY_TURN_SPEED = THREE.MathUtils.degToRad(100); // per second while an arrow key is held
// Spaces without panorama locations: held keys move the camera, [forward, right, up].
const MOVE_KEYS: Record<string, [number, number, number]> = {
  w: [1, 0, 0], ArrowUp: [1, 0, 0], s: [-1, 0, 0], ArrowDown: [-1, 0, 0],
  a: [0, -1, 0], d: [0, 1, 0], e: [0, 0, 1], q: [0, 0, -1]
};
// Walking speed in eye heights a second; Shift runs. A click walks at most WALK_REACH eye heights.
const WALK_REACH = 8;
const WALK_SPEED = 1.6;
const RUN_FACTOR = 3;
const DOWN = new THREE.Vector3(0, -1, 0);

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.isContentEditable || element?.closest?.("input, textarea, select, [contenteditable]"));
}

/** A panorama and direction a link opens a space at. */
export type EntryView = { nodeId: string; rotation: CameraRotation; fov?: number };

export class SphrRuntime {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(80, 1, NEAR, 20000);
  readonly renderer: THREE.WebGLRenderer;

  private readonly tour;
  private readonly manager = new THREE.LoadingManager();
  private readonly textureCache: TextureCache;
  /** A phone, or a browser saving data: mid-size faces, the lighter capture model, fewer textures kept. */
  private readonly light = prefersLight();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerDown = new THREE.Vector2();
  private activePointerId: number | null = null;
  private pointerMoved = false;
  // Held arrow/A/D keys turn the view: +1 left, -1 right.
  private readonly turnKeys = new Map<string, number>();
  // Spaces without panorama locations: held keys walk the camera, easing in and out.
  private readonly moveKeys = new Map<string, [number, number, number]>();
  private readonly moveVelocity = new THREE.Vector3();
  private running = false;
  /** How high the view stands over the ground, the measure for walking a splat space. */
  private eye: number | null = null;
  /** The ground under the camera when last sampled, so walking follows the slope. */
  private walkGround: number | null = null;
  private lastGroundSample = 0;
  private walkLift = 0;
  /** The first-person view left for the dollhouse, to come back to. */
  private freeView: CameraPose | null = null;
  private readonly surfaceRaycaster = new THREE.Raycaster();
  /** The latest pointer over a splat space, hit-tested once a frame. */
  private splatHover: THREE.Vector2 | null = null;
  private lastFrameTime = 0;
  private controls: OrbitControls;
  private audio: AudioController;
  private splats: SparkSplatLayer | null = null;
  private panorama: PanoramaLayer | null = null;
  // Optional only for tests that build a runtime without its constructor.
  private readonly looks?: LookPass;
  private lookStarted = false;
  private iiif: IiifImageLayer | null = null;
  private nav: NavigationLayer | null = null;
  private skybox: SkyboxLayer | null = null;
  private tourSky: TourSkyLayer | null = null;
  private skyStarted = false;
  private legacySkyHidden = false;
  private readonly ambientLight = new THREE.AmbientLight(0xf3efe6, 1.7);
  private readonly sunLight = new THREE.DirectionalLight(0xfff2cf, 3.2);
  private earth: EarthLayer | null = null;
  private lastEarthCredits = 0;
  private reconstruction: ReconstructionLayer | null = null;
  /** The reconstruction shows in the dollhouse unless turned off, and in first person when turned on. */
  private reconOrbit = true;
  private reconFpv = false;
  /** How far the reconstruction has come in for the current view mode, 0 to 1. */
  private reconAmount = 0;
  private reconTween: Tween | null = null;
  private reconTimer: ReturnType<typeof setTimeout> | null = null;
  private sceneGraph: SceneGraphLayer | null = null;
  private cursor: CursorLayer | null = null;
  private annotations: AnnotationLayer | null = null;
  private tweens: Tween[] = [];
  private cameraTween: Tween | null = null;
  private transitionMeshTween: Tween | null = null;
  private navigationReleaseTween: Tween | null = null;
  private animationStarted = false;
  private objects: ObjectLayer | null = null;
  private effects: EffectsLayer | null = null;
  private gizmo: TransformControls | null = null;
  private gizmoDragging = false;
  private editing = false;
  private selectedObject: string | null = null;
  private readonly huntFound = new Set<string>();
  private hintShown = false;
  private hoverObjectId: string | null = null;
  private lastSurfaceHover = 0;
  private tooltip: HTMLDivElement | null = null;
  private spaceBounds: THREE.Box3 | null = null;
  private experienceAudio: ExperienceAudio | null = null;
  private currentNode: NodeData | null = null;
  /** Lets placed objects' models start downloading (they wait behind a deferred capture mesh). */
  private releaseObjects?: () => void;
  private cubeRenderTarget: THREE.WebGLCubeRenderTarget | null = null;
  private cubeCamera: THREE.CubeCamera | null = null;
  private cubeScene: THREE.Scene | null = null;
  private isNavigating = false;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private readonly state: RuntimeState;
  private atmosphereExposure = 1.15;
  /** Stable callback; a look can render the same atmosphere into its own frame. */
  private readonly renderScene = () => {
    const amount = this.reconstruction?.environmentOpacity ?? 0;
    this.ambientLight.intensity = 1.7 * (1 - amount);
    this.sunLight.intensity = 3.2 * (1 - amount);
    this.renderer.toneMapping = amount > 0.001 ? THREE.ACESFilmicToneMapping : THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(this.atmosphereExposure, 1, amount);
    if (!this.reconstruction?.render(this.renderer, this.camera)) this.renderer.render(this.scene, this.camera);
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bootstrap: SphrBootstrap,
    private readonly callbacks: RuntimeCallbacks = {}
  ) {
    this.tour = normalizeTour(bootstrap);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
      stencil: false
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setClearColor(0x0a0c10, 0);
    this.textureCache = new TextureCache(this.manager, (this.light ? 64 : 320) * 1024 * 1024, !this.light);
    this.looks = new LookPass(this.renderer, this.lookHost(), typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.audio = new AudioController(this.tour.audio);

    this.state = {
      loading: {
        label: "Initializing",
        progress: 0,
        ready: false
      },
      activeSpaceIndex: 0,
      activePointIndex: 0,
      viewMode: "FPV",
      guided: this.tour.hasGuidedTour,
      muted: false,
      showText: this.tour.defaultShowText,
      debug: false,
      navigating: false
    };
  }

  /** The spot a shared link opened at, used once while the camera first settles. */
  private entryPoint?: TourPoint;

  /**
   * @param initialPointIndex the tour stop to open at
   * @param startView a panorama and direction to open at instead, as a shared link asks (see ViewerEntry)
   */
  async init(initialPointIndex?: number, startView?: EntryView) {
    this.setupRendererSize();
    this.setupScene();
    this.setupControls();
    this.setupNavigationTransitionRenderTarget();
    this.setupLoadingEvents();
    this.attachEvents();

    const nodes = this.getNodes();
    const exploreEntry = !this.tour.hasGuidedTour && !this.bootstrap.space.space_data.noPanos ? this.resolveInitialNode() : null;
    const initialLocation = (initialPointIndex === undefined ? null : { spaceIndex: 0, pointIndex: initialPointIndex })
      || (exploreEntry && this.findTourPointForNode(exploreEntry.uuid))
      || { spaceIndex: 0, pointIndex: 0 };
    this.state.activeSpaceIndex = initialLocation.spaceIndex;
    this.state.activePointIndex = initialLocation.pointIndex;
    const entryNode = startView ? this.resolveNode(startView.nodeId) : null;
    if (entryNode) {
      const point = this.findTourPointForNode(entryNode.uuid);
      if (point) { this.state.activeSpaceIndex = point.spaceIndex; this.state.activePointIndex = point.pointIndex; }
    }
    const tourPoint = activeTourPoint(this.tour, this.state.activeSpaceIndex, this.state.activePointIndex);
    // A link to a spot opens there, looking where it says; the tour's own stops are left as they are.
    const initialPoint = entryNode && startView
      ? { ...tourPoint, nodeUUID: entryNode.uuid, rotation: startView.rotation, fov: startView.fov ?? tourPoint?.fov, targetType: 'NODE', viewMode: 'FPV' } as typeof tourPoint
      : tourPoint;
    this.currentNode = this.resolveNode(initialPoint?.nodeUUID) ?? this.resolveInitialNode();
    // Spaces without panoramas (splats, point clouds, models) may open orbiting their subject.
    if (this.bootstrap.space.space_data.noPanos && initialPoint?.viewMode === "ORBIT") {
      this.state.viewMode = "ORBIT";
      this.updateControlsForViewMode();
    }
    this.setCameraPose(this.poseForPoint(initialPoint, this.state.viewMode), true);

    if (nodes.length) {
      this.nav = new NavigationLayer(this.scene, this.bootstrap.space.space_data, nodes);
      this.nav.init();
      this.nav.setActive(this.currentNode?.uuid);
    }

    if (!this.bootstrap.space.space_data.noPanos && nodes.length) {
      this.panorama = new PanoramaLayer(this.scene, this.textureCache, this.bootstrap.space.version, this.bootstrap.space.space_data.light?.faces, this.light);
      this.panorama.setVariantSource(this.bootstrap.space.space_data.variants);

    }

    if (this.bootstrap.space.space_data.skybox) {
      this.skybox = new SkyboxLayer(this.scene, this.manager, this.bootstrap.space.space_data.skybox);
    }
    this.tourSky = new TourSkyLayer(this.scene, this.renderer.capabilities.maxTextureSize);

    const reconstruction = this.bootstrap.space.space_data.reconstruction;
    if (reconstruction && (typeof reconstruction === "string" || typeof reconstruction === "object")) {
      this.reconstruction = new ReconstructionLayer(this.scene, reconstruction, this.light ? this.bootstrap.space.space_data.light?.models : undefined, ktx2Loader(this.renderer));
    }

    const splatConfigs = this.getSplatConfigs();
    if (splatConfigs.length) {
      this.splats = new SparkSplatLayer(this.scene, this.renderer, splatConfigs, (loaded, total, label) => {
        const progress = total ? loaded / total : 0.2;
        this.setLoading({ ...this.state.loading, label: `Loading ${label}`, progress: Math.max(this.state.loading.progress, progress), ready: this.state.loading.ready });
      });
    }

    const iiifConfigs = this.getIiifConfigs();
    if (iiifConfigs.length) {
      this.iiif = new IiifImageLayer(this.scene, this.textureCache, iiifConfigs);
    }

    this.sceneGraph = new SceneGraphLayer(this.scene, this.tour.sceneGraph, this.light ? this.bootstrap.space.space_data.light?.models : undefined, ktx2Loader(this.renderer));
    this.cursor = new CursorLayer();
    this.annotations = new AnnotationLayer(this.scene, this.textureCache, this.tour.annotationGraph);

    // A tour opening in a panorama shows it before the capture mesh arrives: the mesh is unseen
    // there (it catches clicks, carries the move between locations and hides placed objects
    // behind walls), so it loads right after. Hunts and the editor wait for it, since what is
    // hidden behind a wall matters to them from the start.
    const deferCapture = !this.editing && this.tour.kind !== "hunt" && !this.bootstrap.space.space_data.noPanos
      && Boolean(this.panorama) && initialPoint?.viewMode !== "ORBIT";
    // So do models only a later stop shows (an authored site model can be 20 MB): out of sight until then.
    const firstModels = new Set(this.stopModels(initialPoint));
    const shownFirst = (node: SceneGraphNode): boolean => firstModels.has(node.id) || (node.children ?? []).some(shownFirst);
    const later = (node: SceneGraphNode) => deferCapture && node.type === "model" && (node.raycast
      ? (node.fpvOpacity ?? 1) === 0
      : !node.persistent && !shownFirst(node));

    // Placed objects stay out of sight until the capture mesh arrives, so their models wait for it too.
    const objectsAfter = deferCapture ? new Promise<void>((resolve) => { this.releaseObjects = resolve; }) : undefined;

    await Promise.all([
      this.panorama?.loadInitial(this.currentNode),
      this.skybox?.init(),
      this.splats?.init(),
      this.iiif?.init(),
      this.sceneGraph.init(later),
      this.setupExperience(objectsAfter)
    ]);
    if (this.disposed) { this.sceneGraph.dispose(); return; }
    this.annotations.init();
    this.nav?.setOccluders(this.sceneGraph.getRaycastObjects());
    // Until the capture mesh can hide them behind walls, placed objects wait out of sight.
    if (this.sceneGraph.complete === false && this.objects) this.objects.root.visible = false;

    // A link's spot stands in for the stop at that location while the camera settles there.
    this.entryPoint = entryNode ? initialPoint : undefined;
    if (entryNode) await this.goTo(this.state.activeSpaceIndex, this.state.activePointIndex, true);
    else await this.goTo(initialLocation.spaceIndex, initialLocation.pointIndex, true);
    this.entryPoint = undefined;
    this.setLoading({ label: "Ready", progress: 1, ready: true });
    this.emitState();
    this.startAnimationLoop();
    // Splat spaces bucket their splats once open, for the cursor's slope and the ground underfoot.
    if (this.walksOnSplats()) void this.splats?.prepareSurface();
    void this.afterFirstView();
  }

  /**
   * What the first view did not need follows once the view in front of the visitor has
   * sharpened (or a few seconds pass), so it does not slow the faces down: the capture mesh
   * left out of it, then the reconstruction, for the dollhouse and the stops that show it.
   */
  private async afterFirstView() {
    await Promise.race([this.panorama?.whenSharp(), new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (this.disposed) return;
    if (this.reconstruction && !this.reconstruction.busy && !this.reconstruction.ready) {
      this.reconTimer = setTimeout(() => void this.loadReconstruction(), RECONSTRUCTION_DELAY_MS);
    }
    await this.captureLoaded();
  }

  /** The whole capture, for views that show it (the overview, a stop that looks down on it) and once the first view is in. */
  private async captureLoaded() {
    this.releaseObjects?.();
    const graph = this.sceneGraph;
    // Starts whatever was left for later; models only later stops show follow the capture.
    const capture = graph?.loadDeferred?.();
    if (!graph || graph.complete !== false) return;
    await capture;
    if (this.disposed || this.sceneGraph !== graph) return;
    this.nav?.setOccluders(graph.getRaycastObjects());
    if (this.objects) this.objects.root.visible = true;
    this.emitState();
  }

  start(guided: boolean) {
    guided = guided && this.tour.hasGuidedTour;
    this.state.guided = guided;
    this.state.showText = guided ? this.tour.defaultShowText : false;
    const point = this.getActivePoint();
    if (guided) {
      this.audio.updateForPoint(point);
      this.annotations?.show(point.annotations ?? point.overlays ?? []);
      this.sceneGraph?.showOnly(this.stopModels(point));
    }
    if (!guided) {
      this.audio.updateForPoint();
      this.annotations?.hideAll();
      this.sceneGraph?.hideAll();
    }
    this.applyExperienceForPoint(point);
    // A guided tour shows the reconstruction only at the stops that ask for it;
    // free exploration goes back to the usual: in the dollhouse, not in panoramas.
    if (this.reconstruction) {
      if (guided) { this.reconstruction.setVariant(point?.reconstructionVariant); this.setReconWanted(this.state.viewMode, point?.reconstruction === true); }
      else { this.reconOrbit = true; this.reconFpv = false; if (this.state.viewMode === "ORBIT") void this.loadReconstruction(); }
      if (!this.isNavigating) this.settleReconstruction();
    }
    this.emitState();
  }

  next() {
    if (!this.tour.hasGuidedTour) return;
    const space = this.tour.spaces[this.state.activeSpaceIndex];
    const isLastPoint = this.state.activePointIndex >= space.tourpoints.length - 1;
    const isLastSpace = this.state.activeSpaceIndex >= this.tour.spaces.length - 1;

    if (isLastPoint && isLastSpace) {
      this.start(false);
      return;
    }

    if (isLastPoint) {
      this.goTo(this.state.activeSpaceIndex + 1, 0);
    } else {
      this.goTo(this.state.activeSpaceIndex, this.state.activePointIndex + 1);
    }
  }

  previous() {
    if (!this.tour.hasGuidedTour) return;
    if (this.state.activePointIndex > 0) {
      this.goTo(this.state.activeSpaceIndex, this.state.activePointIndex - 1);
      return;
    }
    if (this.state.activeSpaceIndex > 0) {
      const previousSpace = this.tour.spaces[this.state.activeSpaceIndex - 1];
      this.goTo(this.state.activeSpaceIndex - 1, previousSpace.tourpoints.length - 1);
    }
  }

  async goTo(spaceIndex: number, pointIndex: number, instant = false, preserveHeading = false, forceFirstPerson = false) {
    const outgoingPoint = this.getActivePoint();
    const point = this.entryPoint ?? activeTourPoint(this.tour, spaceIndex, pointIndex);
    if (!point) return;
    if (this.isNavigating && !instant) return;
    this.freeView = null;

    const fromOverview = this.state.viewMode === "ORBIT";
    const outgoingNode = this.currentNode;
    const node = this.resolveNode(point.nodeUUID);
    const nodeChanged = Boolean(node && node.uuid !== outgoingNode?.uuid);
    const heading = this.camera.getWorldDirection(new THREE.Vector3());
    const prepareReconstruction = Boolean(this.tourShowsStops() && point.reconstruction === true && this.reconstruction && !this.reconstruction.ready);
    // A model only this stop shows (left for after the first view) may still be on its way.
    const stopModels = this.stopModels(point);
    const prepareModels = Boolean(this.sceneGraph?.waitsFor?.(stopModels));
    const busy = prepareReconstruction || prepareModels;
    if (nodeChanged || (fromOverview && !instant) || busy) {
      this.isNavigating = true;
      this.state.navigating = true;
      this.controls.enabled = false;
      this.state.navigationError = undefined;
      if (busy) this.state.loading = { ...this.state.loading, busy: true };
      this.emitState();
      // An overview's camera may be kilometers from the capture. Keep the outgoing
      // photograph and caption until the reconstruction can fill that view.
      try {
        await Promise.all([
          nodeChanged ? this.panorama?.prepareQuick(node!, 600, 25000) : undefined,
          prepareReconstruction ? this.loadReconstruction() : undefined,
          point.viewMode === "ORBIT" ? this.captureLoaded() : undefined,
          prepareModels ? this.sceneGraph?.whenLoaded(stopModels) : undefined
        ]);
        if (prepareReconstruction && !this.reconstruction?.ready) throw new Error("Unable to load the reconstruction. Reload to try again.");
      }
      catch (error) {
        if (busy) this.state.loading = { ...this.state.loading, busy: false };
        this.endNavigationTransition();
        this.state.navigationError = error instanceof Error ? error.message : "Unable to load this location";
        this.emitState();
        if (prepareReconstruction && !this.state.loading.ready) throw error;
        return;
      }
      if (this.disposed) return;
      if (busy) this.state.loading = { ...this.state.loading, busy: false };
    }
    const nextViewMode = !forceFirstPerson && point.viewMode === "ORBIT" ? "ORBIT" : "FPV";
    // In a guided tour the reconstruction shows only at stops that ask for it, so the
    // tour's own views (a cutaway of the capture, an authored model) stay as written.
    if (this.tourShowsStops()) { this.reconstruction?.setVariant(point.reconstructionVariant); this.setReconWanted(nextViewMode, point.reconstruction === true); }
    else if (nextViewMode === "ORBIT" && this.reconWanted("ORBIT")) void this.loadReconstruction();

    this.state.activeSpaceIndex = spaceIndex;
    this.state.activePointIndex = pointIndex;
    this.state.viewMode = nextViewMode;
    this.updateControlsForViewMode();
    this.prepareEarth(outgoingNode);
    const earth = this.earth;
    const earthPoint = nextViewMode === "ORBIT" && Boolean(earth?.available && this.earthPlace() && point.earth);
    const climbing = earthPoint && !fromOverview && !instant;
    if (this.isNavigating) this.nav?.beginTransition();
    this.nav?.setOrbit(nextViewMode === "ORBIT");

    this.splats?.setStudyMode(point.extra);
    this.applySkyboxMode(point.extra);
    this.applyAtmosphere(point.extra);
    this.annotations?.show(point.annotations ?? point.overlays ?? []);
    this.sceneGraph?.showOnly(this.stopModels(point));
    this.sceneGraph?.setViewMode(this.state.viewMode, this.state.debug);
    this.hintShown = false;
    this.applyExperienceForPoint(point);

    const returningFromOverview = fromOverview && nextViewMode === "FPV" && !instant;
    // Moves the visitor chose are always in sight; only tour steps between unlinked scans cut.
    const teleport = nodeChanged && !fromOverview && !preserveHeading && Boolean(outgoingNode && this.nav && !this.nav.canFlyTo(node!.uuid));
    const navigationMs = teleport ? 700 : this.bootstrap.space.space_data.navigationTransition?.navigationMs ?? 1100;
    // With the reconstruction in view the camera simply flies there; the photographs load behind it.
    const navigationTransition = nodeChanged && !fromOverview && !teleport && !instant && this.state.viewMode === "FPV" && !this.reconstructionMove()
      ? this.beginNavigationTransition(outgoingNode)
      : null;

    if (node) {
      this.currentNode = node;
      // Climbing, the photograph the visitor stands in stays until it fades; the next one loads on landing.
      if (!climbing) this.panorama?.navigate(node, navigationMs, {
        replaceImmediately: returningFromOverview || instant,
        fadeStart: navigationTransition?.fadeStart
      });
      this.nav?.setActive(node.uuid);
    }

    this.audio.play("navigate");
    this.audio.updateForPoint(this.state.guided ? point : undefined, outgoingPoint);

    // Climbing to the map, the photograph stays and fades as the camera rises out of it.
    this.panorama?.setVisible(this.state.viewMode === "FPV" || climbing);
    const pose = this.poseForPoint(point, this.state.viewMode);
    if (preserveHeading && this.state.viewMode === "FPV") {
      pose.target.copy(pose.position).addScaledVector(heading, 0.1);
      pose.fov = this.camera.fov;
    }
    if (climbing) this.flyToEarth(pose);
    else if (returningFromOverview) this.flyFromOverview(pose);
    else if (earth && !instant && (earthPoint || earth.visible)) this.glideOverEarth(pose, earthPoint);
    else {
      if (instant) earth?.setOpacity(earthPoint ? 1 : 0);
      const reconstruction = this.reconFlight(fromOverview ? "ORBIT" : "FPV", nextViewMode);
      this.flyTo(pose, instant || teleport, reconstruction?.done, reconstruction?.update);
      if (this.isNavigating && !instant) this.scheduleNavigationTransitionEnd(navigationMs);
      else if (this.isNavigating) this.endNavigationTransition();
    }
    if (node) this.prefetchNeighbors(node);
    this.emitState();
  }

  toggleViewMode() {
    if (this.isNavigating) return;
    if (this.state.viewMode === "FPV" && this.sceneGraph?.complete === false) {
      // The overview shows the capture mesh; it is on its way.
      this.isNavigating = true;
      void this.captureLoaded().finally(() => { this.isNavigating = false; if (!this.disposed) this.toggleViewMode(); });
      return;
    }
    const newMode = this.state.viewMode === "FPV" ? "ORBIT" : "FPV";
    // Walking a space freely, the dollhouse returns to where the visitor stood.
    if (newMode === "ORBIT" && this.walksFreely()) this.freeView = { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.nav?.beginTransition();
    this.state.viewMode = newMode;
    this.updateControlsForViewMode();
    const point = this.getActivePoint();
    const pose = newMode === "FPV" && this.freeView ? this.freeView
      : newMode === "ORBIT" && this.freeView && this.walksOnSplats() && point?.viewMode !== "ORBIT" ? this.splatOverview()
      : this.currentNode ? this.poseForNode(this.currentNode, newMode, point) : this.poseForPoint(point, newMode);
    this.walkGround = null;
    this.nav?.setOrbit(newMode === "ORBIT");
    this.panorama?.setVisible(newMode === "FPV");
    this.sceneGraph?.setViewMode(newMode, this.state.debug);
    if (newMode === "FPV") this.flyFromOverview(pose);
    else {
      if (this.reconWanted("ORBIT")) void this.loadReconstruction();
      // The reconstruction takes the capture's place on the way up.
      const reconstruction = this.reconFlight("FPV", "ORBIT");
      this.isNavigating = true;
      this.state.navigating = true;
      this.controls.enabled = false;
      this.flyTo(pose, false, () => { reconstruction?.done(); this.endNavigationTransition(); }, reconstruction?.update);
    }
    this.emitState();
  }

  /** Show the site's reconstruction in place of the capture in the current view, or the capture again. */
  toggleReconstruction() {
    const reconstruction = this.reconstruction;
    if (!reconstruction || reconstruction.failed) return;
    const mode = this.state.viewMode;
    this.setReconWanted(mode, !this.reconWanted(mode));
    // During a flight the new choice takes over when it lands.
    if (!this.isNavigating) this.settleReconstruction();
    this.emitState();
  }

  selectReconstructionVariant(id: string) {
    if (!this.reconstruction?.variants.some((item) => item.id === id)) return;
    this.reconstruction.setVariant(id);
    this.emitState();
  }

  toggleMute() {
    this.state.muted = !this.state.muted;
    this.audio.setMuted(this.state.muted);
    this.experienceAudio?.setMuted(this.state.muted);
    this.annotations?.setMuted(this.state.muted);
    this.emitState();
  }

  toggleText() {
    this.state.showText = !this.state.showText;
    this.emitState();
  }

  toggleDebug() {
    this.state.debug = !this.state.debug;
    this.nav?.setDebug(this.state.debug);
    this.sceneGraph?.setViewMode(this.state.viewMode, this.state.debug);
    this.emitState();
  }

  setFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  }

  getState() {
    return { ...this.state, activeNodeId: this.currentNode?.uuid, loading: { ...this.state.loading }, reconstruction: this.reconstructionState() };
  }

  getDebugSnapshot() {
    return {
      state: this.getState(),
      raycastTargets: this.sceneGraph?.getRaycastObjects().length ?? 0,
      panorama: this.panorama?.getDebugSnapshot(),
      textures: this.textureCache.getStats(),
      navigation: this.nav?.getDebugSnapshot(),
      cursor: this.cursor?.getDebugState() ?? null,
      sceneGraph: this.sceneGraph?.getDebugSnapshot() ?? null,
      navigationTransition: {
        isNavigating: this.isNavigating,
        cubeRenderTargetSize: this.cubeRenderTarget?.width ?? 0,
        hasCubeCamera: Boolean(this.cubeCamera),
        hasCubeScene: Boolean(this.cubeScene)
      },
      skybox: this.skybox?.getDebugSnapshot() ?? null,
      tourSky: this.tourSky?.getDebugSnapshot() ?? null,
      reconstruction: this.reconstruction ? {
        ...this.reconstruction.getDebugSnapshot(),
        wanted: { FPV: this.reconWanted("FPV"), ORBIT: this.reconWanted("ORBIT") },
        amount: this.reconAmount ?? 0,
        fading: Boolean(this.reconTween)
      } : null,
      experience: {
        kind: this.tour.kind,
        objects: this.tour.objects.length,
        effects: this.tour.effects.length,
        editing: this.editing,
        selected: this.selectedObject,
        hunt: this.state.hunt ?? null
      },
      splats: this.splats?.getDebugSnapshot() ?? null,
      camera: {
        position: this.camera.position.toArray(),
        target: this.controls.target.toArray(),
        fov: this.camera.fov
      }
    };
  }

  getActivePoint() {
    return activeTourPoint(this.tour, this.state.activeSpaceIndex, this.state.activePointIndex);
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detachEvents();
    this.renderer.setAnimationLoop(null);
    this.tweens.forEach((tween) => tween.cancel());
    this.tweens = [];
    this.cameraTween?.cancel();
    this.cameraTween = null;
    this.transitionMeshTween?.cancel();
    this.transitionMeshTween = null;
    this.navigationReleaseTween?.cancel();
    this.navigationReleaseTween = null;
    this.reconTween?.cancel();
    this.reconTween = null;
    if (this.reconTimer) clearTimeout(this.reconTimer);
    this.reconTimer = null;
    this.audio.dispose();
    this.skybox?.dispose();
    this.tourSky?.dispose();
    this.earth?.dispose();
    this.reconstruction?.dispose();
    this.splats?.dispose();
    this.panorama?.dispose();
    this.iiif?.dispose();
    this.nav?.dispose();
    this.cursor?.dispose();
    this.sceneGraph?.dispose();
    this.annotations?.dispose();
    this.gizmo?.detach();
    if (this.gizmo) this.scene.remove(this.gizmo.getHelper());
    this.gizmo?.dispose();
    this.gizmo = null;
    this.effects?.dispose();
    this.objects?.dispose();
    this.looks?.dispose();
    this.experienceAudio?.dispose();
    this.experienceAudio = null;
    this.tooltip?.remove();
    this.tooltip = null;
    this.textureCache.dispose();
    this.controls.dispose();
    this.cubeRenderTarget?.dispose();
    this.cubeRenderTarget = null;
    this.cubeCamera = null;
    this.cubeScene = null;
    this.renderer.dispose();
  }

  private setupScene() {
    this.scene.fog = this.getNodes().length ? null : new THREE.FogExp2(0x090b12, 0.008);
    this.scene.add(this.ambientLight);
    this.sunLight.position.set(4, 8, 5);
    this.scene.add(this.sunLight);
  }

  /** The space, its 360 photos and placed objects take on the tour sky's light. */
  private applySkyLight() {
    const sky = this.tourSky;
    if (!sky) return;
    const tint = sky.light();
    const amount = sky.amount;
    this.panorama?.setSky(amount, tint);
    this.splats?.setTint(tint);
    this.splats?.setSkyCut(amount);
    this.sceneGraph?.setTint(tint);
    this.ambientLight.color.set(0xf3efe6).multiply(tint);
    this.sunLight.color.set(0xfff2cf).multiply(tint);
    const sun = sky.sun();
    if (sun && sun.y > -0.05) this.sunLight.position.copy(sun).multiplyScalar(10);
    else this.sunLight.position.set(4, 8, 5);
    // A space's own authored skybox gives way to the tour's sky.
    const hide = amount > 0.5;
    if (this.skybox && hide !== this.legacySkyHidden) {
      this.legacySkyHidden = hide;
      if (hide) this.skybox.fadeOut(); else this.skybox.fadeIn();
    }
  }

  /** Whether a tour sky can show through this space: its 360 photos need sky outlines. */
  async skySupport() {
    if (!this.panorama) return { panoramas: false, outlines: false };
    return { panoramas: true, outlines: await this.panorama.hasSkyOutlines() };
  }

  private setupNavigationTransitionRenderTarget() {
    const config = this.bootstrap.space.space_data.navigationTransition;
    if (config?.enabled === false || !this.hasTransitionMeshConfig(this.tour.sceneGraph)) return;

    // A phone keeps the photo it projects during a move small and 8-bit: at 1024 in half float it
    // alone took 67 MB of a phone's graphics memory, for a second's blurred motion.
    const requestedSize = Math.min(config?.cubeRenderTargetSize ?? 1024, this.light ? 512 : window.innerWidth < 768 ? 1024 : 2048);
    const maxSize = this.renderer.capabilities.maxCubemapSize || requestedSize;
    const size = Math.min(maxSize, this.previousPowerOfTwo(Math.max(256, requestedSize)));
    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(size, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      mapping: THREE.CubeReflectionMapping,
      // 8-bit targets store sRGB, so dark tombs do not band.
      ...(this.light ? { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace } : { type: THREE.HalfFloatType })
    });
    this.cubeCamera = new THREE.CubeCamera(0.1, 1000, this.cubeRenderTarget);
    this.cubeScene = new THREE.Scene();
  }

  private setupControls() {
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 1;
    this.updateControlsForViewMode();
  }

  private setupLoadingEvents() {
    this.manager.onProgress = (url, loaded, total) => {
      const progress = total ? loaded / total : this.state.loading.progress;
      this.setLoading({
        ...this.state.loading,
        label: url.split("/").pop() ?? "Loading",
        progress: Math.max(this.state.loading.progress, progress),
        ready: this.state.loading.ready
      });
    };
  }

  private viewInset = 0;

  /**
   * Keeps what the camera looks at in the middle of the part of the screen nothing covers:
   * on phones the tour's text covers the bottom, so the picture shifts up by half of it.
   */
  setViewInset(bottom: number) {
    if (Math.abs(bottom - this.viewInset) < 2) return;
    this.viewInset = Math.max(0, bottom);
    this.applyViewOffset();
  }

  private applyViewOffset() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width || window.innerWidth));
    const height = Math.max(1, Math.floor(rect.height || window.innerHeight));
    const shift = Math.min(this.viewInset, height * 0.7) / 2;
    if (shift >= 1) this.camera.setViewOffset(width, height, 0, shift, width, height);
    else if (this.camera.view) this.camera.clearViewOffset();
  }

  private setupRendererSize() {
    const resize = () => {
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width || window.innerWidth));
      const height = Math.max(1, Math.floor(rect.height || window.innerHeight));
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.applyViewOffset();
      this.renderer.setSize(width, height, false);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    };
    resize();
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(this.canvas);

  }

  private attachEvents() {
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.addEventListener("dblclick", this.handleDoubleClick);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleWindowBlur);
  }

  private detachEvents() {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleWindowBlur);
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || this.activePointerId !== null) { this.pointerMoved = true; return; }
    if (this.gizmo?.axis) { this.pointerMoved = true; this.activePointerId = event.pointerId; return; }
    this.activePointerId = event.pointerId;
    this.pointerMoved = this.isNavigating || !this.state.loading.ready;
    this.pointerDown.set(event.clientX, event.clientY);
    this.cursor?.hide();
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (this.activePointerId === event.pointerId && Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 5) this.pointerMoved = true;
    if (event.buttons || this.isNavigating) { this.cursor?.hide(); this.nav?.setHovered(null); return; }
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    if (this.hoverExperience(event)) return;
    const hoveredNode = this.nav?.getIntersectedNode(this.raycaster) ?? null;
    this.nav?.setHovered(hoveredNode && hoveredNode.uuid !== this.currentNode?.uuid ? hoveredNode.uuid : null);
    const targets = this.surfaceTargets();
    if (!targets.length && this.walksOnSplats()) {
      // Splat hits are tested once a frame, with the latest pointer.
      this.splatHover = pointer;
      this.canvas.style.cursor = this.state.viewMode === "FPV" ? "pointer" : "grab";
      return;
    }
    if (!targets.length) { this.canvas.style.cursor = hoveredNode ? "pointer" : ""; return; }
    const canNavigate = Boolean(hoveredNode || this.findPanoramaNavigationNode());
    this.canvas.style.cursor = canNavigate ? "pointer" : "grab";
    if (!this.panorama || canNavigate) this.cursor?.updateFromRaycaster(this.raycaster, targets, Boolean(this.panorama));
    else this.cursor?.hide();
  };

  private handlePointerCancel = () => {
    this.activePointerId = null;
    this.pointerMoved = true;
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    if (this.gizmoDragging) return;
    const dx = event.clientX - this.pointerDown.x;
    const dy = event.clientY - this.pointerDown.y;
    if (this.pointerMoved || Math.hypot(dx, dy) > 5 || this.isNavigating || event.button !== 0) return;
    // A single click in dollhouse must not consume the first half of a double click.
    if (this.state.viewMode === "ORBIT") {
      if (this.objects) {
        const rect = this.canvas.getBoundingClientRect();
        this.raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), this.camera);
        const picked = this.pickObject();
        if (picked && this.editing) this.selectObject(picked);
        else if (picked) this.handleObjectClick(picked);
      }
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const picked = this.pickObject();
    if (picked && this.editing) { this.selectObject(picked); return; }
    if (picked && this.handleObjectClick(picked)) return;
    const node = this.nav?.getIntersectedNode(this.raycaster);
    if (node && node.uuid !== this.currentNode?.uuid) {
      this.navigateToNode(node);
      return;
    }

    const directionalNode = this.findPanoramaNavigationNode(true);
    if (directionalNode) {
      this.navigateToNode(directionalNode);
      return;
    }

    if (this.walkToSplat(pointer)) return;
    this.handleMeshFloorNavigation();
  };

  private handleDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0 || this.state.viewMode !== "ORBIT" || this.isNavigating) return;
    if (this.pointerMoved || Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 5) return;
    event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.surfaceTargets(), true)[0];
    // A splat space steps down into the capture where it was double-clicked.
    if (!hit && !this.nav && this.walksOnSplats() && this.enterSplatAt(pointer)) return;
    let node = this.nav?.getIntersectedNode(this.raycaster) ?? null;
    // Markers behind the visible surface must not select a different room or floor.
    if (node && hit && this.nav && this.camera.position.distanceTo(this.nav.getWorldFloorPosition(node)) > hit.distance + 0.2) node = null;
    if (!node && hit && this.nav) {
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of this.getNodes()) {
        const distance = this.nav.getWorldFloorPosition(candidate).distanceToSquared(hit.point);
        if (distance < nearestDistance) { nearestDistance = distance; node = candidate; }
      }
    }
    // Empty background returns to the current scan; surfaces enter the nearest scan.
    node ??= this.currentNode;
    if (node) void this.navigateToNode(node);
    else this.toggleViewMode();
  };

  private handleWheel = (event: WheelEvent) => {
    if (this.state.viewMode !== "FPV" || this.isNavigating) return;
    event.preventDefault();
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + event.deltaY * 0.025, 30, 110);
    this.camera.updateProjectionMatrix();
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "\\") { this.toggleDebug(); return; }
    if (this.editing && event.key === "Escape" && !isTypingTarget(event.target)) { this.selectObject(null); return; }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    this.running = event.shiftKey;
    if (this.walksFreely()) {
      // Without panorama locations, WASD walks, Q and E sink and rise, and the side arrows turn.
      const move = MOVE_KEYS[key];
      const turn = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : 0;
      if ((!move && !turn) || !this.state.loading.ready) return;
      event.preventDefault();
      if (move) this.moveKeys.set(key, move);
      else this.turnKeys.set(key, turn);
      return;
    }
    const step = key === "ArrowUp" || key === "w" ? 1 : key === "ArrowDown" || key === "s" ? -1 : 0;
    const turn = key === "ArrowLeft" || key === "a" ? 1 : key === "ArrowRight" || key === "d" ? -1 : 0;
    if ((!step && !turn) || this.state.viewMode !== "FPV" || !this.state.loading.ready) return;
    event.preventDefault();
    if (turn) this.turnKeys.set(key, turn);
    // Holding forward keeps walking: repeats are ignored while a move is in flight.
    else void this.stepInDirection(step);
  };

  private handleKeyUp = (event: KeyboardEvent) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    this.running = event.shiftKey;
    this.turnKeys.delete(key);
    this.moveKeys.delete(key);
  };

  private handleWindowBlur = () => { this.turnKeys.clear(); this.moveKeys.clear(); this.running = false; };

  /** Up/W walks to the reachable scan ahead, Down/S to the one behind, keeping the heading. */
  private async stepInDirection(direction: number) {
    if (this.isNavigating || !this.currentNode || !this.nav) return;
    const heading = this.camera.getWorldDirection(new THREE.Vector3());
    // Looking at the floor or sky, "ahead" is the top of the screen.
    if (Math.abs(heading.y) > 0.95) heading.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion)).multiplyScalar(-Math.sign(heading.y));
    const node = selectDirectionalTarget(
      heading.multiplyScalar(direction),
      this.nav.getNavigableNodes().map((item) => ({ value: item, floor: this.nav!.getWorldFloorPosition(item) })),
      this.nav.getWorldFloorPosition(this.currentNode)
    );
    if (node) await this.navigateToNode(node);
  }

  private turnView(radians: number) {
    const look = this.controls.target.clone().sub(this.camera.position).applyAxisAngle(WORLD_UP, radians);
    this.controls.target.copy(this.camera.position).add(look);
  }

  /** Above the space, the side arrows swing the camera around what it looks at. */
  private orbitView(radians: number) {
    const offset = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(WORLD_UP, radians);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  /** Spaces without panorama locations (splats, models): the camera walks and flies freely. */
  private walksFreely() {
    if (this.getNodes().length || this.bootstrap.space.space_data.clickNavigation?.enabled === false) return false;
    return Boolean(this.splats || this.sceneGraph?.getRaycastObjects().length);
  }

  /** Free spaces whose surface is the splats themselves, with no mesh to hit. */
  private walksOnSplats() {
    return this.walksFreely() && Boolean(this.splats?.getMeshes().length) && !this.surfaceTargets().length;
  }

  /**
   * The splat surface under a screen point: the nearest splat the ray meets,
   * moved onto the plane the splats around it lie on, and that plane's normal.
   * Until those are bucketed (just after loading) the surface faces the camera.
   */
  private splatSurface(pointer: THREE.Vector2): SplatSurface | null {
    const meshes = this.splats?.getMeshes() ?? [];
    if (!meshes.length) return null;
    const ray = this.surfaceRaycaster;
    ray.setFromCamera(pointer, this.camera);
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const direction = ray.ray.direction.clone();
    const surface = { point: hit.point.clone(), normal: direction.clone().negate(), direction, distance: hit.distance };
    const local = this.splats?.surfaceAt(hit.point);
    if (!local) return surface;
    surface.normal.copy(local.normal);
    if (surface.normal.dot(direction) > 0) surface.normal.negate();
    // Big splats stop a ray a little short; meet the plane instead when it is close by.
    const along = local.center.clone().sub(ray.ray.origin).dot(surface.normal) / direction.dot(surface.normal);
    if (Number.isFinite(along) && along > 0 && Math.abs(along - hit.distance) < this.eyeHeight() * 0.5) {
      surface.distance = along;
      surface.point.copy(ray.ray.origin).addScaledVector(direction, along);
    }
    return surface;
  }

  /** The height of the splat ground under a point, or null with nothing within reach. */
  private groundBelow(position: THREE.Vector3, reach: number) {
    const meshes = this.splats?.getMeshes() ?? [];
    if (!meshes.length) return null;
    const ground = this.splats!.groundBelow(position, reach);
    if (ground !== null) return ground;
    // Until the splats are bucketed, a ray down; it meets only the splats Spark picked for rays.
    if (!this.splats!.raycastReady()) return null;
    const ray = this.surfaceRaycaster;
    ray.set(position, DOWN);
    ray.far = reach;
    const hit = ray.intersectObjects(meshes, false)[0];
    ray.far = Infinity;
    return hit ? hit.point.y : null;
  }

  /**
   * How high the view stands over the ground: in a splat space (at whatever
   * scale) measured under the camera in first person once its splats are
   * bucketed, else the configured click height or a share of the space's size.
   */
  private eyeHeight() {
    if (this.eye) return this.eye;
    const size = this.getSpaceBounds().getSize(new THREE.Vector3()).length();
    const configured = this.bootstrap.space.space_data.clickNavigation?.yOffset;
    const fallback = configured ?? (size > 0 ? size * 0.04 : 1.6);
    if (configured || !this.splats || this.state.viewMode !== "FPV") return fallback;
    const ground = this.groundBelow(this.camera.position, size || 10);
    const measured = ground === null ? 0 : this.camera.position.y - ground;
    if (!(measured > size * 0.005 && measured < size * 0.25)) return fallback;
    // Only the bucketed splats measure it well enough to keep.
    if (this.splats.surfaceReady()) this.eye = measured;
    return measured;
  }

  private hoverSplat(pointer: THREE.Vector2) {
    if (this.isNavigating || this.activePointerId !== null) return;
    const surface = this.splatSurface(pointer);
    if (surface) this.cursor?.showAt(surface.point, surface.normal, surface.distance);
    else this.cursor?.hide();
  }

  /** Where a visitor stands to reach a spot on the splats. */
  private splatStandingSpot(surface: SplatSurface) {
    const eye = this.eyeHeight();
    return standingSpot(surface, eye, (spot) => this.groundBelow(spot.clone().addScaledVector(WORLD_UP, eye * 0.5), eye * 4));
  }

  /**
   * Above a splat space walked in first person: looking down on where the
   * visitor stood from a few eye heights up, inside the capture's own sky.
   */
  private splatOverview(): CameraPose {
    const eye = this.eyeHeight();
    const target = this.camera.position.clone().addScaledVector(WORLD_UP, -eye);
    const heading = this.camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (heading.lengthSq() < 1e-6) heading.set(0, 0, -1);
    // Captures from 360 photos keep their sky close around them, so the view stays low.
    const direction = heading.normalize().setY(-1).normalize();
    return { position: target.clone().addScaledVector(direction, -eye * 3.5), target, fov: 70 };
  }

  /** In first person, a click on the splats walks there, keeping the heading. */
  private walkToSplat(pointer: THREE.Vector2) {
    if (!this.walksOnSplats()) return false;
    const surface = this.splatSurface(pointer);
    if (!surface) return false;
    const eye = this.eyeHeight();
    const position = this.splatStandingSpot(surface);
    const travel = position.clone().sub(this.camera.position);
    // A spot far off walks toward it: away from where it was taken, a capture thins out.
    if (travel.length() > eye * WALK_REACH) {
      position.copy(this.camera.position).addScaledVector(travel.normalize(), eye * WALK_REACH);
      const ground = this.groundBelow(position.clone().addScaledVector(WORLD_UP, eye * 2), eye * 6);
      if (ground !== null) position.y = ground + eye;
    }
    const distance = position.distanceTo(this.camera.position);
    if (distance < eye * 0.1) return true;
    this.cursor?.showAt(surface.point, surface.normal, surface.distance);
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    this.walkGround = null;
    this.moveVelocity.set(0, 0, 0);
    this.flyTo({ position, target: position.clone().addScaledVector(direction, 0.1), fov: this.camera.fov },
      false, undefined, undefined, THREE.MathUtils.clamp(500 + (220 * distance) / eye, 700, 2200));
    return true;
  }

  /** From the dollhouse, a double click on the splats steps down into the capture there. */
  private enterSplatAt(pointer: THREE.Vector2) {
    const surface = this.splatSurface(pointer);
    if (!surface) return false;
    const position = this.splatStandingSpot(surface);
    // Facing on across the space the way the dollhouse looked, a little down.
    const heading = surface.direction.clone().setY(0);
    if (heading.lengthSq() < 1e-6) heading.set(0, 1, 0).applyQuaternion(this.camera.quaternion).setY(0);
    heading.normalize().setY(-0.2).normalize();
    const fov = this.freeView?.fov ?? this.poseForPoint(this.getActivePoint(), "FPV").fov;
    this.state.viewMode = "FPV";
    this.updateControlsForViewMode();
    this.sceneGraph?.setViewMode("FPV", this.state.debug);
    this.walkGround = null;
    this.freeView = null;
    this.flyFromOverview({ position, target: position.clone().addScaledVector(heading, 0.1), fov });
    this.emitState();
    return true;
  }

  /**
   * Held keys move the camera and what it looks at together, easing in and out.
   * In first person the walk keeps level and follows the ground's rise and fall;
   * above the space it glides at a pace set by how far away the camera looks.
   */
  private moveFreely(elapsed: number, now: number) {
    if (!this.moveKeys.size && this.moveVelocity.lengthSq() === 0) return;
    if (this.cameraTween || this.isNavigating || !this.controls.enabled || !this.state.loading.ready) {
      this.moveVelocity.set(0, 0, 0);
      return;
    }
    const input = { forward: 0, right: 0, up: 0 };
    for (const [forward, right, up] of this.moveKeys.values()) { input.forward += forward; input.right += right; input.up += up; }
    const orbit = this.state.viewMode === "ORBIT";
    const speed = (orbit ? this.camera.position.distanceTo(this.controls.target) * 0.8 : this.eyeHeight() * WALK_SPEED) * (this.running ? RUN_FACTOR : 1);
    const look = this.camera.getWorldDirection(new THREE.Vector3());
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const wanted = freeMoveDirection(look, screenUp, input).multiplyScalar(speed);
    this.moveVelocity.lerp(wanted, 1 - Math.exp(-elapsed * 9));
    if (!this.moveKeys.size && this.moveVelocity.length() < speed * 0.01) { this.moveVelocity.set(0, 0, 0); return; }
    const step = this.moveVelocity.clone().multiplyScalar(elapsed);
    if (!orbit && this.splats && now - this.lastGroundSample > 100 && Math.hypot(step.x, step.z) > 0) {
      // Follow the change in the ground below, not its height, so rising with E sticks.
      this.lastGroundSample = now;
      const eye = this.eyeHeight();
      const ground = this.groundBelow(this.camera.position.clone().addScaledVector(WORLD_UP, eye * 0.5), eye * 4.5);
      if (ground !== null && this.walkGround !== null && Math.abs(ground - this.walkGround) < eye * 0.75) this.walkLift += ground - this.walkGround;
      this.walkGround = ground;
    }
    const lift = this.walkLift * (1 - Math.exp(-elapsed * 8));
    this.walkLift -= lift;
    step.y += lift;
    this.camera.position.add(step);
    this.controls.target.add(step);
    this.cursor?.hide();
  }

  navigateNode(uuid: string) {
    const node = this.resolveNode(uuid);
    if (node) void this.navigateToNode(node);
  }

  adjustFieldOfView(delta: number) {
    if (this.state.viewMode !== 'FPV' || this.isNavigating) return;
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + delta, 30, 110);
    this.camera.updateProjectionMatrix();
  }

  /** Hides the location rings, for a clean frame of the view (a tour's thumbnail). */
  setNavigationHidden(hidden: boolean) {
    if (this.nav) this.nav.group.visible = !hidden;
  }

  captureStartView(): { view: StartView; thumbnail: string } {
    if (!this.state.loading.ready || this.isNavigating || this.cameraTween || this.activePointerId !== null) {
      throw new Error('Wait for the camera to stop moving, then capture again.');
    }
    if (this.state.viewMode !== 'FPV') throw new Error('Enter a panorama before setting the start view.');
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const view: StartView = {
      ...(!this.bootstrap.space.space_data.noPanos && this.currentNode ? { nodeId: this.currentNode.uuid } : {}),
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      rotation: { azimuth: THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z)),
        polar: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1))) },
      fov: this.camera.fov
    };
    const output = document.createElement('canvas');
    output.width = 960; output.height = 640;
    const context = output.getContext('2d');
    if (!context) throw new Error('Unable to create the thumbnail.');
    const hidden = [this.nav?.group, this.scene.getObjectByName('annotations'), this.gizmo?.getHelper()].filter(Boolean) as THREE.Object3D[];
    const visibility = hidden.map(object => object.visible);
    try {
      hidden.forEach(object => { object.visible = false; });
      const camera = this.camera.clone();
      camera.aspect = 960 / 640;
      camera.updateProjectionMatrix();
      // Read synchronously after rendering; no preserveDrawingBuffer cost during exploration.
      this.renderer.render(this.scene, camera);
      context.fillStyle = '#111'; context.fillRect(0, 0, 960, 640);
      context.drawImage(this.canvas, 0, 0, 960, 640);
      return { view, thumbnail: output.toDataURL('image/jpeg', .88) };
    } finally {
      hidden.forEach((object, index) => { object.visible = visibility[index]; });
      this.renderer.render(this.scene, this.camera);
    }
  }

  private async navigateToNode(node: NodeData) {
    if (this.isNavigating) return;
    const fromOverview = this.state.viewMode === "ORBIT";
    // Hunt steps keep their clue while visitors walk around looking.
    const tourPoint = this.tour.kind === "hunt" && this.state.guided ? null : this.findTourPointForNode(node.uuid);
    if (tourPoint) {
      await this.goTo(tourPoint.spaceIndex, tourPoint.pointIndex, false, !fromOverview, fromOverview);
      return;
    }
    this.isNavigating = true;
    this.state.navigating = true;
    this.state.navigationError = undefined;
    this.controls.enabled = false;
    this.emitState();
    try { await this.panorama?.prepareQuick(node, 600, 25000); }
    catch (error) {
      this.endNavigationTransition();
      this.state.navigationError = String(error);
      this.emitState();
      return;
    }
    if (this.disposed) return;
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const transition = fromOverview || this.reconstructionMove() ? null : this.beginNavigationTransition(this.currentNode);
    const navigationMs = this.bootstrap.space.space_data.navigationTransition?.navigationMs ?? 1100;
    this.nav?.beginTransition();
    this.currentNode = node;
    this.panorama?.navigate(node, navigationMs, { replaceImmediately: fromOverview, fadeStart: transition?.fadeStart });
    this.panorama?.setVisible(true);
    this.state.viewMode = "FPV";
    this.updateControlsForViewMode();
    this.sceneGraph?.setViewMode("FPV", this.state.debug);
    this.nav?.setOrbit(false);
    this.nav?.setActive(node.uuid);
    const pose = this.poseForNode(node, "FPV");
    if (!fromOverview) {
      pose.target.copy(pose.position).addScaledVector(direction, 0.1);
      pose.fov = this.camera.fov;
    }
    if (fromOverview) this.flyFromOverview(pose);
    else {
      const reconstruction = this.reconFlight("FPV", "FPV");
      this.flyTo(pose, false, reconstruction?.done, reconstruction?.update);
      this.scheduleNavigationTransitionEnd(navigationMs);
    }
    this.emitState();
    this.prefetchNeighbors(node);
  }

  // ---- Placed objects, effects, scavenger hunts and editing ----

  /** @param objectsAfter when given, the objects' models download once it resolves and the first view does not wait for them */
  private async setupExperience(objectsAfter?: Promise<void>) {
    this.objects = new ObjectLayer(this.scene);
    this.effects = new EffectsLayer({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      objects: this.objects,
      surfaces: () => this.sceneGraph?.getSurfaceMeshes() ?? [],
      spaceBounds: (out) => out.copy(this.getSpaceBounds()),
      splats: () => this.splats?.splatHost() ?? null,
      panorama: () => this.panorama?.style ?? null,
      viewMode: () => this.state.viewMode,
      audio: () => this.audioHost()
    });
    const objects = this.objects.setObjects(this.tour.objects, objectsAfter);
    await Promise.all([objectsAfter ? null : objects, this.effects.setEffects(this.tour.effects)]);
    this.sceneGraph?.setOccluding(this.tour.objects.length > 0 || this.tour.effects.length > 0);
  }

  /** Effect audio is created on first use, following the viewer's mute state. */
  private audioHost() {
    if (!this.experienceAudio) {
      this.experienceAudio = new ExperienceAudio(this.camera);
      this.experienceAudio.setMuted(this.state.muted);
    }
    return this.experienceAudio;
  }

  /** Editor: hear a sound from the packs or an audio address. */
  previewSound(source: string) {
    return this.audioHost().preview(source);
  }

  /** Editor: play an effect that holds back for a find, a hint or a click, as if it came. */
  previewEffect(id: string) {
    return this.effects?.preview(id) ?? false;
  }

  /** What looks can ask of the space: drawn versions of it, splat styling and linear output. */
  private lookHost(): LookHost {
    const size = new THREE.Vector2();
    return {
      prepareVariant: async (variant) => {
        const results = await Promise.all([this.splats?.prepareVariant(variant) ?? false, this.panorama?.prepareVariant(variant) ?? false]);
        return results.some(Boolean);
      },
      showVariant: (variant, amount, transition, direction) => {
        this.splats?.showVariant(variant, amount, transition, this.camera, direction);
        this.renderer.getDrawingBufferSize(size);
        const mode = ["cut", "fade", "dissolve", "wipe", "iris", "sweep", "glitch"].indexOf(transition);
        this.panorama?.showVariant(variant ? amount : 0, mode < 0 ? 1 : mode, direction, size);
      },
      styleSplats: (style, amount) => this.splats?.styleSplats(style ?? null, amount),
      variantReady: (variant) => Boolean(this.splats?.variantReady(variant) || this.panorama?.variantReady())
    };
  }

  /** Previews of the current view in each look, for the builder. */
  lookThumbnails(ids: string[], width?: number) {
    return this.looks?.thumbnails(this.scene, this.camera, ids, width) ?? {};
  }

  private applyExperienceForPoint(point?: TourPoint) {
    const guided = this.state.guided || (this.editing && this.tour.hasGuidedTour);
    const objects = new Set(guided ? point?.objects ?? [] : []);
    const hunt = this.tour.kind === "hunt";
    if (hunt && guided && point?.find) objects.add(point.find.objectId);
    this.objects?.show(objects);
    this.effects?.activate(guided ? point?.effects ?? [] : []);
    // A stop's look, else the tour's; transitions open toward what the stop is about.
    const look = guided ? point?.look ?? this.tour.look : this.tour.look;
    const focus = point?.find?.objectId ?? point?.objects?.[0];
    const anchor = focus ? this.objects?.getData(focus)?.position : undefined;
    // A tour that opens on a stop with its own look starts in the tour's look and transitions from it.
    if (!this.lookStarted) {
      this.lookStarted = true;
      if (lookKey(look) !== lookKey(this.tour.look)) this.looks?.set(this.tour.look, this.camera, null, { instant: true });
    }
    this.looks?.set(look, this.camera, anchor ? new THREE.Vector3(...anchor) : null);
    // A stop's sky, else the tour's; the first one is there from the start.
    const sky = guided ? point?.sky ?? this.tour.sky : this.tour.sky;
    this.tourSky?.set(sky, { instant: !this.skyStarted });
    this.skyStarted = true;
    this.state.hunt = hunt ? {
      found: [...this.huntFound],
      stepFound: Boolean(point?.find && this.huntFound.has(point.find.objectId)),
      hint: this.hintShown
    } : undefined;
  }

  /** Pointer over the space: object labels, interactive cursors and hover effects. */
  private hoverExperience(event: PointerEvent) {
    if (!this.objects) return false;
    const picked = this.pickObject();
    if (picked !== this.hoverObjectId) {
      this.hoverObjectId = picked;
      const data = picked ? this.objects.getData(picked) : null;
      const label = this.editing ? data?.name : this.tour.kind === "hunt" && this.state.guided ? "" : data?.label;
      this.showTooltip(label ?? "", event);
    } else if (this.tooltip?.dataset.visible === "true") this.moveTooltip(event);
    if (this.effects?.wantsPointer() && performance.now() - this.lastSurfaceHover > 70) {
      this.lastSurfaceHover = performance.now();
      this.effects.pointer(this.surfaceHit());
    }
    if (picked && (this.editing || this.isInteractive(picked))) {
      this.canvas.style.cursor = "pointer";
      this.cursor?.hide();
      this.nav?.setHovered(null);
      return true;
    }
    return false;
  }

  private isInteractive(id: string) {
    const point = this.getActivePoint();
    if (this.tour.kind === "hunt" && this.state.guided && point?.find?.objectId === id) return true;
    const data = this.objects?.getData(id);
    return Boolean(data?.label || data?.link) || this.tour.effects.some((effect) => effect.target.kind === "object" && effect.target.id === id && answersCue(effect.params, "click"));
  }

  /** The visible placed object under the pointer ray, unless a wall hides it. */
  private pickObject() {
    const picked = this.objects?.pick(this.raycaster);
    if (!picked) return null;
    if (this.state.viewMode === "FPV") {
      const wall = this.raycaster.intersectObjects(this.surfaceTargets(), true)[0];
      if (wall && wall.distance < picked.distance - 0.15) return null;
    }
    return picked.id;
  }

  private surfaceHit() {
    const targets = [...(this.sceneGraph?.getRaycastObjects() ?? []), ...(this.splats?.getMeshes() ?? [])];
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    const normal = hit.face ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)) : null;
    return { point: hit.point.clone(), normal, objectId: null };
  }

  private handleObjectClick(id: string) {
    const point = this.getActivePoint();
    if (this.tour.kind === "hunt" && this.state.guided && point?.find?.objectId === id && !this.huntFound.has(id)) {
      this.huntFound.add(id);
      this.objects?.collect(id);
      if (!this.effects?.cue(id, "found")) void this.effects?.flash("sparkles", id, "found", { mode: "burst", color: "#fff6c2", color2: "#f7c948", radius: 0.9 });
      if (!this.effects?.hasSound(id, "found")) void this.effects?.flash("sound", id, "found", { sound: "found", trigger: "found", volume: 0.8, range: 20 }, 5);
      this.audio.play("found");
      this.applyExperienceForPoint(point);
      this.emitState();
      return true;
    }
    if (!this.isInteractive(id)) return false;
    this.effects?.cue(id, "click");
    const link = this.objects?.getData(id)?.link;
    if (link) this.openLink(link);
    return true;
  }

  /** An object's link: another page of this site opens in place, anything else in a new tab. */
  private openLink(link: string) {
    try {
      const url = new URL(link, window.location.href);
      if (url.origin === window.location.origin) window.location.assign(url.toString());
      else window.open(url.toString(), "_blank", "noopener");
    } catch { /* an invalid address does nothing */ }
  }

  /** Hunt: show the step's hint and light up where the object is. */
  requestHint() {
    const point = this.getActivePoint();
    const id = point?.find?.objectId;
    if (this.tour.kind !== "hunt" || !id || this.huntFound.has(id)) return;
    this.hintShown = true;
    if (!this.effects?.cue(id, "hint")) void this.effects?.flash("beacon", id, "hint", { height: 3, radius: 0.6, color: "#ffffff" }, 12);
    if (!this.effects?.hasSound(id, "hint")) void this.effects?.flash("sound", id, "hint", { sound: "hint", trigger: "hint", volume: 0.6, range: 30 }, 4);
    this.applyExperienceForPoint(point);
    this.emitState();
  }

  /** Hunt: start over with every object back in place. */
  restartHunt() {
    this.huntFound.clear();
    this.hintShown = false;
    this.objects?.resetCollected();
    this.applyExperienceForPoint(this.getActivePoint());
    this.emitState();
  }

  setEditing(editing: boolean) {
    this.editing = editing;
    this.objects?.setEditing(editing);
    if (editing && !this.gizmo) {
      const gizmo = new TransformControls(this.camera, this.renderer.domElement);
      gizmo.setSize(0.85);
      gizmo.addEventListener("dragging-changed", (event) => {
        this.gizmoDragging = Boolean(event.value);
        this.controls.enabled = !this.gizmoDragging && !this.isNavigating;
        if (!this.gizmoDragging) this.emitObjectTransform();
      });
      gizmo.addEventListener("objectChange", () => this.emitObjectTransform());
      const helper = gizmo.getHelper();
      helper.traverse((child) => { child.renderOrder = 60; });
      this.scene.add(helper);
      this.gizmo = gizmo;
    }
    if (!editing && this.gizmo) this.selectObject(null);
    this.applyExperienceForPoint(this.getActivePoint());
  }

  /** Select an object for the gizmo; `quiet` only re-attaches the gizmo, telling the editor nothing unless the selection is lost. */
  selectObject(id: string | null, quiet = false) {
    const holder = id ? this.objects?.getHolder(id) ?? null : null;
    this.selectedObject = holder ? id : null;
    if (this.gizmo) {
      if (holder) this.gizmo.attach(holder);
      else this.gizmo.detach();
    }
    if (!quiet || this.selectedObject !== id) this.callbacks.onObjectSelect?.(this.selectedObject);
  }

  setGizmoMode(mode: GizmoMode) {
    this.gizmo?.setMode(mode);
    this.gizmo?.setSpace(mode === "scale" ? "local" : "world");
  }

  private emitObjectTransform() {
    const id = this.selectedObject;
    const holder = id ? this.objects?.getHolder(id) : null;
    if (!id || !holder) return;
    const round = (value: number, places = 4) => Number(value.toFixed(places));
    this.callbacks.onObjectTransform?.(id, {
      position: [round(holder.position.x), round(holder.position.y), round(holder.position.z)],
      rotation: [round(THREE.MathUtils.radToDeg(holder.rotation.x), 2), round(THREE.MathUtils.radToDeg(holder.rotation.y), 2), round(THREE.MathUtils.radToDeg(holder.rotation.z), 2)],
      scale: [round(holder.scale.x), round(holder.scale.y), round(holder.scale.z)]
    });
  }

  /** Replace the tour's stops, objects and effects without reloading the space. */
  async setExperience(update: ExperienceUpdate) {
    const segment = this.tour.spaces[0];
    if (segment && update.points.length) segment.tourpoints = update.points;
    this.tour.hasGuidedTour = this.tour.hasGuidedTour || update.points.length > 0;
    this.tour.kind = update.kind;
    this.tour.objects = update.objects;
    this.tour.effects = update.effects;
    this.tour.finale = update.finale;
    this.tour.look = update.look;
    this.tour.sky = update.sky;
    this.tour.place = update.place ?? this.bootstrap.space.space_data.geo;
    if (this.state.activePointIndex >= (segment?.tourpoints.length ?? 1)) this.state.activePointIndex = 0;
    // The builder turns and moves the map live while it is in view.
    const place = this.earthPlace();
    if (this.earth && place) this.earth.setPlace(place, this.placeAnchor(place));
    else if (this.earth && !place) this.earth.setOpacity(0);
    this.prepareEarth(this.currentNode);
    await Promise.all([this.objects?.setObjects(update.objects), this.effects?.setEffects(update.effects)]);
    if (this.disposed) return;
    this.sceneGraph?.setOccluding(update.objects.length > 0 || update.effects.length > 0);
    if (this.selectedObject && !update.objects.some((object) => object.id === this.selectedObject)) this.selectObject(null);
    // Edits rebuild objects; keep the gizmo on the selection without sending the editor back to it.
    else if (this.selectedObject) this.selectObject(this.selectedObject, true);
    this.applyExperienceForPoint(this.getActivePoint());
    this.emitState();
  }

  /** Where a pixel lands in the space: the surface it shows, or two meters out. */
  resolveAnchor(anchor: PixelAnchor): { position: Vec3; normal: Vec3 | null; hit: boolean; distance: number | null; origin: Vec3; floor: number | null; rotation: { azimuth: number; polar: number } } | null {
    const node = anchor.nodeId ? this.resolveNode(anchor.nodeId) : null;
    if (anchor.nodeId && !node) return null;
    const ray = new THREE.Raycaster();
    if (node) {
      const origin = this.nav?.getWorldPosition(node) ?? vectorFromLike(node.position);
      ray.set(origin, panoramaPixelDirection(node, anchor.x, anchor.y, anchor.face));
    } else {
      let camera: THREE.Camera = this.camera;
      if (anchor.camera) {
        const saved = new THREE.PerspectiveCamera(anchor.camera.fov, anchor.camera.aspect, 0.02, 20000);
        saved.position.set(...anchor.camera.position);
        saved.quaternion.fromArray(anchor.camera.quaternion);
        saved.updateMatrixWorld(true);
        camera = saved;
      }
      ray.setFromCamera(new THREE.Vector2(anchor.x * 2 - 1, -(anchor.y * 2 - 1)), camera);
    }
    ray.far = 500;
    const targets = [...(this.sceneGraph?.getRaycastObjects() ?? []), ...(this.splats?.getMeshes() ?? [])];
    const hit = ray.intersectObjects(targets, true).find((item) => item.distance > 0.15);
    const direction = ray.ray.direction;
    const origin: Vec3 = [ray.ray.origin.x, ray.ray.origin.y, ray.ray.origin.z];
    const floor = node?.floorPosition ? (this.nav?.getWorldPosition({ ...node, position: node.floorPosition }) ?? vectorFromLike(node.floorPosition)).y : null;
    const rotation = {
      azimuth: THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z)),
      polar: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)))
    };
    if (!hit) {
      const point = ray.ray.at(2.5, new THREE.Vector3());
      return { position: [point.x, point.y, point.z], normal: null, hit: false, distance: null, origin, floor, rotation };
    }
    const normal = hit.face ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize() : null;
    if (normal && normal.dot(direction) > 0) normal.negate();
    // Rest on floors; stand slightly off walls toward the viewer.
    const point = hit.point.clone().addScaledVector(normal ?? direction.clone().negate(), normal && normal.y > 0.7 ? 0.01 : 0.06);
    return { position: [point.x, point.y, point.z], normal: normal ? [normal.x, normal.y, normal.z] : null, hit: true, distance: hit.distance, origin, floor, rotation };
  }

  /** A JPEG of the current view for the tour agent, with the camera it was taken from. */
  captureView(width = 1024): { image: string; camera: ViewCamera; view: StopView } {
    const aspect = this.camera.aspect;
    const height = Math.round(width / Math.max(0.5, Math.min(2.5, aspect)));
    const output = document.createElement("canvas");
    output.width = width; output.height = height;
    const context = output.getContext("2d");
    if (!context) throw new Error("Unable to capture the view.");
    const hidden = [this.nav?.group, this.scene.getObjectByName("annotations"), this.gizmo?.getHelper()].filter(Boolean) as THREE.Object3D[];
    const visibility = hidden.map((object) => object.visible);
    try {
      hidden.forEach((object) => { object.visible = false; });
      this.renderer.render(this.scene, this.camera);
      context.fillStyle = "#111"; context.fillRect(0, 0, width, height);
      context.drawImage(this.canvas, 0, 0, width, height);
    } finally {
      hidden.forEach((object, index) => { object.visible = visibility[index]; });
    }
    return {
      image: output.toDataURL("image/jpeg", 0.82),
      camera: { position: this.camera.position.toArray() as Vec3, quaternion: this.camera.quaternion.toArray() as [number, number, number, number], fov: this.camera.fov, aspect },
      view: this.cameraView()
    };
  }

  /** Turn the camera toward a placed object without moving, or orbit to it in overview. */
  lookAtObject(id: string) {
    if (!this.objects || this.isNavigating) return;
    const center = this.objects.bounds(id, new THREE.Box3()).getCenter(new THREE.Vector3());
    if (this.state.viewMode === "FPV") {
      const direction = center.clone().sub(this.camera.position);
      if (direction.lengthSq() < 1e-6) return;
      this.flyTo({ position: this.camera.position.clone(), target: this.camera.position.clone().addScaledVector(direction.normalize(), 0.1), fov: this.camera.fov });
    } else {
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.flyTo({ position: center.clone().add(offset), target: center, fov: this.camera.fov });
    }
  }

  /** Heading and tilt that look from a panorama location toward a point. */
  aimFrom(nodeId: string, point: Vec3) {
    const node = this.resolveNode(nodeId);
    if (!node) return null;
    const origin = this.nav?.getWorldPosition(node) ?? vectorFromLike(node.position);
    const direction = new THREE.Vector3(...point).sub(origin);
    if (direction.lengthSq() < 1e-6) return null;
    direction.normalize();
    return {
      azimuth: Number(THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z)).toFixed(2)),
      polar: Number(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1))).toFixed(2))
    };
  }

  /** The current camera as a tour stop view. */
  cameraView(): StopView {
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const rotation = {
      azimuth: Number(THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z)).toFixed(2)),
      polar: Number(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1))).toFixed(2))
    };
    const panoramas = !this.bootstrap.space.space_data.noPanos && this.getNodes().length > 0;
    return {
      ...(panoramas && this.currentNode ? { nodeId: this.currentNode.uuid } : {}),
      ...(!panoramas ? { position: { x: Number(this.camera.position.x.toFixed(3)), y: Number(this.camera.position.y.toFixed(3)), z: Number(this.camera.position.z.toFixed(3)) } } : {}),
      rotation,
      fov: Math.round(this.camera.fov),
      ...(this.state.viewMode === "ORBIT" ? { viewMode: "ORBIT" as const } : {}),
      ...(this.state.viewMode === "ORBIT" && this.earth?.visible
        ? { earth: { range: Math.round(this.camera.position.distanceTo(this.controls.target) / (this.earthPlace()?.scale ?? 1)) } } : {}),
      // A stop taken from the view keeps the reconstruction, or the capture, that is showing.
      ...(this.reconstruction && !this.reconstruction.failed ? { reconstruction: this.reconWanted(this.state.viewMode) } : {}),
      ...(this.reconstruction?.selectedVariant ? { reconstructionVariant: this.reconstruction.selectedVariant } : {})
    };
  }

  /** Builder: rise over the map from where the camera stands, to line the map up with the space. */
  async showEarth(range = 600) {
    const place = this.earthPlace();
    if (!place || this.isNavigating) return false;
    const anchor = this.placeAnchor(place);
    if (this.earth) this.earth.setPlace(place, anchor);
    else this.earth = this.createEarth(place, anchor);
    if (this.currentNode && !this.earth.visible) this.earth.setFocus(this.floorOf(this.currentNode));
    if (!(await this.earth.load()) || this.disposed || this.isNavigating) return false;
    const target = this.currentNode ? this.floorOf(this.currentNode) : this.controls.target.clone();
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const azimuth = THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z));
    const pose = earthPose(target, { range }, { azimuth, polar: -50 }, place.scale ?? 1);
    const fromOverview = this.state.viewMode === "ORBIT";
    this.state.viewMode = "ORBIT";
    this.updateControlsForViewMode();
    this.nav?.setOrbit(true);
    if (this.reconWanted("ORBIT")) void this.loadReconstruction();
    if (fromOverview) this.glideOverEarth(pose, true);
    else {
      this.panorama?.setVisible(true);
      this.flyToEarth(pose);
    }
    this.emitState();
    return true;
  }

  /** Bounds of everything captured: meshes, splats and panorama locations. */
  getSpaceBounds() {
    if (this.spaceBounds && !this.spaceBounds.isEmpty()) return this.spaceBounds;
    const box = new THREE.Box3();
    const graph = this.sceneGraph?.getBounds();
    if (graph && !graph.isEmpty()) box.union(graph);
    if (this.splats) box.union(this.splats.getBounds(new THREE.Box3()));
    for (const node of this.getNodes()) box.expandByPoint(this.nav?.getWorldPosition(node) ?? vectorFromLike(node.position));
    // Measure again later when nothing has loaded yet.
    if (box.isEmpty()) return box.setFromCenterAndSize(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(10, 4, 10));
    this.spaceBounds = box;
    return box;
  }

  private showTooltip(label: string, event: PointerEvent) {
    if (!label) { if (this.tooltip) this.tooltip.dataset.visible = "false"; return; }
    if (!this.tooltip) {
      this.tooltip = document.createElement("div");
      this.tooltip.className = "sphr-object-label";
      this.tooltip.setAttribute("role", "tooltip");
      this.canvas.parentElement?.append(this.tooltip);
    }
    this.tooltip.textContent = label;
    this.tooltip.dataset.visible = "true";
    this.moveTooltip(event);
  }

  private moveTooltip(event: PointerEvent) {
    if (!this.tooltip) return;
    const rect = this.canvas.getBoundingClientRect();
    this.tooltip.style.transform = `translate(${Math.round(event.clientX - rect.left + 14)}px, ${Math.round(event.clientY - rect.top + 14)}px)`;
  }

  /** The next stop of a guided tour first, so Next is quick, then the nearest locations. */
  private prefetchNeighbors(node: NodeData) {
    const next = this.state.guided && this.tour.hasGuidedTour
      ? this.resolveNode(this.tour.spaces[this.state.activeSpaceIndex]?.tourpoints[this.state.activePointIndex + 1]?.nodeUUID)
      : null;
    const neighbors = (this.nav?.getNavigableNodes() ?? []).filter((item) => item.uuid !== node.uuid && item.uuid !== next?.uuid)
      .slice(0, next && this.light ? 1 : 2);
    const panorama = this.panorama;
    if (!panorama) return;
    const ahead = next && next.uuid !== node.uuid ? next : null;
    if (!this.light) {
      for (const item of [ahead, ...neighbors]) if (item) void panorama.prepare(item).then(() => this.textureCache.trim()).catch(() => {});
      return;
    }
    // On a phone the view in front sharpens first, then the small faces of where the visitor may go
    // next, then the next stop's sharp ones, so a slow connection is not split between them.
    void (async () => {
      await Promise.race([panorama.whenSharp(), new Promise((resolve) => setTimeout(resolve, 8000))]);
      const stayed = () => !this.disposed && this.panorama === panorama && this.currentNode?.uuid === node.uuid;
      if (!stayed()) return;
      await Promise.all([ahead, ...neighbors].map((item) => item ? panorama.preparePreview(item).catch(() => {}) : null));
      if (ahead && stayed()) await panorama.prepare(ahead).catch(() => {});
      this.textureCache.trim();
    })();
  }

  private findTourPointForNode(nodeUUID: string) {
    for (let spaceIndex = 0; spaceIndex < this.tour.spaces.length; spaceIndex += 1) {
      const space = this.tour.spaces[spaceIndex];
      const pointIndex = space.tourpoints.findIndex((point) => point.nodeUUID === nodeUUID && point.targetType !== 'MODEL');
      if (pointIndex >= 0) return { spaceIndex, pointIndex };
    }
    return null;
  }

  /** Sightlines are only tested on click; hovering assumes the spot can be reached. */
  private findPanoramaNavigationNode(checkSightlines = false) {
    const nav = this.nav;
    const currentNode = this.currentNode;
    if (this.state.viewMode !== "FPV" || !currentNode || !nav) return null;
    const hit = this.raycaster.intersectObjects(this.surfaceTargets(), true)[0];
    let floorHit: THREE.Vector3 | null = null;
    if (hit?.face) {
      const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
      if (Math.abs(normal.y) >= 0.7) floorHit = hit.point;
    }
    // Unknown floors use directly selectable camera spheres, not inferred floor targets.
    const candidates = (nodes: NodeData[]) => nodes.filter((node) => !node.floorUnobserved)
      .map((node) => ({ value: node, floor: nav.getWorldFloorPosition(node) }));
    const currentFloor = nav.getWorldFloorPosition(currentNode);
    const navigable = nav.getNavigableNodes();
    if (hit) {
      // Any visible spot on the mesh, however far, travels to the scan nearest it.
      const reachable = new Set(navigable.map((node) => node.uuid));
      const spot = selectSpotTarget(hit.point, Boolean(floorHit), candidates(this.getNodes().filter((node) => node.uuid !== currentNode.uuid)), currentFloor,
        (node) => reachable.has(node.uuid) || !checkSightlines || nav.canSee(currentNode, node));
      if (spot) return spot;
    }
    return selectNavigationTarget(this.raycaster.ray, candidates(navigable), currentFloor, floorHit);
  }

  private startAnimationLoop() {
    if (this.animationStarted) return;
    this.animationStarted = true;
    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return;
      const now = performance.now();
      const elapsed = Math.min(0.1, Math.max(0, (now - (this.lastFrameTime || now)) / 1000));
      this.lastFrameTime = now;
      const turn = Math.sign([...this.turnKeys.values()].reduce((sum, value) => sum + value, 0));
      if (turn && !this.cameraTween && this.controls.enabled && this.state.viewMode === "FPV") this.turnView(turn * KEY_TURN_SPEED * elapsed);
      else if (turn && !this.cameraTween && this.controls.enabled && this.walksFreely()) this.orbitView(turn * KEY_TURN_SPEED * elapsed);
      this.moveFreely(elapsed, now);
      this.tweens = this.tweens.filter((tween) => tween.update(now));
      if (this.cameraTween && !this.cameraTween.update(now)) this.cameraTween = null;
      if (this.transitionMeshTween && !this.transitionMeshTween.update(now)) this.transitionMeshTween = null;
      if (this.navigationReleaseTween && !this.navigationReleaseTween.update(now)) this.navigationReleaseTween = null;
      if (this.reconTween && !this.reconTween.update(now)) this.reconTween = null;
      // OrbitControls clamps FPV distance to 0.1m. It must not rewrite an in-flight pose.
      if (!this.cameraTween) this.controls.update();
      this.skybox?.update(this.camera);
      if (this.tourSky?.update(this.camera, elapsed)) this.applySkyLight();
      this.panorama?.update(this.camera);
      this.reconstruction?.update(this.camera);
      this.nav?.update(this.camera, this.canvas.clientHeight);
      this.objects?.update(elapsed, now / 1000);
      this.effects?.update(now / 1000, elapsed);
      this.looks?.update(elapsed);
      this.splats?.update();
      this.updateEarth(now);
      this.updateNearPlane();
      if (this.splatHover) { this.hoverSplat(this.splatHover); this.splatHover = null; }
      this.cursor?.update(now);
      if (this.looks) this.looks.render(this.scene, this.camera, now / 1000, this.renderScene);
      else this.renderScene();
      this.cursor?.render(this.renderer, this.camera);
    });
  }

  private flyFromOverview(pose: CameraPose) {
    this.isNavigating = true;
    this.state.navigating = true;
    this.controls.enabled = false;
    this.panorama?.setVisible(true);
    this.panorama?.setPresentationOpacity(0);
    this.sceneGraph?.setOverviewReturnBlend(0);
    // The reconstruction gives way to the photograph with the same blend, or stays in its place.
    const reconstruction = this.reconFlight("ORBIT", "FPV");
    // Diving from the map, the map gives way to the photograph just above the ground.
    const earth = this.earth?.visible ? this.earth : null;
    const done = () => {
      earth?.setOpacity(0);
      this.panorama?.setPresentationOpacity(1);
      this.sceneGraph?.setOverviewReturnBlend(null);
      reconstruction?.done();
      this.endNavigationTransition();
    };
    const update = (progress: number) => {
      // Retain spatial depth during the flight; reveal the photo only near its capture origin.
      const blend = THREE.MathUtils.smoothstep(progress, earth ? 0.78 : 0.85, earth ? 0.98 : 1);
      this.panorama?.setPresentationOpacity(blend);
      this.sceneGraph?.setOverviewReturnBlend(blend);
      reconstruction?.update(blend);
      earth?.setOpacity(1 - THREE.MathUtils.smoothstep(progress, 0.72, 0.93));
    };
    if (earth) this.flyArc(pose, EARTH_DIVE_MS, update, done);
    else this.flyTo(pose, false, done, update);
  }

  /** Rise out of the photograph to the stop's view over the map. */
  private flyToEarth(pose: CameraPose) {
    const earth = this.earth!;
    this.isNavigating = true;
    this.state.navigating = true;
    this.controls.enabled = false;
    this.sceneGraph?.setViewMode("FPV", this.state.debug);
    const reconstruction = this.reconFlight("FPV", "ORBIT", true);
    this.flyArc(pose, EARTH_CLIMB_MS, (progress) => {
      // The map's coarse ground near the camera stays behind the photograph until it is well above it.
      this.panorama?.setPresentationOpacity(1 - THREE.MathUtils.smoothstep(progress, 0.04, 0.22));
      earth.setOpacity(THREE.MathUtils.smoothstep(progress, 0.06, 0.28));
      if (progress > 0.22) this.sceneGraph?.setViewMode("ORBIT", this.state.debug);
      reconstruction?.update(progress);
    }, () => {
      earth.setOpacity(1);
      this.panorama?.setVisible(false);
      this.panorama?.setPresentationOpacity(1);
      reconstruction?.done();
      this.endNavigationTransition();
    });
  }

  /** From one view above the space to another, bringing the map in or taking it away. */
  private glideOverEarth(pose: CameraPose, show: boolean) {
    const earth = this.earth!;
    const start = earth.opacity;
    this.isNavigating = true;
    this.state.navigating = true;
    this.controls.enabled = false;
    const reconstruction = this.reconFlight("ORBIT", "ORBIT");
    this.flyArc(pose, EARTH_GLIDE_MS, (progress) => {
      earth.setOpacity(show ? Math.max(start, THREE.MathUtils.smoothstep(progress, 0, 0.5)) : start * (1 - THREE.MathUtils.smoothstep(progress, 0.2, 0.8)));
      reconstruction?.update(progress);
    }, () => {
      earth.setOpacity(show ? 1 : 0);
      reconstruction?.done();
      this.endNavigationTransition();
    });
  }

  /**
   * Fly around the target instead of straight at it: the distance changes
   * evenly in proportion, the way a map zooms, and the camera swings from one
   * side to the other on the way.
   */
  private flyArc(pose: CameraPose, duration: number, onUpdate?: (progress: number) => void, onComplete?: () => void) {
    const fromTarget = this.controls.target.clone();
    const fromOffset = this.camera.position.clone().sub(fromTarget);
    const toOffset = pose.position.clone().sub(pose.target);
    // Shifted so the last meters near the ground go quickly.
    const shift = 15 * (this.earthPlace()?.scale ?? 1);
    const fromLog = Math.log(fromOffset.length() + shift);
    const toLog = Math.log(toOffset.length() + shift);
    const fromDirection = fromOffset.lengthSq() > 1e-10 ? fromOffset.normalize() : new THREE.Vector3(0, 0, 1);
    const toDirection = toOffset.lengthSq() > 1e-10 ? toOffset.normalize() : new THREE.Vector3(0, 1, 0);
    const turn = new THREE.Quaternion().setFromUnitVectors(fromDirection, toDirection);
    const step = new THREE.Quaternion();
    const identity = new THREE.Quaternion();
    const direction = new THREE.Vector3();
    const fromFov = this.camera.fov;
    this.cameraTween?.cancel();
    this.cameraTween = createTween({
      duration,
      easing: (value) => 0.5 - Math.cos(Math.PI * value) / 2,
      onUpdate: (value) => {
        step.slerpQuaternions(identity, turn, value);
        direction.copy(fromDirection).applyQuaternion(step);
        const distance = Math.max(0, Math.exp(fromLog + (toLog - fromLog) * value) - shift);
        this.controls.target.lerpVectors(fromTarget, pose.target, value);
        this.camera.position.copy(this.controls.target).addScaledVector(direction, Math.max(distance, 1e-3));
        this.camera.fov = fromFov + (pose.fov - fromFov) * value;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(this.controls.target);
        onUpdate?.(value);
      },
      onComplete: () => {
        this.setCameraPose(pose);
        onComplete?.();
      }
    });
  }

  private flyTo(pose: CameraPose, instant = false, onComplete?: () => void, onUpdate?: (progress: number) => void,
    duration = this.bootstrap.space.space_data.navigationTransition?.navigationMs ?? 1100) {
    if (instant) {
      this.cameraTween?.cancel();
      this.cameraTween = null;
      this.setCameraPose(pose, true);
      onComplete?.();
      return;
    }

    const fromPosition = this.camera.position.clone();
    const fromTarget = this.controls.target.clone();
    const fromFov = this.camera.fov;
    this.cameraTween?.cancel();
    this.cameraTween = createTween({
      duration,
      onUpdate: (value) => {
        this.camera.position.lerpVectors(fromPosition, pose.position, value);
        this.controls.target.lerpVectors(fromTarget, pose.target, value);
        this.camera.fov = fromFov + (pose.fov - fromFov) * value;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(this.controls.target);
        onUpdate?.(value);
      },
      onComplete
    });
  }

  private setCameraPose(pose: CameraPose, updateControls = false) {
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    if (updateControls) this.controls.update();
  }

  private poseForPoint(point: TourPoint | undefined, mode: "FPV" | "ORBIT"): CameraPose {
    if (mode === "ORBIT" && point?.earth) {
      const pose = this.earthPoseFor(point);
      if (pose) return pose;
    }
    if (point?.targetType === 'FREE' && point.position) {
      const distance = point.distance === undefined ? undefined : point.distance / Math.min(1, this.camera.aspect);
      return this.poseForTarget(vectorFromLike(point.position), point.rotation, point.zoom, mode, point.fov, distance);
    }
    if (point?.targetType === 'MODEL') {
      const bounds = this.sceneGraph?.getBounds(point.models);
      const target = bounds && !bounds.isEmpty() ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
      const position = vectorFromLike(point.position, target.clone().add(new THREE.Vector3(4, 3, 4)));
      if (bounds && !bounds.isEmpty()) {
        // Preserve the authored viewing direction while fitting the object at
        // neutral zoom. Authored zoom can still move in for a detail stop.
        const radius = bounds.getSize(new THREE.Vector3()).length() * 0.5;
        const halfAngle = Math.atan(Math.tan(THREE.MathUtils.degToRad(35)) * Math.min(1, this.camera.aspect));
        const distance = radius / Math.sin(halfAngle) * 1.08;
        const direction = position.clone().sub(target);
        if (direction.lengthSq() === 0) direction.set(0, 0, 1);
        if (direction.length() < distance) position.copy(target).addScaledVector(direction.normalize(), distance);
      }
      return { position, target, fov: point.fov === undefined ? THREE.MathUtils.clamp(70 - (point.zoom ?? 0), 35, 85) : THREE.MathUtils.clamp(point.fov, 30, 110) };
    }
    if (mode === 'ORBIT' && point?.viewMode === 'ORBIT' && point.rotation) {
      // Like a dollhouse, the view frames the captured space; a large authored model
      // around it (a whole plateau, say) is scenery and does not push the camera back.
      const capture = (point.models ?? []).filter((id) => this.sceneGraph?.isCapture(id));
      const bounds = this.sceneGraph?.getBounds(capture.length ? capture : point.models);
      if (bounds && !bounds.isEmpty()) {
        const pose = this.overviewPose(bounds);
        const distance = pose.position.distanceTo(pose.target);
        pose.position.copy(pose.target).addScaledVector(cameraDirection(point.rotation), -distance);
        return pose;
      }
    }
    const node = this.resolveNode(point?.nodeUUID);
    if (node) return this.poseForNode(node, mode, point);

    if (mode === 'ORBIT') {
      const bounds = this.sceneGraph?.getBounds();
      if (bounds && !bounds.isEmpty()) return this.overviewPose(bounds);
    }

    const position = vectorFromLike(
      point?.position ?? this.bootstrap.space.space_data.initialPosition ?? { x: 0, y: 1.5, z: 4 }
    );
    return this.poseForTarget(position, point?.rotation ?? this.bootstrap.space.space_data.initialRotation, point?.zoom, mode, point?.fov, point?.distance);
  }

  // ---- The 3D map under the space ----

  /** Where the tour puts the space on the map; the place covers the opening space only. */
  private earthPlace(): EarthPlace | null {
    return this.state.activeSpaceIndex === 0 ? this.tour.place ?? null : null;
  }

  /** The floor at a panorama location, where the camera takes off for the map and lands. */
  private floorOf(node: NodeData) {
    if (this.nav) return node.floorPosition ? this.nav.getWorldFloorPosition(node) : this.nav.getWorldPosition(node).sub(new THREE.Vector3(0, 1.5, 0));
    return vectorFromLike(node.floorPosition ?? node.position);
  }

  /** The location in the space that sits at the place's latitude and longitude. */
  private placeAnchor(place: EarthPlace) {
    const data = this.bootstrap.space.space_data;
    const node = this.resolveNode(place.nodeId) ?? (data.noPanos ? null : this.resolveNode(data.initialNode) ?? this.getNodes()[0]);
    return node ? this.floorOf(node) : new THREE.Vector3();
  }

  /** What a stop above the map looks down on: the floor at its location, or its target. */
  private earthTarget(point: TourPoint) {
    const node = this.resolveNode(point.nodeUUID);
    if (node) return this.floorOf(node);
    return vectorFromLike(point.position ?? this.bootstrap.space.space_data.initialPosition, this.getSpaceBounds().getCenter(new THREE.Vector3()));
  }

  private earthPoseFor(point: TourPoint): CameraPose | null {
    const place = this.earthPlace();
    // Without the map (no key on this site), the stop shows the usual overview instead.
    if (!place || !point.earth || this.earth?.available === false) return null;
    return earthPose(this.earthTarget(point), point.earth, point.rotation, place.scale ?? 1);
  }

  /**
   * Load the map once a stop above it is next or current, and fetch it as seen
   * from that stop. Until then the tour costs no map requests.
   */
  private prepareEarth(takeoff: NodeData | null) {
    const place = this.earthPlace();
    const points = this.tour.spaces[this.state.activeSpaceIndex]?.tourpoints ?? [];
    const index = this.state.activePointIndex;
    const upcoming = [points[index], points[index + 1]].find((point) => point?.earth);
    if (!place || !upcoming) {
      this.earth?.preload(null);
      return;
    }
    const anchor = this.placeAnchor(place);
    if (this.earth) this.earth.setPlace(place, anchor);
    else this.earth = this.createEarth(place, anchor);
    void this.earth.load();
    // Above the map, fetch the ground where the tour lands next, so the dive meets detail.
    const landing = upcoming === points[index] && points[index + 1] && !points[index + 1].earth ? points[index + 1] : null;
    this.earth.preload(landing ? this.poseForPoint(landing, "FPV") : this.earthPoseFor(upcoming));
    if (takeoff && !this.earth.visible) this.earth.setFocus(this.floorOf(takeoff));
  }

  private createEarth(place: EarthPlace, anchor: THREE.Vector3) {
    const earth = new EarthLayer(this.scene, this.camera, this.renderer, place, anchor);
    earth.setPath(this.getNodes().map((node) => this.floorOf(node)));
    return earth;
  }

  private updateEarth(now: number) {
    const earth = this.earth;
    if (!earth) return;
    earth.update();
    // Over the map, the camera stays above the horizon.
    const lowest = earth.visible ? THREE.MathUtils.degToRad(84) : Math.PI;
    if (this.controls.maxPolarAngle !== lowest) this.controls.maxPolarAngle = lowest;
    if (now - this.lastEarthCredits < 1000) return;
    this.lastEarthCredits = now;
    const credits = earth.visible ? earth.credits() : "";
    if ((this.state.earth?.credits ?? null) === (earth.visible ? credits : null)) return;
    this.state.earth = earth.visible ? { credits } : undefined;
    this.emitState();
  }

  /**
   * Keep depth steady for what is in view: the map from the ground to
   * kilometers up, and a reconstruction's sea and distant scenery several
   * kilometers out. Otherwise near enough for things right at the eye.
   */
  private updateNearPlane() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = this.earth?.visible ? earthNear(distance)
      : this.reconstruction?.visible ? THREE.MathUtils.clamp(distance * 0.002, RECONSTRUCTION_NEAR, 2) : NEAR;
    if (Math.abs(this.camera.near - near) > near * 0.05) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  // ---- The site's reconstruction ----

  /** Whether the reconstruction is wanted in a view mode: in the dollhouse unless turned off, in first person when turned on. */
  private reconWanted(mode: ViewMode) {
    return mode === "ORBIT" ? this.reconOrbit !== false : this.reconFpv === true;
  }

  /** How much of the reconstruction a view mode should show: wanted, and loaded. */
  private reconTarget(mode: ViewMode) {
    return this.reconstruction?.ready && this.reconWanted(mode) ? 1 : 0;
  }

  private setReconWanted(mode: ViewMode, wanted: boolean) {
    if (!this.reconstruction) return;
    if (mode === "ORBIT") this.reconOrbit = wanted;
    else this.reconFpv = wanted;
    if (wanted) void this.loadReconstruction();
  }

  /**
   * The scene graph models a stop shows. Where a guided stop shows the site's
   * reconstruction, it stands in for the tour's own models of the site (an
   * authored plateau model, say) as well as the capture; they still frame the view.
   */
  private stopModels(point?: TourPoint) {
    const models = point?.models ?? [];
    if (point?.reconstruction !== true || !this.reconstruction || this.reconstruction.failed || !this.tourShowsStops()) return models;
    return models.filter((id) => this.sceneGraph?.isCapture(id));
  }

  /** Stops change what shows only in a guided tour or hunt, or while the builder plays them. */
  private tourShowsStops() {
    return this.state.guided || (this.editing && this.tour.hasGuidedTour);
  }

  /** A step between panoramas with the reconstruction in view, before or after it. */
  private reconstructionMove() {
    return Boolean(this.reconstruction?.ready) && ((this.reconAmount ?? 0) > 0 || this.reconTarget("FPV") > 0);
  }

  /**
   * What clicks and walls are tested against: the surfaces in view. The
   * reconstruction while it shows, with the capture until it has fully taken
   * its place, so nothing unseen catches a click or hides a placed object.
   */
  private surfaceTargets() {
    const capture = this.sceneGraph?.getRaycastObjects() ?? [];
    const model = this.reconstruction?.getRaycastObjects() ?? [];
    if (!model.length) return capture;
    return this.sceneGraph?.captureReplaced ? model : [...model, ...capture];
  }

  /** Load the reconstruction now (once), then bring it in if the current view wants it. */
  private async loadReconstruction() {
    const reconstruction = this.reconstruction;
    if (!reconstruction || reconstruction.ready || reconstruction.failed) return;
    if (this.reconTimer) clearTimeout(this.reconTimer);
    this.reconTimer = null;
    // load() shares its promise, including a download already started in the background.
    const loading = reconstruction.load();
    this.emitState();
    await loading;
    if (this.disposed || this.reconstruction !== reconstruction) return;
    if (!this.isNavigating) this.settleReconstruction();
    this.emitState();
  }

  /** The reconstruction at rest in a view mode, `amount` of the way in. */
  private reconDisplay(mode: ViewMode, amount: number): ReconstructionDisplay {
    // In first person the model stays solid and the photographs fade over it, a clean crossfade.
    if (mode === "FPV") return { model: amount > 0 ? 1 : 0, sky: amount > 0 ? 1 : 0, veil: amount, capture: amount > 0 ? 0 : 1 };
    // In the dollhouse it trades places with the capture mesh.
    return { model: amount, sky: amount, veil: 0, capture: amount > 0 ? 0 : 1 };
  }

  private showReconstruction(display: ReconstructionDisplay) {
    const reconstruction = this.reconstruction;
    if (!reconstruction?.ready) return;
    reconstruction.setOpacity(display.model);
    reconstruction.setSky(display.sky);
    this.panorama?.setVeil(display.veil);
    // Overlapping site meshes fight for depth, even during a fade. Draw one surface at a time.
    this.sceneGraph?.setCaptureOpacity(display.model > 0 ? 0 : display.capture);
    this.nav?.setOverlay(display.model > 0);
  }

  /** Fade the reconstruction in or out to what the current view wants. */
  private settleReconstruction(duration = RECONSTRUCTION_FADE_MS) {
    if (!this.reconstruction?.ready) return;
    const mode = this.state.viewMode;
    const target = this.reconTarget(mode);
    const start = this.reconAmount ?? 0;
    this.reconTween?.cancel();
    this.reconTween = null;
    if (Math.abs(target - start) < 1e-3) {
      this.reconAmount = target;
      this.showReconstruction(this.reconDisplay(mode, target));
      return;
    }
    this.reconTween = createTween({
      duration: duration * Math.abs(target - start),
      easing: (value) => THREE.MathUtils.smootherstep(value, 0, 1),
      onUpdate: (value) => {
        this.reconAmount = start + (target - start) * value;
        this.showReconstruction(this.reconDisplay(mode, this.reconAmount));
      }
    });
  }

  /**
   * The reconstruction through a flight from one view mode to another: an
   * update for each frame of the flight and the state it lands in. In first
   * person the model stays solid while the photographs fade over it; in the
   * dollhouse it crossfades with the capture mesh. Nothing to do until it loads.
   */
  private reconFlight(from: ViewMode, to: ViewMode, climb = false) {
    this.reconTween?.cancel();
    this.reconTween = null;
    if (!this.reconstruction?.ready) return null;
    const start = this.reconAmount ?? 0;
    const end = this.reconTarget(to);
    this.reconAmount = end;
    if (!start && !end) return null;
    const smooth = THREE.MathUtils.smoothstep;
    const between = (progress: number) => start + (end - start) * progress;
    let update: (progress: number) => void;
    if (from === "FPV" && to === "FPV") {
      // Between panoramas, the photographs go early in the step, or come back as the camera arrives.
      update = (progress) => this.showReconstruction({ model: 1, sky: 1, capture: 0,
        veil: between(end > start ? smooth(progress, 0, 0.3) : smooth(progress, 0.65, 1)) });
    } else if (from === "ORBIT" && to === "ORBIT") {
      update = (progress) => this.showReconstruction(this.reconDisplay("ORBIT", between(smooth(progress, 0.15, 0.85))));
    } else if (from === "ORBIT") {
      // Into a panorama, `progress` is the flight's blend toward the photograph, which comes up over a solid model.
      update = (blend) => this.showReconstruction({ model: end >= start ? between(blend) : start, sky: end * blend, veil: end, capture: 1 - start });
    } else if (climb) {
      // Up to the map, the photograph fades by 22% of the climb, where the dollhouse takes over.
      update = (progress) => this.showReconstruction({
        model: end >= start ? 1 : between(smooth(progress, 0.22, 0.4)),
        sky: start * (1 - smooth(progress, 0.06, 0.28)),
        veil: start,
        capture: progress > 0.22 ? 1 - end : 1 - start
      });
    } else {
      // Up to the dollhouse, the photograph is gone at once and the capture and the model trade places on the way.
      update = (progress) => this.showReconstruction({ ...this.reconDisplay("ORBIT", between(smooth(progress, 0.1, 0.6))), sky: start * (1 - smooth(progress, 0, 0.3)) });
    }
    update(0);
    return { update, done: () => this.showReconstruction(this.reconDisplay(to, end)) };
  }

  private reconstructionState(): RuntimeState["reconstruction"] {
    const reconstruction = this.reconstruction;
    if (!reconstruction) return undefined;
    // Its title and credit show once it can be seen.
    const { title, credit } = reconstruction.ready ? reconstruction.info : {};
    return {
      available: !reconstruction.failed,
      visible: !reconstruction.failed && this.reconWanted(this.state.viewMode),
      loading: reconstruction.busy,
      ...(title ? { title } : {}),
      ...(credit ? { credit } : {}),
      ...(reconstruction.variants.length ? { variant: reconstruction.selectedVariant, variants: reconstruction.variants } : {})
    };
  }

  private poseForNode(node: NodeData, mode: "FPV" | "ORBIT", point?: TourPoint): CameraPose {
    if (mode === "ORBIT") {
      let bounds = this.sceneGraph?.getBounds();
      if (bounds && this.nav) {
        const nodes = this.getNodes();
        bounds = panoramaOverviewBounds(bounds,
          nodes.map((entry) => this.nav!.getWorldPosition(entry)),
          nodes.filter((entry) => entry.floorPosition && !entry.floorUnobserved)
            .map((entry) => this.nav!.getWorldFloorPosition(entry)));
      }
      if (bounds && !bounds.isEmpty()) {
        return this.overviewPose(bounds);
      }
    }
    const target = this.nav?.getWorldPosition(node) ?? vectorFromLike(node.position);
    return this.poseForTarget(target, point?.rotation ?? this.bootstrap.space.space_data.initialRotation, point?.zoom, mode, point?.fov);
  }

  private overviewPose(bounds: THREE.Box3): CameraPose {
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() * 0.5;
    const fov = 50;
    const fit = radius / Math.sin(THREE.MathUtils.degToRad(fov * .5)) / Math.min(1, this.camera.aspect);
    return { position: center.clone().add(new THREE.Vector3(.7, 1, .85).normalize().multiplyScalar(fit)), target: center, fov };
  }

  private poseForTarget(target: THREE.Vector3, rotation = { azimuth: 0, polar: 0 }, zoom = 0, mode: "FPV" | "ORBIT", authoredFov?: number, distance = 8) {
    const direction = cameraDirection(rotation);
    const fov = authoredFov === undefined ? THREE.MathUtils.clamp((mode === "FPV" ? 75 : 70) - zoom, 35, 85) : THREE.MathUtils.clamp(authoredFov, 30, 110);
    if (mode === "ORBIT") {
      return {
        position: target.clone().add(direction.clone().multiplyScalar(-(Number.isFinite(distance) && distance > 0 ? distance : 8))),
        target: target.clone(),
        fov: THREE.MathUtils.clamp(fov, 45, 85)
      };
    }

    return {
      position: target.clone(),
      target: target.clone().add(direction.multiplyScalar(0.1)),
      fov
    };
  }

  private updateControlsForViewMode() {
    const orbit = this.state.viewMode === "ORBIT";
    this.controls.enablePan = orbit;
    this.controls.enableZoom = orbit;
    this.controls.rotateSpeed = orbit ? 0.4 : -0.32;
    this.controls.zoomSpeed = 0.8;
    // Splats come at any scale; above one the camera can come in to half an eye height.
    this.controls.minDistance = orbit ? (this.walksOnSplats() ? Math.min(1, this.eyeHeight() * 0.5) : 1) : 0.1;
    // Large metric captures need portrait framing distances beyond 150 meters.
    // Let the bounds-based camera pose fit the entire survey without clamping it.
    this.controls.maxDistance = orbit ? Infinity : 0.1;
  }

  private beginNavigationTransition(outgoingNode: NodeData | null) {
    const config = this.bootstrap.space.space_data.navigationTransition;
    if (config?.enabled === false || !outgoingNode || !this.panorama || !this.sceneGraph) return null;
    if (!this.cubeRenderTarget || !this.cubeCamera || !this.cubeScene) return null;

    this.navigationReleaseTween?.cancel();
    this.navigationReleaseTween = null;
    this.transitionMeshTween?.cancel();
    this.transitionMeshTween = null;

    this.isNavigating = true;
    this.state.navigating = true;
    const origin = this.nav?.getWorldPosition(outgoingNode) ?? vectorFromLike(outgoingNode.position);
    this.panorama.prepareTransitionCapture(this.cubeScene, outgoingNode, origin);
    this.cubeCamera.position.copy(origin);
    this.cubeCamera.update(this.renderer, this.cubeScene);

    const meshState = this.sceneGraph.showNavigationTransition(this.cubeRenderTarget.texture, {
      origin,
      meshIds: config?.meshIds,
      opacity: config?.opacity,
      fadeMs: config?.meshFadeMs
    });
    if (!meshState) {
      this.panorama.clearTransitionCapture();
      return null;
    }

    const navigationMs = config?.navigationMs ?? 1100;
    const fadeMs = Math.min(meshState.fadeMs, navigationMs * 0.4);
    this.transitionMeshTween = createTween({
      duration: navigationMs,
      easing: (value) => value,
      onUpdate: (value) => {
        const fade = Math.max(0, (value * navigationMs - (navigationMs - fadeMs)) / fadeMs);
        this.sceneGraph?.setNavigationTransitionOpacity(meshState.initialOpacity * (1 - fade));
      },
      onComplete: () => {
        this.sceneGraph?.restoreNavigationTransition();
      }
    });

    this.emitState();
    return {
      navigationMs,
      fadeStart: 1 - fadeMs / navigationMs
    };
  }

  private scheduleNavigationTransitionEnd(duration: number) {
    this.navigationReleaseTween?.cancel();
    this.navigationReleaseTween = createTween({
      duration,
      easing: (value) => value,
      onUpdate: () => {},
      onComplete: () => this.endNavigationTransition()
    });
  }

  private endNavigationTransition() {
    this.sceneGraph?.restoreNavigationTransition();
    this.nav?.setVisible(true);
    this.nav?.endTransition();
    this.panorama?.clearTransitionCapture();
    this.isNavigating = false;
    this.state.navigating = false;
    this.controls.enabled = true;
    // A reconstruction turned on or off, or loaded, during the flight comes in now.
    this.settleReconstruction();
    this.emitState();
  }

  private handleMeshFloorNavigation() {
    const config = this.bootstrap.space.space_data.clickNavigation;
    if (config?.enabled === false || (config?.type ?? "mesh-floor") !== "mesh-floor") return;
    if (!this.bootstrap.space.space_data.noPanos && !config) return;

    const targets = this.sceneGraph?.getRaycastObjects() ?? [];
    if (!targets.length) return;

    const hit = this.raycaster.intersectObjects(targets, true).find((item) => Boolean(item.face));
    if (!hit) return;

    const maxHitY = config?.maxHitY ?? 0;
    if (hit.point.y >= maxHitY) return;

    const yOffset = config?.yOffset ?? 1.8;
    const position = hit.point.clone();
    position.y += yOffset;
    const direction = this.camera.getWorldDirection(new THREE.Vector3()).normalize();
    this.flyTo({
      position,
      target: position.clone().add(direction.multiplyScalar(0.1)),
      fov: this.camera.fov
    });
  }

  private resolveInitialNode() {
    const nodes = this.getNodes();
    const initialNodeId = this.bootstrap.space.space_data.initialNode;
    if (initialNodeId) {
      const node = this.resolveNode(initialNodeId);
      if (node) return node;
    }

    const index = this.bootstrap.space.space_data.initialNavPoint;
    if (typeof index === "number") return nodes[index] ?? null;
    return nodes[0] ?? null;
  }

  private resolveNode(uuid?: string | null) {
    if (!uuid) return null;
    return this.getNodes().find((node) => node.uuid === uuid) ?? null;
  }

  private getNodes() {
    return this.bootstrap.space.space_data.nodes ?? this.bootstrap.space.space_data.navPoints ?? [];
  }

  private getSplatConfigs(): SplatConfig[] {
    const explicit = this.bootstrap.space.space_data.splats ?? [];
    if (explicit.length) return explicit;
    const mesh = this.bootstrap.space.mesh;
    if (mesh && /\.(splat|ply|spz|ksplat|sog|rad)$/i.test(mesh)) return [{ id: "space-mesh", url: mesh, lod: true }];
    return [];
  }

  private getIiifConfigs(): IiifConfig[] {
    const iiif = this.bootstrap.space.space_data.iiif;
    const configs = Array.isArray(iiif) ? iiif : iiif ? [iiif] : [];
    if (configs.length) return configs;
    if (this.bootstrap.space.type === "iiif" && this.bootstrap.space.src) {
      return [{ id: "space-iiif", url: this.bootstrap.space.src, position: [0, 2, -4] }];
    }
    return [];
  }

  private hasTransitionMeshConfig(nodes: SceneGraphNode[]): boolean {
    return nodes.some((node) => {
      if (
        node.transitionMesh === true ||
        typeof node.transitionOpacity === "number" ||
        node.transitionTexture === "cube-render-target"
      ) {
        return true;
      }
      return this.hasTransitionMeshConfig(node.children ?? []);
    });
  }

  private previousPowerOfTwo(value: number) {
    return 2 ** Math.floor(Math.log2(Math.max(1, value)));
  }

  private applyAtmosphere(extra?: string) {
    if (extra === "nightMode") {
      this.atmosphereExposure = this.renderer.toneMappingExposure = 0.78;
      this.scene.fog = new THREE.FogExp2(0x050711, 0.014);
    } else {
      this.atmosphereExposure = this.renderer.toneMappingExposure = 1.15;
      this.scene.fog = this.getNodes().length ? null : new THREE.FogExp2(0x090b12, 0.008);
    }
  }

  private applySkyboxMode(extra?: string) {
    if (!this.skybox) return;
    if (extra === "nightMode") {
      this.skybox.changeToNight();
      this.skybox.fadeIn();
      return;
    }

    this.skybox.changeToDay();
    if (extra === "shrinkToPoints" || extra === "projectToSplats") {
      this.skybox.fadeOut();
    } else {
      this.skybox.fadeIn();
    }
  }

  private setLoading(loading: LoadingState) {
    this.state.loading = loading;
    this.callbacks.onLoading?.(loading);
    this.emitState();
  }

  private emitState() {
    this.canvas.dataset.sphrState = JSON.stringify(this.getDebugSnapshot());
    this.callbacks.onState?.(this.getState());
  }
}
