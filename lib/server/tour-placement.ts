import * as THREE from "three";
import { parseExperience } from "@/lib/experience/validate";
import type { Experience, Vec3 } from "@/lib/experience/types";
import { aimFrom, placeObjectAt, type AnchorSpot } from "@/lib/experience/placement";
import { openingSpace } from "@/lib/scene-edits";
import { cameraDirection, sceneGroupSettings, worldFromGroupedPoint } from "@/lib/three/math";
import { panoramaPixelDirection } from "@/lib/three/renderers/PanoramaLayer";
import type { SphrBootstrap } from "@/lib/types";
import type { AgentAnchors } from "@/lib/server/tour-agent";
import { pointInView, type SpaceView } from "@/lib/server/space-views";

/**
 * Places an agent's draft without a browser, for people's own agents that build tours
 * through the API, the way the builder does in the viewer: each pixel the agent pointed
 * at becomes a ray from its panorama location, cast against the space's capture mesh
 * (see capture-mesh.ts), and objects follow the builder's rules (placeObjectAt). A
 * space without a capture mesh uses the floor under each location as the ground.
 */
export function placeOnServer(bootstrap: SphrBootstrap, experience: Experience, anchors: AgentAnchors, meshes: THREE.Object3D[] = [], views: SpaceView[] = []): Experience {
  const data = openingSpace(bootstrap).space_data;
  const nodes = new Map((data.noPanos ? [] : data.nodes ?? data.navPoints ?? []).map((node) => [node.uuid, node]));
  const settings = sceneGroupSettings("nodes", data);
  const toArray = (vector: THREE.Vector3) => [vector.x, vector.y, vector.z] as Vec3;
  const raycaster = new THREE.Raycaster();
  raycaster.far = 500;

  const resolve = (anchor: { nodeId?: string; face?: number; view?: string; x: number; y: number }): AnchorSpot | null => {
    // A view drawn on the server: its depth gives the point under the pixel.
    const view = anchor.view ? views.find((item) => item.id === anchor.view) : undefined;
    if (view) {
      const origin = new THREE.Vector3(...view.camera.position);
      const found = pointInView(view, anchor.x, anchor.y);
      const toward = found ? found.point.clone().sub(origin).normalize() : null;
      if (!found || !toward) return null;
      const normal = found.normal;
      const point = found.point.clone().addScaledVector(normal ?? toward.clone().negate(), normal && normal.y > 0.7 ? 0.01 : 0.06);
      return { origin: toArray(origin), floor: null, position: toArray(point), normal: normal ? toArray(normal) : null, hit: true, distance: found.distance,
        rotation: { azimuth: THREE.MathUtils.radToDeg(Math.atan2(-toward.x, -toward.z)), polar: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(toward.y, -1, 1))) } };
    }
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
    // A stop above the map keeps the angle the agent gave it.
    const spot = anchor && !stop.view.earth ? resolve(anchor) : null;
    if (!spot) return stop;
    // In a space without panoramas, a stop stands where the view it was aimed in was drawn from.
    const drawnFrom = anchor?.view ? views.find((item) => item.id === anchor.view) : undefined;
    if (drawnFrom && !stop.view.nodeId) {
      const aimed = aimFrom(drawnFrom.camera.position, spot.position);
      const [x, y, z] = drawnFrom.camera.position;
      return { ...stop, view: { ...stop.view, position: { x, y, z }, rotation: aimed ?? { azimuth: Number(drawnFrom.camera.azimuth.toFixed(2)), polar: Number(drawnFrom.camera.polar.toFixed(2)) } } };
    }
    const standing = stop.view.nodeId ? nodes.get(stop.view.nodeId) : undefined;
    const aimed = standing && spot.hit ? aimFrom(toArray(worldFromGroupedPoint(standing.position, settings)), spot.position) : null;
    return { ...stop, view: { ...stop.view, rotation: aimed ?? { azimuth: Number(spot.rotation.azimuth.toFixed(2)), polar: Number(spot.rotation.polar.toFixed(2)) } } };
  });
  const placedNow = new Set(Object.keys(anchors.objects));
  const objects = meshes.length ? keepNoticeable(bootstrap, { ...experience, objects: placed, stops }, meshes, placedNow) : placed;
  const framed = experience.kind === "tour" ? frameStops(bootstrap, { ...experience, objects, stops }, placedNow) : stops;
  return parseExperience({ ...experience, objects, effects, stops: framed }, { lenient: true });
}

/**
 * Whether a direction (heading and tilt in degrees) shows well in a stop's view: up to 20
 * degrees left of center (the tour's text covers the left of wide screens), 32 right, and
 * 28 up or down. Positive `across` is to the left.
 */
