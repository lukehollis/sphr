import * as THREE from "three";

/** A full-screen quad in clip space, drawn last over everything. */
export function screenQuad(fragmentShader: string, uniforms: Record<string, { value: unknown }>, blending: THREE.Blending = THREE.NormalBlending) {
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 90;
  return mesh;
}
