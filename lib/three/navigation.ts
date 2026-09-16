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
