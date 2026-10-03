import spacery from "@/lib/experience/spacery/pack";
import type { Pack } from "@/lib/experience/registry";

/**
 * Packs beyond core. app.spacery.dev adds its own effects and collectibles;
 * the open source repository keeps this list empty.
 */
const extraPacks: Pack[] = [spacery];

export default extraPacks;
