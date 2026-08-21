// Fetches the LIVE booking data straight from the AA Scooters Manager app's
// own Drive-backed database (the "AA Scooters App Data" folder, shared
// read-only with this app's service account 2026-08-21), and reshapes it
// into the same row-dict format build_loyalty.py's load_customer_sheet()
// produces from an xlsx, so loyaltyMatch.js's build() can treat live-Drive
// rows and the bundled 2025 archive identically.
//
// Folder layout (confirmed 2026-08-21 by reading the actual files in Drive
// directly -- NOT by year subfolder as first assumed. There IS a "2026"
// subfolder under "AA Scooters App Data", but it only holds monthly
// accounting exports (August_2026.json, cash flow notes, etc.), never
// customer/rental records. The real customer/rental data lives as TWO FLAT
// FILES directly in the root of "AA Scooters App Data": "customer.json" and
// "Contract.json" -- both a row-array [headerRow, dataRow2, ...], the same
// shape an openpyxl sheet dump produces, and both already span the entire
// history the live app has ever recorded (2025 through today), not just
// 2026 -- so cross-file dedup in loyaltyMatch.js's mergeSources() is what
// keeps this from double-counting rows also present in the bundled 2025
// archive, not any date-based filtering here.
'use strict';
const { findByName, downloadFile } = require('./driveAuth');

const APP_FOLDER_NAME = 'AA Scooters App Data';
const CUSTOMER_FILE = 'customer.json';
const CONTRACT_FILE = 'Contract.json';

function rowsFromJsonSheet(data) {
  if (!data || !data.length) return { rows: [], idx: {} };
  const header = data[0];
  const idx = {};
  header.forEach((h, i) => {
    if (typeof h === 'string' && h.trim()) {
      const key = h.trim();
      if (!(key in idx)) idx[key] = i;
    }
  });
  return { rows: data.slice(1), idx };
}

function buildContractEnrichment(contractData) {
  const { rows, idx } = rowsFromJsonSheet(contractData);
  const nameI = idx['Name'], dateI = idx['Renting date  from'], passportI = idx['Passport Number'], phoneI = idx['Number'];
  const out = new Map();
  if (nameI === undefined || dateI === undefined) return out;
  for (const r of rows) {
    const name = r[nameI];
    if (!name || typeof name !== 'string' || !name.trim()) continue;
    const sdRaw = r[dateI];
    const sdKey = flexDateKey(sdRaw);
    if (!sdKey) continue;
    const entry = {};
    if (passportI !== undefined && r[passportI]) {
      const p = String(r[passportI]).trim();
      if (p && p.toLowerCase() !== 'none') entry.passport = p;
    }
    if (phoneI !== undefined && r[phoneI]) {
      const ph = String(r[phoneI]).trim();
      if (ph && ph.toLowerCase() !== 'none') entry.phone = ph;
    }
    if (Object.keys(entry).length) out.set(normKey(name) + '|' + sdKey, entry);
  }
  return out;
}

function flexDateKey(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const TITLE_RE = /^(mr|mrs|ms|miss|mister|madam)\.?\s*/i;
function normKey(n) {
  return String(n).trim().toLowerCase().replace(TITLE_RE, '').replace(/[^a-z0-9\s\-'.]/g, '').replace(/\s+/g, ' ').trim();
}

const PHONE_HEADERS = new Set(['phone number', 'phone', 'mobile', 'mobile number', 'contact number', 'contact', 'tel', 'telephone', 'phone no', 'phone no.']);
function hasRawPhone(rec) {
  for (const k of Object.keys(rec)) {
    if (PHONE_HEADERS.has(k.trim().toLowerCase()) && rec[k]) {
      const s = String(rec[k]).trim();
      if (s && s.toLowerCase() !== 'none') return true;
    }
  }
  return false;
}

function buildCustomerRowDicts(customerData, enrichment, label) {
  const { rows, idx } = rowsFromJsonSheet(customerData);
  const nameI = idx['Name'];
  const out = [];
  let backfilledPassport = 0, backfilledPhone = 0;
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const name = nameI !== undefined ? r[nameI] : null;
    if (!name || typeof name !== 'string' || !name.trim()) return;
    const rec = {};
    for (const [k, colIdx] of Object.entries(idx)) rec[k] = r[colIdx] === undefined ? null : r[colIdx];
    rec.__row_label__ = `${label} row ${rowNum}`;
    if (enrichment && enrichment.size) {
      const sd = rec['Renting date  from'];
      const key = normKey(rec['Name']) + '|' + (typeof sd === 'string' ? sd.slice(0, 10) : flexDateKey(sd));
      const extra = enrichment.get(key);
      if (extra) {
        if (!(rec['Passport Number'] && String(rec['Passport Number']).trim()) && extra.passport) {
          rec['Passport Number'] = extra.passport;
          backfilledPassport++;
        }
        if (!hasRawPhone(rec) && extra.phone) {
          rec['Phone Number'] = extra.phone;
          backfilledPhone++;
        }
      }
    }
    out.push(rec);
  });
  return { rows: out, backfilledPassport, backfilledPhone };
}

// Returns { rows, warnings } -- rows is a flat array of row-dicts read from
// the live "customer.json" (enriched with passport/phone from "Contract.json"
// where the customer sheet is missing them), ready to hand to
// loyaltyMatch.build() as one (label, rows) source.
async function fetchLiveRows(token) {
  const warnings = [];
  const appFolder = await findByName(token, APP_FOLDER_NAME, { folderOnly: true });
  if (!appFolder) {
    throw new Error(
      `Drive folder "${APP_FOLDER_NAME}" not found or not shared with this app's service account. ` +
      `Ask Anton to share it (Viewer) with the service account email.`
    );
  }

  const [customerFile, contractFile] = await Promise.all([
    findByName(token, CUSTOMER_FILE, { parentId: appFolder.id, fileOnly: true }),
    findByName(token, CONTRACT_FILE, { parentId: appFolder.id, fileOnly: true }),
  ]);
  if (!customerFile) {
    throw new Error(`"${CUSTOMER_FILE}" not found in "${APP_FOLDER_NAME}" -- the live booking app's data layout may have changed.`);
  }
  if (!contractFile) warnings.push(`"${CONTRACT_FILE}" not found -- passport/phone enrichment skipped.`);

  const [customerData, contractData] = await Promise.all([
    downloadFile(token, customerFile.id),
    contractFile ? downloadFile(token, contractFile.id) : Promise.resolve(null),
  ]);
  const enrichment = contractData ? buildContractEnrichment(contractData) : new Map();
  const { rows, backfilledPassport, backfilledPhone } = buildCustomerRowDicts(customerData, enrichment, 'AA Scooters Live Data');

  return { rows, backfilledPassport, backfilledPhone, warnings };
}

module.exports = { fetchLiveRows, APP_FOLDER_NAME, rowsFromJsonSheet, buildContractEnrichment, buildCustomerRowDicts };
