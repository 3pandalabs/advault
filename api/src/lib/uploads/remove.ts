// Removing an upload creative (the owner's own video or AdVault's other-shape
// copy): the row goes (its render and YouTube upload jobs cascade with it),
// then its MP4 and thumbnail in R2. Shared by "Remove video"
// (DELETE /creatives/:id) and by an owner's upload replacing AdVault's copy in
// that shape (routes/uploads.ts). A YouTube copy, if one was published, stays
// on the channel: it is unlisted and serves nothing.

import { deleteObject } from "../../plugins/r2.js";

export type RemovedObjects = { id: string; videoKey: string | null; thumbnailKey: string | null };

/** R2 cleanup after the rows are gone (and committed). Never throws. */
export async function deleteUploadObjects(rows: RemovedObjects[]): Promise<void> {
  for (const row of rows) {
    for (const key of [row.videoKey, row.thumbnailKey]) {
      if (!key) continue;
      await deleteObject(key).catch((err) =>
        console.error(JSON.stringify({ msg: "upload object not deleted", creativeId: row.id, key, error: String(err) })),
      );
    }
  }
}
