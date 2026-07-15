import { authenticateSyncCall, authenticateJwtOnly } from './sync-auth.js';
import { logSyncEvent } from './sync-log.js';
import {
  handleSyncManifest,
  handleSyncUploadPrepare,
  handleSyncUploadComplete,
  handleSyncDownload,
  handleSyncDelete,
  handleSyncVersions,
  handleSyncSetMode,
  handleSyncTeamMode,
  handleSyncUploadPrepareBatch,
  handleSyncUploadCompleteBatch,
  handleSyncDownloadBatch,
  handleSyncDeleteBatch,
} from './sync-handlers.js';
import { json } from './admin-handlers.js';

interface SyncRequest {
  path: string;
  httpMethod: string;
  headers: Record<string, string> | undefined;
  body: any;
}

/**
 * Handle the /sync/* dispatch block from the FC handler.
 * Contains the exact logic of the original inline switch in handler().
 */
export async function handleSyncRequest({ path, httpMethod, headers, body }: SyncRequest): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  if (path === "/sync/set-mode") {
    const auth = await authenticateJwtOnly({ headers });
    if (!auth.ok) { const a = auth as any; return json(a.status, { error: a.error }); }
    return await handleSyncSetMode((auth as any).userId, body);
  }

  if (path === "/sync/team-mode") {
    const auth = await authenticateJwtOnly({ headers });
    if (!auth.ok) { const a = auth as any; return json(a.status, { error: a.error }); }
    return await handleSyncTeamMode((auth as any).userId, body);
  }

  // All other /sync/* routes require teamId + full sync auth
  const teamId = body.teamId || body.team_id;
  if (!teamId) return json(400, { error: "teamId is required" });

  const auth = await authenticateSyncCall({ headers, teamId });
  if (!auth.ok) { const a = auth as any; return json(a.status, { error: a.error }); }

  const startedAt = Date.now();
  let result: any, errorCode: string | undefined;
  try {
    switch (path) {
      case "/sync/manifest":
        result = await handleSyncManifest(auth, body);
        break;
      case "/sync/upload/prepare":
        result = await handleSyncUploadPrepare(auth, body);
        break;
      case "/sync/upload/complete":
        result = await handleSyncUploadComplete(auth, body);
        break;
      case "/sync/download":
        result = await handleSyncDownload(auth, body);
        break;
      case "/sync/delete":
        result = await handleSyncDelete(auth, body);
        break;
      case "/sync/versions":
        result = await handleSyncVersions(auth, body);
        break;
      // Batch endpoints — fan-out over the single-item handlers (whole request
      // is always 200; per-item status lives inside results[]).
      case "/sync/upload/prepare-batch":
        result = await handleSyncUploadPrepareBatch(auth, body);
        break;
      case "/sync/upload/complete-batch":
        result = await handleSyncUploadCompleteBatch(auth, body);
        break;
      case "/sync/download-batch":
        result = await handleSyncDownloadBatch(auth, body);
        break;
      case "/sync/delete-batch":
        result = await handleSyncDeleteBatch(auth, body);
        break;
      default:
        result = json(404, { error: "Not found" });
    }
  } catch (e: any) {
    errorCode = e.code || 'unhandled';
    throw e;
  } finally {
    // Parse body to extract actorId for observability, then strip __actorId.
    let parsedBody: any = null;
    let actorId: string | undefined;
    try {
      parsedBody = result && typeof result.body === 'string' ? JSON.parse(result.body) : (result?.body ?? null);
      actorId = parsedBody?.__actorId;
      if (parsedBody && '__actorId' in parsedBody) {
        delete parsedBody.__actorId;
        if (result) result = { ...result, body: JSON.stringify(parsedBody) };
      }
    } catch { /* ignore parse errors */ }
    logSyncEvent({
      endpoint: path,
      teamId: body?.teamId,
      actorId,
      latencyMs: Date.now() - startedAt,
      result: result?.statusCode ?? (errorCode ? 'error' : 'ok'),
      changeSeq: parsedBody?.changeSeq,
      contentHash: body?.contentHash,
      sizeBytes: body?.size,
      errorCode,
    });
  }
  return result;
}
