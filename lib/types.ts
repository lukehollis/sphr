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
  mpid?: string;
  slug?: string;
  title?: string;
  type?: string;
  tourpoints: TourPoint[];
};

export type TourData = {
  audio?: Record<string, AudioConfig>;
  autoplay?: boolean;
  defaultShowText?: boolean;
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
  floorPosition?: Vector3Like;
  rotation?: EulerLike;
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
  clickNavigation?: ClickNavigationConfig;
  navigation?: NavigationConfig;
  navigationTransition?: NavigationTransitionConfig;
  sceneGraph?: SceneGraphNode[];
  annotationGraph?: AnnotationConfig[];
};

export type SphrSpace = {
  id?: string | number;
  title: string;
  type?: "spaces" | "splat" | "iiif" | "matterport" | string;
  src?: string | null;
  description?: string;
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
  fpvOpacity?: number;
  orbitOpacity?: number;
  debugOpacity?: number;
  transitionMesh?: boolean;
  transitionOpacity?: number;
  transitionFadeMs?: number;
  transitionTexture?: "cube-render-target" | "none" | string;
  wireframeInDebug?: boolean;
  showOnStep?: number;
  color?: number | string;
  intensity?: number;
  distance?: number;
  isSketch?: boolean;
};

export type AnnotationConfig = TransformConfig & {
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

export type NormalizedTour = {
  title: string;
  spaces: TourSpace[];
  audio: Record<string, AudioConfig>;
  autoplay: boolean;
  defaultShowText: boolean;
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
};

export type RuntimeCallbacks = {
  onState?: (state: RuntimeState) => void;
  onLoading?: (loading: LoadingState) => void;
};
