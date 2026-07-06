import * as THREE from "three";
import type { CameraRotation, EulerLike, TransformConfig, Vector3Like } from "@/lib/types";

export function vectorFromLike(value?: Vector3Like | null, fallback = new THREE.Vector3()) {
  if (!value) return fallback.clone();
  return new THREE.Vector3(value.x ?? 0, value.y ?? 0, value.z ?? 0);
}

export function eulerFromLike(value?: EulerLike | null) {
  if (!value) return new THREE.Euler();
  return new THREE.Euler(value.x ?? 0, value.y ?? 0, value.z ?? 0);
}

export function applyTransform(object: THREE.Object3D, transform?: TransformConfig) {
  if (!transform) return;
  if (transform.position) object.position.set(...transform.position);
  if (transform.rotation && Array.isArray(transform.rotation)) object.rotation.set(...transform.rotation);
  if (typeof transform.scale === "number") {
    object.scale.setScalar(transform.scale);
  } else if (Array.isArray(transform.scale)) {
    object.scale.set(...transform.scale);
  }
}

export function cameraDirection(rotation?: CameraRotation) {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotation?.polar ?? 0),
    THREE.MathUtils.degToRad(rotation?.azimuth ?? 0),
    0,
    "YXZ"
  );
  return new THREE.Vector3(0, 0, -1).applyEuler(euler).normalize();
}

export function calculateDistance(a: Vector3Like, b: Vector3Like) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function sceneGroupSettings(settingsKey: "nodes" | "navPoints" | "model" | "dollhouse", data?: {
  sceneSettings?: {
    [key: string]: unknown;
  };
}) {
  const group = (data?.sceneSettings?.[settingsKey] ?? {}) as {
    scale?: number;
    offsetPosition?: Vector3Like;
    offsetRotation?: Vector3Like;
  };

  return {
    scale: group.scale ?? 1,
    offsetPosition: vectorFromLike(group.offsetPosition),
    offsetRotation: vectorFromLike(group.offsetRotation)
  };
}

export function worldFromGroupedPoint(point: Vector3Like, settings?: ReturnType<typeof sceneGroupSettings>) {
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Euler(
    THREE.MathUtils.degToRad(settings?.offsetRotation.x ?? 0),
    THREE.MathUtils.degToRad(settings?.offsetRotation.y ?? 0),
    THREE.MathUtils.degToRad(settings?.offsetRotation.z ?? 0),
    "XYZ"
  );
  matrix.compose(
    settings?.offsetPosition ?? new THREE.Vector3(),
    new THREE.Quaternion().setFromEuler(rotation),
    new THREE.Vector3(settings?.scale ?? 1, settings?.scale ?? 1, settings?.scale ?? 1)
  );
  return vectorFromLike(point).applyMatrix4(matrix);
}
