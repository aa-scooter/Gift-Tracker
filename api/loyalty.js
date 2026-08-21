/*
  /api/loyalty.js  —  Serverless read/write bridge to Google Drive for the
  Customer Loyalty dataset (customers + rentals).

  WHY THIS EXISTS
  ----------------
  app.js used to ship with the customer/rental data hardcoded as JS
  constants (IMPORTED_CUSTOMERS / IMPORTED_RENTALS), which meant every
  update required regenerating that block and redeploying. This endpoint
  moves the *current* data into a Google Drive folder instead, so the app
  can read the live version at runtime and (eventually) write updates back
  — no redeploy needed for day-to-day data changes.

  AUTH
  ----
  Uses a Google Cloud service account (created specifically for this app —
  project "Loyalty Program", account
  loyalty-program@loyalty-program-506114.iam.gserviceaccount.com) via the
  standard OAuth2 JWT-bearer flow, implemented by hand with Node's built-in
  `crypto` module so this stays a zero-dependency function (no googleapis
  package, no build step — matches the rest of this repo, which has no
  bundler).

  The service account's private key must NEVER be committed to the repo.
  It lives only in the Vercel project's environment variables:

    GOOGLE_SERVICE_ACCOUNT_EMAIL   the service account's client_email
    GOOGLE_SERVICE_ACCOUNT_KEY     the service account's private_key
                                    (paste exactly as it appears in the
                                    downloaded JSON key, including the
                                    literal "\n" line breaks — see README
                                    note in PROGRESS_NOTES.md)
    DRIVE_FOLDER_ID                Drive folder ID the service account has
                                    Editor access to (currently the
                                    "Gift Tracker Loyalty Data" folder,
                                    id 1FxY-5COYoGiUfzN7d7K2IW9K8JhoZkuv)

  BEHAVIOR
  --------
  GET  /api/loyalty
    Returns { customers: [...], rentals: [...] }.
    On first-ever call, if loyalty_customers.json / loyalty_rentals.json
    don't exist yet in the Drive folder, this endpoint creates them from
    the seed data bundled in ./seed-data/ (a snapshot of the data that
    used to be hardcoded in app.js) and returns that. From then on, Drive
    is the source of truth.

  POST /api/loyalty
    Body: { customers: [...], rentals: [...] }  (either key optional —
    only what's provided gets overwritten)
    Overwrites the corresponding file(s) in Drive. Returns the same shape
    GET would, reflecting what's now stored.

  This is intentionally simple (whole-file overwrite, no merge/locking).
  It's fine for a single small team updating occasionally; it is NOT safe
  for concurrent simultaneous writers racing each other.
*/

const CUSTOMERS_FILENAME = "loyalty_customers.json";
const RENTALS_FILENAME = "loyalty_rentals.json";

const seedCustomers = require("./seed-data/loyalty_customers.json");
const seedRentals = require("./seed-data/loyalty_rentals.json");

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !rawKey) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY env vars"
    );
  }
  // Vercel env vars store newlines as literal "\n" — convert back.
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const crypto = require("crypto");
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims)
  )}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const jwt = `${unsigned}.${signature}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Token request failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function findFileId(token, folderId, filename) {
  const q = encodeURIComponent(
    `name = '${filename.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`
  );
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    throw new Error(`Drive search failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function downloadFile(token, fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    throw new Error(`Drive download failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function createFile(token, folderId, filename, jsonData) {
  const metadata = { name: filename, parents: [folderId] };
  const boundary = "loyaltyapi" + Date.now();
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(jsonData)}\r\n` +
    `--${boundary}--`;

  const resp = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!resp.ok) {
    throw new Error(`Drive create failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.id;
}

async function updateFile(token, fileId, jsonData) {
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jsonData),
    }
  );
  if (!resp.ok) {
    throw new Error(`Drive update failed: ${resp.status} ${await resp.text()}`);
  }
}

async function readOrSeed(token, folderId, filename, seedData) {
  let fileId = await findFileId(token, folderId, filename);
  if (!fileId) {
    fileId = await createFile(token, folderId, filename, seedData);
    return { fileId, data: seedData };
  }
  const data = await downloadFile(token, fileId);
  return { fileId, data };
}

module.exports = async function handler(req, res) {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    res.status(500).json({ error: "Missing DRIVE_FOLDER_ID env var" });
    return;
  }

  try {
    const token = await getAccessToken();

    if (req.method === "GET") {
      const [customers, rentals] = await Promise.all([
        readOrSeed(token, folderId, CUSTOMERS_FILENAME, seedCustomers),
        readOrSeed(token, folderId, RENTALS_FILENAME, seedRentals),
      ]);
      res.status(200).json({
        customers: customers.data,
        rentals: rentals.data,
      });
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const results = {};

      if (body.customers) {
        const existing = await findFileId(token, folderId, CUSTOMERS_FILENAME);
        if (existing) {
          await updateFile(token, existing, body.customers);
        } else {
          await createFile(token, folderId, CUSTOMERS_FILENAME, body.customers);
        }
        results.customers = body.customers;
      }
      if (body.rentals) {
        const existing = await findFileId(token, folderId, RENTALS_FILENAME);
        if (existing) {
          await updateFile(token, existing, body.rentals);
        } else {
          await createFile(token, folderId, RENTALS_FILENAME, body.rentals);
        }
        results.rentals = body.rentals;
      }

      res.status(200).json({ ok: true, ...results });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[/api/loyalty] error:", err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
