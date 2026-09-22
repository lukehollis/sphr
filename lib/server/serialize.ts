// The application runs as one Node process, so per-key promise chains serialize
// read-modify-write sequences such as billing updates and chunk appends.
const locks = new Map<string, Promise<unknown>>();

export function serialized<T>(key: string, work: () => Promise<T>) {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}
