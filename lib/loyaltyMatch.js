// ---------------------------------------------------------------------------
// AA Scooters loyalty matching/merge pipeline -- JavaScript port of the
// Python build_loyalty.py tool, so it can run inside a Vercel serverless
// function (the "Full Refresh" button) instead of needing a human to run it.
//
// Ported 2026-08-21. Faithful port of build_loyalty.py's matching logic
// (name+nationality grouping, fuzzy name matching via Ratcliff/Obershelp --
// the same algorithm Python's difflib.SequenceMatcher.ratio() uses --
// passport/phone tie-breaking, union-find clustering), PLUS one new stage
// not present in the Python original: consolidating a customer's
// back-to-back renewals of the SAME bike into one rental entry spanning the
// whole continuous stay (e.g. 6 monthly renewals of the same bike become one
// "Jan 1 - Jun 30" entry instead of 6 separate rows) -- added per Anton's
// request 2026-08-21 after noticing Byron Stevens' rentals were listed as
// separate monthly entries instead of one continuous stay.
// ---------------------------------------------------------------------------
'use strict';

const TITLE_RE = /^(mr|mrs|ms|miss|mister|madam)\.?\s*/i;

const NAT_ALIASES = {
  'usa': 'USA', 'united states': 'USA', 'us': 'USA', 'united states of america': 'USA',
  'america': 'USA', 'american': 'USA',
  'uk': 'United Kingdom', 'united kingdom': 'United Kingdom', 'england': 'United Kingdom',
  'britain': 'United Kingdom', 'british': 'United Kingdom',
  'france': 'France', 'french': 'France', 'franch': 'France',
  'germany': 'Germany', 'german': 'Germany',
  'netherland': 'Netherlands', 'netherlands': 'Netherlands', 'dutch': 'Netherlands', 'holland': 'Netherlands',
  'australia': 'Australia', 'australian': 'Australia', 'aus': 'Australia',
  'thai': 'Thailand', 'thailand': 'Thailand',
  'philippines': 'Philippines', 'filipino': 'Philippines', 'philippine': 'Philippines',
  'burmese': 'Myanmar', 'myanmar': 'Myanmar', 'burma': 'Myanmar',
  'canada': 'Canada', 'canadian': 'Canada',
  'ireland': 'Ireland', 'irish': 'Ireland',
  'india': 'India', 'indian': 'India',
  'russia': 'Russia', 'russian': 'Russia', 'russian federation': 'Russia',
  'china': 'China', 'chinese': 'China', 'chianese': 'China',
  'poland': 'Poland', 'polish': 'Poland',
  'belgium': 'Belgium', 'belgian': 'Belgium',
  'spain': 'Spain', 'spanish': 'Spain',
  'korean': 'South Korea', 'korea': 'South Korea', 'sounth korean': 'South Korea', 'south korea': 'South Korea',
  'saudi': 'Saudi Arabia', 'saudi arabia': 'Saudi Arabia',
  'italy': 'Italy', 'italian': 'Italy',
  'turkish': 'Turkey', 'turky': 'Turkey', 'turkey': 'Turkey',
  'malaysia': 'Malaysia', 'malasian': 'Malaysia', 'malasia': 'Malaysia', 'malaysian': 'Malaysia',
  'israel': 'Israel', 'israeli': 'Israel', 'isrel': 'Israel', 'isael': 'Israel',
  'brazil': 'Brazil', 'brazilian': 'Brazil',
  'romania': 'Romania', 'romanian': 'Romania',
  'switzerland': 'Switzerland', 'swiss': 'Switzerland',
  'japan': 'Japan', 'japanese': 'Japan',
  'denish': 'Denmark', 'denmark': 'Denmark', 'danish': 'Denmark',
  'swedish': 'Sweden', 'sweden': 'Sweden',
  'portuguese': 'Portugal', 'portugul': 'Portugal', 'protuguese': 'Portugal', 'portugues': 'Portugal',
  'portugal': 'Portugal',
  'new zealand': 'New Zealand',
  'uraguy': 'Uruguay', 'uruguay': 'Uruguay',
  'slovekian': 'Slovakia', 'slovakian': 'Slovakia', 'slovakia': 'Slovakia',
  'indonesia': 'Indonesia', 'indonisian': 'Indonesia', 'indonisia': 'Indonesia', 'indonesian': 'Indonesia',
  'taiwan': 'Taiwan',
  'morocco': 'Morocco',
  'ukraine': 'Ukraine', 'ukrainian': 'Ukraine',
  'croatia': 'Croatia', 'croatian': 'Croatia',
  'montenego': 'Montenegro', 'montenegro': 'Montenegro',
  'argentina': 'Argentina', 'argentinian': 'Argentina',
  'lituania': 'Lithuania', 'lithuania': 'Lithuania',
  'hungarian': 'Hungary', 'hungary': 'Hungary',
  'syrian': 'Syria', 'syria': 'Syria',
  'zembabwe': 'Zimbabwe', 'zimbabwe': 'Zimbabwe',
  'oman': 'Oman',
  'singapore': 'Singapore',
  'kuwait': 'Kuwait',
  'kazusatan': 'Kazakhstan', 'kazakhstan': 'Kazakhstan',
  'czech': 'Czech Republic', 'czech republic': 'Czech Republic',
  'norway': 'Norway', 'norwegian': 'Norway',
  'estonia': 'Estonia',
  'austria': 'Austria', 'austrian': 'Austria',
  'nepal': 'Nepal',
  'luxembourg': 'Luxembourg',
  'bulgaria': 'Bulgaria', 'bulgarian': 'Bulgaria',
};
const SPECIAL_NAT_FLAGS = new Set(['thai/netherland', 'thai driving lisence']);

