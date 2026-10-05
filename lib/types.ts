import type { EarthPlace, EffectInstance, ExperienceKind, PlacedObject, StopEarth, StopFind, StopLook, StopSky } from "@/lib/experience/types";

export type Vector3Like = {
  x: number;
  y: number;
  z: number;
};

export type EulerLike = {
  x: number;
  y: number;
  z: number;
};

export type CameraRotation = {
  azimuth: number;
  polar: number;
};

export type TransformConfig = {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number] | number;
};

export type ColorConfig = number | string | [number, number, number];

export type SkyboxConfig = TransformConfig & {
  id?: string;
  type?: "equirectangular" | "sphere" | "cube" | "color";
  url?: string;
  day?: string;
  night?: string;
  faces?: string[];
  cubeFaces?: string[];
  backgroundColor?: ColorConfig;
  nightBackgroundColor?: ColorConfig;
  tint?: ColorConfig;
  nightTint?: ColorConfig;
  radius?: number;
  widthSegments?: number;
  heightSegments?: number;
  opacity?: number;
  initialOpacity?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  dayRotation?: [number, number, number];
  nightRotation?: [number, number, number];
  visible?: boolean;
};

export type SplatConfig = TransformConfig & {
  id?: string;
  url: string;
  fileType?: "ply" | "spz" | "splat" | "ksplat" | "sog" | "rad";
  lod?: boolean | "quality";
  opacity?: number;
  reveal?: boolean;
  /**
   * "sketch" marks a companion splat trained on line drawings of the same photos.
   * It stays hidden until a sketch effect reveals it.
   */
  role?: "color" | "sketch" | "watercolor";
};

export type IiifConfig = TransformConfig & {
  id?: string;
  url?: string;
  image?: string;
  infoUrl?: string;
  width?: number;
  height?: number;
  region?: string;
  size?: string;
  rotation?: string | [number, number, number];
  quality?: string;
  format?: string;
};

export type MediaFile = {
  filename?: string;
  url?: string;
  file?: string;
  image?: string;
  video?: string;
  mime_type?: string;
  mimeType?: string;
  title?: string;
  caption?: string;
};

export type TourPoint = {
  /** Short stop name, shown in editors and above hunt clues. */
  title?: string;
  /** "plain" text is shown as paragraphs, never parsed as HTML. */
  format?: "plain" | "html";
  /** Placed objects shown at this stop (see TourData.objects). */
  objects?: string[];
  /** Effects running at this stop (see TourData.effects). */
  effects?: string[];
  /** Scavenger hunt: the object to find at this step. */
  find?: StopFind;
  /** The frame's look at this stop (see TourData.look). */
  look?: StopLook;
  /** The sky behind the space at this stop (see TourData.sky). */
  sky?: StopSky;
  /** Seen from above over the 3D map (see TourData.place). */
  earth?: StopEarth;
  /** Show the site's reconstruction at this stop, or the capture; unset keeps what shows. */
  reconstruction?: boolean;
  /** A named period of the reconstruction, when its manifest offers several. */
  reconstructionVariant?: string;
  mapUrl?: string;
  /** Explicit vertical field of view, in degrees, when supplied by an authoring system. */
  fov?: number;
  id?: string;
  pan?: string;
  text?: string;
  secondaryText?: string | null;
  viewMode?: "FPV" | "ORBIT" | "DOLLHOUSE" | "FLOORPLAN" | string;
  targetType?: "NODE" | "FREE" | "MODEL" | string;
  nodeUUID?: string;
  position?: Vector3Like;
  rotation?: CameraRotation;
  zoom?: number;
  /** Orbit distance, in meters, for a free (non-node) target viewed in ORBIT mode. */
  distance?: number;
  files?: MediaFile[];
  models?: string[];
  sounds?: string[];
  annotations?: string[];
  overlays?: string[];
  textPosition?: "left" | "right" | "center" | string;
  extra?: string;
  transition?: string;
};

export type TourSpace = {
  id?: string | number;
  /** Objects and effects for this space; the tour-level lists belong to the first space. */
  objects?: PlacedObject[];
  effects?: EffectInstance[];
  mpid?: string;
  slug?: string;
  title?: string;
  type?: string;
  tourpoints: TourPoint[];
};

