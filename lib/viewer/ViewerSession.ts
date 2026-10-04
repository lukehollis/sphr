import { normalizeTour } from '@/lib/bootstrap';
import type { RuntimeCallbacks, RuntimeState, SphrBootstrap } from '@/lib/types';
import { SphrRuntime, type ExperienceUpdate, type GizmoMode, type PixelAnchor } from '@/lib/three/SphrRuntime';
import { assertNativeBootstrap } from './native';
import { nextTourLocation, tourSegment } from './segments';

type Stage = { element: HTMLDivElement; key: string; spaceIndex: number; three?: SphrRuntime };

/** Owns tour position across independent scene renderers; failed scene loads retain the last viewer. */
export class ViewerSession {
  private active?: Stage;
  private pending?: Stage;
  private disposed = false;
  private viewInset = 0;
  private switching = false;
  private state: RuntimeState;
  private preferences: { guided: boolean; muted: boolean; showText: boolean };

  constructor(private readonly container: HTMLElement, private readonly bootstrap: SphrBootstrap, private readonly callbacks: RuntimeCallbacks) {
    const tour = normalizeTour(bootstrap);
    this.preferences = { guided: tour.hasGuidedTour, muted: false, showText: tour.defaultShowText };
    this.state = { ...this.preferences, activeSpaceIndex: 0, activePointIndex: 0, viewMode: 'FPV', debug: false,
      navigating: false, loading: { label: 'Loading', progress: 0, ready: false } };
  }

  async init() {
    assertNativeBootstrap(this.bootstrap);
    await this.activate(0);
  }

  private emit() {
    if (this.disposed) return;
    this.state = { ...this.state, ...this.preferences };
    this.container.dataset.sphrSession = JSON.stringify({ ...this.state, engine: 'three', engineKey: this.active?.key });
    this.callbacks.onState?.(this.state);
  }

  private release(stage?: Stage) {
    stage?.three?.dispose();
    stage?.element.remove();
  }

  private async activate(spaceIndex: number, pointIndex?: number) {
    const segment = tourSegment(this.bootstrap, spaceIndex, pointIndex ?? 0);
    const previous = this.active;
    const previousState = this.state;
    const element = document.createElement('div');
    element.className = 'sphr-viewer-stage';
    element.style.opacity = '0';
    element.style.pointerEvents = 'none';
    this.container.append(element);
    const stage: Stage = { element, key: segment.key, spaceIndex };
    this.pending = stage;
    this.switching = true;
    this.state = { ...this.state, navigating: true, navigationError: undefined, loading: { label: 'Loading ' + segment.space.title, progress: 0, ready: false } };
    this.emit();
    try {
      if (segment.space.availability?.status === 'unavailable') throw new Error(segment.space.availability.message);
      const canvas = document.createElement('canvas');
      canvas.className = 'sphr-canvas';
      canvas.setAttribute('aria-label', 'SPHR interactive scene');
      element.append(canvas);
      stage.three = new SphrRuntime(canvas, segment.bootstrap, {
        onState: state => {
          if (this.disposed || (this.pending ?? this.active) !== stage) return;
          this.state = { ...state, activeSpaceIndex: spaceIndex, finished: this.state.finished,
            loading: this.switching ? { ...state.loading, ready: false } : state.loading };
          this.emit();
        },
        onObjectSelect: id => this.callbacks.onObjectSelect?.(id),
        onObjectTransform: (id, transform) => this.callbacks.onObjectTransform?.(id, transform)
      });
      if (this.editing) stage.three.setEditing(true);
      stage.three.setViewInset(this.viewInset);
      await stage.three.init(pointIndex);
      if (this.disposed) return;
      stage.three.start(this.preferences.guided);
      if (stage.three.getState().muted !== this.preferences.muted) stage.three.toggleMute();
      if (stage.three.getState().showText !== this.preferences.showText) stage.three.toggleText();
      if (this.disposed) return;
      this.active = stage;
      this.pending = undefined;
      this.switching = false;
      element.style.opacity = '1';
      element.style.pointerEvents = '';
      this.release(previous);
      this.state = { ...this.state, navigating: false, navigationError: undefined, loading: { label: 'Ready', progress: 1, ready: true } };
      this.emit();
    } catch (error) {
      this.release(stage);
      this.pending = undefined;
      this.switching = false;
      if (!previous) throw error;
      this.state = { ...previousState, navigating: false, navigationError: error instanceof Error ? error.message : String(error) };
      this.emit();
    }
  }

  async goTo(spaceIndex: number, pointIndex: number) {
    if (this.disposed || this.switching || this.state.navigating) return;
    const segment = tourSegment(this.bootstrap, spaceIndex, pointIndex);
    if (this.active?.key !== segment.key) return this.activate(spaceIndex, pointIndex);
    await this.active.three?.goTo(0, pointIndex);
  }

