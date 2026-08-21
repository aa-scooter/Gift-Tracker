/*
  /api/loyalty-rewards.js — Serverless read/write bridge to Google Drive for the
  Rewards dataset (DB.data.rewards).

  WHY THIS EXISTS
  ----------------
  Every reward action (Give Gift, Reserve, Accept, Decline, edit) previously
  wrote ONLY to the browser's own localStorage (see DB.save() in app.js) --
  never synced anywhere. That meant a reward given on one device/browser was
  permanently invisible on every other device, with no way to reconcile them
  short of manually exporting each device's local backup. This endpoint gives
  rewards the exact same Drive-backed sync that customers/rentals already have
  via api/loyalty.js -- one shared loyalty_rewards.json file in the same Drive
  folder, so "Give Gift" on any device becomes visible everywhere.

  Reuses the shared auth/file helpers in lib/driveAuth.js (the same ones
  api/loyalty-refresh.js uses) rather than duplicating the inline JWT-signing
  copy api/loyalty.js still carries from before that file was factored out.

  AUTH
  ----
  Same 3 env vars as api/loyalty.js and api/loyalty-refresh.js:
  GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY, DRIVE_FOLDER_ID.
  No new env vars required -- this writes into the same "Gift Tracker Loyalty
  Data" Drive folder the app already owns.

  BEHAVIOR
  --------
  GET /api/loyalty-rewards
    Returns { rewards: [...] }.

  POST /api/loyalty-rewards
    Body: { rewards: [...] } (required)
    Overwrites loyalty_rewards.json in Drive with exactly this array. Returns
    { ok: true, rewards }.

  Same caveat as api/loyalty.js: this is a whole-file overwrite, no
  merge/locking. Fine for a single small team; not safe for two staff editing
  rewards at the exact same moment on two different devices with no network
  round-trip in between -- app.js's client-side sync (pull-before-push, see
  the DB.save()-for-rewards wiring) is what keeps that window small, not this
  endpoint.

  WHY A HARDCODED FILE ID, NOT A NAME LOOKUP
  --------------------------------------------
  Earlier versions of this endpoint located loyalty_rewards.json by name every
  request -- first via driveAuth.js's findByName() (a `name = '...'` search
  query), then via listChildren() (a plain parent/child listing) after
  findByName() was caught missing a freshly-shared file for 90+ seconds.
  listChildren() turned out to have the same class of problem: same-day
  testing (2026-08-21) caught it intermittently failing to see this exact
  file for 30+ seconds AFTER a successful read/write of that same file,
  moments apart, with no pattern to when it would or wouldn't see it -- a
  handful of retries with short delays was not reliably enough to ride it
  out. That pointed at Drive's list/search paths being eventually consistent
  for a file shared with (not owned by) this service account, in a way a
  short retry loop inside one ~10s serverless invocation can't fully absorb.

  Direct id-based access (files.get / files.update by id, i.e. downloadFile()/
  updateFile() below) does not go through list or search at all -- it reads
  the object directly by its primary key, which Drive serves consistently.
  So this endpoint hardcodes the file's id (captured once, when the file was
  created -- see loyalty_rewards.json's creation history in the Aug 2026
  commits) and uses direct id-based reads/writes as the only path in normal
  operation. Discovery via listChildren + DRIVE_FOLDER_ID is kept as a
  fallback ONLY for the case the hardcoded id ever 404s (file recreated,
  moved, or deleted), which should essentially never happen day to day.
*/
'use strict';

const { getAccessToken, downloadFile, createFile, updateFile, listChildren } = require('../lib/driveAuth');

const REWARDS_FILENAME = 'loyalty_rewards.json';

// Captured once from Drive when loyalty_rewards.json was created (2026-08-21,
// via a real Google account -- this service account has no storage quota of
// its own and cannot create files, see the file-level comment above). Direct
// id access sidesteps the list/search flakiness described above.
const KNOWN_REWARDS_FILE_ID = '1lWU2n7qKnF-TPyr0vu67tq_JsDMSuPLF';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findRewardsFileByListing(token, folderId) {
  const children = await listChildren(token, folderId);
  return children.find((f) => f.name === REWARDS_FILENAME) || null;
}

// Only used if the hardcoded id ever stops working. Retries a few times with
// a short delay to ride out listChildren's occasional lag (see file header).
async function findRewardsFileWithRetry(token, folderId, { retries = 4, delayMs = 1000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const found = await findRewardsFileByListing(token, folderId);
    if (found) return found;
    if (attempt < retries) await sleep(delayMs);
  }
  return null;
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
      try {
        const rewards = await downloadFile(token, KNOWN_REWARDS_FILE_ID);
        res.status(200).json({ rewards: Array.isArray(rewards) ? rewards : [] });
        return;
      } catch (directErr) {
        console.warn('[/api/loyalty-rewards] GET: direct id lookup failed, falling back to listChildren:', directErr && directErr.message);
        const existing = await findRewardsFileWithRetry(token, folderId);
        if (!existing) {
          console.warn('[/api/loyalty-rewards] GET: loyalty_rewards.json not visible via listChildren after retries; returning empty list instead of failing.');
          res.status(200).json({ rewards: [] });
          return;
        }
        const rewards = await downloadFile(token, existing.id);
        res.status(200).json({ rewards: Array.isArray(rewards) ? rewards : [] });
        return;
      }
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!Array.isArray(body.rewards)) {
        res.status(400).json({ error: 'Body must include a "rewards" array' });
        return;
      }
      try {
        await updateFile(token, KNOWN_REWARDS_FILE_ID, body.rewards);
        res.status(200).json({ ok: true, rewards: body.rewards });
        return;
      } catch (directErr) {
        console.warn('[/api/loyalty-rewards] POST: direct id update failed, falling back to listChildren:', directErr && directErr.message);
        const existing = await findRewardsFileWithRetry(token, folderId);
        if (existing) {
          await updateFile(token, existing.id, body.rewards);
        } else {
          await createFile(token, folderId, REWARDS_FILENAME, body.rewards);
        }
        res.status(200).json({ ok: true, rewards: body.rewards });
        return;
      }
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/loyalty-rewards] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
