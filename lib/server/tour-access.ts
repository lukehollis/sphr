import { isAdmin } from "@/lib/server/auth";

/** Who may edit a space's tour. Deployments with accounts also allow the space's owner. */
export async function canEditTour(_sceneId: string) {
  return isAdmin();
}

/** Team editors may place library models whose license is limited to the team. */
export async function isTeamEditor() {
  return isAdmin();
}