  next() {
    if (!normalizeTour(this.bootstrap).hasGuidedTour || this.state.navigating) return;
    const next = nextTourLocation(this.bootstrap, this.state.activeSpaceIndex, this.state.activePointIndex, 1);
    if (next) void this.goTo(next.spaceIndex, next.pointIndex);
    else {
      this.state = { ...this.state, finished: true };
      this.start(false);
    }
  }

  previous() {
    if (this.state.navigating) return;
    const previous = nextTourLocation(this.bootstrap, this.state.activeSpaceIndex, this.state.activePointIndex, -1);
    if (previous) void this.goTo(previous.spaceIndex, previous.pointIndex);
  }

  start(guided: boolean) {
    this.preferences.guided = guided && normalizeTour(this.bootstrap).hasGuidedTour;
    if (guided) this.state = { ...this.state, finished: false };
    const tour = normalizeTour(this.bootstrap);
    const points = tour.spaces[this.state.activeSpaceIndex].tourpoints;
    if (!guided && points[this.state.activePointIndex]?.targetType === 'MODEL') {
      let index = this.state.activePointIndex - 1;
      while (index >= 0 && points[index].targetType === 'MODEL') index -= 1;
      if (index >= 0) { void this.goTo(this.state.activeSpaceIndex, index); return; }
    }
    this.active?.three?.start(this.preferences.guided);
    this.emit();
  }

  toggleMute() {
    this.preferences.muted = !this.preferences.muted;
    this.active?.three?.toggleMute();
    this.emit();
  }

  toggleText() {
    this.preferences.showText = !this.preferences.showText;
    this.active?.three?.toggleText();
    this.emit();
  }

  toggleViewMode() {
    if (this.state.navigating) return;
    this.active?.three?.toggleViewMode();
  }

  /** Close the closing card after a tour or hunt ends. */
  dismissFinale() { this.state = { ...this.state, finished: false }; this.emit(); }

  // ---- Tour builder ----
  private editing = false;

  setEditing(editing: boolean) {
    this.editing = editing;
    this.active?.three?.setEditing(editing);
  }

  /** Live edits from the builder; the opening space is the one being edited. */
  async setExperience(update: ExperienceUpdate) {
    const data = this.bootstrap.tour?.tour_data;
    const segment = (data?.spaces ?? data?.tourmodels)?.[0];
    if (data) {
      data.kind = update.kind;
      data.objects = update.objects;
      data.effects = update.effects;
      data.finale = update.finale;
      data.look = update.look;
      data.place = update.place;
      if (update.points.length) data.mode = 'guided';
    }
    if (segment) {
      if (update.points.length || update.standalone) segment.tourpoints = update.points;
      segment.objects = update.objects;
      segment.effects = update.effects;
    }
    if (this.state.activeSpaceIndex === 0) await this.active?.three?.setExperience(update);
  }

  selectObject(id: string | null) { this.active?.three?.selectObject(id); }
  lookAtObject(id: string) { this.active?.three?.lookAtObject(id); }
  previewSound(source: string) { return this.active?.three?.previewSound(source) ?? Promise.resolve(false); }
  lookThumbnails(ids: string[], width?: number) { return this.active?.three?.lookThumbnails(ids, width) ?? {}; }
  setGizmoMode(mode: GizmoMode) { this.active?.three?.setGizmoMode(mode); }
  resolveAnchor(anchor: PixelAnchor) { return this.active?.three?.resolveAnchor(anchor) ?? null; }
  cameraView() { return this.active?.three?.cameraView() ?? null; }
  showEarth(range?: number) { return this.active?.three?.showEarth(range) ?? Promise.resolve(false); }
  aimFrom(nodeId: string, point: [number, number, number]) { return this.active?.three?.aimFrom(nodeId, point) ?? null; }
  captureView() { return this.active?.three?.captureView() ?? null; }
  requestHint() { this.active?.three?.requestHint(); }
  /** How much of the bottom of the screen the tour's text covers, in pixels. */
  setViewInset(bottom: number) { this.viewInset = bottom; this.active?.three?.setViewInset(bottom); }
  restartHunt() { this.active?.three?.restartHunt(); }
  goToStop(index: number) { return this.goTo(0, index); }

  getState() { return this.state; }
  getDebugSnapshot() { return this.active?.three?.getDebugSnapshot() ?? this.state; }
  navigateNode(id: string) { this.active?.three?.navigateNode(id); }
  adjustFieldOfView(delta: number) { this.active?.three?.adjustFieldOfView(delta); }
  captureStartView() {
    if (this.switching || this.state.navigating || !this.active?.three) throw new Error('Wait for the native viewer to load.');
    return this.active.three.captureStartView();
  }

  dispose() {
    this.disposed = true;
    this.release(this.pending);
    this.release(this.active);
    this.pending = this.active = undefined;
  }
}
