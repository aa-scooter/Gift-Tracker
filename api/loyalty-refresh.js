/*
  /api/loyalty-refresh.js — the "Full Refresh" button's backend.

  Staff-triggered, on demand (POST from the Settings screen), does the
  ENTIRE rebuild in one request:
    1. Pulls the live 2026-onward booking data straight from the AA
       Scooters Manager app's own Drive-backed database ("AA Scooters App
       Data" folder — shared read-only with this service account
       2026-08-21 for exactly this purpose).
    2. Combines it with the frozen 2025 archive bundled in
       ./data/archive_2025.json (that period only ever existed in the old
       spreadsheet export and never will again, so it's baked in once and
       never re-fetched).
    3. Runs the full name/passport/phone matching pipeline (lib/loyaltyMatch.js
       — a JS port of the team's build_loyalty.py tool) to merge everything
       into one deduplicated customer list, INCLUDING the new consolidation
       pass that folds a customer's back-to-back renewals of the same bike
       into one continuous rental entry instead of one row per renewal.
    4. Converts the result to the app's imp_cN/imp_rN shape and writes it
       into the same Drive file GET /api/loyalty reads (loyalty_customers.json
       / loyalty_rentals.json in DRIVE_FOLDER_ID) — AND returns it directly
       in the response, so the button's preview screen doesn't need a
       second round trip.

  This endpoint only ever WRITES to the "Gift Tracker Loyalty Data" folder
  (DRIVE_FOLDER_ID) it already owned. It only ever READS from the separate
  "AA Scooters App Data" folder — never writes there, never touches the
  live booking system's own data.

  Needs the same 3 env vars as /api/loyalty: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_KEY, DRIVE_FOLDER_ID. No new env vars required —
  the live-data folder is discovered by name via Drive search, not an ID
  pinned in config, since sharing is what grants access, not a stored ID.
*/
'use strict';

const { getAccessToken, writeFile } = require('../lib/driveAuth');
const { fetchLiveRows } = require('../lib/liveDriveData');
const loyaltyMatch = require('../lib/loyaltyMatch');
const { toAppShape } = require('../lib/appShape');
const archive2025 = require('../data/archive_2025.json');

const CUSTOMERS_FILENAME = 'loyalty_customers.json';
const RENTALS_FILENAME = 'loyalty_rentals.json';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed -- use POST' });
    return;
  }
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    res.status(500).json({ error: 'Missing DRIVE_FOLDER_ID env var' });
    return;
  }

  try {
    const token = await getAccessToken();
    const { rows: liveRows, yearsFound, warnings } = await fetchLiveRows(token);

    const fileRows = [
      ['2025 archive', archive2025],
      ['AA Scooters Live Data', liveRows],
    ];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const { customers, review, rentals } = loyaltyMatch.build(fileRows, today);
    const { customers: appCustomers, rentals: appRentals } = toAppShape(customers, rentals);

    await Promise.all([
      writeFile(token, folderId, CUSTOMERS_FILENAME, appCustomers),
      writeFile(token, folderId, RENTALS_FILENAME, appRentals),
    ]);

    const consolidatedCount = rentals.filter((r) => r.consolidated_from).length;

    res.status(200).json({
      ok: true,
      customers: appCustomers,
      rentals: appRentals,
      stats: {
        customerCount: appCustomers.length,
        rentalCount: appRentals.length,
        reviewCount: review.length,
        consolidatedRentalCount: consolidatedCount,
        liveYearsFound: yearsFound,
        totalSpendThb: Math.round(customers.reduce((s, c) => s + (c.total_spend_thb || 0), 0)),
      },
      warnings,
    });
  } catch (err) {
    console.error('[/api/loyalty-refresh] error:', err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
