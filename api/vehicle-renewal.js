/*
  /api/vehicle-renewal.js — Serverless read/write bridge to Google Drive for the shared,
  cross-device Vehicle Renewal "current state" dataset (vehicle_renewal_current.json).

  WHY THIS EXISTS
  ----------------
  Vehicle Renewal (Tax / Por Ror Bor expiry, renewal history, service km, status, notes) has
  always lived ONLY in each browser's own localStorage (see DB.save() in app.js) — an edit made
  on one phone/laptop was invisible everywhere else. This gives Vehicle Renewal the same
  Drive-backed shared-state sync the Loyalty V2 ledger already has (api/loyalty-ledger.js),
  reusing the same lib/driveAuth.js helpers and the same DRIVE_FOLDER_ID/OAuth env vars — no new
  credentials, no secrets in client-side JS.

  COMPLETELY SEPARATE from every loyalty_*.json file — this endpoint never reads or writes
  loyalty_ledger.json, loyalty_rewards.json, loyalty_audit_log.json, or loyalty_backup_*.json,
  and none of those endpoints ever touch vehicle_renewal_*.json. Customer Loyalty calculations,
  Manager Sync, Full Refresh, Genuine Visits/Continuous Stay/Lifetime Paid Days, and existing
  loyalty reward history are all untouched by this file.

  DATA MODEL
  ----------
  vehicle_renewal_current.json:
    { schemaVersion: 1, updatedAt: <ISO>, updatedBy: <string>, vehicles: [ {...vehicle} ] }
  Each vehicle keeps exactly the fields app.js's DB.data.vehicles already uses (id, bikeName,
  plate, modelYear, taxExpiryDate, taxOverduePending, renewalNote, taxHistory,
  porRorBorExpiryDate, porRorBorHistory, currentKm, nextServiceKm, status, notes) plus two new
  per-record fields, updatedAt/updatedBy, stamped by the client on every edit.

  CONFLICT SAFETY (optimistic concurrency, whole-document)
  ----------------------------------------------------------
  A POST must include `baseUpdatedAt` — the `updatedAt` the client last fetched/saved. If the
  file currently in Drive has a DIFFERENT `updatedAt` than that (someone else saved in between),
  the write is rejected with 409 and the current server copy is returned instead of being
  silently overwritten — the client is expected to refresh and retry. The one exception is the
  very first write when no cloud file exists yet (a null/absent baseUpdatedAt is fine there —
  see the MIGRATION note below); once a file exists, every subsequent POST must match its
  updatedAt.

  AUTOMATIC, APPEND-ONLY BACKUPS
  --------------------------------
  Every POST that overwrites an EXISTING current file first copies that file's exact prior
  content into a brand-new, timestamped, never-overwritten backup file
  (vehicle_renewal_backup_YYYY-MM-DD_HHMM[.N].json — see api/vehicle-renewal-backup.js, which
  lists/reads these). This is unconditional and cannot be skipped by the client, so restoring an
  earlier state is always possible after any edit, including a restore (a restore is just a
  POST like any other, so it gets the same automatic pre-overwrite backup — i.e. a pre-restore
  safety backup — for free).

  MIGRATION
  ---------
  GET returns { exists: false, ... , vehicles: [] } when vehicle_renewal_current.json has never
  been created. The client uses that to offer an explicit, owner-confirmed "seed the cloud from
  this device's current vehicles" action — never automatic. Once the file exists, GET always
  returns { exists: true, ... } and the client treats cloud as the source of truth.

  AUTH
  ----
  Same env vars as every other endpoint here: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY (or the OAuth GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/
  GOOGLE_REFRESH_TOKEN trio, preferred when present — see lib/driveAuth.js), DRIVE_FOLDER_ID.
  No new env vars required, and no secret ever reaches the browser — this file only runs
  server-side (Vercel serverless function).

  BEHAVIOR
  --------
  GET /api/vehicle-renewal
    { exists, schemaVersion, updatedAt, updatedBy, vehicles }

  POST /api/vehicle-renewal
    Body: { vehicles: [...] (required), baseUpdatedAt: <ISO|null>, updatedBy: <string> }
    200 → { ok: true, schemaVersion, updatedAt, updatedBy, vehicles, backupCreated, backupFilename }
    409 → { error: 'conflict', current: { schemaVersion, updatedAt, updatedBy, vehicles } }
*/
'use strict';

