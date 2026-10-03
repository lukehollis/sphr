import * as THREE from "three";
import type { EffectContext, GsplatValue, SparkDyno } from "@/lib/experience/registry";

export type SplatUniforms = Record<string, { value: unknown }>;

/**
 * A world-space splat modifier written as a GLSL body. The body reads and
 * writes `gs` (center, scales, quaternion, rgba) and may use the declared
 * uniforms by name plus uTime. Returns uniforms to animate and a removal.
 */
export function splatShader(context: EffectContext, uniforms: Record<string, "float" | "vec3">, body: string, globals = "") {
  const host = context.splats;
  if (!host) return null;
  const dyno = host.dyno as SparkDyno;
  const values: Record<string, { value: number | THREE.Vector3 }> = {};
  const inputs: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(uniforms)) {
    const uniform = type === "float" ? dyno.dynoFloat(0) : dyno.dynoVec3(new THREE.Vector3());
    values[name] = uniform as unknown as { value: number | THREE.Vector3 };
    inputs[name] = uniform;
  }
  const remove = host.addModifier((d, gsplat: GsplatValue) => {
    const node = new d.Dyno({
      inTypes: { gsplat: d.Gsplat, ...uniforms },
      outTypes: { gsplat: d.Gsplat },
      globals: () => globals ? [globals] : [],
      statements: ({ inputs: names, outputs }) => d.unindentLines(`
        ${outputs.gsplat} = ${names.gsplat};
        {
          ${Object.keys(uniforms).map((name) => `${uniforms[name]} ${name} = ${(names as Record<string, string>)[name]};`).join("\n")}
          ${body.replaceAll("gs.", `${outputs.gsplat}.`)}
        }
      `)
    });
    return node.apply({ gsplat, ...inputs } as never).gsplat;
  });
  return {
    values,
    invalidate: () => host.invalidate(),
    remove
  };
}

