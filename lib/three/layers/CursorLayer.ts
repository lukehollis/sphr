import * as THREE from "three";

export class CursorLayer {
  private readonly overlayScene = new THREE.Scene();
  private readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly cursorUp = new THREE.Vector3(0, 1, 0);
  private readonly additionalRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly normal = new THREE.Vector3();
  private readonly targetQuaternion = new THREE.Quaternion();
  private lastHitTime = 0;

  constructor() {
    const geometry = new THREE.RingGeometry(0.2, 0.25, 64);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "sphr-cursor";
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
    this.overlayScene.add(this.mesh);
  }

  updateFromRaycaster(raycaster: THREE.Raycaster, targets: THREE.Object3D[]) {
    if (!targets.length) {
      this.hide();
      return;
    }

    const intersects = raycaster.intersectObjects(targets, true);
    const hit = intersects.find((intersect) => Boolean(intersect.face));
    if (!hit?.face) {
      this.hide();
      return;
    }

    this.normal.copy(hit.face.normal);
    this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    this.normal.applyMatrix3(this.normalMatrix).normalize();

    this.targetQuaternion.setFromUnitVectors(this.cursorUp, this.normal).multiply(this.additionalRotation);
    this.mesh.position.copy(hit.point).addScaledVector(this.normal, 0.01);
    this.mesh.quaternion.copy(this.targetQuaternion);
    this.mesh.material.opacity = 1;
    this.mesh.visible = true;
    this.lastHitTime = performance.now();
  }

  update(now: number) {
    if (!this.mesh.visible) return;
    const elapsed = now - this.lastHitTime;
    if (elapsed <= 2000) return;
    const fade = Math.max(0, 1 - (elapsed - 2000) / 200);
    this.mesh.material.opacity = fade;
    if (fade <= 0) this.mesh.visible = false;
  }

  dispose() {
    this.overlayScene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    if (!this.mesh.visible) return;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.overlayScene, camera);
    renderer.autoClear = previousAutoClear;
  }

  getDebugState() {
    return {
      visible: this.mesh.visible,
      opacity: this.mesh.material.opacity,
      position: this.mesh.position.toArray(),
      quaternion: this.mesh.quaternion.toArray(),
      lastHitTime: this.lastHitTime
    };
  }

  private hide() {
    this.lastHitTime = 0;
    this.mesh.material.opacity = 0;
    this.mesh.visible = false;
  }
}
