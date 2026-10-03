import * as THREE from "three";
import { parseExperience } from "@/lib/experience/validate";
import type { Experience, Vec3 } from "@/lib/experience/types";
import { openingSpace } from "@/lib/scene-edits";
import { panoramaPixelDirection } from "@/lib/three/renderers/PanoramaLayer";
import type { NodeData, SphrBootstrap } from "@/lib/types";
import type { AgentAnchors } from "@/lib/server/tour-agent";

/**
 * Places an agent's draft without a browser, for people's own agents that build tours
 * through the API: stops aim along the pixel the agent pointed at, and objects stand
 * where that ray meets the floor of its panorama location (or a few meters out when it
 * points level or up), facing back toward that location. The browser builder places
 * against the capture's mesh instead, so placements there are finer; anyone can move
 * an object afterwards in the builder.
 */
export function placeOnServer(bootstrap: SphrBootstrap, experience: Experience, anchors: AgentAnchors): Experience {
  const data = openingSpace(bootstrap).space_data;
  const nodes = new Map((data.noPanos ? [] : data.nodes ?? data.navPoints ?? []).map((node) => [node.uuid, node]));
  const origin = (node: NodeData) => new THREE.Vector3(node.position.x, node.position.y, node.position.z);
  const floor = (node: NodeData) => node.floorPosition?.y ?? node.position.y - 1.5;
  const heading = (direction: THREE.Vector3) => Number(THREE.MathUtils.radToDeg(Math.atan2(-direction.x, -direction.z)).toFixed(1));

  /** Where an anchor's ray lands, and the ray. */
  const land = (anchor: { nodeId?: string; face?: number; x: number; y: number }) => {
    const node = anchor.nodeId ? nodes.get(anchor.nodeId) : undefined;
    if (!node) return null;
    const direction = panoramaPixelDirection(node, anchor.x, anchor.y, anchor.face);
    const start = origin(node);
    const ground = floor(node);
    let point: THREE.Vector3;
    if (direction.y < -0.05) {
      point = start.clone().addScaledVector(direction, (ground - start.y) / direction.y);
    } else {
      const flat = new THREE.Vector3(direction.x, 0, direction.z).normalize();
      point = start.clone().addScaledVector(flat, 4).setY(ground);
    }
    // Not at the visitor's feet, and not across the valley.
    const away = new THREE.Vector3(point.x - start.x, 0, point.z - start.z);
    const reach = away.length();
    if (reach < 2 || reach > 25) point.copy(start).addScaledVector(away.normalize(), THREE.MathUtils.clamp(reach, 2, 25)).setY(ground);
    return { node, direction, point, reach: Math.max(2, Math.min(25, reach)) };
  };

  const objects = experience.objects.map((object) => {
    const anchor = anchors.objects[object.id];
    const spot = anchor ? land(anchor) : null;
    if (!spot) return object;
    const turned = object.rotation.some((value) => value !== 0);
    const grow = Math.min(5, Math.max(1, spot.reach / 5));
    return { ...object, position: [spot.point.x, spot.point.y, spot.point.z] as Vec3,
      ...(turned ? {} : { rotation: [0, heading(spot.direction), 0] as Vec3 }),
      ...(grow > 1 ? { scale: object.scale.map((value) => Number((value * grow).toFixed(3))) as Vec3 } : {}) };
  });
  const effects = experience.effects.map((effect) => {
    const anchor = anchors.effects[effect.id];
    const spot = anchor && effect.target.kind === "point" ? land(anchor) : null;
    return spot ? { ...effect, target: { kind: "point" as const, position: [spot.point.x, spot.point.y + 0.5, spot.point.z] as Vec3 } } : effect;
  });
  const stops = experience.stops.map((stop) => {
    const anchor = anchors.stops[stop.id];
    const node = anchor?.nodeId ? nodes.get(anchor.nodeId) : undefined;
    if (!anchor || !node) return stop;
    const direction = panoramaPixelDirection(node, anchor.x, anchor.y, anchor.face);
    // Picked in a photo taken somewhere else: look from this stop toward the same spot.
    const standing = stop.view.nodeId ? nodes.get(stop.view.nodeId) : undefined;
    let aim = direction;
    if (standing && standing.uuid !== node.uuid) {
      const spot = land(anchor);
      if (spot) aim = spot.point.clone().sub(origin(standing)).normalize();
    }
    return { ...stop, view: { ...stop.view, rotation: { azimuth: heading(aim), polar: Number(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(aim.y, -1, 1))).toFixed(1)) } } };
  });
  return parseExperience({ ...experience, objects, effects, stops }, { lenient: true });
}
