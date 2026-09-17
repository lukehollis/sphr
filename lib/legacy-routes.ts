import type { SceneListing } from './scene-types';

export function legacyDestination(scenes: SceneListing[], kind: 'space' | 'tour', reference: string) {
  const id = /^([1-9][0-9]*)(?:-[^/]+)?$/.exec(reference)?.[1];
  if (!id) return undefined;
  return scenes.find(scene => scene.legacy?.kind === kind && scene.legacy.id === id)?.scenePath;
}
