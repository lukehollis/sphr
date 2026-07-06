import type { IiifConfig, MediaFile, NodeData } from "@/lib/types";

const IIIF_BASE = "https://iiif.mused.org";
const STATIC_BASE = "https://static.mused.org";

export function isAbsoluteUrl(value?: string | null) {
  return Boolean(value && /^https?:\/\//i.test(value));
}

export function staticUrl(path?: string | null) {
  if (!path) return "";
  if (isAbsoluteUrl(path) || path.startsWith("/")) return path;
  return `${STATIC_BASE}/${path.replace(/^\/+/, "")}`;
}

export function iiifImageUrl(path: string, size = "full", region = "full", rotation = "0", quality = "default", format = "jpg") {
  if (isAbsoluteUrl(path) && path.includes("/full/")) return path;
  const cleanPath = isAbsoluteUrl(path) ? path.replace(`${IIIF_BASE}/`, "") : path.replace(/^\/+/, "");
  return `${IIIF_BASE}/${cleanPath}/${region}/${size}/${rotation}/${quality}.${format}`;
}

export function iiifSquareUrl(path: string, size = "600,") {
  return iiifImageUrl(path, size, "square");
}

export function mediaImageUrl(input?: Pick<MediaFile, "filename" | "url" | "file" | "image" | "mime_type" | "mimeType"> | null, size = "1200,") {
  if (!input) return "";
  const raw = input.url ?? input.file ?? input.image ?? input.filename ?? "";
  if (!raw) return "";
  const mimeType = input.mime_type ?? input.mimeType ?? "";
  if (raw.endsWith(".gif") || mimeType.includes("gif")) return staticUrl(raw);
  if (isAbsoluteUrl(raw)) return raw.includes("/iiif/") || raw.includes("iiif.") ? raw : raw;
  return iiifImageUrl(raw, size);
}

export function mediaVideoUrl(input?: Pick<MediaFile, "filename" | "url" | "file" | "video"> | null) {
  if (!input) return "";
  const raw = input.url ?? input.file ?? input.video ?? input.filename ?? "";
  return raw ? staticUrl(raw) : "";
}

export function nodePanoramaUrl(node: NodeData, size = "full") {
  if (!node.image) return "";
  if (isAbsoluteUrl(node.image)) return node.image;
  return iiifImageUrl(node.image, size === "full" ? "full" : `${size},`);
}

export function nodeCubeFaceUrl(node: NodeData, faceIndex: number, resolution = "1024", version?: string | null) {
  const explicitFaces = node.cubeFaces ?? node.faces;
  if (explicitFaces?.[faceIndex]) {
    return explicitFaces[faceIndex].replace("{resolution}", resolution === "full" ? "full" : `${resolution},`);
  }

  if (node.textureTemplate) {
    return node.textureTemplate
      .replace("{face}", String(faceIndex))
      .replace("{faceI}", String(faceIndex))
      .replace("{uuid}", node.uuid)
      .replace("{resolution}", resolution === "full" ? "full" : `${resolution},`);
  }

  const suffix = version ? `_${version}` : "";
  if (resolution === "4096") {
    return `${STATIC_BASE}/spaceshare/${node.uuid}_face${faceIndex}${suffix}.jpg`;
  }
  if (resolution === "1024") {
    return `${STATIC_BASE}/spaceshare/${node.uuid}_face${faceIndex}${suffix}_1024.jpg`;
  }

  const res = resolution === "full" ? "full" : `${resolution},`;
  return `${IIIF_BASE}/spaceshare/${node.uuid}_face${faceIndex}${suffix}.jpg/full/${res}/0/default.jpg`;
}

export function iiifConfigUrl(config: IiifConfig, size = "1600,") {
  const source = config.url ?? config.image ?? "";
  if (!source) return "";
  if (isAbsoluteUrl(source) && source.includes("/full/")) return source;
  if (isAbsoluteUrl(source) && !source.includes(IIIF_BASE)) return source;
  return iiifImageUrl(
    source.replace(`${IIIF_BASE}/`, ""),
    config.size ?? size,
    config.region ?? "full",
    typeof config.rotation === "string" ? config.rotation : "0",
    config.quality ?? "default",
    config.format ?? "jpg"
  );
}

export function iiifInfoUrl(config: IiifConfig) {
  if (config.infoUrl) return config.infoUrl;
  const source = config.url ?? config.image ?? "";
  if (!source || (isAbsoluteUrl(source) && !source.includes(IIIF_BASE))) return "";
  const stripped = source
    .replace(`${IIIF_BASE}/`, "")
    .replace(/\/full\/.*$/, "")
    .replace(/\/info\.json$/, "");
  return `${IIIF_BASE}/${stripped}/info.json`;
}
