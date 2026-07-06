#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function argValue(name, fallback) {
  const flag = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (flag) return flag.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const port = Number(argValue("--port", "3000"));
const config = argValue("--config", "");
let url = `http://localhost:${port}/`;

if (config) {
  let configUrl = config;
  if (!config.startsWith("/") && !/^https?:\/\//i.test(config)) {
    const absolute = path.resolve(root, config);
    const publicRoot = path.join(root, "public");
    if (absolute.startsWith(publicRoot + path.sep)) {
      configUrl = `/${path.relative(publicRoot, absolute).split(path.sep).join("/")}`;
    }
  }
  url += `?config=${encodeURIComponent(configUrl)}`;
}

const listening = await isListening(port);
console.log(url);
console.log(listening ? `Listening: yes on ${port}` : `Listening: no on ${port}. Start with: npm run dev -- --port ${port}`);
