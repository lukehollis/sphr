#!/usr/bin/env python3
"""Write lib/server/scanner-networks.json: the address blocks of networks whose page loads are link scanners and
crawlers, not people. The analytics leave browser errors from them out (lib/server/scanner-networks.ts).

Microsoft's: when a link is shared in Outlook or Teams, Microsoft's link scanner opens the page and every link on it
from Azure addresses, with an ordinary Chrome user agent. Its pages throw "Object Not Found Matching Id" and fail
to load script chunks. CDS Global Cloud's: a crawler with a 2025 Chrome and an iOS 13 user agent, whose page loads
fail to load chunks nearly every time.

Clouds where people's own traffic leaves from (iCloud Private Relay, VPNs, school web filters on AWS) stay out.

    python3 scripts/scanner_networks.py

Reads the networks' announced prefixes from RIPEstat. Run it again now and then; the date is kept in the file.
"""
import ipaddress
import json
from pathlib import Path
import urllib.request

NETWORKS = {'AS8075': 'Microsoft', 'AS63199': 'CDS Global Cloud'}
TARGET = Path(__file__).resolve().parent.parent / 'lib/server/scanner-networks.json'


def announced(asn):
    url = f'https://stat.ripe.net/data/announced-prefixes/data.json?resource={asn}'
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'spacery-scanner-networks'}), timeout=120) as response:
        data = json.load(response)['data']
    prefixes = [ipaddress.ip_network(item['prefix']) for item in data['prefixes']]
    if not prefixes:
        raise SystemExit(f'{asn} announces nothing; not writing an empty list')
    collapsed = [str(net) for version in (4, 6) for net in ipaddress.collapse_addresses(p for p in prefixes if p.version == version)]
    return data['query_endtime'][:10], collapsed


def main():
    networks, dates = [], []
    for asn, name in NETWORKS.items():
        date, prefixes = announced(asn)
        dates.append(date)
        networks.append({'name': name, 'asn': asn, 'prefixes': prefixes})
        print(f'{asn} {name}: {len(prefixes)} blocks')
    TARGET.write_text(json.dumps({'source': 'RIPEstat announced-prefixes', 'date': min(dates), 'networks': networks}, separators=(',', ':')) + '\n')
    print(f'wrote {TARGET}')


if __name__ == '__main__':
    main()
