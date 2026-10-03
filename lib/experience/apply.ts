import type { SphrBootstrap, TourPoint, TourSpace } from "@/lib/types";
import { parseExperience } from "@/lib/experience/validate";
import { emptyExperience, htmlToPlainText, type Experience, type ExperienceStop } from "@/lib/experience/types";

function openingSegment(bootstrap: SphrBootstrap): TourSpace | undefined {
  return (bootstrap.tour?.tour_data?.spaces ?? bootstrap.tour?.tour_data?.tourmodels)?.[0];
}

export function stopToTourPoint(stop: ExperienceStop): TourPoint {
  return {
    id: stop.id,
    title: stop.title,
    text: stop.text,
    format: "plain",
    secondaryText: stop.detail ?? null,
    nodeUUID: stop.view.nodeId,
    targetType: stop.view.nodeId ? "NODE" : "FREE",
    viewMode: stop.view.viewMode ?? "FPV",
    ...(stop.view.position ? { position: stop.view.position } : {}),
    rotation: stop.view.rotation,
    ...(stop.view.fov ? { fov: stop.view.fov } : {}),
    zoom: 0,
    objects: stop.objects,
    effects: stop.effects,
    ...(stop.find ? { find: stop.find } : {}),
    ...(stop.look ? { look: stop.look } : {}),
    files: stop.files ?? [],
    sounds: stop.sounds ?? [],
    models: stop.models ?? [],
    annotations: stop.annotations ?? []
  };
}

/**
 * Write an authored tour or hunt into the opening space of a bootstrap. A
 * `standalone` tour is someone's own tour of a space: it replaces the space's
 * authored stops even when it has none yet, and leaves out the spaces and
 * narration a longer authored tour would continue into.
 */
export function applyExperience(input: SphrBootstrap, experience: Experience, { standalone = false } = {}): SphrBootstrap {
  const result = structuredClone(input);
  const data = result.tour?.tour_data ?? {};
  const spaces = data.spaces ?? data.tourmodels ?? [];
  const segment: TourSpace = spaces[0] ?? { id: result.space.id, title: result.space.title, tourpoints: [] };
  const points = experience.stops.map(stopToTourPoint);
  const updated: TourSpace = { ...segment, tourpoints: points.length || standalone ? points : segment.tourpoints, objects: experience.objects, effects: experience.effects };
  if (standalone) {
    result.space = result.orderedSpaces?.find((space) => String(space.id) === String(segment.id)) ?? result.space;
    result.orderedSpaces = undefined;
  }
  result.tour = {
    ...result.tour,
    tour_data: {
      ...data,
      ...(points.length ? { mode: "guided" as const } : standalone ? { mode: "explore" as const } : {}),
      ...(standalone ? { audio: {}, autoplay: false } : {}),
      kind: experience.kind,
      finale: experience.finale,
      look: experience.look,
      objects: experience.objects,
      effects: experience.effects,
      spaces: standalone ? [updated] : [updated, ...spaces.slice(1)],
      tourmodels: undefined
    }
  };
  return result;
}

/**
 * The builder's starting point: a saved experience, or the space's existing
 * authored stops turned into editable plain text.
 */
export function experienceFromBootstrap(bootstrap: SphrBootstrap): Experience {
  const data = bootstrap.tour?.tour_data;
  const segment = openingSegment(bootstrap);
  const explore = data?.mode === "explore";
  const points = explore ? [] : (segment?.tourpoints ?? []).filter((point) => point.targetType !== "MODEL");
  const draft = {
    version: 1,
    kind: data?.kind === "hunt" ? "hunt" : "tour",
    finale: data?.finale,
    look: data?.look,
    objects: segment?.objects ?? data?.objects ?? [],
    effects: segment?.effects ?? data?.effects ?? [],
    stops: points.map((point, index) => ({
      id: point.id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(point.id) ? point.id : `stop-${index + 1}`,
      title: point.title ?? "",
      text: point.format === "plain" ? point.text ?? "" : htmlToPlainText(point.text),
      detail: point.format === "plain" ? point.secondaryText ?? "" : htmlToPlainText(point.secondaryText),
      view: {
        nodeId: point.nodeUUID,
        position: point.nodeUUID ? undefined : point.position,
        rotation: point.rotation ?? { azimuth: 0, polar: 0 },
        fov: point.fov,
        viewMode: point.viewMode === "ORBIT" ? "ORBIT" : "FPV"
      },
      objects: point.objects ?? [],
      effects: point.effects ?? [],
      find: point.find,
      look: point.look,
      files: point.files,
      sounds: point.sounds,
      models: point.models,
      annotations: point.annotations ?? point.overlays
    }))
  };
  try { return parseExperience(draft, { lenient: true }); }
  catch { return emptyExperience(); }
}
