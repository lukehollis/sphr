import type { SphrBootstrap } from '@/lib/types';

/** Check every segment before starting, including ones reached later in a tour. */
export function assertNativeBootstrap(bootstrap: SphrBootstrap) {
  const hosted = [bootstrap.space, ...(bootstrap.orderedSpaces ?? [])].some(space => {
    if (space.type === 'matterport') return true;
    try {
      const host = new URL(space.src ?? '').hostname.toLowerCase();
      return host === 'matterport.com' || host.endsWith('.matterport.com');
    } catch { return false; }
  });
  if (hosted) throw new Error('This space needs a native capture before it can be viewed. Matterport embeds are not supported.');
}
