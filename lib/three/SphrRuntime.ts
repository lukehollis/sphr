import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { activeTourPoint, normalizeTour } from "@/lib/bootstrap";
import type {
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
import { AudioController } from "@/lib/three/AudioController";
import { AnnotationLayer } from "@/lib/three/layers/AnnotationLayer";
import { CursorLayer } from "@/lib/three/layers/CursorLayer";
import { NavigationLayer } from "@/lib/three/layers/NavigationLayer";
import { SceneGraphLayer } from "@/lib/three/layers/SceneGraphLayer";
import { SkyboxLayer } from "@/lib/three/layers/SkyboxLayer";
import { IiifImageLayer } from "@/lib/three/renderers/IiifImageLayer";
import { PanoramaLayer } from "@/lib/three/renderers/PanoramaLayer";
import { SparkSplatLayer } from "@/lib/three/renderers/SparkSplatLayer";
import { selectNavigationTarget } from "@/lib/three/navigation";
import { panoramaOverviewBounds } from "@/lib/three/overview";
import { cameraDirection, vectorFromLike } from "@/lib/three/math";
import { createTween, type Tween } from "@/lib/three/tween";

type CameraPose = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
};

export class SphrRuntime {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(80, 1, 0.02, 20000);
  readonly renderer: THREE.WebGLRenderer;

  private readonly tour;
  private readonly manager = new THREE.LoadingManager();
  private readonly textureCache: TextureCache;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerDown = new THREE.Vector2();
  private activePointerId: number | null = null;
  private pointerMoved = false;
  private controls: OrbitControls;
  private audio: AudioController;
  private splats: SparkSplatLayer | null = null;
  private panorama: PanoramaLayer | null = null;
  private iiif: IiifImageLayer | null = null;
  private nav: NavigationLayer | null = null;
  private skybox: SkyboxLayer | null = null;
  private sceneGraph: SceneGraphLayer | null = null;
  private cursor: CursorLayer | null = null;
  private annotations: AnnotationLayer | null = null;
  private tweens: Tween[] = [];
  private cameraTween: Tween | null = null;
  private transitionMeshTween: Tween | null = null;
  private navigationReleaseTween: Tween | null = null;
  private animationStarted = false;
  private currentNode: NodeData | null = null;
  private cubeRenderTarget: THREE.WebGLCubeRenderTarget | null = null;
  private cubeCamera: THREE.CubeCamera | null = null;
  private cubeScene: THREE.Scene | null = null;
  private isNavigating = false;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private readonly state: RuntimeState;

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
    this.textureCache = new TextureCache(this.manager);
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

