import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerNetwork } from '../lib/server/scanner-networks.ts';

test('the addresses Microsoft\'s link scanner and the CDS crawler sent browser errors from are scanner networks', () => {
  // Seen 2026-10-28 to 11-02 opening spacery.dev/migrate/matterport and its links, and in October on a shared mused.com link.
  for (const address of ['4.199.143.156', '4.204.72.11', '9.169.124.20', '48.215.3.173', '57.155.170.206', '68.218.165.164',
    '72.152.84.9', '72.153.231.69', '74.179.67.135', '74.242.242.134', '135.232.19.45', '::ffff:4.199.143.156']) {
    assert.equal(scannerNetwork(address), 'Microsoft', address);
  }
  assert.equal(scannerNetwork('164.52.120.3'), 'CDS Global Cloud');
});

test('Meta\'s network, which opens links shared on Facebook, is a scanner network', () => {
  // Seen 2026-11-07 opening the Tomb of Nefertari tour 24 times in 12 minutes, every load without WebGL 2.
  for (const address of ['2a03:2880:f814:e::', '2a03:2880:9ff:70::', '2a03:2880:7ff:4d::', '2a03:2880:29ff:43::',
    '173.252.83.112', '66.220.149.11', '69.171.249.2', '31.13.115.6']) {
    assert.equal(scannerNetwork(address), 'Meta', address);
  }
});

test('people\'s networks are not, cloud-hosted ones included', () => {
  for (const address of [
    '208.103.121.106', // DQE Communications, which carries school networks
    '207.241.242.1', // Dutchess County BOCES
    '2603:900b:da40:fea:6814:4f3d:2c6f:7503', // a home connection
    '2a04:4e41:6404:4d40::8c48:2d40', // iCloud Private Relay, on Fastly
    '67.226.220.125', // Amazon: school web filters and virtual desktops run there
    '104.28.42.1', // Cloudflare WARP
  ]) assert.equal(scannerNetwork(address), null, address);
});

test('no address, or something that is not one, is no scanner', () => {
  for (const address of [null, undefined, '', 'local', '4.199.143', 'unknown']) assert.equal(scannerNetwork(address), null, String(address));
});
