/**
 * Sync traffic (push/pull) is gated by one shared secret per hotel
 * (SYNC_KEY), not per-staff credentials — staff PIN login is handled
 * entirely on-device so the app keeps working offline. The sync key
 * just proves "this device belongs to our hotel" before it's allowed
 * to read or write the shared database.
 */
function checkSyncKey(event) {
  const expected = process.env.SYNC_KEY;
  if (!expected) return { ok: false, reason: 'Server is missing the SYNC_KEY environment variable.' };
  const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const provided = match ? match[1] : '';
  if (!provided || provided !== expected) return { ok: false, reason: 'Invalid or missing sync key.' };
  return { ok: true };
}

module.exports = { checkSyncKey };
