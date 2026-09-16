#!/usr/bin/env node
// Supply {"username":"…","password":"…"} on stdin. Never store credentials in Git or shell arguments.
import { initializeAdmin } from '../../lib/server/admin-store.ts';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) throw new Error('Input too large.');
}
const { username, password } = JSON.parse(input);
await initializeAdmin(username, password);
console.log('Admin account created.');
