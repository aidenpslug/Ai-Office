// POST /api/upload: called before the page uploads a big PDF, so the storage folder accepts it.
import { userFromRequest, ensureBigUploads, errorResponse, json, MAX_PDF } from './_lib.js';

export async function POST(request) {
  try {
    await userFromRequest(request);
    await ensureBigUploads();
    return json({ maxBytes: MAX_PDF });
  } catch (err) { return errorResponse(err); }
}