const { getAccessToken, listChildren, downloadFile, createFile, updateFile } = require('../lib/driveAuth');

const CURRENT_FILENAME = 'vehicle_renewal_current.json';
const BACKUP_PREFIX = 'vehicle_renewal_backup_';
const SCHEMA_VERSION = 1;

function pad2(n) { return String(n).padStart(2, '0'); }

// vehicle_renewal_backup_YYYY-MM-DD_HHMM.json, e.g. vehicle_renewal_backup_2026-08-25_1540.json
function backupFilenameFor(date) {
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  return `${BACKUP_PREFIX}${y}-${mo}-${d}_${h}${mi}.json`;
}

async function findCurrentFile(token, folderId) {
  const children = await listChildren(token, folderId);
  return children.find((f) => f.name === CURRENT_FILENAME) || null;
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
      const existing = await findCurrentFile(token, folderId);
      if (!existing) {
        res.status(200).json({ exists: false, schemaVersion: SCHEMA_VERSION, updatedAt: null, updatedBy: null, vehicles: [] });
        return;
      }
      const content = await downloadFile(token, existing.id);
      res.status(200).json({
        exists: true,
        schemaVersion: (content && content.schemaVersion) || SCHEMA_VERSION,
        updatedAt: (content && content.updatedAt) || null,
        updatedBy: (content && content.updatedBy) || null,
        vehicles: (content && Array.isArray(content.vehicles)) ? content.vehicles : [],
      });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!Array.isArray(body.vehicles)) {
        res.status(400).json({ error: 'Body must include a "vehicles" array' });
        return;
      }
      const updatedBy = body.updatedBy || 'owner';
      const baseUpdatedAt = body.baseUpdatedAt || null;

      const existing = await findCurrentFile(token, folderId);
      const now = new Date();
      const newContent = { schemaVersion: SCHEMA_VERSION, updatedAt: now.toISOString(), updatedBy, vehicles: body.vehicles };

      if (!existing) {
        // First write ever — this is the explicit migration-seed path. A truthy baseUpdatedAt
        // here means the client thought a cloud copy already existed (stale local state), so
        // refuse rather than guess.
        if (baseUpdatedAt) {
          res.status(409).json({ error: 'conflict', current: { schemaVersion: SCHEMA_VERSION, updatedAt: null, updatedBy: null, vehicles: [] } });
          return;
        }
        await createFile(token, folderId, CURRENT_FILENAME, newContent);
        res.status(200).json({ ok: true, schemaVersion: SCHEMA_VERSION, updatedAt: newContent.updatedAt, updatedBy, vehicles: newContent.vehicles, backupCreated: false, backupFilename: null });
        return;
      }

      const currentContent = await downloadFile(token, existing.id);
      const currentUpdatedAt = (currentContent && currentContent.updatedAt) || null;
      if (baseUpdatedAt !== currentUpdatedAt) {
        res.status(409).json({
          error: 'conflict',
          current: {
            schemaVersion: (currentContent && currentContent.schemaVersion) || SCHEMA_VERSION,
            updatedAt: currentUpdatedAt,
            updatedBy: (currentContent && currentContent.updatedBy) || null,
            vehicles: (currentContent && Array.isArray(currentContent.vehicles)) ? currentContent.vehicles : [],
          },
        });
        return;
      }

      // Automatic, append-only backup of the exact prior content — never skipped, never
      // overwrites an earlier backup (same minute-collision suffixing as api/loyalty-backup.js).
      let backupFilename = backupFilenameFor(now);
      const existingChildren = await listChildren(token, folderId);
      const existingNames = new Set(existingChildren.map((f) => f.name));
      if (existingNames.has(backupFilename)) {
        let n = 1, candidate;
        do {
          candidate = backupFilename.replace(/\.json$/, `.${n}.json`);
          n += 1;
        } while (existingNames.has(candidate));
        backupFilename = candidate;
      }
      await createFile(token, folderId, backupFilename, {
        createdAt: now.toISOString(),
        reason: body.reason || 'Vehicle Renewal save',
        performedBy: updatedBy,
        snapshot: currentContent,
      });

      await updateFile(token, existing.id, newContent);
      res.status(200).json({ ok: true, schemaVersion: SCHEMA_VERSION, updatedAt: newContent.updatedAt, updatedBy, vehicles: newContent.vehicles, backupCreated: true, backupFilename });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/vehicle-renewal] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
