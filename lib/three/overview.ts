import { Box3, Vector3 } from "three";

/** Frame the surveyed area when sparse distant returns dominate a panorama mesh. */
export function panoramaOverviewBounds(mesh: Box3, cameras: Vector3[], floors: Vector3[] = []) {
  const bounds = mesh.clone();
  if (mesh.isEmpty() || cameras.length < 2) return bounds;
  const scans = new Box3().setFromPoints(cameras);
  const span = scans.getSize(new Vector3()).length();
  if (span < 0.1 || mesh.getSize(new Vector3()).length() <= span * 4) return bounds;
  floors.forEach((floor) => scans.expandByPoint(floor));
  // This changes only the initial camera framing. All geometry remains available
  // when orbiting or zooming out, and every measured scan stays inside the frame.
  return bounds.intersect(scans.clone().expandByScalar(span * 0.5)).union(scans);
}
