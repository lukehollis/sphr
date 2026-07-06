import gardenSpaceJson from "@/lib/data/garden-space.json";
import gardenTourJson from "@/lib/data/garden-tour.json";
import gardenUiJson from "@/lib/data/garden-ui.json";
import type {
  NormalizedTour,
  SphrBootstrap,
  SphrSpace,
  SphrTour,
  TourData,
  TourSpace,
  TourUiText
} from "@/lib/types";

declare global {
  interface Window {
    __SPHR_BOOTSTRAP__?: SphrBootstrap;
  }
}

const gardenSpace = gardenSpaceJson as unknown as SphrSpace["space_data"];
const gardenTour = gardenTourJson as TourData;
const gardenUi = gardenUiJson as TourUiText;
const gardenDollhouseUrl = "/demo/gardenvase_small5.glb";

function degreesToRadians(value = 0) {
  return (value * Math.PI) / 180;
}

export function defaultBootstrap(): SphrBootstrap {
  const modelSettings = gardenSpace.sceneSettings?.model ?? gardenSpace.sceneSettings?.dollhouse;
  const modelOffset = modelSettings?.offsetPosition ?? { x: 0, y: 0, z: 0 };
  const modelRotation = modelSettings?.offsetRotation ?? { x: 0, y: 0, z: 0 };

  return {
    space: {
      id: "garden-demo",
      title: gardenSpace.title ?? "Example Garden Scene",
      type: "splat",
      mesh: gardenDollhouseUrl,
      version: null,
      space_custom: "garden",
      space_data: {
        ...gardenSpace,
        dollhouse: gardenDollhouseUrl,
        splats: [
          {
            id: "garden",
            url: "/demo/garden_demo.spark.splat",
            position: [0, 2.6, 0],
            rotation: [-2.56518, -2.66973, 0.2615546],
            scale: 1,
            lod: false,
            reveal: true
          }
        ],
        navigationTransition: {
          enabled: true,
          meshIds: ["garden-dollhouse"],
          opacity: 0.2,
          meshFadeMs: 900,
          navigationMs: 1100,
          cubeRenderTargetSize: 2048
        },
        sceneGraph: [
          ...(gardenSpace.sceneGraph ?? []),
          {
            id: "garden-dollhouse",
            type: "model",
            file: gardenDollhouseUrl,
            position: [modelOffset.x, modelOffset.y, modelOffset.z],
            rotation: [
              degreesToRadians(modelRotation.x),
              degreesToRadians(modelRotation.y),
              degreesToRadians(modelRotation.z)
            ],
            scale: modelSettings?.scale ?? 4,
            visible: true,
            persistent: true,
            raycast: true,
            fpvOpacity: 0,
            orbitOpacity: 1,
            debugOpacity: 0.28,
            transitionMesh: true,
            transitionOpacity: 0.2,
            transitionFadeMs: 900,
            transitionTexture: "cube-render-target",
            wireframeInDebug: true
          }
        ]
      }
    },
    tour: {
      id: "garden-demo-tour",
      title: gardenTour.settings?.title as string,
      tour_data: gardenTour
    },
    ui: {
      ...gardenUi,
      loadingImage: "/demo/garden_scene_splats_tour.jpg"
    }
  };
}

function parseScriptJson<T>(id: string): T | null {
  const el = document.getElementById(id);
  const text = el?.textContent?.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    console.warn(`Failed to parse #${id}`, error);
    return null;
  }
}

async function fetchBootstrapFromUrl(url: string): Promise<SphrBootstrap> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to load config ${url}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as SphrBootstrap;
}

export async function loadBootstrapData(): Promise<SphrBootstrap> {
  if (typeof window === "undefined") return defaultBootstrap();

  const params = new URLSearchParams(window.location.search);
  const configUrl = params.get("config");
  if (configUrl) {
    return coerceBootstrap(await fetchBootstrapFromUrl(configUrl));
  }

  if (window.__SPHR_BOOTSTRAP__) {
    return coerceBootstrap(window.__SPHR_BOOTSTRAP__);
  }

  const embeddedSpace = parseScriptJson<SphrSpace>("space_data");
  const embeddedTour = parseScriptJson<SphrTour>("tour_data");
  const orderedSpaces = parseScriptJson<SphrSpace[]>("ordered_spaces_data");
  const embeddedUi = parseScriptJson<TourUiText>("ui_data");
  if (embeddedSpace || embeddedTour || orderedSpaces) {
    return coerceBootstrap({
      space: embeddedSpace ?? orderedSpaces?.[0] ?? defaultBootstrap().space,
      tour: embeddedTour,
      orderedSpaces: orderedSpaces ?? undefined,
      ui: embeddedUi ?? defaultBootstrap().ui
    });
  }

  return defaultBootstrap();
}

export function coerceBootstrap(input: SphrBootstrap): SphrBootstrap {
  const fallback = defaultBootstrap();
  const space = normalizeSpace(input.space ?? fallback.space);
  const tour = input.tour ? normalizeTourShell(input.tour) : fallback.tour;
  const orderedSpaces = input.orderedSpaces?.map(normalizeSpace);

  if (tour && orderedSpaces?.length && tour.tour_data?.spaces?.length) {
    const firstTourSpace = tour.tour_data.spaces[0];
    const firstSpace = orderedSpaces.find((item) => String(item.id) === String(firstTourSpace.id));
    if (firstSpace) {
      return {
        space: firstSpace,
        tour,
        orderedSpaces,
        ui: input.ui ?? fallback.ui
      };
    }
  }

  return {
    space,
    tour,
    orderedSpaces,
    ui: input.ui ?? fallback.ui
  };
}

