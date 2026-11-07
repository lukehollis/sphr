import { BlockList, isIP } from "node:net";
import data from "./scanner-networks.json" with { type: "json" };

// Networks whose page loads are link scanners and crawlers, not people (scripts/scanner_networks.py says which and
// why): Microsoft's link scanner opens every link of a page shared in Outlook or Teams from Azure, and Meta opens a link
// shared on Facebook from its own network, both with an ordinary Chrome user agent, so the user-agent test in
// analytics.ts can't tell them from a person.

let lists: { name: string; list: BlockList }[] | undefined;

function networks() {
  lists ??= data.networks.map(({ name, prefixes }) => {
    const list = new BlockList();
    for (const prefix of prefixes) {
      const [address, bits] = prefix.split("/");
      list.addSubnet(address, Number(bits), address.includes(":") ? "ipv6" : "ipv4");
    }
    return { name, list };
  });
  return lists;
}

/** The scanner network an address belongs to ("Microsoft"), or null for any other address or none. */
export function scannerNetwork(address: string | null | undefined) {
  const version = address ? isIP(address) : 0;
  if (!address || !version) return null;
  const type = version === 6 ? "ipv6" : "ipv4";
  return networks().find(({ list }) => list.check(address, type))?.name ?? null;
}
