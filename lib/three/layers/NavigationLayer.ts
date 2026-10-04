import * as THREE from "three";
import type { NodeData, SpaceData } from "@/lib/types";
import { sceneGroupSettings, vectorFromLike, worldFromGroupedPoint } from "@/lib/three/math";

export class NavigationLayer {
  readonly group = new THREE.Group();
  private readonly markers = new Map<string, THREE.Object3D>();
  private activeNodeId: string | null = null;
  private readonly navigableNodeIds = new Set<string>();
  private transitionVisibleIds: Set<string> | null = null;
  private occluders: THREE.Object3D[] = [];
  private orbit = false;
  private overlay = false;
  private hoveredNodeId: string | null = null;
  private readonly occlusionRay = new THREE.Raycaster();
  // Capture sightlines, made two-way. Empty when the space has no navigation graph.
  private readonly links = new Map<string, Set<string>>();
  private readonly markerWorld = new THREE.Vector3();

  setOccluders(objects: THREE.Object3D[]) {
    this.occluders = objects;
    this.scene.updateMatrixWorld(true);
    this.setActive(this.activeNodeId);
  }

  setOrbit(orbit: boolean) { this.orbit = orbit; this.setActive(this.activeNodeId); }

  /** Linked scans fly with the projected photo; unlinked tour stops cut instead of passing through walls. */
  canFlyTo(nodeId: string) {
    return !this.links.size || this.navigableNodeIds.has(nodeId);
  }

  canSee(from: NodeData, to: NodeData) {
    return !this.occluders.length || this.unobstructed(this.getWorldPosition(from), this.getWorldPosition(to));
  }

  getNavigableNodes() {
    return this.nodes.filter((node) => this.navigableNodeIds.has(node.uuid) && node.uuid !== this.activeNodeId);
  }

  getDebugSnapshot() {
    return {
      activeNodeId: this.activeNodeId,
      visible: this.group.visible,
      transitioning: this.transitionVisibleIds !== null,
      visibleNodes: this.getNavigableNodes().map((node) => node.uuid),
      renderedNodes: [...this.markers].filter(([, marker]) => marker.visible).map(([id]) => id)
    };
  }

  beginTransition() {
    this.transitionVisibleIds = new Set([...this.markers].filter(([, marker]) => marker.visible).map(([id]) => id));
  }

  endTransition() {
    this.transitionVisibleIds = null;
    this.setActive(this.activeNodeId);
  }

  private unobstructed(from: THREE.Vector3, to: THREE.Vector3) {
    const direction = to.clone().sub(from);
    const distance = direction.length();
    this.occlusionRay.set(from, direction.normalize());
    this.occlusionRay.near = 0.15;
    this.occlusionRay.far = Math.max(0.15, distance - 0.15);
    return !this.occlusionRay.intersectObjects(this.occluders, true).length;
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly data: SpaceData,
    private readonly nodes: NodeData[]
  ) {
    this.group.name = "navigation-points";
  }

