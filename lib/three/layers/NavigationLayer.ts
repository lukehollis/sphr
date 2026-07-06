import * as THREE from "three";
import type { NodeData, SpaceData } from "@/lib/types";
import { sceneGroupSettings, vectorFromLike, worldFromGroupedPoint } from "@/lib/three/math";

export class NavigationLayer {
  readonly group = new THREE.Group();
  private readonly markers = new Map<string, THREE.Object3D>();
  private activeNodeId: string | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly data: SpaceData,
    private readonly nodes: NodeData[]
  ) {
    this.group.name = "navigation-points";
  }

  init() {
    const settings = sceneGroupSettings("nodes", this.data);
    this.nodes.forEach((node) => {
      const marker = this.createMarker(node);
      const localPosition = vectorFromLike(node.floorPosition ?? node.position);
      marker.position.copy(localPosition);
      marker.userData.node = node;
      marker.visible = true;
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
    const visibleNeighborIds = this.visibleNeighborIds(activeNode);
    this.markers.forEach((marker, id) => {
      marker.visible = visibleNeighborIds ? visibleNeighborIds.has(id) : true;
      marker.traverse((child) => {
        const mesh = child as THREE.Mesh;
        const material = mesh.material as THREE.MeshBasicMaterial | undefined;
        if (!material || !("color" in material)) return;
        if (id === this.activeNodeId) {
          material.color.set(0xe7f18c);
          material.opacity = 0.95;
        } else {
          material.color.set(0xffffff);
          material.opacity = 0.55;
        }
      });
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

  getWorldPosition(node: NodeData) {
    return worldFromGroupedPoint(node.position, sceneGroupSettings("nodes", this.data));
  }

  getIntersectedNode(raycaster: THREE.Raycaster) {
    const hits = raycaster.intersectObjects([...this.markers.values()], true);
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
  }

  private createMarker(node: NodeData) {
    const group = new THREE.Group();
    group.name = `nav-${node.uuid}`;

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.42, 48), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.userData.node = node;
    group.add(ring);

    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.08, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.006;
    dot.userData.node = node;
    group.add(dot);

    return group;
  }

  private visibleNeighborIds(activeNode: NodeData | null) {
    const config = this.data.navigation;
    if (config?.mode !== "neighbors" || !activeNode) return null;

    const maxVisible = Math.max(1, Math.floor(config.maxVisible ?? 6));
    const minVisible = Math.max(0, Math.floor(config.minVisible ?? 1));
    const maxDistance = config.maxDistance ?? Number.POSITIVE_INFINITY;
    const activePosition = vectorFromLike(activeNode.floorPosition ?? activeNode.position);
    const distances = this.nodes
      .filter((node) => !(config.hideActive ?? true) || node.uuid !== activeNode.uuid)
      .map((node) => ({
        node,
        distance: activePosition.distanceTo(vectorFromLike(node.floorPosition ?? node.position))
      }))
      .sort((a, b) => a.distance - b.distance);

    let visible = distances.filter((item) => item.distance <= maxDistance).slice(0, maxVisible);
    if (visible.length < minVisible) visible = distances.slice(0, Math.max(minVisible, visible.length));
    return new Set(visible.map((item) => item.node.uuid));
  }
}
