import * as THREE from "three";

export type NavigationCandidate<T> = { value: T; floor: THREE.Vector3 };

/** Candidates must already be reachable and unobstructed from the active scan. */
export function selectNavigationTarget<T>(
  ray: THREE.Ray,
  candidates: NavigationCandidate<T>[],
  currentFloor: THREE.Vector3,
  floorHit: THREE.Vector3 | null
): T | null {
  if (floorHit) {
    // Compare to the current scan too: clicking at your feet should not jump away.
    const score = (floor: THREE.Vector3) => (floor.x - floorHit.x) ** 2 + (floor.z - floorHit.z) ** 2 + 16 * (floor.y - floorHit.y) ** 2;
    let bestScore = score(currentFloor);
    let best: T | null = null;
    for (const candidate of candidates) {
      // Keep a floor click on that measured level, including small steps/slopes.
      if (Math.abs(candidate.floor.y - floorHit.y) > 0.75) continue;
      const distance = score(candidate.floor);
      if (distance < bestScore) { bestScore = distance; best = candidate.value; }
    }
    return best;
  }

  // A click between markers should still move in that direction. Compare the
  // horizontal bearing so clicking low in the image doesn't miss eye-level nodes.
  if (ray.direction.y > 0.65) return null;
  const bearing = new THREE.Vector3(ray.direction.x, 0, ray.direction.z);
  if (bearing.lengthSq() < 0.0001) return null;
  bearing.normalize();
  let best: T | null = null;
  let bestAngle = Math.PI / 6;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const direction = candidate.floor.clone().sub(currentFloor).setY(0);
    const distance = direction.length();
    if (distance < 0.05) continue;
    const angle = bearing.angleTo(direction);
    if (angle < bestAngle - 0.0001 || (Math.abs(angle - bestAngle) < 0.0001 && distance < bestDistance)) {
      best = candidate.value;
      bestAngle = angle;
      bestDistance = distance;
    }
  }
  return best;
}

/** Arrow-key travel: the reachable scan best aligned with a heading, within a 60° cone. */
export function selectDirectionalTarget<T>(
  heading: THREE.Vector3,
  candidates: NavigationCandidate<T>[],
  currentFloor: THREE.Vector3
): T | null {
  const bearing = new THREE.Vector3(heading.x, 0, heading.z);
  if (bearing.lengthSq() < 0.0001) return null;
  bearing.normalize();
  let best: T | null = null;
  let bestCost = Infinity;
  for (const candidate of candidates) {
    const direction = candidate.floor.clone().sub(currentFloor).setY(0);
    const distance = direction.length();
    if (distance < 0.05) continue;
    const angle = bearing.angleTo(direction);
    if (angle > Math.PI / 3) continue;
    // A degree off the heading weighs about the same as a metre further away.
    const cost = angle + distance * THREE.MathUtils.DEG2RAD;
    if (cost < bestCost) { best = candidate.value; bestCost = cost; }
  }
  return best;
}

/**
 * A click on the mesh travels to the scan nearest that spot, however far, if `reachable` allows it.
 * Only the closest few are tested, so sightline checks stay cheap in large captures.
 */
export function selectSpotTarget<T>(
  spot: THREE.Vector3,
  onFloor: boolean,
  candidates: NavigationCandidate<T>[],
  currentFloor: THREE.Vector3,
  reachable: (value: T) => boolean,
  maxChecks = 6
): T | null {
  // Floor clicks keep to the clicked level; wall clicks prefer the current one.
  const score = (floor: THREE.Vector3) => (floor.x - spot.x) ** 2 + (floor.z - spot.z) ** 2
    + (onFloor ? 16 * (floor.y - spot.y) ** 2 : 4 * (floor.y - currentFloor.y) ** 2);
  const here = score(currentFloor);
  const ranked = candidates
    .filter((candidate) => !onFloor || Math.abs(candidate.floor.y - spot.y) <= 0.75)
    .map((candidate) => ({ value: candidate.value, score: score(candidate.floor) }))
    .filter((candidate) => candidate.score < here)
    .sort((a, b) => a.score - b.score);
  for (const candidate of ranked.slice(0, maxChecks)) if (reachable(candidate.value)) return candidate.value;
  return null;
}

/**
 * Where to stand to reach a spot on a capture without marked floors (a splat).
 * Ground (a surface facing up) is stood on at eye height. Anything else is
 * approached along the line of sight, stopping short of it, and stood on the
 * ground below that point when `groundAt` finds some near enough.
 */
export function standingSpot(
  surface: { point: THREE.Vector3; normal: THREE.Vector3; direction: THREE.Vector3; distance: number },
  eye: number,
  groundAt: (spot: THREE.Vector3) => number | null
) {
  if (surface.normal.y > 0.7) return surface.point.clone().addScaledVector(new THREE.Vector3(0, 1, 0), eye);
  const spot = surface.point.clone().addScaledVector(surface.direction, -Math.min(eye, surface.distance * 0.5));
  const ground = groundAt(spot);
  if (ground !== null && spot.y - ground < eye * 3) spot.y = ground + eye;
  return spot;
}

/**
 * Which way held keys move the camera, as a unit vector: forward and back
 * level along the heading, sideways, and straight up or down. Looking
 * straight down, the top of the screen is ahead.
 */
export function freeMoveDirection(look: THREE.Vector3, screenUp: THREE.Vector3, input: { forward: number; right: number; up: number }) {
  const forward = new THREE.Vector3(look.x, 0, look.z);
  if (forward.lengthSq() < 1e-6) forward.set(screenUp.x, 0, screenUp.z).multiplyScalar(Math.sign(-look.y) || 1);
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const move = forward.multiplyScalar(input.forward).addScaledVector(right, input.right).add(new THREE.Vector3(0, input.up, 0));
  return move.lengthSq() > 1 ? move.normalize() : move;
}
