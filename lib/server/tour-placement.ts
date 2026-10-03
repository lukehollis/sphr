import * as THREE from "three";
import { parseExperience } from "@/lib/experience/validate";
import type { Experience, Vec3 } from "@/lib/experience/types";
import { aimFrom, placeObjectAt, type AnchorSpot } from "@/lib/experience/placement";
import { openingSpace } from "@/lib/scene-edits";
import { cameraDirection, sceneGroupSettings, worldFromGroupedPoint } from "@/lib/three/math";
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

  const placed = experience.objects.map((object) => {
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
  const objects = meshes.length ? keepNoticeable(placed) : placed;
  return parseExperience({ ...experience, objects, effects, stops }, { lenient: true });

  /**
   * The agent picks spots in photos taken from many places, so an object can end up out of
   * the view of the stop that shows it, behind a step or a wall (a hunt's object would then
   * be impossible to click), or so far across a large space that it is too small to notice.
   * Seen from the first stop that lists it: in a guided tour, an object well off that stop's
   * view comes into it, onto the ground a few meters ahead; one more than 18 meters away
   * comes along the same line of sight onto the surface at 18 meters; and one the capture
   * hides comes forward onto the surface in the way, or the floor just in front of that.
   */
  function keepNoticeable(list: typeof placed) {
    const firstStop = new Map<string, (typeof stops)[number]>();
    for (const stop of stops) {
      if (!stop.view.nodeId) continue;
      for (const id of [...stop.objects, ...(stop.find ? [stop.find.objectId] : [])]) if (!firstStop.has(id)) firstStop.set(id, stop);
    }
    const down = new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const nearby = 18;
    const moved = new Map<string, number>();
    const surfaceBelow = (from: THREE.Vector3, within: number) => {
      raycaster.set(from, down);
      const hit = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 0.05 && item.distance < within);
      if (!hit) return null;
      const normal = hit.face ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize() : up;
      return Math.abs(normal.y) > 0.7 ? hit.point : null;
    };
    const visibleFrom = (eye: THREE.Vector3, point: THREE.Vector3) => {
      const toward = point.clone().sub(eye);
      raycaster.set(eye, toward.clone().normalize());
      const hit = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 0.15);
      return !hit || hit.distance >= toward.length() - 0.15;
    };
    const heading = (eye: THREE.Vector3, point: THREE.Vector3) => aimFrom(toArray(eye), toArray(point))?.azimuth ?? 0;

    return list.map((original) => {
      let object = original;
      const stop = firstStop.get(object.id);
      const node = nodes.get(stop?.view.nodeId ?? "");
      if (!stop || !node || !anchors.objects[object.id]) return object;
      const eye = worldFromGroupedPoint(node.position, settings);
      let target = new THREE.Vector3(...object.position).add(new THREE.Vector3(0, 0.1, 0));
      const turned = object.rotation.some((value, axis) => axis !== 1 && value !== 0);
      const put = (point: THREE.Vector3) => {
        object = { ...object, position: [point.x, point.y + 0.01, point.z] as Vec3, ...(turned ? {} : { rotation: [0, Number(heading(eye, point).toFixed(1)), 0] as Vec3 }) };
        target = point.clone().add(new THREE.Vector3(0, 0.11, 0));
      };

      // A guided tour shows a stop's objects: one well off its view comes into it.
      if (experience.kind === "tour" && stop.view.rotation) {
        const view = cameraDirection(stop.view.rotation);
        const flat = new THREE.Vector3(view.x, 0, view.z);
        if (THREE.MathUtils.radToDeg(view.angleTo(target.clone().sub(eye))) > 60 && flat.lengthSq() > 0.01) {
          flat.normalize();
          const side = new THREE.Vector3(-flat.z, 0, flat.x);
          const index = moved.get(stop.id) ?? 0;
          moved.set(stop.id, index + 1);
          const offset = ((index % 3) - 1) * 1.2;
          for (const reach of [6, 4, 3]) {
            const ground = surfaceBelow(eye.clone().addScaledVector(flat, reach).addScaledVector(side, offset), 12);
            if (ground && visibleFrom(eye, ground.clone().add(new THREE.Vector3(0, 0.1, 0)))) { put(ground); break; }
          }
        }
      }
      // Not across the valley.
      if (target.distanceTo(eye) > nearby) {
        const ground = surfaceBelow(eye.clone().addScaledVector(target.clone().sub(eye).normalize(), nearby).add(new THREE.Vector3(0, 0.5, 0)), 40);
        if (ground) put(ground);
      }
      // Not behind a wall.
      const toward = target.clone().sub(eye);
      const distance = toward.length();
      if (distance < 0.5) return object;
      raycaster.set(eye, toward.clone().normalize());
      const hit = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 0.15);
      if (!hit || hit.distance >= distance - 0.15) return object;
      const normal = hit.face ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize() : null;
      if (normal && normal.dot(toward) > 0) normal.negate();
      if (normal && normal.y >= 0.7) { put(hit.point); return object; }
      // A wall or a step's face: stand on the floor just in front of it.
      const ground = surfaceBelow(hit.point.clone().addScaledVector(toward.normalize(), -0.3).add(new THREE.Vector3(0, 0.3, 0)), 40);
      if (ground) put(ground);
      return object;
    });
  }
}
