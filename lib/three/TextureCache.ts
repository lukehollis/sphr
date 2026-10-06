import * as THREE from "three";

type Entry = { texture: THREE.Texture; ready: Promise<THREE.Texture>; loaded: boolean; pins: number; permanent: boolean; used: number };

/**
 * TextureLoader with the image asking for the connection first. Browsers rank a fetch (a model
 * downloading) above an image, so on a slow connection the faces of the next view waited behind it.
 */
class FaceLoader extends THREE.TextureLoader {
  load(url: string, onLoad?: (texture: THREE.Texture<HTMLImageElement>) => void, _onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void) {
    const texture = new THREE.Texture<HTMLImageElement>();
    const address = this.manager.resolveURL(this.path + url);
    const image = document.createElementNS("http://www.w3.org/1999/xhtml", "img") as HTMLImageElement;
    const settle = () => { image.removeEventListener("load", loaded); image.removeEventListener("error", failed); };
    const loaded = () => { settle(); texture.image = image; texture.needsUpdate = true; onLoad?.(texture); this.manager.itemEnd(address); };
    const failed = (event: Event) => { settle(); onError?.(event); this.manager.itemError(address); this.manager.itemEnd(address); };
    image.addEventListener("load", loaded, false);
    image.addEventListener("error", failed, false);
    if (!address.startsWith("data:") && this.crossOrigin !== undefined) image.crossOrigin = this.crossOrigin;
    image.fetchPriority = "high";
    this.manager.itemStart(address);
    image.src = address;
    return texture;
  }
}

/** Bounded panorama cache. Visible images stay pinned until their fade completes. */
export class TextureCache {
  private readonly loader: THREE.TextureLoader;
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  /**
   * @param budget bytes of unpinned textures kept for reuse (phones keep fewer)
   * @param mipmaps phones skip them: a face is drawn near its own size there, and they add a third
   */
  constructor(manager?: THREE.LoadingManager, private readonly budget = 320 * 1024 * 1024, private readonly mipmaps = true) { this.loader = new FaceLoader(manager); }

  load(url: string, onLoad?: (texture: THREE.Texture) => void) {
    if (!url) return null;
    const entry = this.get(url);
    entry.permanent = true;
    void entry.ready.then(onLoad).catch((error) => console.error(error));
    return entry.texture;
  }

  getReady(url: string) { return this.get(url).texture; }

  /** Whether the image has arrived, without asking for it. */
  isLoaded(url: string) { return Boolean(this.entries.get(url)?.loaded); }

  async loadAsync(url: string) {
    if (!url) throw new Error("Missing panorama image URL");
    return this.get(url).ready;
  }

  retain(urls: string[]) { urls.forEach((url) => { this.get(url).pins += 1; }); }
  release(urls: string[], trim = true) {
    urls.forEach((url) => { const entry = this.entries.get(url); if (entry) entry.pins = Math.max(0, entry.pins - 1); });
    if (trim) this.trim();
  }

  trim() {
    const bytes = (e: Entry) => ((e.texture.image as { width?: number })?.width ?? 1024) * ((e.texture.image as { height?: number })?.height ?? 1024) * 4 * (this.mipmaps ? 4 / 3 : 1);
    let total = [...this.entries.values()].reduce((sum, entry) => sum + bytes(entry), 0);
    for (const [url, entry] of [...this.entries].sort((a, b) => a[1].used - b[1].used)) {
      if (total < this.budget) break;
      if (entry.pins || entry.permanent) continue;
      total -= bytes(entry);
      entry.texture.dispose();
      this.entries.delete(url);
    }
  }

  getStats() { return { textures: this.entries.size, pinned: [...this.entries.values()].filter((entry) => entry.pins > 0).length }; }

  dispose() {
    this.disposed = true;
    this.entries.forEach((entry) => entry.texture.dispose());
    this.entries.clear();
  }

  private get(url: string): Entry {
    const cached = this.entries.get(url);
    if (cached) { cached.used = performance.now(); return cached; }
    let resolve!: (texture: THREE.Texture) => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<THREE.Texture>((yes, no) => { resolve = yes; reject = no; });
    // A retain can start a request before its consumer awaits it.
    void ready.catch(() => {});
    const texture = this.loader.load(url, (loaded) => {
      if (this.disposed) { loaded.dispose(); reject(new Error("Viewer disposed")); return; }
      loaded.needsUpdate = true;
      const entry = this.entries.get(url);
      if (entry) entry.loaded = true;
      resolve(loaded);
    }, undefined, () => {
      this.entries.delete(url);
      texture.dispose();
      reject(new Error(`Unable to load panorama image: ${url}`));
    });
    texture.minFilter = this.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.generateMipmaps = this.mipmaps;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    const entry = { texture, ready, loaded: false, pins: 0, permanent: false, used: performance.now() };
    this.entries.set(url, entry);
    return entry;
  }
}
