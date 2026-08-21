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
    Returns { rewards: [...] }. On first-ever call, if loyalty_rewards.json
    doesn't exist yet in the Drive folder, this creates it as an empty array
    and returns that. From then on, Drive is the source of truth.

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
*/
'use strict';

const { getAccessToken, findByName, downloadFile, writeFile } = require('../lib/driveAuth');

const REWARDS_FILENAME = 'loyalty_rewards.json';

module.exports = async function handler(req, res) {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    res.status(500).json({ error: 'Missing DRIVE_FOLDER_ID env var' });
    return;
  }

  try {
    const token = await getAccessToken();

    if (req.method === 'GET') {
      const existing = await findByName(token, REWARDS_FILENAME, { parentId: folderId, fileOnly: true });
      if (!existing) {
        await writeFile(token, folderId, REWARDS_FILENAME, []);
        res.status(200).json({ rewards: [] });
        return;
      }
      const rewards = await downloadFile(token, existing.id);
      res.status(200).json({ rewards: Array.isArray(rewards) ? rewards : [] });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!Array.isArray(body.rewards)) {
        res.status(400).json({ error: 'Body must include a "rewards" array' });
        return;
      }
      await writeFile(token, folderId, REWARDS_FILENAME, body.rewards);
      res.status(200).json({ ok: true, rewards: body.rewards });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/loyalty-rewards] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
