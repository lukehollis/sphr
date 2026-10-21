#!/usr/bin/env node
// The processing sandbox's only way out. Agent containers sit on an internal Docker network with no route to
// the internet, the host, the LAN or the tailnet; this proxy is the one container on both that network and
// the outside. It tunnels HTTPS (CONNECT) to allowlisted host names on port 443, and only when the name
// resolves to a public address, so a compromised job can reach the model API and nothing else.
//   ALLOW=api.anthropic.com PORT=3128 node scripts/worker/egress-proxy.mjs
// See docs/accounts.md ("Isolating the agent on a Linux worker") for the network and container setup.
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

const allow = new Set((process.env.ALLOW ?? 'api.anthropic.com').split(',').map(host => host.trim().toLowerCase()).filter(Boolean));
const port = Number(process.env.PORT ?? 3128);
const log = (verdict, target, why = '') => console.log(`${new Date().toISOString()} ${verdict} ${target}${why ? ` (${why})` : ''}`);

/** Loopback, private, link-local, carrier-grade NAT (Tailscale's 100.64.0.0/10), multicast and reserved. */
function publicIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    || a >= 224);
}

const server = http.createServer((request, response) => {
  log('deny', `${request.method} ${request.url}`, 'plain HTTP');
  response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Only HTTPS to the model API is allowed from the processing sandbox.\n');
});

server.on('connect', async (request, client, head) => {
  const target = String(request.url ?? '');
  const match = target.match(/^([a-z0-9.-]+):(\d+)$/i);
  const deny = why => { log('deny', target, why); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); };
  if (!match || !allow.has(match[1].toLowerCase())) return deny('host not allowed');
  if (Number(match[2]) !== 443) return deny('port not allowed');
  let address;
  try { ({ address } = await dns.lookup(match[1], { family: 4 })); } catch { return deny('no address'); }
  if (!publicIPv4(address)) return deny(`resolves to ${address}`);
  const upstream = net.connect(443, address, () => {
    log('allow', target, address);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => { upstream.destroy(); client.destroy(); };
  upstream.on('error', close);
  client.on('error', close);
  upstream.setTimeout(15 * 60 * 1000, close);
});

server.listen(port, '0.0.0.0', () => log('ready', `:${port}`, `allowing ${[...allow].join(', ')}`));
