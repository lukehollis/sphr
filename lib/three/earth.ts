import * as THREE from "three";
import type { EarthPlace, StopEarth } from "@/lib/experience/types";
import type { CameraRotation } from "@/lib/types";
import { cameraDirection } from "@/lib/three/math";

/**
 * The map arrives with +Y up, +Z north and +X west around the place's latitude
 * and longitude. Turning it by this much about +Y makes north fall where the
 * place's heading says a view at azimuth 0 faces.
 */
export function earthYaw(place: Pick<EarthPlace, "heading">) {
  return THREE.MathUtils.degToRad(place.heading) + Math.PI;
}

/** Compass bearing, in degrees clockwise from north, of a view at this azimuth. */
export function bearingOf(place: Pick<EarthPlace, "heading">, azimuth: number) {
  return (((place.heading - azimuth) % 360) + 360) % 360;
}

/** Steep enough to see the ground around the site, never straight down or level. */
export function earthRotation(rotation?: CameraRotation): CameraRotation {
  const polar = rotation?.polar ?? -45;
  return { azimuth: rotation?.azimuth ?? 0, polar: THREE.MathUtils.clamp(polar > -12 ? -45 : polar, -89, -12) };
}

/** The camera above `target`, `range` meters back along the stop's view. */
export function earthPose(target: THREE.Vector3, earth: StopEarth, rotation: CameraRotation | undefined, scale = 1) {
  const direction = cameraDirection(earthRotation(rotation));
  return {
    position: target.clone().addScaledVector(direction, -earth.range * scale),
    target: target.clone(),
    fov: 50
  };
}

/** A near plane that keeps the map's depth steady from the ground to kilometers up. */
export function earthNear(height: number) {
  return THREE.MathUtils.clamp(Math.abs(height) * 0.004, 0.02, 25);
}