export function inFrame(rotation: { azimuth: number; polar: number }, aim: { azimuth: number; polar: number }) {
  const across = ((aim.azimuth - rotation.azimuth) % 360 + 540) % 360 - 180;
  return across <= 20 && across >= -32 && Math.abs(aim.polar - rotation.polar) <= 28;
}

/**
 * A guided tour stop whose objects are all out of its frame (a high vantage point looking
 * out over a space whose ground is far below) turns toward them, the nearest one (or the
 * middle of them when they fit together) a little right of and below center, tilting no
 * more than 35 degrees down or 20 up.
 */
export function frameStops(bootstrap: SphrBootstrap, experience: Experience, only?: Set<string>) {
  const data = openingSpace(bootstrap).space_data;
  const nodes = new Map((data.noPanos ? [] : data.nodes ?? data.navPoints ?? []).map((node) => [node.uuid, node]));
  const settings = sceneGroupSettings("nodes", data);
  const objects = new Map(experience.objects.map((object) => [object.id, object]));
  return experience.stops.map((stop) => {
    const node = stop.view.nodeId ? nodes.get(stop.view.nodeId) : undefined;
    const rotation = stop.view.rotation;
    const shown = stop.objects.filter((id) => !only || only.has(id)).map((id) => objects.get(id)).filter((object): object is NonNullable<typeof object> => Boolean(object));
    if (!node || !rotation || !shown.length || stop.view.earth) return stop;
    const eye = worldFromGroupedPoint(node.position, settings);
    const aims = shown.map((object) => {
      const point = new THREE.Vector3(...object.position).add(new THREE.Vector3(0, 0.3, 0));
      const aim = aimFrom([eye.x, eye.y, eye.z], [point.x, point.y, point.z]);
      return aim ? { aim, distance: point.distanceTo(eye) } : null;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!aims.length || aims.some(({ aim }) => inFrame(rotation, aim))) return stop;
    // Between them when they fit in one view, otherwise the nearest.
    const nearest = aims.reduce((best, item) => item.distance < best.distance ? item : best).aim;
    const spread = aims.map(({ aim }) => ((aim.azimuth - nearest.azimuth) % 360 + 540) % 360 - 180);
    const together = Math.max(...spread) - Math.min(...spread) <= 40;
    const azimuth = (together ? nearest.azimuth + (Math.max(...spread) + Math.min(...spread)) / 2 : nearest.azimuth) + 8;
    const polar = THREE.MathUtils.clamp((together ? aims.reduce((sum, { aim }) => sum + aim.polar, 0) / aims.length : nearest.polar) + 12, -35, 20);
    return { ...stop, view: { ...stop.view, rotation: { azimuth: Number((((azimuth + 540) % 360) - 180).toFixed(2)), polar: Number(polar.toFixed(2)) } } };
  });
}

/**
 * The agent picks spots in photos taken from many places, so an object can end up out of
 * the view of the stop that shows it, behind a step or a wall (a hunt's object would then
 * be impossible to click), or so far across a large space that it is too small to notice.
 * Seen from the first stop that lists it: in a guided tour, an object toward the edge of
 * that stop's view or out of it comes onto the ground a few meters ahead, a little right of
 * center (the tour's text covers the left on wide screens); one more than 18 meters away
 * comes to the first ground along the same line of sight; and one the capture hides comes
 * forward onto the surface in the way, or the floor just in front of that. Ground can be
 * sloped (seating, a hillside) but not a wall. `only` limits it to objects just placed.
 */
export function keepNoticeable(bootstrap: SphrBootstrap, experience: Experience, meshes: THREE.Object3D[], only?: Set<string>) {
  const data = openingSpace(bootstrap).space_data;
  const nodes = new Map((data.noPanos ? [] : data.nodes ?? data.navPoints ?? []).map((node) => [node.uuid, node]));
  const settings = sceneGroupSettings("nodes", data);
  const toArray = (vector: THREE.Vector3) => [vector.x, vector.y, vector.z] as Vec3;
  const raycaster = new THREE.Raycaster();
  raycaster.far = 500;
  const down = new THREE.Vector3(0, -1, 0);
  const lift = (point: THREE.Vector3, height: number) => point.clone().add(new THREE.Vector3(0, height, 0));
  const nearby = 18;

  const firstStop = new Map<string, Experience["stops"][number]>();
  for (const stop of experience.stops) {
    if (!stop.view.nodeId) continue;
    for (const id of [...stop.objects, ...(stop.find ? [stop.find.objectId] : [])]) if (!firstStop.has(id)) firstStop.set(id, stop);
  }
  const normalOf = (hit: THREE.Intersection) => hit.face
    ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize()
    : null;
  /** The ground below a point: the first surface under it, if it is not a wall. */
  const groundBelow = (from: THREE.Vector3, within: number) => {
    raycaster.set(from, down);
    const hit = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 0.05 && item.distance < within);
    const normal = hit ? normalOf(hit) : null;
    return hit && (!normal || Math.abs(normal.y) > 0.5) ? hit.point : null;
  };
  /** Whether nothing in the capture stands between the eye and a point (rough meshes get some slack). */
  const visibleFrom = (eye: THREE.Vector3, point: THREE.Vector3) => {
    const toward = point.clone().sub(eye);
    raycaster.set(eye, toward.clone().normalize());
    const hit = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 0.15);
    return !hit || hit.distance >= toward.length() - 0.4;
  };
  const moved = new Map<string, number>();

  return experience.objects.map((original) => {
    let object = original;
    const stop = firstStop.get(object.id);
    const node = nodes.get(stop?.view.nodeId ?? "");
    if (!stop || !node || (only && !only.has(object.id))) return object;
    const eye = worldFromGroupedPoint(node.position, settings);
    let target = lift(new THREE.Vector3(...object.position), 0.1);
    const turned = object.rotation.some((value, axis) => axis !== 1 && value !== 0);
    const put = (point: THREE.Vector3) => {
      const heading = aimFrom(toArray(eye), toArray(point))?.azimuth ?? 0;
      object = { ...object, position: [point.x, point.y + 0.01, point.z] as Vec3, ...(turned ? {} : { rotation: [0, Number(heading.toFixed(1)), 0] as Vec3 }) };
      target = lift(point, 0.11);
    };
    const rotation = stop.view.rotation;
    const tour = experience.kind === "tour" && Boolean(rotation);
    const framed = (point: THREE.Vector3) => {
      const aim = rotation ? aimFrom(toArray(eye), toArray(point)) : null;
      return !rotation || !aim || inFrame(rotation, aim);
    };
    /** Stands the object on the ground under a point, if the visitor would see it there (and, in a tour, in the stop's view). */
    const tryGround = (point: THREE.Vector3, within: number, inView = tour) => {
      const ground = groundBelow(lift(point, 0.5), within);
      if (!ground || !visibleFrom(eye, lift(ground, 0.1)) || ground.distanceTo(eye) > 32) return false;
      if (inView && !framed(lift(ground, 0.3))) return false;
      put(ground);
      return true;
    };

    // A guided tour shows a stop's objects in its view, clear of the text on the left: on the
    // ground a few meters ahead, a little right of center, or where the stop's gaze lands.
    let framedHere = false;
    if (tour && rotation && !framed(target)) {
      const view = cameraDirection(rotation);
      const flat = new THREE.Vector3(view.x, 0, view.z);
      if (flat.lengthSq() > 0.01) {
        flat.normalize();
        const side = new THREE.Vector3(-flat.z, 0, flat.x);
        const index = moved.get(stop.id) ?? 0;
        moved.set(stop.id, index + 1);
        const offset = [0.8, 2.2, -0.6][index % 3];
        for (const reach of [6, 8, 4, 10, 3, 13]) {
          if ((framedHere = tryGround(eye.clone().addScaledVector(flat, reach).addScaledVector(side, offset * reach / 6), 30))) break;
        }
        if (!framedHere) {
          raycaster.set(eye, view);
          const gaze = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 1);
          if (gaze) {
            const near = gaze.point.clone().addScaledVector(view, -Math.min(2, gaze.distance / 4)).addScaledVector(side, offset);
            framedHere = tryGround(near, 30) || tryGround(gaze.point, 30);
          }
        }
      }
    }
    // Not across the valley: the first ground along the same line within reach (in a tour,
    // still in the stop's view).
    if (!framedHere && target.distanceTo(eye) > nearby) {
      const line = target.clone().sub(eye).normalize();
      for (const reach of [nearby, 14, 10, 7]) if (tryGround(eye.clone().addScaledVector(line, reach), 40)) break;
    }
    // Not behind a wall: forward onto what is in the way, or the floor in front of it.
    const toward = target.clone().sub(eye);
    const distance = toward.length();
    if (distance < 0.5) return object;
    raycaster.set(eye, toward.clone().normalize());
    const hit = raycaster.intersectObjects(meshes, false).find((item) => item.distance > 0.15);
    if (!hit || hit.distance >= distance - 0.15) return object;
    const normal = normalOf(hit);
    if (normal && normal.dot(toward) > 0) normal.negate();
    if (normal && normal.y >= 0.7) { put(hit.point); return object; }
    const ground = groundBelow(lift(hit.point.clone().addScaledVector(toward.normalize(), -0.3), 0.3), 40);
    if (ground) put(ground);
    return object;
  });
}