  async init(initialPointIndex?: number) {
    this.setupRendererSize();
    this.setupScene();
    this.setupControls();
    this.setupNavigationTransitionRenderTarget();
    this.setupLoadingEvents();
    this.attachEvents();

    const nodes = this.getNodes();
    const exploreEntry = !this.tour.hasGuidedTour ? this.resolveInitialNode() : null;
    const initialLocation = (initialPointIndex === undefined ? null : { spaceIndex: 0, pointIndex: initialPointIndex })
      || (exploreEntry && this.findTourPointForNode(exploreEntry.uuid))
      || { spaceIndex: 0, pointIndex: 0 };
    this.state.activeSpaceIndex = initialLocation.spaceIndex;
    this.state.activePointIndex = initialLocation.pointIndex;
    const initialPoint = activeTourPoint(this.tour, initialLocation.spaceIndex, initialLocation.pointIndex);
    this.currentNode = this.resolveNode(initialPoint?.nodeUUID) ?? this.resolveInitialNode();
    this.setCameraPose(this.poseForPoint(initialPoint, "FPV"), true);

    if (nodes.length) {
      this.nav = new NavigationLayer(this.scene, this.bootstrap.space.space_data, nodes);
      this.nav.init();
      this.nav.setActive(this.currentNode?.uuid);
    }

    if (!this.bootstrap.space.space_data.noPanos && nodes.length) {
      this.panorama = new PanoramaLayer(this.scene, this.textureCache, this.bootstrap.space.version);

    }

    if (this.bootstrap.space.space_data.skybox) {
      this.skybox = new SkyboxLayer(this.scene, this.manager, this.bootstrap.space.space_data.skybox);
    }

    const splatConfigs = this.getSplatConfigs();
    if (splatConfigs.length) {
      this.splats = new SparkSplatLayer(this.scene, this.renderer, splatConfigs, (loaded, total, label) => {
        const progress = total ? loaded / total : 0.2;
        this.setLoading({ label: `Loading ${label}`, progress: Math.max(this.state.loading.progress, progress), ready: false });
      });
    }

    const iiifConfigs = this.getIiifConfigs();
    if (iiifConfigs.length) {
      this.iiif = new IiifImageLayer(this.scene, this.textureCache, iiifConfigs);
    }

    this.sceneGraph = new SceneGraphLayer(this.scene, this.tour.sceneGraph);
    this.cursor = new CursorLayer();
    this.annotations = new AnnotationLayer(this.scene, this.textureCache, this.tour.annotationGraph);

    await Promise.all([
      this.panorama?.loadInitial(this.currentNode),
      this.skybox?.init(),
      this.splats?.init(),
      this.iiif?.init(),
      this.sceneGraph.init()
    ]);
    if (this.disposed) { this.sceneGraph.dispose(); return; }
    this.annotations.init();
    this.nav?.setOccluders(this.sceneGraph.getRaycastObjects());

    await this.goTo(initialLocation.spaceIndex, initialLocation.pointIndex, true);
    this.setLoading({ label: "Ready", progress: 1, ready: true });
    this.emitState();
    this.startAnimationLoop();
  }

