import type { Pack } from "./registry";

/**
 * Packs beyond core. A deployment lists its own here, for example
 * `import studio from "./studio"; export default [studio];`.
 * Each pack is a list of effect and shape metadata with lazy loaders.
 */
const extraPacks: Pack[] = [];

export default extraPacks;
