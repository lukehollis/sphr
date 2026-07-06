import * as THREE from "three";

export class TextureCache {
  private readonly loader: THREE.TextureLoader;
  private readonly textures = new Map<string, THREE.Texture>();

  constructor(manager?: THREE.LoadingManager) {
    this.loader = new THREE.TextureLoader(manager);
  }

  load(url: string, onLoad?: (texture: THREE.Texture) => void) {
    if (!url) return null;
    const cached = this.textures.get(url);
    if (cached) {
      onLoad?.(cached);
      return cached;
    }

    const texture = this.loader.load(url, (loaded) => {
      this.applySettings(loaded, true);
      onLoad?.(loaded);
    });
    this.applySettings(texture, false);
    this.textures.set(url, texture);
    return texture;
  }

  dispose() {
    this.textures.forEach((texture) => texture.dispose());
    this.textures.clear();
  }

  private applySettings(texture: THREE.Texture, markUpdated: boolean) {
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    if (markUpdated) texture.needsUpdate = true;
  }
}
