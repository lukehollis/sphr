import * as THREE from "three";
import type { EffectContext } from "@/lib/experience/registry";

/**
 * An additive layer drawn over the capture mesh of a panorama space, sharing
 * its geometry, so surface effects appear on the photograph itself.
 */
/** GLSL declarations for an effect's uniforms, from their values, so no effect has to repeat them. */
function declare(uniforms: Record<string, { value: unknown }>) {
  return Object.entries(uniforms).map(([name, { value }]) => {
    const type = typeof value === "number" || typeof value === "boolean" ? "float" : value instanceof THREE.Color || value instanceof THREE.Vector3 ? "vec3"
      : value instanceof THREE.Vector2 ? "vec2" : value instanceof THREE.Vector4 ? "vec4" : value instanceof THREE.Texture ? "sampler2D" : null;
    return type ? `uniform ${type} ${name};` : "";
  }).join("\n");
}

export function surfaceOverlay(context: EffectContext, fragmentBody: string, uniforms: Record<string, { value: unknown }>, globals = "") {
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormalWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormalWorld;
      ${globals.includes("uniform ") ? "" : declare(uniforms)}
      ${globals}
      void main() {
        vec3 color = vec3(0.0);
        float alpha = 0.0;
        ${fragmentBody}
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(color * alpha, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide
  });
  const group = new THREE.Group();
  for (const source of context.surfaces()) {
    const overlay = new THREE.Mesh(source.geometry, material);
    overlay.matrixAutoUpdate = false;
    overlay.renderOrder = 40;
    overlay.frustumCulled = false;
    overlay.userData.source = source;
    group.add(overlay);
  }
  context.scene.add(group);
  return {
    material,
    empty: group.children.length === 0,
    update(visible: boolean) {
      group.visible = visible && group.children.length > 0;
      if (!group.visible) return;
      for (const overlay of group.children) {
        const source = overlay.userData.source as THREE.Mesh;
        overlay.matrix.copy(source.matrixWorld);
        overlay.matrixWorld.copy(source.matrixWorld);
      }
    },
    dispose() { context.scene.remove(group); material.dispose(); }
  };
}