export type TourData = {
  /** Generated scan waypoints can support navigation without offering a guided tour. */
  mode?: "guided" | "explore";
  /** A guided tour, or a scavenger hunt whose steps ask visitors to find objects. */
  kind?: ExperienceKind;
  /** Custom 3D objects placed in the space. */
  objects?: PlacedObject[];
  /** Visual effects from installed packs. */
  effects?: EffectInstance[];
  /** Shown after the last tour stop, or when every hunt item is found. */
  finale?: string;
  /** Where the tour goes after its last stop: that stop's button opens it instead of free exploration. */
  continueTo?: TourContinue;
  /** The frame's look in free exploration and at stops without their own. */
  look?: StopLook;
  /** The sky behind the space in free exploration and at stops without their own. */
  sky?: StopSky;
  /** Where the space is on the 3D map; the capture's own `geo` when unset. */
  place?: EarthPlace;
  audio?: Record<string, AudioConfig>;
  autoplay?: boolean;
  defaultShowText?: boolean;
  /**
   * How stop text is set over the view: in a dark panel (the default), or
   * straight over the view on a soft gradient from its side, with images as
   * small rounded cards, the way the original guided tours on mused.com look.
   */
  textStyle?: "panel" | "gradient";
  sceneGraph?: SceneGraphNode[];
  annotationGraph?: AnnotationConfig[];
  spaces?: TourSpace[];
  tourmodels?: TourSpace[];
  settings?: Record<string, unknown>;
};

export type SphrTour = {
  id?: string | number;
  title?: string;
  description?: string;
  tour_data?: TourData;
  spaces?: SphrSpace[];
  continue_exploring_link?: string;
  space_custom?: string | null;
};

export type NodeData = {
  uuid: string;
  image?: string;
  faces?: string[];
  cubeFaces?: string[];
  textureTemplate?: string;
  index?: number;
  position: Vector3Like;
  floorPosition?: Vector3Like | null;
  floorUnobserved?: boolean;
  rotation?: EulerLike;
  quaternion?: [number, number, number, number];
  neighbors?: string[];
  label?: string;
  resolution?: string;
  isActive?: boolean;
};

export type SceneSettingsGroup = {
  scale?: number;
  offsetPosition?: Vector3Like;
  offsetRotation?: Vector3Like;
};

export type SceneSettings = {
  offsetPosition?: Vector3Like;
  offsetRotation?: Vector3Like;
  nodes?: SceneSettingsGroup;
  navPoints?: SceneSettingsGroup;
  model?: SceneSettingsGroup;
  dollhouse?: SceneSettingsGroup;
  location?: {
    lat: number;
    lon: number;
  };
};

export type ClickNavigationConfig = {
  enabled?: boolean;
  type?: "mesh-floor";
  yOffset?: number;
  maxHitY?: number;
};

export type NavigationConfig = {
  mode?: "all" | "neighbors";
  maxDistance?: number;
  maxVisible?: number;
  minVisible?: number;
  hideActive?: boolean;
  markerRadius?: number;
};

export type NavigationTransitionConfig = {
  enabled?: boolean;
  meshIds?: string[];
  opacity?: number;
  meshFadeMs?: number;
  navigationMs?: number;
  cubeRenderTargetSize?: number;
};

export type SpaceData = {
  title?: string;
  loadingImage?: string;
  loadingTotal?: number;
  initialNode?: string;
  initialNavPoint?: number | null;
  initialPosition?: Vector3Like;
  initialRotation?: CameraRotation;
  noPanos?: boolean;
  sceneSettings?: SceneSettings;
  nodes?: NodeData[];
  navPoints?: NodeData[];
  dollhouse?: string;
  splats?: SplatConfig[];
  iiif?: IiifConfig | IiifConfig[];
  skybox?: SkyboxConfig | null;
  /** Index of drawn versions of the panorama faces (line drawings, watercolor), for looks. */
  variants?: string;
  clickNavigation?: ClickNavigationConfig;
  navigation?: NavigationConfig;
  navigationTransition?: NavigationTransitionConfig;
  sceneGraph?: SceneGraphNode[];
  annotationGraph?: AnnotationConfig[];
  /** Where the capture is on the 3D map, when its package knows. */
  geo?: EarthPlace;
  /** A stylized model of what the site once looked like: its manifest's address, or the manifest. */
  reconstruction?: string | ReconstructionConfig;
};

/**
 * A reconstruction of a site, built offline as one GLB (Y up, in meters) and
 * placed in the space's world coordinates, where the capture mesh and the
 * panorama locations are. See docs/tours-and-effects.md.
 */
export type ReconstructionConfig = {
  version: 1;
  /** What it shows, such as "The Sanctuary of Poseidon about 440 BC". */
  title?: string;
  /** The GLB, absolute or relative to the manifest. */
  model: string;
  /** Named periods. GLB nodes use extras.reconstructionVariant to belong to one. */
  variants?: { id: string; title: string }[];
  position?: [number, number, number];
  quaternion?: [number, number, number, number];
  scale?: number;
  credit?: string;
  /** Named places in the model's own coordinates. */
  landmarks?: { name: string; position: [number, number, number] }[];
  /** The sky behind it in first person, as #rrggbb colors overhead and at the horizon. */
  sky?: { zenith?: string; horizon?: string };
};

