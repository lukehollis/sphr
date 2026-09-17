import { redirectLegacy } from '@/lib/server/legacy-redirect';

export const dynamic = 'force-dynamic';
export default async function LegacySpace({ params, searchParams }: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return redirectLegacy('space', (await params).reference, await searchParams);
}
