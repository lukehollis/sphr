import { normalizeTour } from '@/lib/bootstrap';
import type { SceneGraphNode, SphrBootstrap, SphrSpace } from '@/lib/types';

export function tourSegment(bootstrap: SphrBootstrap, spaceIndex: number, pointIndex: number) {
  const tour = normalizeTour(bootstrap);
  const segment = tour.spaces[spaceIndex];
  const point = segment?.tourpoints[pointIndex];
  if (!point) throw new Error('Tour location does not exist.');
  const space = bootstrap.orderedSpaces?.find(item => String(item.id) === String(segment.id))
    ?? (spaceIndex === 0 ? bootstrap.space : undefined);
  if (!space) throw new Error('The next space is missing from this tour.');
  const model = point.targetType === 'MODEL';
  const models = new Set(model ? point.models : segment.tourpoints.filter(item => item.targetType !== 'MODEL').flatMap(item => item.models ?? []));
  const graph = new Map<string, SceneGraphNode>();
  for (const node of [...(space.space_data.sceneGraph ?? []), ...tour.sceneGraph]) {
    if (model ? models.has(node.id) : node.persistent || node.raycast || node.type !== 'model' || models.has(node.id)) graph.set(node.id, node);
  }
  let activeSpace: SphrSpace = space;
  if (model) {
    if (!graph.size) throw new Error('The object for this tour stop is missing.');
    activeSpace = { ...space, type: 'model', mesh: null, space_data: {
      noPanos: true, navigationTransition: { enabled: false },
      sceneGraph: [...graph.values()].map(node => ({ ...node, persistent: true, raycast: true }))
    } };
  }
  return {
    key: `${spaceIndex}:${model ? 'model:' + [...models].sort().join(',') : space.type}`,
    point, space: activeSpace,
    bootstrap: {
      ...bootstrap, space: activeSpace, orderedSpaces: undefined,
      tour: { ...bootstrap.tour, tour_data: {
        ...bootstrap.tour?.tour_data,
        mode: tour.hasGuidedTour ? 'guided' : 'explore',
        spaces: [segment], sceneGraph: model ? activeSpace.space_data.sceneGraph : [...graph.values()],
        annotationGraph: model ? [] : tour.annotationGraph
      } }
    } as SphrBootstrap
  };
}

export function nextTourLocation(bootstrap: SphrBootstrap, spaceIndex: number, pointIndex: number, direction: 1 | -1) {
  const spaces = normalizeTour(bootstrap).spaces;
  const point = pointIndex + direction;
  if (point >= 0 && point < spaces[spaceIndex].tourpoints.length) return { spaceIndex, pointIndex: point };
  const nextSpace = spaceIndex + direction;
  if (!spaces[nextSpace]) return null;
  return { spaceIndex: nextSpace, pointIndex: direction === 1 ? 0 : spaces[nextSpace].tourpoints.length - 1 };
}
