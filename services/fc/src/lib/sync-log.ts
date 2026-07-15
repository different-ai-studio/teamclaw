/**
 * Structured logging for /sync/* endpoints (spec §5.4.1).
 *
 * Every call to logSyncEvent() emits a single-line JSON record to stdout,
 * which Function Compute captures as a structured log entry.
 */

/**
 * Emit a structured sync event log line.
 *
 * @param {object} fields
 * @param {string}        fields.endpoint        - e.g. "/sync/manifest"
 * @param {string|undefined} fields.teamId       - team UUID
 * @param {string|undefined} fields.actorId      - actor UUID (if available)
 * @param {number}        fields.latencyMs        - wall-clock ms for the call
 * @param {string|number} fields.result           - HTTP status code or "ok" / "error"
 * @param {number|undefined} fields.changeSeq     - highest change_seq in response
 * @param {string|undefined} fields.contentHash   - blob content_hash if applicable
 * @param {number|undefined} fields.sizeBytes     - upload/download size in bytes
 * @param {string|undefined} fields.errorCode     - FC or internal error code on failure
 */
export function logSyncEvent(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
