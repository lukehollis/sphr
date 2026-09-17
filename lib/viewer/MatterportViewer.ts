import type { AnnotationConfig, SphrSpace, TourPoint } from '@/lib/types';
import { EmbeddedAnnotations, type EmbeddedCameraPose } from './EmbeddedAnnotations';

type Subscription = { cancel(): void };
type Observable<T> = { subscribe(callback: (value: T) => void): Subscription; waitUntil(predicate: (value: T) => boolean): Promise<T> };
type Sdk = {
  App: { Phase: { PLAYING: string }; state: Observable<{ phase: string }> };
  Sweep: { Transition: Record<string, string>; moveTo(id: string, options: object): Promise<string>; current: Observable<{ sid: string }> };
  Mode: { Mode: Record<string, string>; moveTo(mode: string, options?: object): Promise<void>; current: Observable<string> };
  Camera: { zoomTo(zoom: number): Promise<number>; pose: Observable<EmbeddedCameraPose> };
};
declare global { interface Window { MP_SDK?: { connect(iframe: HTMLIFrameElement, key: string, unused: ''): Promise<Sdk> } } }
let sdkScript: Promise<void> | undefined;

function loadSdk() {
  if (window.MP_SDK) return Promise.resolve();
  if (!sdkScript) sdkScript = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://static.matterport.com/showcase-sdk/latest.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); sdkScript = undefined; reject(new Error('Unable to load the Matterport connection.')); };
    document.head.append(script);
  });
  return sdkScript;
}

export class MatterportViewer {
  readonly iframe = document.createElement('iframe');
  private sdk?: Sdk;
  private disposed = false;
  private subscriptions: Subscription[] = [];
  private readonly container: HTMLElement;
  private annotations?: EmbeddedAnnotations;

  constructor(container: HTMLElement, private readonly space: SphrSpace, private readonly sdkKey: string,
    private readonly onChange: (change: { viewMode?: 'FPV' | 'ORBIT'; activeNodeId?: string }) => void,
    private readonly annotationConfigs: AnnotationConfig[] = []) {
    this.iframe.className = 'sphr-embedded-viewer';
    this.iframe.title = space.title;
    this.iframe.allow = 'autoplay; xr-spatial-tracking';
    // Append after setting src so an about:blank load cannot win the ready event.
    this.container = container;
  }

  async init(point?: TourPoint) {
    const url = new URL(this.space.src ?? '');
    if (url.protocol !== 'https:' || url.hostname !== 'my.matterport.com' || !/^[a-zA-Z0-9]+$/.test(url.searchParams.get('m') ?? '')) {
      throw new Error('Invalid Matterport model link.');
    }
    for (const [key, value] of Object.entries({ play: '1', qs: '1', title: '0', brand: '0', tour: '0', vr: '0', fs: '0', hl: '0', mt: '0', applicationKey: this.sdkKey })) url.searchParams.set(key, value);
    if (!this.sdkKey) throw new Error('An Embed SDK application key is required for this Matterport viewer.');
    const loaded = new Promise<void>((resolve) => {
      this.iframe.dataset.sphrEmbed = 'loading-document';
      this.iframe.addEventListener('load', () => { this.iframe.dataset.sphrEmbed = 'document-loaded'; resolve(); }, { once: true });
      this.iframe.src = url.href;
      this.container.append(this.iframe);
    });
    await Promise.all([loaded, loadSdk()]);
    if (this.disposed) return;
    this.iframe.dataset.sphrEmbed = 'connecting-sdk';
    this.sdk = await window.MP_SDK!.connect(this.iframe, this.sdkKey, '');
    if (this.disposed) return;
    this.iframe.dataset.sphrEmbed = 'loading-model';
    await this.sdk.App.state.waitUntil(state => state.phase === this.sdk!.App.Phase.PLAYING);
    if (this.disposed) return;
    this.iframe.dataset.sphrEmbed = 'ready';
    if (this.annotationConfigs.length) {
      this.annotations = new EmbeddedAnnotations(this.container, this.annotationConfigs);
      this.subscriptions.push(this.sdk.Camera.pose.subscribe(pose => this.annotations?.update(pose)));
    }
    this.subscriptions.push(this.sdk.Sweep.current.subscribe(sweep => {
      if (!this.disposed && sweep.sid) this.onChange({ activeNodeId: sweep.sid });
    }), this.sdk.Mode.current.subscribe(mode => {
      if (!this.disposed) this.onChange({ viewMode: mode === this.sdk!.Mode.Mode.INSIDE ? 'FPV' : 'ORBIT' });
    }));
    if (point?.nodeUUID || point?.viewMode === 'DOLLHOUSE') await this.goTo(point, true);
  }

  async goTo(point: TourPoint, instant = false) {
    if (!this.sdk || this.disposed) return;
    const rotation = { x: point.rotation?.polar ?? 0, y: point.rotation?.azimuth ?? 0 };
    if (point.viewMode === 'DOLLHOUSE' || point.viewMode === 'FLOORPLAN') {
      await this.sdk.Mode.moveTo(this.sdk.Mode.Mode[point.viewMode], { rotation });
    } else if (point.nodeUUID) {
      await this.sdk.Sweep.moveTo(point.nodeUUID, {
        rotation, transition: this.sdk.Sweep.Transition[instant ? 'INSTANT' : point.transition || 'FLY'], transitionTime: instant ? 0 : 1100
      });
      await this.sdk.Camera.zoomTo(Math.max(1, 110 / Math.max(35, point.fov ?? 110 - (point.zoom ?? 0))));
    }
  }

  showAnnotations(ids: string[] = []) { this.annotations?.show(ids); }
  setMuted(muted: boolean) { this.annotations?.setMuted(muted); }

  async toggleView(mode: 'FPV' | 'ORBIT') {
    if (this.sdk) await this.sdk.Mode.moveTo(this.sdk.Mode.Mode[mode === 'FPV' ? 'DOLLHOUSE' : 'INSIDE']);
  }

  dispose() {
    this.disposed = true;
    this.subscriptions.forEach(subscription => subscription.cancel());
    this.subscriptions = [];
    this.annotations?.dispose();
    this.iframe.src = 'about:blank';
    this.iframe.remove();
    this.sdk = undefined;
  }
}
