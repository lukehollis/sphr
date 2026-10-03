import type { PlacedObject, Vec3 } from "@/lib/experience/types";

/**
 * Where a pixel the tour agent pointed at lands in the space: from the viewer's
 * raycast in the builder, or from the server's against the capture mesh.
 */
export type AnchorSpot = {
  position: Vec3;
  normal: Vec3 | null;
  /** Whether the ray met a surface. */
  hit: boolean;
  distance: number | null;
  /** Where the ray started (the panorama location). */
  origin: Vec3;
  /** The floor height under that location, when known. */
  floor: number | null;
  rotation: { azimuth: number; polar: number };
};

const DEG = Math.PI / 180;

/**
 * The rules for an object the agent placed, the same in the builder and on the
 * server. Signs and other flat things face the view they were placed from, unless
 * the agent turned them, and things placed far off grow so they still read from
 * there, up to five times. Nothing lands at the visitor's feet: a spot on the
 * floor right below the camera moves out to two meters. Pointed at sky or open
 * air, it stands on the ground a few meters out in that direction.
 */
export function placeObjectAt(object: PlacedObject, spot: AnchorSpot): PlacedObject {
  const turned = object.rotation.some((value) => value !== 0);
  const grow = spot.distance ? Math.min(5, Math.max(1, spot.distance / 5)) : 1;
  const heading = DEG * spot.rotation.azimuth;
  const away = [spot.position[0] - spot.origin[0], spot.position[2] - spot.origin[2]];
  const reach = Math.hypot(away[0], away[1]);
  let position = spot.position;
  if (!spot.hit) {
    position = [spot.origin[0] - Math.sin(heading) * 4, spot.floor ?? spot.origin[1] - 1.5, spot.origin[2] - Math.cos(heading) * 4];
  } else if (reach < 2) {
    const [dx, dz] = reach > 0.2 ? [away[0] / reach, away[1] / reach] : [-Math.sin(heading), -Math.cos(heading)];
    position = [spot.origin[0] + dx * 2, spot.position[1], spot.origin[2] + dz * 2];
  }
  return { ...object, position,
    ...(turned ? {} : { rotation: [0, Number(spot.rotation.azimuth.toFixed(1)), 0] as Vec3 }),
    ...(grow > 1 ? { scale: object.scale.map((value) => Number((value * grow).toFixed(3))) as Vec3 } : {}) };
}

/** Heading and tilt that look from a point (a panorama location) toward another. */
export function aimFrom(origin: Vec3, point: Vec3) {
  const direction = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length < 1e-3) return null;
  return {
    azimuth: Number((Math.atan2(-direction[0], -direction[2]) / DEG).toFixed(2)),
    polar: Number((Math.asin(Math.max(-1, Math.min(1, direction[1] / length))) / DEG).toFixed(2))
  };
}