function normalizeSpace(space: SphrSpace): SphrSpace {
  const spaceData = space.space_data ?? {};
  const nodes = spaceData.nodes ?? spaceData.navPoints ?? [];
  const type = space.type ?? inferSpaceType(space);

  return {
    ...space,
    type,
    title: space.title ?? spaceData.title ?? "SPHR Space",
    space_data: {
      ...spaceData,
      nodes,
      navPoints: spaceData.navPoints ?? nodes,
      sceneSettings: {
        offsetPosition: { x: 0, y: 0, z: 0 },
        offsetRotation: { x: 0, y: 0, z: 0 },
        nodes: {
          scale: 1,
          offsetPosition: { x: 0, y: 0, z: 0 },
          offsetRotation: { x: 0, y: 0, z: 0 },
          ...(spaceData.sceneSettings?.nodes ?? spaceData.sceneSettings?.navPoints ?? {})
        },
        navPoints: {
          scale: 1,
          offsetPosition: { x: 0, y: 0, z: 0 },
          offsetRotation: { x: 0, y: 0, z: 0 },
          ...(spaceData.sceneSettings?.navPoints ?? spaceData.sceneSettings?.nodes ?? {})
        },
        model: {
          scale: 1,
          offsetPosition: { x: 0, y: 0, z: 0 },
          offsetRotation: { x: 0, y: 0, z: 0 },
          ...(spaceData.sceneSettings?.model ?? spaceData.sceneSettings?.dollhouse ?? {})
        },
        dollhouse: {
          scale: 1,
          offsetPosition: { x: 0, y: 0, z: 0 },
          offsetRotation: { x: 0, y: 0, z: 0 },
          ...(spaceData.sceneSettings?.dollhouse ?? spaceData.sceneSettings?.model ?? {})
        },
        ...(spaceData.sceneSettings ?? {})
      },
      initialRotation: spaceData.initialRotation ?? { azimuth: 0, polar: 0 }
    }
  };
}

function inferSpaceType(space: SphrSpace) {
  if (space.space_data?.splats?.length) return "splat";
  if (space.space_data?.iiif || space.src?.includes("iiif")) return "iiif";
  if (space.src?.includes("matterport")) return "matterport";
  return "spaces";
}

function normalizeTourShell(tour: SphrTour): SphrTour {
  return {
    ...tour,
    tour_data: normalizeTourData(tour.tour_data ?? (tour as unknown as TourData))
  };
}

function normalizeTourData(data: TourData): TourData {
  const spaces = data.spaces ?? data.tourmodels ?? [];
  return {
    ...data,
    spaces: spaces.map((space, index) => ({
      ...space,
      id: space.id ?? index,
      tourpoints: (space.tourpoints ?? []).map((point, pointIndex) => ({
        ...point,
        id: point.id ?? `${space.id ?? index}-${pointIndex}`,
        files: point.files ?? [],
        models: point.models ?? [],
        annotations: point.annotations ?? point.overlays ?? [],
        sounds: point.sounds ?? [],
        zoom: point.zoom ?? 0,
        viewMode: point.viewMode ?? "FPV",
        targetType: point.targetType ?? (point.nodeUUID ? "NODE" : "FREE")
      }))
    }))
  };
}

export function normalizeTour(bootstrap: SphrBootstrap): NormalizedTour {
  const tourData = normalizeTourData(bootstrap.tour?.tour_data ?? {});
  const firstSpaceFallback: TourSpace = {
    id: bootstrap.space.id ?? "default",
    title: bootstrap.space.title,
    type: bootstrap.space.type,
    tourpoints: [
      {
        id: "default",
        viewMode: "FPV",
        targetType: "FREE",
        text: bootstrap.space.title,
        position: bootstrap.space.space_data.initialPosition ?? { x: 0, y: 1.5, z: 4 },
        rotation: bootstrap.space.space_data.initialRotation ?? { azimuth: 0, polar: 0 },
        zoom: 0,
        files: [],
        models: [],
        annotations: [],
        sounds: []
      }
    ]
  };

  return {
    title: bootstrap.tour?.title ?? bootstrap.space.title,
    spaces: tourData.spaces?.length ? tourData.spaces : [firstSpaceFallback],
    audio: tourData.audio ?? {},
    autoplay: Boolean(tourData.autoplay),
    defaultShowText: tourData.defaultShowText !== false,
    sceneGraph: tourData.sceneGraph ?? bootstrap.space.space_data.sceneGraph ?? [],
    annotationGraph: tourData.annotationGraph ?? bootstrap.space.space_data.annotationGraph ?? []
  };
}

export function activeTourPoint(tour: NormalizedTour, spaceIndex: number, pointIndex: number) {
  return tour.spaces[spaceIndex]?.tourpoints[pointIndex] ?? tour.spaces[0]?.tourpoints[0];
}
