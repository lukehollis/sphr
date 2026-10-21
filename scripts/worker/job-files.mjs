// Reading files a processing agent wrote. The agent controls its job folder, so any name in it could be a
// symlink to a secret on the worker machine; reading one and relaying it (progress lines reach the customer)
// would leak it. The final component is opened without following links, and the opened file must sit inside
// the job folder — checked on the open descriptor where /proc exists (Linux), so swapping a parent folder for a
// link between the check and the read fails too.
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function readJobFile(dir, relative, { maxBytes = 1_000_000, tail = false } = {}) {
  const base = realpathSync(dir);
  const fd = openSync(path.join(dir, relative), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${relative} is not a regular file`);
    const opened = existsSync(`/proc/self/fd/${fd}`) ? realpathSync(`/proc/self/fd/${fd}`) : realpathSync(path.join(dir, relative));
    if (!opened.startsWith(base + path.sep)) throw new Error(`${relative} is outside the job folder`);
    if (!tail && info.size > maxBytes) throw new Error(`${relative} is too large`);
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, Math.max(0, info.size - length));
    return buffer.toString('utf8');
  } finally { closeSync(fd); }
}
