import { setScenePublic } from "@/lib/server/admin-store";
import { cleanText, deleteCustomerSpace, listUploads, readCustomerSpace, renameCustomerSpace, setUploadStatus } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, ownedSpace } from "@/lib/server/accounts";
import { billingEnabled, syncQuantity } from "@/lib/server/billing";
import { describeSpace } from "@/lib/server/customer-spaces";
import { deleteStoredUpload } from "@/lib/server/uploads";
import { removePublishedScene } from "@/lib/server/published-assets";
import { notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";

type Params = { params: Promise<{ id: string }> };

async function owned(request: Request, params: Params["params"], agents = false) {
  const { user, body, error } = await accountRequest(request, 4096, { agents });
  if (error) return { error };
  const space = readCustomerSpace((await params).id);
  if (!space || space.userId !== user.id || space.status === "deleted") return { error: accountResponse({ error: "Space not found." }, 404) };
  return { user, body, space };
}

export async function GET(request: Request, { params }: Params) {
  const owned = await ownedSpace((await params).id, request);
  return owned ? accountResponse({ space: await describeSpace(owned.space) }) : accountResponse({ error: "Space not found." }, 404);
}

/** Renames a space or changes who can open it. A linked agent may do this; deleting stays with the browser. */
export async function PATCH(request: Request, { params }: Params) {
  const { space, body, error } = await owned(request, params, true);
  if (error) return error;
  if (body?.title !== undefined) {
    const title = cleanText(body.title, 200);
    if (!title) return accountResponse({ error: "Enter a title of 1–200 characters." }, 400);
    renameCustomerSpace(space.id, title);
  }
  if (body?.public !== undefined) {
    if (typeof body.public !== "boolean") return accountResponse({ error: "Choose public or private." }, 400);
    if (!space.sceneId) return accountResponse({ error: "This space is not ready yet." }, 409);
    setScenePublic(space.sceneId, body.public);
  }
  return accountResponse({ ok: true, space: await describeSpace(readCustomerSpace(space.id)!) });
}

export async function DELETE(request: Request, { params }: Params) {
  const { user, space, error } = await owned(request, params);
  if (error) return error;
  deleteCustomerSpace(space.id);
  await recordEvent("space_deleted", { userId: user.id, props: { was: space.status } });
  void notifyTeam({ title: "Space deleted", tone: "warn", fields: [["Title", space.title], ["Account", user.email], ["Was", space.status]] });
  if (space.sceneId) setScenePublic(space.sceneId, false);
  if (billingEnabled()) {
    // A failure here is repaired the next time the account page loads.
    await syncQuantity(user.id).catch(failure => console.error("Unable to update the subscription quantity:", failure instanceof Error ? failure.message : failure));
  }
  if (space.sceneId) {
    await removePublishedScene(space.sceneId).catch(failure => console.error("Unable to remove published files:", failure instanceof Error ? failure.message : failure));
  }
  for (const upload of listUploads(space.id)) {
    await deleteStoredUpload(upload).then(() => setUploadStatus(upload.id, "deleted"))
      .catch(failure => console.error("Unable to remove an upload:", failure instanceof Error ? failure.message : failure));
  }
  return accountResponse({ ok: true });
}
