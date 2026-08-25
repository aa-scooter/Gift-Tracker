/*
  /api/vehicle-renewal-backup.js — Read-only listing/inspection of the timestamped Vehicle
  Renewal backups that api/vehicle-renewal.js creates automatically before every overwrite of
  vehicle_renewal_current.json.

  WHY THIS IS A SEPARATE, READ-ONLY ENDPOINT
  ---------------------------------------------
  Backups are never created by a direct call to this endpoint — they're a mandatory side effect
  of api/vehicle-renewal.js's POST (see that file's header). That keeps "every overwrite is
  backed up" true no matter which code path triggers the overwrite (a normal edit, a migration
  seed, or a restore), instead of relying on every call site to separately remember to back up
  first. This endpoint only lists and reads what already exists.

  Completely separate from api/loyalty-backup.js — this only ever touches
  vehicle_renewal_backup_*.json files, never loyalty_backup_*.json, and vice versa. The two
  backup families are never mixed in one listing.

  Cheap listing, same pattern as api/loyalty-backup.js: the timestamp is encoded directly in the
  filename (vehicle_renewal_backup_YYYY-MM-DD_HHMM[.N].json), so GET (list) parses it from the
  filename alone — no file content is downloaded for a list request.

  AUTH
  ----
  Same env vars as api/vehicle-renewal.js: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY (or the OAuth trio), DRIVE_FOLDER_ID.

  BEHAVIOR
  --------
  GET /api/vehicle-renewal-backup
    Lists existing backups, newest first: { backups: [{ id, filename, createdAt }, ...] }.

  GET /api/vehicle-renewal-backup?id=<fileId>
    Downloads and returns one backup's full content: { createdAt, reason, performedBy,
    snapshot: { schemaVersion, updatedAt, updatedBy, vehicles } }. 404 if the id doesn't exist
    or isn't a backup file.
*/
'use strict';

const { getAccessToken, listChildren, downloadFile } = require('../lib/driveAuth');

const BACKUP_PREFIX = 'vehicle_renewal_backup_';

function parseBackupFilename(name) {
  const m = /^vehicle_renewal_backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(?:\.\d+)?\.json$/.exec(name);
  if (!m) return null;
  return { createdAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z` };
}

module.exports = async function handler(req, res) {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    res.status(500).json({ error: 'Missing DRIVE_FOLDER_ID env var' });
    return;
  }

  try {
    const token = await getAccessToken();

    if (req.method === 'GET') {
      const idParam = req.query && req.query.id;
      if (idParam) {
        const content = await downloadFile(token, idParam);
        if (!content || typeof content !== 'object') {
          res.status(404).json({ error: 'Backup not found or unreadable' });
          return;
        }
        res.status(200).json({
          createdAt: content.createdAt || null,
          reason: content.reason || '',
          performedBy: content.performedBy || 'owner',
          snapshot: content.snapshot || null,
        });
        return;
      }

      const children = await listChildren(token, folderId);
      const backups = children
        .filter((f) => f.name.indexOf(BACKUP_PREFIX) === 0 && f.name.endsWith('.json'))
        .map((f) => {
          const parsed = parseBackupFilename(f.name);
          return parsed ? { id: f.id, filename: f.name, createdAt: parsed.createdAt } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      res.status(200).json({ backups });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/vehicle-renewal-backup] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
