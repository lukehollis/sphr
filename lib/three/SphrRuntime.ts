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
      guided: true,
      muted: false,
      showText: this.tour.defaultShowText,
      debug: false,
      navigating: false
    };
  }

  async init() {
    this.setupRendererSize();
    this.setupScene();
    this.setupControls();
    this.setupNavigationTransitionRenderTarget();
    this.setupLoadingEvents();
    this.attachEvents();

    const nodes = this.getNodes();
    const initialPoint = activeTourPoint(this.tour, 0, 0);
    this.currentNode = this.resolveNode(initialPoint?.nodeUUID) ?? this.resolveInitialNode();
    this.setCameraPose(this.poseForPoint(initialPoint, "FPV"), true);

    if (nodes.length) {
      this.nav = new NavigationLayer(this.scene, this.bootstrap.space.space_data, nodes);
      this.nav.init();
      this.nav.setActive(this.currentNode?.uuid);
    }

    if (!this.bootstrap.space.space_data.noPanos && nodes.length) {
      this.panorama = new PanoramaLayer(this.scene, this.textureCache, this.bootstrap.space.version);
      this.panorama.loadInitial(this.currentNode);
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
      this.skybox?.init(),
      this.splats?.init(),
      this.iiif?.init(),
      this.sceneGraph.init()
    ]);
    this.annotations.init();

    this.goTo(0, 0, true);
    this.setLoading({ label: "Ready", progress: 1, ready: true });
    this.emitState();
    this.startAnimationLoop();
  }

  start(guided: boolean) {
    this.state.guided = guided;
    this.state.showText = guided ? this.tour.defaultShowText : false;
    const point = this.getActivePoint();
    if (guided) this.audio.updateForPoint(point);
    if (!guided) {
      this.annotations?.hideAll();
      this.sceneGraph?.hideAll();
    }
    this.emitState();
  }

  next() {
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
    if (this.state.activePointIndex > 0) {
      this.goTo(this.state.activeSpaceIndex, this.state.activePointIndex - 1);
      return;
    }
    if (this.state.activeSpaceIndex > 0) {
      const previousSpace = this.tour.spaces[this.state.activeSpaceIndex - 1];
      this.goTo(this.state.activeSpaceIndex - 1, previousSpace.tourpoints.length - 1);
    }
  }

  goTo(spaceIndex: number, pointIndex: number, instant = false) {
    const outgoingPoint = this.getActivePoint();
    const point = activeTourPoint(this.tour, spaceIndex, pointIndex);
    if (!point) return;
    if (this.isNavigating && !instant) return;

    const outgoingNode = this.currentNode;
    const node = this.resolveNode(point.nodeUUID);
    const nodeChanged = Boolean(node && node.uuid !== outgoingNode?.uuid);
    const nextViewMode = point.viewMode === "ORBIT" ? "ORBIT" : "FPV";

    this.state.activeSpaceIndex = spaceIndex;
    this.state.activePointIndex = pointIndex;
    this.state.viewMode = nextViewMode;
    this.updateControlsForViewMode();

    this.splats?.setStudyMode(point.extra);
    this.applySkyboxMode(point.extra);
    this.applyAtmosphere(point.extra);
    this.annotations?.show(point.annotations ?? point.overlays ?? []);
    this.sceneGraph?.showOnly(point.models ?? []);
    this.sceneGraph?.setViewMode(this.state.viewMode, this.state.debug);

    const navigationTransition = nodeChanged && !instant && this.state.viewMode === "FPV"
      ? this.beginNavigationTransition(outgoingNode)
      : null;

    if (node) {
      this.currentNode = node;
      this.panorama?.navigate(node);
      this.nav?.setActive(node.uuid);
    }

    this.audio.play("navigate");
    this.audio.updateForPoint(point, outgoingPoint);

    this.flyTo(this.poseForPoint(point, this.state.viewMode), instant);
    if (navigationTransition) this.scheduleNavigationTransitionEnd(navigationTransition.navigationMs);
    this.emitState();
  }

  toggleViewMode() {
    const newMode = this.state.viewMode === "FPV" ? "ORBIT" : "FPV";
    this.state.viewMode = newMode;
    this.updateControlsForViewMode();
    const point = this.getActivePoint();
    this.flyTo(this.poseForPoint(point, newMode));
    this.panorama?.setVisible(newMode === "FPV");
    this.sceneGraph?.setViewMode(newMode, this.state.debug);
    this.emitState();
  }

  toggleMute() {
    this.state.muted = !this.state.muted;
    this.audio.setMuted(this.state.muted);
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
    return { ...this.state, loading: { ...this.state.loading } };
  }

  getDebugSnapshot() {
    return {
      state: this.getState(),
      raycastTargets: this.sceneGraph?.getRaycastObjects().length ?? 0,
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
    this.scene.fog = new THREE.FogExp2(0x090b12, 0.008);
    const ambient = new THREE.AmbientLight(0xf3efe6, 1.7);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff2cf, 3.2);
    sun.position.set(4, 8, 5);
    this.scene.add(sun);
  }

  private setupNavigationTransitionRenderTarget() {
    const config = this.bootstrap.space.space_data.navigationTransition;
    if (config?.enabled === false || !this.hasTransitionMeshConfig(this.tour.sceneGraph)) return;

    const requestedSize = config?.cubeRenderTargetSize ?? 2048;
    const maxSize = this.renderer.capabilities.maxCubemapSize || requestedSize;
    const size = Math.min(maxSize, this.previousPowerOfTwo(Math.max(256, requestedSize)));
    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(size, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      mapping: THREE.CubeRefractionMapping
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
    window.addEventListener("resize", resize);
  }

  private attachEvents() {
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  private detachEvents() {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("keydown", this.handleKeyDown);
  }

  private handlePointerDown = (event: PointerEvent) => {
    this.pointerDown.set(event.clientX, event.clientY);
  };

  private handlePointerMove = (event: PointerEvent) => {
    const targets = this.sceneGraph?.getRaycastObjects() ?? [];
    if (!targets.length) return;

    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    this.cursor?.updateFromRaycaster(this.raycaster, targets);
  };

  private handlePointerUp = (event: PointerEvent) => {
    const dx = event.clientX - this.pointerDown.x;
    const dy = event.clientY - this.pointerDown.y;
    if (Math.hypot(dx, dy) > 5) return;
    if (this.state.guided && this.state.viewMode === "ORBIT") return;

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

    const directionalNode = this.findDirectionalNavigationNode();
    if (directionalNode) {
      this.navigateToNode(directionalNode);
      return;
    }

    this.handleMeshFloorNavigation();
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "\\") this.toggleDebug();
  };

  private navigateToNode(node: NodeData) {
    if (this.isNavigating) return;
    const tourPoint = this.findTourPointForNode(node.uuid);
    if (tourPoint) {
      this.goTo(tourPoint.spaceIndex, tourPoint.pointIndex);
      return;
    }

    const outgoingNode = this.currentNode;
    const transition = node.uuid !== outgoingNode?.uuid && this.state.viewMode === "FPV"
      ? this.beginNavigationTransition(outgoingNode)
      : null;
    this.currentNode = node;
    this.panorama?.navigate(node);
    this.nav?.setActive(node.uuid);
    this.flyTo(this.poseForNode(node, this.state.viewMode));
    if (transition) this.scheduleNavigationTransitionEnd(transition.navigationMs);
    this.emitState();
  }

  private findTourPointForNode(nodeUUID: string) {
    for (let spaceIndex = 0; spaceIndex < this.tour.spaces.length; spaceIndex += 1) {
      const space = this.tour.spaces[spaceIndex];
      const pointIndex = space.tourpoints.findIndex((point) => point.nodeUUID === nodeUUID);
      if (pointIndex >= 0) return { spaceIndex, pointIndex };
    }
    return null;
  }

  private findDirectionalNavigationNode() {
    if (this.state.viewMode !== "FPV" || !this.currentNode) return null;

    const clickDirection = this.raycaster.ray.direction.clone().normalize();
    let nearestNode: NodeData | null = null;
    let smallestAngle = Number.POSITIVE_INFINITY;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const node of this.getNodes()) {
      if (node.uuid === this.currentNode.uuid) continue;
      const nodePosition = this.nav?.getWorldPosition(node) ?? vectorFromLike(node.position);
      const directionToNode = nodePosition.clone().sub(this.camera.position).normalize();
      const angle = clickDirection.angleTo(directionToNode);
      const distance = this.camera.position.distanceTo(nodePosition);
      if (angle < Math.PI / 8 && angle < smallestAngle && distance < nearestDistance) {
        nearestNode = node;
        smallestAngle = angle;
        nearestDistance = distance;
      }
    }

    return nearestNode;
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
      this.controls.update();
      this.skybox?.update(this.camera);
      this.panorama?.update(this.camera);
      this.updateNavigationTransitionCapture();
      this.cursor?.update(now);
      this.renderer.render(this.scene, this.camera);
      this.cursor?.render(this.renderer, this.camera);
    });
  }

  private flyTo(pose: CameraPose, instant = false, onComplete?: () => void) {
    if (instant) {
      this.setCameraPose(pose, true);
      onComplete?.();
      return;
    }

    const fromPosition = this.camera.position.clone();
    const fromTarget = this.controls.target.clone();
    const fromFov = this.camera.fov;
    this.cameraTween?.cancel();
    this.cameraTween = createTween({
      duration: 1100,
      onUpdate: (value) => {
        this.camera.position.lerpVectors(fromPosition, pose.position, value);
        this.controls.target.lerpVectors(fromTarget, pose.target, value);
        this.camera.fov = fromFov + (pose.fov - fromFov) * value;
        this.camera.updateProjectionMatrix();
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
    const node = this.resolveNode(point?.nodeUUID);
    if (node) return this.poseForNode(node, mode, point);

    const position = vectorFromLike(
      point?.position ?? this.bootstrap.space.space_data.initialPosition ?? { x: 0, y: 1.5, z: 4 }
    );
    return this.poseForTarget(position, point?.rotation ?? this.bootstrap.space.space_data.initialRotation, point?.zoom, mode);
  }

  private poseForNode(node: NodeData, mode: "FPV" | "ORBIT", point?: TourPoint): CameraPose {
    const target = this.nav?.getWorldPosition(node) ?? vectorFromLike(node.position);
    return this.poseForTarget(target, point?.rotation ?? this.bootstrap.space.space_data.initialRotation, point?.zoom, mode);
  }

  private poseForTarget(target: THREE.Vector3, rotation = { azimuth: 0, polar: 0 }, zoom = 0, mode: "FPV" | "ORBIT") {
    const direction = cameraDirection(rotation);
    const fov = THREE.MathUtils.clamp(70 - zoom, 35, 85);
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
    this.controls.rotateSpeed = orbit ? 0.4 : -0.25;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = orbit ? 1 : 0.1;
    this.controls.maxDistance = orbit ? 150 : 0.1;
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
    this.panorama.prepareTransitionCapture(this.cubeScene, outgoingNode, this.camera.position);
    this.updateNavigationTransitionCapture();

    const meshState = this.sceneGraph.showNavigationTransition(this.cubeRenderTarget.texture, {
      meshIds: config?.meshIds,
      opacity: config?.opacity,
      fadeMs: config?.meshFadeMs
    });
    if (!meshState) {
      this.endNavigationTransition();
      return null;
    }

    this.transitionMeshTween = createTween({
      duration: meshState.fadeMs,
      easing: (value) => value,
      onUpdate: (value) => {
        this.sceneGraph?.setNavigationTransitionOpacity(meshState.initialOpacity * (1 - value));
      },
      onComplete: () => {
        this.sceneGraph?.restoreNavigationTransition();
      }
    });

    this.emitState();
    return {
      navigationMs: Math.max(config?.navigationMs ?? 1100, meshState.fadeMs)
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
    this.panorama?.clearTransitionCapture();
    this.isNavigating = false;
    this.state.navigating = false;
    this.emitState();
  }

  private updateNavigationTransitionCapture() {
    if (!this.isNavigating || !this.cubeCamera || !this.cubeScene || !this.panorama) return;
    this.cubeCamera.position.copy(this.camera.position);
    this.panorama.updateTransitionCapture(this.camera.position);
    this.cubeCamera.update(this.renderer, this.cubeScene);
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
      this.scene.fog = new THREE.FogExp2(0x090b12, 0.008);
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
    this.callbacks.onState?.(this.getState());
  }
}
