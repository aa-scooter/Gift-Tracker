/*
  /api/loyalty-audit.js — Serverless read/write bridge to Google Drive for the
  Loyalty V2 append-only audit log (DB.data.loyaltyAuditLog).

  WHY THIS EXISTS
  ----------------
  Added 2026-08-23 as part of the Persistent Backup + Audit History safety layer. Every
  owner/staff action that changes loyalty state (Manual Grant, Grant Early, Change Reward,
  Change Quantity, Select Alternative, Mark Given/Redeemed, Decline/Skip, Owner Override,
  Owner Note edit, correction of status, manual backtrack, plus system milestone detection and
  backup create/restore) appends exactly one record via appendAuditRecord() in app.js, and this
  endpoint is what makes that record visible across devices — mirrors api/loyalty-ledger.js
  exactly, just pointed at a different file.

  COMPLETELY SEPARATE from api/loyalty-ledger.js and api/loyalty-rewards.js — this endpoint
  never reads or writes loyalty_ledger.json or loyalty_rewards.json, and neither of those ever
  touches loyalty_audit_log.json.

  APPEND-ONLY BY CONVENTION, NOT BY SERVER ENFORCEMENT
  ------------------------------------------------------
  The POST handler here overwrites the whole file with whatever array the client sends, same
  as api/loyalty-ledger.js — it does not itself refuse a shorter array. The append-only
  guarantee is enforced client-side: app.js's appendAuditRecord() is the ONLY place that
  mutates DB.data.loyaltyAuditLog, and it only ever pushes; pullLoyaltyAuditLogFromCloud() only
  ever unions by auditId, never removes. Nothing in this app ever calls this endpoint with a
  shorter array than what's already stored. (A stricter server-side length/prefix check could
  be added later if this endpoint is ever called from anywhere else.)

  AUTH
  ----
  Same 3 env vars as every other endpoint here: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY, DRIVE_FOLDER_ID. No new env vars required.

  BEHAVIOR
  --------
  GET /api/loyalty-audit
    Returns { loyaltyAuditLog: [...] }. Returns an empty array (not an error) if the file
    doesn't exist yet.

  POST /api/loyalty-audit
    Body: { loyaltyAuditLog: [...] } (required)
    Overwrites loyalty_audit_log.json in Drive with exactly this array, creating it on first
    write. Returns { ok: true, loyaltyAuditLog }.
*/
'use strict';

const { getAccessToken, downloadFile, createFile, updateFile, listChildren } = require('../lib/driveAuth');

const AUDIT_LOG_FILENAME = 'loyalty_audit_log.json';

async function findAuditLogFile(token, folderId) {
  const children = await listChildren(token, folderId);
  return children.find((f) => f.name === AUDIT_LOG_FILENAME) || null;
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
      const existing = await findAuditLogFile(token, folderId);
      if (!existing) {
        res.status(200).json({ loyaltyAuditLog: [] });
        return;
      }
      const loyaltyAuditLog = await downloadFile(token, existing.id);
      res.status(200).json({ loyaltyAuditLog: Array.isArray(loyaltyAuditLog) ? loyaltyAuditLog : [] });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!Array.isArray(body.loyaltyAuditLog)) {
        res.status(400).json({ error: 'Body must include a "loyaltyAuditLog" array' });
        return;
      }
      const existing = await findAuditLogFile(token, folderId);
      if (existing) {
        await updateFile(token, existing.id, body.loyaltyAuditLog);
      } else {
        await createFile(token, folderId, AUDIT_LOG_FILENAME, body.loyaltyAuditLog);
      }
      res.status(200).json({ ok: true, loyaltyAuditLog: body.loyaltyAuditLog });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/loyalty-audit] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
