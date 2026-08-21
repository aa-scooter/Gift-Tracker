// Shared, zero-dependency Google Drive service-account auth + small file
// helpers, factored out of api/loyalty.js's original inline copy so the new
// full-refresh endpoint can reuse it without duplicating the JWT signing
// logic. Behavior is unchanged from api/loyalty.js's original functions.
'use strict';
const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !rawKey) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY env vars');
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;

  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

// Finds a file/folder by exact name, optionally scoped to a parent folder.
// Returns null if not found. If more than one match exists, returns the
// first Drive returns -- fine for this app's narrow, hand-curated folder
// structure, not a general-purpose dedup.
async function findByName(token, name, { parentId, folderOnly, fileOnly } = {}) {
  const parts = [`name = '${String(name).replace(/'/g, "\\'")}'`, 'trashed = false'];
  if (parentId) parts.push(`'${parentId}' in parents`);
  if (folderOnly) parts.push(`mimeType = 'application/vnd.google-apps.folder'`);
  if (fileOnly) parts.push(`mimeType != 'application/vnd.google-apps.folder'`);
  const q = encodeURIComponent(parts.join(' and '));
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.files && data.files.length ? data.files[0] : null;
}

async function listChildren(token, parentId, { folderOnly } = {}) {
  const parts = [`'${parentId}' in parents`, 'trashed = false'];
  if (folderOnly) parts.push(`mimeType = 'application/vnd.google-apps.folder'`);
  const q = encodeURIComponent(parts.join(' and '));
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Drive list failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.files || [];
}

async function downloadFile(token, fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function createFile(token, folderId, filename, jsonData) {
  const metadata = { name: filename, parents: [folderId] };
  const boundary = 'loyaltyapi' + Date.now();
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(jsonData)}\r\n` +
    `--${boundary}--`;
  const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!resp.ok) throw new Error(`Drive create failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.id;
}

async function updateFile(token, fileId, jsonData) {
  const resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(jsonData),
  });
  if (!resp.ok) throw new Error(`Drive update failed: ${resp.status} ${await resp.text()}`);
}

async function writeFile(token, folderId, filename, jsonData) {
  const existing = await findByName(token, filename, { parentId: folderId, fileOnly: true });
  if (existing) { await updateFile(token, existing.id, jsonData); return existing.id; }
  return createFile(token, folderId, filename, jsonData);
}

module.exports = { getAccessToken, findByName, listChildren, downloadFile, createFile, updateFile, writeFile };
