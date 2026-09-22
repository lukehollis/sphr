import { normalizeTour } from '@/lib/bootstrap';
import type { RuntimeCallbacks, RuntimeState, SphrBootstrap } from '@/lib/types';
import { SphrRuntime } from '@/lib/three/SphrRuntime';
import { assertNativeBootstrap } from './native';
import { nextTourLocation, tourSegment } from './segments';

type Stage = { element: HTMLDivElement; key: string; spaceIndex: number; three?: SphrRuntime };

/** Owns tour position across independent scene renderers; failed scene loads retain the last viewer. */
export class ViewerSession {
  private active?: Stage;
  private pending?: Stage;
  private disposed = false;
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
          this.state = { ...state, activeSpaceIndex: spaceIndex,
            loading: this.switching ? { ...state.loading, ready: false } : state.loading };
          this.emit();
        }
      });
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
    else this.start(false);
  }

  previous() {
    if (this.state.navigating) return;
    const previous = nextTourLocation(this.bootstrap, this.state.activeSpaceIndex, this.state.activePointIndex, -1);
    if (previous) void this.goTo(previous.spaceIndex, previous.pointIndex);
  }

  start(guided: boolean) {
    this.preferences.guided = guided && normalizeTour(this.bootstrap).hasGuidedTour;
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