  start(guided: boolean) {
    guided = guided && this.tour.hasGuidedTour;
    this.state.guided = guided;
    this.state.showText = guided ? this.tour.defaultShowText : false;
    const point = this.getActivePoint();
    if (guided) {
      this.audio.updateForPoint(point);
      this.annotations?.show(point.annotations ?? point.overlays ?? []);
      this.sceneGraph?.showOnly(point.models ?? []);
    }
    if (!guided) {
      this.audio.updateForPoint();
      this.annotations?.hideAll();
      this.sceneGraph?.hideAll();
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
    const point = activeTourPoint(this.tour, spaceIndex, pointIndex);
    if (!point) return;
    if (this.isNavigating && !instant) return;

    const fromOverview = this.state.viewMode === "ORBIT";
    const outgoingNode = this.currentNode;
    const node = this.resolveNode(point.nodeUUID);
    const nodeChanged = Boolean(node && node.uuid !== outgoingNode?.uuid);
    const heading = this.camera.getWorldDirection(new THREE.Vector3());
    if (nodeChanged || (fromOverview && !instant)) {
      this.isNavigating = true;
      this.state.navigating = true;
      this.controls.enabled = false;
      this.state.navigationError = undefined;
      this.emitState();
      try { if (nodeChanged) await this.panorama?.prepare(node!); }
      catch (error) {
        this.endNavigationTransition();
        this.state.navigationError = error instanceof Error ? error.message : "Unable to load this location";
        this.emitState();
        return;
      }
      if (this.disposed) return;
    }
    const nextViewMode = !forceFirstPerson && point.viewMode === "ORBIT" ? "ORBIT" : "FPV";

    this.state.activeSpaceIndex = spaceIndex;
    this.state.activePointIndex = pointIndex;
    this.state.viewMode = nextViewMode;
    this.updateControlsForViewMode();
    if (this.isNavigating) this.nav?.beginTransition();
    this.nav?.setOrbit(nextViewMode === "ORBIT");

    this.splats?.setStudyMode(point.extra);
    this.applySkyboxMode(point.extra);
    this.applyAtmosphere(point.extra);
    this.annotations?.show(point.annotations ?? point.overlays ?? []);
    this.sceneGraph?.showOnly(point.models ?? []);
    this.sceneGraph?.setViewMode(this.state.viewMode, this.state.debug);

    const returningFromOverview = fromOverview && nextViewMode === "FPV" && !instant;
    const teleport = nodeChanged && !fromOverview && Boolean(outgoingNode?.neighbors && !outgoingNode.neighbors.includes(node!.uuid));
    const navigationMs = teleport ? 700 : this.bootstrap.space.space_data.navigationTransition?.navigationMs ?? 1100;
    const navigationTransition = nodeChanged && !fromOverview && !teleport && !instant && this.state.viewMode === "FPV"
      ? this.beginNavigationTransition(outgoingNode)
      : null;

    if (node) {
      this.currentNode = node;
      this.panorama?.navigate(node, navigationMs, {
        replaceImmediately: returningFromOverview || instant,
        fadeStart: navigationTransition?.fadeStart
      });
      this.nav?.setActive(node.uuid);
    }

    this.audio.play("navigate");
    this.audio.updateForPoint(this.state.guided ? point : undefined, outgoingPoint);

    this.panorama?.setVisible(this.state.viewMode === "FPV");
    const pose = this.poseForPoint(point, this.state.viewMode);
    if (preserveHeading && this.state.viewMode === "FPV") {
      pose.target.copy(pose.position).addScaledVector(heading, 0.1);
      pose.fov = this.camera.fov;
    }
    if (returningFromOverview) this.flyFromOverview(pose);
    else {
      this.flyTo(pose, instant || teleport);
      if (this.isNavigating && !instant) this.scheduleNavigationTransitionEnd(navigationMs);
      else if (this.isNavigating) this.endNavigationTransition();
    }
    if (node) this.prefetchNeighbors(node);
    this.emitState();
  }

  toggleViewMode() {
    if (this.isNavigating) return;
    const newMode = this.state.viewMode === "FPV" ? "ORBIT" : "FPV";
    this.nav?.beginTransition();
    this.state.viewMode = newMode;
    this.updateControlsForViewMode();
    const point = this.getActivePoint();
    const pose = this.currentNode ? this.poseForNode(this.currentNode, newMode, point) : this.poseForPoint(point, newMode);
    this.nav?.setOrbit(newMode === "ORBIT");
    this.panorama?.setVisible(newMode === "FPV");
    this.sceneGraph?.setViewMode(newMode, this.state.debug);
    if (newMode === "FPV") this.flyFromOverview(pose);
    else {
      this.isNavigating = true;
      this.state.navigating = true;
      this.controls.enabled = false;
      this.flyTo(pose, false, () => this.endNavigationTransition());
    }
    this.emitState();
  }

  toggleMute() {
    this.state.muted = !this.state.muted;
    this.audio.setMuted(this.state.muted);
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
    return { ...this.state, activeNodeId: this.currentNode?.uuid, loading: { ...this.state.loading } };
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
    this.audio.dispose();
    this.skybox?.dispose();
    this.splats?.dispose();
    this.panorama?.dispose();
    this.iiif?.dispose();
    this.nav?.dispose();
    this.cursor?.dispose();
    this.sceneGraph?.dispose();
    this.annotations?.dispose();
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
    const ambient = new THREE.AmbientLight(0xf3efe6, 1.7);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff2cf, 3.2);
    sun.position.set(4, 8, 5);
    this.scene.add(sun);
  }

