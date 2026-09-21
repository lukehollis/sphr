import type { CameraRotation, SphrBootstrap, SphrSpace, Vector3Like } from './types';
import type { SceneListing } from './scene-types';

export type StartView = { nodeId?: string; position: Vector3Like; rotation: CameraRotation; fov: number };
export type SceneEdits = { title: string | null; startView: StartView | null; revision: number; thumbnailVersion: string | null };

export function sceneTitleSlug(title: string) {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'space';
}

export function editedListing(scene: SceneListing, edits?: SceneEdits): SceneListing {
  if (!edits) return scene;
  const title = edits.title ?? scene.title;
  const titleSlug = edits.title ? sceneTitleSlug(title) : scene.titleSlug;
  return { ...scene, title, titleSlug, scenePath: `/s/${scene.sceneId}/${titleSlug}`,
    thumbnail: edits.thumbnailVersion ? `/api/scenes/${scene.sceneId}/thumbnail?v=${edits.thumbnailVersion}` : scene.thumbnail };
}

export function openingSpace(bootstrap: SphrBootstrap): SphrSpace {
  const segment = (bootstrap.tour?.tour_data?.spaces ?? bootstrap.tour?.tour_data?.tourmodels)?.[0];
  return bootstrap.orderedSpaces?.find(space => String(space.id) === String(segment?.id)) ?? bootstrap.space;
}

export function startViewEditingIssue(bootstrap: SphrBootstrap) {
  const space = openingSpace(bootstrap);
  if (space.type === 'matterport' || space.src?.includes('my.matterport.com')) {
    return 'This space still uses an embedded Matterport viewer. Import its capture to edit the start view and thumbnail here.';
  }
  const point = (bootstrap.tour?.tour_data?.spaces ?? bootstrap.tour?.tour_data?.tourmodels)?.[0]?.tourpoints[0];
  if (point?.targetType === 'MODEL') return 'This tour opens on a 3D object. Its opening camera is authored in the tour configuration.';
  return null;
}

export function validateStartView(value: unknown, bootstrap: SphrBootstrap): StartView {
  const issue = startViewEditingIssue(bootstrap);
  if (issue) throw new Error(issue);
  if (!value || typeof value !== 'object') throw new Error('Choose a start view.');
  const view = value as StartView;
  const finite = (number: unknown, limit: number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= limit;
  if (!view.position || !['x', 'y', 'z'].every(key => finite(view.position[key as keyof Vector3Like], 1e7))
    || !view.rotation || !finite(view.rotation.azimuth, 360) || !finite(view.rotation.polar, 90)
    || !finite(view.fov, 110) || view.fov < 30) throw new Error('Invalid start camera.');
  const data = openingSpace(bootstrap).space_data;
  const nodes = data.nodes ?? data.navPoints ?? [];
  if (view.nodeId !== undefined && (typeof view.nodeId !== 'string' || !nodes.some(node => node.uuid === view.nodeId))) {
    throw new Error('That location is no longer in this space. Reload the editor.');
  }
  if (!data.noPanos && nodes.length && !view.nodeId) throw new Error('Choose a panorama location.');
  return { ...(view.nodeId ? { nodeId: view.nodeId } : {}), position: { ...view.position },
    rotation: { azimuth: view.rotation.azimuth, polar: view.rotation.polar }, fov: view.fov };
}

/** Apply metadata at the edge; published capture packages and later tour stops remain intact. */
export function applySceneEdits(input: SphrBootstrap, edits: Pick<SceneEdits, 'title' | 'startView'>): SphrBootstrap {
  const result = structuredClone(input);
  const space = openingSpace(result);
  if (edits.title) {
    space.title = edits.title;
    if (result.tour) result.tour.title = edits.title;
  }
  result.space = space;
  const view = edits.startView;
  if (!view) return result;
  // Reimports can remove a scan. Preserve the new package's valid default in that case.
  try { validateStartView(view, result); } catch { return result; }
  Object.assign(space.space_data, { initialNode: view.nodeId, initialPosition: view.position, initialRotation: view.rotation });
  const segment = (result.tour?.tour_data?.spaces ?? result.tour?.tour_data?.tourmodels)?.[0];
  const point = { nodeUUID: view.nodeId, position: view.position, rotation: view.rotation, fov: view.fov,
    zoom: 0, targetType: view.nodeId ? 'NODE' : 'FREE', viewMode: 'FPV' };
  if (segment?.tourpoints.length) {
    const explore = result.tour?.tour_data?.mode === 'explore';
    const index = explore ? Math.max(0, segment.tourpoints.findIndex(item => item.nodeUUID === view.nodeId)) : 0;
    Object.assign(segment.tourpoints[index], point);
  } else {
    result.tour = { ...result.tour, tour_data: { ...result.tour?.tour_data, mode: 'explore',
      spaces: [{ id: space.id, tourpoints: [point] }] } };
  }
  return result;
}

/** Edit only the opening space, with narration and story controls out of the way. */
export function editorBootstrap(input: SphrBootstrap): SphrBootstrap {
  const result = structuredClone(input);
  result.space = openingSpace(result);
  const data = result.tour?.tour_data;
  const segment = (data?.spaces ?? data?.tourmodels)?.[0];
  if (data?.mode !== 'explore' && segment?.tourpoints[0]?.nodeUUID) {
    result.space.space_data.initialNode = segment.tourpoints[0].nodeUUID;
  }
  result.orderedSpaces = undefined;
  result.tour = { ...result.tour, tour_data: { ...data, mode: 'explore', audio: {},
    spaces: segment ? [segment] : undefined, tourmodels: undefined } };
  return result;
}