  init() {
    this.linkNodes();
    const settings = sceneGroupSettings("nodes", this.data);
    this.nodes.forEach((node) => {
      const marker = this.createMarker(node);
      const localPosition = vectorFromLike(node.floorPosition ?? node.position);
      marker.position.copy(localPosition);
      marker.userData.node = node;
      marker.visible = true;
      // Draw over the projected transition photo, with depth testing against its geometry.
      marker.traverse((child) => { if ((child as THREE.Mesh).isMesh) child.renderOrder += 20; });
      this.group.add(marker);
      this.markers.set(node.uuid, marker);

      const debugSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.6 })
      );
      debugSphere.position.copy(vectorFromLike(node.position));
      debugSphere.userData.node = node;
      debugSphere.userData.debugOnly = true;
      debugSphere.visible = false;
      this.group.add(debugSphere);
    });

    this.group.position.copy(settings.offsetPosition);
    this.group.rotation.set(
      THREE.MathUtils.degToRad(settings.offsetRotation.x),
      THREE.MathUtils.degToRad(settings.offsetRotation.y),
      THREE.MathUtils.degToRad(settings.offsetRotation.z)
    );
    this.group.scale.setScalar(settings.scale);
    this.scene.add(this.group);
  }

  setActive(nodeId?: string | null) {
    this.activeNodeId = nodeId ?? null;
    const activeNode = this.nodes.find((node) => node.uuid === this.activeNodeId) ?? null;
    this.navigableNodeIds.clear();
    this.reachableIds(activeNode).forEach((id) => this.navigableNodeIds.add(id));
    this.markers.forEach((marker, id) => {
      // Keep the departure pucks, including the destination, until the camera arrives.
      // Visual continuity must not broaden the next scan's navigation/prefetch choices.
      marker.visible = this.navigableNodeIds.has(id) || (this.transitionVisibleIds?.has(id) ?? false);
    });
    this.applyMarkerStyles();
  }

  setHovered(nodeId: string | null) {
    if (nodeId === this.hoveredNodeId) return;
    this.hoveredNodeId = nodeId;
    this.applyMarkerStyles();
  }

  /** Keep distant pucks large enough to see and click; nearby ones keep their measured size. */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    if (!this.group.visible || viewportHeight <= 0) return;
    const radius = (this.data.navigation?.markerRadius ?? 0.15) * this.group.scale.x;
    const focalPixels = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.markers.forEach((marker) => {
      if (!marker.visible) return;
      if (this.orbit) { marker.scale.setScalar(1); return; }
      const distance = marker.getWorldPosition(this.markerWorld).distanceTo(camera.position);
      marker.scale.setScalar(THREE.MathUtils.clamp(distance * MIN_PUCK_RADIUS_PX / focalPixels / radius, 1, 8));
    });
  }

  setDebug(debug: boolean) {
    this.group.traverse((child) => {
      if (child.userData.debugOnly) child.visible = debug;
    });
  }

  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  /**
   * Over a reconstruction the pucks draw on top: its ground and walls are not
   * the capture's, so they must not bury the floor where each scan was taken.
   */
  setOverlay(overlay: boolean) {
    if (this.overlay === overlay) return;
    this.overlay = overlay;
    this.group.traverse((child) => {
      const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (material?.userData?.puck) material.depthTest = !overlay;
    });
  }

  getWorldPosition(node: NodeData) {
    return worldFromGroupedPoint(node.position, sceneGroupSettings("nodes", this.data));
  }

  getWorldFloorPosition(node: NodeData) {
    return worldFromGroupedPoint(node.floorPosition ?? node.position, sceneGroupSettings("nodes", this.data));
  }

  getIntersectedNode(raycaster: THREE.Raycaster) {
    const hits = raycaster.intersectObjects([...this.markers.values()].filter((marker) => marker.visible), true);
    const hit = hits.find((item) => item.object.userData.node || item.object.parent?.userData.node);
    return (hit?.object.userData.node ?? hit?.object.parent?.userData.node ?? null) as NodeData | null;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material?.dispose?.();
      }
    });
    this.group.clear();
    this.markers.clear();
    this.navigableNodeIds.clear();
    this.transitionVisibleIds = null;
  }

  private applyMarkerStyles() {
    this.markers.forEach((marker, id) => {
      const active = id === this.activeNodeId && !this.transitionVisibleIds;
      const hovered = id === this.hoveredNodeId && !active;
      marker.traverse((child) => {
        const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        const style = material?.userData.puck as { opacity: number; hover: number; tint: boolean } | undefined;
        if (!material || !style) return;
        if (style.tint) material.color.set(active ? 0xe7f18c : 0xffffff);
        material.opacity = hovered ? style.hover : style.opacity;
      });
    });
  }

  private createMarker(node: NodeData) {
    const group = new THREE.Group();
    group.name = `nav-${node.uuid}`;

    const puckMaterial = (color: number, opacity: number, hover: number) => {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
      material.userData.puck = { opacity, hover, tint: color === 0xffffff };
      return material;
    };
    const radius = this.data.navigation?.markerRadius ?? 0.15;
    if (node.floorUnobserved) {
      // Preserve direct access to a measured camera without inventing a floor.
      const cameraPoint = new THREE.Mesh(new THREE.SphereGeometry(radius * .6, 16, 12), puckMaterial(0xffffff, 0.75, 0.95));
      cameraPoint.userData.node = node;
      group.add(cameraPoint);
      return group;
    }
    // A single white ring on the floor.
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.74, radius, 48), puckMaterial(0xffffff, 0.92, 1));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.006;
    ring.userData.node = node;
    group.add(ring);

    // Raycast the entire marker, including the empty space inside its ring.
    // Invisible hit geometry slightly enlarges the target without changing the photo.
    const hitArea = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.3, 24),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    );
    hitArea.rotation.x = -Math.PI / 2;
    hitArea.userData.node = node;
    group.add(hitArea);

    return group;
  }

  private linkNodes() {
    this.links.clear();
    if (!this.nodes.some((node) => Array.isArray(node.neighbors))) return;
    this.nodes.forEach((node) => this.links.set(node.uuid, new Set()));
    for (const node of this.nodes) {
      for (const id of node.neighbors ?? []) {
        if (id === node.uuid || !this.links.has(id)) continue;
        this.links.get(node.uuid)!.add(id);
        this.links.get(id)!.add(node.uuid);
      }
    }
  }

  private reachableIds(activeNode: NodeData | null) {
    if (this.orbit || !activeNode) return new Set([...this.markers.keys()].filter((id) => id !== this.activeNodeId));
    const candidates = this.visibleNeighborIds(activeNode) ?? this.nodes.filter((node) => node.uuid !== activeNode.uuid);
    if (!this.occluders.length) return new Set(candidates.map((node) => node.uuid));
    const from = this.getWorldPosition(activeNode);
    const clear = candidates.filter((node) => this.unobstructed(from, this.getWorldPosition(node)));
    // The reduced mesh can seal a doorway. Never leave a scan without a way on.
    if (!clear.length && candidates.length) clear.push(this.byDistance(activeNode, candidates)[0].node);
    return new Set(clear.map((node) => node.uuid));
  }

  private byDistance(activeNode: NodeData, nodes: NodeData[]) {
    const activePosition = vectorFromLike(activeNode.floorPosition ?? activeNode.position);
    return nodes
      .map((node) => ({ node, distance: activePosition.distanceTo(vectorFromLike(node.floorPosition ?? node.position)) }))
      .sort((a, b) => a.distance - b.distance);
  }

  private visibleNeighborIds(activeNode: NodeData) {
    const config = this.data.navigation;
    if (config?.mode !== "neighbors") return null;

    const maxVisible = Math.max(1, Math.floor(config.maxVisible ?? 6));
    const minVisible = Math.max(1, Math.floor(config.minVisible ?? 1));
    const maxDistance = config.maxDistance ?? Number.POSITIVE_INFINITY;
    const self = (config.hideActive ?? true) ? [] : [activeNode];
    const linked = this.links.get(activeNode.uuid);
    if (linked?.size) {
      // The capture's own sightlines hold at any distance; open sites space their scans widely.
      return [...self, ...this.byDistance(activeNode, this.nodes.filter((node) => linked.has(node.uuid))).slice(0, maxVisible).map((item) => item.node)];
    }

    // Without sightlines (or for a scan the capture left unlinked), offer the nearest scans.
    const distances = this.byDistance(activeNode, this.nodes.filter((node) => node.uuid !== activeNode.uuid));
    let visible = distances.filter((item) => item.distance <= maxDistance).slice(0, maxVisible);
    if (visible.length < minVisible) visible = distances.slice(0, minVisible);
    return [...self, ...visible.map((item) => item.node)];
  }
}

// Smallest on-screen puck radius, in CSS pixels, before distant pucks grow to stay visible.
const MIN_PUCK_RADIUS_PX = 20;