  private setupNavigationTransitionRenderTarget() {
    const config = this.bootstrap.space.space_data.navigationTransition;
    if (config?.enabled === false || !this.hasTransitionMeshConfig(this.tour.sceneGraph)) return;

    const requestedSize = Math.min(config?.cubeRenderTargetSize ?? 1024, window.innerWidth < 768 ? 1024 : 2048);
    const maxSize = this.renderer.capabilities.maxCubemapSize || requestedSize;
    const size = Math.min(maxSize, this.previousPowerOfTwo(Math.max(256, requestedSize)));
    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(size, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      mapping: THREE.CubeReflectionMapping,
      type: THREE.HalfFloatType
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
        label: url.split("/").pop() ?? "Loading",
        progress: Math.max(this.state.loading.progress, progress),
        ready: this.state.loading.ready
      });
    };
  }

  private setupRendererSize() {
    const resize = () => {
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width || window.innerWidth));
      const height = Math.max(1, Math.floor(rect.height || window.innerHeight));
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
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
  }

  private detachEvents() {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeyDown);
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || this.activePointerId !== null) { this.pointerMoved = true; return; }
    this.activePointerId = event.pointerId;
    this.pointerMoved = this.isNavigating || !this.state.loading.ready;
    this.pointerDown.set(event.clientX, event.clientY);
    this.cursor?.hide();
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (this.activePointerId === event.pointerId && Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 5) this.pointerMoved = true;
    if (event.buttons || this.isNavigating) { this.cursor?.hide(); return; }
    const targets = this.sceneGraph?.getRaycastObjects() ?? [];
    if (!targets.length) return;

    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const canNavigate = Boolean(this.nav?.getIntersectedNode(this.raycaster) || this.findPanoramaNavigationNode());
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
    const dx = event.clientX - this.pointerDown.x;
    const dy = event.clientY - this.pointerDown.y;
    if (this.pointerMoved || Math.hypot(dx, dy) > 5 || this.isNavigating || event.button !== 0) return;
    // A single click in dollhouse must not consume the first half of a double click.
    if (this.state.viewMode === "ORBIT") return;

    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const node = this.nav?.getIntersectedNode(this.raycaster);
    if (node && node.uuid !== this.currentNode?.uuid) {
      this.navigateToNode(node);
      return;
    }

    const directionalNode = this.findPanoramaNavigationNode();
    if (directionalNode) {
      this.navigateToNode(directionalNode);
      return;
    }

    this.handleMeshFloorNavigation();
  };

  private handleDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0 || this.state.viewMode !== "ORBIT" || this.isNavigating) return;
    if (this.pointerMoved || Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 5) return;
    event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    ), this.camera);
    const hit = this.raycaster.intersectObjects(this.sceneGraph?.getRaycastObjects() ?? [], true)[0];
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
    if (event.key === "\\") this.toggleDebug();
  };

  navigateNode(uuid: string) {
    const node = this.resolveNode(uuid);
    if (node) void this.navigateToNode(node);
  }

  private async navigateToNode(node: NodeData) {
    if (this.isNavigating) return;
    const fromOverview = this.state.viewMode === "ORBIT";
    const tourPoint = this.findTourPointForNode(node.uuid);
    if (tourPoint) {
      await this.goTo(tourPoint.spaceIndex, tourPoint.pointIndex, false, !fromOverview, fromOverview);
      return;
    }
    this.isNavigating = true;
    this.state.navigating = true;
    this.state.navigationError = undefined;
    this.controls.enabled = false;
    this.emitState();
    try { await this.panorama?.prepare(node); }
    catch (error) {
      this.endNavigationTransition();
      this.state.navigationError = String(error);
      this.emitState();
      return;
    }
    if (this.disposed) return;
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const transition = fromOverview ? null : this.beginNavigationTransition(this.currentNode);
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
      this.flyTo(pose);
      this.scheduleNavigationTransitionEnd(navigationMs);
    }
    this.emitState();
    this.prefetchNeighbors(node);
  }

  private prefetchNeighbors(node: NodeData) {
    const neighbors = this.nav?.getNavigableNodes() ?? [];
    for (const neighbor of neighbors.filter((item) => item.uuid !== node.uuid).slice(0, 2)) {
      void this.panorama?.prepare(neighbor).then(() => this.textureCache.trim()).catch(() => {});
    }
  }

  private findTourPointForNode(nodeUUID: string) {
    for (let spaceIndex = 0; spaceIndex < this.tour.spaces.length; spaceIndex += 1) {
      const space = this.tour.spaces[spaceIndex];
      const pointIndex = space.tourpoints.findIndex((point) => point.nodeUUID === nodeUUID && point.targetType !== 'MODEL');
      if (pointIndex >= 0) return { spaceIndex, pointIndex };
    }
    return null;
  }

  private findPanoramaNavigationNode() {
    if (this.state.viewMode !== "FPV" || !this.currentNode || !this.nav) return null;
    const hit = this.raycaster.intersectObjects(this.sceneGraph?.getRaycastObjects() ?? [], true)[0];
    let floorHit: THREE.Vector3 | null = null;
    if (hit?.face) {
      const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
      if (Math.abs(normal.y) >= 0.7) floorHit = hit.point;
    }
    return selectNavigationTarget(
      this.raycaster.ray,
      // Unknown floors use directly selectable camera spheres, not inferred floor targets.
      this.nav.getNavigableNodes().filter((node) => !node.floorUnobserved)
        .map((node) => ({ value: node, floor: this.nav!.getWorldFloorPosition(node) })),
      this.nav.getWorldFloorPosition(this.currentNode),
      floorHit
    );
  }

  private startAnimationLoop() {
    if (this.animationStarted) return;
    this.animationStarted = true;
    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return;
      const now = performance.now();
      this.tweens = this.tweens.filter((tween) => tween.update(now));
      if (this.cameraTween && !this.cameraTween.update(now)) this.cameraTween = null;
      if (this.transitionMeshTween && !this.transitionMeshTween.update(now)) this.transitionMeshTween = null;
      if (this.navigationReleaseTween && !this.navigationReleaseTween.update(now)) this.navigationReleaseTween = null;
      // OrbitControls clamps FPV distance to 0.1m. It must not rewrite an in-flight pose.
      if (!this.cameraTween) this.controls.update();
      this.skybox?.update(this.camera);
      this.panorama?.update(this.camera);
      this.cursor?.update(now);
      this.renderer.render(this.scene, this.camera);
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
    this.flyTo(pose, false, () => {
      this.panorama?.setPresentationOpacity(1);
      this.sceneGraph?.setOverviewReturnBlend(null);
      this.endNavigationTransition();
    }, (progress) => {
      // Retain spatial depth during the flight; reveal the photo only near its capture origin.
      const blend = THREE.MathUtils.smoothstep(progress, 0.85, 1);
      this.panorama?.setPresentationOpacity(blend);
      this.sceneGraph?.setOverviewReturnBlend(blend);
    });
  }

  private flyTo(pose: CameraPose, instant = false, onComplete?: () => void, onUpdate?: (progress: number) => void) {
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
      duration: this.bootstrap.space.space_data.navigationTransition?.navigationMs ?? 1100,
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
    if (point?.targetType === 'MODEL') {
      const bounds = this.sceneGraph?.getBounds();
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
    const node = this.resolveNode(point?.nodeUUID);
    if (node) return this.poseForNode(node, mode, point);

    if (mode === 'ORBIT') {
      const bounds = this.sceneGraph?.getBounds();
      if (bounds && !bounds.isEmpty()) return this.overviewPose(bounds);
    }

    const position = vectorFromLike(
      point?.position ?? this.bootstrap.space.space_data.initialPosition ?? { x: 0, y: 1.5, z: 4 }
    );
    return this.poseForTarget(position, point?.rotation ?? this.bootstrap.space.space_data.initialRotation, point?.zoom, mode, point?.fov);
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

  private poseForTarget(target: THREE.Vector3, rotation = { azimuth: 0, polar: 0 }, zoom = 0, mode: "FPV" | "ORBIT", authoredFov?: number) {
    const direction = cameraDirection(rotation);
    const fov = authoredFov === undefined ? THREE.MathUtils.clamp((mode === "FPV" ? 75 : 70) - zoom, 35, 85) : THREE.MathUtils.clamp(authoredFov, 30, 110);
    if (mode === "ORBIT") {
      return {
        position: target.clone().add(direction.clone().multiplyScalar(-8)),
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
    this.controls.minDistance = orbit ? 1 : 0.1;
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
      this.renderer.toneMappingExposure = 0.78;
      this.scene.fog = new THREE.FogExp2(0x050711, 0.014);
    } else {
      this.renderer.toneMappingExposure = 1.15;
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
