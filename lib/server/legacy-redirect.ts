import { notFound, permanentRedirect } from 'next/navigation';
import { readAllScenes } from '@/lib/scene-catalog';
import { legacyDestination } from '@/lib/legacy-routes';

export async function redirectLegacy(kind: 'space' | 'tour', reference: string, search: Record<string, string | string[] | undefined>) {
  const destination = legacyDestination(await readAllScenes(), kind, reference);
  if (!destination) notFound();
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, item);
  }
  // The canonical route performs the same admin/visibility check as every other link.
  permanentRedirect(destination + (query.size ? '?' + query.toString() : ''));
}
