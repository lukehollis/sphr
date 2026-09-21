export type SceneListing = {
  sceneId: string;
  titleSlug: string;
  scenePath: string;
  slug: string;
  title: string;
  bootstrapUrl: string;
  thumbnail: string;
  nodeCount: number;
  createdAt: string;
  legacy?: { kind: "space" | "tour"; id: string };
  sourceType?: string;
  hasGuidedTour?: boolean;
};
