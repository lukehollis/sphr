import { isAdmin } from "@/lib/server/auth";
import { canManageScene } from "@/lib/server/accounts";

/** Who may edit a space's tour: administrators and the customer who owns the space. */
export async function canEditTour(sceneId: string) {
  return canManageScene(sceneId);
}

/** Team editors may place library models whose license is limited to the team. */
export async function isTeamEditor() {
  return isAdmin();
}
