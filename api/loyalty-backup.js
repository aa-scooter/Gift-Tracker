/*
  /api/loyalty-backup.js — Serverless bridge to Google Drive for versioned Loyalty V2
  backups (full point-in-time snapshots of customers/rentals/rewards/loyaltyLedger/
  loyaltyAuditLog/meta).

  WHY THIS EXISTS
  ----------------
  Added 2026-08-23 as part of the Persistent Backup + Audit History safety layer. Per spec:
  a backup must be taken before production migration, bulk loyalty changes, a full loyalty
  rebuild, a ledger migration, or any operation capable of changing multiple customer/reward
  records — and backups must be timestamped and must NEVER overwrite a previous backup.

  THIS IS DELIBERATELY DIFFERENT FROM api/loyalty-ledger.js AND api/loyalty-audit.js
  -------------------------------------------------------------------------------------
  Those two endpoints find-or-create a single named file and overwrite it. This endpoint does
  the opposite on purpose: POST ALWAYS creates a brand-new file with a unique, timestamped
  name — there is no "find existing and update" branch at all, because overwriting would
  violate the "must not overwrite the previous backup" requirement. If a name collision
  somehow occurs (e.g. two backups requested in the same minute), a short numeric suffix is
  appended so the new file still never overwrites the earlier one.

  CHEAP LISTING, EXPENSIVE DETAIL
  ----------------------------------
  The backup count could grow large over time, and downloading every backup file's full
  snapshot just to list them would be slow and wasteful. So the creation timestamp is encoded
  directly in the filename (loyalty_backup_YYYY-MM-DD_HHMM[.N].json) and GET (list) parses it
  from the filename alone — no file content is downloaded for a list request. The backup
  `reason` (e.g. "Manual", "Pre-restore safety backup...") lives only inside the file content
  and is only returned by the single-backup GET (?id=...), matching what app.js's
  fetchLoyaltyBackup() expects.

  COMPLETELY SEPARATE from api/loyalty-ledger.js and api/loyalty-audit.js — this endpoint
  never reads or writes loyalty_ledger.json or loyalty_audit_log.json; those never read or
  write loyalty_backup_*.json files.

  AUTH
  ----
  Same 3 env vars as every other endpoint here: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY, DRIVE_FOLDER_ID. No new env vars required.

  BEHAVIOR
  --------
  GET /api/loyalty-backup
    Lists existing backups, newest first: { backups: [{ id, filename, createdAt }, ...] }.
    createdAt is parsed from the filename; no file content is downloaded.

  GET /api/loyalty-backup?id=<fileId>
    Downloads and returns one backup's full content: { createdAt, reason, performedBy,
    snapshot }. 404 if the id doesn't exist or isn't a backup file.

  POST /api/loyalty-backup
    Body: { reason, performedBy, snapshot } (snapshot required)
    ALWAYS creates a new file — never updates/overwrites an existing one. Returns
    { ok: true, filename, fileId, createdAt }.
*/
'use strict';

const { getAccessToken, listChildren, downloadFile, createFile } = require('../lib/driveAuth');

const BACKUP_PREFIX = 'loyalty_backup_';

function pad2(n) { return String(n).padStart(2, '0'); }

// Formats a Date as loyalty_backup_YYYY-MM-DD_HHMM.json, e.g. loyalty_backup_2026-08-23_1430.json
function backupFilenameFor(date) {
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  return `${BACKUP_PREFIX}${y}-${mo}-${d}_${h}${mi}.json`;
}

// Parses the createdAt timestamp back out of a loyalty_backup_YYYY-MM-DD_HHMM[.N].json name.
// Returns null (not a throw) for anything that doesn't match, so a stray/renamed file in the
// same folder just gets skipped by the list endpoint rather than crashing it.
function parseBackupFilename(name) {
  const m = /^loyalty_backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(?:\.\d+)?\.json$/.exec(name);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
  return iso;
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
        .map((f) => ({ id: f.id, filename: f.name, createdAt: parseBackupFilename(f.name) }))
        .filter((b) => b.createdAt) // skip anything that doesn't match the expected pattern
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
      res.status(200).json({ backups });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!body.snapshot || typeof body.snapshot !== 'object') {
        res.status(400).json({ error: 'Body must include a "snapshot" object' });
        return;
      }
      const now = new Date();
      const createdAt = now.toISOString();
      let filename = backupFilenameFor(now);

      // Guard against a same-minute name collision — append .1, .2, ... rather than ever
      // overwriting an existing backup file.
      const existingChildren = await listChildren(token, folderId);
      const existingNames = new Set(existingChildren.map((f) => f.name));
      if (existingNames.has(filename)) {
        let n = 1;
        let candidate;
        do {
          candidate = filename.replace(/\.json$/, `.${n}.json`);
          n += 1;
        } while (existingNames.has(candidate));
        filename = candidate;
      }

      const fileContent = {
        createdAt,
        reason: body.reason || 'Manual',
        performedBy: body.performedBy || 'owner',
        snapshot: body.snapshot,
      };
      const fileId = await createFile(token, folderId, filename, fileContent);
      res.status(200).json({ ok: true, filename, fileId, createdAt });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/loyalty-backup] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