export type SphrSpace = {
  id?: string | number;
  title: string;
  type?: "spaces" | "splat" | "iiif" | "matterport" | string;
  src?: string | null;
  description?: string;
  availability?: { status: 'unavailable'; message: string };
  share_image?: string | null;
  thumbnail?: string | null;
  video?: string | null;
  space_data: SpaceData;
  version?: string | null;
  space_custom?: string | null;
  mesh?: string | null;
};

export type SceneGraphNode = TransformConfig & {
  id: string;
  type: "group" | "model" | "pointLight" | "ambientLight" | "directionalLight" | string;
  children?: SceneGraphNode[];
  file?: string;
  fileType?: string;
  visible?: boolean;
  persistent?: boolean;
  raycast?: boolean;
  /** An environmental model that also gives way when the reconstruction shows. */
  replacedByReconstruction?: boolean;
  fpvOpacity?: number;
  orbitOpacity?: number;
  debugOpacity?: number;
  transitionMesh?: boolean;
  transitionOpacity?: number;
  transitionFadeMs?: number;
  transitionTexture?: "cube-render-target" | "none" | string;
  wireframeInDebug?: boolean;
  unlit?: boolean;
  showOnStep?: number;
  color?: number | string;
  intensity?: number;
  distance?: number;
  isSketch?: boolean;
};

export type AnnotationConfig = TransformConfig & {
  volume?: number;
  id: string;
  type?: "annotation" | string;
  navPointId?: string;
  file: string;
  size?: [number, number];
  opacity?: number;
};

export type AudioConfig = {
  url: string;
  options?: {
    loop?: boolean;
    volume?: number;
    autoplay?: boolean;
  };
};

export type TourUiText = {
  titlePart1?: string;
  titlePart2?: string;
  subtitle?: string;
  loadingImage?: string;
  enterButtonText?: string;
  exploreButtonText?: string;
  loadingText?: string;
  nextButtonText?: string;
  previousButtonText?: string;
  continueExploringButtonText?: string;
};

export type SphrBootstrap = {
  space: SphrSpace;
  tour?: SphrTour | null;
  ui?: TourUiText;
  orderedSpaces?: SphrSpace[];
};

/** The next page after a tour: another tour on this site, or an https page elsewhere. */
export type TourContinue = { url: string; label: string };

export type NormalizedTour = {
  hasGuidedTour: boolean;
  kind: ExperienceKind;
  objects: PlacedObject[];
  effects: EffectInstance[];
  finale?: string;
  continueTo?: TourContinue;
  look?: StopLook;
  sky?: StopSky;
  place?: EarthPlace;
  title: string;
  spaces: TourSpace[];
  audio: Record<string, AudioConfig>;
  autoplay: boolean;
  defaultShowText: boolean;
  textStyle: "panel" | "gradient";
  sceneGraph: SceneGraphNode[];
  annotationGraph: AnnotationConfig[];
};

export type LoadingState = {
  label: string;
  progress: number;
  ready: boolean;
  error?: string;
};

export type RuntimeState = {
  loading: LoadingState;
  activeSpaceIndex: number;
  activePointIndex: number;
  viewMode: "FPV" | "ORBIT";
  guided: boolean;
  muted: boolean;
  showText: boolean;
  debug: boolean;
  navigating: boolean;
  activeNodeId?: string;
  navigationError?: string;
  /** The visitor reached the end of the tour or hunt; the closing card shows. */
  finished?: boolean;
  /** Scavenger hunt progress: IDs of found objects, and whether this step's object is found. */
  hunt?: { found: string[]; stepFound: boolean; hint: boolean };
  /** The 3D map is in view; its data providers must be credited on screen. */
  earth?: { credits: string };
  /**
   * The space has a reconstruction: whether it can still show (it has not failed to load),
   * whether it is shown in the current view, whether it is loading, and its title and credit.
   */
  reconstruction?: { available: boolean; visible: boolean; loading: boolean; title?: string; credit?: string;
    variant?: string; variants?: { id: string; title: string }[] };
};

export type ObjectTransform = { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] };

export type RuntimeCallbacks = {
  onState?: (state: RuntimeState) => void;
  onLoading?: (loading: LoadingState) => void;
  /** Editor: an object was selected in the scene (null clears). */
  onObjectSelect?: (id: string | null) => void;
  /** Editor: the gizmo moved, turned or scaled an object. */
  onObjectTransform?: (id: string, transform: ObjectTransform) => void;
};
