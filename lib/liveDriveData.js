// Fetches the LIVE 2026-onward booking data straight from the AA Scooters
// Manager app's own Drive-backed database (the "AA Scooters App Data"
// folder, shared read-only with this app's service account 2026-08-21),
// and reshapes it into the same row-dict format build_loyalty.py's
// load_customer_sheet() produces from an xlsx, so loyaltyMatch.js's build()
// can treat live-Drive rows and the bundled 2025 archive identically.
//
// Folder layout (confirmed by reading vercel-site/lib/googleDrive.js +
// contractWrites.js directly): root folder named "AA Scooters App Data" ->
// one subfolder per year, named literally e.g. "2026" -> files named
// "<sheetName>_<year>.json", e.g. "customer_2026.json", "Contract_2026.json".
// Each file is a row-array: [headerRow, dataRow2, dataRow3, ...], the same
// shape an openpyxl sheet dump produces.
'use strict';
const { findByName, listChildren, downloadFile } = require('./driveAuth');

const APP_FOLDER_NAME = 'AA Scooters App Data';

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

// Returns { rows, yearsFound, warnings } -- rows is a flat array of
// row-dicts across every year subfolder found under "AA Scooters App Data",
// ready to hand to loyaltyMatch.build() as one (label, rows) source.
async function fetchLiveRows(token) {
  const warnings = [];
  const appFolder = await findByName(token, APP_FOLDER_NAME, { folderOnly: true });
  if (!appFolder) {
    throw new Error(
      `Drive folder "${APP_FOLDER_NAME}" not found or not shared with this app's service account. ` +
      `Ask Anton to share it (Viewer) with the service account email.`
    );
  }
  const yearFolders = (await listChildren(token, appFolder.id, { folderOnly: true }))
    .filter((f) => /^\d{4}$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!yearFolders.length) throw new Error(`No year subfolders found inside "${APP_FOLDER_NAME}".`);

  let allRows = [];
  const yearsFound = [];
  for (const yf of yearFolders) {
    const [customerFile, contractFile] = await Promise.all([
      findByName(token, `customer_${yf.name}.json`, { parentId: yf.id, fileOnly: true }),
      findByName(token, `Contract_${yf.name}.json`, { parentId: yf.id, fileOnly: true }),
    ]);
    if (!customerFile) { warnings.push(`No customer_${yf.name}.json found in year folder ${yf.name} -- skipped.`); continue; }
    const [customerData, contractData] = await Promise.all([
      downloadFile(token, customerFile.id),
      contractFile ? downloadFile(token, contractFile.id) : Promise.resolve(null),
    ]);
    const enrichment = contractData ? buildContractEnrichment(contractData) : new Map();
    const { rows, backfilledPassport, backfilledPhone } = buildCustomerRowDicts(customerData, enrichment, `AA Scooters Live Data ${yf.name}`);
    allRows = allRows.concat(rows);
    yearsFound.push({ year: yf.name, rows: rows.length, backfilledPassport, backfilledPhone });
  }
  return { rows: allRows, yearsFound, warnings };
}

module.exports = { fetchLiveRows, APP_FOLDER_NAME, rowsFromJsonSheet, buildContractEnrichment, buildCustomerRowDicts };