function normNameKey(n) {
  if (!n) return '';
  n = String(n).trim().toLowerCase();
  n = n.replace(TITLE_RE, '');
  n = n.replace(/[^a-z0-9\s\-'.]/g, '');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

function displayName(rawNames) {
  const titled = rawNames.filter((n) => TITLE_RE.test(String(n).trim()));
  const pool = titled.length ? titled : rawNames;
  return pool.slice().sort((a, b) => String(b).length - String(a).length)[0].trim();
}

function normNat(raw) {
  if (!raw) return { canon: '', flag: null };
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (SPECIAL_NAT_FLAGS.has(s)) return { canon: s, flag: `unrecognized nationality text: "${raw}"` };
  const canon = NAT_ALIASES[s];
  if (canon) return { canon, flag: null };
  const titled = String(raw).trim().replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
  return { canon: titled, flag: `nationality not in alias map: "${raw}" (used as-is)` };
}

function parsePrice(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// Returns a Date at UTC midnight for the given y/m/d, so day-diff math is exact.
function ymd(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

function parseDateLoose(v) {
  if (!v) return null;
  if (v instanceof Date) return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = ymd(+m[3], +m[2], +m[1]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = ymd(+m[1], +m[2], +m[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function isoDate(d) {
  return d ? d.toISOString().slice(0, 10) : null;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

const PHONE_HEADER_CANDIDATES = new Set([
  'phone number', 'phone', 'mobile', 'mobile number', 'contact number',
  'contact', 'tel', 'telephone', 'phone no', 'phone no.', 'number',
]);

function rawPhone(r) {
  for (const k of Object.keys(r)) {
    if (PHONE_HEADER_CANDIDATES.has(k.trim().toLowerCase()) && r[k]) {
      const s = String(r[k]).trim();
      if (s && s.toLowerCase() !== 'none') return s;
    }
  }
  return null;
}

function phoneMatchKey(v) {
  if (!v) return null;
  const digits = String(v).replace(/[^0-9]/g, '');
  if (digits.length < 6) return null;
  return digits.slice(-9);
}

function rowkey(r) {
  const sd = r['Renting date  from'];
  return normNameKey(r['Name']) + '|' + (sd ? String(sd).slice(0, 10) : '');
}

function fullRowkey(r) {
  return rowkey(r) + '|' + (r['Return date'] || '') + '|' + String(r['total price']);
}

// merge_sources: cross-file (name,start-date) collisions -- last file wins.
// Within-file: only byte-identical rows (name+start+end+price) collapse.
function mergeSources(fileRows) {
  const dedupedPerFile = fileRows.map(([label, rows]) => {
    const seen = new Set();
    const kept = [];
    for (const r of rows) {
      const fk = fullRowkey(r);
      if (seen.has(fk)) continue;
      seen.add(fk);
      kept.push(r);
    }
    return [label, kept];
  });

  const merged = [];
  const keysKept = new Set();
  for (let fi = dedupedPerFile.length - 1; fi >= 0; fi--) {
    const [label, rows] = dedupedPerFile[fi];
    const thisFileKeys = new Set();
    for (const r of rows) {
      const k = rowkey(r);
      const hasDate = !!r['Renting date  from'];
      if (hasDate && keysKept.has(k)) continue;
      thisFileKeys.add(k);
      merged.push([label, r]);
    }
    thisFileKeys.forEach((k) => keysKept.add(k));
  }
  merged.reverse();
  return merged;
}

function fuzzyKey(name) {
  let n = (name || '').replace(/\(.*?\)/g, ' ');
  n = normNameKey(n);
  n = n.replace(/[^a-z0-9\s]/g, ' ');
  const toks = n.split(/\s+/).filter((t) => t.length > 1).sort();
  return toks.join(' ');
}

// Ratcliff/Obershelp similarity ratio -- the same algorithm Python's
// difflib.SequenceMatcher.ratio() implements (find longest common
// substring, recurse on the leftover left/right pieces, ratio = 2*M / T).
function longestMatch(a, b, aLo, aHi, bLo, bHi) {
  let bestI = aLo, bestJ = bLo, bestLen = 0;
  const j2len = new Map();
  for (let i = aLo; i < aHi; i++) {
    const newj2len = new Map();
    for (let j = bLo; j < bHi; j++) {
      if (a[i] === b[j]) {
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestLen) { bestI = i - k + 1; bestJ = j - k + 1; bestLen = k; }
      }
    }
    j2len.clear();
    newj2len.forEach((v, k) => j2len.set(k, v));
  }
  return [bestI, bestJ, bestLen];
}

function matchingBlocksLen(a, b) {
  let total = 0;
  const stack = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [aLo, aHi, bLo, bHi] = stack.pop();
    if (aLo >= aHi || bLo >= bHi) continue;
    const [i, j, k] = longestMatch(a, b, aLo, aHi, bLo, bHi);
    if (k === 0) continue;
    total += k;
    stack.push([aLo, i, bLo, j]);
    stack.push([i + k, aHi, j + k, bHi]);
  }
  return total;
}

function nameSimilarity(a, b) {
  if (!a.length && !b.length) return 1;
  const total = a.length + b.length;
  if (total === 0) return 1;
  const m = matchingBlocksLen(a, b);
  return (2 * m) / total;
}

const AUTO_MERGE_THRESHOLD = 0.90;
const REVIEW_THRESHOLD = 0.80;

class UnionFind {
  constructor(n) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb; }
}

function aggregateItems(items, today) {
  const rawNames = items.map(([, r]) => r['Name']);
  const rawNats = items.map(([, r]) => r['Nationality']).filter(Boolean);
  const passports = [...new Set(items.map(([, r]) => (r['Passport Number'] != null ? String(r['Passport Number']).trim() : ''))
    .filter((p) => p && p.toLowerCase() !== 'none'))].sort();
  const phones = [...new Set(items.map(([, r]) => rawPhone(r)).filter(Boolean))].sort();

  let totalSpend = 0, totalDaysSummed = 0, firstStart = null, lastTouch = null;
  let nMissingPrice = 0, nMissingDates = 0, isActive = false;
  const natFlags = [];
  const intervals = [];

  for (const [, r, natFlag] of items) {
    if (natFlag) natFlags.push({ name: r['Name'], nationality_raw: r['Nationality'], issue: natFlag, renting_date: r['Renting date  from'] });
    const price = parsePrice(r['total price']);
    if (price === null) nMissingPrice++; else totalSpend += price;
    const sd = parseDateLoose(r['Renting date  from']);
    const ed = parseDateLoose(r['Return date']);
    if (sd && ed) {
      if (ed >= today) isActive = true;
      let effEd = ed < today ? ed : today;
      if (effEd < sd) effEd = sd;
      totalDaysSummed += daysBetween(sd, ed);
      intervals.push([sd, effEd]);
      if (!firstStart || sd < firstStart) firstStart = sd;
      const touch = sd > ed ? sd : ed;
      if (!lastTouch || touch > lastTouch) lastTouch = touch;
    } else {
      nMissingDates++;
    }
  }

  let mergedDays = 0;
  if (intervals.length) {
    intervals.sort((a, b) => a[0] - b[0]);
    let [curS, curE] = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      const [s, e] = intervals[i];
      if (s <= curE) { if (e > curE) curE = e; }
      else { mergedDays += daysBetween(curS, curE); curS = s; curE = e; }
    }
    mergedDays += daysBetween(curS, curE);
  }

  const customer = {
    name: displayName(rawNames),
    name_variants: [...new Set(rawNames.map((n) => String(n).trim()))].sort(),
    nationality: null,
    nationality_raw_variants: [...new Set(rawNats)].sort(),
    passport_numbers: passports,
    phone_numbers: phones,
    total_rentals: items.length,
    total_spend_thb: Math.round(totalSpend * 100) / 100,
    total_days_rented: mergedDays,
    total_days_summed_raw: totalDaysSummed,
    first_rental_date: isoDate(firstStart),
    last_activity_date: isoDate(lastTouch),
    currently_active: isActive,
    rows_missing_price: nMissingPrice,
    rows_missing_dates: nMissingDates,
  };
  return { customer, passports, phones, natFlags };
}

// ---- NEW stage (not in the Python original): consolidate a customer's
// back-to-back renewals of the SAME bike into one rental entry spanning the
// whole continuous stay. Two rentals for the same customer+bike merge when
// the next one starts within GAP_DAYS of the previous one's end (covers
// same-day and next-day handover/logging variance without accidentally
// merging two genuinely separate visits weeks apart). Revenue and days are
// summed from the constituent rows (not recomputed from the date span) so
// totals stay exactly correct even if a renewal's dates overlap slightly.
const GAP_DAYS = 1;

function normalizeBikeKey(bikeRaw) {
  if (!bikeRaw) return '';
  return String(bikeRaw).trim().toLowerCase().replace(/\s+/g, ' ');
}

function consolidateRentals(rentals) {
  const byGroup = new Map();
  for (const r of rentals) {
    const key = r.customer_id + '|' + normalizeBikeKey(r.bike_model);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(r);
  }

  const out = [];
  for (const group of byGroup.values()) {
    group.sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
    let run = null;
    for (const r of group) {
      const sd = r.start_date ? parseDateLoose(r.start_date) : null;
      const ed = r.end_date ? parseDateLoose(r.end_date) : null;
      // _segments records each constituent renewal's OWN dates/revenue/days exactly as they
      // came in, independent of the summed totals above — finalizeRun() attaches this as
      // `segments` (only when >1 constituent) so downstream year-by-year reporting can
      // attribute a boundary-spanning consolidated rental's revenue to the calendar year each
      // renewal actually started in, instead of dumping the whole summed total into the year
      // the FIRST constituent started (the bug this was added to fix).
      if (!run) {
        run = { ...r, _sourceRows: [r.source_row].filter(Boolean), _constituents: 1, _endDate: ed,
          _segments: [{ start_date: r.start_date, end_date: r.end_date, revenue: r.revenue || 0, paid_days: r.paid_days || 0, booked_days: r.booked_days || 0 }] };
        continue;
      }
      const gapOk = sd && run._endDate && daysBetween(run._endDate, sd) <= GAP_DAYS;
      if (gapOk) {
        run.end_date = r.end_date || run.end_date;
        run._endDate = ed && (!run._endDate || ed > run._endDate) ? ed : run._endDate;
        run.revenue = (run.revenue || 0) + (r.revenue || 0);
        run.booked_days = (run.booked_days || 0) + (r.booked_days || 0);
        run.paid_days = (run.paid_days || 0) + (r.paid_days || 0);
        if (r.status === 'active') run.status = 'active';
        if (r.source_row) run._sourceRows.push(r.source_row);
        run._segments.push({ start_date: r.start_date, end_date: r.end_date, revenue: r.revenue || 0, paid_days: r.paid_days || 0, booked_days: r.booked_days || 0 });
        run._constituents++;
      } else {
        out.push(finalizeRun(run));
        run = { ...r, _sourceRows: [r.source_row].filter(Boolean), _constituents: 1, _endDate: ed,
          _segments: [{ start_date: r.start_date, end_date: r.end_date, revenue: r.revenue || 0, paid_days: r.paid_days || 0, booked_days: r.booked_days || 0 }] };
      }
    }
    if (run) out.push(finalizeRun(run));
  }
  out.sort((a, b) => (a.start_date || '').localeCompare(b.start_date || '') || a.customer_id.localeCompare(b.customer_id));
  return out;
}

function finalizeRun(run) {
  const { _endDate, _sourceRows, _constituents, _segments, ...rest } = run;
  rest.source_row = _sourceRows.length > 1 ? _sourceRows.join('; ') : (_sourceRows[0] || null);
  if (_constituents > 1) {
    rest.consolidated_from = _constituents;
    rest.segments = _segments;
  }
  return rest;
}

function build(fileRows, today) {
  const merged = mergeSources(fileRows);

  const groups = new Map();
  for (const [label, r] of merged) {
    const nk = normNameKey(r['Name']);
    const { canon: natCanon, flag: natFlag } = normNat(r['Nationality']);
    const key = nk + '' + natCanon;
    if (!groups.has(key)) groups.set(key, { nk, nat: natCanon, items: [] });
    groups.get(key).items.push([label, r, natFlag]);
  }

  const protos = [];
  for (const g of groups.values()) {
    const passports = new Set(), phones = new Set();
    for (const [, r] of g.items) {
      const p = String(r['Passport Number'] || '').trim();
      if (p && p.toLowerCase() !== 'none') passports.add(p);
      const pk = phoneMatchKey(rawPhone(r));
      if (pk) phones.add(pk);
    }
    protos.push({
      nat: g.nat,
      items: g.items,
      fkey: fuzzyKey(displayName(g.items.map(([, r]) => r['Name']))),
      passports, phones,
    });
  }

  const uf = new UnionFind(protos.length);
  const review = [];
  const byNat = new Map();
  protos.forEach((p, i) => {
    if (!byNat.has(p.nat)) byNat.set(p.nat, []);
    byNat.get(p.nat).push(i);
  });

  const possibleMerges = [];
  for (const idxs of byNat.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a], j = idxs[b];
        const pi = protos[i], pj = protos[j];
        if (!pi.fkey || !pj.fkey) continue;
        const score = nameSimilarity(pi.fkey, pj.fkey);
        if (score < REVIEW_THRESHOLD) continue;
        const sharedPassport = [...pi.passports].some((p) => pj.passports.has(p));
        const sharedPhone = [...pi.phones].some((p) => pj.phones.has(p));
        const conflictingPassport = pi.passports.size > 0 && pj.passports.size > 0 && !sharedPassport;
        const conflictingPhone = pi.phones.size > 0 && pj.phones.size > 0 && !sharedPhone;
        if (sharedPassport || sharedPhone) uf.union(i, j);
        else if (score >= AUTO_MERGE_THRESHOLD && !conflictingPassport && !conflictingPhone) uf.union(i, j);
        else possibleMerges.push([score, i, j, conflictingPassport, conflictingPhone]);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < protos.length; i++) {
    const root = uf.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const customers = [];
  const rootItems = new Map();
  for (const [root, idxs] of clusters.entries()) {
    let items = [];
    const natVotes = new Map();
    for (const i of idxs) {
      items = items.concat(protos[i].items);
      natVotes.set(protos[i].nat, (natVotes.get(protos[i].nat) || 0) + protos[i].items.length);
    }
    let natCanon = '', bestVotes = -1;
    natVotes.forEach((v, k) => { if (v > bestVotes) { bestVotes = v; natCanon = k; } });
    const { customer, passports, phones, natFlags } = aggregateItems(items, today);
    customer.nationality = natCanon;
    review.push(...natFlags);
    rootItems.set(root, items);
    if (passports.length > 1) review.push({ name: customer.name, nationality: natCanon, issue: `multiple different passport numbers on file: ${JSON.stringify(passports)}`, renting_date: null });
    if (phones.length > 1) review.push({ name: customer.name, nationality: natCanon, issue: `multiple different phone numbers on file: ${JSON.stringify(phones)}`, renting_date: null });
    if (idxs.length > 1) customer._merged_from = idxs.length;
    customers.push([root, customer]);
  }

  customers.sort((a, b) => {
    const fa = a[1].first_rental_date || '', fb = b[1].first_rental_date || '';
    if (!fa !== !fb) return fa ? -1 : 1;
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a[1].name.localeCompare(b[1].name);
  });

  const rootToId = new Map();
  const finalCustomers = [];
  customers.forEach(([root, cust], i) => {
    const cid = 'C' + String(i + 1).padStart(4, '0');
    rootToId.set(root, cid);
    const mergedFrom = cust._merged_from;
    delete cust._merged_from;
    finalCustomers.push({ customer_id: cid, ...cust });
    if (mergedFrom) review.push({ name: cust.name, nationality: cust.nationality, issue: `auto-combined ${mergedFrom} differently-spelled/ordered name entries into this one customer (${cid}) -- worth a quick sanity check`, renting_date: null });
  });

  const seenPairs = new Set();
  possibleMerges.sort((a, b) => b[0] - a[0]);
  for (const [score, i, j, conflictingPassport, conflictingPhone] of possibleMerges) {
    const ci = rootToId.get(uf.find(i)), cj = rootToId.get(uf.find(j));
    if (ci === cj) continue;
    const pairKey = [ci, cj].sort().join('|');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const nameI = displayName(protos[i].items.map(([, r]) => r['Name']));
    const nameJ = displayName(protos[j].items.map(([, r]) => r['Name']));
    let note = `possible same person (name similarity ${Math.round(score * 100)}%), not merged automatically`;
    const conflicts = [];
    if (conflictingPassport) conflicts.push('different passport numbers on file for each');
    if (conflictingPhone) conflicts.push('different phone numbers on file for each');
    if (conflicts.length) note += ' -- ' + conflicts.join('; ') + ', which argues against merging';
    review.push({ name: `${nameI} (${ci}) / ${nameJ} (${cj})`, nationality: protos[i].nat, issue: note, renting_date: null });
  }

  let rentals = [];
  for (const [root, idxs] of clusters.entries()) {
    const cid = rootToId.get(root);
    if (!cid) continue;
    for (const [, r] of rootItems.get(root)) {
      const sd = parseDateLoose(r['Renting date  from']);
      const ed = parseDateLoose(r['Return date']);
      const price = parsePrice(r['total price']);
      let bikeRaw = r['Bike model'];
      bikeRaw = typeof bikeRaw === 'string' && bikeRaw.trim() ? bikeRaw.trim() : null;
      const days = sd && ed ? daysBetween(sd, ed) : null;
      const status = (!ed || ed >= today) ? 'active' : 'completed';
      rentals.push({
        customer_id: cid,
        bike_model: bikeRaw,
        bike_name_raw: bikeRaw,
        start_date: isoDate(sd),
        end_date: isoDate(ed),
        booked_days: days,
        paid_days: days,
        revenue: price,
        status,
        source_row: r['__row_label__'] || null,
      });
    }
  }

  // NEW: consolidate back-to-back same-bike renewals into one entry before
  // assigning rental IDs, so a long-running rental spans its whole stay.
  rentals = consolidateRentals(rentals);

  rentals.sort((a, b) => (a.start_date || '').localeCompare(b.start_date || '') || a.customer_id.localeCompare(b.customer_id));
  rentals.forEach((r, i) => { r.rental_id = 'R' + String(i + 1).padStart(5, '0'); });

  return { customers: finalCustomers, review, rentals };
}

module.exports = {
  normNameKey, displayName, normNat, parsePrice, parseDateLoose, isoDate,
  rawPhone, phoneMatchKey, mergeSources, fuzzyKey, nameSimilarity,
  UnionFind, aggregateItems, consolidateRentals, normalizeBikeKey, build,
};
