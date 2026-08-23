/*
  /api/loyalty-ledger.js — Serverless read/write bridge to Google Drive for the
  Loyalty V2 persistent ledger dataset (DB.data.loyaltyLedger).

  WHY THIS EXISTS
  ----------------
  Added 2026-08-23 alongside the three-dimension Loyalty V2 architecture (Genuine Visits /
  Continuous Stay / Lifetime Paid Days). Every ledger action (Mark Given, Select Choice,
  Owner Override, Skip/Decline, Add Note, Manual Grant) writes to DB.data.loyaltyLedger and
  needs the exact same Drive-backed sync the legacy `rewards` array already has via
  api/loyalty-rewards.js — one shared loyalty_ledger.json file in the same Drive folder, so
  an action taken on any device becomes visible everywhere.

  COMPLETELY SEPARATE FROM api/loyalty-rewards.js — this endpoint never reads or writes
  loyalty_rewards.json, and that endpoint never reads or writes loyalty_ledger.json. The
  legacy reward history (Ride Upgrade / Premium Ride Experience / VIP Extra Day given
  records) is preserved exactly as-is and is never migrated into, or touched by, this file.

  Reuses the shared auth/file helpers in lib/driveAuth.js, same as api/loyalty-rewards.js.

  AUTH
  ----
  Same 3 env vars as every other endpoint here: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY, DRIVE_FOLDER_ID. No new env vars required.

  BEHAVIOR
  --------
  GET /api/loyalty-ledger
    Returns { loyaltyLedger: [...] }. Returns an empty array (not an error) if the file
    doesn't exist yet — this is expected the very first time this endpoint runs in a given
    environment, before loyalty_ledger.json has ever been created.

  POST /api/loyalty-ledger
    Body: { loyaltyLedger: [...] } (required)
    Overwrites loyalty_ledger.json in Drive with exactly this array, creating it on first
    write. Returns { ok: true, loyaltyLedger }.

  NO HARDCODED FILE ID (YET)
  ---------------------------
  Unlike api/loyalty-rewards.js, this endpoint does NOT hardcode a Drive file id — the
  loyalty_ledger.json file does not exist yet as of this commit (this architecture has only
  been dry-run tested against local backups; no production Drive writes have happened for
  the ledger). It locates the file by name via listChildren() (see the file-id-flakiness
  caveat documented in api/loyalty-rewards.js — the same caveat applies here) and creates it
  on first POST. ONCE the file is created for real and its id is known, capture that id here
  the same way KNOWN_REWARDS_FILE_ID was captured in api/loyalty-rewards.js, for the same
  reliability reasons documented there.
*/
'use strict';

const { getAccessToken, downloadFile, createFile, updateFile, listChildren } = require('../lib/driveAuth');

const LEDGER_FILENAME = 'loyalty_ledger.json';

async function findLedgerFile(token, folderId) {
  const children = await listChildren(token, folderId);
  return children.find((f) => f.name === LEDGER_FILENAME) || null;
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
      const existing = await findLedgerFile(token, folderId);
      if (!existing) {
        res.status(200).json({ loyaltyLedger: [] });
        return;
      }
      const loyaltyLedger = await downloadFile(token, existing.id);
      res.status(200).json({ loyaltyLedger: Array.isArray(loyaltyLedger) ? loyaltyLedger : [] });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!Array.isArray(body.loyaltyLedger)) {
        res.status(400).json({ error: 'Body must include a "loyaltyLedger" array' });
        return;
      }
      const existing = await findLedgerFile(token, folderId);
      if (existing) {
        await updateFile(token, existing.id, body.loyaltyLedger);
      } else {
        await createFile(token, folderId, LEDGER_FILENAME, body.loyaltyLedger);
      }
      res.status(200).json({ ok: true, loyaltyLedger: body.loyaltyLedger });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/loyalty-ledger] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
