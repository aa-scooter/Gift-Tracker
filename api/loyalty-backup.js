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

  UPDATED 2026-08-23 (second pass): every backup now also records WHICH operation triggered it
  (Manager Sync, Full Refresh, Cloud Sync, a manual click, a pre-restore safety backup, etc.),
  a record-count snapshot, and an optional free-text "source version" description — see
  app.js's createLoyaltyBackup() for how these are produced. The triggering operation is
  encoded in the filename itself (see backupFilenameFor/parseBackupFilename below) so the
  Backup History list can show "why" a backup exists without downloading anything.

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
  snapshot just to list them would be slow and wasteful. So the creation timestamp AND the
  triggering operation are both encoded directly in the filename
  (loyalty_backup_YYYY-MM-DD_HHMM_<operation>[.N].json) and GET (list) parses both from the
  filename alone — no file content is downloaded for a list request. The backup's free-text
  `reason`, `sourceVersion`, and `recordCounts` live only inside the file content and are only
  returned by the single-backup GET (?id=...), matching what app.js's fetchLoyaltyBackup()
  expects. A filename with no operation slug (backups created before this update) still parses
  fine — the operation just comes back as "manual" — so nothing already-created breaks.

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
    Lists existing backups, newest first: { backups: [{ id, filename, createdAt, operation }, ...] }.
    createdAt and operation are both parsed from the filename; no file content is downloaded.

  GET /api/loyalty-backup?id=<fileId>
    Downloads and returns one backup's full content: { createdAt, reason, performedBy,
    operation, sourceVersion, recordCounts, snapshot }. 404 if the id doesn't exist or isn't a
    backup file.

  POST /api/loyalty-backup
    Body: { reason, performedBy, operation, sourceVersion, recordCounts, snapshot } (snapshot
    required; everything else optional and defaulted). ALWAYS creates a new file — never
    updates/overwrites an existing one. Returns { ok: true, filename, fileId, createdAt }.
*/
'use strict';

const { getAccessToken, listChildren, downloadFile, createFile } = require('../lib/driveAuth');

const BACKUP_PREFIX = 'loyalty_backup_';

function pad2(n) { return String(n).padStart(2, '0'); }

// Sanitizes an operation string down to a filename-safe slug (lowercase letters/digits/
// underscores only) so it can be embedded directly in the filename. Falls back to "manual" for
// anything empty or unrecognizable, rather than ever producing an unparseable filename.
function sanitizeOperationSlug(op) {
  const slug = String(op || 'manual').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'manual';
}

// Formats a Date + operation as loyalty_backup_YYYY-MM-DD_HHMM_<operation>.json, e.g.
// loyalty_backup_2026-08-23_1430_manager_sync.json
function backupFilenameFor(date, operation) {
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  return `${BACKUP_PREFIX}${y}-${mo}-${d}_${h}${mi}_${sanitizeOperationSlug(operation)}.json`;
}

// Parses the createdAt timestamp AND the triggering operation back out of a
// loyalty_backup_YYYY-MM-DD_HHMM[_operation][.N].json name. The operation group is optional so
// backups created before this update (no operation suffix) still parse — they just come back
// with operation: "manual". Returns null (not a throw) for anything that doesn't match at all,
// so a stray/renamed file in the same folder just gets skipped by the list endpoint rather than
// crashing it.
function parseBackupFilename(name) {
  const m = /^loyalty_backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(?:_([a-z0-9_]+))?(?:\.\d+)?\.json$/.exec(name);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
  return { createdAt: iso, operation: m[6] || 'manual' };
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
          operation: content.operation || 'manual',
          sourceVersion: content.sourceVersion || null,
          recordCounts: content.recordCounts || null,
          snapshot: content.snapshot || null,
        });
        return;
      }

      const children = await listChildren(token, folderId);
      const backups = children
        .filter((f) => f.name.indexOf(BACKUP_PREFIX) === 0 && f.name.endsWith('.json'))
        .map((f) => {
          const parsed = parseBackupFilename(f.name);
          return parsed ? { id: f.id, filename: f.name, createdAt: parsed.createdAt, operation: parsed.operation } : null;
        })
        .filter(Boolean) // skip anything that doesn't match the expected pattern at all
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
      const operation = sanitizeOperationSlug(body.operation);
      let filename = backupFilenameFor(now, operation);

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
        operation,
        sourceVersion: body.sourceVersion || null,
        recordCounts: body.recordCounts || null,
        snapshot: body.snapshot,
      };
      const fileId = await createFile(token, folderId, filename, fileContent);
      res.status(200).json({ ok: true, filename, fileId, createdAt, operation, recordCounts: body.recordCounts || null });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/loyalty-backup] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
