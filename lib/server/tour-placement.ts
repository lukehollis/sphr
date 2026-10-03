import * as THREE from "three";
import { parseExperience } from "@/lib/experience/validate";
import type { Experience, Vec3 } from "@/lib/experience/types";
import { aimFrom, placeObjectAt, type AnchorSpot } from "@/lib/experience/placement";
import { openingSpace } from "@/lib/scene-edits";
import { sceneGroupSettings, worldFromGroupedPoint } from "@/lib/three/math";
import { panoramaPixelDirection } from "@/lib/three/renderers/PanoramaLayer";
import type { SphrBootstrap } from "@/lib/types";
import type { AgentAnchors } from "@/lib/server/tour-agent";

/**
 * Places an agent's draft without a browser, for people's own agents that build tours
 * through the API, the way the builder does in the viewer: each pixel the agent pointed
 * at becomes a ray from its panorama location, cast against the space's capture mesh
 * (see capture-mesh.ts), and objects follow the builder's rules (placeObjectAt). A
 * space without a capture mesh uses the floor under each location as the ground.
 */
export function placeOnServer(bootstrap: SphrBootstrap, experience: Experience, anchors: AgentAnchors, meshes: THREE.Object3D[] = []): Experience {
  const data = openingSpace(bootstrap).space_data;
  const nodes = new Map((data.noPanos ? [] : data.nodes ?? data.navPoints ?? []).map((node) => [node.uuid, node]));
  const settings = sceneGroupSettings("nodes", data);
  const toArray = (vector: THREE.Vector3) => [vector.x, vector.y, vector.z] as Vec3;
  const raycaster = new THREE.Raycaster();
  raycaster.far = 500;

  const resolve = (anchor: { nodeId?: string; face?: number; x: number; y: number }): AnchorSpot | null => {
    const node = anchor.nodeId ? nodes.get(anchor.nodeId) : undefined;
    if (!node) return null;
    const origin = worldFromGroupedPoint(node.position, settings);
    const direction = panoramaPixelDirection(node, anchor.x, anchor.y, anchor.face);
    const floor = node.floorPosition ? worldFromGroupedPoint(node.floorPosition, settings).y : null;
    const base = { origin: toArray(origin), floor, rotation: {
      azimuth: THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z)),
      polar: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)))
    } };
    if (meshes.length) {
      raycaster.set(origin, direction);
      const hit = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 0.15);
      if (hit) {
        const normal = hit.face ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize() : null;
        if (normal && normal.dot(direction) > 0) normal.negate();
        // Rest on floors; stand slightly off walls toward the viewer.
        const point = hit.point.clone().addScaledVector(normal ?? direction.clone().negate(), normal && normal.y > 0.7 ? 0.01 : 0.06);
        return { ...base, position: toArray(point), normal: normal ? toArray(normal) : null, hit: true, distance: hit.distance };
      }
    } else if (direction.y < -0.05) {
      // No capture mesh: the floor under the location stands in for the ground, out to 25 meters.
      const ground = floor ?? origin.y - 1.5;
      const distance = (ground - origin.y) / direction.y;
      const across = distance * Math.hypot(direction.x, direction.z);
      if (distance > 0 && across <= 25) return { ...base, position: toArray(origin.clone().addScaledVector(direction, distance)), normal: [0, 1, 0], hit: true, distance };
    }
    return { ...base, position: toArray(origin.clone().addScaledVector(direction, 2.5)), normal: null, hit: false, distance: null };
  };

  const objects = experience.objects.map((object) => {
    const anchor = anchors.objects[object.id];
    const spot = anchor ? resolve(anchor) : null;
    return spot ? placeObjectAt(object, spot) : object;
  });
  const effects = experience.effects.map((effect) => {
    const anchor = anchors.effects[effect.id];
    const spot = anchor && effect.target.kind === "point" ? resolve(anchor) : null;
    return spot ? { ...effect, target: { kind: "point" as const, position: spot.position } } : effect;
  });
  // A stop looks from where it stands toward the spot the agent pointed at, even when
  // that spot was picked in a photo taken somewhere else.
  const stops = experience.stops.map((stop) => {
    const anchor = anchors.stops[stop.id];
    const spot = anchor ? resolve(anchor) : null;
    if (!spot) return stop;
    const standing = stop.view.nodeId ? nodes.get(stop.view.nodeId) : undefined;
    const aimed = standing && spot.hit ? aimFrom(toArray(worldFromGroupedPoint(standing.position, settings)), spot.position) : null;
    return { ...stop, view: { ...stop.view, rotation: aimed ?? { azimuth: Number(spot.rotation.azimuth.toFixed(2)), polar: Number(spot.rotation.polar.toFixed(2)) } } };
  });
  return parseExperience({ ...experience, objects, effects, stops }, { lenient: true });
}
