/* ==========================================================================
   AA Scooter Rental — Customer & Loyalty Manager
   Internal operations tool. Single-file app logic, localStorage-backed.
   Data model is deliberately import-friendly — see DB.seed() / DB.importJSON()
   for the shape existing AA Scooters records should be mapped into.
   ========================================================================== */

(() => {
"use strict";

/* ---------------------------------------------------------------------- */
/* CONFIG                                                                  */
/* ---------------------------------------------------------------------- */

const STORAGE_KEY = "aa_scooter_manager_db_v1";

// Standardized Vehicle Category tiers (Ride Upgrade ladder + Journey Gift / Qualified
// Rental thresholds are all keyed off these five, never the raw historical bike name).
const CATEGORY_TIERS = [
  "125cc",                 // Tier 1 — 110cc/125cc: Zoomer-X, GT family, Grand Filano, Freego
  "155cc Standard Key",    // Tier 2 — Aerox Green/Red/RAX family, NMAX White
  "155cc Keyless/ABS",     // Tier 3 — Aerox White/Cool family, NMAX Blue/Black/Grey, Drone
  "Forza 300",             // Tier 4 — Honda Forza 300, standard key
  "XMAX 300",              // Tier 5 — XMAX 300, keyless/ABS — top of the fleet
];

// Bikes -> paid-day threshold that unlocks the AA Journey Gift on return.
const JOURNEY_GIFT_THRESHOLDS = {
  "125cc": 60,
  "155cc Standard Key": 45,
  "155cc Keyless/ABS": 45,
  "Forza 300": 30,
  "XMAX 300": 30,
};
const DEFAULT_JOURNEY_THRESHOLD = 45;

const WELCOME_KIT_MIN_DAYS = 7;

// A "Rental Visit" is any genuine new rental after a previous one ended (already tracked as
// a rental record). A "Qualified Rental" is a visit substantial enough to count toward Ride
// Upgrade progression — paid days OR final paid value, whichever is met first, per tier.
// Tier 3 consolidates the old separate Aerox-Keyless (5d/2000) and NMAX/DRONE (4d/2000)
// thresholds into one — using the more lenient day count since they're now one category.
const QUALIFIED_RENTAL_THRESHOLDS = {
  "125cc": { days: 7, revenue: 2000 },
  "155cc Standard Key": { days: 5, revenue: 1800 },
  "155cc Keyless/ABS": { days: 4, revenue: 2000 },
  "Forza 300": { days: 3, revenue: 1800 },
  "XMAX 300": { days: 3, revenue: 2400 },
};
const DEFAULT_QUALIFIED_RENTAL_THRESHOLD = { days: 5, revenue: 1800 };

const RETURN_PRIVILEGE_MIN_QUALIFIED_RENTALS = 3;
const RETURN_PRIVILEGE_MIN_REVENUE = 8000;

// The operational/legacy boundary for the loyalty program's data model — deliberately
// hardcoded, NOT staff-editable in Settings, unlike every other threshold in this app.
// 2025 rentals still establish real customer identity/history (visible in rental history,
// still counted in Rental Visits and "Returning Customer" recognition) but never feed
// reward-eligibility math, Qualified Rental counts, cumulative loyalty day/revenue
// thresholds, or Customer Value economics — those are 2026-onward operational concerns
// only. This is a deliberate, one-time business/data-model decision for this version of
// the app, not something that should silently recalculate every customer's eligibility if
// changed casually — hence hardcoded rather than a Settings field.
const LEGACY_CUTOFF_DATE = "2026-01-01";
// Kept intentionally separate from DB.data.meta.loyaltyEffectiveDate, which answers a
// different question (when Welcome/Journey Gift specifically became available) and stays
// staff-editable exactly as before.

// The confirmed, live, read-only endpoint on the AA Scooters Manager/booking system's
// Apps Script backend, added specifically for this app (never affects the Manager system's
// own pages or actions). GET only — this app never sends anything to it. Deployment
// verified live and returning correctly-shaped JSON before this was wired in.
const MANAGER_SYNC_URL = "https://script.google.com/macros/s/AKfycbztdtViH9qFCZ755EefaZqiZWzKK_yTOWkwaFLqZJm271wzDIVMgGoaYGFaSrd20OGsnQ/exec?action=giftTrackerRentals2026";

// Serverless bridge (this repo's own /api/loyalty.js, deployed alongside this static site on
// Vercel) that reads/writes the Customer Loyalty baseline dataset from a Google Drive folder,
// via a dedicated service account. Same-origin, relative path — works on any deployment of
// this app without editing this file. Staff-triggered only via "Refresh Loyalty Baseline from
// Cloud" in Settings; nothing here runs automatically or on a timer. Only ever touches records
// whose id starts with "imp_" (the pipeline-owned baseline) — anything added through Manager
// Sync ("mgr_r*") or the in-app "+" customer/rental forms (uid()-based ids) is never touched
// by this sync, exactly mirroring how Manager Sync itself leaves legacy history alone.
const LOYALTY_CLOUD_API_URL = "/api/loyalty";

// Premium Ride Experience / VIP Extra Day both use the same cycle mechanic: 180+ cumulative
// PAID days (an active rental counts in full — no requirement to return first) since the
// last time that specific reward was used. Lifetime paid days never reset; this does.
const PREMIUM_RIDE_MIN_PAID_DAYS = 180;

// Default financial/threshold values for the loyalty program — ALL of these are seeded
// here but the live, staff-editable copy lives in DB.data.meta (Settings). Nothing here
// should be read directly by business logic; always go through DB.data.meta.* so edits
// in Settings take effect immediately without a code change.
const DEFAULT_REWARD_COSTS = { welcomeGift: 50, journeyGift: 150 };
// Estimated daily rental value used for Premium Ride Experience (x2 days) and VIP Extra
// Day — keyed by Standardized Vehicle Category (the fine-grained Ride Upgrade tiers).
const DEFAULT_DAILY_VALUES = {
  "125cc": 300,
  "Aerox Standard Key 155cc": 400,
  "NMAX White Standard Key 155cc": 400,
  "Aerox Keyless/ABS 155cc": 450,
  "NMAX Keyless/ABS 155cc": 500,
  "Forza 300": 600,
  "XMAX 300": 800,
};
// VIP Extra Day qualification: meaningful repeat rentals + cumulative paid days, tier-aware.
const DEFAULT_VIP_THRESHOLDS = {
  "125cc": { episodes: 2, days: 20 },
  "155cc": { episodes: 2, days: 18 },
  "300cc": { episodes: 2, days: 14 },
};
// Reward-to-Revenue Loyalty Health bands (%). <= healthyMax => Healthy, <= watchMax =>
// Watch, above that => High. Initial suggested values only — meant to be tuned in Settings.
const DEFAULT_HEALTH_THRESHOLDS = { healthyMax: 8, watchMax: 15 };

const ALL_BIKE_MODELS = CATEGORY_TIERS;

// Bike Name Mapping — Original Bike Name (as it appears in historical records) -> Standardized
// Vehicle Category. This is the DEFAULT seed; the live, editable copy lives in
// DB.data.meta.bikeNameMap (Settings -> Bike Name Mapping) so it can be corrected without a
// code change. classifyBike() always reads the live copy, never this constant directly.
const DEFAULT_BIKE_NAME_MAP = {
  "aerox black": "155cc Standard Key",
  "aerox blue": "155cc Standard Key",
  "aerox cool 1": "155cc Keyless/ABS",
  "aerox cool 2": "155cc Keyless/ABS",
  "aerox cool blue 1": "155cc Keyless/ABS",
  "aerox greeen": "155cc Standard Key",
  "aerox green": "155cc Standard Key",
  "aerox red": "155cc Standard Key",
  "aerox red 1": "155cc Standard Key",
  "aerox red 2": "155cc Standard Key",
  "aerox white": "155cc Keyless/ABS",
  "cbr": "155cc Standard Key",
  "click blue": "125cc",
  "click red": "125cc",
  "cool 1": "155cc Keyless/ABS",
  "cool 2": "155cc Keyless/ABS",
  "cool 4": "155cc Keyless/ABS",
  "cool blue": "155cc Keyless/ABS",
  "cool blue 1": "155cc Keyless/ABS",
  "cool blue 2": "155cc Keyless/ABS",
  "drone": "155cc Keyless/ABS",
  "forza": "Forza 300",
  "freego black": "125cc",
  "freego red": "125cc",
  "freego white": "125cc",
  "grand filano": "125cc",
  "grand filano 2": "125cc",
  "granfilano": "125cc",
  "gt 1": "125cc",
  "gt 2": "125cc",
  "gt 3": "125cc",
  "gt 4 red": "125cc",
  "gt 5": "125cc",
  "gt 5 mint": "125cc",
  "gt black": "125cc",
  "gt black 1": "125cc",
  "gt black 2": "125cc",
  "gt black 3": "125cc",
  "gt black 4": "125cc",
  "gt black 4 )": "125cc",
  "gt black 5": "125cc",
  "gt black 6": "125cc",
  "gt burgandy": "125cc",
  "gt burgundy": "125cc",
  "gt mint": "125cc",
  "gt red": "125cc",
  "gt red 1": "125cc",
  "gt red 2": "125cc",
  "gt red 2 papaya": "125cc",
  "gt red 3": "125cc",
  "gt silver 1": "125cc",
  "gt silver 1 )": "125cc",
  "gt silver 2": "125cc",
  "gt2": "125cc",
  "mio carbu": "125cc",
  "n": "155cc Standard Key",
  "nmax": "155cc Keyless/ABS",
  "nmax black": "155cc Keyless/ABS",
  "nmax blue": "155cc Keyless/ABS",
  "nmax grey": "155cc Keyless/ABS",
  "nmax grey 1": "155cc Keyless/ABS",
  "nmax grey 2": "155cc Keyless/ABS",
  "nmax white": "155cc Standard Key",
  "rax 1": "155cc Standard Key",
  "rax 1 gold": "155cc Standard Key",
  "rax 2": "155cc Standard Key",
  "rax 3": "155cc Standard Key",
  "rax blue": "155cc Standard Key",
  "rax red": "155cc Standard Key",
  "xmax": "XMAX 300",
  "zoomer x": "125cc",
};

// Import field definitions: target schema + header aliases used to auto-guess column
// mapping when a CSV (e.g. exported from Google Sheets) is uploaded. Google Sheets is only
// ever an import/backup source here — the app's own localStorage database runs everything.
const IMPORT_SCHEMAS = {
  customers: {
    label: "Customers",
    fields: [
      { key: "name", label: "Full name", required: true, type: "text", aliases: ["name", "customer name", "full name", "customer"] },
      { key: "phone", label: "Phone", required: false, type: "text", aliases: ["phone", "phone number", "mobile", "contact", "tel"] },
      { key: "firstSeen", label: "First rental date", required: false, type: "date", aliases: ["first seen", "first rental", "joined", "date joined", "first rental date"] },
      { key: "notes", label: "Notes", required: false, type: "text", aliases: ["notes", "remark", "remarks"] },
    ],
  },
  vehicles: {
    label: "Vehicles",
    fields: [
      { key: "plate", label: "Plate number", required: true, type: "text", aliases: ["plate", "plate number", "license plate", "registration", "reg", "plate no"] },
      { key: "bikeName", label: "Bike name", required: true, type: "text", aliases: ["bike", "bike name", "name"] },
      { key: "modelYear", label: "Model year", required: false, type: "number", aliases: ["model year", "year"] },
      { key: "porRorBorExpiryDate", label: "Por Ror Bor expiry date", required: false, type: "date", aliases: ["por ror bor", "porrorbor", "prb", "por ror bor expiry", "insurance expiry", "insurance"] },
      // Tax is intentionally NOT a plain date field — the source spreadsheet may use "-"
      // (same date as Por Ror Bor) or "Not yet" (overdue, renewal pending) instead of a date.
      { key: "taxRaw", label: "Tax (date, '-', or 'Not yet')", required: false, type: "taxSpecial", aliases: ["tax", "tax expiry", "tax expiry date", "tax date", "tax renewal"] },
      { key: "renewalNote", label: "Renewal note / reason", required: false, type: "text", aliases: ["renewal note", "reason", "note", "renewal reason"] },
      { key: "currentKm", label: "Current km", required: false, type: "number", aliases: ["current km", "km", "mileage", "odometer"] },
      { key: "nextServiceKm", label: "Next service km", required: false, type: "number", aliases: ["next service km", "service km", "next service"] },
      { key: "status", label: "Vehicle status", required: false, type: "text", aliases: ["status", "vehicle status"] },
      { key: "notes", label: "Notes", required: false, type: "text", aliases: ["notes", "remark", "remarks"] },
    ],
  },
  rentals: {
    label: "Rentals",
    fields: [
      { key: "customerName", label: "Customer name", required: true, type: "text", aliases: ["customer", "customer name", "name", "renter"] },
      { key: "bikeModel", label: "Bike model", required: true, type: "text", aliases: ["bike model", "model", "bike"] },
      { key: "plate", label: "Plate number", required: false, type: "text", aliases: ["plate", "plate number"] },
      { key: "startDate", label: "Start date (handover)", required: true, type: "date", aliases: ["start date", "start", "handover date", "pickup date", "handover"] },
      { key: "endDate", label: "End date (return)", required: false, type: "date", aliases: ["end date", "end", "return date", "returned"] },
      { key: "bookedDays", label: "Booked days", required: false, type: "number", aliases: ["booked days", "booking days", "days booked"] },
      { key: "paidDays", label: "Paid / completed days", required: false, type: "number", aliases: ["paid days", "actual paid days", "completed days", "days"] },
      { key: "revenue", label: "Revenue (THB)", required: false, type: "number", aliases: ["revenue", "amount", "total", "price", "cost"] },
      { key: "status", label: "Status", required: false, type: "text", aliases: ["status"] },
    ],
  },
};

const REWARD_LABELS = {
  welcome_kit: "AA Welcome Gift",
  journey_gift: "AA Journey Gift",
  return_privilege: "Ride Upgrade",
  premium_ride: "Premium Ride Experience",
  vip_extra_day: "VIP Extra Day on Us",
};

/* ---------------------------------------------------------------------- */
/* IMPORTED CUSTOMER & LOYALTY DATA                                        */
/* Regenerated 2026-08-20 from "AA SCOOTERS Accounts 2025.xlsx" and        */
/* "AA Scooter Account 2026 3.xlsx" (the "customer" sheet of each) via     */
/* AA_Scooters_Loyalty_Program/build_loyalty.py -- name+nationality as the */
/* primary match key, loose/fuzzy name matching within a nationality, and  */
/* passport number + phone number as tie-breakers (shared value forces a   */
/* merge regardless of name spelling; conflicting value blocks an          */
/* automatic one). Phone numbers came from the 2026 workbook's 'Contract'  */
/* sheet (the 'customer' sheet itself has no phone column) where it        */
/* overlapped a 'customer' sheet row by name + start date -- coverage is   */
/* partial (47 of 442 customers), not a data gap in this import step.      */
/* Everything the matcher declined to decide automatically -- passport/    */
/* phone conflicts, unclassifiable nationality text, every near-miss name  */
/* match -- is in AA_Scooters_Loyalty_Program/loyalty_review.json, not     */
/* silently guessed at here. IMPORTED_NEEDS_REVIEW is intentionally empty  */
/* this round: that array holds a DIFFERENT, more specific kind of flag    */
/* (rental-boundary gaps, cross-customer near-duplicates) that the         */
/* previous import round had computed; re-deriving those wasn't in scope   */
/* here and re-running runDataAudit()-style boundary detection against     */
/* the new IMPORTED_RENTALS is a reasonable follow-up, not done yet.       */
/* This is real business data, not a fabricated demo set.                  */
/* ---------------------------------------------------------------------- */

const IMPORTED_CUSTOMERS = [
{"id":"imp_c1","name":"Patrick","mergedNames":[],"nationality":"Malaysia","passport":null,"phone":"","notes":"","firstSeen":"2025-02-02","source":"import"},
{"id":"imp_c2","name":"Mr. Guy-Oliver Charles","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-02-27","source":"import"},
{"id":"imp_c3","name":"Mr.Leich JR Sean Patrick","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-03-05","source":"import"},
{"id":"imp_c4","name":"Mr.Gregory Keith Woodard","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-03-06","source":"import"},
{"id":"imp_c5","name":"Mr. Kamthon Suksirithon","mergedNames":[],"nationality":"Thailand","passport":null,"phone":"","notes":"","firstSeen":"2025-03-07","source":"import"},
{"id":"imp_c6","name":"Ms. Guy-Goddard Lilian Hope","mergedNames":[],"nationality":"Australia","passport":null,"phone":"","notes":"","firstSeen":"2025-03-07","source":"import"},
{"id":"imp_c7","name":"Mr. Ye Yint aung","mergedNames":[],"nationality":"Myanmar","passport":null,"phone":"","notes":"","firstSeen":"2025-03-09","source":"import"},
{"id":"imp_c8","name":"Mr. Paul Gary Smart","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-03-10","source":"import"},
{"id":"imp_c9","name":"Mr. Peter Barabas","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-03-10","source":"import"},
{"id":"imp_c10","name":"Mr. Robert Skrobar","mergedNames":[],"nationality":"Hungary","passport":null,"phone":"","notes":"","firstSeen":"2025-03-10","source":"import"},
{"id":"imp_c11","name":"Ms. Olivia Jade Catusse","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-03-14","source":"import"},
{"id":"imp_c12","name":"Mr. Chernets Vladimir","mergedNames":[],"nationality":"Russia","passport":null,"phone":"","notes":"","firstSeen":"2025-03-15","source":"import"},
{"id":"imp_c13","name":"Mr. Charles Kaa Bach","mergedNames":[],"nationality":"Denmark","passport":null,"phone":"","notes":"","firstSeen":"2025-03-17","source":"import"},
{"id":"imp_c14","name":"Mr. Elo Silas Knight Andersen","mergedNames":[],"nationality":"Sweden","passport":null,"phone":"","notes":"","firstSeen":"2025-03-20","source":"import"},
{"id":"imp_c15","name":"Mr.Tian Haotong","mergedNames":[],"nationality":"China","passport":null,"phone":"","notes":"","firstSeen":"2025-03-20","source":"import"},
{"id":"imp_c16","name":"Mr. Ion Machis","mergedNames":[],"nationality":"Romania","passport":null,"phone":"","notes":"","firstSeen":"2025-03-22","source":"import"},
{"id":"imp_c17","name":"Ms. Lavinia-Elena Dimache","mergedNames":[],"nationality":"Romania","passport":null,"phone":"","notes":"","firstSeen":"2025-03-22","source":"import"},
{"id":"imp_c18","name":"Mr. Goffin Andre-Marie","mergedNames":[],"nationality":"Belgium","passport":null,"phone":"","notes":"","firstSeen":"2025-03-29","source":"import"},
{"id":"imp_c19","name":"Mr.Brimioulle Adrien Benoit","mergedNames":[],"nationality":"Belgium","passport":null,"phone":"","notes":"","firstSeen":"2025-03-29","source":"import"},
{"id":"imp_c20","name":"Mr. Lambert Leonard Pierre Camile","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-03-30","source":"import"},
{"id":"imp_c21","name":"Mr.Karol Lempochner","mergedNames":[],"nationality":"Slovakia","passport":null,"phone":"","notes":"","firstSeen":"2025-03-31","source":"import"},
{"id":"imp_c22","name":"Mr. Lenna Douglas Francis","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-04-01","source":"import"},
{"id":"imp_c23","name":"Mr. Jenkins Scott Laurence","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-04-03","source":"import"},
{"id":"imp_c24","name":"Mr. Warayut Prasopchokchai (Frank)","mergedNames":[],"nationality":"thai/netherland","passport":null,"phone":"","notes":"","firstSeen":"2025-04-07","source":"import"},
{"id":"imp_c25","name":"Mr. Michael Duggan ( Mike)","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-04-08","source":"import"},
{"id":"imp_c26","name":"Ms. Mita Wulandari","mergedNames":[],"nationality":"Indonesia","passport":null,"phone":"","notes":"","firstSeen":"2025-04-11","source":"import"},
{"id":"imp_c27","name":"Mr.Ozdmemir Dennis","mergedNames":[],"nationality":"Russia","passport":null,"phone":"","notes":"","firstSeen":"2025-04-12","source":"import"},
{"id":"imp_c28","name":"Mr Farat Mohammad","mergedNames":[],"nationality":"Syria","passport":null,"phone":"","notes":"","firstSeen":"2025-04-13","source":"import"},
{"id":"imp_c29","name":"Mr. Brady Joseph Philip","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-04-18","source":"import"},
{"id":"imp_c30","name":"Mr. Clement Romain","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-04-19","source":"import"},
{"id":"imp_c31","name":"Mr. Byunghee Hwang","mergedNames":[],"nationality":"South Korea","passport":null,"phone":"","notes":"","firstSeen":"2025-04-23","source":"import"},
{"id":"imp_c32","name":"Mr. Rutter Rueben Jude","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-04-24","source":"import"},
{"id":"imp_c33","name":"Mr.Daly Ethan Hunter","mergedNames":[],"nationality":"Australia","passport":null,"phone":"","notes":"","firstSeen":"2025-04-24","source":"import"},
{"id":"imp_c34","name":"Mr. Wachirawan Kewkaew","mergedNames":[],"nationality":"Thailand","passport":null,"phone":"","notes":"","firstSeen":"2025-04-27","source":"import"},
{"id":"imp_c35","name":"Mr. Kyungjik Kim (Paul)","mergedNames":["Mr. Kim Kyungjik"],"nationality":"South Korea","passport":null,"phone":"","notes":"","firstSeen":"2025-05-01","source":"import"},
{"id":"imp_c36","name":"Miss Rudder Hannah Lee","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-05-02","source":"import"},
{"id":"imp_c37","name":"Miss Farah Michele","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-05-05","source":"import"},
{"id":"imp_c38","name":"Mr. Antoni Sabate","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-05-05","source":"import"},
{"id":"imp_c39","name":"Mr. Ramahi Nael","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-05-08","source":"import"},
{"id":"imp_c40","name":"Ms. Amma","mergedNames":[],"nationality":"China","passport":null,"phone":"","notes":"","firstSeen":"2025-05-08","source":"import"},
{"id":"imp_c41","name":"Mr.  Pangilinan Julian","mergedNames":["Mr. Pangilinan Julian"],"nationality":"Philippines","passport":null,"phone":"","notes":"","firstSeen":"2025-05-09","source":"import"},
{"id":"imp_c42","name":"Mr. John Seung Yop Lee","mergedNames":[],"nationality":"Canada","passport":null,"phone":"","notes":"","firstSeen":"2025-05-12","source":"import"},
{"id":"imp_c43","name":"Mr. David Jean Albert Barthelat","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-05-13","source":"import"},
{"id":"imp_c44","name":"Mr. Warayut Prasopchokchai","mergedNames":[],"nationality":"Thailand","passport":null,"phone":"","notes":"","firstSeen":"2025-05-14","source":"import"},
{"id":"imp_c45","name":"Mr. Lashawn Antionne Amos","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-05-16","source":"import"},
{"id":"imp_c46","name":"Mr. Folkert Kerckoffs","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-05-21","source":"import"},
{"id":"imp_c47","name":"Mr. Santino Giorgio Gulino","mergedNames":[],"nationality":"Indonesia","passport":null,"phone":"","notes":"","firstSeen":"2025-05-21","source":"import"},
{"id":"imp_c48","name":"Mr. Timon Yan Jiun","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-05-21","source":"import"},
{"id":"imp_c49","name":"Miss Ding Xiaoke (Denise)","mergedNames":[],"nationality":"USA","passport":"A35767109","phone":"","notes":"","firstSeen":"2025-05-22","source":"import"},
{"id":"imp_c50","name":"Miss Texada Destini Ronna","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-05-23","source":"import"},
{"id":"imp_c51","name":"Mr. Seth David Bayram","mergedNames":[],"nationality":"United Kingdom","passport":"148449526.0","phone":"","notes":"","firstSeen":"2025-05-24","source":"import"},
{"id":"imp_c52","name":"Mr. Tiago Dias Da Silva","mergedNames":[],"nationality":"Portugal","passport":null,"phone":"","notes":"","firstSeen":"2025-05-30","source":"import"},
{"id":"imp_c53","name":"Mr. Alexander Vincent","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-06-01","source":"import"},
{"id":"imp_c54","name":"Mr. Sanguk Lee","mergedNames":[],"nationality":"South Korea","passport":null,"phone":"","notes":"","firstSeen":"2025-06-01","source":"import"},
{"id":"imp_c55","name":"wildwood brook homestay","mergedNames":[],"nationality":"Thailand","passport":null,"phone":"","notes":"","firstSeen":"2025-06-01","source":"import"},
{"id":"imp_c56","name":"Mr. Nicholas John","mergedNames":[],"nationality":"Zimbabwe","passport":null,"phone":"","notes":"","firstSeen":"2025-06-02","source":"import"},
{"id":"imp_c57","name":"Mr. Glovanni Mang","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-06-03","source":"import"},
{"id":"imp_c58","name":"Mr. Jerzy Franciszek Grzelak (Jurek)","mergedNames":[],"nationality":"Poland","passport":null,"phone":"","notes":"","firstSeen":"2025-06-04","source":"import"},
{"id":"imp_c59","name":"Mr. Almozaini Abdulaziz Salah A","mergedNames":["Mr Abdulaziz Saleh A Almozaini","Mr. Almozaini Abdulaziz Saleh A"],"nationality":"Saudi Arabia","passport":"CA99083","phone":"092 387 5545","notes":"","firstSeen":"2025-06-06","source":"import"},
{"id":"imp_c60","name":"Mr. Aaron Tinotenda Mutisi","mergedNames":[],"nationality":"New Zealand","passport":null,"phone":"","notes":"","firstSeen":"2025-06-08","source":"import"},
{"id":"imp_c61","name":"Mr. Nyi Nyi Kyaw Min","mergedNames":[],"nationality":"Myanmar","passport":"M1517342","phone":"","notes":"","firstSeen":"2025-06-08","source":"import"},
{"id":"imp_c62","name":"Mr. Paras Ladwal","mergedNames":[],"nationality":"India","passport":"Z5830384","phone":"","notes":"","firstSeen":"2025-06-10","source":"import"},
{"id":"imp_c63","name":"Mr. Stefano Vaghi","mergedNames":[],"nationality":"Italy","passport":null,"phone":"","notes":"","firstSeen":"2025-06-10","source":"import"},
{"id":"imp_c64","name":"Mr. Kit Henry Langdale","mergedNames":["Mr. Kit Henry Langale"],"nationality":"United Kingdom","passport":"135858608.0","phone":"","notes":"","firstSeen":"2025-06-13","source":"import"},
{"id":"imp_c65","name":"Mr.Simon Alain Deflesselle","mergedNames":[],"nationality":"Oman","passport":null,"phone":"","notes":"","firstSeen":"2025-06-14","source":"import"},
{"id":"imp_c66","name":"Mr. Vincent Pinot Heidemann","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-06-15","source":"import"},
{"id":"imp_c67","name":"Mr. Ahmed Abdulaziz Alnaseif","mergedNames":[],"nationality":"Saudi Arabia","passport":null,"phone":"","notes":"","firstSeen":"2025-06-17","source":"import"},
{"id":"imp_c68","name":"Ms. Liu Yi-Ting","mergedNames":[],"nationality":"Taiwan","passport":null,"phone":"","notes":"","firstSeen":"2025-06-17","source":"import"},
{"id":"imp_c69","name":"Mr. Mohammed Rizwan Bin Rafeek","mergedNames":["Mr.Mohamed Rizwan Bin Rafeek"],"nationality":"Malaysia","passport":"A71189884","phone":"","notes":"","firstSeen":"2025-06-18","source":"import"},
{"id":"imp_c70","name":"Ms. Marianne Audhuy","mergedNames":[],"nationality":"Canada","passport":null,"phone":"","notes":"","firstSeen":"2025-06-18","source":"import"},
{"id":"imp_c71","name":"Mr. Zack","mergedNames":[],"nationality":"New Zealand","passport":null,"phone":"","notes":"","firstSeen":"2025-06-19","source":"import"},
{"id":"imp_c72","name":"Mr. Maentawan Rachad Na Chiang Mai","mergedNames":[],"nationality":"Thailand","passport":null,"phone":"","notes":"","firstSeen":"2025-06-20","source":"import"},
{"id":"imp_c73","name":"Mr.Cory Joe Larsen","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-06-21","source":"import"},
{"id":"imp_c74","name":"Mr. Vladimir Popov","mergedNames":[],"nationality":"Russia","passport":null,"phone":"","notes":"","firstSeen":"2025-06-22","source":"import"},
{"id":"imp_c75","name":"Mr. Alistair Edward Carter","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-06-23","source":"import"},
{"id":"imp_c76","name":"Mr. Itamar Bluemenfeld","mergedNames":[],"nationality":"Israel","passport":null,"phone":"","notes":"","firstSeen":"2025-06-27","source":"import"},
{"id":"imp_c77","name":"Miss Ariane Chevalier","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-06-30","source":"import"},
{"id":"imp_c78","name":"Mr. Riadh Mimouni","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-07-01","source":"import"},
{"id":"imp_c79","name":"Mr.Jared Lee Strayer","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-07-01","source":"import"},
{"id":"imp_c80","name":"Mr. Lin Khant Phyo","mergedNames":[],"nationality":"Myanmar","passport":null,"phone":"","notes":"","firstSeen":"2025-07-02","source":"import"},
{"id":"imp_c81","name":"Mr. Nathan Reilly","mergedNames":[],"nationality":"Ireland","passport":null,"phone":"","notes":"","firstSeen":"2025-07-02","source":"import"},
{"id":"imp_c82","name":"Mr. Dennis Krezer","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-07-03","source":"import"},
{"id":"imp_c83","name":"Mr. Olivier Rodrigue","mergedNames":[],"nationality":"Canada","passport":null,"phone":"","notes":"","firstSeen":"2025-07-04","source":"import"},
{"id":"imp_c84","name":"Mr. Kuba Szutowicz","mergedNames":[],"nationality":"Poland","passport":null,"phone":"","notes":"","firstSeen":"2025-07-05","source":"import"},
{"id":"imp_c85","name":"Mr. Mathias Kassa Belaouchat","mergedNames":[],"nationality":"Belgium","passport":null,"phone":"","notes":"","firstSeen":"2025-07-05","source":"import"},
{"id":"imp_c86","name":"Miss. Jana Maren Kunisch","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-07-06","source":"import"},
{"id":"imp_c87","name":"Mr. David Long","mergedNames":[],"nationality":"Romania","passport":null,"phone":"","notes":"","firstSeen":"2025-07-06","source":"import"},
{"id":"imp_c88","name":"Mr. David Stepp","mergedNames":[],"nationality":"USA","passport":null,"phone":"+66 840432132","notes":"","firstSeen":"2025-07-06","source":"import"},
{"id":"imp_c89","name":"Mr. Nicholas Mario Spano","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-07-06","source":"import"},
{"id":"imp_c90","name":"Mr. Ashmon Maruthikkunnel Chacko","mergedNames":[],"nationality":"India","passport":null,"phone":"","notes":"","firstSeen":"2025-07-07","source":"import"},
{"id":"imp_c91","name":"Mr. Jerzy Teichmon","mergedNames":[],"nationality":"Russia","passport":null,"phone":"","notes":"","firstSeen":"2025-07-09","source":"import"},
{"id":"imp_c92","name":"Mr. Ryan David Lynch","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-07-09","source":"import"},
{"id":"imp_c93","name":"Miss. Camille Lang","mergedNames":[],"nationality":"Canada","passport":null,"phone":"","notes":"","firstSeen":"2025-07-11","source":"import"},
{"id":"imp_c94","name":"Mr. Randall Kim","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-07-12","source":"import"},
{"id":"imp_c95","name":"Mr. Dan Khon Aung","mergedNames":[],"nationality":"Myanmar","passport":null,"phone":"","notes":"","firstSeen":"2025-07-13","source":"import"},
{"id":"imp_c96","name":"Mr. Adam Drygalo","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-07-14","source":"import"},
{"id":"imp_c97","name":"Mr. Luis Henrique Minizoni","mergedNames":[],"nationality":"Brazil","passport":null,"phone":"","notes":"","firstSeen":"2025-07-15","source":"import"},
{"id":"imp_c98","name":"Mr. Amazir Manniez","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-07-17","source":"import"},
{"id":"imp_c99","name":"Mr. Youngseop Lee","mergedNames":[],"nationality":"South Korea","passport":null,"phone":"","notes":"","firstSeen":"2025-07-17","source":"import"},
{"id":"imp_c100","name":"Mr. John Alain Piccin","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-07-18","source":"import"},
{"id":"imp_c101","name":"Mr. Simon Anton Kurth","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-07-18","source":"import"},
{"id":"imp_c102","name":"Mr.Torsten Preub","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-07-18","source":"import"},
{"id":"imp_c103","name":"Miss Anna Egea Fornas","mergedNames":[],"nationality":"Spain","passport":null,"phone":"","notes":"","firstSeen":"2025-07-22","source":"import"},
{"id":"imp_c104","name":"Miss. Lisa Huang","mergedNames":["Miss Lisa Huang"],"nationality":"USA","passport":"567940321.0","phone":"","notes":"","firstSeen":"2025-07-22","source":"import"},
{"id":"imp_c105","name":"Mr. Tomer Levy","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-07-22","source":"import"},
{"id":"imp_c106","name":"Mr. Mehdi Marwan","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-07-24","source":"import"},
{"id":"imp_c107","name":"Mr.Michael Egon Wuchael","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-07-24","source":"import"},
{"id":"imp_c108","name":"Mr.Paul Louis Pertuet","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-07-24","source":"import"},
{"id":"imp_c109","name":"Mr. Tik Lung Ho","mergedNames":[],"nationality":"Australia","passport":"PB3662412","phone":"+61 428452266","notes":"","firstSeen":"2025-07-26","source":"import"},
{"id":"imp_c110","name":"Mr. Jorden Chudmick","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-07-27","source":"import"},
{"id":"imp_c111","name":"Mr. Benjamin Andrew Van Harten","mergedNames":["Mr.Benjamin Andrew Van Herten"],"nationality":"Canada","passport":"AB768624","phone":"","notes":"","firstSeen":"2025-07-28","source":"import"},
{"id":"imp_c112","name":"Mr. Rassam Farddoust","mergedNames":[],"nationality":"United Kingdom","passport":"525370111.0","phone":"","notes":"","firstSeen":"2025-07-28","source":"import"},
{"id":"imp_c113","name":"Mr. Kittisak Busara","mergedNames":[],"nationality":"Thailand","passport":null,"phone":"","notes":"","firstSeen":"2025-07-30","source":"import"},
{"id":"imp_c114","name":"Mr. Yeow Jia Le","mergedNames":[],"nationality":"Malaysia","passport":null,"phone":"","notes":"","firstSeen":"2025-07-30","source":"import"},
{"id":"imp_c115","name":"Mr. Byron George Edward Stevens","mergedNames":[],"nationality":"United Kingdom","passport":"136147468.0","phone":"+44 7914815910","notes":"","firstSeen":"2025-07-31","source":"import"},
{"id":"imp_c116","name":"Mr. Burak Emre Akkaya","mergedNames":[],"nationality":"Turkey","passport":null,"phone":"","notes":"","firstSeen":"2025-08-01","source":"import"},
{"id":"imp_c117","name":"Miss Aneesha M Pagaria","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-08-05","source":"import"},
{"id":"imp_c118","name":"Mr. Bob Yannieck Van Zijverden","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-08-05","source":"import"},
{"id":"imp_c119","name":"Mr. Aleksei Perov","mergedNames":[],"nationality":"Russia","passport":null,"phone":"","notes":"","firstSeen":"2025-08-10","source":"import"},
{"id":"imp_c120","name":"Miss Yang Liu (Linni)","mergedNames":["Miss . Yang Liu"],"nationality":"China","passport":"EQ0694953","phone":"","notes":"","firstSeen":"2025-08-11","source":"import"},
{"id":"imp_c121","name":"Mr. Marc Hagendijk","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-08-13","source":"import"},
{"id":"imp_c122","name":"Mr. Albert Strdrmann","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-08-17","source":"import"},
{"id":"imp_c123","name":"Mr. Zwe Htet Paing","mergedNames":[],"nationality":"Myanmar","passport":null,"phone":"","notes":"","firstSeen":"2025-08-17","source":"import"},
{"id":"imp_c124","name":"Mr. imilian Kieinle","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-08-24","source":"import"},
{"id":"imp_c125","name":"Mr. Selemon Amare Asyehegn Setaregu","mergedNames":[],"nationality":"Sweden","passport":null,"phone":"","notes":"","firstSeen":"2025-08-27","source":"import"},
{"id":"imp_c126","name":"Mr. Ismail Junior Adesine Adisa","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-08-28","source":"import"},
{"id":"imp_c127","name":"Mr. Jonas Altelbyed","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-08-28","source":"import"},
{"id":"imp_c128","name":"Mr. Yassine Tazi","mergedNames":[],"nationality":"Morocco","passport":null,"phone":"","notes":"","firstSeen":"2025-08-28","source":"import"},
{"id":"imp_c129","name":"Miss. Leila De Pril","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-08-29","source":"import"},
{"id":"imp_c130","name":"Miss. Peng Hengshi (Poly)","mergedNames":[],"nationality":"China","passport":null,"phone":"","notes":"","firstSeen":"2025-08-29","source":"import"},
{"id":"imp_c131","name":"Mr. Thomas Ricky Carmouche","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-08-29","source":"import"},
{"id":"imp_c132","name":"Mr. Benjamin Anthony Klein","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-09-01","source":"import"},
{"id":"imp_c133","name":"Mr. Graeme John Clarke","mergedNames":[],"nationality":"Australia","passport":"RA4076121","phone":"","notes":"","firstSeen":"2025-09-02","source":"import"},
{"id":"imp_c134","name":"mr. Michael Korashi","mergedNames":[],"nationality":"Australia","passport":null,"phone":"","notes":"","firstSeen":"2025-09-02","source":"import"},
{"id":"imp_c135","name":"Mr. Chong  Junrui","mergedNames":[],"nationality":"Singapore","passport":null,"phone":"","notes":"","firstSeen":"2025-09-03","source":"import"},
{"id":"imp_c136","name":"Mr. George Thomas Baxter","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-09-03","source":"import"},
{"id":"imp_c137","name":"Mr. Robert Artur Michon","mergedNames":[],"nationality":"Poland","passport":null,"phone":"","notes":"","firstSeen":"2025-09-04","source":"import"},
{"id":"imp_c138","name":"Mr. Ye Ming- Zhen ( Alvin)","mergedNames":[],"nationality":"Taiwan","passport":null,"phone":"","notes":"","firstSeen":"2025-09-04","source":"import"},
{"id":"imp_c139","name":"Miss Claire Louise Laing","mergedNames":[],"nationality":"Australia","passport":null,"phone":"","notes":"","firstSeen":"2025-09-06","source":"import"},
{"id":"imp_c140","name":"Mr. Valentin Prata","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-09-07","source":"import"},
{"id":"imp_c141","name":"Mr. John Scott Brown","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-09-08","source":"import"},
{"id":"imp_c142","name":"Mr. Christian Jay Verona","mergedNames":[],"nationality":"Philippines","passport":"P2334417C","phone":"","notes":"","firstSeen":"2025-09-09","source":"import"},
{"id":"imp_c143","name":"Mr. Bryce Michael Raney","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-09-11","source":"import"},
{"id":"imp_c144","name":"Mr. Charles Luc Leibovici","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-09-11","source":"import"},
{"id":"imp_c145","name":"Mr. Htal War  ( Franky)","mergedNames":[],"nationality":"Myanmar","passport":null,"phone":"","notes":"","firstSeen":"2025-09-11","source":"import"},
{"id":"imp_c146","name":"Mr. Essa HMY Alazmi","mergedNames":[],"nationality":"Kuwait","passport":null,"phone":"","notes":"","firstSeen":"2025-09-12","source":"import"},
{"id":"imp_c147","name":"Mr. Ramazan Uigun","mergedNames":[],"nationality":"Kazakhstan","passport":null,"phone":"","notes":"","firstSeen":"2025-09-13","source":"import"},
{"id":"imp_c148","name":"Mr. Stephane Herve Billat","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-09-13","source":"import"},
{"id":"imp_c149","name":"Miss. Yang Yu","mergedNames":[],"nationality":"China","passport":null,"phone":"","notes":"","firstSeen":"2025-09-14","source":"import"},
{"id":"imp_c150","name":"Miss. Michaela Stankova","mergedNames":[],"nationality":"Czech Republic","passport":null,"phone":"","notes":"","firstSeen":"2025-09-15","source":"import"},
{"id":"imp_c151","name":"Mr. Luis Felipe Garcia","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-09-15","source":"import"},
{"id":"imp_c152","name":"Mr.Hong Hai Chen ( Jacob)","mergedNames":[],"nationality":"Australia","passport":null,"phone":"","notes":"","firstSeen":"2025-09-17","source":"import"},
{"id":"imp_c153","name":"Mr.  Joao Carlos Belo De Silva","mergedNames":[],"nationality":"Portugal","passport":null,"phone":"","notes":"","firstSeen":"2025-09-23","source":"import"},
{"id":"imp_c154","name":"Mr. Ebubekir Yilmaz","mergedNames":[],"nationality":"Turkey","passport":"U15574681","phone":"","notes":"","firstSeen":"2025-09-26","source":"import"},
{"id":"imp_c155","name":"Mr. Silas Liam Nowlin","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-09-26","source":"import"},
{"id":"imp_c156","name":"Mr. Sagi Stolbunski","mergedNames":[],"nationality":"Israel","passport":null,"phone":"","notes":"","firstSeen":"2025-09-27","source":"import"},
{"id":"imp_c157","name":"Mr.David Lee Jimenez","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-09-27","source":"import"},
{"id":"imp_c158","name":"Mr. He Meng","mergedNames":[],"nationality":"China","passport":null,"phone":"","notes":"","firstSeen":"2025-09-29","source":"import"},
{"id":"imp_c159","name":"Mr. Nicholas Austin Sims","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-09-29","source":"import"},
{"id":"imp_c160","name":"Mr.Matthew Francis Ayres","mergedNames":[],"nationality":"Australia","passport":null,"phone":"","notes":"","firstSeen":"2025-10-01","source":"import"},
{"id":"imp_c161","name":"Mr. Anthony Decremer","mergedNames":[],"nationality":"Belgium","passport":null,"phone":"","notes":"","firstSeen":"2025-10-05","source":"import"},
{"id":"imp_c162","name":"Mr. Zackary Corbin Meyerle","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-10-07","source":"import"},
{"id":"imp_c163","name":"Mr.Louis-Marle Prud Homme Lacroix","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-10-08","source":"import"},
{"id":"imp_c164","name":"Mr. Berwin Tagdulang Tolero","mergedNames":[],"nationality":"Philippines","passport":null,"phone":"","notes":"","firstSeen":"2025-10-10","source":"import"},
{"id":"imp_c165","name":"Mr.Theo Sebastien Paul Gonzales","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-10-11","source":"import"},
{"id":"imp_c166","name":"Mr. Guerric Henri Marcel Galle","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-10-14","source":"import"},
{"id":"imp_c167","name":"Mr. Guiliaume Sauget","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-10-15","source":"import"},
{"id":"imp_c168","name":"Mr.Louis Morgan Coyne","mergedNames":[],"nationality":"Ireland","passport":null,"phone":"","notes":"","firstSeen":"2025-10-15","source":"import"},
{"id":"imp_c169","name":"Mr.Mike Vos","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-10-15","source":"import"},
{"id":"imp_c170","name":"Mr. Taekyeong Lee","mergedNames":[],"nationality":"South Korea","passport":null,"phone":"","notes":"","firstSeen":"2025-10-16","source":"import"},
{"id":"imp_c171","name":"Mr. Magnus Kristoffer Laaksonen","mergedNames":[],"nationality":"Norway","passport":null,"phone":"","notes":"","firstSeen":"2025-10-19","source":"import"},
{"id":"imp_c172","name":"Mr.Timothy Alan Igneri","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-10-19","source":"import"},
{"id":"imp_c173","name":"Mr. Rafael Castilhd Borges","mergedNames":[],"nationality":"USA","passport":"59237303.0; 592387303.0","phone":"+1 7328414585","notes":"","firstSeen":"2025-10-20","source":"import"},
{"id":"imp_c174","name":"Mr. Charles Saidler","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-10-22","source":"import"},
{"id":"imp_c175","name":"Mr. Oliver Willaim Murooch","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-10-22","source":"import"},
{"id":"imp_c176","name":"Mr. Tobias David Reuben","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-10-22","source":"import"},
{"id":"imp_c177","name":"Mr. Zak George Benario Bartfeld","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-10-22","source":"import"},
{"id":"imp_c178","name":"Mr. Youngjin Lee","mergedNames":[],"nationality":"South Korea","passport":null,"phone":"","notes":"","firstSeen":"2025-10-24","source":"import"},
{"id":"imp_c179","name":"Mr.Nicola Modari","mergedNames":[],"nationality":"Italy","passport":null,"phone":"","notes":"","firstSeen":"2025-10-27","source":"import"},
{"id":"imp_c180","name":"Mr.Yurii Braha","mergedNames":[],"nationality":"Ukraine","passport":null,"phone":"","notes":"","firstSeen":"2025-10-27","source":"import"},
{"id":"imp_c181","name":"Mr. Ben Slatter","mergedNames":[],"nationality":"United Kingdom","passport":"542613664.0","phone":"","notes":"","firstSeen":"2025-10-28","source":"import"},
{"id":"imp_c182","name":"Mr. Stefanos Kontogeorgis","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-10-28","source":"import"},
{"id":"imp_c183","name":"Mr.Thomas stanley Williams","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-10-28","source":"import"},
{"id":"imp_c184","name":"Mr.Yehonatan Maly","mergedNames":[],"nationality":"Israel","passport":"32375138.0","phone":"","notes":"","firstSeen":"2025-10-28","source":"import"},
{"id":"imp_c185","name":"Mr. Martin Christian Richter","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-10-29","source":"import"},
{"id":"imp_c186","name":"Mr.Bruce Buchan","mergedNames":[],"nationality":"Ireland","passport":null,"phone":"","notes":"","firstSeen":"2025-10-30","source":"import"},
{"id":"imp_c187","name":"Mr.Miguel Angel Cortes","mergedNames":[],"nationality":"Brazil","passport":null,"phone":"","notes":"","firstSeen":"2025-10-30","source":"import"},
{"id":"imp_c188","name":"Mr. Kauan Ventura Da Silva","mergedNames":[],"nationality":"Brazil","passport":null,"phone":"","notes":"","firstSeen":"2025-11-01","source":"import"},
{"id":"imp_c189","name":"Ms. Oceane Perrot","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-11-01","source":"import"},
{"id":"imp_c190","name":"Mr. William David Sloat","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-11-04","source":"import"},
{"id":"imp_c191","name":"Mr. Quentin Martus Paulo Gouzy","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-11-06","source":"import"},
{"id":"imp_c192","name":"Mr.Kallum Thomson (Danyela)","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-11-06","source":"import"},
{"id":"imp_c193","name":"Miss. Omerine Florie G Lannoy","mergedNames":[],"nationality":"Belgium","passport":null,"phone":"","notes":"","firstSeen":"2025-11-07","source":"import"},
{"id":"imp_c194","name":"Mr. Ezra Raiatua Keaoha Marama","mergedNames":[],"nationality":"USA","passport":"673992297.0","phone":"","notes":"","firstSeen":"2025-11-08","source":"import"},
{"id":"imp_c195","name":"Mr. Pablo Reinaldo Cosculluela","mergedNames":[],"nationality":"Spain","passport":"PAU47126","phone":"","notes":"","firstSeen":"2025-11-08","source":"import"},
{"id":"imp_c196","name":"Mr. Roberto Carlos Borja","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-11-08","source":"import"},
{"id":"imp_c197","name":"Ms. Amanda Jean Dixon","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-11-11","source":"import"},
{"id":"imp_c198","name":"Mr.Josilin Suillivan Alain Vincent","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-11-13","source":"import"},
{"id":"imp_c199","name":"Mr.Kevin Tom Antony","mergedNames":[],"nationality":"Ireland","passport":null,"phone":"","notes":"","firstSeen":"2025-11-13","source":"import"},
{"id":"imp_c200","name":"Mr. Martin Patzold","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-11-14","source":"import"},
{"id":"imp_c201","name":"Mr.Oliver Bowett","mergedNames":[],"nationality":"United Kingdom","passport":"548563810.0","phone":"","notes":"","firstSeen":"2025-11-16","source":"import"},
{"id":"imp_c202","name":"Mr. Maarten Van den Adel","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-11-18","source":"import"},
{"id":"imp_c203","name":"Mr. Cyrill Keng Yew Pang","mergedNames":["Cyrill Keng Yew Pang"],"nationality":"Netherlands","passport":"NR2277KF1","phone":"","notes":"","firstSeen":"2025-11-19","source":"import"},
{"id":"imp_c204","name":"Mr. Eric Trebing","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-11-20","source":"import"},
{"id":"imp_c205","name":"Mr. Randall Kitchener Cochrane","mergedNames":[],"nationality":"Canada","passport":null,"phone":"","notes":"","firstSeen":"2025-11-20","source":"import"},
{"id":"imp_c206","name":"Mr. Kevin Dean Callow","mergedNames":[],"nationality":"Ireland","passport":null,"phone":"","notes":"","firstSeen":"2025-11-22","source":"import"},
{"id":"imp_c207","name":"Mr. William Jonathan Butler","mergedNames":[],"nationality":"Ireland","passport":null,"phone":"","notes":"","firstSeen":"2025-11-22","source":"import"},
{"id":"imp_c208","name":"Mr. Pierre Alian Claude Picq","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-11-25","source":"import"},
{"id":"imp_c209","name":"Mr. Maximilian Olaf Maser","mergedNames":[],"nationality":"Germany","passport":"CGWHGJ7FW","phone":"","notes":"","firstSeen":"2025-11-26","source":"import"},
{"id":"imp_c210","name":"Mr. Jack Laycock","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-11-27","source":"import"},
{"id":"imp_c211","name":"Mr. Ryan Luke Connolly","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-11-27","source":"import"},
{"id":"imp_c212","name":"Mr. Charles Carson Lawler","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-11-28","source":"import"},
{"id":"imp_c213","name":"Mr. Danai Chaisan","mergedNames":[],"nationality":"Thailand","passport":null,"phone":"","notes":"","firstSeen":"2025-11-29","source":"import"},
{"id":"imp_c214","name":"Mr. Jason Seo","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-12-01","source":"import"},
{"id":"imp_c215","name":"Mr.Aldo Felicissimo De Souza Junior","mergedNames":[],"nationality":"Brazil","passport":null,"phone":"","notes":"","firstSeen":"2025-12-01","source":"import"},
{"id":"imp_c216","name":"Mr. Adam Cheshin","mergedNames":[],"nationality":"Israel","passport":null,"phone":"","notes":"","firstSeen":"2025-12-02","source":"import"},
{"id":"imp_c217","name":"Mr. Samer James Tawil","mergedNames":[],"nationality":"USA","passport":"A80956259","phone":"","notes":"","firstSeen":"2025-12-03","source":"import"},
{"id":"imp_c218","name":"Mr. er James Tawil","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2025-12-03","source":"import"},
{"id":"imp_c219","name":"Mr.Jason Kershaw","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-12-03","source":"import"},
{"id":"imp_c220","name":"Mr. Lim Peng Young","mergedNames":[],"nationality":"Malaysia","passport":null,"phone":"","notes":"","firstSeen":"2025-12-06","source":"import"},
{"id":"imp_c221","name":"Mr. Massimo Reverberi","mergedNames":[],"nationality":"Italy","passport":null,"phone":"","notes":"","firstSeen":"2025-12-07","source":"import"},
{"id":"imp_c222","name":"Mr. Raife Harvie Phoenix Godfrey","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-12-08","source":"import"},
{"id":"imp_c223","name":"Ms. Carmen Citizen Renoldi-Mateos","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-12-08","source":"import"},
{"id":"imp_c224","name":"Mr. Nikita Ovdienko","mergedNames":[],"nationality":"Russia","passport":null,"phone":"","notes":"","firstSeen":"2025-12-10","source":"import"},
{"id":"imp_c225","name":"Mr. Itai Shechter","mergedNames":[],"nationality":"Romania","passport":"62420001.0","phone":"","notes":"","firstSeen":"2025-12-11","source":"import"},
{"id":"imp_c226","name":"Mr. Patryk Jan Stefanski","mergedNames":[],"nationality":"Poland","passport":null,"phone":"","notes":"","firstSeen":"2025-12-13","source":"import"},
{"id":"imp_c227","name":"Mr. Ziyang Liu","mergedNames":[],"nationality":"China","passport":null,"phone":"","notes":"","firstSeen":"2025-12-13","source":"import"},
{"id":"imp_c228","name":"Mr. Han Paing Htet","mergedNames":[],"nationality":"Myanmar","passport":null,"phone":"","notes":"","firstSeen":"2025-12-15","source":"import"},
{"id":"imp_c229","name":"Mr. Ohanma Northito (wife uses)","mergedNames":["Mr. Ohanma Northito"],"nationality":"Japan","passport":null,"phone":"","notes":"","firstSeen":"2025-12-15","source":"import"},
{"id":"imp_c230","name":"Mr.Jeremy Aymeric","mergedNames":[],"nationality":"France","passport":null,"phone":"","notes":"","firstSeen":"2025-12-15","source":"import"},
{"id":"imp_c231","name":"Mr. Daniele Terrasi","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-12-16","source":"import"},
{"id":"imp_c232","name":"Mr. Irie Eden Marchevsky Gottlieb","mergedNames":[],"nationality":"Poland","passport":null,"phone":"","notes":"","firstSeen":"2025-12-16","source":"import"},
{"id":"imp_c233","name":"Mr. Alp Mustafa Tastah","mergedNames":[],"nationality":"Turkey","passport":null,"phone":"","notes":"","firstSeen":"2025-12-17","source":"import"},
{"id":"imp_c234","name":"Mr.Rafael Carranza Melendez","mergedNames":[],"nationality":"Spain","passport":null,"phone":"","notes":"","firstSeen":"2025-12-18","source":"import"},
{"id":"imp_c235","name":"Mr. Till Alexander Lukat","mergedNames":[],"nationality":"Germany","passport":"C3JLT9CGT","phone":"","notes":"","firstSeen":"2025-12-19","source":"import"},
{"id":"imp_c236","name":"Mr. Cody Harrison","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-12-20","source":"import"},
{"id":"imp_c237","name":"Mr. Darious Luke","mergedNames":[],"nationality":"United Kingdom","passport":"153894624.0","phone":"","notes":"","firstSeen":"2025-12-20","source":"import"},
{"id":"imp_c238","name":"Mr. Leon Moulos","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-12-20","source":"import"},
{"id":"imp_c239","name":"Mr. OR Perel","mergedNames":[],"nationality":"Israel","passport":null,"phone":"","notes":"","firstSeen":"2025-12-20","source":"import"},
{"id":"imp_c240","name":"Mr. Milind","mergedNames":[],"nationality":"India","passport":"U6090203","phone":"","notes":"","firstSeen":"2025-12-24","source":"import"},
{"id":"imp_c241","name":"Mr. Erkan Yapi","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-12-25","source":"import"},
{"id":"imp_c242","name":"Mr. Janik Andreas Felten","mergedNames":[],"nationality":"Netherlands","passport":null,"phone":"","notes":"","firstSeen":"2025-12-25","source":"import"},
{"id":"imp_c243","name":"Mr. Leroy Michael Husar","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-12-25","source":"import"},
{"id":"imp_c244","name":"Ms. Silvija Prvulovic","mergedNames":[],"nationality":"Germany","passport":null,"phone":"","notes":"","firstSeen":"2025-12-25","source":"import"},
{"id":"imp_c245","name":"Mr. Stephen Anthony Wilson","mergedNames":[],"nationality":"Ireland","passport":"135150121.0","phone":"","notes":"","firstSeen":"2025-12-26","source":"import"},
{"id":"imp_c246","name":"Mr. Fabrizio Belliere","mergedNames":[],"nationality":"Italy","passport":"YB1698961","phone":"","notes":"","firstSeen":"2025-12-28","source":"import"},
{"id":"imp_c247","name":"Mr. Karina Van Rooyen Cowell","mergedNames":["Ms.Karina Van Rooyen Cowell"],"nationality":"United Kingdom","passport":"549865971.0","phone":"+44 7983112527","notes":"","firstSeen":"2025-12-30","source":"import"},
{"id":"imp_c248","name":"Mr. Sangkyun Kim","mergedNames":[],"nationality":"South Korea","passport":null,"phone":"","notes":"","firstSeen":"2025-12-30","source":"import"},
{"id":"imp_c249","name":"Mr.Marcel Weishaupl","mergedNames":[],"nationality":"Germany","passport":"C2CTG2P0T","phone":"","notes":"","firstSeen":"2025-12-30","source":"import"},
{"id":"imp_c250","name":"Mr. Alexander Herbert Wichmann","mergedNames":[],"nationality":"Germany","passport":"C798334XN","phone":"","notes":"","firstSeen":"2025-12-31","source":"import"},
{"id":"imp_c251","name":"Ms. Natalee Jade Jenkin-Parrott","mergedNames":[],"nationality":"United Kingdom","passport":null,"phone":"","notes":"","firstSeen":"2025-12-31","source":"import"},
{"id":"imp_c252","name":"Mr. Daniel Joseph Perry","mergedNames":[],"nationality":"USA","passport":null,"phone":"","notes":"","firstSeen":"2026-01-01","source":"import"},
{"id":"imp_c253","name":"Mr. Paul Da Luz Soares","mergedNames":[],"nationality":"Portugal","passport":"CE068730","phone":"","notes":"","firstSeen":"2026-01-01","source":"import"},
{"id":"imp_c254","name":"Mr. Landry Lucas Maxence Veron","mergedNames":[],"nationality":"France","passport":"25CH11660","phone":"","notes":"","firstSeen":"2026-01-03","source":"import"},
{"id":"imp_c255","name":"Ms. Noah Rachel Whiting","mergedNames":[],"nationality":"USA","passport":"566850931.0","phone":"","notes":"","firstSeen":"2026-01-03","source":"import"},
{"id":"imp_c256","name":"Mr. Ismael Garcia Britos","mergedNames":[],"nationality":"Uruguay","passport":"D348357","phone":"","notes":"","firstSeen":"2026-01-06","source":"import"},
{"id":"imp_c257","name":"Ms. Farahnaaz Azrah Nain","mergedNames":[],"nationality":"United Kingdom","passport":"153524135.0","phone":"","notes":"","firstSeen":"2026-01-07","source":"import"},
{"id":"imp_c258","name":"Mr. Richard William Jones","mergedNames":[],"nationality":"United Kingdom","passport":"130261259.0","phone":"","notes":"","firstSeen":"2026-01-08","source":"import"},
{"id":"imp_c259","name":"Mr. Chad Milo Toner","mergedNames":[],"nationality":"USA","passport":"640279173.0","phone":"","notes":"","firstSeen":"2026-01-09","source":"import"},
{"id":"imp_c260","name":"Mr. Roberto Thawani Magwani","mergedNames":[],"nationality":"Spain","passport":"PAY068620","phone":"","notes":"","firstSeen":"2026-01-10","source":"import"},
{"id":"imp_c261","name":"Mr. Rain Pailvar","mergedNames":[],"nationality":"Estonia","passport":"KE0267018","phone":"","notes":"","firstSeen":"2026-01-13","source":"import"},
{"id":"imp_c262","name":"Mr. Emmauel Gilles Floret","mergedNames":[],"nationality":"Canada","passport":"AT600013","phone":"","notes":"","firstSeen":"2026-01-14","source":"import"},
{"id":"imp_c263","name":"Mr. Jackson Windsor Kenelm Baird","mergedNames":[],"nationality":"United Kingdom","passport":"152334677.0","phone":"","notes":"","firstSeen":"2026-01-14","source":"import"},
{"id":"imp_c264","name":"Mr. Noel Marc Marchetti","mergedNames":[],"nationality":"France","passport":"23FA28186","phone":"","notes":"","firstSeen":"2026-01-19","source":"import"},
{"id":"imp_c265","name":"Mr. Christopher Manguerra Catilago","mergedNames":[],"nationality":"Philippines","passport":"P8378588B","phone":"","notes":"","firstSeen":"2026-01-20","source":"import"},
{"id":"imp_c266","name":"Mr, Nicola Lucchini","mergedNames":[],"nationality":"Italy","passport":"YC5823135","phone":"","notes":"","firstSeen":"2026-01-21","source":"import"},
{"id":"imp_c267","name":"Ms.Shin Hye Um","mergedNames":[],"nationality":"South Korea","passport":"M14882673","phone":"","notes":"","firstSeen":"2026-01-21","source":"import"},
{"id":"imp_c268","name":"Miss. Erica Fernanda Mendonca Montes","mergedNames":[],"nationality":"Spain","passport":"XDF131276","phone":"","notes":"","firstSeen":"2026-01-22","source":"import"},
{"id":"imp_c269","name":"Miss. Nina Lea Wadl","mergedNames":[],"nationality":"Germany","passport":"CF8XJ9RR8","phone":"","notes":"","firstSeen":"2026-01-24","source":"import"},
{"id":"imp_c270","name":"Mr. Hitoshi Horio","mergedNames":[],"nationality":"Japan","passport":"TS4212191","phone":"","notes":"","firstSeen":"2026-01-30","source":"import"},
{"id":"imp_c271","name":"Mr. Hu Peng","mergedNames":[],"nationality":"China","passport":"ER0218747","phone":"","notes":"","firstSeen":"2026-01-31","source":"import"},
{"id":"imp_c272","name":"Mr. Andrey Volkov","mergedNames":["Mr Andrey Volkov"],"nationality":"Russia","passport":"550847519.0","phone":"+82 1023293395","notes":"","firstSeen":"2026-02-02","source":"import"},
{"id":"imp_c273","name":"Mr.Alistair James Mcauley","mergedNames":[],"nationality":"United Kingdom","passport":"551462569.0","phone":"","notes":"","firstSeen":"2026-02-04","source":"import"},
{"id":"imp_c274","name":"Mr.Nikola Vidovic","mergedNames":[],"nationality":"Croatia","passport":"322062365.0","phone":"","notes":"","firstSeen":"2026-02-04","source":"import"},
{"id":"imp_c275","name":"Ms. Ilona Bianca Vermeulen","mergedNames":[],"nationality":"Netherlands","passport":"NSF58DJ63","phone":"","notes":"","firstSeen":"2026-02-04","source":"import"},
{"id":"imp_c276","name":"Ms. Eda Ovet","mergedNames":[],"nationality":"Turkey","passport":"U37730017","phone":"","notes":"","firstSeen":"2026-02-07","source":"import"},
{"id":"imp_c277","name":"Mr. Andrei Matiukhin","mergedNames":[],"nationality":"Russia","passport":"66N4016478","phone":"","notes":"","firstSeen":"2026-02-08","source":"import"},
{"id":"imp_c278","name":"Mr. Florian Eicke Wedell","mergedNames":[],"nationality":"Germany","passport":"CH1HK3JX4","phone":"","notes":"","firstSeen":"2026-02-10","source":"import"},
{"id":"imp_c279","name":"Ms.Indra Lancien","mergedNames":[],"nationality":"France","passport":"25DA19739","phone":"","notes":"","firstSeen":"2026-02-10","source":"import"},
{"id":"imp_c280","name":"Mr. Shane David Moore","mergedNames":[],"nationality":"United Kingdom","passport":"560975457.0","phone":"","notes":"","firstSeen":"2026-02-11","source":"import"},
{"id":"imp_c281","name":"Ms. Abigail Nimshimri Jamang","mergedNames":[],"nationality":"India","passport":"Z6269500","phone":"","notes":"","firstSeen":"2026-02-11","source":"import"},
{"id":"imp_c282","name":"Mr. Jamie Charles Wilkes","mergedNames":[],"nationality":"United Kingdom","passport":"156625918.0","phone":"","notes":"","firstSeen":"2026-02-12","source":"import"},
{"id":"imp_c283","name":"Mr.Kartik Chandrasheker","mergedNames":[],"nationality":"India","passport":"Z4921006","phone":"","notes":"","firstSeen":"2026-02-12","source":"import"},
{"id":"imp_c284","name":"Mr. Alex John Milne","mergedNames":[],"nationality":"United Kingdom","passport":"124804604.0","phone":"","notes":"","firstSeen":"2026-02-14","source":"import"},
{"id":"imp_c285","name":"Mr. Nikolai Egorov","mergedNames":[],"nationality":"Russia","passport":"77 4891143","phone":"","notes":"","firstSeen":"2026-02-14","source":"import"},
{"id":"imp_c286","name":"Ms. Hayleigh Quigg","mergedNames":[],"nationality":"Ireland","passport":"PW0485684","phone":"","notes":"","firstSeen":"2026-02-16","source":"import"},
{"id":"imp_c287","name":"Mr. Marcin Stanislaw Solarski","mergedNames":[],"nationality":"Poland","passport":"FD5315792","phone":"","notes":"","firstSeen":"2026-02-17","source":"import"},
{"id":"imp_c288","name":"Ms. Kimi Sue Bruurema","mergedNames":[],"nationality":"USA","passport":"A76305304","phone":"+1 2069736727","notes":"","firstSeen":"2026-02-17","source":"import"},
{"id":"imp_c289","name":"Mr.Nitchakul Amborisut","mergedNames":[],"nationality":"Thailand","passport":"AC755776","phone":"","notes":"","firstSeen":"2026-02-18","source":"import"},
{"id":"imp_c290","name":"Mr. Giovanni Giorgio Calvia","mergedNames":[],"nationality":"Germany","passport":"C782RZ13R","phone":"","notes":"","firstSeen":"2026-02-19","source":"import"},
{"id":"imp_c291","name":"Mr. Ivan Zhirnov","mergedNames":[],"nationality":"Russia","passport":"76 6613703","phone":"063 797 0510","notes":"","firstSeen":"2026-02-20","source":"import"},
{"id":"imp_c292","name":"Mr. Philipp Wagner","mergedNames":[],"nationality":"Austria","passport":"U7939117","phone":"","notes":"","firstSeen":"2026-02-20","source":"import"},
{"id":"imp_c293","name":"Mr. Eris Beganovic","mergedNames":[],"nationality":"Montenegro","passport":"P937F4543","phone":"","notes":"","firstSeen":"2026-02-24","source":"import"},
{"id":"imp_c294","name":"Mr. Po Kwa Si","mergedNames":[],"nationality":"USA","passport":"552933574.0","phone":"","notes":"","firstSeen":"2026-02-26","source":"import"},
{"id":"imp_c295","name":"Mr. Alex Donnam Miller","mergedNames":[],"nationality":"USA","passport":"591737269.0","phone":"","notes":"","firstSeen":"2026-02-28","source":"import"},
{"id":"imp_c296","name":"Mr. John Adedayo Bamisaye","mergedNames":[],"nationality":"United Kingdom","passport":"156833423.0","phone":"","notes":"","firstSeen":"2026-02-28","source":"import"},
{"id":"imp_c297","name":"Ms. Johanna Johanne Moemie Delcroix","mergedNames":[],"nationality":"France","passport":"24EH87735","phone":"","notes":"","firstSeen":"2026-03-01","source":"import"},
{"id":"imp_c298","name":"Mr. Ivan Boiko","mergedNames":[],"nationality":"Russia","passport":"76 1305726","phone":"","notes":"","firstSeen":"2026-03-03","source":"import"},
{"id":"imp_c299","name":"Ms.Emma Jeanne Venus Chevreux","mergedNames":[],"nationality":"France","passport":"20DK02498","phone":"","notes":"","firstSeen":"2026-03-04","source":"import"},
{"id":"imp_c300","name":"Mr. Matias Ignacio Belmartino","mergedNames":[],"nationality":"Argentina","passport":"AAF868957","phone":"","notes":"","firstSeen":"2026-03-05","source":"import"},
{"id":"imp_c301","name":"Mr. Bartlomiej Olichwirowicz","mergedNames":[],"nationality":"Poland","passport":"FK0194944","phone":"","notes":"","firstSeen":"2026-03-07","source":"import"},
{"id":"imp_c302","name":"Mr. Justin Elihu Whiteman","mergedNames":[],"nationality":"USA","passport":"A04524172","phone":"","notes":"","firstSeen":"2026-03-10","source":"import"},
{"id":"imp_c303","name":"Mr.Peter Lopez","mergedNames":[],"nationality":"USA","passport":"567268894.0","phone":"","notes":"","firstSeen":"2026-03-10","source":"import"},
{"id":"imp_c304","name":"Mr. Florian Pontet","mergedNames":[],"nationality":"France","passport":"22HF50353","phone":"","notes":"","firstSeen":"2026-03-11","source":"import"},
{"id":"imp_c305","name":"Mr. Marcus Thomas Walter","mergedNames":[],"nationality":"Germany","passport":"C6YR2WPV6","phone":"","notes":"","firstSeen":"2026-03-11","source":"import"},
{"id":"imp_c306","name":"Mr. Robert Flipse","mergedNames":[],"nationality":"Netherlands","passport":"NWL6D33D2","phone":"","notes":"","firstSeen":"2026-03-12","source":"import"},
{"id":"imp_c307","name":"Mr. Deng Xu","mergedNames":[],"nationality":"China","passport":"EE9859121","phone":"","notes":"","firstSeen":"2026-03-13","source":"import"},
{"id":"imp_c308","name":"Ms. Hannah Sophia Lute","mergedNames":[],"nationality":"USA","passport":"A35994062","phone":"","notes":"","firstSeen":"2026-03-14","source":"import"},
{"id":"imp_c309","name":"Ms.Julie Gombart","mergedNames":[],"nationality":"Germany","passport":"C75YW4N5G","phone":"","notes":"","firstSeen":"2026-03-16","source":"import"},
{"id":"imp_c310","name":"Mr. Adomas Krunevicius","mergedNames":[],"nationality":"Lithuania","passport":"27176173.0","phone":"","notes":"","firstSeen":"2026-03-17","source":"import"},
{"id":"imp_c311","name":"Ms. Clara Paule Thiery","mergedNames":[],"nationality":"France","passport":"17C129924","phone":"","notes":"","firstSeen":"2026-03-17","source":"import"},
{"id":"imp_c312","name":"Ms. Allina Nicolis","mergedNames":[],"nationality":"Australia","passport":"PA9974396","phone":"","notes":"","firstSeen":"2026-03-18","source":"import"},
{"id":"imp_c313","name":"Mr. Dovydas Rokas","mergedNames":[],"nationality":"Lithuania","passport":"25204710.0","phone":"","notes":"","firstSeen":"2026-03-19","source":"import"},
{"id":"imp_c314","name":"Mr. Jonathan Tristan Yong Phelps","mergedNames":[],"nationality":"Australia","passport":"RA3387301","phone":"","notes":"","firstSeen":"2026-03-19","source":"import"},
{"id":"imp_c315","name":"Ms.Franziska Thinius","mergedNames":[],"nationality":"Germany","passport":"C3T4LFTCH","phone":"","notes":"","firstSeen":"2026-03-22","source":"import"},
{"id":"imp_c316","name":"Mr. Jakob Meyland","mergedNames":[],"nationality":"Denmark","passport":"216195811.0","phone":"","notes":"","firstSeen":"2026-03-23","source":"import"},
{"id":"imp_c317","name":"Mr. Valentin Paul Kainz","mergedNames":[],"nationality":"Germany","passport":"C9TNH22Y6","phone":"","notes":"","firstSeen":"2026-03-23","source":"import"},
{"id":"imp_c318","name":"Mr.Gregory Gabriel Barabas","mergedNames":[],"nationality":"France","passport":"24EH44530","phone":"","notes":"","firstSeen":"2026-03-24","source":"import"},
{"id":"imp_c319","name":"Ms. Huang Qiaoling","mergedNames":[],"nationality":"China","passport":"EK6561725","phone":"","notes":"","firstSeen":"2026-03-24","source":"import"},
{"id":"imp_c320","name":"Ms. Rebecca Louise Nunan","mergedNames":[],"nationality":"Australia","passport":"RA5999098","phone":"","notes":"","firstSeen":"2026-03-24","source":"import"},
{"id":"imp_c321","name":"Mr. Mohamed Tahar Chemaou","mergedNames":[],"nationality":"France","passport":"24ID04907","phone":"","notes":"","firstSeen":"2026-03-25","source":"import"},
{"id":"imp_c322","name":"Mr. Martinus Jeffrey Ariawan","mergedNames":[],"nationality":"Indonesia","passport":"E7276914","phone":"","notes":"","firstSeen":"2026-03-26","source":"import"},
{"id":"imp_c323","name":"Mr. Zwe Thu Rein","mergedNames":[],"nationality":"Myanmar","passport":null,"phone":"","notes":"","firstSeen":"2026-03-27","source":"import"},
{"id":"imp_c324","name":"Mr.Alhumaidi Abdulaziz Abdullah J","mergedNames":[],"nationality":"Saudi Arabia","passport":"AK04521","phone":"","notes":"","firstSeen":"2026-03-29","source":"import"},
{"id":"imp_c325","name":"Ms. Zhan Qilin (mumu)","mergedNames":[],"nationality":"China","passport":"ER4464224","phone":"","notes":"","firstSeen":"2026-03-29","source":"import"},
{"id":"imp_c326","name":"Mr. Majnheiv Sainfort","mergedNames":[],"nationality":"USA","passport":"566596767.0","phone":"","notes":"","firstSeen":"2026-03-30","source":"import"},
{"id":"imp_c327","name":"Mr. Ronald Duncan Hamilton","mergedNames":[],"nationality":"USA","passport":"564119304.0","phone":"","notes":"","firstSeen":"2026-03-30","source":"import"},
{"id":"imp_c328","name":"Ms. Erin Audrey Laramee","mergedNames":[],"nationality":"USA","passport":"A46697856","phone":"","notes":"","firstSeen":"2026-03-30","source":"import"},
{"id":"imp_c329","name":"Mr. Attis Jovan Rudolphe Bijleveld","mergedNames":["Mr Attis Jovan Rudolphe Bijleveld"],"nationality":"Switzerland","passport":"X6867671","phone":"+41 76644392","notes":"","firstSeen":"2026-03-31","source":"import"},
{"id":"imp_c330","name":"Ms.Damar Kentjana Isherwood","mergedNames":[],"nationality":"Australia","passport":"PB5721453","phone":"","notes":"","firstSeen":"2026-03-31","source":"import"},
{"id":"imp_c331","name":"Mr.Calogero Audino","mergedNames":[],"nationality":"Belgium","passport":"GA8144919","phone":"","notes":"","firstSeen":"2026-04-07","source":"import"},
{"id":"imp_c332","name":"Mr.Christian August Oellers","mergedNames":[],"nationality":"Germany","passport":"C6YR8F293","phone":"","notes":"","firstSeen":"2026-04-07","source":"import"},
{"id":"imp_c333","name":"Mr. Elliot Thomas Coates","mergedNames":[],"nationality":"United Kingdom","passport":"157675069.0","phone":"","notes":"","firstSeen":"2026-04-09","source":"import"},
{"id":"imp_c334","name":"Mr. Nicolas Vincent Parra","mergedNames":[],"nationality":"France","passport":"17EE49672","phone":"","notes":"","firstSeen":"2026-04-09","source":"import"},
{"id":"imp_c335","name":"Mr. Niklas Mulhaupt","mergedNames":[],"nationality":"Germany","passport":"C9HPZVH4N","phone":"","notes":"","firstSeen":"2026-04-09","source":"import"},
{"id":"imp_c336","name":"Mr. William Liange","mergedNames":[],"nationality":"France","passport":"23HK74225","phone":"","notes":"","firstSeen":"2026-04-09","source":"import"},
{"id":"imp_c337","name":"Mr. Liangfu Zhou","mergedNames":[],"nationality":"China","passport":"EP0522633","phone":"","notes":"","firstSeen":"2026-04-11","source":"import"},
{"id":"imp_c338","name":"Mr.Pyay Phyo OO","mergedNames":[],"nationality":"Myanmar","passport":"MF782344","phone":"","notes":"","firstSeen":"2026-04-11","source":"import"},
{"id":"imp_c339","name":"Mr.Arron David Ryan","mergedNames":[],"nationality":"United Kingdom","passport":"156305113.0","phone":"","notes":"","firstSeen":"2026-04-12","source":"import"},
{"id":"imp_c340","name":"Mr.Petro Maria Moreira Nogueira","mergedNames":[],"nationality":"Portugal","passport":"CC702234","phone":"","notes":"","firstSeen":"2026-04-15","source":"import"},
{"id":"imp_c341","name":"Mr. Ferit Yilmaz","mergedNames":[],"nationality":"Netherlands","passport":"NMDJ488L2","phone":"","notes":"","firstSeen":"2026-04-17","source":"import"},
{"id":"imp_c342","name":"Mr. Hadrien David Auguste Cazier","mergedNames":[],"nationality":"France","passport":"22HA90790","phone":"","notes":"","firstSeen":"2026-04-18","source":"import"},
{"id":"imp_c343","name":"Mr. Matcha Yasamut","mergedNames":[],"nationality":"Thailand","passport":"68011499.0","phone":"","notes":"","firstSeen":"2026-04-18","source":"import"},
{"id":"imp_c344","name":"Mr.Alexandru- Nicusor Epure","mergedNames":[],"nationality":"Romania","passport":"59430144.0","phone":"","notes":"","firstSeen":"2026-04-20","source":"import"},
{"id":"imp_c345","name":"Mr. Bo-Anthony Bogers","mergedNames":[],"nationality":"Netherlands","passport":"NWJC5F631","phone":"+31 623533442","notes":"","firstSeen":"2026-04-24","source":"import"},
{"id":"imp_c346","name":"Mr. Wai Kim Liu","mergedNames":[],"nationality":"Ireland","passport":"130907462.0","phone":"","notes":"","firstSeen":"2026-04-24","source":"import"},
{"id":"imp_c347","name":"Mr. Antonio Cascio","mergedNames":[],"nationality":"Italy","passport":"YB2375959","phone":"","notes":"","firstSeen":"2026-04-25","source":"import"},
{"id":"imp_c348","name":"Mr. Ye Changzhan","mergedNames":[],"nationality":"China","passport":"EF8645171","phone":"","notes":"","firstSeen":"2026-04-25","source":"import"},
{"id":"imp_c349","name":"Mr. Lubin Pierre Simon Jouan","mergedNames":[],"nationality":"France","passport":"23CR18642","phone":"","notes":"","firstSeen":"2026-04-26","source":"import"},
{"id":"imp_c350","name":"Mr. Teilo Henaff","mergedNames":["Mr. Telio Henaff"],"nationality":"France","passport":"22HA61086","phone":"","notes":"","firstSeen":"2026-04-26","source":"import"},
{"id":"imp_c351","name":"Miss. Juliette Guillon","mergedNames":[],"nationality":"France","passport":"26CE35197","phone":"","notes":"","firstSeen":"2026-04-27","source":"import"},
{"id":"imp_c352","name":"Miss. Yuki Nowak","mergedNames":[],"nationality":"Poland","passport":"FH3402515","phone":"","notes":"","firstSeen":"2026-04-27","source":"import"},
{"id":"imp_c353","name":"Mr. Arbind Shakya","mergedNames":[],"nationality":"Nepal","passport":"11786683.0","phone":"","notes":"","firstSeen":"2026-04-30","source":"import"},
{"id":"imp_c354","name":"Mr. Jared Anthony Shipp","mergedNames":[],"nationality":"USA","passport":"A64197281","phone":"","notes":"","firstSeen":"2026-04-30","source":"import"},
{"id":"imp_c355","name":"Mr. Alexander Vincent Torre","mergedNames":[],"nationality":"USA","passport":"A54819589","phone":"","notes":"","firstSeen":"2026-05-01","source":"import"},
{"id":"imp_c356","name":"Mr. Mylo Chante Ferrier","mergedNames":[],"nationality":"Netherlands","passport":"NS9735B46","phone":"","notes":"","firstSeen":"2026-05-01","source":"import"},
{"id":"imp_c357","name":"Mr. Luke Alexander Allsopp","mergedNames":[],"nationality":"United Kingdom","passport":"141599845.0","phone":"","notes":"","firstSeen":"2026-05-04","source":"import"},
{"id":"imp_c358","name":"Mr. Mohamed Shafiq Bin Jawead","mergedNames":[],"nationality":"Malaysia","passport":"A56690968","phone":"","notes":"","firstSeen":"2026-05-05","source":"import"},
{"id":"imp_c359","name":"Ms. Tishauna Sakeila Bailey Kennedy","mergedNames":[],"nationality":"USA","passport":"A35885926","phone":"","notes":"","firstSeen":"2026-05-05","source":"import"},
{"id":"imp_c360","name":"Mr. Lee Jer Yan","mergedNames":[],"nationality":"Malaysia","passport":"A59718774","phone":"","notes":"","firstSeen":"2026-05-06","source":"import"},
{"id":"imp_c361","name":"Mr. Yukun Chen","mergedNames":[],"nationality":"China","passport":"EM5052843","phone":"","notes":"","firstSeen":"2026-05-06","source":"import"},
{"id":"imp_c362","name":"Mrs. Angkana Bamber","mergedNames":[],"nationality":"Thailand","passport":"AC2299854","phone":"","notes":"","firstSeen":"2026-05-06","source":"import"},
{"id":"imp_c363","name":"Mr. Benjamin George Hargreves","mergedNames":[],"nationality":"United Kingdom","passport":"131767421.0","phone":"","notes":"","firstSeen":"2026-05-07","source":"import"},
{"id":"imp_c364","name":"Mr. Hugo Peyre","mergedNames":[],"nationality":"France","passport":"25AD22725","phone":"","notes":"","firstSeen":"2026-05-07","source":"import"},
{"id":"imp_c365","name":"Mr. Rohit Dayanand Nimbalkar","mergedNames":[],"nationality":"India","passport":"P8744193","phone":"","notes":"","firstSeen":"2026-05-07","source":"import"},
{"id":"imp_c366","name":"Ms. Kathryn Janine Noble","mergedNames":[],"nationality":"United Kingdom","passport":"538843570.0","phone":"","notes":"","firstSeen":"2026-05-07","source":"import"},
{"id":"imp_c367","name":"Mr. Cetin Yonca","mergedNames":[],"nationality":"Netherlands","passport":"NYCH7C9L3","phone":"","notes":"","firstSeen":"2026-05-08","source":"import"},
{"id":"imp_c368","name":"Ms. Albina Vafina","mergedNames":[],"nationality":"Russia","passport":"75 6056615","phone":"","notes":"","firstSeen":"2026-05-08","source":"import"},
{"id":"imp_c369","name":"Mr. Benjamin Lindon Smith","mergedNames":["Mr Benjamin Lindon Smith"],"nationality":"United Kingdom","passport":"130063925.0; 1300639925.0","phone":"+66 933904278","notes":"","firstSeen":"2026-05-11","source":"import"},
{"id":"imp_c370","name":"Mr.Antoine Pierre A Missuwe","mergedNames":[],"nationality":"Belgium","passport":"GC9517837","phone":"","notes":"","firstSeen":"2026-05-11","source":"import"},
{"id":"imp_c371","name":"Mr.Paul Pierre Richard Lamayle","mergedNames":[],"nationality":"France","passport":"23E141580","phone":"","notes":"","firstSeen":"2026-05-12","source":"import"},
{"id":"imp_c372","name":"Mr. Leonard Karl Zandbergen","mergedNames":[],"nationality":"Luxembourg","passport":"LC3E4C5F","phone":"","notes":"","firstSeen":"2026-05-13","source":"import"},
{"id":"imp_c373","name":"Mr. Alexandre Meira Domingues","mergedNames":[],"nationality":"Portugal","passport":"CE573797","phone":"","notes":"","firstSeen":"2026-05-18","source":"import"},
{"id":"imp_c374","name":"Mr. Marvin Meyer Lowe","mergedNames":[],"nationality":"Germany","passport":"C2CTY2RYM","phone":"","notes":"","firstSeen":"2026-05-20","source":"import"},
{"id":"imp_c375","name":"Ms.Aalyiyah Celeste Handal","mergedNames":[],"nationality":"USA","passport":"680212827.0","phone":"","notes":"","firstSeen":"2026-05-20","source":"import"},
{"id":"imp_c376","name":"Ms.Jillian Mary Fox","mergedNames":[],"nationality":"USA","passport":"A26413024","phone":"","notes":"","firstSeen":"2026-05-20","source":"import"},
{"id":"imp_c377","name":"Mr. Martin Yukang Hanley","mergedNames":[],"nationality":"Australia","passport":"PB5727481","phone":"","notes":"","firstSeen":"2026-05-21","source":"import"},
{"id":"imp_c378","name":"Mr. Art Chepra","mergedNames":[],"nationality":"USA","passport":"561145899.0","phone":"","notes":"","firstSeen":"2026-05-23","source":"import"},
{"id":"imp_c379","name":"Ms. Morgane Celine Estelle Geraudie","mergedNames":[],"nationality":"France","passport":"23EC82489","phone":"","notes":"","firstSeen":"2026-05-23","source":"import"},
{"id":"imp_c380","name":"Mr. Gregory James Spruill","mergedNames":[],"nationality":"USA","passport":"A73610335","phone":"","notes":"","firstSeen":"2026-05-25","source":"import"},
{"id":"imp_c381","name":"Mr. Riyad Bouazer","mergedNames":[],"nationality":"Canada","passport":"P216899HO","phone":"","notes":"","firstSeen":"2026-05-25","source":"import"},
{"id":"imp_c382","name":"Mr. Aldi Rama","mergedNames":[],"nationality":"Indonesia","passport":"X1681517","phone":"","notes":"","firstSeen":"2026-05-27","source":"import"},
{"id":"imp_c383","name":"Mr. Romeo Manuel Bartholomeus","mergedNames":[],"nationality":"Netherlands","passport":"NRCHRRDg","phone":"","notes":"","firstSeen":"2026-05-27","source":"import"},
{"id":"imp_c384","name":"Mr. Anthony Fusto","mergedNames":[],"nationality":"thai driving lisence","passport":"67011028.0","phone":"","notes":"","firstSeen":"2026-05-30","source":"import"},
{"id":"imp_c385","name":"Mr. Andrears Markus Kahlert","mergedNames":[],"nationality":"Germany","passport":"C293TL126","phone":"+49 16359261115","notes":"","firstSeen":"2026-05-31","source":"import"},
{"id":"imp_c386","name":"Miss. Panida Boonthep","mergedNames":[],"nationality":"Thailand","passport":"5 5505 00204 07 8","phone":"","notes":"","firstSeen":"2026-06-01","source":"import"},
{"id":"imp_c387","name":"Miss.Khalidah Erica Campbell","mergedNames":[],"nationality":"USA","passport":"A81620762","phone":"+1 8765828572","notes":"","firstSeen":"2026-06-01","source":"import"},
{"id":"imp_c388","name":"Mr. Renat Ibragimov","mergedNames":[],"nationality":"Russia","passport":"55 0101294","phone":"","notes":"","firstSeen":"2026-06-01","source":"import"},
{"id":"imp_c389","name":"Mr. Vynerfes Valerian","mergedNames":[],"nationality":"Malaysia","passport":"H55817848","phone":"","notes":"","firstSeen":"2026-06-01","source":"import"},
{"id":"imp_c390","name":"Mr. Thana Charoenkaew","mergedNames":[],"nationality":"Thailand","passport":"1 9098 02919 68 3","phone":"","notes":"","firstSeen":"2026-06-02","source":"import"},
{"id":"imp_c391","name":"Mr.Louis Dominik Peter","mergedNames":[],"nationality":"Germany","passport":"C349NVZVW","phone":"","notes":"","firstSeen":"2026-06-04","source":"import"},
{"id":"imp_c392","name":"Ms. Nicole Patrizia Dolezych","mergedNames":[],"nationality":"Germany","passport":"C5HX6W4PZ","phone":"","notes":"","firstSeen":"2026-06-04","source":"import"},
{"id":"imp_c393","name":"Mr. Nathan James Scarrott","mergedNames":[],"nationality":"United Kingdom","passport":"130986772.0","phone":"","notes":"","firstSeen":"2026-06-06","source":"import"},
{"id":"imp_c394","name":"Mr. Hugo Fragne-Benaissi","mergedNames":[],"nationality":"France","passport":"2DED33903","phone":"","notes":"","firstSeen":"2026-06-08","source":"import"},
{"id":"imp_c395","name":"Mr. Filip Rubenov Filipov","mergedNames":[],"nationality":"Bulgaria","passport":"388747303.0","phone":"","notes":"","firstSeen":"2026-06-11","source":"import"},
{"id":"imp_c396","name":"Mr. Grant Christian Inman","mergedNames":[],"nationality":"USA","passport":"A67973703","phone":"+1 7347172137","notes":"","firstSeen":"2026-06-11","source":"import"},
{"id":"imp_c397","name":"Mr.Matthew Joseph Gordon Mcmullin","mergedNames":[],"nationality":"Canada","passport":"HM490925","phone":"","notes":"","firstSeen":"2026-06-12","source":"import"},
{"id":"imp_c398","name":"Mr.Antoine Jean Allain","mergedNames":[],"nationality":"France","passport":"18HC92788","phone":"","notes":"","firstSeen":"2026-06-15","source":"import"},
{"id":"imp_c399","name":"Miss. Souad Lazar","mergedNames":[],"nationality":"France","passport":"241K82446","phone":"","notes":"","firstSeen":"2026-06-16","source":"import"},
{"id":"imp_c400","name":"Mr.Pedro Vicente Fernandes Prado","mergedNames":[],"nationality":"Brazil","passport":"GN449041","phone":"","notes":"","firstSeen":"2026-06-16","source":"import"},
{"id":"imp_c401","name":"Mr. Carlo Dominic Berry","mergedNames":["Mr Carlo Dominic Berry"],"nationality":"United Kingdom","passport":"140264192.0","phone":"+44 7539155767","notes":"","firstSeen":"2026-06-17","source":"import"},
{"id":"imp_c402","name":"Mr. Timothy David Lemkuil","mergedNames":[],"nationality":"USA","passport":"A75760861","phone":"","notes":"","firstSeen":"2026-06-17","source":"import"},
{"id":"imp_c403","name":"Mr. Nicolas Quillevere","mergedNames":[],"nationality":"France","passport":"23DD83579","phone":"+33 611362007","notes":"","firstSeen":"2026-06-18","source":"import"},
{"id":"imp_c404","name":"Mr. Kaito Otomo","mergedNames":[],"nationality":"Japan","passport":"TT2272866","phone":"","notes":"","firstSeen":"2026-06-19","source":"import"},
{"id":"imp_c405","name":"Mr. Chu Lueng Chu","mergedNames":[],"nationality":"China","passport":"H21155754","phone":"","notes":"","firstSeen":"2026-06-22","source":"import"},
{"id":"imp_c406","name":"Mr. Emilien Pierre Celestin Delecroix","mergedNames":[],"nationality":"France","passport":"26DF64313","phone":"","notes":"","firstSeen":"2026-06-23","source":"import"},
{"id":"imp_c407","name":"Mr. Harsh Bajpai","mergedNames":[],"nationality":"India","passport":"Z7069942","phone":"","notes":"","firstSeen":"2026-06-24","source":"import"},
{"id":"imp_c408","name":"Mr. Paul Anthony Dzingarov-chubb","mergedNames":[],"nationality":"United Kingdom","passport":"560942184.0","phone":"","notes":"","firstSeen":"2026-06-26","source":"import"},
{"id":"imp_c409","name":"Mr. Murtadha Ramzi Subhi Al Maroof","mergedNames":[],"nationality":"Canada","passport":"AM892474","phone":"080 822 4745","notes":"","firstSeen":"2026-06-27","source":"import"},
{"id":"imp_c410","name":"Miss. Morgane Michelle Claudia Poulain","mergedNames":[],"nationality":"France","passport":"19DK87008","phone":"","notes":"","firstSeen":"2026-06-28","source":"import"},
{"id":"imp_c411","name":"Mr. Andrew Robert Thompson","mergedNames":[],"nationality":"United Kingdom","passport":"148545865.0","phone":"","notes":"","firstSeen":"2026-06-29","source":"import"},
{"id":"imp_c412","name":"Mr. Sean Francis Brochmann","mergedNames":[],"nationality":"USA","passport":"583938186.0","phone":"+1 7027207207","notes":"","firstSeen":"2026-06-30","source":"import"},
{"id":"imp_c413","name":"Miss Jade Diana Askew","mergedNames":[],"nationality":"United Kingdom","passport":"543741665.0","phone":"+44 7738605631","notes":"","firstSeen":"2026-07-01","source":"import"},
{"id":"imp_c414","name":"Mr.Mounir Michael Chraibi","mergedNames":[],"nationality":"France","passport":"24DF20589","phone":"","notes":"","firstSeen":"2026-07-04","source":"import"},
{"id":"imp_c415","name":"Mr.Ding Hairui","mergedNames":[],"nationality":"China","passport":"EN9475837","phone":"+852 68509891","notes":"","firstSeen":"2026-07-06","source":"import"},
{"id":"imp_c416","name":"Miss. Paris Denver Senior","mergedNames":[],"nationality":"United Kingdom","passport":"154117813.0","phone":"+44 7850695392","notes":"","firstSeen":"2026-07-08","source":"import"},
{"id":"imp_c417","name":"Mr Sam Robert Kennedy","mergedNames":[],"nationality":"United Kingdom","passport":"158411204.0","phone":"+44 7961953434","notes":"","firstSeen":"2026-07-08","source":"import"},
{"id":"imp_c418","name":"Miss Yen Jen Chen","mergedNames":[],"nationality":"China","passport":"365573365.0","phone":"+886 987660669","notes":"","firstSeen":"2026-07-09","source":"import"},
{"id":"imp_c419","name":"Miss. KADILYN DEL KNIEF","mergedNames":[],"nationality":"USA","passport":"585933910.0","phone":"+1 3174807103","notes":"","firstSeen":"2026-07-11","source":"import"},
{"id":"imp_c420","name":"Mr. SCOTT ADAM KELLY","mergedNames":[],"nationality":"Australia","passport":"RB2612658","phone":"+61 438380295","notes":"","firstSeen":"2026-07-13","source":"import"},
{"id":"imp_c421","name":"Mr Zvi Gur","mergedNames":[],"nationality":"Israel","passport":"40830022.0","phone":"+972 527777188","notes":"","firstSeen":"2026-07-15","source":"import"},
{"id":"imp_c422","name":"Mr Xue Feng","mergedNames":[],"nationality":"China","passport":"EM7897341","phone":"+86 13914092609","notes":"","firstSeen":"2026-07-16","source":"import"},
{"id":"imp_c423","name":"Mr Joseph Martin","mergedNames":[],"nationality":"United Kingdom","passport":"142465661.0","phone":"+44 7736648789","notes":"","firstSeen":"2026-07-17","source":"import"},
{"id":"imp_c424","name":"Mr Amin Karimi Malekabadi","mergedNames":[],"nationality":"Brazil","passport":"GM960663","phone":"+55 21989977136","notes":"","firstSeen":"2026-07-18","source":"import"},
{"id":"imp_c425","name":"Miss Kim Kassandra Henke","mergedNames":[],"nationality":"Germany","passport":"C3MJKNYNJ","phone":"+49 15158188691","notes":"","firstSeen":"2026-07-24","source":"import"},
{"id":"imp_c426","name":"Mr Elden Campbell Wrightson","mergedNames":[],"nationality":"United Kingdom","passport":"310197319.0","phone":"+44 7853629113","notes":"","firstSeen":"2026-07-25","source":"import"},
{"id":"imp_c427","name":"Miss Charlotte Alice Genevieve Vienot","mergedNames":[],"nationality":"France","passport":"17EK461627","phone":"+33 624076231","notes":"","firstSeen":"2026-07-26","source":"import"},
{"id":"imp_c428","name":"Mr Samuel Harold Edwards","mergedNames":[],"nationality":"Australia","passport":"PB4798449","phone":"+61 422404700","notes":"","firstSeen":"2026-07-28","source":"import"},
{"id":"imp_c429","name":"Mr Yassine Zagri","mergedNames":[],"nationality":"Morocco","passport":"WR5607572","phone":"+212 655578462","notes":"","firstSeen":"2026-08-01","source":"import"},
{"id":"imp_c430","name":"Mr Omer Primo","mergedNames":[],"nationality":"Portugal","passport":"CH036942","phone":"+972 524776488","notes":"","firstSeen":"2026-08-02","source":"import"},
{"id":"imp_c431","name":"Mr Daniel Eduardo Serrati","mergedNames":[],"nationality":"Argentina","passport":"AAF538398","phone":"+54 93548562512","notes":"","firstSeen":"2026-08-05","source":"import"},
{"id":"imp_c432","name":"Mr Kangyu Li","mergedNames":[],"nationality":"China","passport":"EA5824695","phone":"+31 626036031","notes":"","firstSeen":"2026-08-06","source":"import"},
{"id":"imp_c433","name":"Mr Leonid Nakonechnyi","mergedNames":[],"nationality":"Ukraine","passport":"FL737639","phone":"+380 954845053","notes":"","firstSeen":"2026-08-06","source":"import"},
{"id":"imp_c434","name":"Mr Josep Pradas Martínez","mergedNames":[],"nationality":"Spain","passport":"PAQ841030","phone":"+34 618197136","notes":"","firstSeen":"2026-08-09","source":"import"},
{"id":"imp_c435","name":"Mr Alexander William Pearce","mergedNames":[],"nationality":"United Kingdom","passport":"557890315.0","phone":"+44 7809635869","notes":"","firstSeen":"2026-08-12","source":"import"},
{"id":"imp_c436","name":"Miss Megan Terresa Sharper","mergedNames":[],"nationality":"USA","passport":null,"phone":"+1 2252502961","notes":"","firstSeen":"2026-08-15","source":"import"},
{"id":"imp_c437","name":"Miss Liron Pasternak","mergedNames":[],"nationality":"Israel","passport":"32199732.0","phone":"+972 542553955","notes":"","firstSeen":"2026-08-17","source":"import"},
{"id":"imp_c438","name":"Mr Geoffrey Jin Scott","mergedNames":[],"nationality":"New Zealand","passport":"LM948296","phone":"+61 434818553","notes":"","firstSeen":"2026-08-17","source":"import"},
{"id":"imp_c439","name":"Mr Liam Padraic Maguire","mergedNames":[],"nationality":"Canada","passport":"OA632123","phone":"+1 8076319181","notes":"","firstSeen":"2026-08-17","source":"import"},
{"id":"imp_c440","name":"Mr Shakti Singh","mergedNames":[],"nationality":"India","passport":"ZA701297","phone":"+91 8532818447","notes":"","firstSeen":"2026-08-17","source":"import"},
{"id":"imp_c441","name":"Mr Yu Jin Lim","mergedNames":[],"nationality":"Malaysia","passport":"A58605284","phone":"","notes":"","firstSeen":"2026-08-18","source":"import"},
{"id":"imp_c442","name":"Mr Naveen Mahendran","mergedNames":[],"nationality":"","passport":"AI127772","phone":"+91 9945251801","notes":"","firstSeen":"2026-08-19","source":"import"},
];

const IMPORTED_RENTALS = [
{"id":"imp_r1","customerId":"imp_c1","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-02-02","endDate":"2025-02-10","bookedDays":8,"paidDays":8,"revenue":5700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 2"],"pendingReviewBoundary":false},
{"id":"imp_r2","customerId":"imp_c2","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2025-02-27","endDate":"2025-02-27","bookedDays":0,"paidDays":0,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 3"],"pendingReviewBoundary":false},
{"id":"imp_r3","customerId":"imp_c3","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2025-03-05","endDate":"2025-03-07","bookedDays":2,"paidDays":2,"revenue":800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 5"],"pendingReviewBoundary":false},
{"id":"imp_r4","customerId":"imp_c4","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-03-06","endDate":"2025-03-09","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 6"],"pendingReviewBoundary":false},
{"id":"imp_r5","customerId":"imp_c5","bikeModel":"Click Red","bikeNameRaw":"Click Red","plate":"","startDate":"2025-03-07","endDate":"2025-03-09","bookedDays":2,"paidDays":2,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 7"],"pendingReviewBoundary":false},
{"id":"imp_r6","customerId":"imp_c6","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2025-03-07","endDate":"2025-03-28","bookedDays":21,"paidDays":21,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 8"],"pendingReviewBoundary":false},
{"id":"imp_r7","customerId":"imp_c4","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-03-09","endDate":"2025-03-10","bookedDays":1,"paidDays":1,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 10"],"pendingReviewBoundary":false},
{"id":"imp_r8","customerId":"imp_c7","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-03-09","endDate":"2025-05-09","bookedDays":61,"paidDays":61,"revenue":6000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 9"],"pendingReviewBoundary":false},
{"id":"imp_r9","customerId":"imp_c8","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-03-10","endDate":"2025-03-16","bookedDays":6,"paidDays":6,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 11"],"pendingReviewBoundary":false},
{"id":"imp_r10","customerId":"imp_c9","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-03-10","endDate":"2025-03-22","bookedDays":12,"paidDays":12,"revenue":2650.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 12"],"pendingReviewBoundary":false},
{"id":"imp_r11","customerId":"imp_c10","bikeModel":"Click Red","bikeNameRaw":"Click Red","plate":"","startDate":"2025-03-10","endDate":"2025-03-22","bookedDays":12,"paidDays":12,"revenue":1900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 13"],"pendingReviewBoundary":false},
{"id":"imp_r12","customerId":"imp_c11","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-03-14","endDate":"2025-03-15","bookedDays":1,"paidDays":1,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 14"],"pendingReviewBoundary":false},
{"id":"imp_r13","customerId":"imp_c12","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-03-15","endDate":"2025-03-16","bookedDays":1,"paidDays":1,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 15"],"pendingReviewBoundary":false},
{"id":"imp_r14","customerId":"imp_c13","bikeModel":"Aerox Blue / change to red","bikeNameRaw":"Aerox Blue / change to red","plate":"","startDate":"2025-03-17","endDate":"2025-04-16","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 16"],"pendingReviewBoundary":false},
{"id":"imp_r15","customerId":"imp_c14","bikeModel":"N","bikeNameRaw":"N","plate":"","startDate":"2025-03-20","endDate":"2025-05-20","bookedDays":61,"paidDays":61,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 53"],"pendingReviewBoundary":false},
{"id":"imp_r16","customerId":"imp_c14","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-03-20","endDate":"2025-05-17","bookedDays":58,"paidDays":58,"revenue":6900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 17"],"pendingReviewBoundary":false},
{"id":"imp_r17","customerId":"imp_c15","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-03-20","endDate":"2025-03-22","bookedDays":2,"paidDays":2,"revenue":700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 18"],"pendingReviewBoundary":false},
{"id":"imp_r18","customerId":"imp_c16","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-03-22","endDate":"2025-03-27","bookedDays":5,"paidDays":5,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 20"],"pendingReviewBoundary":false},
{"id":"imp_r19","customerId":"imp_c17","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-03-22","endDate":"2025-03-27","bookedDays":5,"paidDays":5,"revenue":1800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 19"],"pendingReviewBoundary":false},
{"id":"imp_r20","customerId":"imp_c18","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-03-29","endDate":"2025-04-22","bookedDays":24,"paidDays":24,"revenue":2700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 21"],"pendingReviewBoundary":false},
{"id":"imp_r21","customerId":"imp_c19","bikeModel":"Click Red","bikeNameRaw":"Click Red","plate":"","startDate":"2025-03-29","endDate":"2025-04-22","bookedDays":24,"paidDays":24,"revenue":2550.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 22"],"pendingReviewBoundary":false},
{"id":"imp_r22","customerId":"imp_c20","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-03-30","endDate":"2025-04-27","bookedDays":28,"paidDays":28,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 23"],"pendingReviewBoundary":false},
{"id":"imp_r23","customerId":"imp_c21","bikeModel":"Additional helmet rent 3 day","bikeNameRaw":"Additional helmet rent 3 day","plate":"","startDate":"2025-03-31","endDate":"2025-04-03","bookedDays":3,"paidDays":3,"revenue":150.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 27"],"pendingReviewBoundary":false},
{"id":"imp_r24","customerId":"imp_c21","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-03-31","endDate":"2025-04-04","bookedDays":4,"paidDays":4,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 24"],"pendingReviewBoundary":false},
{"id":"imp_r25","customerId":"imp_c22","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-04-01","endDate":"2015-04-05","bookedDays":-3649,"paidDays":-3649,"revenue":1600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 26"],"pendingReviewBoundary":false},
{"id":"imp_r26","customerId":"imp_c23","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-04-03","endDate":"2025-04-10","bookedDays":7,"paidDays":7,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 28"],"pendingReviewBoundary":false},
{"id":"imp_r27","customerId":"imp_c24","bikeModel":"GT2","bikeNameRaw":"GT2","plate":"","startDate":"2025-04-07","endDate":"2025-04-13","bookedDays":6,"paidDays":6,"revenue":1380.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 29"],"pendingReviewBoundary":false},
{"id":"imp_r28","customerId":"imp_c25","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-04-08","endDate":"2025-06-08","bookedDays":61,"paidDays":61,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 30"],"pendingReviewBoundary":false},
{"id":"imp_r29","customerId":"imp_c26","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-04-11","endDate":"2025-04-17","bookedDays":6,"paidDays":6,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 31"],"pendingReviewBoundary":false},
{"id":"imp_r30","customerId":"imp_c27","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-04-12","endDate":"2025-04-13","bookedDays":1,"paidDays":1,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 32"],"pendingReviewBoundary":false},
{"id":"imp_r31","customerId":"imp_c28","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-04-13","endDate":"2025-04-18","bookedDays":5,"paidDays":5,"revenue":1600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 33"],"pendingReviewBoundary":false},
{"id":"imp_r32","customerId":"imp_c29","bikeModel":"GT2","bikeNameRaw":"GT2","plate":"","startDate":"2025-04-18","endDate":"2025-04-18","bookedDays":0,"paidDays":0,"revenue":200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 34"],"pendingReviewBoundary":false},
{"id":"imp_r33","customerId":"imp_c30","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-04-19","endDate":"2025-04-27","bookedDays":8,"paidDays":8,"revenue":4750.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 35"],"pendingReviewBoundary":false},
{"id":"imp_r34","customerId":"imp_c31","bikeModel":"GT red","bikeNameRaw":"GT red","plate":"","startDate":"2025-04-23","endDate":"2025-05-14","bookedDays":21,"paidDays":21,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 36"],"pendingReviewBoundary":false},
{"id":"imp_r35","customerId":"imp_c32","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-04-24","endDate":"2025-05-18","bookedDays":24,"paidDays":24,"revenue":2300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 37"],"pendingReviewBoundary":false},
{"id":"imp_r36","customerId":"imp_c33","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-04-24","endDate":"2025-05-22","bookedDays":28,"paidDays":28,"revenue":2800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 41"],"pendingReviewBoundary":false},
{"id":"imp_r37","customerId":"imp_c33","bikeModel":"Click Red","bikeNameRaw":"Click Red","plate":"","startDate":"2025-04-24","endDate":"2025-04-29","bookedDays":5,"paidDays":5,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 38"],"pendingReviewBoundary":false},
{"id":"imp_r38","customerId":"imp_c13","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-04-27","endDate":"2025-05-02","bookedDays":5,"paidDays":5,"revenue":200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 40"],"pendingReviewBoundary":false},
{"id":"imp_r39","customerId":"imp_c34","bikeModel":"GT2","bikeNameRaw":"GT2","plate":"","startDate":"2025-04-27","endDate":"2025-04-29","bookedDays":2,"paidDays":2,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 39"],"pendingReviewBoundary":false},
{"id":"imp_r40","customerId":"imp_c35","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-05-01","endDate":"2025-05-29","bookedDays":28,"paidDays":28,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 56"],"pendingReviewBoundary":false},
{"id":"imp_r41","customerId":"imp_c35","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-05-01","endDate":"2025-05-15","bookedDays":14,"paidDays":14,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 43"],"pendingReviewBoundary":false},
{"id":"imp_r42","customerId":"imp_c13","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-05-02","endDate":"2025-05-14","bookedDays":12,"paidDays":12,"revenue":1800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 44"],"pendingReviewBoundary":false},
{"id":"imp_r43","customerId":"imp_c36","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-05-02","endDate":"2025-05-05","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 45"],"pendingReviewBoundary":false},
{"id":"imp_r44","customerId":"imp_c37","bikeModel":"GT 5 mint","bikeNameRaw":"GT 5 mint","plate":"","startDate":"2025-05-05","endDate":"2025-05-08","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 46"],"pendingReviewBoundary":false},
{"id":"imp_r45","customerId":"imp_c38","bikeModel":"GT 5","bikeNameRaw":"GT 5","plate":"","startDate":"2025-05-05","endDate":"2025-05-08","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 47"],"pendingReviewBoundary":false},
{"id":"imp_r46","customerId":"imp_c39","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-05-08","endDate":"2025-06-08","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 51"],"pendingReviewBoundary":false},
{"id":"imp_r47","customerId":"imp_c40","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-05-08","endDate":"2025-05-11","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 49"],"pendingReviewBoundary":false},
{"id":"imp_r48","customerId":"imp_c7","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-05-09","endDate":"2025-06-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 48"],"pendingReviewBoundary":false},
{"id":"imp_r49","customerId":"imp_c41","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-05-09","endDate":"2025-06-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 52"],"pendingReviewBoundary":false},
{"id":"imp_r50","customerId":"imp_c42","bikeModel":"GT 5 Mint","bikeNameRaw":"GT 5 Mint","plate":"","startDate":"2025-05-12","endDate":"2025-06-12","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 54"],"pendingReviewBoundary":false},
{"id":"imp_r51","customerId":"imp_c43","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-05-13","endDate":"2025-07-13","bookedDays":61,"paidDays":61,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 87"],"pendingReviewBoundary":false},
{"id":"imp_r52","customerId":"imp_c43","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-05-13","endDate":"2025-06-13","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 55"],"pendingReviewBoundary":false},
{"id":"imp_r53","customerId":"imp_c44","bikeModel":"GT 4 Red","bikeNameRaw":"GT 4 Red","plate":"","startDate":"2025-05-14","endDate":"2025-05-22","bookedDays":8,"paidDays":8,"revenue":300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 59"],"pendingReviewBoundary":false},
{"id":"imp_r54","customerId":"imp_c44","bikeModel":"GT 4 Red","bikeNameRaw":"GT 4 Red","plate":"","startDate":"2025-05-14","endDate":"2025-05-20","bookedDays":6,"paidDays":6,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 57"],"pendingReviewBoundary":false},
{"id":"imp_r55","customerId":"imp_c45","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-05-16","endDate":"2025-05-17","bookedDays":1,"paidDays":1,"revenue":250.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 58"],"pendingReviewBoundary":false},
{"id":"imp_r56","customerId":"imp_c14","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-05-20","endDate":"2025-06-13","bookedDays":24,"paidDays":24,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 65"],"pendingReviewBoundary":false},
{"id":"imp_r57","customerId":"imp_c46","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-05-21","endDate":"2025-06-09","bookedDays":19,"paidDays":19,"revenue":1700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 62"],"pendingReviewBoundary":false},
{"id":"imp_r58","customerId":"imp_c47","bikeModel":"Rax 1 gold","bikeNameRaw":"Rax 1 gold","plate":"","startDate":"2025-05-21","endDate":"2025-05-28","bookedDays":7,"paidDays":7,"revenue":1900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 60"],"pendingReviewBoundary":false},
{"id":"imp_r59","customerId":"imp_c48","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-05-21","endDate":"2025-07-21","bookedDays":61,"paidDays":61,"revenue":5500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 101"],"pendingReviewBoundary":false},
{"id":"imp_r60","customerId":"imp_c48","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-05-21","endDate":"2025-06-21","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 61"],"pendingReviewBoundary":false},
{"id":"imp_r61","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-05-22","endDate":"2025-06-22","bookedDays":31,"paidDays":31,"revenue":350.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 68"],"pendingReviewBoundary":false},
{"id":"imp_r62","customerId":"imp_c49","bikeModel":"RAX 2 silver","bikeNameRaw":"RAX 2 silver","plate":"","startDate":"2025-05-22","endDate":"2025-05-31","bookedDays":9,"paidDays":9,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 63"],"pendingReviewBoundary":false},
{"id":"imp_r63","customerId":"imp_c50","bikeModel":"GT Red","bikeNameRaw":"GT Red","plate":"","startDate":"2025-05-23","endDate":"2025-06-08","bookedDays":16,"paidDays":16,"revenue":1700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 64"],"pendingReviewBoundary":false},
{"id":"imp_r64","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-05-24","endDate":"2025-06-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 66"],"pendingReviewBoundary":false},
{"id":"imp_r65","customerId":"imp_c52","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-05-30","endDate":"2025-06-08","bookedDays":9,"paidDays":9,"revenue":430.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 77"],"pendingReviewBoundary":false},
{"id":"imp_r66","customerId":"imp_c52","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-05-30","endDate":"2025-06-06","bookedDays":7,"paidDays":7,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 71"],"pendingReviewBoundary":false},
{"id":"imp_r67","customerId":"imp_c52","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-05-30","endDate":"2025-06-02","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 67"],"pendingReviewBoundary":false},
{"id":"imp_r68","customerId":"imp_c53","bikeModel":"GT Black","bikeNameRaw":"GT Black","plate":"","startDate":"2025-06-01","endDate":"2025-07-01","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 73"],"pendingReviewBoundary":false},
{"id":"imp_r69","customerId":"imp_c54","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-06-01","endDate":"2025-06-02","bookedDays":1,"paidDays":1,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 72"],"pendingReviewBoundary":false},
{"id":"imp_r70","customerId":"imp_c55","bikeModel":"Mio Carbu","bikeNameRaw":"Mio Carbu","plate":"","startDate":"2025-06-01","endDate":"2025-06-30","bookedDays":29,"paidDays":29,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 69"],"pendingReviewBoundary":false},
{"id":"imp_r71","customerId":"imp_c56","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-06-02","endDate":"2025-06-10","bookedDays":8,"paidDays":8,"revenue":1600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 74"],"pendingReviewBoundary":false},
{"id":"imp_r72","customerId":"imp_c57","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-06-03","endDate":"2025-06-17","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 75"],"pendingReviewBoundary":false},
{"id":"imp_r73","customerId":"imp_c58","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-06-04","endDate":"2025-06-18","bookedDays":14,"paidDays":14,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 76"],"pendingReviewBoundary":false},
{"id":"imp_r74","customerId":"imp_c59","bikeModel":"GT red","bikeNameRaw":"GT red","plate":"","startDate":"2025-06-06","endDate":"2025-06-15","bookedDays":9,"paidDays":9,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 78"],"pendingReviewBoundary":false},
{"id":"imp_r75","customerId":"imp_c25","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-06-08","endDate":"2025-07-08","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 85"],"pendingReviewBoundary":false},
{"id":"imp_r76","customerId":"imp_c60","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-06-08","endDate":"2025-06-11","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 79"],"pendingReviewBoundary":false},
{"id":"imp_r77","customerId":"imp_c61","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-06-08","endDate":"2025-06-10","bookedDays":2,"paidDays":2,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 80"],"pendingReviewBoundary":false},
{"id":"imp_r78","customerId":"imp_c35","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2025-06-09","endDate":"2025-07-09","bookedDays":30,"paidDays":30,"revenue":3850.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 82"],"pendingReviewBoundary":false},
{"id":"imp_r79","customerId":"imp_c41","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-06-09","endDate":"2025-07-09","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 81"],"pendingReviewBoundary":false},
{"id":"imp_r80","customerId":"imp_c62","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-06-10","endDate":"2025-07-10","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 84"],"pendingReviewBoundary":false},
{"id":"imp_r81","customerId":"imp_c63","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-06-10","endDate":"2025-06-12","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 83"],"pendingReviewBoundary":false},
{"id":"imp_r82","customerId":"imp_c64","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-06-13","endDate":"2025-07-04","bookedDays":21,"paidDays":21,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 86"],"pendingReviewBoundary":false},
{"id":"imp_r83","customerId":"imp_c65","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-06-14","endDate":"2025-06-16","bookedDays":2,"paidDays":2,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 88"],"pendingReviewBoundary":false},
{"id":"imp_r84","customerId":"imp_c59","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-06-15","endDate":"2025-07-16","bookedDays":31,"paidDays":31,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 89"],"pendingReviewBoundary":false},
{"id":"imp_r85","customerId":"imp_c66","bikeModel":"N","bikeNameRaw":"N","plate":"","startDate":"2025-06-15","endDate":"2025-06-22","bookedDays":7,"paidDays":7,"revenue":1700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 90"],"pendingReviewBoundary":false},
{"id":"imp_r86","customerId":"imp_c57","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-06-17","endDate":"2025-07-01","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 92"],"pendingReviewBoundary":false},
{"id":"imp_r87","customerId":"imp_c67","bikeModel":"GT red","bikeNameRaw":"GT red","plate":"","startDate":"2025-06-17","endDate":"2025-06-19","bookedDays":2,"paidDays":2,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 91"],"pendingReviewBoundary":false},
{"id":"imp_r88","customerId":"imp_c68","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-06-17","endDate":"2025-07-04","bookedDays":17,"paidDays":17,"revenue":1700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 93"],"pendingReviewBoundary":false},
{"id":"imp_r89","customerId":"imp_c69","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-06-18","endDate":"2025-06-22","bookedDays":4,"paidDays":4,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 96"],"pendingReviewBoundary":false},
{"id":"imp_r90","customerId":"imp_c70","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-06-18","endDate":"2025-06-21","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 94"],"pendingReviewBoundary":false},
{"id":"imp_r91","customerId":"imp_c71","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-06-19","endDate":"2025-06-22","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 97"],"pendingReviewBoundary":false},
{"id":"imp_r92","customerId":"imp_c72","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-06-20","endDate":"2025-06-28","bookedDays":8,"paidDays":8,"revenue":1140.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 98"],"pendingReviewBoundary":false},
{"id":"imp_r93","customerId":"imp_c73","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-06-21","endDate":"2025-07-21","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 100"],"pendingReviewBoundary":false},
{"id":"imp_r94","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-06-22","endDate":"2025-07-22","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 99"],"pendingReviewBoundary":false},
{"id":"imp_r95","customerId":"imp_c66","bikeModel":"N (extend 1 days)","bikeNameRaw":"N (extend 1 days)","plate":"","startDate":"2025-06-22","endDate":"2025-06-23","bookedDays":1,"paidDays":1,"revenue":225.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 95"],"pendingReviewBoundary":false},
{"id":"imp_r96","customerId":"imp_c74","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-06-22","endDate":"2025-06-26","bookedDays":4,"paidDays":4,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 102"],"pendingReviewBoundary":false},
{"id":"imp_r97","customerId":"imp_c61","bikeModel":"GT red","bikeNameRaw":"GT red","plate":"","startDate":"2025-06-23","endDate":"2025-06-25","bookedDays":2,"paidDays":2,"revenue":700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 103"],"pendingReviewBoundary":false},
{"id":"imp_r98","customerId":"imp_c75","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-06-23","endDate":"2025-07-03","bookedDays":10,"paidDays":10,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 106"],"pendingReviewBoundary":false},
{"id":"imp_r99","customerId":"imp_c51","bikeModel":"Aerox Red (extend 1 month)","bikeNameRaw":"Aerox Red (extend 1 month)","plate":"","startDate":"2025-06-24","endDate":"2025-07-24","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 105"],"pendingReviewBoundary":false},
{"id":"imp_r100","customerId":"imp_c76","bikeModel":"GT Red","bikeNameRaw":"GT Red","plate":"","startDate":"2025-06-27","endDate":"2025-06-30","bookedDays":3,"paidDays":3,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 107"],"pendingReviewBoundary":false},
{"id":"imp_r101","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-06-28","endDate":"2025-07-23","bookedDays":25,"paidDays":25,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 104"],"pendingReviewBoundary":false},
{"id":"imp_r102","customerId":"imp_c77","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-06-30","endDate":"2025-07-01","bookedDays":1,"paidDays":1,"revenue":200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 108"],"pendingReviewBoundary":false},
{"id":"imp_r103","customerId":"imp_c53","bikeModel":"GT Black","bikeNameRaw":"GT Black","plate":"","startDate":"2025-07-01","endDate":"2025-07-03","bookedDays":2,"paidDays":2,"revenue":200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 114"],"pendingReviewBoundary":false},
{"id":"imp_r104","customerId":"imp_c55","bikeModel":"Mio Carbu","bikeNameRaw":"Mio Carbu","plate":"","startDate":"2025-07-01","endDate":"2025-07-31","bookedDays":30,"paidDays":30,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 110"],"pendingReviewBoundary":false},
{"id":"imp_r105","customerId":"imp_c78","bikeModel":"GT Red","bikeNameRaw":"GT Red","plate":"","startDate":"2025-07-01","endDate":"2025-07-15","bookedDays":14,"paidDays":14,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 111"],"pendingReviewBoundary":false},
{"id":"imp_r106","customerId":"imp_c79","bikeModel":"Aerox cool 2","bikeNameRaw":"Aerox cool 2","plate":"","startDate":"2025-07-01","endDate":"2025-08-01","bookedDays":31,"paidDays":31,"revenue":3800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 112"],"pendingReviewBoundary":false},
{"id":"imp_r107","customerId":"imp_c80","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2025-07-02","endDate":"2025-07-04","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 115"],"pendingReviewBoundary":false},
{"id":"imp_r108","customerId":"imp_c81","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-07-02","endDate":"2025-07-09","bookedDays":7,"paidDays":7,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 113"],"pendingReviewBoundary":false},
{"id":"imp_r109","customerId":"imp_c82","bikeModel":"GT Black","bikeNameRaw":"GT Black","plate":"","startDate":"2025-07-03","endDate":"2025-07-05","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 116"],"pendingReviewBoundary":false},
{"id":"imp_r110","customerId":"imp_c83","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-07-04","endDate":"2025-08-03","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 117"],"pendingReviewBoundary":false},
{"id":"imp_r111","customerId":"imp_c84","bikeModel":"Grand filano","bikeNameRaw":"Grand filano","plate":"","startDate":"2025-07-05","endDate":"2025-07-17","bookedDays":12,"paidDays":12,"revenue":1400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 119"],"pendingReviewBoundary":false},
{"id":"imp_r112","customerId":"imp_c85","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-07-05","endDate":"2025-07-06","bookedDays":1,"paidDays":1,"revenue":200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 118"],"pendingReviewBoundary":false},
{"id":"imp_r113","customerId":"imp_c57","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-07-06","endDate":"2025-08-06","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 120"],"pendingReviewBoundary":false},
{"id":"imp_r114","customerId":"imp_c86","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-07-06","endDate":"2025-07-09","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 121"],"pendingReviewBoundary":false},
{"id":"imp_r115","customerId":"imp_c87","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-07-06","endDate":"2025-07-13","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 123"],"pendingReviewBoundary":false},
{"id":"imp_r116","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2025-07-06","endDate":"2025-10-06","bookedDays":92,"paidDays":92,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 168"],"pendingReviewBoundary":false},
{"id":"imp_r117","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2025-07-06","endDate":"2025-08-06","bookedDays":31,"paidDays":31,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 124"],"pendingReviewBoundary":false},
{"id":"imp_r118","customerId":"imp_c89","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-07-06","endDate":"2025-07-10","bookedDays":4,"paidDays":4,"revenue":1100.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 122"],"pendingReviewBoundary":false},
{"id":"imp_r119","customerId":"imp_c90","bikeModel":"GT 3 ( extend to 29 th AUG)","bikeNameRaw":"GT 3 ( extend to 29 th AUG)","plate":"","startDate":"2025-07-07","endDate":"2025-08-29","bookedDays":53,"paidDays":53,"revenue":1850.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 172"],"pendingReviewBoundary":false},
{"id":"imp_r120","customerId":"imp_c90","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-07-07","endDate":"2025-08-07","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 125"],"pendingReviewBoundary":false},
{"id":"imp_r121","customerId":"imp_c25","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-07-08","endDate":"2025-07-28","bookedDays":20,"paidDays":20,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 126"],"pendingReviewBoundary":false},
{"id":"imp_r122","customerId":"imp_c41","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-07-09","endDate":"2025-08-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 127"],"pendingReviewBoundary":false},
{"id":"imp_r123","customerId":"imp_c91","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-07-09","endDate":"2025-07-16","bookedDays":7,"paidDays":7,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 129"],"pendingReviewBoundary":false},
{"id":"imp_r124","customerId":"imp_c92","bikeModel":"Click blue","bikeNameRaw":"Click blue","plate":"","startDate":"2025-07-09","endDate":"2025-07-12","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 128"],"pendingReviewBoundary":false},
{"id":"imp_r125","customerId":"imp_c62","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-07-10","endDate":"2025-08-10","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 130"],"pendingReviewBoundary":false},
{"id":"imp_r126","customerId":"imp_c93","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-07-11","endDate":"2025-07-12","bookedDays":1,"paidDays":1,"revenue":100.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 131"],"pendingReviewBoundary":false},
{"id":"imp_r127","customerId":"imp_c94","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-07-12","endDate":"2025-07-21","bookedDays":9,"paidDays":9,"revenue":1800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 132"],"pendingReviewBoundary":false},
{"id":"imp_r128","customerId":"imp_c87","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-07-13","endDate":"2025-07-15","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 133"],"pendingReviewBoundary":false},
{"id":"imp_r129","customerId":"imp_c95","bikeModel":"Click blue","bikeNameRaw":"Click blue","plate":"","startDate":"2025-07-13","endDate":"2025-07-17","bookedDays":4,"paidDays":4,"revenue":700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 134"],"pendingReviewBoundary":false},
{"id":"imp_r130","customerId":"imp_c96","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-07-14","endDate":"2025-07-21","bookedDays":7,"paidDays":7,"revenue":1100.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 135"],"pendingReviewBoundary":false},
{"id":"imp_r131","customerId":"imp_c78","bikeModel":"GT Red","bikeNameRaw":"GT Red","plate":"","startDate":"2025-07-15","endDate":"2025-08-04","bookedDays":20,"paidDays":20,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 160"],"pendingReviewBoundary":false},
{"id":"imp_r132","customerId":"imp_c78","bikeModel":"GT Red","bikeNameRaw":"GT Red","plate":"","startDate":"2025-07-15","endDate":"2025-07-29","bookedDays":14,"paidDays":14,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 136"],"pendingReviewBoundary":false},
{"id":"imp_r133","customerId":"imp_c97","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2025-07-15","endDate":"2025-07-29","bookedDays":14,"paidDays":14,"revenue":2400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 137"],"pendingReviewBoundary":false},
{"id":"imp_r134","customerId":"imp_c98","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-07-17","endDate":"2025-08-22","bookedDays":36,"paidDays":36,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 139"],"pendingReviewBoundary":false},
{"id":"imp_r135","customerId":"imp_c99","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-07-17","endDate":"2025-07-24","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 138"],"pendingReviewBoundary":false},
{"id":"imp_r136","customerId":"imp_c100","bikeModel":"Click blue","bikeNameRaw":"Click blue","plate":"","startDate":"2025-07-18","endDate":"2025-07-20","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 140"],"pendingReviewBoundary":false},
{"id":"imp_r137","customerId":"imp_c101","bikeModel":"GT black 3","bikeNameRaw":"GT black 3","plate":"","startDate":"2025-07-18","endDate":"2025-07-20","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 142"],"pendingReviewBoundary":false},
{"id":"imp_r138","customerId":"imp_c102","bikeModel":"Grand filano","bikeNameRaw":"Grand filano","plate":"","startDate":"2025-07-18","endDate":"2025-07-24","bookedDays":6,"paidDays":6,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 143"],"pendingReviewBoundary":false},
{"id":"imp_r139","customerId":"imp_c73","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-07-21","endDate":"2025-08-21","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 146"],"pendingReviewBoundary":false},
{"id":"imp_r140","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-07-22","endDate":"2025-08-22","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 144"],"pendingReviewBoundary":false},
{"id":"imp_r141","customerId":"imp_c53","bikeModel":"GT Black 3","bikeNameRaw":"GT Black 3","plate":"","startDate":"2025-07-22","endDate":"2025-08-22","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 150"],"pendingReviewBoundary":false},
{"id":"imp_r142","customerId":"imp_c103","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-07-22","endDate":"2025-07-25","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 149"],"pendingReviewBoundary":false},
{"id":"imp_r143","customerId":"imp_c104","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-07-22","endDate":"2025-07-29","bookedDays":7,"paidDays":7,"revenue":1700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 148"],"pendingReviewBoundary":false},
{"id":"imp_r144","customerId":"imp_c105","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-07-22","endDate":"2025-07-24","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 147"],"pendingReviewBoundary":false},
{"id":"imp_r145","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-07-23","endDate":"2025-08-23","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 145"],"pendingReviewBoundary":false},
{"id":"imp_r146","customerId":"imp_c35","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-07-24","endDate":"2025-08-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 152"],"pendingReviewBoundary":false},
{"id":"imp_r147","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-07-24","endDate":"2025-08-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 151"],"pendingReviewBoundary":false},
{"id":"imp_r148","customerId":"imp_c106","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-07-24","endDate":"2025-08-19","bookedDays":26,"paidDays":26,"revenue":2300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 153"],"pendingReviewBoundary":false},
{"id":"imp_r149","customerId":"imp_c107","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-07-24","endDate":"2025-07-28","bookedDays":4,"paidDays":4,"revenue":1100.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 155"],"pendingReviewBoundary":false},
{"id":"imp_r150","customerId":"imp_c108","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-07-24","endDate":"2025-09-04","bookedDays":42,"paidDays":42,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 154"],"pendingReviewBoundary":false},
{"id":"imp_r151","customerId":"imp_c109","bikeModel":"Granfilano","bikeNameRaw":"Granfilano","plate":"","startDate":"2025-07-26","endDate":"2025-08-26","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 156"],"pendingReviewBoundary":false},
{"id":"imp_r152","customerId":"imp_c110","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2025-07-27","endDate":"2025-08-27","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 157"],"pendingReviewBoundary":false},
{"id":"imp_r153","customerId":"imp_c111","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-07-28","endDate":"2025-08-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 158"],"pendingReviewBoundary":false},
{"id":"imp_r154","customerId":"imp_c112","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-07-28","endDate":"2025-08-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 159"],"pendingReviewBoundary":false},
{"id":"imp_r155","customerId":"imp_c113","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2025-07-30","endDate":"2025-08-02","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 161"],"pendingReviewBoundary":false},
{"id":"imp_r156","customerId":"imp_c114","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-07-30","endDate":"2025-08-23","bookedDays":24,"paidDays":24,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 162"],"pendingReviewBoundary":false},
{"id":"imp_r157","customerId":"imp_c115","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-07-31","endDate":"2025-08-31","bookedDays":31,"paidDays":31,"revenue":2600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 163"],"pendingReviewBoundary":false},
{"id":"imp_r158","customerId":"imp_c55","bikeModel":"Mio Carbu","bikeNameRaw":"Mio Carbu","plate":"","startDate":"2025-08-01","endDate":"2025-08-31","bookedDays":30,"paidDays":30,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 167"],"pendingReviewBoundary":false},
{"id":"imp_r159","customerId":"imp_c116","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-08-01","endDate":"2025-09-01","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 165"],"pendingReviewBoundary":false},
{"id":"imp_r160","customerId":"imp_c83","bikeModel":"aerox cool 2","bikeNameRaw":"aerox cool 2","plate":"","startDate":"2025-08-04","endDate":"2025-08-28","bookedDays":24,"paidDays":24,"revenue":3300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 166"],"pendingReviewBoundary":false},
{"id":"imp_r161","customerId":"imp_c117","bikeModel":"GT Red","bikeNameRaw":"GT Red","plate":"","startDate":"2025-08-05","endDate":"2025-09-05","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 169"],"pendingReviewBoundary":false},
{"id":"imp_r162","customerId":"imp_c118","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-08-05","endDate":"2025-08-16","bookedDays":11,"paidDays":11,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 170"],"pendingReviewBoundary":false},
{"id":"imp_r163","customerId":"imp_c57","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-08-06","endDate":"2025-08-22","bookedDays":16,"paidDays":16,"revenue":1350.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 171"],"pendingReviewBoundary":false},
{"id":"imp_r164","customerId":"imp_c59","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2025-08-07","endDate":"2025-09-07","bookedDays":31,"paidDays":31,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 173"],"pendingReviewBoundary":false},
{"id":"imp_r165","customerId":"imp_c41","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-08-09","endDate":"2025-09-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 174"],"pendingReviewBoundary":false},
{"id":"imp_r166","customerId":"imp_c119","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-08-10","endDate":"2025-08-16","bookedDays":6,"paidDays":6,"revenue":1450.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 175"],"pendingReviewBoundary":false},
{"id":"imp_r167","customerId":"imp_c120","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2025-08-11","endDate":"2025-09-16","bookedDays":36,"paidDays":36,"revenue":3150.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 176"],"pendingReviewBoundary":false},
{"id":"imp_r168","customerId":"imp_c121","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2025-08-13","endDate":"2025-09-13","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 177"],"pendingReviewBoundary":false},
{"id":"imp_r169","customerId":"imp_c122","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-08-17","endDate":"2025-08-27","bookedDays":10,"paidDays":10,"revenue":1950.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 179"],"pendingReviewBoundary":false},
{"id":"imp_r170","customerId":"imp_c123","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-08-17","endDate":"2025-08-19","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 178"],"pendingReviewBoundary":false},
{"id":"imp_r171","customerId":"imp_c73","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-08-21","endDate":"2025-09-21","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 180"],"pendingReviewBoundary":false},
{"id":"imp_r172","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-08-22","endDate":"2025-09-22","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 181"],"pendingReviewBoundary":false},
{"id":"imp_r173","customerId":"imp_c53","bikeModel":"GT Black 3","bikeNameRaw":"GT Black 3","plate":"","startDate":"2025-08-22","endDate":"2025-09-22","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 182"],"pendingReviewBoundary":false},
{"id":"imp_r174","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-08-23","endDate":"2025-09-23","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 186"],"pendingReviewBoundary":false},
{"id":"imp_r175","customerId":"imp_c35","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-08-24","endDate":"2025-09-07","bookedDays":14,"paidDays":14,"revenue":1300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 183"],"pendingReviewBoundary":false},
{"id":"imp_r176","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-08-24","endDate":"2025-09-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 185"],"pendingReviewBoundary":false},
{"id":"imp_r177","customerId":"imp_c124","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2025-08-24","endDate":"2025-08-27","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 187"],"pendingReviewBoundary":false},
{"id":"imp_r178","customerId":"imp_c84","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-08-27","endDate":"2025-09-27","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 189"],"pendingReviewBoundary":false},
{"id":"imp_r179","customerId":"imp_c125","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-08-27","endDate":"2025-09-19","bookedDays":23,"paidDays":23,"revenue":173.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 207"],"pendingReviewBoundary":false},
{"id":"imp_r180","customerId":"imp_c125","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-08-27","endDate":"2025-09-27","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 188"],"pendingReviewBoundary":false},
{"id":"imp_r181","customerId":"imp_c111","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-08-28","endDate":"2025-09-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 184"],"pendingReviewBoundary":false},
{"id":"imp_r182","customerId":"imp_c112","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-08-28","endDate":"2025-09-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 190"],"pendingReviewBoundary":false},
{"id":"imp_r183","customerId":"imp_c126","bikeModel":"Aerox blue","bikeNameRaw":"Aerox blue","plate":"","startDate":"2025-08-28","endDate":"2025-08-31","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 192"],"pendingReviewBoundary":false},
{"id":"imp_r184","customerId":"imp_c127","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-08-28","endDate":"2025-08-31","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 191"],"pendingReviewBoundary":false},
{"id":"imp_r185","customerId":"imp_c128","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2025-08-28","endDate":"2025-08-31","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 193"],"pendingReviewBoundary":false},
{"id":"imp_r186","customerId":"imp_c129","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2025-08-29","endDate":"2025-08-31","bookedDays":2,"paidDays":2,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 194"],"pendingReviewBoundary":false},
{"id":"imp_r187","customerId":"imp_c130","bikeModel":"GT Black 1","bikeNameRaw":"GT Black 1","plate":"","startDate":"2025-08-29","endDate":"2025-09-24","bookedDays":26,"paidDays":26,"revenue":2300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 195"],"pendingReviewBoundary":false},
{"id":"imp_r188","customerId":"imp_c131","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-08-29","endDate":"2025-09-29","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 196"],"pendingReviewBoundary":false},
{"id":"imp_r189","customerId":"imp_c115","bikeModel":"Aerox blue","bikeNameRaw":"Aerox blue","plate":"","startDate":"2025-08-31","endDate":"2025-09-30","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 197"],"pendingReviewBoundary":false},
{"id":"imp_r190","customerId":"imp_c55","bikeModel":"Mio Carbu","bikeNameRaw":"Mio Carbu","plate":"","startDate":"2025-09-01","endDate":"2025-09-30","bookedDays":29,"paidDays":29,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 199"],"pendingReviewBoundary":false},
{"id":"imp_r191","customerId":"imp_c132","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-09-01","endDate":"2025-09-08","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 200"],"pendingReviewBoundary":false},
{"id":"imp_r192","customerId":"imp_c133","bikeModel":"Cool 4 (blue)","bikeNameRaw":"Cool 4 (blue)","plate":"","startDate":"2025-09-02","endDate":"2025-10-16","bookedDays":44,"paidDays":44,"revenue":2600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 246"],"pendingReviewBoundary":false},
{"id":"imp_r193","customerId":"imp_c134","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-09-02","endDate":"2025-09-14","bookedDays":12,"paidDays":12,"revenue":2100.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 201"],"pendingReviewBoundary":false},
{"id":"imp_r194","customerId":"imp_c135","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-09-03","endDate":"2025-10-14","bookedDays":41,"paidDays":41,"revenue":5600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 203"],"pendingReviewBoundary":false},
{"id":"imp_r195","customerId":"imp_c136","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2025-09-03","endDate":"2025-10-03","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 205"],"pendingReviewBoundary":false},
{"id":"imp_r196","customerId":"imp_c108","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-09-04","endDate":"2025-10-04","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 204"],"pendingReviewBoundary":false},
{"id":"imp_r197","customerId":"imp_c137","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-09-04","endDate":"2025-10-20","bookedDays":46,"paidDays":46,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 248"],"pendingReviewBoundary":false},
{"id":"imp_r198","customerId":"imp_c138","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-09-04","endDate":"2025-09-05","bookedDays":1,"paidDays":1,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 206"],"pendingReviewBoundary":false},
{"id":"imp_r199","customerId":"imp_c117","bikeModel":"GT Red","bikeNameRaw":"GT Red","plate":"","startDate":"2025-09-05","endDate":"2025-10-05","bookedDays":30,"paidDays":30,"revenue":2650.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 208"],"pendingReviewBoundary":false},
{"id":"imp_r200","customerId":"imp_c139","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-09-06","endDate":"2025-09-10","bookedDays":4,"paidDays":4,"revenue":750.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 209"],"pendingReviewBoundary":false},
{"id":"imp_r201","customerId":"imp_c59","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2025-09-07","endDate":"2025-10-07","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 210"],"pendingReviewBoundary":false},
{"id":"imp_r202","customerId":"imp_c140","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-09-07","endDate":"2025-09-24","bookedDays":17,"paidDays":17,"revenue":2200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 202"],"pendingReviewBoundary":false},
{"id":"imp_r203","customerId":"imp_c141","bikeModel":"Click blue","bikeNameRaw":"Click blue","plate":"","startDate":"2025-09-08","endDate":"2025-10-09","bookedDays":31,"paidDays":31,"revenue":2600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 212"],"pendingReviewBoundary":false},
{"id":"imp_r204","customerId":"imp_c41","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-09-09","endDate":"2025-10-09","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 211"],"pendingReviewBoundary":false},
{"id":"imp_r205","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-09-09","endDate":"2025-11-09","bookedDays":61,"paidDays":61,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 251"],"pendingReviewBoundary":false},
{"id":"imp_r206","customerId":"imp_c109","bikeModel":"Granfilano","bikeNameRaw":"Granfilano","plate":"","startDate":"2025-09-11","endDate":"2025-10-11","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 216"],"pendingReviewBoundary":false},
{"id":"imp_r207","customerId":"imp_c143","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-09-11","endDate":"2025-09-15","bookedDays":4,"paidDays":4,"revenue":700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 214"],"pendingReviewBoundary":false},
{"id":"imp_r208","customerId":"imp_c144","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2025-09-11","endDate":"2025-10-11","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 213"],"pendingReviewBoundary":false},
{"id":"imp_r209","customerId":"imp_c145","bikeModel":"GT black 3","bikeNameRaw":"GT black 3","plate":"","startDate":"2025-09-11","endDate":"2025-09-13","bookedDays":2,"paidDays":2,"revenue":460.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 215"],"pendingReviewBoundary":false},
{"id":"imp_r210","customerId":"imp_c146","bikeModel":"GT Red 3","bikeNameRaw":"GT Red 3","plate":"","startDate":"2025-09-12","endDate":"2025-09-14","bookedDays":2,"paidDays":2,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 217"],"pendingReviewBoundary":false},
{"id":"imp_r211","customerId":"imp_c147","bikeModel":"GT black 3","bikeNameRaw":"GT black 3","plate":"","startDate":"2025-09-13","endDate":"2025-09-15","bookedDays":2,"paidDays":2,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 219"],"pendingReviewBoundary":false},
{"id":"imp_r212","customerId":"imp_c148","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-09-13","endDate":"2025-10-19","bookedDays":36,"paidDays":36,"revenue":500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 258"],"pendingReviewBoundary":false},
{"id":"imp_r213","customerId":"imp_c148","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-09-13","endDate":"2025-10-13","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 218"],"pendingReviewBoundary":false},
{"id":"imp_r214","customerId":"imp_c149","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2025-09-14","endDate":"2025-10-26","bookedDays":42,"paidDays":42,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 220"],"pendingReviewBoundary":false},
{"id":"imp_r215","customerId":"imp_c150","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-09-15","endDate":"2025-09-18","bookedDays":3,"paidDays":3,"revenue":0.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 222"],"pendingReviewBoundary":false},
{"id":"imp_r216","customerId":"imp_c151","bikeModel":"GT silver 2","bikeNameRaw":"GT silver 2","plate":"","startDate":"2025-09-15","endDate":"2025-10-15","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 221"],"pendingReviewBoundary":false},
{"id":"imp_r217","customerId":"imp_c25","bikeModel":"GT Red 2","bikeNameRaw":"GT Red 2","plate":"","startDate":"2025-09-16","endDate":"2025-10-16","bookedDays":30,"paidDays":30,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 224"],"pendingReviewBoundary":false},
{"id":"imp_r218","customerId":"imp_c152","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-09-17","endDate":"2025-09-24","bookedDays":7,"paidDays":7,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 223"],"pendingReviewBoundary":false},
{"id":"imp_r219","customerId":"imp_c73","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-09-21","endDate":"2025-10-21","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 225"],"pendingReviewBoundary":false},
{"id":"imp_r220","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-09-22","endDate":"2025-10-22","bookedDays":30,"paidDays":30,"revenue":5200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 226"],"pendingReviewBoundary":false},
{"id":"imp_r221","customerId":"imp_c53","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-09-22","endDate":"2025-10-22","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 228"],"pendingReviewBoundary":false},
{"id":"imp_r222","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-09-23","endDate":"2025-10-23","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 227"],"pendingReviewBoundary":false},
{"id":"imp_r223","customerId":"imp_c153","bikeModel":"Aerox Greeen","bikeNameRaw":"Aerox Greeen","plate":"","startDate":"2025-09-23","endDate":"2025-09-27","bookedDays":4,"paidDays":4,"revenue":1300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 229"],"pendingReviewBoundary":false},
{"id":"imp_r224","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-09-24","endDate":"2025-10-24","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 230"],"pendingReviewBoundary":false},
{"id":"imp_r225","customerId":"imp_c59","bikeModel":"Cool 4","bikeNameRaw":"Cool 4","plate":"","startDate":"2025-09-26","endDate":"2025-09-30","bookedDays":4,"paidDays":4,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 232"],"pendingReviewBoundary":false},
{"id":"imp_r226","customerId":"imp_c154","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-09-26","endDate":"2025-10-26","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 233"],"pendingReviewBoundary":false},
{"id":"imp_r227","customerId":"imp_c155","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-09-26","endDate":"2025-10-10","bookedDays":14,"paidDays":14,"revenue":1800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 234"],"pendingReviewBoundary":false},
{"id":"imp_r228","customerId":"imp_c84","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-09-27","endDate":"2025-10-27","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 236"],"pendingReviewBoundary":false},
{"id":"imp_r229","customerId":"imp_c156","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-09-27","endDate":"2025-10-03","bookedDays":6,"paidDays":6,"revenue":1300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 238"],"pendingReviewBoundary":false},
{"id":"imp_r230","customerId":"imp_c157","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-09-27","endDate":"2025-10-04","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 237"],"pendingReviewBoundary":false},
{"id":"imp_r231","customerId":"imp_c112","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-09-28","endDate":"2025-10-28","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 235"],"pendingReviewBoundary":false},
{"id":"imp_r232","customerId":"imp_c131","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-09-29","endDate":"2025-10-25","bookedDays":26,"paidDays":26,"revenue":2300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 242"],"pendingReviewBoundary":false},
{"id":"imp_r233","customerId":"imp_c158","bikeModel":"GT black 3","bikeNameRaw":"GT black 3","plate":"","startDate":"2025-09-29","endDate":"2025-10-06","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 241"],"pendingReviewBoundary":false},
{"id":"imp_r234","customerId":"imp_c159","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-09-29","endDate":"2025-09-29","bookedDays":0,"paidDays":0,"revenue":250.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 240"],"pendingReviewBoundary":false},
{"id":"imp_r235","customerId":"imp_c159","bikeModel":"CBR","bikeNameRaw":"CBR","plate":"","startDate":"2025-09-29","endDate":"2025-09-29","bookedDays":0,"paidDays":0,"revenue":0.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 239"],"pendingReviewBoundary":false},
{"id":"imp_r236","customerId":"imp_c115","bikeModel":"Cool 3","bikeNameRaw":"Cool 3","plate":"","startDate":"2025-09-30","endDate":"2025-10-30","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 243"],"pendingReviewBoundary":false},
{"id":"imp_r237","customerId":"imp_c160","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-10-01","endDate":"2025-10-30","bookedDays":29,"paidDays":29,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 245"],"pendingReviewBoundary":false},
{"id":"imp_r238","customerId":"imp_c136","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2025-10-03","endDate":"2025-11-03","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 247"],"pendingReviewBoundary":false},
{"id":"imp_r239","customerId":"imp_c108","bikeModel":"GT 1","bikeNameRaw":"GT 1","plate":"","startDate":"2025-10-04","endDate":"2025-10-25","bookedDays":21,"paidDays":21,"revenue":1900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 231"],"pendingReviewBoundary":false},
{"id":"imp_r240","customerId":"imp_c161","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2025-10-05","endDate":"2025-10-14","bookedDays":9,"paidDays":9,"revenue":1150.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 249"],"pendingReviewBoundary":false},
{"id":"imp_r241","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2025-10-06","endDate":"2025-11-06","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 250"],"pendingReviewBoundary":false},
{"id":"imp_r242","customerId":"imp_c162","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-10-07","endDate":"2025-11-06","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 252"],"pendingReviewBoundary":false},
{"id":"imp_r243","customerId":"imp_c163","bikeModel":"GT Black 3","bikeNameRaw":"GT Black 3","plate":"","startDate":"2025-10-08","endDate":"2025-10-13","bookedDays":5,"paidDays":5,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 253"],"pendingReviewBoundary":false},
{"id":"imp_r244","customerId":"imp_c111","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-10-10","endDate":"2025-11-10","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 255"],"pendingReviewBoundary":false},
{"id":"imp_r245","customerId":"imp_c164","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2025-10-10","endDate":"2025-10-28","bookedDays":18,"paidDays":18,"revenue":1900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 254"],"pendingReviewBoundary":false},
{"id":"imp_r246","customerId":"imp_c109","bikeModel":"Granfilano","bikeNameRaw":"Granfilano","plate":"","startDate":"2025-10-11","endDate":"2025-11-11","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 257"],"pendingReviewBoundary":false},
{"id":"imp_r247","customerId":"imp_c144","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-10-11","endDate":"2025-10-30","bookedDays":19,"paidDays":19,"revenue":1950.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 267"],"pendingReviewBoundary":false},
{"id":"imp_r248","customerId":"imp_c165","bikeModel":"GT Black 1","bikeNameRaw":"GT Black 1","plate":"","startDate":"2025-10-11","endDate":"2025-11-11","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 256"],"pendingReviewBoundary":false},
{"id":"imp_r249","customerId":"imp_c59","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2025-10-13","endDate":"2025-11-13","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 259"],"pendingReviewBoundary":false},
{"id":"imp_r250","customerId":"imp_c166","bikeModel":"GT black 3","bikeNameRaw":"GT black 3","plate":"","startDate":"2025-10-14","endDate":"2025-10-28","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 260"],"pendingReviewBoundary":false},
{"id":"imp_r251","customerId":"imp_c167","bikeModel":"Click blue","bikeNameRaw":"Click blue","plate":"","startDate":"2025-10-15","endDate":"2025-11-15","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 263"],"pendingReviewBoundary":false},
{"id":"imp_r252","customerId":"imp_c168","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2025-10-15","endDate":"2025-10-16","bookedDays":1,"paidDays":1,"revenue":200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 262"],"pendingReviewBoundary":false},
{"id":"imp_r253","customerId":"imp_c169","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2025-10-15","endDate":"2025-10-22","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 261"],"pendingReviewBoundary":false},
{"id":"imp_r254","customerId":"imp_c25","bikeModel":"GT Red 2","bikeNameRaw":"GT Red 2","plate":"","startDate":"2025-10-16","endDate":"2025-11-16","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 268"],"pendingReviewBoundary":false},
{"id":"imp_r255","customerId":"imp_c170","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2025-10-16","endDate":"2025-10-20","bookedDays":4,"paidDays":4,"revenue":700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 264"],"pendingReviewBoundary":false},
{"id":"imp_r256","customerId":"imp_c171","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2025-10-19","endDate":"2025-10-26","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 266"],"pendingReviewBoundary":false},
{"id":"imp_r257","customerId":"imp_c172","bikeModel":"Cool Blue","bikeNameRaw":"Cool Blue","plate":"","startDate":"2025-10-19","endDate":"2025-10-20","bookedDays":1,"paidDays":1,"revenue":350.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 265"],"pendingReviewBoundary":false},
{"id":"imp_r258","customerId":"imp_c151","bikeModel":"GT silver 2","bikeNameRaw":"GT silver 2","plate":"","startDate":"2025-10-20","endDate":"2025-11-15","bookedDays":26,"paidDays":26,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 269"],"pendingReviewBoundary":false},
{"id":"imp_r259","customerId":"imp_c173","bikeModel":"Cool blue","bikeNameRaw":"Cool blue","plate":"","startDate":"2025-10-20","endDate":"2025-11-20","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 270"],"pendingReviewBoundary":false},
{"id":"imp_r260","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-10-22","endDate":"2025-11-22","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 273"],"pendingReviewBoundary":false},
{"id":"imp_r261","customerId":"imp_c53","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-10-22","endDate":"2025-11-22","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 272"],"pendingReviewBoundary":false},
{"id":"imp_r262","customerId":"imp_c174","bikeModel":"RAX Blue","bikeNameRaw":"RAX Blue","plate":"","startDate":"2025-10-22","endDate":"2025-11-18","bookedDays":27,"paidDays":27,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 274"],"pendingReviewBoundary":false},
{"id":"imp_r263","customerId":"imp_c175","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-10-22","endDate":"2025-11-18","bookedDays":27,"paidDays":27,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 277"],"pendingReviewBoundary":false},
{"id":"imp_r264","customerId":"imp_c176","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2025-10-22","endDate":"2025-11-18","bookedDays":27,"paidDays":27,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 275"],"pendingReviewBoundary":false},
{"id":"imp_r265","customerId":"imp_c177","bikeModel":"CBR","bikeNameRaw":"CBR","plate":"","startDate":"2025-10-22","endDate":"2025-11-18","bookedDays":27,"paidDays":27,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 276"],"pendingReviewBoundary":false},
{"id":"imp_r266","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-10-23","endDate":"2025-11-23","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 271"],"pendingReviewBoundary":false},
{"id":"imp_r267","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-10-24","endDate":"2025-11-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 278"],"pendingReviewBoundary":false},
{"id":"imp_r268","customerId":"imp_c178","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-10-24","endDate":"2025-11-24","bookedDays":31,"paidDays":31,"revenue":4200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 279"],"pendingReviewBoundary":false},
{"id":"imp_r269","customerId":"imp_c154","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-10-26","endDate":"2025-11-26","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 280"],"pendingReviewBoundary":false},
{"id":"imp_r270","customerId":"imp_c179","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2025-10-27","endDate":"2025-11-07","bookedDays":11,"paidDays":11,"revenue":1600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 281"],"pendingReviewBoundary":false},
{"id":"imp_r271","customerId":"imp_c180","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2025-10-27","endDate":"2025-11-07","bookedDays":11,"paidDays":11,"revenue":1300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 282"],"pendingReviewBoundary":false},
{"id":"imp_r272","customerId":"imp_c112","bikeModel":"Nmax","bikeNameRaw":"Nmax","plate":"","startDate":"2025-10-28","endDate":"2025-11-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 287"],"pendingReviewBoundary":false},
{"id":"imp_r273","customerId":"imp_c181","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2025-10-28","endDate":"2025-11-18","bookedDays":21,"paidDays":21,"revenue":2800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 285"],"pendingReviewBoundary":false},
{"id":"imp_r274","customerId":"imp_c182","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2025-10-28","endDate":"2025-11-04","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 283"],"pendingReviewBoundary":false},
{"id":"imp_r275","customerId":"imp_c183","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-10-28","endDate":"2025-11-28","bookedDays":31,"paidDays":31,"revenue":3100.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 286"],"pendingReviewBoundary":false},
{"id":"imp_r276","customerId":"imp_c184","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-10-28","endDate":"2025-11-28","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 284"],"pendingReviewBoundary":false},
{"id":"imp_r277","customerId":"imp_c185","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2025-10-29","endDate":"2025-11-04","bookedDays":6,"paidDays":6,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 288"],"pendingReviewBoundary":false},
{"id":"imp_r278","customerId":"imp_c141","bikeModel":"GT Burgundy","bikeNameRaw":"GT Burgundy","plate":"","startDate":"2025-10-30","endDate":"2025-11-30","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 289"],"pendingReviewBoundary":false},
{"id":"imp_r279","customerId":"imp_c186","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2025-10-30","endDate":"2025-11-02","bookedDays":3,"paidDays":3,"revenue":600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 290"],"pendingReviewBoundary":false},
{"id":"imp_r280","customerId":"imp_c187","bikeModel":"GT black 3","bikeNameRaw":"GT black 3","plate":"","startDate":"2025-10-30","endDate":"2025-11-10","bookedDays":11,"paidDays":11,"revenue":1600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 291"],"pendingReviewBoundary":false},
{"id":"imp_r281","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-11-01","endDate":"2025-12-01","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 293"],"pendingReviewBoundary":false},
{"id":"imp_r282","customerId":"imp_c188","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2025-11-01","endDate":"2025-11-10","bookedDays":9,"paidDays":9,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 295"],"pendingReviewBoundary":false},
{"id":"imp_r283","customerId":"imp_c189","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-11-01","endDate":"2025-11-08","bookedDays":7,"paidDays":7,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 294"],"pendingReviewBoundary":false},
{"id":"imp_r284","customerId":"imp_c136","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2025-11-03","endDate":"2025-12-03","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 296"],"pendingReviewBoundary":false},
{"id":"imp_r285","customerId":"imp_c190","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-11-04","endDate":"2025-11-20","bookedDays":16,"paidDays":16,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 297"],"pendingReviewBoundary":false},
{"id":"imp_r286","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2025-11-06","endDate":"2026-01-06","bookedDays":61,"paidDays":61,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 3"],"pendingReviewBoundary":false},
{"id":"imp_r287","customerId":"imp_c191","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-11-06","endDate":"2025-11-11","bookedDays":5,"paidDays":5,"revenue":1400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 299"],"pendingReviewBoundary":false},
{"id":"imp_r288","customerId":"imp_c192","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-11-06","endDate":"2025-11-11","bookedDays":5,"paidDays":5,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 298"],"pendingReviewBoundary":false},
{"id":"imp_r289","customerId":"imp_c193","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2025-11-07","endDate":"2025-12-07","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 300"],"pendingReviewBoundary":false},
{"id":"imp_r290","customerId":"imp_c194","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2025-11-08","endDate":"2025-11-18","bookedDays":10,"paidDays":10,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 304"],"pendingReviewBoundary":false},
{"id":"imp_r291","customerId":"imp_c195","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2025-11-08","endDate":"2025-12-08","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 303"],"pendingReviewBoundary":false},
{"id":"imp_r292","customerId":"imp_c196","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-11-08","endDate":"2025-11-12","bookedDays":4,"paidDays":4,"revenue":800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 305"],"pendingReviewBoundary":false},
{"id":"imp_r293","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-11-09","endDate":"2025-12-09","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 302"],"pendingReviewBoundary":false},
{"id":"imp_r294","customerId":"imp_c188","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2025-11-10","endDate":"2025-12-07","bookedDays":27,"paidDays":27,"revenue":3850.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 306"],"pendingReviewBoundary":false},
{"id":"imp_r295","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2025-11-11","endDate":"2026-01-11","bookedDays":61,"paidDays":61,"revenue":5000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 4"],"pendingReviewBoundary":false},
{"id":"imp_r296","customerId":"imp_c165","bikeModel":"GT Black 1","bikeNameRaw":"GT Black 1","plate":"","startDate":"2025-11-11","endDate":"2025-12-05","bookedDays":24,"paidDays":24,"revenue":2600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 307"],"pendingReviewBoundary":false},
{"id":"imp_r297","customerId":"imp_c197","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-11-11","endDate":"2025-12-11","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 309"],"pendingReviewBoundary":false},
{"id":"imp_r298","customerId":"imp_c59","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2025-11-13","endDate":"2025-11-27","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 310"],"pendingReviewBoundary":false},
{"id":"imp_r299","customerId":"imp_c198","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-11-13","endDate":"2025-11-13","bookedDays":0,"paidDays":0,"revenue":300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 311"],"pendingReviewBoundary":false},
{"id":"imp_r300","customerId":"imp_c199","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-11-13","endDate":"2025-11-26","bookedDays":13,"paidDays":13,"revenue":1900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 312"],"pendingReviewBoundary":false},
{"id":"imp_r301","customerId":"imp_c200","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-11-14","endDate":"2025-12-14","bookedDays":30,"paidDays":30,"revenue":4500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 313"],"pendingReviewBoundary":false},
{"id":"imp_r302","customerId":"imp_c167","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-11-15","endDate":"2025-11-28","bookedDays":13,"paidDays":13,"revenue":2250.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 315"],"pendingReviewBoundary":false},
{"id":"imp_r303","customerId":"imp_c25","bikeModel":"GT Red 2","bikeNameRaw":"GT Red 2","plate":"","startDate":"2025-11-16","endDate":"2025-11-30","bookedDays":14,"paidDays":14,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 314"],"pendingReviewBoundary":false},
{"id":"imp_r304","customerId":"imp_c201","bikeModel":"GT silver 2","bikeNameRaw":"GT silver 2","plate":"","startDate":"2025-11-16","endDate":"2025-12-16","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 316"],"pendingReviewBoundary":false},
{"id":"imp_r305","customerId":"imp_c140","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2025-11-18","endDate":"2025-12-18","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 318"],"pendingReviewBoundary":false},
{"id":"imp_r306","customerId":"imp_c181","bikeModel":"RAX red","bikeNameRaw":"RAX red","plate":"","startDate":"2025-11-18","endDate":"2025-12-19","bookedDays":31,"paidDays":31,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 317"],"pendingReviewBoundary":false},
{"id":"imp_r307","customerId":"imp_c202","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2025-11-18","endDate":"2025-11-25","bookedDays":7,"paidDays":7,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 319"],"pendingReviewBoundary":false},
{"id":"imp_r308","customerId":"imp_c203","bikeModel":"Freego","bikeNameRaw":"Freego","plate":"","startDate":"2025-11-19","endDate":"2025-12-19","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 320"],"pendingReviewBoundary":false},
{"id":"imp_r309","customerId":"imp_c173","bikeModel":"Cool blue","bikeNameRaw":"Cool blue","plate":"","startDate":"2025-11-20","endDate":"2025-12-20","bookedDays":30,"paidDays":30,"revenue":4500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 321"],"pendingReviewBoundary":false},
{"id":"imp_r310","customerId":"imp_c204","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2025-11-20","endDate":"2025-12-22","bookedDays":32,"paidDays":32,"revenue":3400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 323"],"pendingReviewBoundary":false},
{"id":"imp_r311","customerId":"imp_c205","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2025-11-20","endDate":"2025-11-27","bookedDays":7,"paidDays":7,"revenue":1900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 322"],"pendingReviewBoundary":false},
{"id":"imp_r312","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-11-22","endDate":"2025-12-22","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 324"],"pendingReviewBoundary":false},
{"id":"imp_r313","customerId":"imp_c53","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-11-22","endDate":"2025-12-22","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 325"],"pendingReviewBoundary":false},
{"id":"imp_r314","customerId":"imp_c206","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2025-11-22","endDate":"2025-12-22","bookedDays":30,"paidDays":30,"revenue":4600.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 327"],"pendingReviewBoundary":false},
{"id":"imp_r315","customerId":"imp_c207","bikeModel":"Click Blue","bikeNameRaw":"Click Blue","plate":"","startDate":"2025-11-22","endDate":"2025-12-22","bookedDays":30,"paidDays":30,"revenue":3100.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 326"],"pendingReviewBoundary":false},
{"id":"imp_r316","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-11-23","endDate":"2025-12-23","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 328"],"pendingReviewBoundary":false},
{"id":"imp_r317","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-11-24","endDate":"2025-12-24","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 329"],"pendingReviewBoundary":false},
{"id":"imp_r318","customerId":"imp_c208","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2025-11-25","endDate":"2026-01-11","bookedDays":47,"paidDays":47,"revenue":6800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 5"],"pendingReviewBoundary":false},
{"id":"imp_r319","customerId":"imp_c154","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-11-26","endDate":"2025-12-26","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 331"],"pendingReviewBoundary":false},
{"id":"imp_r320","customerId":"imp_c209","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-11-26","endDate":"2025-12-26","bookedDays":30,"paidDays":30,"revenue":4500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 332"],"pendingReviewBoundary":false},
{"id":"imp_r321","customerId":"imp_c210","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-11-27","endDate":"2025-12-04","bookedDays":7,"paidDays":7,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 335"],"pendingReviewBoundary":false},
{"id":"imp_r322","customerId":"imp_c211","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-11-27","endDate":"2025-12-04","bookedDays":7,"paidDays":7,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 334"],"pendingReviewBoundary":false},
{"id":"imp_r323","customerId":"imp_c35","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2025-11-28","endDate":"2026-01-04","bookedDays":37,"paidDays":37,"revenue":4350.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 6"],"pendingReviewBoundary":false},
{"id":"imp_r324","customerId":"imp_c112","bikeModel":"nmax","bikeNameRaw":"nmax","plate":"","startDate":"2025-11-28","endDate":"2025-12-28","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 336"],"pendingReviewBoundary":false},
{"id":"imp_r325","customerId":"imp_c184","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-11-28","endDate":"2025-12-28","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 333"],"pendingReviewBoundary":false},
{"id":"imp_r326","customerId":"imp_c212","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2025-11-28","endDate":"2025-12-01","bookedDays":3,"paidDays":3,"revenue":2000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 337"],"pendingReviewBoundary":false},
{"id":"imp_r327","customerId":"imp_c213","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-11-29","endDate":"2025-11-30","bookedDays":1,"paidDays":1,"revenue":300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 339"],"pendingReviewBoundary":false},
{"id":"imp_r328","customerId":"imp_c141","bikeModel":"GT Burgundy","bikeNameRaw":"GT Burgundy","plate":"","startDate":"2025-11-30","endDate":"2025-12-10","bookedDays":10,"paidDays":10,"revenue":900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 345"],"pendingReviewBoundary":false},
{"id":"imp_r329","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-12-01","endDate":"2026-02-01","bookedDays":62,"paidDays":62,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 46"],"pendingReviewBoundary":false},
{"id":"imp_r330","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2025-12-01","endDate":"2026-01-01","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 7"],"pendingReviewBoundary":false},
{"id":"imp_r331","customerId":"imp_c214","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-12-01","endDate":"2025-12-11","bookedDays":10,"paidDays":10,"revenue":2300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 342"],"pendingReviewBoundary":false},
{"id":"imp_r332","customerId":"imp_c215","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2025-12-01","endDate":"2025-12-25","bookedDays":24,"paidDays":24,"revenue":4000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 344"],"pendingReviewBoundary":false},
{"id":"imp_r333","customerId":"imp_c216","bikeModel":"gt red 2                             (under Irene)","bikeNameRaw":"gt red 2                             (under Irene)","plate":"","startDate":"2025-12-02","endDate":"2026-02-11","bookedDays":71,"paidDays":71,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 45"],"pendingReviewBoundary":false},
{"id":"imp_r334","customerId":"imp_c216","bikeModel":"gt red 2","bikeNameRaw":"gt red 2","plate":"","startDate":"2025-12-02","endDate":"2026-01-02","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 10"],"pendingReviewBoundary":false},
{"id":"imp_r335","customerId":"imp_c217","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-12-03","endDate":"2026-01-03","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 348"],"pendingReviewBoundary":false},
{"id":"imp_r336","customerId":"imp_c218","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2025-12-03","endDate":"2026-01-03","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 11"],"pendingReviewBoundary":false},
{"id":"imp_r337","customerId":"imp_c219","bikeModel":"Cool Blue 2","bikeNameRaw":"Cool Blue 2","plate":"","startDate":"2025-12-03","endDate":"2025-12-10","bookedDays":7,"paidDays":7,"revenue":1700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 347"],"pendingReviewBoundary":false},
{"id":"imp_r338","customerId":"imp_c220","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2025-12-06","endDate":"2025-12-13","bookedDays":7,"paidDays":7,"revenue":2840.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 349"],"pendingReviewBoundary":false},
{"id":"imp_r339","customerId":"imp_c188","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2025-12-07","endDate":"2025-12-14","bookedDays":7,"paidDays":7,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 351"],"pendingReviewBoundary":false},
{"id":"imp_r340","customerId":"imp_c193","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2025-12-07","endDate":"2026-02-22","bookedDays":77,"paidDays":77,"revenue":6250.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 12"],"pendingReviewBoundary":false},
{"id":"imp_r341","customerId":"imp_c221","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2025-12-07","endDate":"2025-12-18","bookedDays":11,"paidDays":11,"revenue":1800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 353"],"pendingReviewBoundary":false},
{"id":"imp_r342","customerId":"imp_c195","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2025-12-08","endDate":"2026-01-08","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 13"],"pendingReviewBoundary":false},
{"id":"imp_r343","customerId":"imp_c222","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-12-08","endDate":"2025-12-13","bookedDays":5,"paidDays":5,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 354"],"pendingReviewBoundary":false},
{"id":"imp_r344","customerId":"imp_c223","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-12-08","endDate":"2025-12-13","bookedDays":5,"paidDays":5,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 356"],"pendingReviewBoundary":false},
{"id":"imp_r345","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2025-12-09","endDate":"2026-01-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 9"],"pendingReviewBoundary":false},
{"id":"imp_r346","customerId":"imp_c224","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2025-12-10","endDate":"2026-01-10","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 14"],"pendingReviewBoundary":false},
{"id":"imp_r347","customerId":"imp_c225","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2025-12-11","endDate":"2026-01-11","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 15"],"pendingReviewBoundary":false},
{"id":"imp_r348","customerId":"imp_c226","bikeModel":"GT Burgundy","bikeNameRaw":"GT Burgundy","plate":"","startDate":"2025-12-13","endDate":"2025-12-20","bookedDays":7,"paidDays":7,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 360"],"pendingReviewBoundary":false},
{"id":"imp_r349","customerId":"imp_c227","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2025-12-13","endDate":"2026-01-10","bookedDays":28,"paidDays":28,"revenue":2900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 17"],"pendingReviewBoundary":false},
{"id":"imp_r350","customerId":"imp_c188","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2025-12-14","endDate":"2025-12-18","bookedDays":4,"paidDays":4,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 362"],"pendingReviewBoundary":false},
{"id":"imp_r351","customerId":"imp_c228","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-12-15","endDate":"2025-12-16","bookedDays":1,"paidDays":1,"revenue":400.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 364"],"pendingReviewBoundary":false},
{"id":"imp_r352","customerId":"imp_c229","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-12-15","endDate":"2025-12-19","bookedDays":4,"paidDays":4,"revenue":800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 366"],"pendingReviewBoundary":false},
{"id":"imp_r353","customerId":"imp_c229","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-12-15","endDate":"2025-12-16","bookedDays":1,"paidDays":1,"revenue":300.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 365"],"pendingReviewBoundary":false},
{"id":"imp_r354","customerId":"imp_c230","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2025-12-15","endDate":"2025-12-26","bookedDays":11,"paidDays":11,"revenue":4900.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 367"],"pendingReviewBoundary":false},
{"id":"imp_r355","customerId":"imp_c201","bikeModel":"GT silver 2","bikeNameRaw":"GT silver 2","plate":"","startDate":"2025-12-16","endDate":"2026-01-16","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 19"],"pendingReviewBoundary":false},
{"id":"imp_r356","customerId":"imp_c231","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2025-12-16","endDate":"2025-12-20","bookedDays":4,"paidDays":4,"revenue":1000.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 369"],"pendingReviewBoundary":false},
{"id":"imp_r357","customerId":"imp_c232","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2025-12-16","endDate":"2025-12-30","bookedDays":14,"paidDays":14,"revenue":2700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 370"],"pendingReviewBoundary":false},
{"id":"imp_r358","customerId":"imp_c233","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-12-17","endDate":"2025-12-31","bookedDays":14,"paidDays":14,"revenue":1200.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 371"],"pendingReviewBoundary":false},
{"id":"imp_r359","customerId":"imp_c234","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2025-12-18","endDate":"2025-12-28","bookedDays":10,"paidDays":10,"revenue":1500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 372"],"pendingReviewBoundary":false},
{"id":"imp_r360","customerId":"imp_c203","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2025-12-19","endDate":"2026-01-19","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 18"],"pendingReviewBoundary":false},
{"id":"imp_r361","customerId":"imp_c235","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2025-12-19","endDate":"2026-01-10","bookedDays":22,"paidDays":22,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 20"],"pendingReviewBoundary":false},
{"id":"imp_r362","customerId":"imp_c173","bikeModel":"Cool blue","bikeNameRaw":"Cool blue","plate":"","startDate":"2025-12-20","endDate":"2026-01-28","bookedDays":39,"paidDays":39,"revenue":5700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 21"],"pendingReviewBoundary":false},
{"id":"imp_r363","customerId":"imp_c236","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2025-12-20","endDate":"2025-12-23","bookedDays":3,"paidDays":3,"revenue":800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 378"],"pendingReviewBoundary":false},
{"id":"imp_r364","customerId":"imp_c237","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2025-12-20","endDate":"2026-01-20","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 22"],"pendingReviewBoundary":false},
{"id":"imp_r365","customerId":"imp_c238","bikeModel":"GT burgandy","bikeNameRaw":"GT burgandy","plate":"","startDate":"2025-12-20","endDate":"2025-12-23","bookedDays":3,"paidDays":3,"revenue":800.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 377"],"pendingReviewBoundary":false},
{"id":"imp_r366","customerId":"imp_c239","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2025-12-20","endDate":"2025-12-27","bookedDays":7,"paidDays":7,"revenue":1700.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 375"],"pendingReviewBoundary":false},
{"id":"imp_r367","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2025-12-22","endDate":"2026-01-22","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 24"],"pendingReviewBoundary":false},
{"id":"imp_r368","customerId":"imp_c206","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2025-12-22","endDate":"2025-12-28","bookedDays":6,"paidDays":6,"revenue":2500.0,"status":"completed","sourceRows":["AA SCOOTERS Accounts 2025 row 382"],"pendingReviewBoundary":false},
{"id":"imp_r369","customerId":"imp_c207","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2025-12-22","endDate":"2026-01-03","bookedDays":12,"paidDays":12,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 23"],"pendingReviewBoundary":false},
{"id":"imp_r370","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2025-12-23","endDate":"2026-01-23","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 25"],"pendingReviewBoundary":false},
{"id":"imp_r371","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2025-12-24","endDate":"2026-01-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 16"],"pendingReviewBoundary":false},
{"id":"imp_r372","customerId":"imp_c240","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2025-12-24","endDate":"2026-01-28","bookedDays":35,"paidDays":35,"revenue":3700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 26"],"pendingReviewBoundary":false},
{"id":"imp_r373","customerId":"imp_c241","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2025-12-25","endDate":"2026-01-01","bookedDays":7,"paidDays":7,"revenue":1700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 27"],"pendingReviewBoundary":false},
{"id":"imp_r374","customerId":"imp_c242","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2025-12-25","endDate":"2026-01-02","bookedDays":8,"paidDays":8,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 30"],"pendingReviewBoundary":false},
{"id":"imp_r375","customerId":"imp_c243","bikeModel":"GT black 4             (under (Maziar))","bikeNameRaw":"GT black 4             (under (Maziar))","plate":"","startDate":"2025-12-25","endDate":"2026-01-29","bookedDays":35,"paidDays":35,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 31"],"pendingReviewBoundary":false},
{"id":"imp_r376","customerId":"imp_c244","bikeModel":"GT silver 1             (under (Maziar))","bikeNameRaw":"GT silver 1             (under (Maziar))","plate":"","startDate":"2025-12-25","endDate":"2026-01-29","bookedDays":35,"paidDays":35,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 32"],"pendingReviewBoundary":false},
{"id":"imp_r377","customerId":"imp_c25","bikeModel":"GT Burgandy","bikeNameRaw":"GT Burgandy","plate":"","startDate":"2025-12-26","endDate":"2026-01-26","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 34"],"pendingReviewBoundary":false},
{"id":"imp_r378","customerId":"imp_c154","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2025-12-26","endDate":"2026-01-26","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 29"],"pendingReviewBoundary":false},
{"id":"imp_r379","customerId":"imp_c209","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2025-12-26","endDate":"2026-01-26","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 28"],"pendingReviewBoundary":false},
{"id":"imp_r380","customerId":"imp_c245","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2025-12-26","endDate":"2026-01-26","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 33"],"pendingReviewBoundary":false},
{"id":"imp_r381","customerId":"imp_c112","bikeModel":"nmax","bikeNameRaw":"nmax","plate":"","startDate":"2025-12-28","endDate":"2026-01-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 35"],"pendingReviewBoundary":false},
{"id":"imp_r382","customerId":"imp_c184","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2025-12-28","endDate":"2026-01-28","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 36"],"pendingReviewBoundary":false},
{"id":"imp_r383","customerId":"imp_c246","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2025-12-28","endDate":"2026-01-06","bookedDays":9,"paidDays":9,"revenue":2700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 37"],"pendingReviewBoundary":false},
{"id":"imp_r384","customerId":"imp_c247","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-12-30","endDate":"2026-03-01","bookedDays":61,"paidDays":61,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 85"],"pendingReviewBoundary":false},
{"id":"imp_r385","customerId":"imp_c247","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2025-12-30","endDate":"2026-01-30","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 39"],"pendingReviewBoundary":false},
{"id":"imp_r386","customerId":"imp_c248","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2025-12-30","endDate":"2026-01-11","bookedDays":12,"paidDays":12,"revenue":6400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 38"],"pendingReviewBoundary":false},
{"id":"imp_r387","customerId":"imp_c249","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2025-12-30","endDate":"2026-02-04","bookedDays":36,"paidDays":36,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 86"],"pendingReviewBoundary":false},
{"id":"imp_r388","customerId":"imp_c250","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2025-12-31","endDate":"2026-01-05","bookedDays":5,"paidDays":5,"revenue":1700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 40"],"pendingReviewBoundary":false},
{"id":"imp_r389","customerId":"imp_c251","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2025-12-31","endDate":"2026-01-03","bookedDays":3,"paidDays":3,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 41"],"pendingReviewBoundary":false},
{"id":"imp_r390","customerId":"imp_c252","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-01-01","endDate":"2026-01-03","bookedDays":2,"paidDays":2,"revenue":900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 43"],"pendingReviewBoundary":false},
{"id":"imp_r391","customerId":"imp_c253","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-01-01","endDate":"2026-01-08","bookedDays":7,"paidDays":7,"revenue":2100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 44"],"pendingReviewBoundary":false},
{"id":"imp_r392","customerId":"imp_c181","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-01-03","endDate":"2026-02-03","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 49"],"pendingReviewBoundary":false},
{"id":"imp_r393","customerId":"imp_c217","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-01-03","endDate":"2026-02-03","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 47"],"pendingReviewBoundary":false},
{"id":"imp_r394","customerId":"imp_c254","bikeModel":"Freego red                          ( under Tiacas)","bikeNameRaw":"Freego red                          ( under Tiacas)","plate":"","startDate":"2026-01-03","endDate":"2026-02-03","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 50"],"pendingReviewBoundary":false},
{"id":"imp_r395","customerId":"imp_c255","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-01-03","endDate":"2026-01-24","bookedDays":21,"paidDays":21,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 48"],"pendingReviewBoundary":false},
{"id":"imp_r396","customerId":"imp_c194","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2026-01-05","endDate":"2026-02-05","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 51"],"pendingReviewBoundary":false},
{"id":"imp_r397","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2026-01-06","endDate":"2026-03-06","bookedDays":59,"paidDays":59,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 63"],"pendingReviewBoundary":false},
{"id":"imp_r398","customerId":"imp_c120","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2026-01-06","endDate":"2026-02-03","bookedDays":28,"paidDays":28,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 52"],"pendingReviewBoundary":false},
{"id":"imp_r399","customerId":"imp_c256","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2026-01-06","endDate":"2026-02-06","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 53"],"pendingReviewBoundary":false},
{"id":"imp_r400","customerId":"imp_c257","bikeModel":"RAX red                              (under Sabzi)","bikeNameRaw":"RAX red                              (under Sabzi)","plate":"","startDate":"2026-01-07","endDate":"2026-01-22","bookedDays":15,"paidDays":15,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 55"],"pendingReviewBoundary":false},
{"id":"imp_r401","customerId":"imp_c195","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-01-08","endDate":"2026-02-08","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 54"],"pendingReviewBoundary":false},
{"id":"imp_r402","customerId":"imp_c258","bikeModel":"Cool 2                                  ( under Melissa)","bikeNameRaw":"Cool 2                                  ( under Melissa)","plate":"","startDate":"2026-01-08","endDate":"2026-01-18","bookedDays":10,"paidDays":10,"revenue":2200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 57"],"pendingReviewBoundary":false},
{"id":"imp_r403","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-01-09","endDate":"2026-02-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 56"],"pendingReviewBoundary":false},
{"id":"imp_r404","customerId":"imp_c259","bikeModel":"NMAX blue","bikeNameRaw":"NMAX blue","plate":"","startDate":"2026-01-09","endDate":"2026-01-31","bookedDays":22,"paidDays":22,"revenue":3800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 58"],"pendingReviewBoundary":false},
{"id":"imp_r405","customerId":"imp_c224","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-01-10","endDate":"2026-02-10","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 59"],"pendingReviewBoundary":false},
{"id":"imp_r406","customerId":"imp_c260","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-01-10","endDate":"2026-02-11","bookedDays":32,"paidDays":32,"revenue":10000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 60"],"pendingReviewBoundary":false},
{"id":"imp_r407","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-01-11","endDate":"2026-02-11","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 61"],"pendingReviewBoundary":false},
{"id":"imp_r408","customerId":"imp_c225","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-01-11","endDate":"2026-02-11","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 62"],"pendingReviewBoundary":false},
{"id":"imp_r409","customerId":"imp_c261","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2026-01-13","endDate":"2026-01-20","bookedDays":7,"paidDays":7,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 64"],"pendingReviewBoundary":false},
{"id":"imp_r410","customerId":"imp_c262","bikeModel":"Aerox blue                      (under Manufloret)","bikeNameRaw":"Aerox blue                      (under Manufloret)","plate":"","startDate":"2026-01-14","endDate":"2026-02-04","bookedDays":21,"paidDays":21,"revenue":3300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 65"],"pendingReviewBoundary":false},
{"id":"imp_r411","customerId":"imp_c263","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2026-01-14","endDate":"2026-03-03","bookedDays":48,"paidDays":48,"revenue":4700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 66"],"pendingReviewBoundary":false},
{"id":"imp_r412","customerId":"imp_c201","bikeModel":"GT silver 2","bikeNameRaw":"GT silver 2","plate":"","startDate":"2026-01-16","endDate":"2026-03-16","bookedDays":59,"paidDays":59,"revenue":6000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 67"],"pendingReviewBoundary":false},
{"id":"imp_r413","customerId":"imp_c203","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2026-01-19","endDate":"2026-02-14","bookedDays":26,"paidDays":26,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 68"],"pendingReviewBoundary":false},
{"id":"imp_r414","customerId":"imp_c264","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-01-19","endDate":"2026-02-12","bookedDays":24,"paidDays":24,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 69"],"pendingReviewBoundary":false},
{"id":"imp_r415","customerId":"imp_c265","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-01-20","endDate":"2026-02-28","bookedDays":39,"paidDays":39,"revenue":3200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 70"],"pendingReviewBoundary":false},
{"id":"imp_r416","customerId":"imp_c266","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-01-21","endDate":"2026-02-20","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 71"],"pendingReviewBoundary":false},
{"id":"imp_r417","customerId":"imp_c267","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2026-01-21","endDate":"2026-02-10","bookedDays":20,"paidDays":20,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 72"],"pendingReviewBoundary":false},
{"id":"imp_r418","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2026-01-22","endDate":"2026-02-22","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 73"],"pendingReviewBoundary":false},
{"id":"imp_r419","customerId":"imp_c268","bikeModel":"RAX red","bikeNameRaw":"RAX red","plate":"","startDate":"2026-01-22","endDate":"2026-02-22","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 74"],"pendingReviewBoundary":false},
{"id":"imp_r420","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-01-23","endDate":"2026-02-23","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 75"],"pendingReviewBoundary":false},
{"id":"imp_r421","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2026-01-24","endDate":"2026-02-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 78"],"pendingReviewBoundary":false},
{"id":"imp_r422","customerId":"imp_c269","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-01-24","endDate":"2026-02-15","bookedDays":22,"paidDays":22,"revenue":2850.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 76"],"pendingReviewBoundary":false},
{"id":"imp_r423","customerId":"imp_c25","bikeModel":"GT Burgandy","bikeNameRaw":"GT Burgandy","plate":"","startDate":"2026-01-26","endDate":"2026-02-26","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 80"],"pendingReviewBoundary":false},
{"id":"imp_r424","customerId":"imp_c154","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2026-01-26","endDate":"2026-02-26","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 79"],"pendingReviewBoundary":false},
{"id":"imp_r425","customerId":"imp_c209","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2026-01-26","endDate":"2026-02-11","bookedDays":16,"paidDays":16,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 81"],"pendingReviewBoundary":false},
{"id":"imp_r426","customerId":"imp_c245","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2026-01-26","endDate":"2026-02-26","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 77"],"pendingReviewBoundary":false},
{"id":"imp_r427","customerId":"imp_c112","bikeModel":"nmax","bikeNameRaw":"nmax","plate":"","startDate":"2026-01-28","endDate":"2026-02-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 84"],"pendingReviewBoundary":false},
{"id":"imp_r428","customerId":"imp_c184","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-01-28","endDate":"2026-02-02","bookedDays":5,"paidDays":5,"revenue":800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 83"],"pendingReviewBoundary":false},
{"id":"imp_r429","customerId":"imp_c240","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2026-01-28","endDate":"2026-02-13","bookedDays":16,"paidDays":16,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 82"],"pendingReviewBoundary":false},
{"id":"imp_r430","customerId":"imp_c270","bikeModel":"Cool Blue 1","bikeNameRaw":"Cool Blue 1","plate":"","startDate":"2026-01-30","endDate":"2026-02-13","bookedDays":14,"paidDays":14,"revenue":2700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 87"],"pendingReviewBoundary":false},
{"id":"imp_r431","customerId":"imp_c271","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-01-31","endDate":"2026-02-27","bookedDays":27,"paidDays":27,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 88"],"pendingReviewBoundary":false},
{"id":"imp_r432","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2026-02-01","endDate":"2026-03-01","bookedDays":28,"paidDays":28,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 91"],"pendingReviewBoundary":false},
{"id":"imp_r433","customerId":"imp_c184","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-02-02","endDate":"2026-02-18","bookedDays":16,"paidDays":16,"revenue":2150.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 92"],"pendingReviewBoundary":false},
{"id":"imp_r434","customerId":"imp_c272","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2026-02-02","endDate":"2026-03-02","bookedDays":28,"paidDays":28,"revenue":3100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 94"],"pendingReviewBoundary":false},
{"id":"imp_r435","customerId":"imp_c181","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-02-03","endDate":"2026-03-03","bookedDays":28,"paidDays":28,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 95"],"pendingReviewBoundary":false},
{"id":"imp_r436","customerId":"imp_c273","bikeModel":"Aerox Blue","bikeNameRaw":"Aerox Blue","plate":"","startDate":"2026-02-04","endDate":"2026-03-04","bookedDays":28,"paidDays":28,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 98"],"pendingReviewBoundary":false},
{"id":"imp_r437","customerId":"imp_c274","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2026-02-04","endDate":"2026-03-04","bookedDays":28,"paidDays":28,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 97"],"pendingReviewBoundary":false},
{"id":"imp_r438","customerId":"imp_c275","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-02-04","endDate":"2026-02-28","bookedDays":24,"paidDays":24,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 96"],"pendingReviewBoundary":false},
{"id":"imp_r439","customerId":"imp_c194","bikeModel":"Nmax Blue","bikeNameRaw":"Nmax Blue","plate":"","startDate":"2026-02-05","endDate":"2026-03-05","bookedDays":28,"paidDays":28,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 93"],"pendingReviewBoundary":false},
{"id":"imp_r440","customerId":"imp_c256","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2026-02-06","endDate":"2026-03-06","bookedDays":28,"paidDays":28,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 99"],"pendingReviewBoundary":false},
{"id":"imp_r441","customerId":"imp_c276","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-02-07","endDate":"2026-02-12","bookedDays":5,"paidDays":5,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 100"],"pendingReviewBoundary":false},
{"id":"imp_r442","customerId":"imp_c277","bikeModel":"Aerox Red 2","bikeNameRaw":"Aerox Red 2","plate":"","startDate":"2026-02-08","endDate":"2026-03-08","bookedDays":28,"paidDays":28,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 101"],"pendingReviewBoundary":false},
{"id":"imp_r443","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-02-09","endDate":"2026-03-09","bookedDays":28,"paidDays":28,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 89"],"pendingReviewBoundary":false},
{"id":"imp_r444","customerId":"imp_c133","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-02-10","endDate":"2026-02-16","bookedDays":6,"paidDays":6,"revenue":3300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 103"],"pendingReviewBoundary":false},
{"id":"imp_r445","customerId":"imp_c278","bikeModel":"Aerox White","bikeNameRaw":"Aerox White","plate":"","startDate":"2026-02-10","endDate":"2026-02-27","bookedDays":17,"paidDays":17,"revenue":3200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 104"],"pendingReviewBoundary":false},
{"id":"imp_r446","customerId":"imp_c279","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-02-10","endDate":"2026-02-17","bookedDays":7,"paidDays":7,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 102"],"pendingReviewBoundary":false},
{"id":"imp_r447","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-02-11","endDate":"2026-02-18","bookedDays":7,"paidDays":7,"revenue":600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 105"],"pendingReviewBoundary":false},
{"id":"imp_r448","customerId":"imp_c225","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-02-11","endDate":"2026-02-17","bookedDays":6,"paidDays":6,"revenue":900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 106"],"pendingReviewBoundary":false},
{"id":"imp_r449","customerId":"imp_c280","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2026-02-11","endDate":"2026-02-18","bookedDays":7,"paidDays":7,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 108"],"pendingReviewBoundary":false},
{"id":"imp_r450","customerId":"imp_c281","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-02-11","endDate":"2026-02-14","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 107"],"pendingReviewBoundary":false},
{"id":"imp_r451","customerId":"imp_c282","bikeModel":"Cool  2","bikeNameRaw":"Cool  2","plate":"","startDate":"2026-02-12","endDate":"2026-03-07","bookedDays":23,"paidDays":23,"revenue":3800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 110"],"pendingReviewBoundary":false},
{"id":"imp_r452","customerId":"imp_c283","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-02-12","endDate":"2026-03-01","bookedDays":17,"paidDays":17,"revenue":2300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 109"],"pendingReviewBoundary":false},
{"id":"imp_r453","customerId":"imp_c284","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2026-02-14","endDate":"2026-03-16","bookedDays":30,"paidDays":30,"revenue":3200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 112"],"pendingReviewBoundary":false},
{"id":"imp_r454","customerId":"imp_c285","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-02-14","endDate":"2026-03-14","bookedDays":28,"paidDays":28,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 111"],"pendingReviewBoundary":false},
{"id":"imp_r455","customerId":"imp_c286","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-02-16","endDate":"2026-02-20","bookedDays":4,"paidDays":4,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 113"],"pendingReviewBoundary":false},
{"id":"imp_r456","customerId":"imp_c225","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-02-17","endDate":"2026-03-01","bookedDays":12,"paidDays":12,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 117"],"pendingReviewBoundary":false},
{"id":"imp_r457","customerId":"imp_c287","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2026-02-17","endDate":"2026-03-17","bookedDays":28,"paidDays":28,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 114"],"pendingReviewBoundary":false},
{"id":"imp_r458","customerId":"imp_c288","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-02-17","endDate":"2026-03-17","bookedDays":28,"paidDays":28,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 115"],"pendingReviewBoundary":false},
{"id":"imp_r459","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-02-18","endDate":"2026-03-18","bookedDays":28,"paidDays":28,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 118"],"pendingReviewBoundary":false},
{"id":"imp_r460","customerId":"imp_c289","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-02-18","endDate":"2026-02-28","bookedDays":10,"paidDays":10,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 116"],"pendingReviewBoundary":false},
{"id":"imp_r461","customerId":"imp_c290","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-02-19","endDate":"2026-02-23","bookedDays":4,"paidDays":4,"revenue":2300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 119"],"pendingReviewBoundary":false},
{"id":"imp_r462","customerId":"imp_c111","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2026-02-20","endDate":"2026-03-13","bookedDays":21,"paidDays":21,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 122"],"pendingReviewBoundary":false},
{"id":"imp_r463","customerId":"imp_c291","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-02-20","endDate":"2026-03-20","bookedDays":28,"paidDays":28,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 123"],"pendingReviewBoundary":false},
{"id":"imp_r464","customerId":"imp_c292","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2026-02-20","endDate":"2026-03-13","bookedDays":21,"paidDays":21,"revenue":3300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 121"],"pendingReviewBoundary":false},
{"id":"imp_r465","customerId":"imp_c266","bikeModel":"RAX 3 (upgraded from GT)","bikeNameRaw":"RAX 3 (upgraded from GT)","plate":"","startDate":"2026-02-21","endDate":"2026-03-17","bookedDays":24,"paidDays":24,"revenue":3700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 120"],"pendingReviewBoundary":false},
{"id":"imp_r466","customerId":"imp_c49","bikeModel":"Aerox Cool","bikeNameRaw":"Aerox Cool","plate":"","startDate":"2026-02-22","endDate":"2026-03-22","bookedDays":28,"paidDays":28,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 124"],"pendingReviewBoundary":false},
{"id":"imp_r467","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-02-23","endDate":"2026-03-23","bookedDays":28,"paidDays":28,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 125"],"pendingReviewBoundary":false},
{"id":"imp_r468","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2026-02-24","endDate":"2026-03-24","bookedDays":28,"paidDays":28,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 126"],"pendingReviewBoundary":false},
{"id":"imp_r469","customerId":"imp_c293","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2026-02-24","endDate":"2026-03-24","bookedDays":28,"paidDays":28,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 127"],"pendingReviewBoundary":false},
{"id":"imp_r470","customerId":"imp_c25","bikeModel":"GT Burgandy","bikeNameRaw":"GT Burgandy","plate":"","startDate":"2026-02-26","endDate":"2026-03-26","bookedDays":28,"paidDays":28,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 130"],"pendingReviewBoundary":false},
{"id":"imp_r471","customerId":"imp_c154","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2026-02-26","endDate":"2026-03-26","bookedDays":28,"paidDays":28,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 128"],"pendingReviewBoundary":false},
{"id":"imp_r472","customerId":"imp_c245","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2026-02-26","endDate":"2026-03-26","bookedDays":28,"paidDays":28,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 129"],"pendingReviewBoundary":false},
{"id":"imp_r473","customerId":"imp_c294","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-02-26","endDate":"2026-02-28","bookedDays":2,"paidDays":2,"revenue":750.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 132"],"pendingReviewBoundary":false},
{"id":"imp_r474","customerId":"imp_c112","bikeModel":"nmax","bikeNameRaw":"nmax","plate":"","startDate":"2026-02-28","endDate":"2026-03-28","bookedDays":28,"paidDays":28,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 134"],"pendingReviewBoundary":false},
{"id":"imp_r475","customerId":"imp_c247","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2026-02-28","endDate":"2026-03-30","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 135"],"pendingReviewBoundary":false},
{"id":"imp_r476","customerId":"imp_c265","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-02-28","endDate":"2026-03-13","bookedDays":13,"paidDays":13,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 133"],"pendingReviewBoundary":false},
{"id":"imp_r477","customerId":"imp_c275","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-02-28","endDate":"2026-03-12","bookedDays":12,"paidDays":12,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 131"],"pendingReviewBoundary":false},
{"id":"imp_r478","customerId":"imp_c289","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-02-28","endDate":"2026-03-05","bookedDays":5,"paidDays":5,"revenue":500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 142"],"pendingReviewBoundary":false},
{"id":"imp_r479","customerId":"imp_c295","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2026-02-28","endDate":"2026-03-05","bookedDays":5,"paidDays":5,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 137"],"pendingReviewBoundary":false},
{"id":"imp_r480","customerId":"imp_c296","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-02-28","endDate":"2026-03-07","bookedDays":7,"paidDays":7,"revenue":1400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 136"],"pendingReviewBoundary":false},
{"id":"imp_r481","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2026-03-01","endDate":"2026-04-01","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 139"],"pendingReviewBoundary":false},
{"id":"imp_r482","customerId":"imp_c225","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-03-01","endDate":"2026-03-09","bookedDays":8,"paidDays":8,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 140"],"pendingReviewBoundary":false},
{"id":"imp_r483","customerId":"imp_c283","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-03-01","endDate":"2026-03-20","bookedDays":19,"paidDays":19,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 141"],"pendingReviewBoundary":false},
{"id":"imp_r484","customerId":"imp_c297","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-03-01","endDate":"2026-03-11","bookedDays":10,"paidDays":10,"revenue":2050.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 145"],"pendingReviewBoundary":false},
{"id":"imp_r485","customerId":"imp_c272","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2026-03-02","endDate":"2026-03-18","bookedDays":16,"paidDays":16,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 146"],"pendingReviewBoundary":false},
{"id":"imp_r486","customerId":"imp_c181","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-03-03","endDate":"2026-03-09","bookedDays":6,"paidDays":6,"revenue":800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 147"],"pendingReviewBoundary":false},
{"id":"imp_r487","customerId":"imp_c298","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-03-03","endDate":"2026-03-07","bookedDays":4,"paidDays":4,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 148"],"pendingReviewBoundary":false},
{"id":"imp_r488","customerId":"imp_c274","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2026-03-04","endDate":"2026-03-30","bookedDays":26,"paidDays":26,"revenue":2600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 149"],"pendingReviewBoundary":false},
{"id":"imp_r489","customerId":"imp_c299","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2026-03-04","endDate":"2026-03-18","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 150"],"pendingReviewBoundary":false},
{"id":"imp_r490","customerId":"imp_c194","bikeModel":"Nmax Blue","bikeNameRaw":"Nmax Blue","plate":"","startDate":"2026-03-05","endDate":"2026-04-05","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 151"],"pendingReviewBoundary":false},
{"id":"imp_r491","customerId":"imp_c300","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-03-05","endDate":"2026-03-11","bookedDays":6,"paidDays":6,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 153"],"pendingReviewBoundary":false},
{"id":"imp_r492","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2026-03-06","endDate":"2026-05-06","bookedDays":61,"paidDays":61,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 143"],"pendingReviewBoundary":false},
{"id":"imp_r493","customerId":"imp_c256","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2026-03-06","endDate":"2026-03-13","bookedDays":7,"paidDays":7,"revenue":1100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 152"],"pendingReviewBoundary":false},
{"id":"imp_r494","customerId":"imp_c296","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-03-07","endDate":"2026-03-17","bookedDays":10,"paidDays":10,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 154"],"pendingReviewBoundary":false},
{"id":"imp_r495","customerId":"imp_c301","bikeModel":"Aerox white","bikeNameRaw":"Aerox white","plate":"","startDate":"2026-03-07","endDate":"2026-03-25","bookedDays":18,"paidDays":18,"revenue":3700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 155"],"pendingReviewBoundary":false},
{"id":"imp_r496","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-03-09","endDate":"2026-04-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 144"],"pendingReviewBoundary":false},
{"id":"imp_r497","customerId":"imp_c302","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-03-10","endDate":"2026-03-14","bookedDays":4,"paidDays":4,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 157"],"pendingReviewBoundary":false},
{"id":"imp_r498","customerId":"imp_c303","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-03-10","endDate":"2026-03-17","bookedDays":7,"paidDays":7,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 158"],"pendingReviewBoundary":false},
{"id":"imp_r499","customerId":"imp_c304","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-03-11","endDate":"2026-03-30","bookedDays":19,"paidDays":19,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 161"],"pendingReviewBoundary":false},
{"id":"imp_r500","customerId":"imp_c305","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-03-11","endDate":"2026-03-17","bookedDays":6,"paidDays":6,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 159"],"pendingReviewBoundary":false},
{"id":"imp_r501","customerId":"imp_c306","bikeModel":"Nmax Black","bikeNameRaw":"Nmax Black","plate":"","startDate":"2026-03-12","endDate":"2026-03-25","bookedDays":13,"paidDays":13,"revenue":2700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 162"],"pendingReviewBoundary":false},
{"id":"imp_r502","customerId":"imp_c111","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2026-03-13","endDate":"2026-03-23","bookedDays":10,"paidDays":10,"revenue":1350.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 156"],"pendingReviewBoundary":false},
{"id":"imp_r503","customerId":"imp_c267","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-03-13","endDate":"2026-03-28","bookedDays":15,"paidDays":15,"revenue":2800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 163"],"pendingReviewBoundary":false},
{"id":"imp_r504","customerId":"imp_c307","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-03-13","endDate":"2026-03-29","bookedDays":16,"paidDays":16,"revenue":2200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 164"],"pendingReviewBoundary":false},
{"id":"imp_r505","customerId":"imp_c289","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-03-14","endDate":"2026-03-18","bookedDays":4,"paidDays":4,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 165"],"pendingReviewBoundary":false},
{"id":"imp_r506","customerId":"imp_c308","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-03-14","endDate":"2026-03-21","bookedDays":7,"paidDays":7,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 166"],"pendingReviewBoundary":false},
{"id":"imp_r507","customerId":"imp_c201","bikeModel":"Aerox Black","bikeNameRaw":"Aerox Black","plate":"","startDate":"2026-03-16","endDate":"2026-04-16","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 167"],"pendingReviewBoundary":false},
{"id":"imp_r508","customerId":"imp_c309","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-03-16","endDate":"2026-03-19","bookedDays":3,"paidDays":3,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 169"],"pendingReviewBoundary":false},
{"id":"imp_r509","customerId":"imp_c287","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2026-03-17","endDate":"2026-04-27","bookedDays":41,"paidDays":41,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 160"],"pendingReviewBoundary":false},
{"id":"imp_r510","customerId":"imp_c288","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-03-17","endDate":"2026-04-17","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 168"],"pendingReviewBoundary":false},
{"id":"imp_r511","customerId":"imp_c310","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-03-17","endDate":"2026-04-02","bookedDays":16,"paidDays":16,"revenue":2200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 171"],"pendingReviewBoundary":false},
{"id":"imp_r512","customerId":"imp_c311","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2026-03-17","endDate":"2026-03-26","bookedDays":9,"paidDays":9,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 170"],"pendingReviewBoundary":false},
{"id":"imp_r513","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-03-18","endDate":"2026-04-18","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 172"],"pendingReviewBoundary":false},
{"id":"imp_r514","customerId":"imp_c289","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-03-18","endDate":"2026-03-28","bookedDays":10,"paidDays":10,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 173"],"pendingReviewBoundary":false},
{"id":"imp_r515","customerId":"imp_c312","bikeModel":"Aerox black","bikeNameRaw":"Aerox black","plate":"","startDate":"2026-03-18","endDate":"2026-03-31","bookedDays":13,"paidDays":13,"revenue":2700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 174"],"pendingReviewBoundary":false},
{"id":"imp_r516","customerId":"imp_c313","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-03-19","endDate":"2026-03-26","bookedDays":7,"paidDays":7,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 175"],"pendingReviewBoundary":false},
{"id":"imp_r517","customerId":"imp_c314","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2026-03-19","endDate":"2026-04-02","bookedDays":14,"paidDays":14,"revenue":2300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 176"],"pendingReviewBoundary":false},
{"id":"imp_r518","customerId":"imp_c283","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-03-20","endDate":"2026-04-17","bookedDays":28,"paidDays":28,"revenue":2800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 179"],"pendingReviewBoundary":false},
{"id":"imp_r519","customerId":"imp_c291","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-03-20","endDate":"2026-04-20","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 177"],"pendingReviewBoundary":false},
{"id":"imp_r520","customerId":"imp_c49","bikeModel":"Cool 1","bikeNameRaw":"Cool 1","plate":"","startDate":"2026-03-22","endDate":"2026-04-22","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 180"],"pendingReviewBoundary":false},
{"id":"imp_r521","customerId":"imp_c315","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2026-03-22","endDate":"2026-04-05","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 181"],"pendingReviewBoundary":false},
{"id":"imp_r522","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-03-23","endDate":"2026-04-23","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 182"],"pendingReviewBoundary":false},
{"id":"imp_r523","customerId":"imp_c111","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2026-03-23","endDate":"2026-04-05","bookedDays":13,"paidDays":13,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 178"],"pendingReviewBoundary":false},
{"id":"imp_r524","customerId":"imp_c316","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-03-23","endDate":"2026-03-30","bookedDays":7,"paidDays":7,"revenue":2200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 184"],"pendingReviewBoundary":false},
{"id":"imp_r525","customerId":"imp_c317","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2026-03-23","endDate":"2026-04-07","bookedDays":15,"paidDays":15,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 183"],"pendingReviewBoundary":false},
{"id":"imp_r526","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2026-03-24","endDate":"2026-04-24","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 185"],"pendingReviewBoundary":false},
{"id":"imp_r527","customerId":"imp_c293","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2026-03-24","endDate":"2026-04-07","bookedDays":14,"paidDays":14,"revenue":1400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 186"],"pendingReviewBoundary":false},
{"id":"imp_r528","customerId":"imp_c318","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-03-24","endDate":"2026-03-29","bookedDays":5,"paidDays":5,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 188"],"pendingReviewBoundary":false},
{"id":"imp_r529","customerId":"imp_c319","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-03-24","endDate":"2026-04-24","bookedDays":31,"paidDays":31,"revenue":2600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 187"],"pendingReviewBoundary":false},
{"id":"imp_r530","customerId":"imp_c320","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-03-24","endDate":"2026-03-31","bookedDays":7,"paidDays":7,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 189"],"pendingReviewBoundary":false},
{"id":"imp_r531","customerId":"imp_c321","bikeModel":"Nmax Black","bikeNameRaw":"Nmax Black","plate":"","startDate":"2026-03-25","endDate":"2026-04-25","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 191"],"pendingReviewBoundary":false},
{"id":"imp_r532","customerId":"imp_c154","bikeModel":"GT burgandy","bikeNameRaw":"GT burgandy","plate":"","startDate":"2026-03-26","endDate":"2026-04-26","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 190"],"pendingReviewBoundary":false},
{"id":"imp_r533","customerId":"imp_c322","bikeModel":"RAX Blue","bikeNameRaw":"RAX Blue","plate":"","startDate":"2026-03-26","endDate":"2026-03-31","bookedDays":5,"paidDays":5,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 192"],"pendingReviewBoundary":false},
{"id":"imp_r534","customerId":"imp_c323","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-03-27","endDate":"2026-03-31","bookedDays":4,"paidDays":4,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 193"],"pendingReviewBoundary":false},
{"id":"imp_r535","customerId":"imp_c112","bikeModel":"nmax","bikeNameRaw":"nmax","plate":"","startDate":"2026-03-28","endDate":"2026-04-28","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 194"],"pendingReviewBoundary":false},
{"id":"imp_r536","customerId":"imp_c209","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2026-03-28","endDate":"2026-03-29","bookedDays":1,"paidDays":1,"revenue":400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 195"],"pendingReviewBoundary":false},
{"id":"imp_r537","customerId":"imp_c181","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-03-29","endDate":"2026-04-06","bookedDays":8,"paidDays":8,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 199"],"pendingReviewBoundary":false},
{"id":"imp_r538","customerId":"imp_c324","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-03-29","endDate":"2026-04-05","bookedDays":7,"paidDays":7,"revenue":1700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 196"],"pendingReviewBoundary":false},
{"id":"imp_r539","customerId":"imp_c325","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2026-03-29","endDate":"2026-03-30","bookedDays":1,"paidDays":1,"revenue":300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 197"],"pendingReviewBoundary":false},
{"id":"imp_r540","customerId":"imp_c247","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2026-03-30","endDate":"2026-04-30","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 198"],"pendingReviewBoundary":false},
{"id":"imp_r541","customerId":"imp_c326","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-03-30","endDate":"2026-04-17","bookedDays":18,"paidDays":18,"revenue":3100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 201"],"pendingReviewBoundary":false},
{"id":"imp_r542","customerId":"imp_c327","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-03-30","endDate":"2026-04-01","bookedDays":2,"paidDays":2,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 202"],"pendingReviewBoundary":false},
{"id":"imp_r543","customerId":"imp_c328","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2026-03-30","endDate":"2026-04-08","bookedDays":9,"paidDays":9,"revenue":2200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 200"],"pendingReviewBoundary":false},
{"id":"imp_r544","customerId":"imp_c62","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-03-31","endDate":"2026-04-05","bookedDays":5,"paidDays":5,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 205"],"pendingReviewBoundary":false},
{"id":"imp_r545","customerId":"imp_c329","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-03-31","endDate":"2026-04-30","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 206"],"pendingReviewBoundary":false},
{"id":"imp_r546","customerId":"imp_c330","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-03-31","endDate":"2026-04-04","bookedDays":4,"paidDays":4,"revenue":1650.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 203"],"pendingReviewBoundary":false},
{"id":"imp_r547","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2026-04-01","endDate":"2026-05-01","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 204"],"pendingReviewBoundary":false},
{"id":"imp_r548","customerId":"imp_c194","bikeModel":"Nmax Blue","bikeNameRaw":"Nmax Blue","plate":"","startDate":"2026-04-05","endDate":"2026-05-08","bookedDays":33,"paidDays":33,"revenue":5100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 209"],"pendingReviewBoundary":false},
{"id":"imp_r549","customerId":"imp_c284","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2026-04-07","endDate":"2026-05-07","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 212"],"pendingReviewBoundary":false},
{"id":"imp_r550","customerId":"imp_c331","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-04-07","endDate":"2026-04-17","bookedDays":10,"paidDays":10,"revenue":5000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 211"],"pendingReviewBoundary":false},
{"id":"imp_r551","customerId":"imp_c332","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-04-07","endDate":"2026-04-13","bookedDays":6,"paidDays":6,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 210"],"pendingReviewBoundary":false},
{"id":"imp_r552","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-04-09","endDate":"2026-05-09","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 208"],"pendingReviewBoundary":false},
{"id":"imp_r553","customerId":"imp_c333","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2026-04-09","endDate":"2026-05-09","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 216"],"pendingReviewBoundary":false},
{"id":"imp_r554","customerId":"imp_c334","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-04-09","endDate":"2026-05-06","bookedDays":27,"paidDays":27,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 214"],"pendingReviewBoundary":false},
{"id":"imp_r555","customerId":"imp_c335","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-04-09","endDate":"2026-04-11","bookedDays":2,"paidDays":2,"revenue":600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 215"],"pendingReviewBoundary":false},
{"id":"imp_r556","customerId":"imp_c336","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2026-04-09","endDate":"2026-04-10","bookedDays":1,"paidDays":1,"revenue":300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 217"],"pendingReviewBoundary":false},
{"id":"imp_r557","customerId":"imp_c337","bikeModel":"RAX Blue, RAX Red and Cool Blue 2","bikeNameRaw":"RAX Blue, RAX Red and Cool Blue 2","plate":"","startDate":"2026-04-11","endDate":"2026-04-13","bookedDays":2,"paidDays":2,"revenue":2400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 218"],"pendingReviewBoundary":false},
{"id":"imp_r558","customerId":"imp_c338","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-04-11","endDate":"2026-04-13","bookedDays":2,"paidDays":2,"revenue":600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 219"],"pendingReviewBoundary":false},
{"id":"imp_r559","customerId":"imp_c339","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-04-12","endDate":"2026-04-15","bookedDays":3,"paidDays":3,"revenue":1160.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 220"],"pendingReviewBoundary":false},
{"id":"imp_r560","customerId":"imp_c340","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2026-04-15","endDate":"2026-04-19","bookedDays":4,"paidDays":4,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 221"],"pendingReviewBoundary":false},
{"id":"imp_r561","customerId":"imp_c283","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-04-17","endDate":"2026-04-23","bookedDays":6,"paidDays":6,"revenue":600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 222"],"pendingReviewBoundary":false},
{"id":"imp_r562","customerId":"imp_c288","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-04-17","endDate":"2026-05-17","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 213"],"pendingReviewBoundary":false},
{"id":"imp_r563","customerId":"imp_c341","bikeModel":"GT black 6","bikeNameRaw":"GT black 6","plate":"","startDate":"2026-04-17","endDate":"2026-05-11","bookedDays":24,"paidDays":24,"revenue":2800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 223"],"pendingReviewBoundary":false},
{"id":"imp_r564","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-04-18","endDate":"2026-05-13","bookedDays":25,"paidDays":25,"revenue":2100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 227"],"pendingReviewBoundary":false},
{"id":"imp_r565","customerId":"imp_c342","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2026-04-18","endDate":"2026-05-01","bookedDays":13,"paidDays":13,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 225"],"pendingReviewBoundary":false},
{"id":"imp_r566","customerId":"imp_c343","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-04-18","endDate":"2026-04-19","bookedDays":1,"paidDays":1,"revenue":700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 224"],"pendingReviewBoundary":false},
{"id":"imp_r567","customerId":"imp_c291","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-04-20","endDate":"2026-05-20","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 226"],"pendingReviewBoundary":false},
{"id":"imp_r568","customerId":"imp_c344","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-04-20","endDate":"2026-04-28","bookedDays":8,"paidDays":8,"revenue":2100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 228"],"pendingReviewBoundary":false},
{"id":"imp_r569","customerId":"imp_c111","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2026-04-21","endDate":"2026-05-30","bookedDays":39,"paidDays":39,"revenue":4700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 230"],"pendingReviewBoundary":false},
{"id":"imp_r570","customerId":"imp_c49","bikeModel":"Cool 1","bikeNameRaw":"Cool 1","plate":"","startDate":"2026-04-22","endDate":"2026-05-28","bookedDays":36,"paidDays":36,"revenue":4700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 231"],"pendingReviewBoundary":false},
{"id":"imp_r571","customerId":"imp_c61","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-04-23","endDate":"2026-05-23","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 233"],"pendingReviewBoundary":false},
{"id":"imp_r572","customerId":"imp_c283","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-04-23","endDate":"2026-04-25","bookedDays":2,"paidDays":2,"revenue":500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 232"],"pendingReviewBoundary":false},
{"id":"imp_r573","customerId":"imp_c51","bikeModel":"Aerox Red","bikeNameRaw":"Aerox Red","plate":"","startDate":"2026-04-24","endDate":"2026-04-30","bookedDays":6,"paidDays":6,"revenue":720.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 229"],"pendingReviewBoundary":false},
{"id":"imp_r574","customerId":"imp_c345","bikeModel":"Nmax black","bikeNameRaw":"Nmax black","plate":"","startDate":"2026-04-24","endDate":"2026-05-24","bookedDays":30,"paidDays":30,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 236"],"pendingReviewBoundary":false},
{"id":"imp_r575","customerId":"imp_c346","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-04-24","endDate":"2026-04-24","bookedDays":0,"paidDays":0,"revenue":600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 235"],"pendingReviewBoundary":false},
{"id":"imp_r576","customerId":"imp_c347","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-04-25","endDate":"2026-04-29","bookedDays":4,"paidDays":4,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 237"],"pendingReviewBoundary":false},
{"id":"imp_r577","customerId":"imp_c348","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2026-04-25","endDate":"2026-05-02","bookedDays":7,"paidDays":7,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 238"],"pendingReviewBoundary":false},
{"id":"imp_r578","customerId":"imp_c349","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2026-04-26","endDate":"2026-05-03","bookedDays":7,"paidDays":7,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 239"],"pendingReviewBoundary":false},
{"id":"imp_r579","customerId":"imp_c350","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-04-26","endDate":"2026-05-03","bookedDays":7,"paidDays":7,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 240"],"pendingReviewBoundary":false},
{"id":"imp_r580","customerId":"imp_c351","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2026-04-27","endDate":"2026-04-29","bookedDays":2,"paidDays":2,"revenue":700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 241"],"pendingReviewBoundary":false},
{"id":"imp_r581","customerId":"imp_c352","bikeModel":"GT Burgandy","bikeNameRaw":"GT Burgandy","plate":"","startDate":"2026-04-27","endDate":"2026-05-11","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 242"],"pendingReviewBoundary":false},
{"id":"imp_r582","customerId":"imp_c112","bikeModel":"nmax","bikeNameRaw":"nmax","plate":"","startDate":"2026-04-28","endDate":"2026-05-28","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 243"],"pendingReviewBoundary":false},
{"id":"imp_r583","customerId":"imp_c247","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2026-04-30","endDate":"2026-05-30","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 244"],"pendingReviewBoundary":false},
{"id":"imp_r584","customerId":"imp_c329","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-04-30","endDate":"2026-05-31","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 245"],"pendingReviewBoundary":false},
{"id":"imp_r585","customerId":"imp_c353","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2026-04-30","endDate":"2026-05-01","bookedDays":1,"paidDays":1,"revenue":600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 248"],"pendingReviewBoundary":false},
{"id":"imp_r586","customerId":"imp_c354","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-04-30","endDate":"2026-05-30","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 246"],"pendingReviewBoundary":false},
{"id":"imp_r587","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2026-05-01","endDate":"2026-06-01","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 247"],"pendingReviewBoundary":false},
{"id":"imp_r588","customerId":"imp_c283","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-05-01","endDate":"2026-05-07","bookedDays":6,"paidDays":6,"revenue":900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 251"],"pendingReviewBoundary":false},
{"id":"imp_r589","customerId":"imp_c355","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2026-05-01","endDate":"2026-05-08","bookedDays":7,"paidDays":7,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 234"],"pendingReviewBoundary":false},
{"id":"imp_r590","customerId":"imp_c356","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-05-01","endDate":"2026-05-03","bookedDays":2,"paidDays":2,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 250"],"pendingReviewBoundary":false},
{"id":"imp_r591","customerId":"imp_c357","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-05-04","endDate":"2026-05-18","bookedDays":14,"paidDays":14,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 253"],"pendingReviewBoundary":false},
{"id":"imp_r592","customerId":"imp_c358","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-05-05","endDate":"2026-05-07","bookedDays":2,"paidDays":2,"revenue":900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 254"],"pendingReviewBoundary":false},
{"id":"imp_r593","customerId":"imp_c359","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2026-05-05","endDate":"2026-06-05","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 256"],"pendingReviewBoundary":false},
{"id":"imp_r594","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2026-05-06","endDate":"2026-07-06","bookedDays":61,"paidDays":61,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 258"],"pendingReviewBoundary":false},
{"id":"imp_r595","customerId":"imp_c360","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-05-06","endDate":"2026-05-12","bookedDays":6,"paidDays":6,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 257"],"pendingReviewBoundary":false},
{"id":"imp_r596","customerId":"imp_c361","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-05-06","endDate":"2026-05-13","bookedDays":7,"paidDays":7,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 260"],"pendingReviewBoundary":false},
{"id":"imp_r597","customerId":"imp_c362","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2026-05-06","endDate":"2026-05-19","bookedDays":13,"paidDays":13,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 259"],"pendingReviewBoundary":false},
{"id":"imp_r598","customerId":"imp_c284","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2026-05-07","endDate":"2026-06-07","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 255"],"pendingReviewBoundary":false},
{"id":"imp_r599","customerId":"imp_c363","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-05-07","endDate":"2026-05-21","bookedDays":14,"paidDays":14,"revenue":2700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 264"],"pendingReviewBoundary":false},
{"id":"imp_r600","customerId":"imp_c364","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2026-05-07","endDate":"2026-05-11","bookedDays":4,"paidDays":4,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 262"],"pendingReviewBoundary":false},
{"id":"imp_r601","customerId":"imp_c365","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-05-07","endDate":"2026-05-09","bookedDays":2,"paidDays":2,"revenue":800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 263"],"pendingReviewBoundary":false},
{"id":"imp_r602","customerId":"imp_c366","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-05-07","endDate":"2026-06-07","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 261"],"pendingReviewBoundary":false},
{"id":"imp_r603","customerId":"imp_c367","bikeModel":"Aerox Red 1","bikeNameRaw":"Aerox Red 1","plate":"","startDate":"2026-05-08","endDate":"2026-05-10","bookedDays":2,"paidDays":2,"revenue":800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 265"],"pendingReviewBoundary":false},
{"id":"imp_r604","customerId":"imp_c368","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-05-08","endDate":"2026-05-19","bookedDays":11,"paidDays":11,"revenue":4900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 266"],"pendingReviewBoundary":false},
{"id":"imp_r605","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-05-09","endDate":"2026-06-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 252"],"pendingReviewBoundary":false},
{"id":"imp_r606","customerId":"imp_c369","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2026-05-11","endDate":"2026-06-22","bookedDays":42,"paidDays":42,"revenue":4200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 267"],"pendingReviewBoundary":false},
{"id":"imp_r607","customerId":"imp_c370","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2026-05-11","endDate":"2026-05-14","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 269"],"pendingReviewBoundary":false},
{"id":"imp_r608","customerId":"imp_c371","bikeModel":"Nmax Blue","bikeNameRaw":"Nmax Blue","plate":"","startDate":"2026-05-12","endDate":"2026-06-12","bookedDays":31,"paidDays":31,"revenue":5000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 270"],"pendingReviewBoundary":false},
{"id":"imp_r609","customerId":"imp_c372","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-05-13","endDate":"2026-06-13","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 271"],"pendingReviewBoundary":false},
{"id":"imp_r610","customerId":"imp_c288","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-05-17","endDate":"2026-06-17","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 268"],"pendingReviewBoundary":false},
{"id":"imp_r611","customerId":"imp_c373","bikeModel":"Nmax grey","bikeNameRaw":"Nmax grey","plate":"","startDate":"2026-05-18","endDate":"2026-05-20","bookedDays":2,"paidDays":2,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 272"],"pendingReviewBoundary":false},
{"id":"imp_r612","customerId":"imp_c291","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-05-20","endDate":"2026-06-20","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 273"],"pendingReviewBoundary":false},
{"id":"imp_r613","customerId":"imp_c374","bikeModel":"GT red 1/ GT Red 2/ GT 3 and GT black 4","bikeNameRaw":"GT red 1/ GT Red 2/ GT 3 and GT black 4","plate":"","startDate":"2026-05-20","endDate":"2026-05-23","bookedDays":3,"paidDays":3,"revenue":2400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 276"],"pendingReviewBoundary":false},
{"id":"imp_r614","customerId":"imp_c375","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2026-05-20","endDate":"2026-06-03","bookedDays":14,"paidDays":14,"revenue":2800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 274"],"pendingReviewBoundary":false},
{"id":"imp_r615","customerId":"imp_c376","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-05-20","endDate":"2026-06-20","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 275"],"pendingReviewBoundary":false},
{"id":"imp_r616","customerId":"imp_c289","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-05-21","endDate":"2026-05-24","bookedDays":3,"paidDays":3,"revenue":500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 277"],"pendingReviewBoundary":false},
{"id":"imp_r617","customerId":"imp_c377","bikeModel":"Aerox red 1","bikeNameRaw":"Aerox red 1","plate":"","startDate":"2026-05-21","endDate":"2026-05-24","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 278"],"pendingReviewBoundary":false},
{"id":"imp_r618","customerId":"imp_c378","bikeModel":"Cool blue 2","bikeNameRaw":"Cool blue 2","plate":"","startDate":"2026-05-23","endDate":"2026-06-23","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 281"],"pendingReviewBoundary":false},
{"id":"imp_r619","customerId":"imp_c379","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-05-23","endDate":"2026-05-29","bookedDays":6,"paidDays":6,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 280"],"pendingReviewBoundary":false},
{"id":"imp_r620","customerId":"imp_c345","bikeModel":"Nmax black","bikeNameRaw":"Nmax black","plate":"","startDate":"2026-05-24","endDate":"2026-07-17","bookedDays":54,"paidDays":54,"revenue":7950.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 279"],"pendingReviewBoundary":false},
{"id":"imp_r621","customerId":"imp_c380","bikeModel":"Nmax Grey","bikeNameRaw":"Nmax Grey","plate":"","startDate":"2026-05-25","endDate":"2026-06-25","bookedDays":31,"paidDays":31,"revenue":5000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 282"],"pendingReviewBoundary":false},
{"id":"imp_r622","customerId":"imp_c381","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-05-25","endDate":"2026-05-30","bookedDays":5,"paidDays":5,"revenue":1100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 283"],"pendingReviewBoundary":false},
{"id":"imp_r623","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-05-27","endDate":"2026-07-20","bookedDays":54,"paidDays":54,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 329"],"pendingReviewBoundary":false},
{"id":"imp_r624","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-05-27","endDate":"2026-06-27","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 285"],"pendingReviewBoundary":false},
{"id":"imp_r625","customerId":"imp_c382","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-05-27","endDate":"2026-05-30","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 286"],"pendingReviewBoundary":false},
{"id":"imp_r626","customerId":"imp_c383","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-05-27","endDate":"2026-06-08","bookedDays":12,"paidDays":12,"revenue":5000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 284"],"pendingReviewBoundary":false},
{"id":"imp_r627","customerId":"imp_c64","bikeModel":"GT red 2","bikeNameRaw":"GT red 2","plate":"","startDate":"2026-05-28","endDate":"2026-06-19","bookedDays":22,"paidDays":22,"revenue":2750.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 288"],"pendingReviewBoundary":false},
{"id":"imp_r628","customerId":"imp_c112","bikeModel":"nmax","bikeNameRaw":"nmax","plate":"","startDate":"2026-05-28","endDate":"2026-06-15","bookedDays":18,"paidDays":18,"revenue":2100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 289"],"pendingReviewBoundary":false},
{"id":"imp_r629","customerId":"imp_c173","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-05-28","endDate":"2026-06-28","bookedDays":31,"paidDays":31,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 287"],"pendingReviewBoundary":false},
{"id":"imp_r630","customerId":"imp_c111","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2026-05-30","endDate":"2026-06-08","bookedDays":9,"paidDays":9,"revenue":5800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 292"],"pendingReviewBoundary":false},
{"id":"imp_r631","customerId":"imp_c247","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2026-05-30","endDate":"2026-06-30","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 290"],"pendingReviewBoundary":false},
{"id":"imp_r632","customerId":"imp_c384","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-05-30","endDate":"2026-06-04","bookedDays":5,"paidDays":5,"revenue":1250.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 293"],"pendingReviewBoundary":false},
{"id":"imp_r633","customerId":"imp_c329","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-05-31","endDate":"2026-06-30","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 291"],"pendingReviewBoundary":false},
{"id":"imp_r634","customerId":"imp_c385","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-05-31","endDate":"2026-06-30","bookedDays":30,"paidDays":30,"revenue":3200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 294"],"pendingReviewBoundary":false},
{"id":"imp_r635","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2026-06-01","endDate":"2026-07-01","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 295"],"pendingReviewBoundary":false},
{"id":"imp_r636","customerId":"imp_c386","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-06-01","endDate":"2026-06-04","bookedDays":3,"paidDays":3,"revenue":900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 300"],"pendingReviewBoundary":false},
{"id":"imp_r637","customerId":"imp_c387","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2026-06-01","endDate":"2026-07-01","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 301"],"pendingReviewBoundary":false},
{"id":"imp_r638","customerId":"imp_c388","bikeModel":"RAX Red","bikeNameRaw":"RAX Red","plate":"","startDate":"2026-06-01","endDate":"2026-06-18","bookedDays":17,"paidDays":17,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 298"],"pendingReviewBoundary":false},
{"id":"imp_r639","customerId":"imp_c389","bikeModel":"Cool 1","bikeNameRaw":"Cool 1","plate":"","startDate":"2026-06-01","endDate":"2026-06-07","bookedDays":6,"paidDays":6,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 299"],"pendingReviewBoundary":false},
{"id":"imp_r640","customerId":"imp_c59","bikeModel":"Cool 1","bikeNameRaw":"Cool 1","plate":"","startDate":"2026-06-02","endDate":"2026-07-20","bookedDays":48,"paidDays":48,"revenue":6300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 302"],"pendingReviewBoundary":false},
{"id":"imp_r641","customerId":"imp_c390","bikeModel":"Aerox red 1","bikeNameRaw":"Aerox red 1","plate":"","startDate":"2026-06-02","endDate":"2026-06-05","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 304"],"pendingReviewBoundary":false},
{"id":"imp_r642","customerId":"imp_c362","bikeModel":"GT black 4","bikeNameRaw":"GT black 4","plate":"","startDate":"2026-06-03","endDate":"2026-06-13","bookedDays":10,"paidDays":10,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 305"],"pendingReviewBoundary":false},
{"id":"imp_r643","customerId":"imp_c375","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2026-06-03","endDate":"2026-06-16","bookedDays":13,"paidDays":13,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 303"],"pendingReviewBoundary":false},
{"id":"imp_r644","customerId":"imp_c391","bikeModel":"Freego Red","bikeNameRaw":"Freego Red","plate":"","startDate":"2026-06-04","endDate":"2026-06-14","bookedDays":10,"paidDays":10,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 308"],"pendingReviewBoundary":false},
{"id":"imp_r645","customerId":"imp_c392","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2026-06-04","endDate":"2026-06-14","bookedDays":10,"paidDays":10,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 307"],"pendingReviewBoundary":false},
{"id":"imp_r646","customerId":"imp_c359","bikeModel":"GT black 2","bikeNameRaw":"GT black 2","plate":"","startDate":"2026-06-05","endDate":"2026-07-05","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 306"],"pendingReviewBoundary":false},
{"id":"imp_r647","customerId":"imp_c393","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-06-06","endDate":"2026-06-13","bookedDays":7,"paidDays":7,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 309"],"pendingReviewBoundary":false},
{"id":"imp_r648","customerId":"imp_c284","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2026-06-07","endDate":"2026-07-07","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 310"],"pendingReviewBoundary":false},
{"id":"imp_r649","customerId":"imp_c394","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-06-08","endDate":"2026-07-08","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 312"],"pendingReviewBoundary":false},
{"id":"imp_r650","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-06-09","endDate":"2026-07-09","bookedDays":30,"paidDays":30,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 297"],"pendingReviewBoundary":false},
{"id":"imp_r651","customerId":"imp_c395","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2026-06-11","endDate":"2026-06-14","bookedDays":3,"paidDays":3,"revenue":1400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 314"],"pendingReviewBoundary":false},
{"id":"imp_r652","customerId":"imp_c396","bikeModel":"Aerox red 1","bikeNameRaw":"Aerox red 1","plate":"","startDate":"2026-06-11","endDate":"2026-07-11","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 313"],"pendingReviewBoundary":false},
{"id":"imp_r653","customerId":"imp_c397","bikeModel":"Forza","bikeNameRaw":"Forza","plate":"","startDate":"2026-06-12","endDate":"2026-06-19","bookedDays":7,"paidDays":7,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 315"],"pendingReviewBoundary":false},
{"id":"imp_r654","customerId":"imp_c398","bikeModel":"GT 3","bikeNameRaw":"GT 3","plate":"","startDate":"2026-06-15","endDate":"2026-07-04","bookedDays":19,"paidDays":19,"revenue":2600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 316"],"pendingReviewBoundary":false},
{"id":"imp_r655","customerId":"imp_c399","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-06-16","endDate":"2026-06-23","bookedDays":7,"paidDays":7,"revenue":1400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 317"],"pendingReviewBoundary":false},
{"id":"imp_r656","customerId":"imp_c400","bikeModel":"GT 2","bikeNameRaw":"GT 2","plate":"","startDate":"2026-06-16","endDate":"2026-06-25","bookedDays":9,"paidDays":9,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 318"],"pendingReviewBoundary":false},
{"id":"imp_r657","customerId":"imp_c288","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-06-17","endDate":"2026-07-17","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 311"],"pendingReviewBoundary":false},
{"id":"imp_r658","customerId":"imp_c401","bikeModel":"Cool blue 1","bikeNameRaw":"Cool blue 1","plate":"","startDate":"2026-06-17","endDate":"2026-06-22","bookedDays":5,"paidDays":5,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 320"],"pendingReviewBoundary":false},
{"id":"imp_r659","customerId":"imp_c402","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-06-17","endDate":"2026-06-20","bookedDays":3,"paidDays":3,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 319"],"pendingReviewBoundary":false},
{"id":"imp_r660","customerId":"imp_c403","bikeModel":"RAX blue","bikeNameRaw":"RAX blue","plate":"","startDate":"2026-06-18","endDate":"2026-06-24","bookedDays":6,"paidDays":6,"revenue":1700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 321"],"pendingReviewBoundary":false},
{"id":"imp_r661","customerId":"imp_c404","bikeModel":"RAX 3","bikeNameRaw":"RAX 3","plate":"","startDate":"2026-06-19","endDate":"2026-07-09","bookedDays":20,"paidDays":20,"revenue":3350.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 323"],"pendingReviewBoundary":false},
{"id":"imp_r662","customerId":"imp_c291","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-06-20","endDate":"2026-07-20","bookedDays":30,"paidDays":30,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 322"],"pendingReviewBoundary":false},
{"id":"imp_r663","customerId":"imp_c405","bikeModel":"GT red 2 / RAX red","bikeNameRaw":"GT red 2 / RAX red","plate":"","startDate":"2026-06-22","endDate":"2026-06-25","bookedDays":3,"paidDays":3,"revenue":2100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 324"],"pendingReviewBoundary":false},
{"id":"imp_r664","customerId":"imp_c403","bikeModel":"Xmax","bikeNameRaw":"Xmax","plate":"","startDate":"2026-06-23","endDate":"2026-07-23","bookedDays":30,"paidDays":30,"revenue":10000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 325"],"pendingReviewBoundary":false},
{"id":"imp_r665","customerId":"imp_c406","bikeModel":"GT red 1","bikeNameRaw":"GT red 1","plate":"","startDate":"2026-06-23","endDate":"2026-06-30","bookedDays":7,"paidDays":7,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 326"],"pendingReviewBoundary":false},
{"id":"imp_r666","customerId":"imp_c407","bikeModel":"RAX Blue","bikeNameRaw":"RAX Blue","plate":"","startDate":"2026-06-24","endDate":"2026-07-05","bookedDays":11,"paidDays":11,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 327"],"pendingReviewBoundary":false},
{"id":"imp_r667","customerId":"imp_c405","bikeModel":"RAX red/ Nmax white","bikeNameRaw":"RAX red/ Nmax white","plate":"","startDate":"2026-06-25","endDate":"2026-06-28","bookedDays":3,"paidDays":3,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 328"],"pendingReviewBoundary":false},
{"id":"imp_r668","customerId":"imp_c408","bikeModel":"Aerox Green","bikeNameRaw":"Aerox Green","plate":"","startDate":"2026-06-26","endDate":"2026-07-04","bookedDays":8,"paidDays":8,"revenue":2000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 331"],"pendingReviewBoundary":false},
{"id":"imp_r669","customerId":"imp_c409","bikeModel":"Nmax grey 1","bikeNameRaw":"Nmax grey 1","plate":"","startDate":"2026-06-27","endDate":"2026-07-27","bookedDays":30,"paidDays":30,"revenue":4700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 332"],"pendingReviewBoundary":false},
{"id":"imp_r670","customerId":"imp_c173","bikeModel":"Nmax Blue","bikeNameRaw":"Nmax Blue","plate":"","startDate":"2026-06-28","endDate":"2026-07-28","bookedDays":30,"paidDays":30,"revenue":5250.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 330"],"pendingReviewBoundary":false},
{"id":"imp_r671","customerId":"imp_c410","bikeModel":"GT 2 / GT black 4","bikeNameRaw":"GT 2 / GT black 4","plate":"","startDate":"2026-06-28","endDate":"2026-07-01","bookedDays":3,"paidDays":3,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 333"],"pendingReviewBoundary":false},
{"id":"imp_r672","customerId":"imp_c411","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2026-06-29","endDate":"2026-07-04","bookedDays":5,"paidDays":5,"revenue":1200.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 337"],"pendingReviewBoundary":false},
{"id":"imp_r673","customerId":"imp_c247","bikeModel":"GT black 1","bikeNameRaw":"GT black 1","plate":"","startDate":"2026-06-30","endDate":"2026-07-17","bookedDays":17,"paidDays":17,"revenue":1700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 334"],"pendingReviewBoundary":false},
{"id":"imp_r674","customerId":"imp_c329","bikeModel":"RAX 2","bikeNameRaw":"RAX 2","plate":"","startDate":"2026-06-30","endDate":"2026-07-30","bookedDays":30,"paidDays":30,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 335"],"pendingReviewBoundary":false},
{"id":"imp_r675","customerId":"imp_c385","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-06-30","endDate":"2026-07-31","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 336"],"pendingReviewBoundary":false},
{"id":"imp_r676","customerId":"imp_c412","bikeModel":"Cool Blue 2","bikeNameRaw":"Cool Blue 2","plate":"","startDate":"2026-06-30","endDate":"2026-07-30","bookedDays":30,"paidDays":30,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 340"],"pendingReviewBoundary":false},
{"id":"imp_r677","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2026-07-01","endDate":"2026-08-01","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 338"],"pendingReviewBoundary":false},
{"id":"imp_r678","customerId":"imp_c387","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2026-07-01","endDate":"2026-08-01","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 339"],"pendingReviewBoundary":false},
{"id":"imp_r679","customerId":"imp_c413","bikeModel":"RAX 1","bikeNameRaw":"RAX 1","plate":"","startDate":"2026-07-01","endDate":"2026-10-01","bookedDays":92,"paidDays":92,"revenue":9500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 342"],"pendingReviewBoundary":false},
{"id":"imp_r680","customerId":"imp_c104","bikeModel":"Cool 2","bikeNameRaw":"Cool 2","plate":"","startDate":"2026-07-02","endDate":"2026-07-10","bookedDays":8,"paidDays":8,"revenue":2100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 343"],"pendingReviewBoundary":false},
{"id":"imp_r681","customerId":"imp_c120","bikeModel":"GT black 5","bikeNameRaw":"GT black 5","plate":"","startDate":"2026-07-03","endDate":"2026-08-01","bookedDays":29,"paidDays":29,"revenue":2930.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 345"],"pendingReviewBoundary":false},
{"id":"imp_r682","customerId":"imp_c414","bikeModel":"GT Black 4","bikeNameRaw":"GT Black 4","plate":"","startDate":"2026-07-04","endDate":"2026-07-07","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 346"],"pendingReviewBoundary":false},
{"id":"imp_r683","customerId":"imp_c69","bikeModel":"rax red (155)","bikeNameRaw":"rax red (155)","plate":"","startDate":"2026-07-05","endDate":"2026-07-10","bookedDays":5,"paidDays":5,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 347"],"pendingReviewBoundary":false},
{"id":"imp_r684","customerId":"imp_c88","bikeModel":"Zoomer X","bikeNameRaw":"Zoomer X","plate":"","startDate":"2026-07-06","endDate":"2026-09-06","bookedDays":62,"paidDays":62,"revenue":4000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 359"],"pendingReviewBoundary":false},
{"id":"imp_r685","customerId":"imp_c415","bikeModel":"aerox cool blue 1 (155)","bikeNameRaw":"aerox cool blue 1 (155)","plate":"","startDate":"2026-07-06","endDate":"2026-08-01","bookedDays":26,"paidDays":26,"revenue":4500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 348"],"pendingReviewBoundary":false},
{"id":"imp_r686","customerId":"imp_c284","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2026-07-07","endDate":"2026-07-21","bookedDays":14,"paidDays":14,"revenue":2600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 349"],"pendingReviewBoundary":false},
{"id":"imp_r687","customerId":"imp_c416","bikeModel":"gt 2  (125)","bikeNameRaw":"gt 2  (125)","plate":"","startDate":"2026-07-08","endDate":"2026-07-11","bookedDays":3,"paidDays":3,"revenue":800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 351"],"pendingReviewBoundary":false},
{"id":"imp_r688","customerId":"imp_c417","bikeModel":"nmax grey 2 (155)","bikeNameRaw":"nmax grey 2 (155)","plate":"","startDate":"2026-07-08","endDate":"2026-08-01","bookedDays":24,"paidDays":24,"revenue":5000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 350"],"pendingReviewBoundary":false},
{"id":"imp_r689","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-07-09","endDate":"2026-08-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 344"],"pendingReviewBoundary":false},
{"id":"imp_r690","customerId":"imp_c349","bikeModel":"rax blue (155)","bikeNameRaw":"rax blue (155)","plate":"","startDate":"2026-07-09","endDate":"2026-07-13","bookedDays":4,"paidDays":4,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 354"],"pendingReviewBoundary":false},
{"id":"imp_r691","customerId":"imp_c350","bikeModel":"nmax white (155)","bikeNameRaw":"nmax white (155)","plate":"","startDate":"2026-07-09","endDate":"2026-07-13","bookedDays":4,"paidDays":4,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 355"],"pendingReviewBoundary":false},
{"id":"imp_r692","customerId":"imp_c418","bikeModel":"gt  black 2  (125)","bikeNameRaw":"gt  black 2  (125)","plate":"","startDate":"2026-07-09","endDate":"2026-08-30","bookedDays":52,"paidDays":52,"revenue":6000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 353"],"pendingReviewBoundary":false},
{"id":"imp_r693","customerId":"imp_c396","bikeModel":"Aerox red 1","bikeNameRaw":"Aerox red 1","plate":"","startDate":"2026-07-11","endDate":"2026-08-11","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 356"],"pendingReviewBoundary":false},
{"id":"imp_r694","customerId":"imp_c416","bikeModel":"freego white  (125)","bikeNameRaw":"freego white  (125)","plate":"","startDate":"2026-07-11","endDate":"2026-08-01","bookedDays":21,"paidDays":21,"revenue":3300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 358"],"pendingReviewBoundary":false},
{"id":"imp_r695","customerId":"imp_c419","bikeModel":"rax 3 (155)","bikeNameRaw":"rax 3 (155)","plate":"","startDate":"2026-07-11","endDate":"2026-07-18","bookedDays":7,"paidDays":7,"revenue":1800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 357"],"pendingReviewBoundary":false},
{"id":"imp_r696","customerId":"imp_c420","bikeModel":"Aerox cool 2","bikeNameRaw":"Aerox cool 2","plate":"","startDate":"2026-07-13","endDate":"2026-08-15","bookedDays":33,"paidDays":33,"revenue":4800.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 360"],"pendingReviewBoundary":false},
{"id":"imp_r697","customerId":"imp_c421","bikeModel":"Rax red","bikeNameRaw":"Rax red","plate":"","startDate":"2026-07-15","endDate":"2026-07-19","bookedDays":4,"paidDays":4,"revenue":1500.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 361"],"pendingReviewBoundary":false},
{"id":"imp_r698","customerId":"imp_c422","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2026-07-16","endDate":"2026-07-31","bookedDays":15,"paidDays":15,"revenue":2700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 362"],"pendingReviewBoundary":false},
{"id":"imp_r699","customerId":"imp_c288","bikeModel":"Grand Filano 2","bikeNameRaw":"Grand Filano 2","plate":"","startDate":"2026-07-17","endDate":"2026-08-18","bookedDays":32,"paidDays":32,"revenue":3000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 352"],"pendingReviewBoundary":false},
{"id":"imp_r700","customerId":"imp_c423","bikeModel":"Nmax white","bikeNameRaw":"Nmax white","plate":"","startDate":"2026-07-17","endDate":"2026-08-25","bookedDays":39,"paidDays":39,"revenue":6500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 363"],"pendingReviewBoundary":false},
{"id":"imp_r701","customerId":"imp_c424","bikeModel":"Nmax black","bikeNameRaw":"Nmax black","plate":"","startDate":"2026-07-18","endDate":"2026-08-10","bookedDays":23,"paidDays":23,"revenue":4000.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 364"],"pendingReviewBoundary":false},
{"id":"imp_r702","customerId":"imp_c421","bikeModel":"Rax blue","bikeNameRaw":"Rax blue","plate":"","startDate":"2026-07-19","endDate":"2026-07-21","bookedDays":2,"paidDays":2,"revenue":300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 365"],"pendingReviewBoundary":false},
{"id":"imp_r703","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-07-20","endDate":"2026-08-20","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 366"],"pendingReviewBoundary":false},
{"id":"imp_r704","customerId":"imp_c291","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-07-20","endDate":"2026-08-20","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 367"],"pendingReviewBoundary":false},
{"id":"imp_r705","customerId":"imp_c403","bikeModel":"Xmax","bikeNameRaw":"Xmax","plate":"","startDate":"2026-07-23","endDate":"2026-08-23","bookedDays":31,"paidDays":31,"revenue":10000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 368"],"pendingReviewBoundary":false},
{"id":"imp_r706","customerId":"imp_c425","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2026-07-24","endDate":"2026-07-27","bookedDays":3,"paidDays":3,"revenue":1100.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 369"],"pendingReviewBoundary":false},
{"id":"imp_r707","customerId":"imp_c426","bikeModel":"Rax red","bikeNameRaw":"Rax red","plate":"","startDate":"2026-07-25","endDate":"2026-07-26","bookedDays":1,"paidDays":1,"revenue":400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 370"],"pendingReviewBoundary":false},
{"id":"imp_r708","customerId":"imp_c427","bikeModel":"Aerox cool 1","bikeNameRaw":"Aerox cool 1","plate":"","startDate":"2026-07-26","endDate":"2026-07-31","bookedDays":5,"paidDays":5,"revenue":1600.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 371"],"pendingReviewBoundary":false},
{"id":"imp_r709","customerId":"imp_c409","bikeModel":"Nmax grey 1","bikeNameRaw":"Nmax grey 1","plate":"","startDate":"2026-07-27","endDate":"2026-08-27","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 374"],"pendingReviewBoundary":false},
{"id":"imp_r710","customerId":"imp_c173","bikeModel":"Nmax Blue","bikeNameRaw":"Nmax Blue","plate":"","startDate":"2026-07-28","endDate":"2026-08-28","bookedDays":31,"paidDays":31,"revenue":5000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 372"],"pendingReviewBoundary":false},
{"id":"imp_r711","customerId":"imp_c428","bikeModel":"Aerox red 2","bikeNameRaw":"Aerox red 2","plate":"","startDate":"2026-07-28","endDate":"2026-07-31","bookedDays":3,"paidDays":3,"revenue":339.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 373"],"pendingReviewBoundary":false},
{"id":"imp_r712","customerId":"imp_c412","bikeModel":"Cool Blue 2","bikeNameRaw":"Cool Blue 2","plate":"","startDate":"2026-07-30","endDate":"2026-08-30","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 377"],"pendingReviewBoundary":false},
{"id":"imp_r713","customerId":"imp_c369","bikeModel":"Aerox green","bikeNameRaw":"Aerox green","plate":"","startDate":"2026-07-31","endDate":"2026-08-31","bookedDays":31,"paidDays":31,"revenue":3387.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 380"],"pendingReviewBoundary":false},
{"id":"imp_r714","customerId":"imp_c369","bikeModel":"Rax blue","bikeNameRaw":"Rax blue","plate":"","startDate":"2026-07-31","endDate":"2026-07-31","bookedDays":0,"paidDays":0,"revenue":113.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 378"],"pendingReviewBoundary":false},
{"id":"imp_r715","customerId":"imp_c385","bikeModel":"GT silver 1","bikeNameRaw":"GT silver 1","plate":"","startDate":"2026-07-31","endDate":"2026-08-31","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 375"],"pendingReviewBoundary":false},
{"id":"imp_r716","customerId":"imp_c428","bikeModel":"Rax red","bikeNameRaw":"Rax red","plate":"","startDate":"2026-07-31","endDate":"2026-08-28","bookedDays":28,"paidDays":28,"revenue":3161.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 376"],"pendingReviewBoundary":false},
{"id":"imp_r717","customerId":"imp_c115","bikeModel":"Drone","bikeNameRaw":"Drone","plate":"","startDate":"2026-08-01","endDate":"2026-09-01","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 381"],"pendingReviewBoundary":false},
{"id":"imp_r718","customerId":"imp_c120","bikeModel":"Freego white","bikeNameRaw":"Freego white","plate":"","startDate":"2026-08-01","endDate":"2026-08-26","bookedDays":25,"paidDays":25,"revenue":2570.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 383"],"pendingReviewBoundary":false},
{"id":"imp_r719","customerId":"imp_c387","bikeModel":"GT red 3","bikeNameRaw":"GT red 3","plate":"","startDate":"2026-08-01","endDate":"2026-09-01","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 379"],"pendingReviewBoundary":false},
{"id":"imp_r720","customerId":"imp_c429","bikeModel":"Aerox cool 1","bikeNameRaw":"Aerox cool 1","plate":"","startDate":"2026-08-01","endDate":"2026-08-10","bookedDays":9,"paidDays":9,"revenue":2700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 384"],"pendingReviewBoundary":false},
{"id":"imp_r721","customerId":"imp_c430","bikeModel":"Gt red 1","bikeNameRaw":"Gt red 1","plate":"","startDate":"2026-08-02","endDate":"2026-08-20","bookedDays":18,"paidDays":18,"revenue":2800.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 385"],"pendingReviewBoundary":false},
{"id":"imp_r722","customerId":"imp_c431","bikeModel":"Gt red 2 papaya","bikeNameRaw":"Gt red 2 papaya","plate":"","startDate":"2026-08-05","endDate":"2026-08-13","bookedDays":8,"paidDays":8,"revenue":1300.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 386"],"pendingReviewBoundary":false},
{"id":"imp_r723","customerId":"imp_c432","bikeModel":"Gt 2","bikeNameRaw":"Gt 2","plate":"","startDate":"2026-08-06","endDate":"2026-08-19","bookedDays":13,"paidDays":13,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 387"],"pendingReviewBoundary":false},
{"id":"imp_r724","customerId":"imp_c433","bikeModel":"Nmax grey 2","bikeNameRaw":"Nmax grey 2","plate":"","startDate":"2026-08-06","endDate":"2026-08-11","bookedDays":5,"paidDays":5,"revenue":1900.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 388"],"pendingReviewBoundary":false},
{"id":"imp_r725","customerId":"imp_c142","bikeModel":"Click red","bikeNameRaw":"Click red","plate":"","startDate":"2026-08-09","endDate":"2026-09-09","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 382"],"pendingReviewBoundary":false},
{"id":"imp_r726","customerId":"imp_c434","bikeModel":"Rax blue","bikeNameRaw":"Rax blue","plate":"","startDate":"2026-08-09","endDate":"2026-08-11","bookedDays":2,"paidDays":2,"revenue":1400.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 389"],"pendingReviewBoundary":false},
{"id":"imp_r727","customerId":"imp_c396","bikeModel":"Aerox red 1","bikeNameRaw":"Aerox red 1","plate":"","startDate":"2026-08-11","endDate":"2026-09-11","bookedDays":31,"paidDays":31,"revenue":3500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 390"],"pendingReviewBoundary":false},
{"id":"imp_r728","customerId":"imp_c59","bikeModel":"Aerox cool 1","bikeNameRaw":"Aerox cool 1","plate":"","startDate":"2026-08-12","endDate":"2026-09-12","bookedDays":31,"paidDays":31,"revenue":4000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 391"],"pendingReviewBoundary":false},
{"id":"imp_r729","customerId":"imp_c435","bikeModel":"Freego red","bikeNameRaw":"Freego red","plate":"","startDate":"2026-08-12","endDate":"2026-09-02","bookedDays":21,"paidDays":21,"revenue":3500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 392"],"pendingReviewBoundary":false},
{"id":"imp_r730","customerId":"imp_c401","bikeModel":"Aerox cool blue 1","bikeNameRaw":"Aerox cool blue 1","plate":"","startDate":"2026-08-14","endDate":"2026-08-19","bookedDays":5,"paidDays":5,"revenue":1700.0,"status":"completed","sourceRows":["AA Scooter Account 2026 3 row 393"],"pendingReviewBoundary":false},
{"id":"imp_r731","customerId":"imp_c436","bikeModel":"Gt 3","bikeNameRaw":"Gt 3","plate":"","startDate":"2026-08-15","endDate":"2026-08-22","bookedDays":7,"paidDays":7,"revenue":1300.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 394"],"pendingReviewBoundary":false},
{"id":"imp_r732","customerId":"imp_c437","bikeModel":"Gt black 4","bikeNameRaw":"Gt black 4","plate":"","startDate":"2026-08-17","endDate":"2026-08-24","bookedDays":7,"paidDays":7,"revenue":1300.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 398"],"pendingReviewBoundary":false},
{"id":"imp_r733","customerId":"imp_c438","bikeModel":"Rax 3","bikeNameRaw":"Rax 3","plate":"","startDate":"2026-08-17","endDate":"2026-08-23","bookedDays":6,"paidDays":6,"revenue":1700.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 395"],"pendingReviewBoundary":false},
{"id":"imp_r734","customerId":"imp_c439","bikeModel":"Rax blue","bikeNameRaw":"Rax blue","plate":"","startDate":"2026-08-17","endDate":"2026-08-24","bookedDays":7,"paidDays":7,"revenue":1800.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 396"],"pendingReviewBoundary":false},
{"id":"imp_r735","customerId":"imp_c440","bikeModel":"Gt black 1","bikeNameRaw":"Gt black 1","plate":"","startDate":"2026-08-17","endDate":"2026-08-27","bookedDays":10,"paidDays":10,"revenue":1900.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 397"],"pendingReviewBoundary":false},
{"id":"imp_r736","customerId":"imp_c441","bikeModel":"Freego black","bikeNameRaw":"Freego black","plate":"","startDate":"2026-08-18","endDate":"2026-08-25","bookedDays":7,"paidDays":7,"revenue":1100.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 399"],"pendingReviewBoundary":false},
{"id":"imp_r737","customerId":"imp_c329","bikeModel":"Rax 2","bikeNameRaw":"Rax 2","plate":"","startDate":"2026-08-19","endDate":"2026-08-22","bookedDays":3,"paidDays":3,"revenue":1000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 400"],"pendingReviewBoundary":false},
{"id":"imp_r738","customerId":"imp_c442","bikeModel":"Gt red 2 papaya","bikeNameRaw":"Gt red 2 papaya","plate":"","startDate":"2026-08-19","endDate":"2026-08-26","bookedDays":7,"paidDays":7,"revenue":1300.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 401"],"pendingReviewBoundary":false},
{"id":"imp_r739","customerId":"imp_c109","bikeModel":"Grand Filano","bikeNameRaw":"Grand Filano","plate":"","startDate":"2026-08-20","endDate":"2026-09-20","bookedDays":31,"paidDays":31,"revenue":2500.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 402"],"pendingReviewBoundary":false},
{"id":"imp_r740","customerId":"imp_c272","bikeModel":"Gt black 5","bikeNameRaw":"Gt black 5","plate":"","startDate":"2026-08-20","endDate":"2026-09-20","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 403"],"pendingReviewBoundary":false},
{"id":"imp_r741","customerId":"imp_c291","bikeModel":"GT mint","bikeNameRaw":"GT mint","plate":"","startDate":"2026-08-20","endDate":"2026-09-20","bookedDays":31,"paidDays":31,"revenue":3000.0,"status":"active","sourceRows":["AA Scooter Account 2026 3 row 404"],"pendingReviewBoundary":false},
];

const IMPORTED_NEEDS_REVIEW = [
];

/* ---------------------------------------------------------------------- */
/* DB LAYER                                                                */
/* ---------------------------------------------------------------------- */

const DB = {
  data: null,

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.data = raw ? JSON.parse(raw) : this.seed();
    } catch (e) {
      console.error("DB load failed, reseeding", e);
      this.data = this.seed();
    }
    if (!this.data.meta) this.data.meta = { loyaltyEffectiveDate: "2026-08-10" };
    if (this.data.meta.loyaltyEffectiveDate === undefined && this.data.meta.welcomeKitLaunchDate !== undefined) this.data.meta.loyaltyEffectiveDate = this.data.meta.welcomeKitLaunchDate;
    if (!this.data.meta.bikeNameMap) this.data.meta.bikeNameMap = Object.assign({}, DEFAULT_BIKE_NAME_MAP);
    if (!this.data.meta.rewardCosts) this.data.meta.rewardCosts = Object.assign({}, DEFAULT_REWARD_COSTS);
    if (!this.data.meta.dailyValues) this.data.meta.dailyValues = Object.assign({}, DEFAULT_DAILY_VALUES);
    if (!this.data.meta.vipThresholds) this.data.meta.vipThresholds = JSON.parse(JSON.stringify(DEFAULT_VIP_THRESHOLDS));
    if (!this.data.meta.healthThresholds) this.data.meta.healthThresholds = Object.assign({}, DEFAULT_HEALTH_THRESHOLDS);
    if (!this.data.customers) this.data.customers = [];
    if (!this.data.rentals) this.data.rentals = [];
    if (!this.data.vehicles) this.data.vehicles = [];
    // Migration safety: older saves may be missing newer vehicle fields.
    this.data.vehicles.forEach((v) => {
      if (v.taxExpiryDate === undefined) v.taxExpiryDate = v.taxDate || "";
      if (v.porRorBorExpiryDate === undefined) v.porRorBorExpiryDate = v.porRorBorDate || "";
      if (!v.taxHistory) v.taxHistory = [];
      if (!v.porRorBorHistory) v.porRorBorHistory = [];
      if (v.bikeName === undefined) v.bikeName = v.model || "";
      if (v.modelYear === undefined) v.modelYear = "";
      if (v.taxOverduePending === undefined) v.taxOverduePending = false;
      if (v.renewalNote === undefined) v.renewalNote = "";
    });
    if (!this.data.rewards) this.data.rewards = [];
    if (!this.data.needsReview) this.data.needsReview = [];
    return this.data;
  },

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
  },

  // Demo seed data so the app is usable immediately. Safe to wipe from Settings.
  // Deliberately covers all three Welcome Kit states (already given / eligible / not eligible)
  // and shows Journey Gift tracked from actual completed days, independent of booked days.
  seed() {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
    const daysFromNow = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

    // Real customer & rental history, imported from "Customer list 2025" and
    // "Customer list 2026" only (see IMPORTED_CUSTOMERS / IMPORTED_RENTALS above).
    // Continuous-rental merge, confirmed name-dedup, and the cross-year exact-duplicate
    // cleanup have already been applied — a spreadsheet row is not the same thing as a
    // rental visit here. bookedDays/paidDays for imported rows are both approximated from
    // the episode's actual date span, since the source spreadsheet only ever recorded one
    // start/end pair per row (no separate "booked vs actual" distinction pre-app).
    // DEEP CLONED, never a direct reference — DB.data must never share a mutable array or
    // object with the canonical IMPORTED_CUSTOMERS/IMPORTED_RENTALS constants. Without this,
    // pushing or editing a live rental/customer on a freshly-seeded device would silently
    // mutate the "canonical" reference itself for the rest of that session (confirmed and
    // proven directly before this fix). sourceRows arrays specifically need a real deep
    // clone, not a shallow array copy, since a shallow copy still shares those nested arrays.
    const customers = JSON.parse(JSON.stringify(IMPORTED_CUSTOMERS));
    const rentals = JSON.parse(JSON.stringify(IMPORTED_RENTALS));

    const vehicles = [
      { id: "v1", bikeName: "Aerox Green", modelYear: 2016, plate: "1 กจ 9669 ลำพูน", porRorBorExpiryDate: "2026-10-27", taxExpiryDate: "2026-10-27", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v2", bikeName: "Aerox Red 1", modelYear: 2018, plate: "3 กฎ 2741 ชม", porRorBorExpiryDate: "2026-09-21", taxExpiryDate: "2026-09-21", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v3", bikeName: "Aerox Red 2", modelYear: 2020, plate: "3 กน 624 ชม", porRorBorExpiryDate: "2027-03-29", taxExpiryDate: "2027-03-29", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v4", bikeName: "Aerox White", modelYear: 2017, plate: "2 กฬ 7735 ชม", porRorBorExpiryDate: "2027-03-22", taxExpiryDate: "2027-03-22", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v5", bikeName: "Aerox Rax 1", modelYear: 2021, plate: "3 กด 7084 ชม", porRorBorExpiryDate: "2027-07-13", taxExpiryDate: "2027-07-13", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v6", bikeName: "Aerox Rax 2", modelYear: 2021, plate: "3 กด 7605 ชม", porRorBorExpiryDate: "2027-06-23", taxExpiryDate: "2027-06-23", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v7", bikeName: "Aerox Rax 3", modelYear: 2021, plate: "3 กด 7538 ชม", porRorBorExpiryDate: "2026-11-16", taxExpiryDate: "2026-11-16", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v8", bikeName: "Aerox Rax Red", modelYear: 2022, plate: "2 กส 5345 ชม", porRorBorExpiryDate: "2027-03-31", taxExpiryDate: "2027-03-31", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v9", bikeName: "Aerox Rax Blue", modelYear: 2022, plate: "3 กถ 8590 ชม", porRorBorExpiryDate: "2026-10-28", taxExpiryDate: "2026-10-28", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v10", bikeName: "Aerox Cool 1", modelYear: 2023, plate: "3 กด 7927 ชม", porRorBorExpiryDate: "2027-02-10", taxExpiryDate: "2027-02-10", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v11", bikeName: "Aerox Cool  2", modelYear: 2021, plate: "2 กภ 2149 ชม", porRorBorExpiryDate: "2026-08-06", taxExpiryDate: "2026-08-06", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v12", bikeName: "Aerox Cool Blue 1", modelYear: 2021, plate: "3 กท 1708 ชม", porRorBorExpiryDate: "2027-06-10", taxExpiryDate: "2027-06-10", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v13", bikeName: "Aerox Cool Blue 2", modelYear: 2021, plate: "2 กล 4730 ชม", porRorBorExpiryDate: "2027-06-30", taxExpiryDate: "2027-06-30", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v14", bikeName: "Forza", modelYear: 2013, plate: "3 กธ 2388 ชม", porRorBorExpiryDate: "2026-11-17", taxExpiryDate: "2026-11-17", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v15", bikeName: "Click Red", modelYear: 2016, plate: "2 กว 487 ชม", porRorBorExpiryDate: "2027-05-24", taxExpiryDate: "2027-05-24", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v16", bikeName: "Drone", modelYear: 2022, plate: "3 กฒ 7427 ชม", porRorBorExpiryDate: "2027-04-19", taxExpiryDate: "2027-04-19", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v17", bikeName: "Honda CBR150", modelYear: 2020, plate: "3 กฆ 259 ชม", porRorBorExpiryDate: "2026-11-27", taxExpiryDate: "2026-11-27", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v18", bikeName: "GT silver 1", modelYear: 2019, plate: "3 กช 4191 ชม", porRorBorExpiryDate: "2027-06-09", taxExpiryDate: "2027-06-09", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v19", bikeName: "GT 2", modelYear: 2017, plate: "3 กฆ 7689 ชม", porRorBorExpiryDate: "2027-06-25", taxExpiryDate: "2027-06-25", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v20", bikeName: "GT 3", modelYear: 2017, plate: "3 กต 25 ชม", porRorBorExpiryDate: "2026-09-19", taxExpiryDate: "2026-09-19", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v21", bikeName: "GT Mint", modelYear: 2022, plate: "3 กด 9293 ชม", porRorBorExpiryDate: "2027-03-13", taxExpiryDate: "2027-03-13", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v22", bikeName: "Gt black 1", modelYear: 2018, plate: "2 กศ 1423 ชม", porRorBorExpiryDate: "2027-08-03", taxExpiryDate: "2027-08-03", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v23", bikeName: "Gt black 2", modelYear: 2019, plate: "3 กต 129 ชม", porRorBorExpiryDate: "2027-05-13", taxExpiryDate: "2027-05-13", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v24", bikeName: "Gt black 4", modelYear: 2016, plate: "3 กต 9193 ชม", porRorBorExpiryDate: "2027-06-29", taxExpiryDate: "2027-06-29", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v25", bikeName: "Gt black 5", modelYear: 2016, plate: "1 กว 6391 ชม", porRorBorExpiryDate: "2027-03-20", taxExpiryDate: "2027-03-20", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v26", bikeName: "GT Red 1", modelYear: 2021, plate: "2 กว 4152 ชม", porRorBorExpiryDate: "2026-10-20", taxExpiryDate: "2026-10-20", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v27", bikeName: "GT Red 2 papaya", modelYear: 2018, plate: "2 กท 4812 ชม", porRorBorExpiryDate: "2026-11-06", taxExpiryDate: "2026-11-06", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v28", bikeName: "GT  Red 3", modelYear: 2017, plate: "2 กษ  4342 ชม", porRorBorExpiryDate: "2026-09-06", taxExpiryDate: "2026-10-10", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v29", bikeName: "Nmax white", modelYear: 2016, plate: "1 กฮ 47 ชม", porRorBorExpiryDate: "2027-04-08", taxExpiryDate: "2027-04-08", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v30", bikeName: "Nmax blue", modelYear: 2021, plate: "2 กร 4856 ชม", porRorBorExpiryDate: "2026-10-04", taxExpiryDate: "2026-10-04", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v31", bikeName: "Nmax black", modelYear: 2024, plate: "3 กฐ 2474 ชม", porRorBorExpiryDate: "2027-03-03", taxExpiryDate: "2026-12-16", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v32", bikeName: "Nmax Grey 1", modelYear: 2021, plate: "2 กร 7808 ชม", porRorBorExpiryDate: "2027-02-09", taxExpiryDate: "2027-02-09", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v33", bikeName: "Nmax Grey 2", modelYear: 2021, plate: "2 กล 6930 ชม", porRorBorExpiryDate: "2027-07-01", taxExpiryDate: "", taxOverduePending: true, renewalNote: "Pending vehicle inspection (ตรอ.)", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v34", bikeName: "Grand Filano 1", modelYear: 2016, plate: "1 กย 4485 ชม", porRorBorExpiryDate: "2026-09-23", taxExpiryDate: "2026-09-23", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v35", bikeName: "Grand Filano 2", modelYear: 2017, plate: "2 กก 1655 ชม", porRorBorExpiryDate: "2027-03-06", taxExpiryDate: "2027-03-06", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v36", bikeName: "Freego white", modelYear: 2019, plate: "9 กส 9983 กท", porRorBorExpiryDate: "2027-07-18", taxExpiryDate: "2027-07-18", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v37", bikeName: "Freego red", modelYear: 2019, plate: "2 กช 7192 ชม", porRorBorExpiryDate: "2027-03-28", taxExpiryDate: "2027-03-28", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v38", bikeName: "Freego Black", modelYear: 2019, plate: "2 กบ 5411 ชม", porRorBorExpiryDate: "2027-03-09", taxExpiryDate: "2027-03-09", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v39", bikeName: "Xmax Red", modelYear: 2021, plate: "3 กพ 4411 ชม", porRorBorExpiryDate: "2026-10-04", taxExpiryDate: "2026-10-04", taxOverduePending: false, renewalNote: "", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
      { id: "v40", bikeName: "Zoomer X", modelYear: 2017, plate: "1 กว 8302  ชม", porRorBorExpiryDate: "2027-03-29", taxExpiryDate: "", taxOverduePending: true, renewalNote: "Pending vehicle inspection (ตรอ.)", taxHistory: [], porRorBorHistory: [], currentKm: 0, nextServiceKm: 3000, status: "active", notes: "" },
    ];

    // No historical reward data exists — every imported customer starts with a clean
    // loyalty slate; staff decide Give/Use going forward from here.
    const rewards = [];
    const needsReview = IMPORTED_NEEDS_REVIEW;

    return {
      // Welcome Kit Launch Date: set to before the earliest imported rental so historical
      // customers can be credited for qualifying past bookings rather than being treated
      // as ineligible purely for having rented before the app existed. Adjust in Settings
      // if you'd rather the program only apply going forward.
      meta: { loyaltyEffectiveDate: "2026-08-10" },
      customers, rentals, vehicles, rewards, needsReview,
    };
  },

  exportJSON() { return JSON.stringify(this.data, null, 2); },
  importJSON(json) {
    const parsed = JSON.parse(json);
    this.data = parsed;
    this.save();
  },
  wipe() {
    this.data = { meta: { loyaltyEffectiveDate: "2026-08-10" }, customers: [], rentals: [], vehicles: [], rewards: [], needsReview: [] };
    this.save();
  },
};

/* ---------------------------------------------------------------------- */
/* ICONS — small inline SVGs, currentColor-based, used inside .icon-badge  */
/* wrappers so color/background come from CSS context. Simple, geometric, */
/* premium feel rather than literal illustration.                         */
/* ---------------------------------------------------------------------- */

const ICONS = {
  rider: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="17.5" cy="17.5" r="3.5"/><circle cx="6.5" cy="17.5" r="3.5"/><path d="M6.5 17.5V13l3-3h4l3 5h3.5"/><circle cx="15" cy="6" r="2"/></svg>`,
  gift: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M4 13h16"/><path d="M12 9v11"/><path d="M12 9c-1.2-3-3-4.2-4.5-3.3C6 6.6 6.6 9 9 9"/><path d="M12 9c1.2-3 3-4.2 4.5-3.3C18 6.6 17.4 9 15 9"/></svg>`,
  journey: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7"/><path d="M4 12h16"/></svg>`,
  upgrade: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="18" r="2.5"/><circle cx="16" cy="18" r="2.5"/><path d="M7 18l1.5-5H14l2 5"/><path d="M9 13l3-4h3"/><path d="M15 6l3 3-3 3"/></svg>`,
  premium: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.7z"/></svg>`,
  vip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16"/><path d="M8 3v4M16 3v4"/><path d="M12 13.5l1.1 2.3 2.5.4-1.8 1.8.4 2.5-2.2-1.2-2.2 1.2.4-2.5-1.8-1.8 2.5-.4z"/></svg>`,
  document: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4"/><path d="m9.5 13 1.7 1.7L14.5 11"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.5-4.5"/></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V20a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H4a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H10.5a1.7 1.7 0 0 0 1-1.6V4a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V10.5a1.7 1.7 0 0 0 1.6 1H20a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.6 1z"/></svg>`,
  logoMark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="17" r="3"/><circle cx="7" cy="17" r="3"/><path d="M7 17V12l3.5-3.5h4L18 17"/><path d="M9 8.5h5"/></svg>`,
  scooterBig: `<svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="150" cy="150" r="26" stroke="currentColor" stroke-width="7"/><circle cx="55" cy="150" r="26" stroke="currentColor" stroke-width="7"/><path d="M55 150V105l30-30h35l30 55h30" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M75 75h42" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="128" cy="55" r="15" stroke="currentColor" stroke-width="7"/></svg>`,

  // Elegant, non-cartoon module icons for the App Home launcher cards — moderate
  // weight, geometric, single-color. Deliberately restrained vs. the illustrated
  // "BOLD" mascot-style set used elsewhere in the app.
  loyaltyMark: `<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="10" width="22" height="14" rx="2.2" stroke="currentColor" stroke-width="2"/><path d="M3 15h22" stroke="currentColor" stroke-width="2"/><path d="M14 10V6.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 6.8c-1.4-3-6-2.6-6 .3 0 1.8 2.5 2.9 6 2.9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 6.8c1.4-3 6-2.6 6 .3 0 1.8-2.5 2.9-6 2.9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  renewalMark: `<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="18" height="19" rx="2.2" stroke="currentColor" stroke-width="2"/><path d="M9.5 3v4.4M18.5 3v4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 11h18" stroke="currentColor" stroke-width="2"/><path d="M10 16.2l2.4 2.4 5.6-5.6" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

/* -- Bold / filled "chunky" icon set — brand mascot + illustrated badges,   */
/* -- distinct from the thin utility ICONS above. Original AA character,    */
/* -- not copied from any reference. Warm yellow/orange + black, rounded.   */
const BOLD = {
  // Original "AA Scoot" mascot — helmeted rider character with an "AA" badge on the
  // helmet, one eye winking, blush, thumbs-up, sitting on a scooter with motion streaks.
  // Hand-illustrated in SVG (no image-generation tool available); an original design,
  // not copied from any reference — same warm gold/black energy, different character.
  mascot: `<svg viewBox="0 0 300 340" xmlns="http://www.w3.org/2000/svg">
    <path d="M210 60 Q250 45 285 30" stroke="#FF8F00" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path d="M215 78 Q255 68 290 58" stroke="#FFC107" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.85"/>
    <path d="M218 96 Q250 90 278 86" stroke="#FF8F00" stroke-width="4" stroke-linecap="round" fill="none" opacity="0.7"/>
    <circle cx="100" cy="290" r="34" fill="#111111"/><circle cx="100" cy="290" r="13" fill="#FFC107"/>
    <circle cx="210" cy="290" r="34" fill="#111111"/><circle cx="210" cy="290" r="13" fill="#FFC107"/>
    <path d="M65 292 Q60 240 100 228 Q110 200 140 195 L170 195 Q185 200 190 220 Q235 232 240 292 Z" fill="#FFC107" stroke="#111111" stroke-width="5" stroke-linejoin="round"/>
    <circle cx="150" cy="215" r="9" fill="#111111"/>
    <path d="M110 200 Q150 185 195 202" stroke="#111111" stroke-width="10" stroke-linecap="round" fill="none"/>
    <circle cx="108" cy="200" r="9" fill="#111111"/><circle cx="197" cy="203" r="9" fill="#111111"/>
    <path d="M118 245 Q150 225 185 245 L190 275 Q150 290 113 275 Z" fill="#111111"/>
    <path d="M120 250 Q108 235 108 210" stroke="#111111" stroke-width="16" stroke-linecap="round" fill="none"/>
    <path d="M182 248 Q205 235 215 205" stroke="#111111" stroke-width="16" stroke-linecap="round" fill="none"/>
    <rect x="207" y="176" width="11" height="21" rx="5.5" fill="#FFC107" stroke="#111111" stroke-width="4"/>
    <ellipse cx="217" cy="198" rx="14" ry="16" fill="#FFC107" stroke="#111111" stroke-width="4"/>
    <path d="M92 118 Q78 90 100 85 Q112 100 108 125 Z" fill="#111111"/>
    <path d="M92 116 Q84 98 98 95 Q106 105 104 118 Z" fill="#FFC107"/>
    <path d="M208 118 Q222 90 200 85 Q188 100 192 125 Z" fill="#111111"/>
    <path d="M208 116 Q216 98 202 95 Q194 105 196 118 Z" fill="#FFC107"/>
    <circle cx="150" cy="150" r="72" fill="#111111"/>
    <path d="M96 118 Q150 95 204 118" stroke="#FF8F00" stroke-width="6" stroke-linecap="round" fill="none"/>
    <ellipse cx="150" cy="170" rx="58" ry="54" fill="#FFC107" stroke="#FF8F00" stroke-width="5"/>
    <ellipse cx="128" cy="162" rx="15" ry="18" fill="#FFFFFF"/>
    <circle cx="131" cy="166" r="7" fill="#111111"/><circle cx="134" cy="161" r="2.5" fill="#FFFFFF"/>
    <path d="M164 157 Q174 150 184 157" stroke="#111111" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M186 154 l5 -3" stroke="#111111" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="118" cy="184" rx="9" ry="6" fill="#FF8F6B" opacity="0.55"/>
    <ellipse cx="180" cy="184" rx="9" ry="6" fill="#FF8F6B" opacity="0.55"/>
    <ellipse cx="150" cy="180" rx="4" ry="3" fill="#111111"/>
    <path d="M136 192 Q150 204 166 190" stroke="#111111" stroke-width="5" stroke-linecap="round" fill="none"/>
    <rect x="128" y="98" width="44" height="24" rx="8" fill="#FFFFFF"/>
    <text x="150" y="116" font-family="Space Grotesk, sans-serif" font-size="16" font-weight="800" fill="#111111" text-anchor="middle">AA</text>
  </svg>`,

  // Bottom nav — Customer Loyalty: bold filled scooter silhouette.
  navScooter: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="29" r="6.2" fill="currentColor"/><circle cx="9" cy="29" r="2.4" fill="#111111" opacity="0.35"/>
    <circle cx="27" cy="29" r="6.2" fill="currentColor"/><circle cx="27" cy="29" r="2.4" fill="#111111" opacity="0.35"/>
    <path d="M8 26 Q8 14 18 14 Q23 14 25 20 L31 26 Q34 27 34 29 L4 29 Q4 27 8 26 Z" fill="currentColor"/>
    <path d="M12 18h9" stroke="#111111" stroke-width="2" stroke-linecap="round" opacity="0.35"/>
  </svg>`,
  // Bottom nav — Vehicle Renewal: bold filled document.
  navDoc: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 6h14l7 7v20a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="currentColor"/>
    <path d="M24 6v7h7" fill="none" stroke="#F6F6F6" stroke-width="2"/>
    <path d="M14 22h6M14 27h9" stroke="#F6F6F6" stroke-width="2.2" stroke-linecap="round" opacity="0.7"/>
  </svg>`,

  // Badge icon: filled gift box with bold ribbon — Rewards Ready / Welcome Gift.
  gift: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <rect x="7" y="18" width="26" height="17" rx="3" fill="#FF8F00" stroke="#111111" stroke-width="2.5"/>
    <rect x="7" y="18" width="26" height="7" fill="#111111"/>
    <rect x="17.5" y="12" width="5" height="23" fill="#111111"/>
    <path d="M20 12c-2-6-9-6-9-1 0 3 4 3 9 1z" fill="#FF8F00" stroke="#111111" stroke-width="2" stroke-linejoin="round"/>
    <path d="M20 12c2-6 9-6 9-1 0 3-4 3-9 1z" fill="#FF8F00" stroke="#111111" stroke-width="2" stroke-linejoin="round"/>
  </svg>`,

  // Badge icon: drawstring travel pouch — Journey Gift.
  pouch: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 17 Q12 10 20 10 Q28 10 28 17 L30 17 Q34 17 34 24 Q34 34 20 34 Q6 34 6 24 Q6 17 10 17 Z" fill="#FF8F00" stroke="#111111" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M15 17 Q15 12 20 12 Q25 12 25 17" fill="none" stroke="#111111" stroke-width="2.3"/>
    <circle cx="20" cy="24" r="3.2" fill="#111111"/>
  </svg>`,

  // Badge icon: scooter with an upward arrow — Ride Upgrade.
  upgrade: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="30" r="5.4" fill="#111111"/><circle cx="9" cy="30" r="2" fill="#FF8F00"/>
    <circle cx="23" cy="30" r="5.4" fill="#111111"/><circle cx="23" cy="30" r="2" fill="#FF8F00"/>
    <path d="M8 27 Q8 17 17 17 Q21 17 23 22 L28 27 Z" fill="#111111"/>
    <path d="M30 8 L30 20 M30 8 L25 13 M30 8 L35 13" stroke="#FF8F00" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`,

  // Badge icon: scooter with a star — Premium Ride Experience.
  premiumScooter: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="30" r="5.4" fill="#111111"/><circle cx="9" cy="30" r="2" fill="#FFC107"/>
    <circle cx="23" cy="30" r="5.4" fill="#111111"/><circle cx="23" cy="30" r="2" fill="#FFC107"/>
    <path d="M8 27 Q8 17 17 17 Q21 17 23 22 L28 27 Z" fill="#111111"/>
    <path d="M31 8l2.1 4.4 4.9.7-3.5 3.5.8 4.9-4.3-2.3-4.3 2.3.8-4.9-3.5-3.5 4.9-.7z" fill="#FFC107" stroke="#111111" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`,

  // Badge icon: calendar with a star — VIP Extra Day on Us.
  vipCalendar: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <rect x="6" y="9" width="28" height="24" rx="4" fill="#FF8F00" stroke="#111111" stroke-width="2.3"/>
    <rect x="6" y="9" width="28" height="8" fill="#111111"/>
    <path d="M13 6v6M27 6v6" stroke="#111111" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M20 20l1.8 3.7 4 .6-3 3 .7 4-3.5-1.9-3.5 1.9.7-4-3-3 4-.6z" fill="#111111"/>
  </svg>`,

  // Badge icon: bold helmet — Active Long-Term Riders.
  helmet: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 25 Q6 8 20 8 Q34 8 34 25 L34 27 Q34 30 31 30 L9 30 Q6 30 6 27 Z" fill="#111111"/>
    <path d="M9 25 Q9 12 20 12 Q31 12 31 25" fill="none" stroke="#FF8F00" stroke-width="2.4" stroke-linecap="round"/>
    <rect x="4" y="27" width="32" height="6" rx="3" fill="#111111"/>
  </svg>`,

  // Badge icon: clipboard with a magnifier — Needs Review.
  clipSearch: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <rect x="8" y="8" width="24" height="28" rx="3" fill="#FF8F00" stroke="#111111" stroke-width="2.3"/>
    <rect x="14" y="5" width="12" height="7" rx="2" fill="#111111"/>
    <path d="M13 20h10M13 26h7" stroke="#111111" stroke-width="2.3" stroke-linecap="round"/>
    <circle cx="24" cy="27" r="5" fill="#F6F6F6" stroke="#111111" stroke-width="2.3"/>
    <path d="M28 31l3 3" stroke="#111111" stroke-width="2.6" stroke-linecap="round"/>
  </svg>`,

  // Bold filled magnifying glass — Search.
  search: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <circle cx="17" cy="17" r="11" fill="none" stroke="#111111" stroke-width="5"/>
    <path d="M25 25l9 9" stroke="#111111" stroke-width="5.5" stroke-linecap="round"/>
  </svg>`,

  // Viewfinder / scan-document corners — Quick Actions "Scan Document".
  scan: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 14V10a2 2 0 0 1 2-2h4M32 14V10a2 2 0 0 0-2-2h-4M8 26v4a2 2 0 0 0 2 2h4M32 26v4a2 2 0 0 1-2 2h-4" stroke="#111111" stroke-width="4" stroke-linecap="round" fill="none"/>
    <rect x="14" y="17" width="12" height="6" rx="2" fill="#111111"/>
  </svg>`,

  // Bar chart — Quick Actions "Reports".
  reports: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <rect x="7" y="22" width="6" height="12" rx="1.5" fill="#111111"/>
    <rect x="17" y="14" width="6" height="20" rx="1.5" fill="#FF8F00"/>
    <rect x="27" y="8" width="6" height="26" rx="1.5" fill="#111111"/>
  </svg>`,

  // Small sparkle/star used as a scattered decorative accent (hero banners, empty states).
  sparkle: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" fill="currentColor"/></svg>`,
  dot: `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="5" fill="currentColor"/></svg>`,

  // The AA wordmark: bold "AA" lettering with a small rider-on-scooter silhouette and
  // motion streaks above the letters — the app's main logo lockup.
  wordmark: `<svg viewBox="0 0 320 220" xmlns="http://www.w3.org/2000/svg">
    <path d="M222 22 Q254 15 278 8" stroke="#FFC107" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M226 34 Q260 29 284 25" stroke="#FF8F00" stroke-width="4" stroke-linecap="round" fill="none" opacity="0.85"/>
    <path d="M228 46 Q256 44 278 42" stroke="#FFC107" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.65"/>
    <ellipse cx="197" cy="20" rx="15" ry="13" fill="#FFFFFF"/>
    <path d="M188 17 Q197 12 208 18" stroke="#111111" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M184 28 Q160 36 138 54 Q133 60 141 61 L158 57 Q176 40 190 31 Z" fill="#FFFFFF"/>
    <path d="M190 31 Q203 44 199 60 L184 60 Q182 45 186 28 Z" fill="#FFFFFF"/>
    <path d="M140 61 L222 61 L207 74 L155 74 Z" fill="#FFFFFF"/>
    <circle cx="155" cy="78" r="10" fill="#FFFFFF"/>
    <circle cx="207" cy="78" r="10" fill="#FFFFFF"/>
    <text x="80" y="185" font-family="Space Grotesk, sans-serif" font-size="150" font-weight="800" fill="#FFFFFF" text-anchor="middle" letter-spacing="-4">A</text>
    <text x="228" y="185" font-family="Space Grotesk, sans-serif" font-size="150" font-weight="800" fill="#FFC107" text-anchor="middle" letter-spacing="-4">A</text>
  </svg>`,
};
function icon(name, extraClass) { return `<span class="icon-badge${extraClass ? " " + extraClass : ""}">${ICONS[name] || ""}</span>`; }
function boldIcon(name, extraClass) { return `<span class="bold-icon-badge${extraClass ? " " + extraClass : ""}">${BOLD[name] || ""}</span>`; }

/* ---------------------------------------------------------------------- */
/* HELPERS                                                                 */
/* ---------------------------------------------------------------------- */

function uid(prefix) { return prefix + "_" + Math.random().toString(36).slice(2, 9); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
// A precise "10 Aug 2026 10:30"-style timestamp — used only for audit-trail events
// (Marked Used / Use Reversed) where staff need to see exactly when a transaction
// happened, not just the date, to distinguish an action from its later reversal.
function nowDateTimeLabel() {
  const d = new Date();
  const datePart = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const timePart = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${datePart} ${timePart}`;
}
// Same format as nowDateTimeLabel() but for an arbitrary stored ISO timestamp — used to
// display "last successful Manager check" without re-deriving the current time.
function fmtDateTimeLabel(isoTimestamp) {
  if (!isoTimestamp) return null;
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return null;
  const datePart = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const timePart = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${datePart} ${timePart}`;
}
// Reads Manager sync status fields safely with defaults — never assumes they exist.
// Existing live users' DB.data.meta predates these fields entirely; this never mutates
// meta or triggers any write, purely a read-time default. Nothing is written here.
function getManagerSyncMeta() {
  const m = DB.data.meta || {};
  return {
    lastManagerCheckAt: m.lastManagerCheckAt || null,
    lastManagerRecordCount: m.lastManagerRecordCount || 0,
    lastManagerNewCustomerCount: m.lastManagerNewCustomerCount || 0,
    lastManagerExistingActivityCount: m.lastManagerExistingActivityCount || 0,
    lastManagerNeedsReviewCount: m.lastManagerNeedsReviewCount || 0,
  };
}
function fmtMoney(n) {
  const v = Number(n) || 0;
  return "฿" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function daysBetween(a, b) {
  if (!a || !b) return 0;
  const d1 = new Date(a + "T00:00:00"), d2 = new Date(b + "T00:00:00");
  return Math.round((d2 - d1) / 86400000);
}
function daysFromToday(iso) { return daysBetween(todayISO(), iso); }
function initials(name) {
  return (name || "?").trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("");
}
// First name for personalized messages — strips common titles (Mr./Mrs./Ms./Miss/Dr.)
// since several imported names carry them (e.g. "Mr.Benjamin Andrew Van Herten").
function firstNameOf(name) {
  let s = String(name || "").trim();
  s = s.replace(/^(mrs|miss|mr|ms|dr)\.?\s*/i, "").trim();
  return s.split(/\s+/)[0] || s;
}
// Full readable display name — strips the same honorifics as firstNameOf, but keeps the
// rest of the name intact (never touches the actual stored customer.name; this is a
// display-only transform used for screens like Rewards Ready). Also normalizes common
// punctuation variants some imported records carry, like "Mr," instead of "Mr.".
function cleanCustomerDisplayName(name) {
  let s = String(name || "").trim();
  s = s.replace(/^(mrs|miss|mr|ms|dr)[.,]?\s*/i, "");
  return s.replace(/\s+/g, " ").trim() || String(name || "").trim();
}
// Customer-facing bike name only — drops internal trim/spec detail (Standard Key,
// Keyless, ABS) that means nothing to a customer and could set the wrong expectation,
// since the actual bike/version provided depends on what's available on the day.
// Internal fields (Experience Bike shown to staff, Mark Used options, eligibility) are
// untouched — this simplification applies only inside the customer-facing message text.
function simplifyBikeNameForCustomer(bike) {
  if (!bike) return bike;
  if (bike.includes("Aerox")) return "Aerox 155cc";
  if (bike.includes("NMAX")) return "NMAX 155cc";
  return bike; // "Forza 300" / "XMAX 300" are already customer-facing as-is
}

// The warm, natural Premium Ride Experience invite message — exact approved wording and
// structure, personalized only with first name and Experience Bike. Deliberately does NOT
// mention the customer's current bike (this should feel like a gift, not a bike swap) and
// deliberately does NOT explain internal fleet/availability/priority rules to the customer
// — "subject to availability, confirmed the day before" is all they need to know.
function premiumInviteMessage(customer, currentBikeRaw, experienceBike) {
  const first = firstNameOf(customer.name);
  const bike = simplifyBikeNameForCustomer(experienceBike) || "premium bike";
  return `Hi ${first}! 😊 We've got a little thank-you for you for being such a loyal rider with us.\n\nWe'd love to treat you to a complimentary Premium Ride Experience — enjoy a${/^[aeiou]/i.test(bike) ? "n" : ""} ${bike} for 2 days / 1 night, on us! 🛵✨\n\nWhenever you have a little trip in mind, just let us know your preferred dates. As this experience is subject to availability, we'll check the bike and confirm with you the day before.\n\nJust our little way of saying thank you for being with AA for so long. Enjoy the ride! 😊`;
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}
function journeyThreshold(category) { return JOURNEY_GIFT_THRESHOLDS[category] ?? DEFAULT_JOURNEY_THRESHOLD; }

// Bike Name Mapping: Original Bike Name -> Standardized Vehicle Category, editable from
// Settings without touching code. classifyBike() is the single source of truth for turning
// a raw historical/manually-entered name into one of the five CATEGORY_TIERS; every loyalty
// calculation (Journey Gift, Qualified Rentals, Ride Upgrade) goes through it live, so editing
// the mapping recalculates everything immediately — nothing is baked into stored rentals.
function normalizeBikeName(raw) {
  let s = String(raw || "").toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, "");   // strip parenthetical notes e.g. "(under Irene)", "(155)"
  s = s.split(/[/,]/)[0];             // if multiple bikes were noted, take the first
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
function classifyBike(rawName) {
  const map = DB.data.meta.bikeNameMap || DEFAULT_BIKE_NAME_MAP;
  const n = normalizeBikeName(rawName);
  if (map[n]) return map[n];
  // Fall back to keyword matching for anything not in the table yet (typos, new bikes) —
  // same priority order used to build the default table, so new similar names classify
  // sensibly until someone adds an exact mapping in Settings.
  if (n.includes("zoomer")) return "125cc";
  if (n.startsWith("gt")) return "125cc";
  if (n.includes("click")) return "125cc";
  if (n.includes("filano")) return "125cc";
  if (n.includes("freego")) return "125cc";
  if (n.includes("forza")) return "Forza 300";
  if (n.includes("xmax")) return "XMAX 300";
  if (n.includes("cool")) return "155cc Keyless/ABS";
  if (n.includes("white") && n.includes("aerox")) return "155cc Keyless/ABS";
  if (n.includes("nmax")) {
    if (n.includes("white")) return "155cc Standard Key";
    return "155cc Keyless/ABS";
  }
  if (n.includes("rax") || n.includes("rex")) return "155cc Standard Key";
  if (n.includes("drone")) return "155cc Keyless/ABS";
  if (n.includes("aerox")) return "155cc Standard Key";
  return "155cc Standard Key"; // last-resort generic default
}
// The category actually used for loyalty math: recomputed live from the Original Bike Name
// when we have one (all imported historical rentals do); manually-logged rentals without a
// raw name were assigned a category directly at creation time, so that's used as-is.
function rentalCategory(rental) {
  if (rental.bikeNameRaw) return classifyBike(rental.bikeNameRaw);
  return rental.bikeModel;
}

// --- Ride Upgrade ladder (separate from Premium Ride Experience) ---------------------
// Ride Upgrade only ever moves a customer through the 155cc fleet — it never jumps to
// Forza/XMAX. Within 155cc, Aerox and NMAX are different lines with their own Standard/
// Keyless step, so the 5-tier Journey Gift category isn't granular enough here; this reads
// the raw bike name again just to tell Aerox-family from NMAX-family within that tier.
function bikeFamily(rawName) {
  const n = normalizeBikeName(rawName);
  if (n.includes("nmax")) return "nmax";
  if (n.includes("aerox") || n.includes("rax") || n.includes("rex") || n.includes("cool")) return "aerox";
  return "aerox"; // safe default for anything 155cc-tier but unclear (e.g. Drone) -- flagged in reason text
}
function rideUpgradeCategory(rental) {
  const tier = rentalCategory(rental);
  if (tier === "155cc Standard Key") return bikeFamily(rental.bikeNameRaw || "") === "nmax" ? "NMAX White Standard Key 155cc" : "Aerox Standard Key 155cc";
  if (tier === "155cc Keyless/ABS") return bikeFamily(rental.bikeNameRaw || "") === "nmax" ? "NMAX Keyless/ABS 155cc" : "Aerox Keyless/ABS 155cc";
  return tier; // "125cc", "Forza 300", "XMAX 300" pass through unchanged
}
// The normal Ride Upgrade ladder tops out at NMAX Keyless/ABS — Forza/XMAX are never a
// Ride Upgrade destination, only ever Premium Ride Experience (a separate reward).
const RIDE_UPGRADE_NEXT = {
  "125cc": "Aerox Standard Key 155cc",
  "Aerox Standard Key 155cc": "Aerox Keyless/ABS 155cc",
  "NMAX White Standard Key 155cc": "NMAX Keyless/ABS 155cc",
  "Aerox Keyless/ABS 155cc": "NMAX Keyless/ABS 155cc",
  "NMAX Keyless/ABS 155cc": null, // top of the normal ladder
};
const RIDE_UPGRADE_LADDER_VISUAL = ["125cc", "Aerox Standard Key 155cc", "Aerox Keyless/ABS 155cc", "NMAX Keyless/ABS 155cc"];

// Premium Ride Experience: a complimentary 2-day/1-night TASTE of a nicer bike — separate
// from Ride Upgrade (which is a permanent rate change). The Experience Bike is always
// relative to the customer's ACTUAL current bike, never a blanket jump to 300cc:
//   110/125cc               -> a 155cc Keyless/ABS experience (Aerox or NMAX family)
//   155cc Standard Key      -> the matching family's 155cc Keyless/ABS experience
//   155cc Keyless/ABS       -> Forza 300 (staff can pick XMAX 300 instead when marking used)
//   Forza 300 / XMAX 300    -> not applicable; these riders' equivalent reward is VIP Extra Day
function premiumExperienceBike(rental) {
  const tier = rentalCategory(rental);
  if (tier === "Forza 300" || tier === "XMAX 300") return null;
  if (tier === "125cc" || tier === "155cc Standard Key") {
    return bikeFamily(rental.bikeNameRaw || "") === "nmax" ? "NMAX Keyless/ABS 155cc" : "Aerox Keyless/ABS 155cc";
  }
  if (tier === "155cc Keyless/ABS") return "Forza 300";
  return null;
}

// Ride Upgrade pricing — ONLY the specific transitions that have actually been priced.
// A Ride Upgrade is never assumed to carry the customer's old rate forward; if a transition
// isn't listed here, no rate is shown at all (never invent a number for an unpriced step).
const RIDE_UPGRADE_PRICING = {
  "125cc->Aerox Standard Key 155cc": { normalRate: 4000, loyaltyRate: 3500, unit: "month" },
};
function getUpgradePricing(fromCategory, toCategory) {
  return RIDE_UPGRADE_PRICING[`${fromCategory}->${toCategory}`] || null;
}

// A rental "qualifies" toward Ride Upgrade progression if it clears EITHER the paid-days
// threshold OR the final paid revenue threshold for its bike class — whichever the customer
// actually hit. Uses paid days / final paid revenue (post-refund, if any), not just days the
// bike was physically out, so an early return on a longer paid booking still counts.
function qualifiedRentalThreshold(category) { return QUALIFIED_RENTAL_THRESHOLDS[category] ?? DEFAULT_QUALIFIED_RENTAL_THRESHOLD; }
function isQualifiedRental(rental) {
  const t = qualifiedRentalThreshold(rentalCategory(rental));
  const days = Number(rental.paidDays) || 0;
  const revenue = Number(rental.revenue) || 0;
  return days >= t.days || revenue >= t.revenue;
}

/* ---------------------------------------------------------------------- */
/* REWARD FINANCIALS — estimated value / actual cost, all editable via     */
/* DB.data.meta.* (Settings), never hard-coded business rules.             */
/* ---------------------------------------------------------------------- */

// Collapses the 5 fine-grained Ride Upgrade tiers into the 3 broad bands VIP Extra Day
// qualification is defined against (110/125cc, 155cc, Forza/XMAX 300).
function broadTier(category) {
  if (category === "125cc") return "125cc";
  if (category === "Forza 300" || category === "XMAX 300") return "300cc";
  return "155cc";
}
function dailyValueFor(category) {
  const table = (DB.data.meta && DB.data.meta.dailyValues) || DEFAULT_DAILY_VALUES;
  return table[category] ?? 0;
}
function rewardCost(field) {
  const table = (DB.data.meta && DB.data.meta.rewardCosts) || DEFAULT_REWARD_COSTS;
  return table[field] ?? 0;
}
function vipThresholdFor(broad) {
  const table = (DB.data.meta && DB.data.meta.vipThresholds) || DEFAULT_VIP_THRESHOLDS;
  return table[broad] ?? DEFAULT_VIP_THRESHOLDS[broad];
}
// Loyalty Health status from a Reward-to-Revenue ratio (%), using editable thresholds.
function loyaltyHealth(ratioPct) {
  const t = (DB.data.meta && DB.data.meta.healthThresholds) || DEFAULT_HEALTH_THRESHOLDS;
  if (ratioPct <= t.healthyMax) return { label: "Healthy", emoji: "🟢", cls: "green" };
  if (ratioPct <= t.watchMax) return { label: "Watch", emoji: "🟡", cls: "amber" };
  return { label: "High", emoji: "🔴", cls: "red" };
}
// A customer's full financial/loyalty-value summary — used on the profile's "Customer
// Value" section and the Reward History screen. Reads only already-computed stats/rewards;
// never recalculates rental history or eligibility.
function customerFinancialSummary(customer, stats) {
  const given = rewardsFor(customer.id).filter((r) => r.given);
  const totalValue = given.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const totalActualCost = given.reduce((s, r) => s + (Number(r.actualCost ?? r.value) || 0), 0);
  const ratio = stats.totalRevenue > 0 ? (totalValue / stats.totalRevenue) * 100 : 0;
  return {
    lifetimeRevenue: stats.totalRevenue,
    rewardsGivenCount: given.length,
    totalRewardValue: totalValue,
    actualGiftCost: totalActualCost,
    ratioPct: ratio,
    health: loyaltyHealth(ratio),
  };
}

/* ---------------------------------------------------------------------- */
/* DATA AUDIT (PHASE 1) — strictly READ-ONLY. Compares each customer's     */
/* CURRENTLY STORED rentals (whatever is already in this browser's         */
/* localStorage, loaded into DB.data) against CANONICAL rentals — the      */
/* literal IMPORTED_RENTALS/IMPORTED_CUSTOMERS constants baked into this   */
/* exact copy of the code, which never change regardless of what a given   */
/* browser has persisted from an earlier version. Nothing in this function */
/* or its render/wiring calls DB.save(), mutates DB.data, or touches       */
/* localStorage in any way — it only reads and reports.                    */
/* ---------------------------------------------------------------------- */

// Three clearly separated scopes, per explicit design correction:
//   A. IMPORTED HISTORY — live import-sourced records (id starts "imp_r") vs canonical
//      IMPORTED_RENTALS. This is the ONLY comparison that determines mismatch status.
//   B. MANUAL RENTALS — legitimate later business records (never "imp_r" prefixed). Shown
//      separately, NEVER compared to canonical, NEVER counted toward mismatch, NEVER a
//      reconciliation candidate.
//   C. FULL CUSTOMER TOTAL — A + B, for business/display context only (e.g. Customer Value),
//      never used to decide MATCH/MISMATCH.
function runDataAudit() {
  // 2025 is legacy/recognition-only — never in scope for MATCH/MISMATCH. Both sides of the
  // comparison are restricted to 2026-01-01 onward before anything else happens.
  const canonicalByCustomer = {};
  IMPORTED_RENTALS.filter((r) => r.startDate >= LEGACY_CUTOFF_DATE).forEach((r) => {
    (canonicalByCustomer[r.customerId] = canonicalByCustomer[r.customerId] || []).push(r);
  });

  const rows = [];
  let importMatchCount = 0, importMismatchCount = 0;
  let customersWithManual = 0, mismatchOnlyBecauseOfManual = 0;
  let importDiffRevenueTotal = 0, manualRevenueTotal = 0;

  IMPORTED_CUSTOMERS.forEach((seedCust) => {
    const custId = seedCust.id;
    const canonicalRentals = canonicalByCustomer[custId] || [];
    const canonicalVisits = canonicalRentals.length;
    const canonicalDays = canonicalRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const canonicalRevenue = canonicalRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const canonicalIds = new Set(canonicalRentals.map((r) => r.id));

    const storedCust = DB.data.customers.find((c) => c.id === custId);
    const displayName = storedCust ? storedCust.name : seedCust.name;
    // 2025-dated live records (import-sourced or manual) never enter this screen at all —
    // legacy history, visible on the customer's own profile, never audited here.
    const allStoredRentals = DB.data.rentals.filter((r) => r.customerId === custId && r.startDate >= LEGACY_CUTOFF_DATE); // read only

    // SCOPE A — import-sourced only.
    const importRentals = allStoredRentals.filter((r) => String(r.id).startsWith("imp_r"));
    const importVisits = importRentals.length;
    const importDays = importRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const importRevenue = importRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const importStatus = (importVisits === canonicalVisits && importDays === canonicalDays && importRevenue === canonicalRevenue) ? "MATCH" : "MISMATCH";

    // SCOPE B — manual rentals. Legitimate, later, import-independent. Never compared to
    // canonical, never contributes to mismatch status, never a reconciliation candidate.
    const manualRentals = allStoredRentals.filter((r) => !String(r.id).startsWith("imp_r"));
    const manualVisits = manualRentals.length;
    const manualDays = manualRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const manualRevenue = manualRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);

    // SCOPE C — full total, for display/business context (e.g. Customer Value), never used
    // to determine mismatch.
    const totalVisits = importVisits + manualVisits;
    const totalDays = importDays + manualDays;
    const totalRevenue = importRevenue + manualRevenue;

    if (manualVisits > 0) customersWithManual++;
    if (importStatus === "MATCH") importMatchCount++; else importMismatchCount++;
    manualRevenueTotal += manualRevenue;

    // For reporting only: would the OLD (flawed) full-total-vs-canonical comparison have
    // flagged this customer, even though their import-sourced history is actually correct?
    const oldStyleWasMismatch = totalVisits !== canonicalVisits || totalDays !== canonicalDays || totalRevenue !== canonicalRevenue;
    if (importStatus === "MATCH" && oldStyleWasMismatch) mismatchOnlyBecauseOfManual++;

    if (importStatus === "MISMATCH") importDiffRevenueTotal += (importRevenue - canonicalRevenue);

    // Only report rows that are genuinely interesting: an import mismatch, or a customer
    // carrying manual rentals worth showing separately.
    if (importStatus === "MATCH" && manualVisits === 0) return;

    const custRewards = DB.data.rewards.filter((r) => r.customerId === custId);
    const hasRewardHistory = custRewards.some((r) => r.given || r.reserved);
    const riskyRewards = custRewards.filter((r) => (r.given || r.reserved) && r.rentalId && !canonicalIds.has(r.rentalId));

    rows.push({
      name: displayName,
      importVisits, importDays, importRevenue,
      canonicalVisits, canonicalDays, canonicalRevenue,
      importStatus,
      importDiffRevenue: importRevenue - canonicalRevenue,
      manualVisits, manualDays, manualRevenue,
      totalVisits, totalDays, totalRevenue,
      hasRewardHistory,
      riskyRewardCount: riskyRewards.length,
      riskLevel: riskyRewards.length > 0 ? "NEEDS REVIEW" : "SAFE TO RECONCILE",
    });
  });

  const totalAudited = IMPORTED_CUSTOMERS.length;

  return {
    totalAudited,
    importMatchCount, importMismatchCount,
    customersWithManual, mismatchOnlyBecauseOfManual,
    importDiffRevenueTotal, manualRevenueTotal,
    // Legacy field names kept so nothing else that reads runDataAudit()'s summary breaks —
    // "mismatching"/"matching" now mean import-history mismatch/match specifically.
    matching: importMatchCount, mismatching: importMismatchCount,
    totalDiffRevenue: importDiffRevenueTotal,
    riskCustomers: rows.filter((r) => r.riskyRewardCount > 0).length,
    rows: rows.sort((a, b) => Math.abs((b.importDiffRevenue || 0)) - Math.abs((a.importDiffRevenue || 0))),
  };
}

/* ---------------------------------------------------------------------- */
/* SOURCE-ROW MAPPING DIAGNOSTIC (READ-ONLY). Rental technical IDs are NOT */
/* treated as business identity — they were assigned once, offline, and   */
/* are not provably stable across different generations of this array     */
/* (confirmed: several past Needs Review resolutions changed record count */
/* and would have shifted sequential numbering had the array ever been    */
/* regenerated). sourceRows are the only stable anchor, since they cite    */
/* the untouched original spreadsheet directly. This function determines, */
/* per mismatched customer, whether every live record can be              */
/* deterministically mapped to a canonical episode by sourceRows overlap  */
/* — and if not, marks that customer REVIEW REQUIRED rather than guessing.*/
/* ---------------------------------------------------------------------- */

function buildSourceRowMappingDiagnostic() {
  // 2025 is legacy/recognition-only — excluded from source-row mapping the same way it's
  // excluded from Data Audit.
  const canonicalByCustomer = {};
  IMPORTED_RENTALS.filter((r) => r.startDate >= LEGACY_CUTOFF_DATE).forEach((r) => {
    (canonicalByCustomer[r.customerId] = canonicalByCustomer[r.customerId] || []).push(r);
  });

  const results = [];

  IMPORTED_CUSTOMERS.forEach((seedCust) => {
    const custId = seedCust.id;
    const canonicalRentals = canonicalByCustomer[custId] || [];
    const storedRentals = DB.data.rentals.filter((r) => r.customerId === custId && r.startDate >= LEGACY_CUTOFF_DATE);

    const storedVisits = storedRentals.length;
    const storedDays = storedRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const storedRevenue = storedRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const canonicalVisits = canonicalRentals.length;
    const canonicalDays = canonicalRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const canonicalRevenue = canonicalRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const isMatch = storedVisits === canonicalVisits && storedDays === canonicalDays && storedRevenue === canonicalRevenue;
    if (isMatch) return; // only mismatched customers are examined

    const displayCust = DB.data.customers.find((c) => c.id === custId);
    const displayName = displayCust ? displayCust.name : seedCust.name;

    // Map every canonical sourceRow citation to the episode it belongs to.
    const canonicalRowToEpisode = {};
    canonicalRentals.forEach((ep) => { (ep.sourceRows || []).forEach((row) => { canonicalRowToEpisode[row] = ep; }); });

    const importSourced = storedRentals.filter((r) => String(r.id).startsWith("imp_r"));
    const manualRentals = storedRentals.filter((r) => !String(r.id).startsWith("imp_r"));

    const claimedRows = new Set();
    const episodeCoverage = {}; // episode.id -> Set of rows covered so far by live records

    const liveRecordClassifications = importSourced.map((liveRec) => {
      const rows = liveRec.sourceRows || [];
      if (rows.length === 0) {
        return { id: liveRec.id, record: liveRec, classification: "AMBIGUOUS / REVIEW REQUIRED", reason: "No sourceRows on this record — cannot verify its origin." };
      }
      const episodesHit = new Set(rows.map((r) => canonicalRowToEpisode[r]).filter(Boolean));
      if (episodesHit.size === 0) {
        return { id: liveRec.id, record: liveRec, classification: "MISSING CANONICAL EPISODE", reason: "None of this record's sourceRows match any canonical episode." };
      }
      if (episodesHit.size > 1) {
        return { id: liveRec.id, record: liveRec, classification: "AMBIGUOUS / REVIEW REQUIRED", reason: "sourceRows span more than one canonical episode." };
      }
      const episode = [...episodesHit][0];
      const duplicateClaim = rows.some((r) => claimedRows.has(r));
      rows.forEach((r) => claimedRows.add(r));
      if (duplicateClaim) {
        return { id: liveRec.id, record: liveRec, classification: "DUPLICATE SOURCE ROW CLAIM", reason: "One or more sourceRows already claimed by another live record.", episodeId: episode.id };
      }
      episodeCoverage[episode.id] = episodeCoverage[episode.id] || new Set();
      rows.forEach((r) => episodeCoverage[episode.id].add(r));
      const episodeRowCount = (episode.sourceRows || []).length;
      const coveredSoFar = episodeCoverage[episode.id].size;
      if (coveredSoFar < episodeRowCount) {
        return { id: liveRec.id, record: liveRec, classification: "FRAGMENT OF CANONICAL EPISODE", reason: `Covers ${coveredSoFar} of ${episodeRowCount} rows belonging to this episode.`, episodeId: episode.id };
      }
      const contentMatches = liveRec.startDate === episode.startDate && liveRec.endDate === episode.endDate
        && Number(liveRec.paidDays) === Number(episode.paidDays) && Number(liveRec.revenue) === Number(episode.revenue);
      return {
        id: liveRec.id, record: liveRec,
        classification: contentMatches ? "MATCH" : "FRAGMENT OF CANONICAL EPISODE",
        reason: contentMatches ? "Covers all rows for this episode and content matches canonical exactly." : "Covers all rows for this episode, but its own field values differ from canonical.",
        episodeId: episode.id,
      };
    });

    const missingEpisodes = canonicalRentals.filter((ep) => {
      const covered = episodeCoverage[ep.id];
      return !(covered && covered.size === (ep.sourceRows || []).length);
    });

    const anyAmbiguous = liveRecordClassifications.some((c) => c.classification === "AMBIGUOUS / REVIEW REQUIRED" || c.classification === "MISSING CANONICAL EPISODE");
    const deterministic = !anyAmbiguous && missingEpisodes.length === 0;

    results.push({
      customerId: custId,
      name: displayName,
      liveRecords: liveRecordClassifications,
      manualRentals,
      canonicalEpisodes: canonicalRentals,
      missingEpisodes,
      deterministic,
      status: deterministic ? "SAFE (sourceRows-verified)" : "REVIEW REQUIRED",
    });
  });

  const categoryTotals = { fragmented: 0, duplicate: 0, missingEpisode: 0, ambiguous: 0, safe: 0, review: 0 };
  results.forEach((r) => {
    if (r.deterministic) categoryTotals.safe++; else categoryTotals.review++;
    r.liveRecords.forEach((lr) => {
      if (lr.classification === "FRAGMENT OF CANONICAL EPISODE") categoryTotals.fragmented++;
      if (lr.classification === "DUPLICATE SOURCE ROW CLAIM") categoryTotals.duplicate++;
      if (lr.classification === "MISSING CANONICAL EPISODE") categoryTotals.missingEpisode++;
      if (lr.classification === "AMBIGUOUS / REVIEW REQUIRED") categoryTotals.ambiguous++;
    });
  });

  // Customer-level counts (how many CUSTOMERS exhibit each pattern at least once) — distinct
  // from categoryTotals above, which counts individual RECORDS.
  const customerCounts = {
    withDuplicateClaims: results.filter((r) => r.liveRecords.some((lr) => lr.classification === "DUPLICATE SOURCE ROW CLAIM")).length,
    withMissingSourceRows: results.filter((r) => r.liveRecords.some((lr) => (lr.record.sourceRows || []).length === 0)).length,
    withOnlyCleanFragments: results.filter((r) => r.deterministic && r.liveRecords.some((lr) => lr.classification === "FRAGMENT OF CANONICAL EPISODE") && r.liveRecords.every((lr) => lr.classification === "FRAGMENT OF CANONICAL EPISODE" || lr.classification === "MATCH")).length,
    withMissingCanonicalEpisode: results.filter((r) => r.missingEpisodes.length > 0 || r.liveRecords.some((lr) => lr.classification === "MISSING CANONICAL EPISODE")).length,
    withAmbiguous: results.filter((r) => r.liveRecords.some((lr) => lr.classification === "AMBIGUOUS / REVIEW REQUIRED")).length,
  };

  return { customers: results, categoryTotals, customerCounts };
}

/* ---------------------------------------------------------------------- */
/* NON-IMPORT RENTAL CLASSIFICATION DIAGNOSTIC (READ-ONLY). Scans every    */
/* current non-import rental (id NOT starting "imp_r") and classifies it   */
/* against that customer's canonical episodes, WITHOUT assuming "manual"   */
/* means suspicious — only overlap evidence (date/bike/revenue) marks a    */
/* record as a likely duplicate. No delete/repair action exists anywhere   */
/* in this screen.                                                         */
/* ---------------------------------------------------------------------- */

function classifyNonImportRentals() {
  const canonicalByCustomer = {};
  IMPORTED_RENTALS.forEach((r) => {
    (canonicalByCustomer[r.customerId] = canonicalByCustomer[r.customerId] || []).push(r);
  });

  const results = [];
  DB.data.customers.forEach((cust) => {
    // Only 2026-onward non-import rentals are in scope — 2025 stays legacy/recognition-only,
    // out of scope for this diagnostic the same way it's out of scope for Data Audit.
    const nonImport = DB.data.rentals.filter((r) =>
      r.customerId === cust.id && !String(r.id).startsWith("imp_r") && r.startDate >= LEGACY_CUTOFF_DATE
    );
    if (nonImport.length === 0) return;

    const canonical = canonicalByCustomer[cust.id] || [];

    const classified = nonImport.map((r) => {
      const zeroDayFinancial = (Number(r.paidDays) || 0) === 0 && (Number(r.revenue) || 0) > 0;
      let overlapEpisode = null;
      const overlapReasons = [];
      canonical.forEach((ep) => {
        if (overlapEpisode) return; // first genuine match is enough to explain this record
        const rEnd = r.endDate || r.startDate;
        const epEnd = ep.endDate || todayISO(); // an ongoing/active canonical episode extends through today, not just its own start date
        const dateOverlap = r.startDate <= epEnd && rEnd >= ep.startDate;
        const bikeMatchRaw = r.bikeNameRaw && ep.bikeNameRaw && normalizeText(r.bikeNameRaw) === normalizeText(ep.bikeNameRaw);
        // The exact cross-field comparison that explains how these records were created in
        // the first place: a raw bike name landing in bikeModel matching an existing
        // canonical record's true bikeNameRaw.
        const bikeMatchCross = r.bikeModel && ep.bikeNameRaw && normalizeText(r.bikeModel) === normalizeText(ep.bikeNameRaw);
        const revenueSubset = Number(r.revenue) > 0 && Number(r.revenue) <= Number(ep.revenue);
        const reasons = [];
        if (dateOverlap) reasons.push("date range overlaps this episode");
        if (bikeMatchRaw) reasons.push("bike (raw name) matches");
        if (bikeMatchCross) reasons.push("bike matches this episode's raw name (cross-field)");
        if (zeroDayFinancial && revenueSubset && (bikeMatchRaw || bikeMatchCross)) reasons.push("zero-day revenue is a plausible subset of this episode's total");
        if (reasons.length > 0) { overlapEpisode = ep; overlapReasons.push(...reasons); }
      });

      // A record can genuinely be BOTH a zero-day financial entry AND show duplicate
      // overlap — both signals are preserved and shown, never collapsed into one.
      let category;
      if (overlapEpisode) category = "B";
      else if (zeroDayFinancial) category = "C";
      else if ((Number(r.paidDays) || 0) > 0 && (Number(r.revenue) || 0) > 0) category = "A";
      else category = "D";

      return {
        id: r.id, startDate: r.startDate, endDate: r.endDate,
        paidDays: r.paidDays, bookedDays: r.bookedDays, revenue: r.revenue,
        bikeModel: r.bikeModel, bikeNameRaw: r.bikeNameRaw, status: r.status,
        sourceRows: r.sourceRows || null,
        category, zeroDayFinancial,
        overlapEpisodeId: overlapEpisode ? overlapEpisode.id : null,
        overlapReasons,
      };
    });

    const genuineCount = classified.filter((r) => r.category === "A").length;
    const duplicateCount = classified.filter((r) => r.category === "B").length;
    const zeroDayCount = classified.filter((r) => r.zeroDayFinancial).length; // independent of category, per the "show both signals" rule
    const ambiguousCount = classified.filter((r) => r.category === "D").length;
    const duplicateRevenueTotal = classified.filter((r) => r.category === "B").reduce((s, r) => s + (Number(r.revenue) || 0), 0);

    results.push({
      customerId: cust.id, name: cust.name,
      records: classified,
      genuineCount, duplicateCount, zeroDayCount, ambiguousCount, duplicateRevenueTotal,
    });
  });

  return {
    totalCustomers: results.length,
    totalDuplicateRevenue: results.reduce((s, r) => s + r.duplicateRevenueTotal, 0),
    customers: results.sort((a, b) => b.duplicateRevenueTotal - a.duplicateRevenueTotal),
  };
}

function renderNonImportClassificationScreen() {
  const diag = classifyNonImportRentals();
  const catBadge = (cat) => {
    if (cat === "A") return `<span class="pill pill-green">A · GENUINE</span>`;
    if (cat === "B") return `<span class="pill pill-red">B · LIKELY DUPLICATE</span>`;
    if (cat === "C") return `<span class="pill pill-amber">C · ZERO-DAY</span>`;
    return `<span class="pill pill-neutral">D · AMBIGUOUS</span>`;
  };

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="data-audit">‹ Data Audit</button>
      <h1 class="screen-title" style="margin-top:8px;">Non-Import Rental Review</h1>
      <p class="screen-sub">Read-only. Classifies every non-imported (manual-labeled) 2026 rental by comparing it against canonical import history — never assumes "manual" means suspicious. No delete or repair action exists on this screen.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value">${diag.totalCustomers}</div><div class="report-tile-label">Customers with Non-Import Rentals</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--red);">${fmtMoney(diag.totalDuplicateRevenue)}</div><div class="report-tile-label">Revenue in Likely Duplicates</div></div>
      </div>

      ${diag.customers.length === 0 ? `<div class="empty"><div class="empty-icon">✓</div><h3>Nothing to review</h3></div>` : diag.customers.map((c) => `
        <div class="card" style="margin-bottom:14px;">
          <div style="font-weight:700; font-size:15px; margin-bottom:8px;">${escapeHtml(c.name)}</div>
          <div class="grid-2" style="margin-bottom:10px;">
            <div><div class="muted" style="font-size:11px;">Genuine candidates (A)</div><div class="mono">${c.genuineCount}</div></div>
            <div><div class="muted" style="font-size:11px;">Likely duplicates (B)</div><div class="mono" style="color:var(--red);">${c.duplicateCount}</div></div>
            <div><div class="muted" style="font-size:11px;">Zero-day records (C)</div><div class="mono">${c.zeroDayCount}</div></div>
            <div><div class="muted" style="font-size:11px;">Ambiguous (D)</div><div class="mono">${c.ambiguousCount}</div></div>
          </div>
          <div class="reward-note" style="margin-bottom:10px;">Revenue currently contributed by likely duplicates: <b>${fmtMoney(c.duplicateRevenueTotal)}</b></div>
          ${c.records.map((r) => `
            <div class="reward-note" style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                <b>${escapeHtml(r.id)}</b> ${catBadge(r.category)}${r.zeroDayFinancial && r.category !== "C" ? ` <span class="pill pill-amber">zero-day</span>` : ""}
              </div>
              ${fmtDate(r.startDate)} → ${r.endDate ? fmtDate(r.endDate) : "ongoing"} · ${escapeHtml(r.bikeNameRaw || r.bikeModel || "—")} · ${fmtMoney(r.revenue)} · paidDays: ${r.paidDays}<br/>
              ${r.overlapEpisodeId ? `<span class="muted">Overlaps canonical ${escapeHtml(r.overlapEpisodeId)} — ${escapeHtml(r.overlapReasons.join(", "))}</span>` : `<span class="muted">No overlap found with canonical history</span>`}
            </div>
          `).join("")}
        </div>
      `).join("")}
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* CUSTOMER IDENTITY DIAGNOSTIC (READ-ONLY). Scans DB.data.customers for   */
/* duplicate passport numbers and duplicate cleaned names — the one thing  */
/* no existing diagnostic in this app currently covers (Non-Import Rental  */
/* Review, Data Audit, and Source-Row Mapping all operate on rentals, not  */
/* customer identity). No merge/delete/edit action exists anywhere here.   */
/* ---------------------------------------------------------------------- */

function buildCustomerIdentityDiagnostic() {
  const allCustomers = DB.data.customers;

  const byPassport = {};
  allCustomers.forEach((c) => {
    const p = normalizePassport(c.passport);
    if (p) (byPassport[p] = byPassport[p] || []).push(c);
  });
  const rawPassportGroups = Object.entries(byPassport).filter(([, cs]) => cs.length > 1);

  const byName = {};
  allCustomers.forEach((c) => {
    const n = normalizeText(cleanCustomerDisplayName(c.name));
    (byName[n] = byName[n] || []).push(c);
  });
  const rawNameGroups = Object.entries(byName).filter(([, cs]) => cs.length > 1);

  function detailFor(c) {
    const rentals = DB.data.rentals.filter((r) => r.customerId === c.id);
    const rewards = DB.data.rewards.filter((r) => r.customerId === c.id);
    const importCount = rentals.filter((r) => String(r.id).startsWith("imp_r")).length;
    const nonImportCount = rentals.length - importCount;
    const hasMgrRowNumber = rentals.some((r) => r.mgrRowNumber !== undefined && r.mgrRowNumber !== null);
    let sourceType;
    if (rentals.length === 0) sourceType = "none";
    else if (importCount > 0 && nonImportCount > 0) sourceType = "mixed";
    else if (importCount > 0) sourceType = "imported";
    else sourceType = "manual";
    return {
      id: c.id, name: c.name, passport: c.passport || null,
      rentalCount: rentals.length, rewardCount: rewards.length,
      sourceType, hasMgrRowNumber,
    };
  }

  function classifyGroup(details) {
    const withHistory = details.filter((d) => d.rentalCount > 0 || d.rewardCount > 0);
    if (withHistory.length === 0) return "shadow_empty_all"; // all copies empty — likely accidental duplicates, safest to clean up
    if (withHistory.length === 1) return "shadow_empty_one"; // one real record, rest are empty shadows — very likely deterministically cleanable
    // 2+ copies each have real history — cannot safely auto-resolve, always human review
    const identicalLooking = withHistory.every((d) => d.rentalCount === withHistory[0].rentalCount && d.rewardCount === withHistory[0].rewardCount && d.sourceType === withHistory[0].sourceType);
    return identicalLooking ? "both_meaningful_similar" : "both_meaningful_different";
  }

  const passportGroups = rawPassportGroups.map(([passport, cs]) => {
    const details = cs.map(detailFor);
    return { passport, customers: details, classification: classifyGroup(details) };
  });
  const nameGroups = rawNameGroups.map(([name, cs]) => {
    const details = cs.map(detailFor);
    return { name, customers: details, classification: classifyGroup(details) };
  });

  const affectedCustomerIds = new Set();
  passportGroups.forEach((g) => g.customers.forEach((c) => affectedCustomerIds.add(c.id)));
  nameGroups.forEach((g) => g.customers.forEach((c) => affectedCustomerIds.add(c.id)));

  const allGroups = [...passportGroups, ...nameGroups];
  const deterministicCount = allGroups.filter((g) => g.classification === "shadow_empty_all" || g.classification === "shadow_empty_one").length;
  const humanReviewCount = allGroups.filter((g) => g.classification === "both_meaningful_similar" || g.classification === "both_meaningful_different").length;

  return {
    totalCustomers: allCustomers.length,
    passportGroups, nameGroups,
    affectedCustomerCount: affectedCustomerIds.size,
    affectedCustomerIds: [...affectedCustomerIds],
    deterministicCount, humanReviewCount,
  };
}

// Cross-references the identity diagnostic above against a Manager Sync plan's Needs
// Review entries (passport_conflict / multiple_customer_match specifically), using the
// customerIds now captured on those entries. Purely read-only — just counts overlap.
function crossReferenceIdentityWithManagerSync(identityDiagnostic, syncPlan) {
  if (!syncPlan) return null;
  const groupedCustomerIds = new Set(identityDiagnostic.affectedCustomerIds);
  const relevant = syncPlan.needsReview.filter((r) => r.category === "passport_conflict" || r.category === "multiple_customer_match");
  const explained = relevant.filter((r) => (r.customerIds || []).some((id) => groupedCustomerIds.has(id)));
  return { totalRelevant: relevant.length, explainedByIdentityGroups: explained.length };
}

/* ---------------------------------------------------------------------- */
/* REPAIR PREVIEW (READ-ONLY, NO EXECUTION PATH EXISTS YET). Resolves only */
/* the deterministic subset of duplicate structure — reuses the identity   */
/* and non-import diagnostics above rather than re-deriving matching       */
/* logic. Everything that isn't provably safe stays in manualReview.       */
/* There is no apply/commit function anywhere in this section — building   */
/* one is a deliberately separate future step, not part of this preview.   */
/* ---------------------------------------------------------------------- */

function buildRepairPlan() {
  const identity = buildCustomerIdentityDiagnostic();
  const nonImport = classifyNonImportRentals();

  const proposedMerges = [];
  const manualReview = [];
  const mergedPairKeys = new Set(); // dedupe a pair proposed via both a passport group and a name group

  // A pair is only ever merged if it resolves to exactly one record with real history and
  // one completely empty (rule 1/2) — never when both sides carry any rental or reward.
  function tryProposeMerge(customers, reason) {
    if (customers.length !== 2) return false; // 3+ records sharing an identity signal is never a clean deterministic pair
    const withHistory = customers.filter((c) => c.rentalCount > 0 || c.rewardCount > 0);
    const empty = customers.filter((c) => c.rentalCount === 0 && c.rewardCount === 0);
    if (withHistory.length !== 1 || empty.length !== 1) return false;
    const key = [customers[0].id, customers[1].id].sort().join("|");
    if (mergedPairKeys.has(key)) return true;
    mergedPairKeys.add(key);
    proposedMerges.push({
      keepCustomerId: withHistory[0].id, keepName: withHistory[0].name,
      removeCustomerId: empty[0].id, removeName: empty[0].name,
      reason,
      keepRentals: withHistory[0].rentalCount, keepRewards: withHistory[0].rewardCount,
      keepSourceType: withHistory[0].sourceType,
    });
    return true;
  }

  // 1. Duplicate passport groups.
  identity.passportGroups.forEach((g) => {
    if (g.customers.length !== 2) {
      manualReview.push({ type: "passport_group", key: g.passport, customerIds: g.customers.map((c) => c.id), reason: `${g.customers.length} records share passport "${g.passport}" — not a clean pair, never auto-resolved.` });
      return;
    }
    const merged = tryProposeMerge(g.customers, `Shared passport "${g.passport}" — one record has real history, the other is completely empty.`);
    if (!merged) {
      manualReview.push({ type: "passport_group", key: g.passport, customerIds: g.customers.map((c) => c.id), reason: `Both records sharing passport "${g.passport}" contain meaningful rental/reward history — never auto-merged.` });
    }
  });

  // 2. Duplicate cleaned-name groups — only merged if passport ALSO confirms the same pair,
  // or the pair is unambiguous (exactly 2, one completely empty). No fuzzy name matching
  // anywhere in this decision.
  identity.nameGroups.forEach((g) => {
    if (g.customers.length !== 2) {
      manualReview.push({ type: "name_group", key: g.name, customerIds: g.customers.map((c) => c.id), reason: `${g.customers.length} records share this cleaned name — not a clean pair, never auto-resolved.` });
      return;
    }
    const pairKey = g.customers.map((c) => c.id).sort().join("|");
    if (mergedPairKeys.has(pairKey)) return; // already proposed via a passport group above
    const passportConfirms = identity.passportGroups.some((pg) => pg.customers.map((c) => c.id).sort().join("|") === pairKey);
    const reason = passportConfirms
      ? `Shared cleaned name "${g.name}" — passport also confirms the same person.`
      : `Shared cleaned name "${g.name}" — one record is completely empty, identity unambiguous (exactly 2 records, no passport conflict).`;
    const merged = tryProposeMerge(g.customers, reason);
    if (!merged) {
      manualReview.push({ type: "name_group", key: g.name, customerIds: g.customers.map((c) => c.id), reason: `Both records sharing the cleaned name "${g.name}" contain meaningful history, and passport does not confirm — never auto-merged.` });
    }
  });

  // 3. Zero-day/manual duplicate rentals — reuses classifyNonImportRentals()'s own overlap
  // detection (customer + raw bike identity + date overlap against a canonical episode)
  // rather than re-deriving it. Only records that are BOTH zero-day AND already classified
  // as a likely duplicate (category B) are proposed — a zero-day record with no overlap at
  // all is left alone, per rule 3.
  const proposedRentalRemovals = [];
  nonImport.customers.forEach((cust) => {
    cust.records.forEach((r) => {
      if (r.zeroDayFinancial && r.category === "B" && r.overlapEpisodeId) {
        proposedRentalRemovals.push({
          rentalId: r.id, customerId: cust.customerId, customerName: cust.name,
          revenue: r.revenue, bikeNameRaw: r.bikeNameRaw, startDate: r.startDate, endDate: r.endDate,
          overlapsWith: r.overlapEpisodeId, overlapReasons: r.overlapReasons,
        });
      } else if (r.zeroDayFinancial) {
        // Zero-day but no clear canonical overlap found — stays manual, never assumed stale.
        manualReview.push({ type: "zero_day_no_overlap", key: r.id, customerIds: [cust.customerId], reason: `${cust.name}'s record ${r.id} is a zero-day financial entry but doesn't clearly overlap a canonical episode — left for manual review, not assumed to be an artifact.` });
      }
    });
  });

  // Always-manual categories, per rule 4 — explicitly untouched by this plan. Nothing here
  // computes or proposes anything for these; listed only so the preview can say so plainly.
  const alwaysManualNote = "completed→active changes, passport/name conflicts where both records have real history, multiple-rental-match ambiguity, and missing/invalid data are never auto-resolved by this plan.";

  return {
    proposedMerges,
    proposedRentalRemovals,
    manualReview,
    alwaysManualNote,
    beforeCustomerCount: DB.data.customers.length,
    afterCustomerCount: DB.data.customers.length - proposedMerges.length,
    beforeRentalCount: DB.data.rentals.length,
    afterRentalCount: DB.data.rentals.length - proposedRentalRemovals.length,
  };
}

function renderCustomerIdentityDiagnosticScreen() {
  const diag = buildCustomerIdentityDiagnostic();
  const crossRef = crossReferenceIdentityWithManagerSync(diag, state.managerSyncPlan);

  const classLabel = {
    shadow_empty_all: "All copies empty — likely accidental duplicates",
    shadow_empty_one: "One real record + empty shadow(s) — likely deterministically cleanable",
    both_meaningful_similar: "Two+ records both have history, look similar — human review",
    both_meaningful_different: "Two+ records both have history, differ — human review",
  };
  const classColor = {
    shadow_empty_all: "var(--green)", shadow_empty_one: "var(--green)",
    both_meaningful_similar: "var(--red)", both_meaningful_different: "var(--red)",
  };

  const renderCustomerRow = (c) => `
    <div class="reward-note" style="margin-bottom:4px;">
      <b>${escapeHtml(c.name)}</b> (${escapeHtml(c.id)})<br/>
      <span class="muted">Passport: ${c.passport ? escapeHtml(c.passport) : "—"} · Rentals: ${c.rentalCount} (${c.sourceType}) · Rewards: ${c.rewardCount} · mgrRowNumber present: ${c.hasMgrRowNumber ? "Yes" : "No"}</span>
    </div>
  `;

  const renderGroup = (g, keyLabel, keyValue) => `
    <div class="card" style="margin-bottom:12px;">
      <div class="card-row" style="margin-bottom:8px;">
        <div style="font-weight:700; font-size:14px;">${escapeHtml(keyLabel)}: ${escapeHtml(keyValue)}</div>
        <span class="pill" style="background:${classColor[g.classification]}; color:#fff;">${escapeHtml(classLabel[g.classification])}</span>
      </div>
      ${g.customers.map(renderCustomerRow).join("")}
    </div>
  `;

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="data-audit">‹ Data Audit</button>
      <h1 class="screen-title" style="margin-top:8px;">Customer Identity Diagnostic</h1>
      <p class="screen-sub">Read-only. Scans stored customer records for duplicate passports and duplicate cleaned names. No merge, delete, or edit action exists on this screen.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value">${diag.totalCustomers}</div><div class="report-tile-label">Total Customers</div></div>
        <div class="report-tile"><div class="report-tile-value">${diag.affectedCustomerCount}</div><div class="report-tile-label">Customers Affected</div></div>
        <div class="report-tile"><div class="report-tile-value">${diag.passportGroups.length}</div><div class="report-tile-label">Duplicate Passport Groups</div></div>
        <div class="report-tile"><div class="report-tile-value">${diag.nameGroups.length}</div><div class="report-tile-label">Duplicate Name Groups</div></div>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <div class="grid-2">
          <div><div class="muted" style="font-size:11.5px;">Look deterministically cleanable</div><div style="font-weight:700; color:var(--green);">${diag.deterministicCount}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Require human review</div><div style="font-weight:700; color:var(--red);">${diag.humanReviewCount}</div></div>
        </div>
      </div>

      ${crossRef ? `
        <div class="card" style="margin-bottom:16px; border: 1.5px dashed var(--orange-soft-line);">
          <div style="font-weight:700; margin-bottom:6px;">Cross-Reference with Manager Sync</div>
          <p class="muted">Of ${crossRef.totalRelevant} current Needs Review rows in the Passport/name conflict and Multiple customer identity match categories, <b>${crossRef.explainedByIdentityGroups}</b> involve a customer that also appears in one of the duplicate groups below.</p>
        </div>
      ` : `
        <div class="card" style="margin-bottom:16px;">
          <p class="muted">No current Manager Sync plan in memory to cross-reference against — run "Check Now" on Manager Sync first if you want that comparison.</p>
        </div>
      `}

      ${diag.passportGroups.length > 0 ? `
        <div class="section-title">Duplicate Passport Groups</div>
        ${diag.passportGroups.map((g) => renderGroup(g, "Passport", g.passport)).join("")}
      ` : ""}

      ${diag.nameGroups.length > 0 ? `
        <div class="section-title">Duplicate Name Groups</div>
        ${diag.nameGroups.map((g) => renderGroup(g, "Name", g.name)).join("")}
      ` : ""}

      ${diag.passportGroups.length === 0 && diag.nameGroups.length === 0 ? `
        <div class="empty"><div class="empty-icon">✓</div><h3>No duplicates found</h3></div>
      ` : ""}

      <button class="btn btn-outline btn-block" data-goto="repair-preview" style="margin-top:16px;">View Repair Preview</button>
    </div>
  `;
}

// Read-only preview of buildRepairPlan()'s proposed repairs. No action button of any kind
// exists on this screen — no merge, no delete, no apply/execute. That deliberately doesn't
// exist yet; this screen only shows what a repair WOULD do.
function renderRepairPreviewScreen() {
  const plan = buildRepairPlan();
  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="customer-identity-diagnostic">‹ Customer Identity Diagnostic</button>
      <h1 class="screen-title" style="margin-top:8px;">Repair Preview</h1>
      <p class="screen-sub">Read-only. Shows exactly what a repair of deterministic duplicates would change — nothing is written. No merge, delete, or apply action exists on this screen.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value" style="color:var(--green);">${plan.proposedMerges.length}</div><div class="report-tile-label">Customer Merges Proposed</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--green);">${plan.proposedRentalRemovals.length}</div><div class="report-tile-label">Rental Artifacts Proposed</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--red);">${plan.manualReview.length}</div><div class="report-tile-label">Unresolved — Manual Review</div></div>
        <div class="report-tile"><div class="report-tile-value">${plan.proposedMerges.length + plan.proposedRentalRemovals.length}</div><div class="report-tile-label">Total Deterministic</div></div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="section-label" style="margin-top:0;">Before / After Counts</div>
        <div class="grid-2">
          <div><div class="muted" style="font-size:11.5px;">Customers</div><div style="font-weight:700;">${plan.beforeCustomerCount} → ${plan.afterCustomerCount}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Rentals</div><div style="font-weight:700;">${plan.beforeRentalCount} → ${plan.afterRentalCount}</div></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <p class="muted">Always manual, never auto-resolved by this plan: ${escapeHtml(plan.alwaysManualNote)}</p>
      </div>

      ${plan.proposedMerges.length > 0 ? `
        <div class="section-title">Customer Merges Proposed</div>
        ${plan.proposedMerges.map((m) => `
          <div class="reward-note" style="margin-bottom:8px;">
            Keep <b>${escapeHtml(m.keepName)}</b> (${escapeHtml(m.keepCustomerId)}) — ${m.keepRentals} rentals, ${m.keepRewards} rewards, ${escapeHtml(m.keepSourceType)}<br/>
            Remove <b>${escapeHtml(m.removeName)}</b> (${escapeHtml(m.removeCustomerId)}) — empty shadow record<br/>
            <span class="muted">${escapeHtml(m.reason)}</span>
          </div>
        `).join("")}
      ` : ""}

      ${plan.proposedRentalRemovals.length > 0 ? `
        <div class="section-title">Rental Artifacts Proposed for Removal</div>
        ${plan.proposedRentalRemovals.map((r) => `
          <div class="reward-note" style="margin-bottom:8px;">
            <b>${escapeHtml(r.rentalId)}</b> — ${escapeHtml(r.customerName)} (${escapeHtml(r.customerId)})<br/>
            ${escapeHtml(r.bikeNameRaw || "")} · ${fmtDate(r.startDate)} → ${r.endDate ? fmtDate(r.endDate) : "ongoing"} · ${fmtMoney(r.revenue)}<br/>
            <span class="muted">Overlaps canonical ${escapeHtml(r.overlapsWith)} — ${escapeHtml(r.overlapReasons.join(", "))}</span>
          </div>
        `).join("")}
      ` : ""}

      ${plan.manualReview.length > 0 ? `
        <div class="section-title">Unresolved — Manual Review (${plan.manualReview.length})</div>
        ${plan.manualReview.map((m) => `<div class="reward-note" style="margin-bottom:6px;"><span class="muted">${escapeHtml(m.reason)}</span></div>`).join("")}
      ` : ""}
    </div>
  `;
}

// Read-only screen for the source-row mapping diagnostic. Nothing here writes anything —
// it only displays buildSourceRowMappingDiagnostic()'s output.
function renderSourceRowDiagnosticScreen() {
  const diag = buildSourceRowMappingDiagnostic();
  const classPill = (c) => {
    if (c === "MATCH") return `<span class="pill pill-green">MATCH</span>`;
    if (c === "FRAGMENT OF CANONICAL EPISODE") return `<span class="pill pill-amber">FRAGMENT</span>`;
    if (c === "DUPLICATE SOURCE ROW CLAIM") return `<span class="pill pill-red">DUPLICATE CLAIM</span>`;
    if (c === "MISSING CANONICAL EPISODE") return `<span class="pill pill-red">NO CANONICAL MATCH</span>`;
    return `<span class="pill pill-neutral">AMBIGUOUS</span>`;
  };

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="data-audit">‹ Data Audit</button>
      <h1 class="screen-title" style="margin-top:8px;">Source-Row Mapping</h1>
      <p class="screen-sub">Every live record for each mismatched customer, matched to canonical episodes by source spreadsheet row only — never by technical rental ID.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value" style="color:var(--green);">${diag.categoryTotals.safe}</div><div class="report-tile-label">Deterministic (SAFE)</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--red);">${diag.categoryTotals.review}</div><div class="report-tile-label">Review Required</div></div>
        <div class="report-tile"><div class="report-tile-value">${diag.categoryTotals.fragmented}</div><div class="report-tile-label">Fragment Records</div></div>
        <div class="report-tile"><div class="report-tile-value">${diag.categoryTotals.duplicate}</div><div class="report-tile-label">Duplicate Claims</div></div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="section-label" style="margin-top:0;">Customer-Level Summary</div>
        <div class="grid-2">
          <div><div class="muted" style="font-size:11px;">Total customers analysed</div><div style="font-weight:700;">${diag.customers.length}</div></div>
          <div><div class="muted" style="font-size:11px;">SAFE / deterministic</div><div style="font-weight:700; color:var(--green);">${diag.categoryTotals.safe}</div></div>
          <div><div class="muted" style="font-size:11px;">Review Required</div><div style="font-weight:700; color:var(--red);">${diag.categoryTotals.review}</div></div>
          <div><div class="muted" style="font-size:11px;">With duplicate source-row claims</div><div style="font-weight:700;">${diag.customerCounts.withDuplicateClaims}</div></div>
          <div><div class="muted" style="font-size:11px;">With records missing sourceRows</div><div style="font-weight:700;">${diag.customerCounts.withMissingSourceRows}</div></div>
          <div><div class="muted" style="font-size:11px;">Only clean fragments</div><div style="font-weight:700;">${diag.customerCounts.withOnlyCleanFragments}</div></div>
          <div><div class="muted" style="font-size:11px;">With missing canonical episode</div><div style="font-weight:700;">${diag.customerCounts.withMissingCanonicalEpisode}</div></div>
          <div><div class="muted" style="font-size:11px;">With ambiguous mappings</div><div style="font-weight:700;">${diag.customerCounts.withAmbiguous}</div></div>
        </div>
      </div>

      ${diag.customers.length === 0 ? `<div class="empty"><div class="empty-icon">✓</div><h3>Nothing to map</h3></div>` : diag.customers.map((c) => `
        <div class="card" style="margin-bottom:14px;">
          <div class="card-row" style="margin-bottom:10px;">
            <div style="font-weight:700; font-size:15px;">${escapeHtml(c.name)}</div>
            <span class="pill ${c.deterministic ? "pill-green" : "pill-red"}">${c.deterministic ? "SAFE" : "REVIEW REQUIRED"}</span>
          </div>

          <div class="section-label" style="margin-top:0;">Canonical Episodes (${c.canonicalEpisodes.length})</div>
          ${c.canonicalEpisodes.map((ep) => `
            <div class="reward-note" style="margin-bottom:6px;">
              <b>${fmtDate(ep.startDate)} → ${ep.endDate ? fmtDate(ep.endDate) : "ongoing"}</b> · ${escapeHtml(ep.bikeNameRaw || ep.bikeModel)} · ${fmtMoney(ep.revenue)} · ${ep.paidDays} days<br/>
              <span class="muted">sourceRows: ${(ep.sourceRows || []).map(escapeHtml).join(", ") || "—"}</span>
              ${c.missingEpisodes.some((m) => m.id === ep.id) ? `<br/><span style="color:var(--red);">No live record fully covers this episode</span>` : ""}
            </div>
          `).join("")}

          <div class="section-label">Live Records (${c.liveRecords.length})</div>
          ${c.liveRecords.map((lr) => `
            <div class="reward-note" style="margin-bottom:6px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                <b>${escapeHtml(lr.id)}</b> ${classPill(lr.classification)}
              </div>
              ${fmtDate(lr.record.startDate)} → ${lr.record.endDate ? fmtDate(lr.record.endDate) : "ongoing"} · ${escapeHtml(lr.record.bikeNameRaw || lr.record.bikeModel)} · ${fmtMoney(lr.record.revenue)} · ${lr.record.paidDays} days<br/>
              <span class="muted">sourceRows: ${(lr.record.sourceRows || []).map(escapeHtml).join(", ") || "none"}</span><br/>
              <span class="muted">${escapeHtml(lr.reason)}</span>
            </div>
          `).join("")}

          ${c.manualRentals.length > 0 ? `<div class="section-label">Manual Rentals (never touched, ${c.manualRentals.length})</div>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* PHASE 2 — RECONCILIATION PLAN (PREVIEW ONLY, STRICTLY READ-ONLY).       */
/* Computes what a future repair WOULD do, for inspection only. Does not   */
/* call DB.save(), does not assign to any DB.data field, does not touch    */
/* localStorage. No button in this UI triggers a write — this function's   */
/* only output is a plain JS object describing a plan, and a render        */
/* function that displays it.                                              */
/* ---------------------------------------------------------------------- */

// Fields compared to detect an import-sourced record that's been edited in place since
// import (same id, different values) — this must NEVER be silently overwritten, since it
// likely represents a legitimate staff correction, not stale pre-merge data.
const RECONCILE_COMPARE_FIELDS = ["startDate", "endDate", "bookedDays", "paidDays", "revenue", "bikeModel", "bikeNameRaw", "status"];

function buildReconciliationPlan() {
  // 2025 is legacy/recognition-only — excluded from the reconciliation plan the same way
  // it's excluded from Data Audit and Source-Row Mapping. (This route stays disabled
  // regardless — updated here only for internal consistency, per instruction.)
  const canonicalByCustomer = {};
  IMPORTED_RENTALS.filter((r) => r.startDate >= LEGACY_CUTOFF_DATE).forEach((r) => {
    (canonicalByCustomer[r.customerId] = canonicalByCustomer[r.customerId] || []).push(r);
  });

  const plans = [];
  IMPORTED_CUSTOMERS.forEach((seedCust) => {
    const custId = seedCust.id;
    const canonicalRentals = canonicalByCustomer[custId] || [];
    const canonicalVisits = canonicalRentals.length;
    const canonicalDays = canonicalRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const canonicalRevenue = canonicalRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const canonicalById = {};
    canonicalRentals.forEach((r) => { canonicalById[r.id] = r; });

    const storedCust = DB.data.customers.find((c) => c.id === custId);
    const displayName = storedCust ? storedCust.name : seedCust.name;
    const storedRentals = DB.data.rentals.filter((r) => r.customerId === custId && r.startDate >= LEGACY_CUTOFF_DATE); // read-only filter
    const storedVisits = storedRentals.length;
    const storedDays = storedRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const storedRevenue = storedRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);

    // Same mismatch definition as runDataAudit() — only a MISMATCH customer is a candidate.
    const isMatch = storedVisits === canonicalVisits && storedDays === canonicalDays && storedRevenue === canonicalRevenue;
    if (isMatch) return;

    // A) imported historical records = id starts with "imp_r" (assigned once, at import
    //    time, never reused for anything else). B) manually created records = everything
    //    else (uid("r") never produces this prefix) — these are NEVER a reconciliation
    //    candidate, full stop, regardless of SAFE/REVIEW status.
    const manualRentals = storedRentals.filter((r) => !String(r.id).startsWith("imp_r"));
    const importSourcedStored = storedRentals.filter((r) => String(r.id).startsWith("imp_r"));

    // C) records potentially linked to rewards, or edited in place since import — both
    // make automatic reconciliation ambiguous for this customer.
    let editedRecordCount = 0;
    importSourcedStored.forEach((r) => {
      const canon = canonicalById[r.id];
      if (canon && RECONCILE_COMPARE_FIELDS.some((f) => String(r[f] ?? "") !== String(canon[f] ?? ""))) {
        editedRecordCount++;
      }
    });

    const custRewards = DB.data.rewards.filter((r) => r.customerId === custId);
    const hasRewardHistory = custRewards.some((r) => r.given || r.reserved);
    const canonicalIds = new Set(canonicalRentals.map((r) => r.id));
    const riskyRewards = custRewards.filter((r) => (r.given || r.reserved) && r.rentalId && !canonicalIds.has(r.rentalId));

    const ambiguous = editedRecordCount > 0 || riskyRewards.length > 0;
    const manualDays = manualRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const manualRevenue = manualRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);

    plans.push({
      customerId: custId,
      name: displayName,
      storedVisits, storedDays, storedRevenue,
      afterVisits: canonicalVisits + manualRentals.length,
      afterDays: canonicalDays + manualDays,
      afterRevenue: canonicalRevenue + manualRevenue,
      staleImportRecordsToReplace: importSourcedStored.length,
      manualRentalsPreserved: manualRentals.length,
      hasRewardHistory,
      riskyRewardCount: riskyRewards.length,
      editedRecordCount,
      status: ambiguous ? "REVIEW REQUIRED" : "SAFE",
    });
  });

  return {
    total: plans.length,
    safeCount: plans.filter((p) => p.status === "SAFE").length,
    reviewCount: plans.filter((p) => p.status === "REVIEW REQUIRED").length,
    plans: plans.sort((a, b) => Math.abs(b.storedRevenue - b.afterRevenue) - Math.abs(a.storedRevenue - a.afterRevenue)),
  };
}

// Read-only report screen. Reached only via a Settings button — never auto-runs, never
// wired to anything that mutates data. Rebuilding this view (e.g. tapping back and
// re-entering) simply re-runs the same read-only comparison; it cannot drift or accumulate
// state because it holds none.
function renderDataAuditScreen() {
  const audit = runDataAudit();
  const riskPill = (level) => level === "NEEDS REVIEW"
    ? `<span class="pill pill-red">NEEDS REVIEW</span>`
    : `<span class="pill pill-green">SAFE TO RECONCILE</span>`;

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="settings">‹ Settings</button>
      <h1 class="screen-title" style="margin-top:8px;">Data Audit</h1>
      <p class="screen-sub">Read-only. Imported-history mismatch is judged ONLY against live import-sourced records — manual rentals are shown separately and never count toward a mismatch.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value">${audit.totalAudited}</div><div class="report-tile-label">Customers Audited</div></div>
        <div class="report-tile"><div class="report-tile-value">${audit.importMatchCount}</div><div class="report-tile-label">Imported History MATCH</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:${audit.importMismatchCount > 0 ? "var(--red)" : "var(--ink)"};">${audit.importMismatchCount}</div><div class="report-tile-label">Imported History MISMATCH</div></div>
        <div class="report-tile"><div class="report-tile-value">${audit.customersWithManual}</div><div class="report-tile-label">Customers with Manual Rentals</div></div>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <div class="grid-2">
          <div><div class="muted" style="font-size:11.5px;">Mismatched only because of manual rentals (import history was actually fine)</div><div style="font-weight:700;">${audit.mismatchOnlyBecauseOfManual}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Genuine imported-history mismatches remaining</div><div style="font-weight:700; color:${audit.importMismatchCount > 0 ? "var(--red)" : "var(--ink)"};">${audit.importMismatchCount}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Genuine imported-history revenue discrepancy</div><div style="font-weight:700;">${audit.importDiffRevenueTotal > 0 ? "+" : ""}${fmtMoney(audit.importDiffRevenueTotal)}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Legitimate manual-rental revenue (never a mismatch)</div><div style="font-weight:700;">${fmtMoney(audit.manualRevenueTotal)}</div></div>
        </div>
      </div>

      ${audit.importMismatchCount > 0 ? `
        <div class="card" style="margin-bottom:16px; border: 1.5px dashed var(--orange-soft-line);">
          <div style="font-weight:700; margin-bottom:6px;">Source-Row Mapping Diagnostic</div>
          <p class="muted" style="margin-bottom:12px;">Verifies whether every genuinely mismatched customer's live import-sourced records can be deterministically matched to canonical episodes by source spreadsheet row — never by technical rental ID. Read-only.</p>
          <button class="btn btn-outline btn-block" data-goto="sourcerow-diagnostic">View Source-Row Mapping</button>
        </div>
      ` : ""}

      ${audit.customersWithManual > 0 ? `
        <div class="card" style="margin-bottom:16px; border: 1.5px dashed var(--orange-soft-line);">
          <div style="font-weight:700; margin-bottom:6px;">Non-Import Rental Review</div>
          <p class="muted" style="margin-bottom:12px;">Classifies every non-imported (manual-labeled) rental for the ${audit.customersWithManual} customer${audit.customersWithManual === 1 ? "" : "s"} who have them — genuine new activity, likely duplicates of already-imported history, zero-day financial entries, or ambiguous. Never assumes "manual" means suspicious. Read-only, no delete or repair action.</p>
          <button class="btn btn-outline btn-block" data-goto="nonimport-review">Review Non-Import Rentals</button>
        </div>
      ` : ""}

      <div class="card" style="margin-bottom:16px; border: 1.5px dashed var(--orange-soft-line);">
        <div style="font-weight:700; margin-bottom:6px;">Customer Identity Diagnostic</div>
        <p class="muted" style="margin-bottom:12px;">Scans stored customer records for duplicate passport numbers and duplicate cleaned names — no existing screen checks this. Read-only, no merge/delete/edit action.</p>
        <button class="btn btn-outline btn-block" data-goto="customer-identity-diagnostic">View Customer Identity Diagnostic</button>
      </div>


      ${audit.importMismatchCount > 0 ? `
        <div class="card" style="margin-bottom:16px; border: 1.5px dashed var(--red);">
          <div style="font-weight:700; margin-bottom:6px;">Phase 2 — Reconciliation Preview (Temporarily Disabled)</div>
          <p class="muted">The reconciliation model is being reworked following the manual-rentals audit correction. This path is disabled for now so the old model can't run by accident — it will be re-enabled once the updated model is approved.</p>
        </div>
      ` : ""}

      ${audit.rows.length === 0 ? `
        <div class="empty"><div class="empty-icon">✓</div><h3>No mismatches found</h3><p>Every audited customer's imported history matches the canonical data exactly.</p></div>
      ` : audit.rows.map((r) => `
        <div class="card" style="margin-bottom:12px;">
          <div class="card-row" style="margin-bottom:8px;">
            <div style="font-weight:700; font-size:15px;">${escapeHtml(r.name)}</div>
            <span class="pill ${r.importStatus === "MATCH" ? "pill-green" : "pill-red"}">${r.importStatus === "MATCH" ? "IMPORT MATCH" : "IMPORT MISMATCH"}</span>
          </div>

          <div class="section-label" style="margin-top:0;">Imported History</div>
          <div class="grid-2" style="margin-bottom:6px;">
            <div><div class="muted" style="font-size:11px;">Live Imported</div><div class="mono">${r.importVisits}v / ${r.importDays}d / ${fmtMoney(r.importRevenue)}</div></div>
            <div><div class="muted" style="font-size:11px;">Canonical</div><div class="mono">${r.canonicalVisits}v / ${r.canonicalDays}d / ${fmtMoney(r.canonicalRevenue)}</div></div>
          </div>
          ${r.importStatus === "MISMATCH" ? `<div class="reward-note" style="margin-bottom:8px; color:var(--red);">Difference: ${r.importDiffRevenue > 0 ? "+" : ""}${fmtMoney(r.importDiffRevenue)}</div>` : ""}

          ${r.manualVisits > 0 ? `
            <div class="section-label">Manual Rentals</div>
            <div class="reward-note" style="margin-bottom:8px;">
              ${r.manualVisits} visit${r.manualVisits === 1 ? "" : "s"} · ${r.manualDays} paid days · ${fmtMoney(r.manualRevenue)}<br/>
              <span class="muted">Legitimate manual history — excluded from canonical audit</span>
            </div>
          ` : ""}

          <div class="section-label">Full Customer Total</div>
          <div class="reward-note" style="margin-bottom:8px;">${r.totalVisits} visits · ${r.totalDays} paid days · ${fmtMoney(r.totalRevenue)} lifetime revenue</div>

          <div class="status-line" style="margin-bottom:8px;">
            <span>Reward History: <b>${r.hasRewardHistory ? "Yes" : "No"}</b></span>
            <span>Linked rewards at risk: <b>${r.riskyRewardCount}</b></span>
          </div>
          ${r.importStatus === "MISMATCH" ? riskPill(r.riskLevel) : ""}
        </div>
      `).join("")}
    </div>
  `;
}

// PHASE 2 PREVIEW SCREEN — displays buildReconciliationPlan()'s output. Purely
// informational: every value on this screen comes from a read-only computation: there is
// no button anywhere on this screen that calls DB.save(), mutates DB.data, or touches
// localStorage. Backup export (already-existing, already read-only DB.exportJSON()) is
// offered here as a convenience, ready whenever a real repair step is built and approved.
function renderReconcilePreviewScreen() {
  const plan = buildReconciliationPlan();
  const statusPill = (status) => status === "SAFE"
    ? `<span class="pill pill-green">SAFE</span>`
    : `<span class="pill pill-red">REVIEW REQUIRED</span>`;

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="data-audit">‹ Data Audit</button>
      <h1 class="screen-title" style="margin-top:8px;">Reconciliation Preview</h1>
      <p class="screen-sub">Shows exactly what a repair would change. Nothing is written from this screen.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value">${plan.total}</div><div class="report-tile-label">Mismatched Customers</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--green);">${plan.safeCount}</div><div class="report-tile-label">SAFE</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--red);">${plan.reviewCount}</div><div class="report-tile-label">Review Required</div></div>
      </div>

      ${plan.safeCount > 0 ? `
        <button class="btn btn-primary btn-block" data-goto="reconcile-confirm" style="margin-bottom:16px;">Continue to Confirm Reconciliation</button>
      ` : ""}

      <div class="card" style="margin-bottom:16px;">
        <p class="muted" style="margin-bottom:10px;">Optional: save a full backup of this device's current data now (this export itself changes nothing — it only downloads a copy).</p>
        <button class="btn btn-outline btn-block" id="export-backup-now">Export Backup (JSON)</button>
      </div>

      ${plan.plans.length === 0 ? `
        <div class="empty"><div class="empty-icon">✓</div><h3>Nothing to preview</h3><p>No mismatched customers found.</p></div>
      ` : plan.plans.map((p) => `
        <div class="card" style="margin-bottom:12px;">
          <div class="card-row" style="margin-bottom:8px;">
            <div style="font-weight:700; font-size:15px;">${escapeHtml(p.name)}</div>
            ${statusPill(p.status)}
          </div>
          <div class="section-label" style="margin-top:0;">Current Stored</div>
          <div class="grid-2" style="margin-bottom:8px;">
            <div><div class="muted" style="font-size:11px;">Rental Visits</div><div class="mono">${p.storedVisits}</div></div>
            <div><div class="muted" style="font-size:11px;">Paid Days</div><div class="mono">${p.storedDays}</div></div>
            <div><div class="muted" style="font-size:11px;">Lifetime Revenue</div><div class="mono">${fmtMoney(p.storedRevenue)}</div></div>
          </div>
          <div class="section-label">After Reconciliation (proposed)</div>
          <div class="grid-2" style="margin-bottom:8px;">
            <div><div class="muted" style="font-size:11px;">Rental Visits</div><div class="mono">${p.afterVisits}</div></div>
            <div><div class="muted" style="font-size:11px;">Paid Days</div><div class="mono">${p.afterDays}</div></div>
            <div><div class="muted" style="font-size:11px;">Lifetime Revenue</div><div class="mono">${fmtMoney(p.afterRevenue)}</div></div>
          </div>
          <div class="status-line" style="margin-bottom:6px;">
            <span>Stale import records to replace: <b>${p.staleImportRecordsToReplace}</b></span>
            <span>Manual rentals preserved: <b>${p.manualRentalsPreserved}</b></span>
          </div>
          <div class="status-line" style="margin-bottom:8px;">
            <span>Reward History: <b>${p.hasRewardHistory ? "Yes" : "No"}</b></span>
            <span>Linked rewards at risk: <b>${p.riskyRewardCount}</b></span>
            <span>Edited-in-place records: <b>${p.editedRecordCount}</b></span>
          </div>
          ${p.status === "REVIEW REQUIRED" ? `<div class="reward-note">Not proposed for automatic reconciliation — ${p.riskyRewardCount > 0 ? "a reward is linked to a rental record not present in the canonical set" : ""}${p.riskyRewardCount > 0 && p.editedRecordCount > 0 ? "; " : ""}${p.editedRecordCount > 0 ? "one or more records appear to have been edited in place since import" : ""}. Needs manual review before any change.</div>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* PHASE 3 — CONTROLLED RECONCILIATION. Everything below this point is    */
/* what actually WRITES data — everything above (Phase 1 audit, Phase 2   */
/* plan) is pure read. This section is deliberately isolated so it's easy */
/* to verify: the confirmation screen and confirm sheet never call        */
/* executeReconciliation() themselves, only a single explicit button      */
/* press after backup + confirmation does.                                 */
/* ---------------------------------------------------------------------- */

const RECONCILE_BACKUP_KEY_PREFIX = "aa_scooter_manager_reconcile_backup_";
const RECONCILE_LATEST_BACKUP_KEY = "aa_scooter_manager_latest_reconcile_backup_id";

// Pure, read-only: figures out exactly what a repair WOULD do without doing it. Used both
// by the confirmation screen (to show accurate numbers) and by executeReconciliation()
// itself (which calls this again, fresh, at the actual moment of writing — never trusting
// a plan generated even a few seconds earlier, per the requirement that ambiguity can
// appear between viewing the preview and pressing the button).
function computeSafePlan() {
  const plan = buildReconciliationPlan();
  return {
    safe: plan.plans.filter((p) => p.status === "SAFE"),
    review: plan.plans.filter((p) => p.status === "REVIEW REQUIRED"),
  };
}

// The actual write. Builds the ENTIRE new rentals array in memory, validates it against a
// set of hard invariants, and only if every check passes does it snapshot the pre-repair
// state and call DB.save() — exactly once, for the whole operation, never per-customer.
// Returns { success: true, ... } or { success: false, reason }. On failure, DB.data is
// left completely untouched — nothing is partially written.
function executeReconciliation() {
  const { safe, review } = computeSafePlan(); // recalculated fresh, right now
  const safeIds = new Set(safe.map((p) => p.customerId));
  const reviewIds = new Set(review.map((p) => p.customerId));

  const canonicalByCustomer = {};
  IMPORTED_RENTALS.forEach((r) => {
    (canonicalByCustomer[r.customerId] = canonicalByCustomer[r.customerId] || []).push(r);
  });

  // Snapshot of BEFORE state, for validation comparison (never mutated).
  const beforeRentals = DB.data.rentals;
  const beforeManualByCustomer = {};
  const beforeRewardsCount = DB.data.rewards.length;
  const beforeCustomersCount = DB.data.customers.length;
  const beforeNeedsReviewCount = DB.data.needsReview.length;
  const beforeVehiclesJSON = JSON.stringify(DB.data.vehicles);
  const beforeMetaJSON = JSON.stringify(DB.data.meta);

  safeIds.forEach((custId) => {
    beforeManualByCustomer[custId] = beforeRentals.filter((r) => r.customerId === custId && !String(r.id).startsWith("imp_r")).length;
  });

  // Construct the full new array: every rental for a non-SAFE customer is carried over
  // completely untouched; every SAFE customer's rentals are rebuilt as canonical
  // import-sourced records + their existing manual records, unmodified.
  const untouchedRentals = beforeRentals.filter((r) => !safeIds.has(r.customerId));
  const rebuiltForSafe = [];
  safeIds.forEach((custId) => {
    const manual = beforeRentals.filter((r) => r.customerId === custId && !String(r.id).startsWith("imp_r"));
    const canonical = (canonicalByCustomer[custId] || []).map((r) => ({ ...r })); // clone, never share references with the seed constant
    rebuiltForSafe.push(...canonical, ...manual);
  });
  const newRentals = [...untouchedRentals, ...rebuiltForSafe];

  // --- VALIDATION — every one of these must hold, or nothing is written ---
  const errors = [];
  // 1. Every REVIEW REQUIRED customer's rentals must be byte-identical to before.
  reviewIds.forEach((custId) => {
    const beforeR = JSON.stringify(beforeRentals.filter((r) => r.customerId === custId));
    const afterR = JSON.stringify(newRentals.filter((r) => r.customerId === custId));
    if (beforeR !== afterR) errors.push(`REVIEW REQUIRED customer ${custId} would have been modified`);
  });
  // 2. Every SAFE customer's manual rental count must be identical before vs after.
  safeIds.forEach((custId) => {
    const afterManual = newRentals.filter((r) => r.customerId === custId && !String(r.id).startsWith("imp_r")).length;
    if (afterManual !== beforeManualByCustomer[custId]) errors.push(`Manual rental count changed for ${custId}`);
  });
  // 3. No rental record for any customer NOT in the safe set may have changed at all.
  const untouchedCustomerIds = new Set(DB.data.customers.map((c) => c.id).filter((id) => !safeIds.has(id)));
  untouchedCustomerIds.forEach((custId) => {
    const beforeR = JSON.stringify(beforeRentals.filter((r) => r.customerId === custId));
    const afterR = JSON.stringify(newRentals.filter((r) => r.customerId === custId));
    if (beforeR !== afterR) errors.push(`Untouched customer ${custId} would have been modified`);
  });
  // 4. Rewards, customers, Needs Review, Vehicle Renewal, Settings — none of these are ever
  //    touched by this function at all (structurally impossible — no code path below
  //    assigns to any of them), but assert their counts/content are unchanged as a final
  //    belt-and-braces check before allowing a save.
  if (DB.data.rewards.length !== beforeRewardsCount) errors.push("Reward record count changed");
  if (DB.data.customers.length !== beforeCustomersCount) errors.push("Customer count changed");
  if (DB.data.needsReview.length !== beforeNeedsReviewCount) errors.push("Needs Review count changed");
  if (JSON.stringify(DB.data.vehicles) !== beforeVehiclesJSON) errors.push("Vehicle Renewal data changed");
  if (JSON.stringify(DB.data.meta) !== beforeMetaJSON) errors.push("Settings/meta changed unexpectedly");
  // 5. No duplicate rental IDs introduced.
  const idCounts = {};
  newRentals.forEach((r) => { idCounts[r.id] = (idCounts[r.id] || 0) + 1; });
  const dupes = Object.entries(idCounts).filter(([, n]) => n > 1);
  if (dupes.length > 0) errors.push(`Duplicate rental IDs introduced: ${dupes.map(([id]) => id).join(", ")}`);
  // 6. HARD CHECK — every SAFE customer's proposed import-sourced record set must actually
  //    differ (by ID set or by content) from their stale stored set, compared explicitly
  //    here rather than trusted from the plan. If NONE of them show any real change, the
  //    repair must never report success — that would be silently lying about what happened.
  let anyRealChange = false;
  safeIds.forEach((custId) => {
    const beforeImport = beforeRentals.filter((r) => r.customerId === custId && String(r.id).startsWith("imp_r"));
    const afterImport = newRentals.filter((r) => r.customerId === custId && String(r.id).startsWith("imp_r"));
    const beforeIds = beforeImport.map((r) => r.id).sort().join(",");
    const afterIds = afterImport.map((r) => r.id).sort().join(",");
    const beforeContent = JSON.stringify(beforeImport.slice().sort((a, b) => a.id.localeCompare(b.id)));
    const afterContent = JSON.stringify(afterImport.slice().sort((a, b) => a.id.localeCompare(b.id)));
    if (beforeIds !== afterIds || beforeContent !== afterContent) anyRealChange = true;
  });
  if (safeIds.size > 0 && !anyRealChange) {
    return { success: false, reason: "Reconciliation produced no data changes." };
  }

  if (errors.length > 0) {
    return { success: false, reason: errors.join("; ") };
  }

  // --- All checks passed. Snapshot BEFORE writing anything. ---
  const runId = "reconcile_" + Date.now();
  const timestamp = new Date().toISOString();
  try {
    localStorage.setItem(RECONCILE_BACKUP_KEY_PREFIX + runId, JSON.stringify(DB.data));
    localStorage.setItem(RECONCILE_LATEST_BACKUP_KEY, runId);
  } catch (err) {
    return { success: false, reason: "Could not write pre-repair backup — aborting without changing any data." };
  }

  // --- The single write for this entire operation. ---
  DB.data.rentals = newRentals;
  DB.data.meta.lastReconciliation = { runId, timestamp, customersReconciled: [...safeIds].length, customersSkipped: [...reviewIds].length };
  DB.save();

  return {
    success: true,
    runId, timestamp,
    reconciledIds: [...safeIds],
    reconciledNames: safe.map((p) => p.name),
    skippedIds: [...reviewIds],
    skippedNames: review.map((p) => p.name),
    totalRevenueCorrection: safe.reduce((s, p) => s + (p.storedRevenue - p.afterRevenue), 0),
    manualRentalsPreserved: safe.reduce((s, p) => s + p.manualRentalsPreserved, 0),
  };
}

// Restores DB.data from a pre-reconciliation backup snapshot — the rollback path. Always
// available in Settings once at least one reconciliation has run.
function restoreReconciliationBackup(runId) {
  const raw = localStorage.getItem(RECONCILE_BACKUP_KEY_PREFIX + runId);
  if (!raw) { toast("Backup not found"); return false; }
  try {
    DB.data = JSON.parse(raw);
    DB.save();
    return true;
  } catch (err) {
    toast("Restore failed — backup file could not be read");
    return false;
  }
}

// Final confirmation screen — the ONLY screen with the actual write button. Nothing
// executes just from opening this screen; the button itself is disabled until the backup
// checkbox is ticked, and pressing it opens an in-app confirm sheet (never native
// confirm()) as one more explicit step before executeReconciliation() is ever called.
function renderReconcileConfirmScreen() {
  // TEMPORARILY DISABLED — the reconciliation model is being reworked following the
  // manual-rentals audit correction. This hard guard replaces the entire screen (including
  // the execute button) with a plain notice, so this path cannot run even if reached
  // directly by route/bookmark rather than through the (already-removed) Data Audit link.
  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="data-audit">‹ Data Audit</button>
      <h1 class="screen-title" style="margin-top:8px;">Reconciliation Temporarily Disabled</h1>
    </header>
    <div class="screen-body">
      <div class="card" style="border: 1.5px solid var(--red);">
        <div style="font-weight:700; color:var(--red); margin-bottom:8px;">This step is disabled for now.</div>
        <p class="muted">The reconciliation model is being reworked following the manual-rentals audit correction. No repair can run from here until the updated model is reviewed and re-enabled.</p>
      </div>
    </div>
  `;
}

function renderReconcileConfirmScreen_DISABLED_ORIGINAL() {
  const { safe, review } = computeSafePlan();
  const totalStaleRecords = safe.reduce((s, p) => s + p.staleImportRecordsToReplace, 0);
  const totalManualPreserved = safe.reduce((s, p) => s + p.manualRentalsPreserved, 0);
  const rewardLinkedExcluded = review.filter((p) => p.riskyRewardCount > 0).length;

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="reconcile-preview">‹ Reconciliation Preview</button>
      <h1 class="screen-title" style="margin-top:8px;">Confirm Reconciliation</h1>
      <p class="screen-sub">Final review before any data is written. Nothing changes until you press the button below and confirm again.</p>
    </header>
    <div class="screen-body">
      <div class="card" style="margin-bottom:16px;">
        <div class="grid-2" style="margin-bottom:4px;">
          <div><div class="muted" style="font-size:11.5px;">Total mismatched customers</div><div style="font-weight:700; font-size:16px;">${safe.length + review.length}</div></div>
          <div><div class="muted" style="font-size:11.5px;">SAFE — will be reconciled</div><div style="font-weight:700; font-size:16px; color:var(--green);">${safe.length}</div></div>
          <div><div class="muted" style="font-size:11.5px;">REVIEW REQUIRED — excluded</div><div style="font-weight:700; font-size:16px; color:var(--red);">${review.length}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Reward-linked customers excluded</div><div style="font-weight:700; font-size:16px;">${rewardLinkedExcluded}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Stale imported records to replace</div><div style="font-weight:700; font-size:16px;">${totalStaleRecords}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Manual rentals preserved</div><div style="font-weight:700; font-size:16px;">${totalManualPreserved}</div></div>
        </div>
      </div>

      ${review.length > 0 ? `
        <div class="card" style="margin-bottom:16px;">
          <div class="section-label" style="margin-top:0;">Excluded — REVIEW REQUIRED (unchanged)</div>
          ${review.map((p) => `<div class="reward-note" style="margin-bottom:4px;">${escapeHtml(p.name)}${p.riskyRewardCount > 0 ? " — linked reward" : ""}${p.editedRecordCount > 0 ? " — edited-in-place record" : ""}</div>`).join("")}
        </div>
      ` : ""}

      <div class="card" style="margin-bottom:16px;">
        <div class="section-label" style="margin-top:0;">Backup status</div>
        <p class="muted" style="margin-bottom:10px;">Export a copy of the current data before proceeding. A separate automatic snapshot is also taken the instant before anything is written, regardless.</p>
        <button class="btn btn-outline btn-block" id="export-backup-confirm-screen" style="margin-bottom:10px;">Export Backup (JSON)</button>
        <div class="checkbox-row">
          <input type="checkbox" id="f-backup-confirmed" ${state.backupConfirmed ? "checked" : ""} />
          <label style="margin:0;text-transform:none;font-weight:500;">I have exported a backup</label>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="reconcile-execute-btn" ${state.backupConfirmed ? "" : "disabled"}>Reconcile ${safe.length} Safe Customer${safe.length === 1 ? "" : "s"}</button>
    </div>
  `;
}

// Result screen — shown only after executeReconciliation() has actually run. Reads the
// outcome from state.lastReconciliationResult, set once, right after the write completes.
function renderReconcileResultScreen() {
  const r = state.lastReconciliationResult;
  if (!r) { navigate("data-audit"); return ""; }

  if (!r.success) {
    return `
      <header class="screen-header">
        <button class="back-btn" data-goto="settings">‹ Settings</button>
        <h1 class="screen-title" style="margin-top:8px;">Reconciliation Failed</h1>
      </header>
      <div class="screen-body">
        <div class="card" style="border: 1.5px solid var(--red);">
          <div style="font-weight:700; color:var(--red); margin-bottom:8px;">No changes were saved.</div>
          <p class="muted">${escapeHtml(r.reason)}</p>
        </div>
      </div>
    `;
  }

  // Post-repair validation, run fresh right now (not cached from before the repair).
  const postAudit = runDataAudit();

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="settings">‹ Settings</button>
      <h1 class="screen-title" style="margin-top:8px;">Reconciliation Complete</h1>
      <p class="screen-sub">Run ID: ${escapeHtml(r.runId)} · ${fmtDate(r.timestamp.slice(0, 10))}</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value" style="color:var(--green);">${r.reconciledIds.length}</div><div class="report-tile-label">Customers Reconciled</div></div>
        <div class="report-tile"><div class="report-tile-value">${r.skippedIds.length}</div><div class="report-tile-label">Customers Skipped</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:${postAudit.mismatching > 0 ? "var(--red)" : "var(--ink)"};">${postAudit.mismatching}</div><div class="report-tile-label">Remaining Mismatches</div></div>
        <div class="report-tile"><div class="report-tile-value">${r.skippedIds.length}</div><div class="report-tile-label">Remaining REVIEW REQUIRED</div></div>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <div class="grid-2">
          <div><div class="muted" style="font-size:11.5px;">Total revenue correction applied</div><div style="font-weight:700;">${fmtMoney(r.totalRevenueCorrection)}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Manual rentals preserved</div><div style="font-weight:700;">${r.manualRentalsPreserved}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Reward records preserved</div><div style="font-weight:700;">${DB.data.rewards.length} (unchanged)</div></div>
          <div><div class="muted" style="font-size:11.5px;">Backup run ID</div><div style="font-weight:700; font-size:12px;">${escapeHtml(r.runId)}</div></div>
        </div>
      </div>
      ${r.skippedNames.length > 0 ? `
        <div class="card" style="margin-bottom:16px;">
          <div class="section-label" style="margin-top:0;">Skipped (unchanged, still REVIEW REQUIRED)</div>
          ${r.skippedNames.map((n) => `<div class="reward-note" style="margin-bottom:4px;">${escapeHtml(n)}</div>`).join("")}
        </div>
      ` : ""}
      <button class="btn btn-outline btn-block" data-goto="data-audit">View Updated Data Audit</button>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* MANAGER SYNC — staff-triggered, read-only pull from the AA Scooters      */
/* Manager/booking system's Apps Script endpoint (MANAGER_SYNC_URL). This   */
/* app NEVER writes back to that Sheet — only ever a GET. The Manager       */
/* system remains the single source of truth for customer/rental identity; */
/* this only ever reads from it, on demand, never on a timer. Reward        */
/* records are never touched by anything in this section.                  */
/* ---------------------------------------------------------------------- */

// Turns one raw Manager row (fixed column positions, confirmed against the
// live endpoint — see MANAGER_SYNC_URL) into a normalized shape. Positional,
// not header-text-based, since a couple of the real headers are blank or
// inconsistently spaced. Returns null for a row too incomplete to use
// (blank name or unparseable start date) rather than guessing at it.
function parseManagerRow(row) {
  const v = row.values || [];
  const name = String(v[2] || "").trim();
  const startDate = parseDateLoose(v[7]);
  if (!name || !startDate) return null; // incomplete/junk row — flagged NEEDS REVIEW by the caller, never silently dropped
  const nationality = String(v[3] || "").trim();
  const passport = String(v[4] || "").trim();
  const bikeNameRaw = String(v[5] || "").trim();
  const endDateRaw = String(v[8] || "").trim();
  const endDate = endDateRaw ? parseDateLoose(v[8]) : "";
  const revenue = Number(String(v[11] == null ? "" : v[11]).replace(/[^\d.-]/g, "")) || 0;
  const situation = String(v[13] || "").trim();
  const status = situation.toLowerCase() === "returned" ? "completed" : "active";
  return { rowNumber: row.rowNumber, name, nationality, passport, bikeNameRaw, startDate, endDate, revenue, status };
}

// Pure, read-only. Fetches nothing itself — takes already-fetched Manager
// rows and compares them against current DB.data, producing a plan of what
// a sync WOULD do. Never mutates DB.data. Mirrors the same customer-name +
// raw-bike-identity + date-overlap matching already fixed for the CSV
// importer, so the same duplicate-prevention guarantee applies here too.
// Conservative passport normalization for Manager Sync identity matching — trim, case-
// insensitive, harmless internal spaces removed. No partial/fuzzy matching of any kind.
function normalizePassport(p) {
  if (!p) return "";
  return String(p).trim().toUpperCase().replace(/\s+/g, "");
}

// Empty-shadow check used by the identity-resolution refinements below — a customer record
// with zero rentals and zero rewards is provably not a second real person for matching
// purposes, just an accidental duplicate Gift Tracker record. Never used to override a
// conflict where the other record has any real history at all.
function isEmptyShadowCustomer(customerId) {
  const rentalCount = DB.data.rentals.filter((r) => r.customerId === customerId).length;
  const rewardCount = DB.data.rewards.filter((r) => r.customerId === customerId).length;
  return rentalCount === 0 && rewardCount === 0;
}

// ============================================================================
// SIMPLIFIED MANAGER-FIRST LOYALTY MODEL (approved redesign — replaces the previous
// row-by-row historical reconciliation entirely). Manager Live is the operational source
// of truth for rental activity. Once a customer is safely identified, ALL of their current
// Manager rows become their approximate operational rental list — one row, one visit, real
// dates, real revenue, no cross-checking against old Gift Tracker rental records at all.
// Needs Review now means exactly one thing: customer identity itself could not be safely
// established. Ordinary rental-history differences never produce a review item.
// ============================================================================

// Resolves a Manager-reported name+passport to an existing Gift Tracker customer, a
// genuinely new customer, or a genuine identity ambiguity — using ONLY the already-approved
// exact passport/name matching and empty-shadow exception. No fuzzy matching of any kind.
function resolveCustomerIdentity(name, passport) {
  const parsedPassport = normalizePassport(passport);
  const byPassport = parsedPassport ? DB.data.customers.filter((c) => normalizePassport(c.passport) === parsedPassport) : [];
  const matchingCustomers = DB.data.customers.filter((c) => normalizeText(cleanCustomerDisplayName(c.name)) === normalizeText(cleanCustomerDisplayName(name)));

  let resolvedPassportCustomer = null;
  if (parsedPassport && byPassport.length > 1) {
    const withHistory = byPassport.filter((c) => !isEmptyShadowCustomer(c.id));
    if (withHistory.length === 1) {
      resolvedPassportCustomer = withHistory[0];
    } else {
      return { ambiguous: true, reason: `Passport "${passport}" matches more than one existing customer with real history — identity cannot be safely established.` };
    }
  }

  if (parsedPassport && (byPassport.length === 1 || resolvedPassportCustomer)) {
    const passportCustomer = resolvedPassportCustomer || byPassport[0];
    const conflicting = matchingCustomers.filter((c) => c.id !== passportCustomer.id);
    const realConflicts = conflicting.filter((c) => !isEmptyShadowCustomer(c.id));
    if (realConflicts.length > 0) {
      return { ambiguous: true, reason: `Passport matches "${passportCustomer.name}" but the name also matches a different existing customer with real history — identity cannot be safely established.` };
    }
    return { ambiguous: false, customer: passportCustomer, isNew: false };
  }

  if (matchingCustomers.length > 1) {
    const withHistory = matchingCustomers.filter((c) => !isEmptyShadowCustomer(c.id));
    if (withHistory.length === 1) return { ambiguous: false, customer: withHistory[0], isNew: false };
    return { ambiguous: true, reason: `Name "${name}" matches more than one existing customer with real history — identity cannot be safely established.` };
  }
  if (matchingCustomers.length === 1) return { ambiguous: false, customer: matchingCustomers[0], isNew: false };
  return { ambiguous: false, customer: null, isNew: true };
}

// Groups every parsed Manager row by the real-world person it belongs to (passport first,
// falling back to cleaned name), resolves each group's identity once, and — for safely
// identified customers — carries their full row list forward as-is. No per-row comparison
// against old Gift Tracker rentals anywhere in this function.
function buildManagerSyncPlan(managerData) {
  const plan = { resolvedCustomers: [], needsReview: [] };
  const groups = {};

  (managerData.rows || []).forEach((raw) => {
    const parsed = parseManagerRow(raw);
    if (!parsed) {
      plan.needsReview.push({ rowNumber: raw.rowNumber, reason: "Missing customer name or a valid start date.", identityIssue: false });
      return;
    }
    const p = normalizePassport(parsed.passport);
    const key = p || ("name:" + normalizeText(cleanCustomerDisplayName(parsed.name)));
    if (!groups[key]) groups[key] = { name: parsed.name, passport: parsed.passport, rows: [] };
    groups[key].rows.push(parsed);
  });

  Object.values(groups).forEach((group) => {
    const resolved = resolveCustomerIdentity(group.name, group.passport);
    if (resolved.ambiguous) {
      plan.needsReview.push({ rowNumber: group.rows.map((r) => r.rowNumber).join(", "), reason: resolved.reason, identityIssue: true, name: group.name });
      return;
    }
    plan.resolvedCustomers.push({
      customerId: resolved.customer ? resolved.customer.id : null,
      customerName: resolved.customer ? resolved.customer.name : group.name,
      isNew: resolved.isNew,
      nationality: group.rows[0].nationality, passport: group.passport,
      rows: group.rows,
    });
  });

  return plan;
}

// Builds the per-customer Loyalty Preview for the simplified model — runs the real,
// unmodified customerStats()/computeCustomerStatus()/getSuggestions() against a simulated
// rentals array where this customer's Manager rows are the ONLY operational rentals
// (matching exactly what executeManagerSync() would produce), while any of their legacy
// Gift Tracker rentals remain present but excluded from the sums — same rule
// customerStats() itself applies once real Manager data exists. Nothing is written.
// Shared shape-builder for a single customer's loyalty preview row — extracts eligible vs.
// already-given rewards from getSuggestions()'s real output, never a simplified copy.
function buildLoyaltyPreviewEntry(name, stats, status, suggestions) {
  const rewardsGiven = suggestions.filter((s) => s.reward && s.reward.given).map((s) => s.title);
  const eligible = suggestions.filter((s) => !(s.reward && s.reward.given) && s.eligible).map((s) => s.title);
  return {
    name, statusLabel: status.label,
    operationalDays: stats.paidRentalDays, visits: stats.rentalCount, revenue2026: stats.totalRevenue,
    eligibleRewards: eligible, rewardsGiven,
  };
}

function buildManagerSyncLoyaltyPreview(plan) {
  return plan.resolvedCustomers.map((rc) => {
    const customer = rc.customerId ? DB.data.customers.find((c) => c.id === rc.customerId) : { id: "preview-only-" + normalizeText(rc.customerName), name: rc.customerName };
    const legacyRentals = rc.customerId ? customerRentals(rc.customerId) : [];
    const managerRentals = rc.rows.map((row) => {
      const paidDays = Math.max(daysBetween(row.startDate, row.endDate || todayISO()), 0);
      return { id: "mgr_r" + row.rowNumber, mgrRowNumber: row.rowNumber, customerId: customer.id, bikeModel: row.bikeNameRaw, bikeNameRaw: row.bikeNameRaw, plate: "", startDate: row.startDate, endDate: row.endDate || null, bookedDays: paidDays, paidDays, revenue: row.revenue, status: row.status };
    });
    const simulatedRentals = [...legacyRentals, ...managerRentals];
    const stats = customerStats(customer, simulatedRentals);
    const status = computeCustomerStatus(customer, stats);
    const suggestions = getSuggestions(customer, stats);
    return { ...buildLoyaltyPreviewEntry(rc.customerName, stats, status, suggestions), isNew: rc.isNew, visitCount: rc.rows.length };
  });
}

// The actual write. For each safely resolved customer: create the customer if genuinely
// new, then upsert one rental per Manager row (id = "mgr_r" + row number, so re-running the
// sync naturally updates the same records rather than duplicating them). Legacy Gift
// Tracker rentals for that customer are never touched, deleted, or modified — they remain
// exactly as they were, simply excluded from operational sums by customerStats() once
// Manager-linked rentals exist for that customer. Rewards are never touched here.
function executeManagerSync(plan) {
  const beforeRewards = JSON.stringify(DB.data.rewards);
  const beforeVehicles = JSON.stringify(DB.data.vehicles);

  let customersCreated = 0, rentalsCreated = 0, rentalsUpdated = 0;

  plan.resolvedCustomers.forEach((rc) => {
    let customerId = rc.customerId;
    if (!customerId) {
      customerId = uid("c");
      DB.data.customers.push({ id: customerId, name: rc.customerName, mergedNames: [], nationality: rc.nationality || "", passport: rc.passport || null, phone: "", notes: "", firstSeen: todayISO(), source: "manager_sync" });
      customersCreated++;
    }
    rc.rows.forEach((row) => {
      const paidDays = Math.max(daysBetween(row.startDate, row.endDate || todayISO()), 0);
      const rentalId = "mgr_r" + row.rowNumber;
      const existing = DB.data.rentals.find((r) => r.id === rentalId);
      if (existing) {
        existing.startDate = row.startDate; existing.endDate = row.endDate || null;
        existing.revenue = row.revenue; existing.status = row.status;
        existing.bikeModel = row.bikeNameRaw; existing.bikeNameRaw = row.bikeNameRaw;
        existing.bookedDays = paidDays; existing.paidDays = paidDays;
        existing.customerId = customerId; existing.mgrRowNumber = row.rowNumber;
        rentalsUpdated++;
      } else {
        DB.data.rentals.push({ id: rentalId, mgrRowNumber: row.rowNumber, customerId, bikeModel: row.bikeNameRaw, bikeNameRaw: row.bikeNameRaw, plate: "", startDate: row.startDate, endDate: row.endDate || null, bookedDays: paidDays, paidDays, revenue: row.revenue, status: row.status });
        rentalsCreated++;
      }
    });
  });

  if (JSON.stringify(DB.data.rewards) !== beforeRewards || JSON.stringify(DB.data.vehicles) !== beforeVehicles) {
    return { success: false, reason: "Aborted — unexpected change detected outside customers/rentals." };
  }

  DB.save();
  return {
    success: true,
    customersCreated, rentalsCreated, rentalsUpdated,
    customersProcessed: plan.resolvedCustomers.length,
    needsReview: plan.needsReview.length,
  };
}


function renderManagerSyncScreen() {
  const syncMeta = getManagerSyncMeta();
  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="settings">‹ Settings</button>
      <h1 class="screen-title" style="margin-top:8px;">Check for Updates from Manager</h1>
      <p class="screen-sub">Read-only pull from the Manager/booking system. Manager Live is now the operational source of rental activity for any customer we can safely identify. This app never writes back to that Sheet — only ever fetches. Nothing here runs automatically; it only checks when you press the button.</p>
    </header>
    <div class="screen-body">
      <div class="card" style="margin-bottom:16px;">
        <div class="section-label" style="margin-top:0;">Last Successful Check</div>
        ${syncMeta.lastManagerCheckAt ? `
          <div style="font-weight:700; margin-bottom:8px;">${escapeHtml(fmtDateTimeLabel(syncMeta.lastManagerCheckAt) || "—")}</div>
          <div class="grid-2">
            <div><div class="muted" style="font-size:11px;">Manager Records Received</div><div style="font-weight:700;">${syncMeta.lastManagerRecordCount}</div></div>
            <div><div class="muted" style="font-size:11px;">New Customers Found</div><div style="font-weight:700;">${syncMeta.lastManagerNewCustomerCount}</div></div>
            <div><div class="muted" style="font-size:11px;">Existing Customers Updated</div><div style="font-weight:700;">${syncMeta.lastManagerExistingActivityCount}</div></div>
            <div><div class="muted" style="font-size:11px;">Needing Identity Review</div><div style="font-weight:700; color:${syncMeta.lastManagerNeedsReviewCount > 0 ? "var(--red)" : "var(--ink)"};">${syncMeta.lastManagerNeedsReviewCount}</div></div>
          </div>
        ` : `<p class="muted">Never checked yet on this device.</p>`}
      </div>

      ${state.managerSyncStatus === "idle" ? `
        <button class="btn btn-primary btn-block" id="check-manager-updates">Check Now</button>
      ` : ""}

      ${state.managerSyncStatus === "fetching" ? `
        <div class="card"><p class="muted">Checking the Manager system…</p></div>
      ` : ""}

      ${state.managerSyncStatus === "error" ? `
        <div class="card" style="border: 1.5px solid var(--red);">
          <div style="font-weight:700; color:var(--red); margin-bottom:8px;">Couldn't reach the Manager system</div>
          <p class="muted">${escapeHtml(state.managerSyncError || "Unknown error.")}</p>
        </div>
        <button class="btn btn-outline btn-block" id="check-manager-updates" style="margin-top:12px;">Try Again</button>
      ` : ""}

      ${state.managerSyncStatus === "preview" && state.managerSyncPlan ? (() => {
        const p = state.managerSyncPlan;
        const newCustomerCount = p.resolvedCustomers.filter((c) => c.isNew).length;
        const loyaltyPreviews = buildManagerSyncLoyaltyPreview(p);
        const newPreviews = loyaltyPreviews.filter((lp) => lp.isNew);
        const existingPreviews = loyaltyPreviews.filter((lp) => !lp.isNew);
        return `
          <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
            <div class="report-tile"><div class="report-tile-value" style="color:var(--green);">${p.resolvedCustomers.length}</div><div class="report-tile-label">Customers Identified</div></div>
            <div class="report-tile"><div class="report-tile-value">${newCustomerCount}</div><div class="report-tile-label">New Customers</div></div>
            <div class="report-tile"><div class="report-tile-value">${p.resolvedCustomers.reduce((s, c) => s + c.rows.length, 0)}</div><div class="report-tile-label">Manager Rows Processed</div></div>
            <div class="report-tile"><div class="report-tile-value" style="color:${p.needsReview.length > 0 ? "var(--red)" : "var(--ink)"};">${p.needsReview.length}</div><div class="report-tile-label">Needs Review (identity only)</div></div>
          </div>

          ${newPreviews.length > 0 ? `
            <div class="section-title">New Customers Found (${newPreviews.length}) — tap to see loyalty/gift recommendation</div>
            ${newPreviews.map((lp) => {
              const key = normalizeText(lp.name);
              const expanded = state.managerSyncExpandedNewCustomer === key;
              return `
                <div class="card" style="margin-bottom:8px; cursor:pointer;" data-new-customer-toggle="${escapeHtml(key)}">
                  <div class="card-row">
                    <div style="font-weight:700;">${escapeHtml(lp.name)}</div>
                    <span class="pill pill-green">${expanded ? "▲" : "▼"} New</span>
                  </div>
                  ${expanded ? `
                    <div class="grid-2" style="margin-top:8px; margin-bottom:6px;">
                      <div><div class="muted" style="font-size:11px;">Status</div><div style="font-weight:700;">${escapeHtml(lp.statusLabel)}</div></div>
                      <div><div class="muted" style="font-size:11px;">Approx. Visits</div><div>${lp.visitCount}</div></div>
                      <div><div class="muted" style="font-size:11px;">Operational Days</div><div>${lp.operationalDays}</div></div>
                      <div><div class="muted" style="font-size:11px;">Revenue</div><div>${fmtMoney(lp.revenue2026)}</div></div>
                    </div>
                    <div class="muted" style="font-size:11.5px;">Eligible now: ${lp.eligibleRewards.length ? escapeHtml(lp.eligibleRewards.join(", ")) : "none yet"}</div>
                    <div class="muted" style="font-size:11.5px;">Already given: ${lp.rewardsGiven.length ? escapeHtml(lp.rewardsGiven.join(", ")) : "none"}</div>
                  ` : ""}
                </div>
              `;
            }).join("")}
          ` : ""}

          ${existingPreviews.length > 0 ? `
            <div class="section-title">Existing Customers — Activity Updated</div>
            ${existingPreviews.map((lp) => `
              <div class="card" style="margin-bottom:10px;">
                <div class="card-row" style="margin-bottom:6px;">
                  <div style="font-weight:700;">${escapeHtml(lp.name)}</div>
                </div>
                <div class="grid-2" style="margin-bottom:6px;">
                  <div><div class="muted" style="font-size:11px;">Status</div><div style="font-weight:700;">${escapeHtml(lp.statusLabel)}</div></div>
                  <div><div class="muted" style="font-size:11px;">Approx. Visits</div><div>${lp.visitCount}</div></div>
                  <div><div class="muted" style="font-size:11px;">Operational Days</div><div>${lp.operationalDays}</div></div>
                  <div><div class="muted" style="font-size:11px;">Revenue</div><div>${fmtMoney(lp.revenue2026)}</div></div>
                </div>
                <div class="muted" style="font-size:11.5px;">Eligible now: ${lp.eligibleRewards.length ? escapeHtml(lp.eligibleRewards.join(", ")) : "none yet"}</div>
                <div class="muted" style="font-size:11.5px;">Already given: ${lp.rewardsGiven.length ? escapeHtml(lp.rewardsGiven.join(", ")) : "none"}</div>
              </div>
            `).join("")}
          ` : ""}

          ${p.needsReview.length > 0 ? `
            <div class="section-title">Needs Review — identity could not be safely established</div>
            ${p.needsReview.map((r) => `<div class="reward-note" style="margin-bottom:6px;">Row(s) ${escapeHtml(String(r.rowNumber))}${r.name ? " · <b>" + escapeHtml(r.name) + "</b>" : ""}<br/><span class="muted">${escapeHtml(r.reason)}</span></div>`).join("")}
          ` : ""}

          <button class="btn btn-primary btn-block" id="apply-manager-sync" style="margin-top:16px;">Apply Updates</button>
          <button class="btn btn-outline btn-block" id="cancel-manager-sync" style="margin-top:8px;">Cancel</button>
        `;
      })() : ""}

      ${state.managerSyncStatus === "done" && state.managerSyncResult ? (() => {
        const r = state.managerSyncResult;
        return `
          <div class="card" style="border: 1.5px solid var(--green);">
            <div style="font-weight:700; color:var(--green); margin-bottom:8px;">Sync complete</div>
            <div class="grid-2">
              <div><div class="muted" style="font-size:11.5px;">Customers processed</div><div style="font-weight:700;">${r.customersProcessed}</div></div>
              <div><div class="muted" style="font-size:11.5px;">New customers</div><div style="font-weight:700;">${r.customersCreated}</div></div>
              <div><div class="muted" style="font-size:11.5px;">Rentals created</div><div style="font-weight:700;">${r.rentalsCreated}</div></div>
              <div><div class="muted" style="font-size:11.5px;">Rentals updated</div><div style="font-weight:700;">${r.rentalsUpdated}</div></div>
              <div><div class="muted" style="font-size:11.5px;">Needing review (skipped)</div><div style="font-weight:700;">${r.needsReview}</div></div>
            </div>
          </div>
          <button class="btn btn-outline btn-block" id="check-manager-updates" style="margin-top:16px;">Check Again</button>
        `;
      })() : ""}
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* CSV IMPORT — Google Sheets/CSV is only ever an import & backup source. */
/* Nothing in the app depends on a live connection to a spreadsheet.      */
/* ---------------------------------------------------------------------- */

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip, \n handles the line break */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function normalizeHeader(h) { return String(h || "").toLowerCase().trim().replace(/[_\-]+/g, " ").replace(/\s+/g, " "); }

function guessColumnMapping(headers, schema) {
  const normHeaders = headers.map(normalizeHeader);
  const mapping = {};
  schema.fields.forEach((f) => {
    let idx = normHeaders.findIndex((h) => h === f.key.toLowerCase() || f.aliases.includes(h));
    if (idx === -1) idx = normHeaders.findIndex((h) => f.aliases.some((a) => h.includes(a)));
    mapping[f.key] = idx;
  });
  return mapping;
}

function parseDateLoose(str) {
  if (!str) return "";
  const s = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or D/M/YYYY (most common in Thai spreadsheets)
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, "0"), month = m[2].padStart(2, "0");
    return `${m[3]}-${month}-${day}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return "";
}

function normalizeText(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }

// The Tax column rules from the source spreadsheet: "-" means same date as Por Ror Bor,
// "Not yet" means the previous Tax expired but renewal isn't done yet (commonly waiting on
// ตรอ. inspection) — NOT missing data, and never given a fake/copied expiry date.
function parseTaxColumn(raw, prbExpiryIso) {
  const s = String(raw || "").trim();
  if (s === "") return { taxExpiryDate: "", taxOverduePending: false, renewalNote: "" };
  if (s === "-") return { taxExpiryDate: prbExpiryIso || "", taxOverduePending: false, renewalNote: "" };
  if (normalizeText(s) === "not yet") {
    return { taxExpiryDate: "", taxOverduePending: true, renewalNote: "Pending vehicle inspection (ตรอ.)" };
  }
  return { taxExpiryDate: parseDateLoose(s), taxOverduePending: false, renewalNote: "" };
}


/* ---------------------------------------------------------------------- */
/* BUSINESS LOGIC                                                          */
/* ---------------------------------------------------------------------- */

function customerRentals(customerId) {
  return DB.data.rentals.filter((r) => r.customerId === customerId)
    .slice().sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
}

// A reward's cycleBaselinePaidDays was, until now, always captured under the OLD all-time
// paid-days model (2025 + 2026 combined). The new operational model only counts 2026-onward
// days — so an old baseline is on a different scale from the new stats.paidRentalDays and
// must be read-time normalized, never migrated/overwritten in storage. `baselineModel:
// "operational"` is the version marker written onto every NEW baseline going forward (see
// quickGiveOrUse / sheetMarkPremiumRideUsed / sheetEditRewardFull); its absence on an
// existing record is exactly how a legacy baseline is safely distinguished, with zero risk
// of a false positive, since no code before this update ever wrote that field.
function effectiveCycleBaseline(rw, stats) {
  if (!rw || rw.cycleBaselinePaidDays === undefined) return 0;
  if (rw.baselineModel === "operational") return rw.cycleBaselinePaidDays; // already correct scale
  const legacyPaidDaysBefore2026 = stats.rentals
    .filter((r) => r.startDate < LEGACY_CUTOFF_DATE)
    .reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
  return Math.max(0, rw.cycleBaselinePaidDays - legacyPaidDaysBefore2026);
}
// Same issue, same fix, for VIP Extra Day's qualified-episode counter specifically.
function effectiveCycleBaselineQualified(rw, stats) {
  if (!rw || rw.cycleBaselineQualifiedCount === undefined) return 0;
  if (rw.baselineModel === "operational") return rw.cycleBaselineQualifiedCount;
  const legacyQualifiedBefore2026 = stats.rentals
    .filter((r) => r.startDate < LEGACY_CUTOFF_DATE && isQualifiedRental(r)).length;
  return Math.max(0, rw.cycleBaselineQualifiedCount - legacyQualifiedBefore2026);
}

// ============================================================================
// THE ONE CENTRALIZED OPERATIONAL MODEL — every screen/function that needs a
// customer's 2026 operational activity goes through customerStats() below, which in turn
// derives every rental's contribution from THIS single function. No screen independently
// filters or sums DB.data.rentals for operational purposes — that was the exact bug this
// replaces (a startDate-only filter that zeroed out any customer whose rental started in
// 2025 but is still active/ongoing into 2026, like a long-term monthly renter).
//
// Three distinct cases per rental, matching the approved design exactly:
//   1. Rental fully completed before 2026-01-01 → archive only, contributes nothing.
//   2. Rental starts before 2026-01-01 but overlaps 2026 (still active, or ended in 2026)
//      → counts as exactly ONE operational visit, contributes ONLY the paid days that fall
//      within 2026 (calendar-day overlap, clipped to today if still ongoing), and
//      contributes ZERO revenue — this app has no reliable way to allocate a legacy
//      boundary-spanning payment between 2025 and 2026, and this is explicitly NOT an
//      accounting system, so it doesn't try.
//   3. Rental starts on/after 2026-01-01 → counts normally: recorded paidDays, recorded
//      revenue, one visit. No clipping needed, nothing to guess.
// Never mutates the rental record — purely a derived, read-only computation.
function operationalContribution(rental, todayIso) {
  const end = rental.endDate || todayIso; // ongoing -> extends through today
  if (end < LEGACY_CUTOFF_DATE) return null; // archive only
  const isBoundarySpanning = rental.startDate < LEGACY_CUTOFF_DATE;
  if (isBoundarySpanning) {
    const overlapStart = LEGACY_CUTOFF_DATE;
    const overlapEnd = end > todayIso ? todayIso : end;
    const days = Math.max(daysBetween(overlapStart, overlapEnd), 0);
    return { visits: 1, days, revenue: 0, isBoundarySpanning: true };
  }
  return { visits: 1, days: Number(rental.paidDays) || 0, revenue: Number(rental.revenue) || 0, isBoundarySpanning: false };
}

// Identifies rentals PROVEN to be duplicate/artifact records of an already-canonical rental
// for the same customer — never merely because dates overlap. "Canonical" here means
// either import-sourced (id starts "imp_r") or Manager-linked (mgrRowNumber present); both
// are legitimate, already-approved sources of operational truth. A candidate is only ever
// excluded when it carries the zero-day-financial signature (paidDays === 0, revenue > 0)
// AND matches an actual canonical record by raw bike identity + date overlap — the same
// deterministic evidence already used by Non-Import Rental Review and the Repair Preview.
// A genuine extension/continuation (real paid days, or no matching canonical record) is
// never touched by this — it keeps its full operational contribution regardless of any
// date overlap with something else. Excluded rentals stay fully visible in rental history;
// this only affects the derived operational sums in customerStats(), never DB.data itself.
function computeArtifactRentalIds(customerRentalsList) {
  const canonicalRecords = customerRentalsList.filter((r) => String(r.id).startsWith("imp_r") || (r.mgrRowNumber !== undefined && r.mgrRowNumber !== null));
  const artifactIds = new Set();
  customerRentalsList.forEach((r) => {
    if (String(r.id).startsWith("imp_r") || (r.mgrRowNumber !== undefined && r.mgrRowNumber !== null)) return; // a canonical record is never excluded, by definition
    const isZeroDayFinancial = (Number(r.paidDays) || 0) === 0 && (Number(r.revenue) || 0) > 0;
    if (!isZeroDayFinancial) return; // the ONLY trigger for exclusion — an ordinary rental with real paid days is never suppressed just for overlapping something
    const matchesCanonical = canonicalRecords.some((c) => {
      const bikeMatch = normalizeText(r.bikeNameRaw || r.bikeModel) === normalizeText(c.bikeNameRaw || c.bikeModel);
      if (!bikeMatch) return false;
      const cEnd = c.endDate || todayISO(); // an ongoing/active canonical record extends through today, not just its own start date
      const rEnd = r.endDate || r.startDate;
      return r.startDate <= cEnd && rEnd >= c.startDate;
    });
    if (matchesCanonical) artifactIds.add(r.id);
  });
  return artifactIds;
}

// ============================================================================
// SEGMENT-BASED VISIT GROUPING — the exact tested algorithm, approved after the
// dataset-wide simulation. Applies only to a canonical rental that carries a `segments`
// array (merged historical episodes, sourceRows.length > 1). A rental with no `segments`
// field is untouched by this and flows through exactly as before.
//
// 1. Sort segments by (start ascending, span-length descending on ties) — a broader
//    segment starting on the same date is considered before a narrower one.
// 2. A segment is DISCARDED only when its entire date range already lies within the union
//    of already-kept segments (the deterministic rule for "these two source rows describe
//    the same booking" — e.g. Byron's row 340 fully inside row 46). Never partial/invented.
// 3. Remaining KEPT segments are merged into VISITS: segments that overlap or are exactly
//    adjacent (touching, no gap) belong to one visit; any real gap starts a new visit.
// 4. A visit's revenue is the sum of only its kept segments' own recorded revenue.
// 5. Only the LAST visit may inherit the canonical record's true current status
//    (active/completed) — earlier visits are always completed, since a later visit proves
//    they genuinely ended. This never fabricates a return that was never logged.
// ============================================================================
function buildVisitsFromSegments(rental) {
  const segs = (rental.segments || []).slice().sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
    const spanA = daysBetween(a.startDate, a.endDate), spanB = daysBetween(b.startDate, b.endDate);
    return spanB - spanA; // broader (longer span) first on a tied start date
  });

  const kept = [];
  const covered = []; // [start, end] pairs already kept
  segs.forEach((s) => {
    const contained = covered.some((c) => c[0] <= s.startDate && s.endDate <= c[1]);
    if (contained) return;
    kept.push(s);
    covered.push([s.startDate, s.endDate]);
  });
  kept.sort((a, b) => (a.startDate < b.startDate ? -1 : 1));

  const visits = [];
  kept.forEach((s) => {
    const last = visits[visits.length - 1];
    if (last && s.startDate <= last.endDate) {
      if (s.endDate > last.endDate) last.endDate = s.endDate;
      last.revenue += Number(s.revenue) || 0;
    } else {
      visits.push({ startDate: s.startDate, endDate: s.endDate, revenue: Number(s.revenue) || 0, bike: s.bike });
    }
  });

  return visits.map((v, i) => {
    const isLast = i === visits.length - 1;
    // Only the last visit may stay open-ended/active, and only if the canonical record's
    // own real current status says so — a segment's own recorded end date never
    // overrides "still active" into a fabricated return.
    const endDate = (isLast && rental.status === "active") ? null : v.endDate;
    const status = (isLast && rental.status === "active") ? "active" : "completed";
    const paidDays = Math.max(daysBetween(v.startDate, v.endDate), 0);
    return {
      id: rental.id + "_visit" + i, customerId: rental.customerId,
      bikeModel: v.bike, bikeNameRaw: v.bike, plate: rental.plate || "",
      startDate: v.startDate, endDate, bookedDays: paidDays, paidDays,
      revenue: v.revenue, status,
      _segmentDerivedFrom: rental.id, // internal provenance marker only, never read elsewhere
    };
  });
}

// Optional second argument lets a caller supply a hypothetical rentals array instead of
// reading DB.data.rentals directly — used only by the Manager Sync Loyalty Preview to show
// what a customer's status/rewards WOULD be after a proposed sync, without writing
// anything. Every existing call site is unaffected, since this only activates when
// explicitly passed.
function customerStats(customer, simulatedRentals) {
  const rentals = simulatedRentals || customerRentals(customer.id);
  // `rentals` stays exactly the real, unexpanded stored history — this is what displays in
  // rental history, what rewards link their rentalId against, and what "current"/"completed"
  // below reference. A merged canonical rental still appears here ONCE, completely
  // unmodified — never rewritten, split, or replaced, per the approved design.
  const current = rentals.find((r) => r.status === "active") || null;
  const completed = rentals.filter((r) => r.status === "completed");

  // MANAGER SUPERSEDES LEGACY: if this customer has ANY Manager-linked rental
  // (mgrRowNumber present), Manager Live is now their operational source of truth — ONLY
  // Manager-linked rentals count toward loyalty. Legacy Gift Tracker rentals stay fully
  // visible in `rentals` above (archive/history), they just stop being summed, so an old
  // duplicate/historical record can never double-count alongside real current Manager
  // activity. A customer with no Manager data at all is completely unaffected by this and
  // continues exactly as before, segments and all.
  const hasManagerData = rentals.some((r) => r.mgrRowNumber !== undefined && r.mgrRowNumber !== null);
  const operationalSource = hasManagerData ? rentals.filter((r) => r.mgrRowNumber !== undefined && r.mgrRowNumber !== null) : rentals;

  // A SEPARATE array, used ONLY for the operational summing loop below — a merged canonical
  // rental (one with `segments`) is expanded into its real visit blocks here, and ONLY
  // here. Non-merged rentals pass through unchanged. This is what "operational loyalty
  // calculations use the reconstructed real segments" actually means: the calculation
  // layer sees real visits; the display/history/reward-linking layer still sees the one
  // real canonical record it always has. (Manager-linked rentals never carry `segments`, so
  // this expansion is a no-op once Manager data supersedes legacy for a customer.)
  const forCalculation = operationalSource.flatMap((r) => (r.segments ? buildVisitsFromSegments(r) : [r]));
  const artifactRentalIds = computeArtifactRentalIds(forCalculation);

  // ONE pass, through the ONE centralized helper, per the approved overlap model. Per-rental
  // operational contribution (visits/days/revenue) is computed once and summed here — this
  // is the single source every operational figure below (and therefore every downstream
  // screen) derives from. `rentals` above stays the FULL history for display purposes — a
  // 2025-only (archived) rental still shows up in rental history, just contributes nothing
  // operationally; a boundary-spanning rental (like an ongoing stay that started in 2025)
  // correctly counts as one visit with its 2026-only days, per the approved design. A
  // proven artifact (see computeArtifactRentalIds above) also stays fully visible here but
  // is skipped entirely for every operational sum below, so it can never double-count
  // alongside the canonical record it duplicates.
  const todayIso = todayISO();
  let rentalCount = 0, paidRentalDays = 0, totalRevenue = 0, qualifiedRentalCount = 0;
  let boundarySpanningCount = 0;
  forCalculation.forEach((r) => {
    if (artifactRentalIds.has(r.id)) return; // proven artifact — visible in history, zero operational contribution
    const contrib = operationalContribution(r, todayIso);
    if (!contrib) return; // archive-only, zero operational contribution
    rentalCount += contrib.visits;
    paidRentalDays += contrib.days;
    totalRevenue += contrib.revenue;
    if (contrib.isBoundarySpanning) boundarySpanningCount++;
    // Qualified Rental check runs against the SAME clipped operational values (days/revenue)
    // as everything else — never against the raw record's all-time fields — so a
    // boundary-spanning rental with zero operational revenue can still qualify purely on its
    // genuine 2026 day count, exactly matching how every other operational figure works.
    const t = qualifiedRentalThreshold(rentalCategory(r));
    if (contrib.days >= t.days || contrib.revenue >= t.revenue) qualifiedRentalCount++;
  });

  const lifetimeRentalDays = rentals.reduce((s, r) => {
    const end = r.endDate || todayIso;
    return s + Math.max(daysBetween(r.startDate, end), Number(r.paidDays) || 0);
  }, 0);
  const previousBikes = [...new Set(completed.map((r) => rentalCategory(r)))];

  return {
    rentals, current, completed,
    rentalCount, qualifiedRentalCount,
    paidRentalDays, lifetimeRentalDays, totalRevenue,
    previousBikes, boundarySpanningCount, artifactRentalIds,
  };
}


function rewardsFor(customerId) { return DB.data.rewards.filter((r) => r.customerId === customerId); }
function findReward(key) { return DB.data.rewards.find((r) => r.key === key) || null; }

// Simple, non-technical customer status — the only categories staff ever see.
// VIP is reserved for customers who've actually experienced Premium Ride or VIP Extra Day;
// Long-Term covers either a high rental count OR one continuous rental that's simply been
// running a long time (6+ months) — visit count alone would undercount a single long-term
// renter like someone on an ongoing monthly arrangement.
const LONG_TERM_DAYS_THRESHOLD = 180;
function computeCustomerStatus(customer, stats) {
  const hasTopTierHistory = rewardsFor(customer.id).some((r) => (r.type === "premium_ride" || r.type === "vip_extra_day") && r.given);
  const n = stats.rentalCount;
  const longByDuration = stats.paidRentalDays >= LONG_TERM_DAYS_THRESHOLD;
  if (hasTopTierHistory || n >= 6) return { label: "VIP Customer", detail: n >= 2 ? `${n}${ordinal(n)} rental` : "" };
  if (n >= 4 || longByDuration) return { label: "Long-Term Customer", detail: n >= 2 ? `${n}${ordinal(n)} rental` : `${stats.paidRentalDays} days with AA` };
  if (n >= 2) return { label: "Returning Customer", detail: `${n}${ordinal(n)} rental` };
  return { label: "New Customer", detail: "" };
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
function customerStatusText(customer, stats) {
  const st = computeCustomerStatus(customer, stats);
  return st.detail ? `${st.label} · ${st.detail}` : st.label;
}

// Returns the full recommendation set for a customer: each item describes
// eligibility + whatever has actually been given. Nothing here is ever
// shown to the customer automatically — internal use only.
function getSuggestions(customer, stats) {
  const out = [];

  // Manual override support: a reward record can carry `overrideEligible` (true/false).
  // When present, it wins for display, but the underlying calculated value always stays
  // available on the suggestion (`calculatedEligible`) so the system recommendation is
  // never lost, just superseded.
  function effectiveEligible(reward, calculatedEligible) {
    if (reward && reward.overrideEligible !== undefined && reward.overrideEligible !== null) return reward.overrideEligible;
    return calculatedEligible;
  }
  function isOverridden(reward) {
    return !!(reward && reward.overrideEligible !== undefined && reward.overrideEligible !== null);
  }

  // 1. Welcome Gift — based on the CONFIRMED PAID BOOKING duration at handover, not on
  //    completed rental days. One-time per customer. Not retroactive for rentals handed
  //    over before the Loyalty Program Effective Date. Once given, it's never reversed even
  //    if the customer later shortens their trip.
  {
    const key = "welcome_kit:" + customer.id;
    const existing = findReward(key);
    const effectiveDate = DB.data.meta.loyaltyEffectiveDate;
    const alreadyGiven = !!(existing && existing.given);
    // Earliest rental handed over on/after the effective date with a confirmed paid booking of 7+ days.
    const qualifying = stats.rentals
      .filter((r) => (!effectiveDate || r.startDate >= effectiveDate) && (Number(r.bookedDays) || 0) >= WELCOME_KIT_MIN_DAYS)
      .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))[0] || null;
    // Has this customer got ANY rental at all on/after the effective date? If not, the
    // program simply isn't active for them yet — distinct from "active but not eligible".
    const hasEraRental = stats.rentals.some((r) => !effectiveDate || r.startDate >= effectiveDate);
    const calculatedEligible = !alreadyGiven && !!qualifying;
    const eligible = alreadyGiven ? false : effectiveEligible(existing, calculatedEligible);

    let desc, reason;
    if (alreadyGiven) {
      desc = "One-time reward — already given to this customer.";
      reason = existing.notes || `Given at handover, ${fmtDate(existing.dateGiven)}.`;
    } else if (qualifying) {
      desc = `Give once, at bike handover, once a confirmed paid booking of ${WELCOME_KIT_MIN_DAYS}+ days is reached.`;
      reason = `Paid booking of ${qualifying.bookedDays} day(s) on ${qualifying.bikeModel}, handover ${fmtDate(qualifying.startDate)}.`;
    } else if (!hasEraRental) {
      desc = `The AA Loyalty Program became effective ${fmtDate(effectiveDate)}. This customer has no booking on or after that date yet, so the Welcome Gift isn't active for them.`;
      reason = "Not active — no rental on or after the loyalty program's effective date.";
    } else {
      desc = `Give once, at bike handover, once a confirmed paid booking of ${WELCOME_KIT_MIN_DAYS}+ days is reached (on or after ${fmtDate(effectiveDate)}).`;
      reason = "No qualifying booking of 7+ paid days on or after the effective date yet.";
    }

    out.push({
      key, type: "welcome_kit",
      title: REWARD_LABELS.welcome_kit,
      desc, eligible, reason,
      calculatedEligible, overridden: !alreadyGiven && isOverridden(existing),
      notActive: !alreadyGiven && !qualifying && !hasEraRental,
      reward: existing, repeatable: false,
      rentalId: qualifying ? qualifying.id : null,
      estimatedValue: rewardCost("welcomeGift"),
    });
  }

  // 2. Journey Gift — based on ACTUAL PAID/COMPLETED days, only given at actual return.
  //    Tracked fully separately from the Welcome Gift; never given early off the booking alone.
  //    A rental that was FULLY COMPLETED before the Loyalty Program Effective Date never
  //    creates a pending gift obligation — the program didn't exist yet — but it still
  //    counts everywhere else (Times Rented, Qualified Rentals, revenue, relationship status).
  {
    const effectiveDate = DB.data.meta.loyaltyEffectiveDate;
    const isHistorical = (rental) => rental.status === "completed" && effectiveDate && rental.endDate && rental.endDate < effectiveDate;
    const hasActiveEraRental = stats.rentals.some((r) => !isHistorical(r));

    stats.rentals.forEach((rental) => {
      const key = "journey_gift:" + rental.id;
      const category = rentalCategory(rental);
      const threshold = journeyThreshold(category);
      const accruedDays = Number(rental.paidDays) || 0;
      const isReturned = rental.status === "completed";
      const meetsThreshold = accruedDays >= threshold;
      const historical = isHistorical(rental);
      const calculatedEligible = !historical && isReturned && meetsThreshold;
      const rewardRec = historical ? null : findReward(key);
      const overridden = !historical && isOverridden(rewardRec);
      const eligible = historical ? false : effectiveEligible(rewardRec, calculatedEligible);

      // A rental can already have cleared the day threshold while still active (bike not
      // yet returned) — that's a distinct "qualified, waiting on return" state from "not
      // yet qualified", even though the reward can't actually be given until return either way.
      const qualifiedPending = !historical && !isReturned && meetsThreshold && !overridden;

      out.push({
        key, type: "journey_gift", rentalId: rental.id,
        title: `${REWARD_LABELS.journey_gift} — ${category}`,
        desc: historical
          ? `Completed before the Loyalty Program's effective date (${fmtDate(effectiveDate)}) — no gift obligation applies, but this rental still counts toward relationship history.`
          : isReturned
            ? `Given at return once a rental reaches ${threshold} actual paid/completed days on this bike class.`
            : `Give only at return. Required: ${threshold} actual paid/completed days on this bike class.`,
        eligible, calculatedEligible, overridden, qualifiedPending, historical,
        inProgress: !historical && !isReturned && !overridden,
        reason: historical
          ? `Historical — Before Loyalty Program (returned ${fmtDate(rental.endDate)}).`
          : isReturned
            ? `${accruedDays} paid day(s), returned ${fmtDate(rental.endDate)}.`
            : qualifiedPending
              ? `${accruedDays} completed paid day(s) so far — already past the ${threshold}-day threshold, waiting on return.`
              : `${accruedDays} completed paid day(s) so far (still active) — bike not yet returned.`,
        reward: rewardRec, repeatable: false,
        estimatedValue: rewardCost("journeyGift"),
      });
    });

    // If literally everything on file predates the program, the headline card should say
    // so plainly rather than surfacing any single historical rental's status.
    out.push({
      key: "journey_gift_no_current:" + customer.id, type: "journey_gift", isNoCurrentRentalMarker: true,
      title: REWARD_LABELS.journey_gift,
      desc: "No rental on or after the Loyalty Program's effective date yet.",
      eligible: false, calculatedEligible: false, overridden: false, noCurrentRental: !hasActiveEraRental,
      reason: "No current rental under the active program.",
      reward: null, repeatable: false,
    });
  }

  // 3. Return Privilege / Ride Upgrade — a normal rental loyalty privilege that only ever
  //    moves a customer through the 155cc fleet (never a jump to Forza/XMAX — that's Premium
  //    Ride Experience, a completely separate reward below). Capped at NMAX Keyless/ABS.
  {
    const given = rewardsFor(customer.id).filter((r) => r.type === "return_privilege" && r.given)
      .sort((a, b) => (a.dateGiven < b.dateGiven ? -1 : 1));
    given.forEach((rw, idx) => {
      const target = RIDE_UPGRADE_LADDER_VISUAL[idx + 1] || "top of the ladder";
      out.push({
        key: rw.key, type: "return_privilege",
        title: `${REWARD_LABELS.return_privilege} — upgraded to ${target}`,
        desc: "Return Privilege previously used.",
        eligible: true, calculatedEligible: true, overridden: false, rideUpgradeStatus: "used",
        reason: `Used ${fmtDate(rw.dateGiven)}.${rw.loyaltyRate ? ` Loyalty rate applied: ${fmtMoney(rw.loyaltyRate)}/${rw.rateUnit || "month"} (regular ${fmtMoney(rw.normalRate)}).` : ""}`,
        reward: rw, repeatable: true,
        normalRate: rw.normalRate || null, loyaltyRate: rw.loyaltyRate || null, rateUnit: rw.rateUnit || null,
      });
    });

    const lastRental = stats.current || stats.rentals[0] || null;
    const lastTier = lastRental ? rentalCategory(lastRental) : null;
    const lastRideCategory = lastRental ? rideUpgradeCategory(lastRental) : null;
    const isOn300cc = lastTier === "Forza 300" || lastTier === "XMAX 300";
    const nextTarget = lastRideCategory ? RIDE_UPGRADE_NEXT[lastRideCategory] : undefined;
    // True when we had to guess Aerox-vs-NMAX family from an ambiguous historical name
    // (e.g. "Drone", or a garbled entry) rather than a clearly recognizable one.
    let familyUncertain = false;
    if (lastRental && lastRental.bikeNameRaw && (lastTier === "155cc Standard Key" || lastTier === "155cc Keyless/ABS")) {
      const n = normalizeBikeName(lastRental.bikeNameRaw);
      familyUncertain = !(n.includes("aerox") || n.includes("rax") || n.includes("rex") || n.includes("cool") || n.includes("nmax"));
    }

    if (isOn300cc) {
      // 300cc riders are never routed through the 155cc ladder — handled separately via
      // Premium Ride Experience / VIP Extra Day, not a Ride Upgrade "downgrade".
      out.push({
        key: "return_privilege:" + customer.id + ":na300",
        type: "return_privilege",
        title: `${REWARD_LABELS.return_privilege} — not applicable`,
        desc: "This customer's current bike is already Forza/XMAX (300cc) — the normal 155cc Ride Upgrade ladder doesn't apply. See Premium Ride Experience / VIP Extra Day on Us instead.",
        eligible: false, calculatedEligible: false, overridden: false,
        reason: `Already riding ${lastTier}.`,
        reward: null, repeatable: false, notApplicable300cc: true,
      });
    } else if (nextTarget) {
      const key = "return_privilege:" + customer.id + ":" + (given.length + 1);
      const enoughQualified = stats.qualifiedRentalCount >= RETURN_PRIVILEGE_MIN_QUALIFIED_RENTALS;
      const enoughRevenue = stats.totalRevenue >= RETURN_PRIVILEGE_MIN_REVENUE;
      const calculatedEligible = enoughQualified && enoughRevenue;
      const rewardRec = findReward(key);
      const pricing = getUpgradePricing(lastRideCategory, nextTarget);
      let reason;
      if (calculatedEligible) {
        reason = `${stats.qualifiedRentalCount} qualified rental(s), ${fmtMoney(stats.totalRevenue)} lifetime revenue.`;
      } else if (!enoughQualified) {
        reason = `${stats.qualifiedRentalCount} of ${RETURN_PRIVILEGE_MIN_QUALIFIED_RENTALS} qualified rentals`;
      } else {
        reason = "Revenue requirement not yet reached";
      }
      // Available until actually used — accepting or declining an offer never consumes it.
      const accepted = !!(rewardRec && rewardRec.upgradeStatus === "accepted" && !rewardRec.given);
      const rideUpgradeStatus = rewardRec && rewardRec.given ? "used" : accepted ? "accepted" : "available";
      out.push({
        key, type: "return_privilege",
        title: `${REWARD_LABELS.return_privilege} — upgrade to ${nextTarget}`,
        desc: `Based on their current/last bike (${lastRideCategory}${familyUncertain ? " — Aerox/NMAX family unclear from the historical name, defaulted to Aerox; flag for review if that's wrong" : ""}). Eligible once a customer has ${RETURN_PRIVILEGE_MIN_QUALIFIED_RENTALS}+ Qualified Rentals (substantial paid days or value, not just visit count) and ${fmtMoney(RETURN_PRIVILEGE_MIN_REVENUE)}+ lifetime revenue, subject to bike availability.`,
        eligible: effectiveEligible(rewardRec, calculatedEligible), calculatedEligible, overridden: isOverridden(rewardRec),
        reason, notYetReason: reason, needsReview: !!familyUncertain,
        reward: rewardRec, repeatable: true, upgradeTarget: nextTarget, fromCategory: lastRideCategory,
        normalRate: pricing ? pricing.normalRate : null, loyaltyRate: pricing ? pricing.loyaltyRate : null, rateUnit: pricing ? pricing.unit : null,
        // The reward's financial value is only the DISCOUNT actually given (normal minus
        // loyalty rate) — never the full rental price. Null when the step isn't priced yet.
        estimatedValue: pricing ? Math.max(pricing.normalRate - pricing.loyaltyRate, 0) : null,
        rideUpgradeStatus,
      });
    } else if (lastRideCategory === "NMAX Keyless/ABS 155cc") {
      out.push({
        key: "return_privilege:" + customer.id + ":top",
        type: "return_privilege",
        title: `${REWARD_LABELS.return_privilege} — top of the ladder`,
        desc: "This customer has reached NMAX Keyless/ABS — the top of the normal Ride Upgrade ladder. No further Ride Upgrade applies; consider Premium Ride Experience instead.",
        eligible: false, calculatedEligible: false, overridden: false,
        reason: "Already at NMAX Keyless/ABS 155cc, the top of the Ride Upgrade ladder.",
        reward: null, repeatable: false, atTopTier: true,
      });
    }
  }

  // 4. Premium Ride Experience — a SEPARATE reward from Ride Upgrade AND from Journey Gift.
  //    NOT gated on the bike being returned — an active rental counts fully. A dynamic
  //    benefit engine for every customer: the Experience Bike is always relative to the
  //    customer's ACTUAL current bike (never a blanket jump to 300cc) — see
  //    premiumExperienceBike() for the tier progression. Eligibility itself is purely the
  //    180+ cumulative paid days (since this reward was last used) loyalty/time dimension;
  //    tier-appropriateness is handled by WHICH bike gets recommended, not by gating
  //    eligibility on having already experienced a specific tier.
  //    Supports Locked / Ready / Reserved / Used; an unused Ready/Reserved reward is never
  //    deleted just because the customer's current rental happens to end.
  {
    const givenPremium = rewardsFor(customer.id).filter((r) => r.type === "premium_ride" && r.given)
      .sort((a, b) => (a.dateGiven < b.dateGiven ? -1 : 1));

    const lastUsed = givenPremium[givenPremium.length - 1] || null;
    const cycleBaseline = effectiveCycleBaseline(lastUsed, stats);
    const paidDaysSinceLast = Math.max(stats.paidRentalDays - cycleBaseline, 0);
    const enoughLoyaltyDays = paidDaysSinceLast >= PREMIUM_RIDE_MIN_PAID_DAYS;

    const lastRental = stats.current || stats.rentals[0] || null;
    const currentBikeRaw = lastRental ? (lastRental.bikeNameRaw || lastRental.bikeModel) : null;
    const experienceBike = lastRental ? premiumExperienceBike(lastRental) : null;
    // 300cc riders have no Premium Ride Experience target — their equivalent reward is
    // VIP Extra Day on Us (below), never a downgrade or an invented target here.
    const calculatedEligible = enoughLoyaltyDays && !!experienceBike;

    givenPremium.forEach((rw, idx) => {
      const isLatest = idx === givenPremium.length - 1;
      out.push({
        key: rw.key, type: "premium_ride",
        title: REWARD_LABELS.premium_ride,
        desc: "Premium Ride Experience — used.",
        eligible: true, calculatedEligible: true, overridden: false, cycleStatus: "used",
        reason: `Used ${fmtDate(rw.dateGiven)}${rw.bikeUsed ? " on " + rw.bikeUsed : ""}.`
          + (isLatest ? ` Next reward progress: ${paidDaysSinceLast} / ${PREMIUM_RIDE_MIN_PAID_DAYS} days.` : ""),
        reward: rw, repeatable: true,
        estimatedValue: rw.value,
      });
    });

    const key = "premium_ride:" + customer.id + ":" + (givenPremium.length + 1);
    const rewardRec = findReward(key);
    const eligible = effectiveEligible(rewardRec, calculatedEligible);
    const isReserved = !!(rewardRec && rewardRec.reserved && !rewardRec.given);
    const cycleStatus = eligible ? (isReserved ? "reserved" : "ready") : "locked";

    let reason;
    if (calculatedEligible) {
      reason = `${paidDaysSinceLast} paid day(s) since last Premium Ride (${PREMIUM_RIDE_MIN_PAID_DAYS} needed) — does not require the bike to be returned.`;
    } else if (enoughLoyaltyDays && !experienceBike) {
      reason = "Long-term loyalty requirement achieved, but this customer's current bike is already 300cc — see VIP Extra Day on Us instead.";
    } else {
      reason = `${paidDaysSinceLast} of ${PREMIUM_RIDE_MIN_PAID_DAYS} paid days since last Premium Ride.` + (experienceBike ? ` Would offer: ${experienceBike}.` : "");
    }

    out.push({
      key, type: "premium_ride",
      title: REWARD_LABELS.premium_ride,
      desc: "A complimentary standby perk, not a guaranteed reservation — the customer can share preferred dates 3–5 days ahead, but final availability is only confirmed the day before, after paid rentals are settled first. Swaps to the Experience Bike for 2 days / 1 night, then back to their original bike — this never closes, splits, or restarts their ongoing rental.",
      eligible, calculatedEligible, overridden: isOverridden(rewardRec), cycleStatus,
      reason,
      reward: rewardRec, repeatable: true,
      savedForNextVisit: eligible && !stats.current,
      paidDaysSinceLast, currentBikeRaw, experienceBike,
      estimatedValue: experienceBike ? dailyValueFor(experienceBike) * 2 : null,
    });
  }

  // 5. VIP Extra Day on Us — an EARNED reward with its own qualification/redemption cycle.
  //    A dynamic benefit for EVERY customer now (not just Forza/XMAX riders) — this is
  //    Option B of the Return Privilege choice: same preferred bike/category, one
  //    complimentary extra rental day, rather than moving up a tier. Qualification is
  //    meaningful repeat rentals + cumulative paid days since the last Extra Day cycle,
  //    tier-aware (110/125cc, 155cc, Forza/XMAX 300) via editable Settings thresholds —
  //    never just counting transactions (e.g. 3+3 days across two visits does not qualify
  //    on its own if the day threshold isn't met).
  {
    const lastRental = stats.current || stats.rentals[0] || null;
    const currentTierVip = lastRental ? rentalCategory(lastRental) : null;
    const broadTierVip = currentTierVip ? broadTier(currentTierVip) : "125cc";
    const thresholdVip = vipThresholdFor(broadTierVip);
    // dailyValueFor() needs the FINE-grained category (matches the Ride Upgrade ladder
    // naming used as keys in DEFAULT_DAILY_VALUES) — rentalCategory() above is the coarse
    // 5-tier bucket used only for the threshold lookup, never for the value lookup.
    const fineTierVip = lastRental ? rideUpgradeCategory(lastRental) : null;

    const givenVip = rewardsFor(customer.id).filter((r) => r.type === "vip_extra_day" && r.given)
      .sort((a, b) => (a.dateGiven < b.dateGiven ? -1 : 1));

    const lastUsedVip = givenVip[givenVip.length - 1] || null;
    const cycleBaselineVip = effectiveCycleBaseline(lastUsedVip, stats);
    const cycleBaselineQualifiedVip = effectiveCycleBaselineQualified(lastUsedVip, stats);
    const paidDaysSinceLastVip = Math.max(stats.paidRentalDays - cycleBaselineVip, 0);
    const qualifiedEpisodesSinceLastVip = Math.max(stats.qualifiedRentalCount - cycleBaselineQualifiedVip, 0);
    const enoughEpisodes = qualifiedEpisodesSinceLastVip >= thresholdVip.episodes;
    const enoughDays = paidDaysSinceLastVip >= thresholdVip.days;
    const calculatedEligible = enoughEpisodes && enoughDays;

    givenVip.forEach((rw, idx) => {
      const isLatest = idx === givenVip.length - 1;
      out.push({
        key: rw.key, type: "vip_extra_day",
        title: REWARD_LABELS.vip_extra_day,
        desc: "VIP Extra Day — used.",
        eligible: true, calculatedEligible: true, overridden: false, cycleStatus: "used",
        reason: `Used ${fmtDate(rw.dateGiven)}${rw.bikeUsed ? " on " + rw.bikeUsed : ""}.`
          + (isLatest ? ` Next reward progress: ${qualifiedEpisodesSinceLastVip}/${thresholdVip.episodes} episodes, ${paidDaysSinceLastVip}/${thresholdVip.days} days.` : ""),
        reward: rw, repeatable: true,
        estimatedValue: rw.value,
      });
    });

    const key = "vip_extra_day:" + customer.id + ":" + (givenVip.length + 1);
    const rewardRec = findReward(key);
    const eligible = effectiveEligible(rewardRec, calculatedEligible);
    const isReserved = !!(rewardRec && rewardRec.reserved && !rewardRec.given);
    const cycleStatus = eligible ? (isReserved ? "reserved" : "ready") : "locked";

    let reasonVip;
    if (calculatedEligible) {
      reasonVip = `${qualifiedEpisodesSinceLastVip} qualified rental(s), ${paidDaysSinceLastVip} paid day(s) since last VIP reward (needs ${thresholdVip.episodes}+ episodes and ${thresholdVip.days}+ days).`;
    } else if (!enoughEpisodes) {
      reasonVip = `${qualifiedEpisodesSinceLastVip} of ${thresholdVip.episodes} qualified rental episodes since last VIP reward.`;
    } else {
      reasonVip = `${paidDaysSinceLastVip} of ${thresholdVip.days} cumulative paid days since last VIP reward.`;
    }

    out.push({
      key, type: "vip_extra_day",
      title: REWARD_LABELS.vip_extra_day,
      desc: `An earned reward, redeemed as one complimentary day added to a qualifying rental of 7+ paid days — e.g. Pay 7 → Ride 8, Pay 10 → Ride 11 (not a repeating "7+1" promotion, and paying 14 doesn't become 16). The alternative to Ride Upgrade for customers who genuinely prefer their current bike size.`,
      eligible, calculatedEligible, overridden: isOverridden(rewardRec), cycleStatus,
      reason: reasonVip,
      reward: rewardRec, repeatable: true,
      savedForNextVisit: eligible && !stats.current,
      lastUsed: lastUsedVip ? lastUsedVip.dateGiven : null,
      currentTierVip, qualifiedEpisodesSinceLastVip, paidDaysSinceLastVip, thresholdVip,
      estimatedValue: fineTierVip ? dailyValueFor(fineTierVip) : null,
    });
  }

  return out;
}

// Tax and Por Ror Bor are tracked as two fully independent expiry dates —
// never assume one changes when the other does.
function renewalInfo(dateISO) {
  if (!dateISO) return { level: "unset", daysLeft: null, label: "Not set" };
  const days = daysFromToday(dateISO);
  let level;
  if (days <= 0) level = "red";
  else if (days <= 30) level = "amber";
  else level = "green";
  const label = days <= 0 ? `Overdue by ${Math.abs(days)}d` : `Due in ${days}d`;
  return { level, daysLeft: days, label };
}

// "Overdue — Renewal Pending" (the "Not yet" import case): the previous Tax has expired
// but renewal hasn't happened yet (commonly waiting on ตรอ. inspection). This is NOT the
// same as a missing/unset date — it's a known, active red state with no fake expiry date
// invented for it.
function taxRenewalInfo(v) {
  if (v.taxOverduePending) return { level: "red", daysLeft: null, label: "Overdue — Renewal Pending", pending: true };
  return renewalInfo(v.taxExpiryDate);
}

const RENEWAL_LEVEL_RANK = { red: 0, amber: 1, unset: 1, green: 2 };

function vehicleStatus(v) {
  const tax = taxRenewalInfo(v);
  const prb = renewalInfo(v.porRorBorExpiryDate);

  const kmLeft = (Number(v.nextServiceKm) || 0) - (Number(v.currentKm) || 0);
  let serviceLevel = "green";
  if (kmLeft < 0) serviceLevel = "red";
  else if (kmLeft <= 300) serviceLevel = "amber";

  // Overall = the worse of Tax / Por Ror Bor (used for sorting and top-level alerts only —
  // the two are never merged into a single date, just compared for urgency).
  const overall = RENEWAL_LEVEL_RANK[tax.level] <= RENEWAL_LEVEL_RANK[prb.level] ? tax.level : prb.level;

  const flags = [];
  if (tax.pending) flags.push({ level: "red", text: `Tax ${tax.label}${v.renewalNote ? " — " + v.renewalNote : ""}` });
  else if (tax.level === "red") flags.push({ level: "red", text: `Tax ${tax.label}` });
  else if (tax.level === "amber") flags.push({ level: "amber", text: `Tax ${tax.label}` });
  else if (tax.level === "unset") flags.push({ level: "amber", text: "Tax expiry not set" });

  if (prb.level === "red") flags.push({ level: "red", text: `Por Ror Bor ${prb.label}` });
  else if (prb.level === "amber") flags.push({ level: "amber", text: `Por Ror Bor ${prb.label}` });
  else if (prb.level === "unset") flags.push({ level: "amber", text: "Por Ror Bor expiry not set" });

  if (serviceLevel === "red") flags.push({ level: "red", text: `${Math.abs(kmLeft)}km past service` });
  else if (serviceLevel === "amber") flags.push({ level: "amber", text: `Service due in ${kmLeft}km` });

  return { tax, prb, overall, service: { level: serviceLevel, kmLeft }, flags };
}

function dashboardStats() {
  const revenue = DB.data.rentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const given = (type) => DB.data.rewards.filter((r) => r.type === type && r.given);
  const welcomeKits = given("welcome_kit").length;
  const journeyGifts = given("journey_gift").length;
  const privilegesUsed = given("return_privilege").length + given("premium_ride").length + given("vip_extra_day").length;
  const loyaltyCost = DB.data.rewards.filter((r) => r.given).reduce((s, r) => s + (Number(r.value) || 0), 0);
  const loyaltyPct = revenue > 0 ? (loyaltyCost / revenue) * 100 : 0;

  const eligibleCustomers = new Set();
  DB.data.customers.forEach((c) => {
    const stats = customerStats(c);
    const sugg = getSuggestions(c, stats);
    if (sugg.some((s) => s.eligible && !(s.reward && s.reward.given))) eligibleCustomers.add(c.id);
  });

  const vehicleAlerts = DB.data.vehicles.map((v) => ({ v, status: vehicleStatus(v) }))
    .filter((x) => x.status.overall !== "green");

  return { revenue, welcomeKits, journeyGifts, privilegesUsed, loyaltyCost, loyaltyPct, eligibleCustomers, vehicleAlerts };
}

/* ---------------------------------------------------------------------- */
/* ROUTER + STATE                                                          */
/* ---------------------------------------------------------------------- */

const state = { route: "home", customerId: null, vehicleId: null, search: "", expandedCard: null, searchOpen: false, rewardHistoryCustomerId: null, rewardHistorySearch: "", reportsPeriod: "month", rewardHistoryFilter: "all", backupConfirmed: false, lastReconciliationResult: null, managerSyncStatus: "idle", managerSyncPlan: null, managerSyncError: null, managerSyncResult: null, managerSyncExpandedNewCustomer: null, cloudSyncStatus: "idle", cloudSyncError: null, cloudSyncPreview: null };

// Import wizard state — lives outside `state` since it holds parsed file data,
// not something to preserve across normal navigation.
let importState = null;
function resetImportState(type) {
  importState = { type: type || null, headers: [], rows: [], mapping: {}, fileName: "", updateDuplicates: false };
}

function navigate(route, params = {}) {
  state.route = route;
  Object.assign(state, params);
  document.querySelectorAll(".tab").forEach((t) => {
    t.setAttribute("aria-current", t.dataset.route === topLevel(route) ? "page" : "false");
  });
  // The launcher (app home) is a full-screen picker — no bottom tabs or gear icon over it.
  const tabbarEl = document.getElementById("tabbar");
  const gearEl = document.getElementById("gear-btn");
  if (tabbarEl) tabbarEl.style.display = route === "home" ? "none" : "";
  if (gearEl) gearEl.style.display = route === "home" ? "none" : "";
  render();
  document.getElementById("app").scrollTo?.(0, 0);
  window.scrollTo(0, 0);
}
function topLevel(route) {
  if (route.startsWith("customer") || route === "needs-review" || route === "rewards-ready" || route === "active-riders" || route === "reward-history" || route === "loyalty-reports") return "customers";
  if (route.startsWith("vehicle")) return "vehicles";
  return "settings"; // settings/import — no bottom tab, reached via gear icon
}

/* ---------------------------------------------------------------------- */
/* RENDER — APP HOME (launcher: pick Customer Loyalty or Vehicle Renewal)  */
/* ---------------------------------------------------------------------- */

function renderAppHome() {
  const pendingReviewCount = DB.data.needsReview.filter((r) => !r.resolved).length;
  const needsAttentionCount = DB.data.vehicles.filter((v) => {
    const st = vehicleStatus(v);
    return st.tax.level !== "green" || st.prb.level !== "green";
  }).length;
  const syncMeta = getManagerSyncMeta();

  return `
    <div class="launcher-wrap dark-bg compact">
      <div class="launcher-compact-brand">
        <div class="launcher-compact-mark">AA</div>
        <div class="launcher-compact-text">
          <div class="launcher-compact-title">AA SCOOTER RENTAL</div>
          <div class="launcher-compact-sub">Chiang Mai · Internal Operations</div>
        </div>
      </div>
      <button class="pill pill-neutral" data-goto="manager-sync" style="margin-bottom:14px; display:inline-flex; align-items:center; gap:6px; cursor:pointer;">
        ${syncMeta.lastManagerCheckAt ? `Manager: Synced ✓ · ${escapeHtml(fmtDateTimeLabel(syncMeta.lastManagerCheckAt) || "")}` : `Manager: Not checked yet`}
      </button>
      <div class="launcher-cards compact">
        <button class="module-card dark compact" data-goto="customers">
          <div class="module-card-arrow">${ICONS.chevronRight}</div>
          <div class="module-card-icon compact">${ICONS.loyaltyMark}</div>
          <div class="module-card-title">Customer Loyalty</div>
          <div class="module-card-sub">Customers · Rewards · Ride Benefits${pendingReviewCount ? ` · ${pendingReviewCount} to review` : ""}</div>
        </button>
        <button class="module-card light compact" data-goto="vehicles">
          <div class="module-card-arrow">${ICONS.chevronRight}</div>
          <div class="module-card-icon compact">${ICONS.renewalMark}</div>
          <div class="module-card-title">Vehicle Renewal</div>
          <div class="module-card-sub">Por Ror Bor · Tax · Due Dates${needsAttentionCount ? ` · ${needsAttentionCount} need attention` : ""}</div>
        </button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* RENDER — CUSTOMERS HOME (search + at-a-glance insight cards)            */
/* ---------------------------------------------------------------------- */

// "What do I need to know or do right now?" — computed fresh each render from the
// same underlying getSuggestions()/customerStats() logic used everywhere else.
// A concise, specific detail string for a reward-ready line item — e.g. the actual
// upgrade target, or paid-day count — never just repeating the reward type name.
function shortRewardDetail(s) {
  if (s.type === "return_privilege" && s.upgradeTarget) return s.upgradeTarget;
  if (s.type === "welcome_kit") {
    const m = /Paid booking of (\d+) day/.exec(s.reason || "");
    return m ? `${m[1]}-day paid booking` : "";
  }
  if (s.type === "journey_gift") {
    const category = (s.title || "").split(" — ")[1] || "";
    const m = /(\d+) paid day/.exec(s.reason || "");
    return [category, m ? `${m[1]} days` : ""].filter(Boolean).join(" · ");
  }
  return "";
}

function computeHomeInsights() {
  const rewardsDueMap = new Map(); // customerId -> { customer, items: [{type, detail}] }
  const journeyGiftsDueMap = new Map();
  const returningVip = [];
  const activeLongTermRiders = [];

  DB.data.customers.forEach((c) => {
    const stats = customerStats(c);
    const sugg = getSuggestions(c, stats);

    sugg.forEach((s) => {
      if (s.eligible && !(s.reward && s.reward.given)) {
        const target = s.type === "journey_gift" ? journeyGiftsDueMap : rewardsDueMap;
        if (!target.has(c.id)) target.set(c.id, { customer: c, items: [] });
        target.get(c.id).items.push({ type: s.type, title: s.title, detail: shortRewardDetail(s) });
      }
    });

    const hasPrivilegeHistory = rewardsFor(c.id).some((r) => ["return_privilege", "premium_ride", "vip_extra_day"].includes(r.type) && r.given);
    if (stats.rentalCount >= 3 || hasPrivilegeHistory) {
      returningVip.push({ customer: c, detail: `${stats.rentalCount} rental(s)` });
    }

    // Presentation-only grouping — "currently renting" + already Long-Term/VIP by the
    // existing (unchanged) computeCustomerStatus logic. No new eligibility rule.
    // Current Bike = the raw bike name from THIS specific active rental row only —
    // never the standardized/loyalty-tier category, never a fallback from another field.
    if (stats.current) {
      const custStatus = computeCustomerStatus(c, stats);
      if (custStatus.label === "Long-Term Customer" || custStatus.label === "VIP Customer") {
        activeLongTermRiders.push({ customer: c, detail: custStatus.label, bike: stats.current.bikeNameRaw || stats.current.bikeModel });
      }
    }
  });

  // "Rewards Ready" combines Welcome Gift / Ride Upgrade / Premium / VIP items (rewardsDueMap)
  // with Journey Gift items due at return — same underlying eligibility, just one card.
  const rewardsReadyMap = new Map();
  rewardsDueMap.forEach((v, k) => rewardsReadyMap.set(k, { customer: v.customer, items: [...v.items] }));
  journeyGiftsDueMap.forEach((v, k) => {
    if (!rewardsReadyMap.has(k)) rewardsReadyMap.set(k, { customer: v.customer, items: [] });
    rewardsReadyMap.get(k).items.push(...v.items);
  });

  return {
    rewardsDue: [...rewardsDueMap.values()],
    journeyGiftsDue: [...journeyGiftsDueMap.values()],
    rewardsReady: [...rewardsReadyMap.values()],
    returningVip,
    activeLongTermRiders,
  };
}

function renderInsightCard(id, title, items, renderRow, emptyLabel, iconName) {
  const count = items.length;
  const expanded = state.expandedCard === id;
  return `
    <div class="insight-card" data-insight-toggle="${id}">
      <div class="insight-card-top">
        <div style="display:flex; gap:12px; align-items:center;">
          ${iconName ? icon(iconName, count > 0 ? "" : "neutral") : ""}
          <div>
            <div class="insight-title">${escapeHtml(title)}</div>
            <div class="insight-sub">${count === 0 ? escapeHtml(emptyLabel) : `Tap to ${expanded ? "collapse" : "view"}`}</div>
          </div>
        </div>
        <div class="insight-count ${count === 0 ? "zero" : ""}">${count}</div>
      </div>
      ${expanded && count > 0 ? `
        <div class="insight-expand">
          ${items.slice(0, 8).map(renderRow).join("")}
          ${items.length > 8 ? `<div class="insight-row-detail">+ ${items.length - 8} more</div>` : ""}
        </div>
      ` : ""}
    </div>
  `;
}

function renderCustomersHome() {
  const q = state.search.trim().toLowerCase();
  const pendingReviewCount = DB.data.needsReview.filter((r) => !r.resolved).length;

  // A customer can also be found by a bike they've rented (original historical name or its
  // standardized category, e.g. "Click Red" or "125cc") — not just name/phone/passport.
  function customerMatchesBike(c, q) {
    return DB.data.rentals.some((r) => {
      if (r.customerId !== c.id) return false;
      const raw = (r.bikeNameRaw || "").toLowerCase();
      const category = rentalCategory(r).toLowerCase();
      return raw.includes(q) || category.includes(q);
    });
  }

  const topBar = `
    <div class="brand-topbar">
      <button class="brand-topbar-icon" data-goto="home" aria-label="AA Scooter home">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      <div class="brand-topbar-title">
        <div class="brand-topbar-line1">AA SCOOTER <span>RENTAL</span></div>
        <div class="brand-topbar-line2">CHIANG MAI</div>
      </div>
      <button class="brand-topbar-icon" id="notif-btn" aria-label="Notifications">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>
      </button>
    </div>`;

  // Search mode — reuses the exact existing filter logic; only the entry point moved
  // (from a persistent hero search bar to the Quick Actions "Search Customer" button
  // and the top bar), to match the reference composition, which has no home search bar.
  if (q || state.searchOpen) {
    const list = DB.data.customers
      .filter((c) => c.name.toLowerCase().includes(q) || (c.phone || "").toLowerCase().includes(q) || (c.passport || "").toLowerCase().includes(q) || customerMatchesBike(c, q))
      .sort((a, b) => a.name.localeCompare(b.name));
    return `
      <div class="brand-dark-header">
        ${topBar}
        <button class="back-btn" data-action="close-search" style="color:#fff; margin:6px 20px 0;">‹ Back</button>
        <div class="home-search-wrap" style="margin:12px 20px 18px;">
          <span class="search-icon">${boldIcon("search")}</span>
          <input id="customer-search" type="search" inputmode="search" placeholder="Search by name, phone, passport, or bike…" value="${escapeHtml(state.search)}" autocomplete="off" autofocus />
        </div>
      </div>
      <div class="screen-body">
        ${list.length === 0 ? `
          <div class="empty">
            <div class="empty-icon">${boldIcon("search")}</div>
            <h3>No matches</h3>
            <p>Try a different name, phone number, passport, or bike.</p>
          </div>
        ` : list.map((c) => {
          const stats = customerStats(c);
          const statusText = customerStatusText(c, stats);
          const sugg = getSuggestions(c, stats);
          const hasRewardAttention = sugg.some((s) => s.eligible && !(s.reward && s.reward.given));
          const hasUpgrade = sugg.some((s) => s.type === "return_privilege" && s.eligible && !(s.reward && s.reward.given));
          const latestBike = stats.current ? (stats.current.bikeNameRaw || stats.current.bikeModel) : (stats.rentals[0] ? (stats.rentals[0].bikeNameRaw || stats.rentals[0].bikeModel) : null);
          let indicator = "";
          if (stats.current) indicator = `<span class="compact-row-indicator">● Ongoing</span>`;
          else if (hasUpgrade) indicator = `<span class="compact-row-indicator">⭐ Ride Upgrade</span>`;
          else if (hasRewardAttention) indicator = `<span class="compact-row-indicator">🎁 Reward Ready</span>`;
          return `<div class="compact-row" data-goto="customer" data-id="${c.id}">
            <div class="avatar">${initials(c.name)}</div>
            <div class="compact-row-main">
              <div class="compact-row-title">${escapeHtml(c.name)}</div>
              <div class="compact-row-sub">${escapeHtml(statusText)}${latestBike ? " · " + escapeHtml(latestBike) : ""}</div>
            </div>
            ${indicator}
          </div>`;
        }).join("")}
      </div>
    `;
  }

  const insights = computeHomeInsights();
  return `
    <div class="brand-dark-header">
      ${topBar}
      <div class="brand-hero">
        <div class="brand-hero-confetti">
          <span class="spark" style="top:6px; right:42%;">${BOLD.sparkle}</span>
          <span class="spark teal" style="top:34px; right:36%; width:9px;">${BOLD.sparkle}</span>
        </div>
        <div class="brand-hero-content">
          <div class="brand-hero-title">LOYAL<br/><span>RIDER</span></div>
          <div class="brand-hero-sub">Rewarding every<br/>journey with AA</div>
          <button class="hero-banner-v2-cta" data-goto="rewards-ready">View Rewards</button>
        </div>
        <div class="brand-hero-mascot">${BOLD.mascot}</div>
      </div>
    </div>
    <div class="screen-body" style="margin-top:-14px;">
      <div class="status-card-row">
        ${renderStatusCard("rewards-ready", "gift", "Rewards Ready", insights.rewardsReady.length, insights.rewardsReady.length === 1 ? "1 customer has a reward available" : `${insights.rewardsReady.length} customers have rewards available`)}
        ${renderStatusCard("active-riders", "helmet", "Active Riders", insights.activeLongTermRiders.length, insights.activeLongTermRiders.length === 1 ? "1 rider currently active" : `${insights.activeLongTermRiders.length} riders currently active`)}
        ${renderStatusCard("needs-review", "clipSearch", "Needs Review", pendingReviewCount, pendingReviewCount === 1 ? "1 record needs review" : `${pendingReviewCount} records need review`)}
      </div>

      <div class="quick-actions-panel">
        <div class="quick-actions-title">Quick Actions</div>
        <div class="quick-actions-row">
          <button class="quick-action" data-action="open-search"><span class="quick-action-circle">${boldIcon("search")}</span><span class="quick-action-label">Search<br/>Customer</span></button>
          <button class="quick-action" data-action="open-search"><span class="quick-action-circle">${boldIcon("gift")}</span><span class="quick-action-label">Add<br/>Reward</span></button>
          <button class="quick-action" data-action="open-reward-history-fresh"><span class="quick-action-circle">${boldIcon("gift")}</span><span class="quick-action-label">Reward<br/>History</span></button>
          <button class="quick-action" data-goto="loyalty-reports"><span class="quick-action-circle">${boldIcon("reports")}</span><span class="quick-action-label">Loyalty<br/>Reports</span></button>
        </div>
      </div>
    </div>
    <button class="fab" id="add-customer-fab" aria-label="Add customer">+</button>
  `;
}

// Reference-style status card: icon top-left, title, big number, one concise hint line,
// circular arrow button — the whole card navigates straight to its own dedicated list
// screen (never expands inline), so a long customer list can never take over the dashboard.
function renderStatusCard(id, iconName, title, count, hint) {
  return `
    <div class="status-card" data-goto="${id}">
      ${boldIcon(iconName)}
      <div class="status-card-title">${escapeHtml(title)}</div>
      <div class="status-card-count">${count}</div>
      <div class="status-card-hint">${escapeHtml(hint)}</div>
      <span class="status-card-arrow">${ICONS.chevronRight}</span>
    </div>
  `;
}

// Stacked customer-reward rows — one clearly separated card per customer, each of
// their ready rewards on its own line (icon + gold type + grey detail), never a
// two-column name/reward layout. Reused by the Rewards Ready dedicated screen.
function renderCustomerRewardRow(entry) {
  return `
    <div class="cust-row" data-goto="customer" data-id="${entry.customer.id}">
      <div class="cust-row-main">
        <div class="cust-row-name">${escapeHtml(cleanCustomerDisplayName(entry.customer.name))}</div>
        ${entry.items.map((it) => `
          <div class="cust-row-reward">
            ${boldIcon(REWARD_ICON[it.type] || "gift", "row")}
            <span class="cust-row-reward-type">${escapeHtml(REWARD_LABELS[it.type] || it.title)}</span>
            ${it.detail ? `<span class="cust-row-reward-detail"> · ${escapeHtml(it.detail)}</span>` : ""}
          </div>
        `).join("")}
      </div>
      <span class="cust-row-chevron">${ICONS.chevronRight}</span>
    </div>
  `;
}

function renderRewardsReadyScreen() {
  const insights = computeHomeInsights();
  // ONE customer = one row, guaranteed by computeHomeInsights()'s Map-based grouping (keyed
  // by customerId) — a customer with multiple eligible rewards already accumulates them into
  // one entry's `items` list, never a separate entry per reward. Sorted by the cleaned
  // display name (honorifics stripped) so real alphabetical order isn't thrown off by
  // everyone named "Mr." clustering together.
  const list = insights.rewardsReady.slice().sort((a, b) =>
    cleanCustomerDisplayName(a.customer.name).localeCompare(cleanCustomerDisplayName(b.customer.name))
  );
  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="customers">‹ Customer Loyalty</button>
      <h1 class="screen-title" style="margin-top:8px;">Rewards Ready</h1>
      <p class="screen-sub">${list.length} customer${list.length === 1 ? "" : "s"} have a reward available</p>
    </header>
    <div class="screen-body">
      ${list.length === 0 ? `
        <div class="empty"><div class="empty-icon">${boldIcon("gift")}</div><h3>Nothing waiting</h3><p>No customer currently has an unclaimed reward.</p></div>
      ` : `<div class="cust-row-list">${list.map(renderCustomerRewardRow).join("")}</div>`}
    </div>
  `;
}

function renderActiveRidersScreen() {
  const insights = computeHomeInsights();
  const list = insights.activeLongTermRiders.slice().sort((a, b) => a.customer.name.localeCompare(b.customer.name));
  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="customers">‹ Customer Loyalty</button>
      <h1 class="screen-title" style="margin-top:8px;">Active Riders</h1>
      <p class="screen-sub">${list.length} long-term rider${list.length === 1 ? "" : "s"} currently renting</p>
    </header>
    <div class="screen-body">
      ${list.length === 0 ? `
        <div class="empty"><div class="empty-icon">${boldIcon("helmet")}</div><h3>No active long-term riders</h3><p>Nobody currently renting is Long-Term or VIP status yet.</p></div>
      ` : `<div class="cust-row-list">${list.map((entry) => `
        <div class="cust-row" data-goto="customer" data-id="${entry.customer.id}">
          <div class="cust-row-main">
            <div class="cust-row-name">${escapeHtml(entry.customer.name)}</div>
            <div class="cust-row-reward">
              ${boldIcon("helmet", "row")}
              <span class="cust-row-reward-type">${escapeHtml(entry.detail)}</span>
              ${entry.bike ? `<span class="cust-row-reward-detail"> · ${escapeHtml(entry.bike)}</span>` : ""}
            </div>
          </div>
          <span class="cust-row-chevron">${ICONS.chevronRight}</span>
        </div>
      `).join("")}</div>`}
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* RENDER — CUSTOMER DETAIL                                                 */
/* ---------------------------------------------------------------------- */

function renderLadder(customer, stats) {
  const lastRental = stats.current || stats.rentals[0] || null;
  const lastRideCategory = lastRental ? rideUpgradeCategory(lastRental) : null;
  // NMAX White's path skips the Aerox-Keyless rung, so for this simplified visual it's
  // shown at the same position as Aerox Keyless (both are "one step before the top").
  const visualCategory = lastRideCategory === "NMAX White Standard Key 155cc" ? "Aerox Standard Key 155cc" : lastRideCategory;
  const currentTierIdx = RIDE_UPGRADE_LADDER_VISUAL.indexOf(visualCategory);
  const meetsQualification = stats.qualifiedRentalCount >= RETURN_PRIVILEGE_MIN_QUALIFIED_RENTALS && stats.totalRevenue >= RETURN_PRIVILEGE_MIN_REVENUE;
  // Index of the step that represents where the customer could go next.
  const nextIndex = (meetsQualification && currentTierIdx >= 0 && currentTierIdx < RIDE_UPGRADE_LADDER_VISUAL.length - 1) ? currentTierIdx + 1 : -1;

  return `
    <div class="ladder">
      ${RIDE_UPGRADE_LADDER_VISUAL.map((label, i) => {
        const isDone = currentTierIdx >= 0 && i <= currentTierIdx;
        const isCurrent = i === nextIndex;
        return `${i > 0 ? `<div class="ladder-connector ${isDone ? "done" : ""}"></div>` : ""}
        <div class="ladder-step ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}">
          <div class="ladder-node">${isDone ? "✓" : i + 1}</div>
          <div class="ladder-label">${escapeHtml(label)}</div>
        </div>`;
      }).join("")}
    </div>
    ${lastRental && (rentalCategory(lastRental) === "Forza 300" || rentalCategory(lastRental) === "XMAX 300") ? `<p class="muted" style="padding:0 6px 10px;font-size:12.5px;">This customer's current bike is already ${rentalCategory(lastRental)} — the 155cc Ride Upgrade ladder doesn't apply to them. See Premium Ride Experience / VIP Extra Day instead.</p>` : ""}
  `;
}

// Simple emoji-forward status, per the "what do I need to know right now" design.
function loyaltyStatusDisplay(s) {
  // Premium Ride Experience / VIP Extra Day run on their own Locked/Ready/Standby/Used
  // cycle rather than the simpler given/eligible states everything else uses. Premium Ride
  // is a standby perk, never a guaranteed booking, so its "reserved" state is worded as a
  // noted preference, not a confirmation — VIP Extra Day keeps its own separate wording.
  if (s.cycleStatus === "used") return { emoji: "✅", text: "Used", cls: "given" };
  if (s.cycleStatus === "reserved") return s.type === "premium_ride"
    ? { emoji: "🕒", text: "Standby — Date Noted", cls: "eligible" }
    : { emoji: "📅", text: "Reserved", cls: "eligible" };
  if (s.cycleStatus === "ready") return { emoji: "🎁", text: s.savedForNextVisit ? "Ready — Saved for Next Visit" : "Ready", cls: "eligible" };
  if (s.cycleStatus === "locked") return { emoji: "—", text: "Locked", cls: "not-yet" };

  // Ride Upgrade has its own Available/Accepted/Used vocabulary — an offer isn't consumed
  // by simply being accepted, only by actually being used.
  if (s.type === "return_privilege" && s.rideUpgradeStatus) {
    if (s.rideUpgradeStatus === "used") return { emoji: "✅", text: "Used", cls: "given" };
    if (s.rideUpgradeStatus === "accepted") return { emoji: "🎁", text: "Accepted", cls: "eligible" };
    if (s.eligible) return { emoji: "🎁", text: "Available", cls: "eligible" };
    return { emoji: "—", text: "Not Eligible Yet", cls: "not-eligible" };
  }

  if (s.reward && s.reward.given) return { emoji: "✅", text: "Given", cls: "given" };
  if (s.isNoCurrentRentalMarker) return { emoji: "—", text: "No Current Rental", cls: "not-yet" };
  if (s.notActive) return { emoji: "—", text: "Not Active", cls: "not-yet" };
  if (s.historical) return { emoji: "—", text: "Historical", cls: "not-yet" };
  if (s.qualifiedPending) return { emoji: "🎁", text: "Still Active — Give at Return", cls: "eligible" };
  if (s.inProgress) return { emoji: "—", text: "Not Eligible Yet", cls: "not-yet" };
  if (s.eligible) {
    if (s.type === "journey_gift") return { emoji: "🎁", text: "Eligible at Return", cls: "eligible" };
    return { emoji: "🎁", text: "Eligible", cls: "eligible" };
  }
  return { emoji: "—", text: "Not Eligible Yet", cls: "not-eligible" };
}

// Picks the single most relevant suggestion for a reward type — the one worth
// surfacing at a glance — while keeping every instance available for "View details".
function primaryForType(suggestions, type) {
  const list = suggestions.filter((s) => s.type === type);
  if (!list.length) return null;
  if (type === "journey_gift") {
    const marker = list.find((s) => s.isNoCurrentRentalMarker);
    const nonMarker = list.filter((s) => !s.isNoCurrentRentalMarker);
    // Historical (pre-loyalty-program) rentals never surface as the headline — they still
    // count toward the relationship, just not as a gift status to act on.
    const real = nonMarker.filter((s) => !s.historical);
    if (real.length === 0) return { primary: marker, all: nonMarker };
    const inProg = real.find((s) => s.inProgress);
    if (inProg) return { primary: inProg, all: nonMarker };
    const dueNow = real.find((s) => s.eligible && !(s.reward && s.reward.given));
    if (dueNow) return { primary: dueNow, all: nonMarker };
    return { primary: real[0], all: nonMarker }; // stats.rentals is newest-first already
  }
  if (type === "return_privilege" || type === "premium_ride" || type === "vip_extra_day") {
    const pending = list[list.length - 1]; // always the current/next cycle entry, pushed last
    const givenEntries = list.filter((s) => s.reward && s.reward.given);
    if (type === "premium_ride" || type === "vip_extra_day") {
      // Cycle-based: show the pending cycle only once it's actually actionable (Ready/
      // Reserved). Otherwise the most recent "Used" record stays the headline (with its own
      // next-cycle progress noted in its reason) rather than flashing "Locked" right after use.
      if (pending && (pending.cycleStatus === "ready" || pending.cycleStatus === "reserved")) {
        return { primary: pending, all: list };
      }
      if (givenEntries.length) return { primary: givenEntries[givenEntries.length - 1], all: list };
      return { primary: pending, all: list };
    }
    if (givenEntries.length) return { primary: givenEntries[givenEntries.length - 1], all: list };
    return { primary: pending, all: list }; // the pending one is pushed last
  }
  return { primary: list[0], all: list }; // welcome_kit — only ever one entry
}

const REWARD_ICON = { welcome_kit: "gift", journey_gift: "pouch", return_privilege: "upgrade", premium_ride: "premiumScooter", vip_extra_day: "vipCalendar" };

// Reference-style reward row: icon badge, title + status pill on one line, a concise
// reason underneath, and one clear action — matches the master reference's "AA Rewards"
// panel. Reuses the exact same data-action wiring as before (no event-wiring changes).
function renderRewardCardV2(customer, s) {
  const given = s.reward && s.reward.given;
  const status = loyaltyStatusDisplay(s);
  const pillClass = status.cls === "given" ? "pill-green" : status.cls === "eligible" ? "pill-orange" : "pill-neutral";
  const hasHistory = s.reward && ((s.reward.history && s.reward.history.length) || s.reward.notes || s.overridden);
  const panelId = "rcard-" + s.key.replace(/[^a-zA-Z0-9]/g, "_");

  let actionHtml = "";
  if (s.type === "premium_ride" || s.type === "vip_extra_day") {
    if (s.cycleStatus === "ready") actionHtml = `<button class="btn btn-outline btn-sm" data-action="reserve-reward" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}">${s.type === "premium_ride" ? "Note Preferred Date" : "Reserve"}</button>`;
    if (s.cycleStatus === "ready" || s.cycleStatus === "reserved") {
      actionHtml += s.type === "premium_ride"
        ? `<button class="btn btn-orange btn-sm" data-action="mark-premium-used" data-key="${s.key}" data-customer="${customer.id}" data-rental="${s.rentalId || ""}">Mark used</button>`
        : `<button class="btn btn-orange btn-sm" data-action="quick-give-use" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}">Mark used</button>`;
    }
    if (s.cycleStatus === "reserved") {
      actionHtml += `<button class="btn btn-ghost btn-sm" data-action="return-to-ready" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}">Return to Ready</button>`;
    }
    if (s.type === "premium_ride" && (s.cycleStatus === "ready" || s.cycleStatus === "reserved") && s.experienceBike) {
      actionHtml += `<button class="btn btn-ghost btn-sm" data-action="send-premium-invite" data-customer="${customer.id}" data-current-bike="${escapeHtml(s.currentBikeRaw || "")}" data-experience-bike="${escapeHtml(s.experienceBike)}">Send Invite</button>`;
    }
  } else if (s.type === "return_privilege" && s.rideUpgradeStatus && s.rideUpgradeStatus !== "used" && s.eligible) {
    if (s.rideUpgradeStatus === "available") actionHtml += `<button class="btn btn-outline btn-sm" data-action="accept-upgrade" data-key="${s.key}" data-customer="${customer.id}" data-rental="${s.rentalId || ""}">Accept Upgrade</button>`;
    actionHtml += `<button class="btn btn-orange btn-sm" data-action="quick-give-use" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}" data-upgrade-target="${s.upgradeTarget || ""}">Mark used</button>`;
    if (s.rideUpgradeStatus === "accepted") {
      actionHtml += `<button class="btn btn-ghost btn-sm" data-action="return-to-ready" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}">Return to Ready</button>`;
    } else {
      actionHtml += `<button class="btn btn-ghost btn-sm" data-action="decline-upgrade" data-key="${s.key}" data-customer="${customer.id}" data-rental="${s.rentalId || ""}">Decline</button>`;
    }
  } else if (!given && !s.inProgress && !s.historical && !s.notActive && !s.isNoCurrentRentalMarker) {
    actionHtml = `<button class="btn btn-orange btn-sm" data-action="quick-give-use" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}" data-upgrade-target="${s.upgradeTarget || ""}">${s.type === "return_privilege" ? "Use" : "Give Gift"}</button>`;
  }

  return `
    <div class="reward-row-v2">
      <div class="reward-row-v2-top">
        ${boldIcon(REWARD_ICON[s.type] || "gift")}
        <div class="reward-row-v2-body">
          <div class="reward-row-v2-titleline">
            <span class="reward-row-v2-title">${escapeHtml(s.title.replace(/^AA Journey Gift — .*/, "AA Journey Gift").replace(/^AA Welcome Gift.*/, "AA Welcome Gift"))}</span>
            <span class="pill ${pillClass}">${escapeHtml(status.text)}</span>
          </div>
          ${s.type === "return_privilege" && s.upgradeTarget ? `<div class="reward-row-v2-upgrade-path">${escapeHtml(s.fromCategory || "")} → <b>${escapeHtml(s.upgradeTarget)}</b></div>` : ""}
          ${s.type === "premium_ride" && s.experienceBike ? `
            <div class="reward-row-v2-upgrade-path">Current Bike: <b>${escapeHtml(s.currentBikeRaw || "—")}</b> → Experience Bike: <b>${escapeHtml(s.experienceBike)}</b></div>
            <div class="reward-row-v2-reason">Duration: 2 Days / 1 Night</div>
          ` : ""}
          <div class="reward-row-v2-reason">${escapeHtml(s.reason)}</div>
          ${s.type === "return_privilege" && s.normalRate ? `
            <div class="reward-row-v2-rate">Loyalty Rate: <b>${fmtMoney(s.loyaltyRate)}/${escapeHtml(s.rateUnit || "month")}</b> <span class="muted">(regular ${fmtMoney(s.normalRate)})</span></div>
          ` : ""}
          ${given ? `<div class="reward-row-v2-rate">Value: <b>${fmtMoney(s.reward.value)}</b>${s.reward.actualCost !== undefined ? ` · Actual Cost: <b>${fmtMoney(s.reward.actualCost)}</b>` : ""}</div>` : ""}
        </div>
      </div>
      ${actionHtml ? `<div class="reward-row-v2-actions">${actionHtml}</div>` : ""}
      ${hasHistory ? `<button class="link-btn" data-toggle="${panelId}" style="font-size:11.5px;margin-top:6px;">Details</button>
        <div class="detail-panel" id="${panelId}" hidden>
          ${s.overridden ? `<div class="loyalty-override-tag">Manually set — system calculated ${s.calculatedEligible ? "Eligible" : "Not eligible"}</div>` : ""}
          ${s.reward && s.reward.notes ? `<div class="reward-note">${escapeHtml(s.reward.notes)}</div>` : ""}
          ${s.reward && s.reward.history && s.reward.history.length ? s.reward.history.slice().reverse().map((h) => `<div class="reward-note" style="margin-bottom:4px;font-size:12px;">${escapeHtml(h.field)}: ${escapeHtml(String(h.previous))} → ${escapeHtml(String(h.new))} · ${h.changedOn}</div>`).join("") : ""}
        </div>` : ""}
      ${given
        ? `<button class="btn btn-outline btn-sm" data-action="reward-override-menu" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}" style="margin-top:8px;">Edit / Override</button>`
        : `<button class="link-btn" data-action="edit-reward-full" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}" style="font-size:11.5px; margin-top:4px;">Edit / override</button>`}
    </div>
  `;
}

function renderRewardDetailRow(customer, s) {
  const given = s.reward && s.reward.given;
  const status = loyaltyStatusDisplay(s);
  const pillClass = status.cls === "given" ? "pill-green" : status.cls === "eligible" ? "pill-orange" : "pill-neutral";
  return `
    <div class="reward-card">
      <div class="reward-head">
        <div>
          <div class="reward-title">${escapeHtml(s.title)}</div>
          <div class="reward-desc">${escapeHtml(s.desc)}</div>
        </div>
        <span class="pill ${pillClass}">${status.emoji} ${escapeHtml(status.text)}</span>
      </div>
      ${s.type === "return_privilege" && s.normalRate ? `
        <div class="reward-meta" style="margin-top:2px;">
          <span>Loyalty Rate: <b>${fmtMoney(s.loyaltyRate)}/${escapeHtml(s.rateUnit || "month")}</b></span>
          <span>Regular Rate: <b>${fmtMoney(s.normalRate)}/${escapeHtml(s.rateUnit || "month")}</b></span>
        </div>
      ` : ""}
      <div class="reward-meta">
        <span>${escapeHtml(s.reason)}</span>
        ${given ? `<span>Given: <b>${fmtDate(s.reward.dateGiven)}</b></span>` : ""}
        ${s.reward && s.reward.value ? `<span>Value: <b>${fmtMoney(s.reward.value)}</b></span>` : ""}
        ${s.lastUsed ? `<span>Last used: <b>${fmtDate(s.lastUsed)}</b></span>` : ""}
      </div>
      ${s.overridden ? `<div class="loyalty-override-tag">Manually set — system calculated ${s.calculatedEligible ? "Eligible" : "Not eligible"}</div>` : ""}
      ${s.reward && s.reward.notes ? `<div class="reward-note">${escapeHtml(s.reward.notes)}</div>` : ""}
      ${s.reward && s.reward.history && s.reward.history.length ? `
        <div class="muted" style="font-size:11.5px;font-weight:600;margin:8px 0 4px;">Change history</div>
        ${s.reward.history.slice().reverse().map((h) => `<div class="reward-note" style="margin-bottom:4px;font-size:12px;">${escapeHtml(h.field)}: ${escapeHtml(String(h.previous))} → ${escapeHtml(String(h.new))} · ${fmtDate(h.changedOn)}</div>`).join("")}
      ` : ""}
      <div class="reward-actions">
        ${s.type === "premium_ride" || s.type === "vip_extra_day" ? `
          ${s.cycleStatus === "ready" ? `<button class="btn btn-outline btn-sm" data-action="reserve-reward" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}">${s.type === "premium_ride" ? "Note Preferred Date" : "Reserve"}</button>` : ""}
          ${s.cycleStatus === "ready" || s.cycleStatus === "reserved" ? (
            s.type === "premium_ride"
              ? `<button class="btn btn-orange btn-sm" data-action="mark-premium-used" data-key="${s.key}" data-customer="${customer.id}" data-rental="${s.rentalId || ""}">Mark used</button>`
              : `<button class="btn btn-orange btn-sm" data-action="quick-give-use" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}">Mark used</button>`
          ) : ""}
        ` : s.type === "return_privilege" && s.rideUpgradeStatus && s.rideUpgradeStatus !== "used" && s.eligible ? `
          ${s.rideUpgradeStatus === "available" ? `<button class="btn btn-outline btn-sm" data-action="accept-upgrade" data-key="${s.key}" data-customer="${customer.id}" data-rental="${s.rentalId || ""}">Accept Upgrade</button>` : ""}
          <button class="btn btn-orange btn-sm" data-action="quick-give-use" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}" data-upgrade-target="${s.upgradeTarget || ""}">Mark used</button>
          <button class="btn btn-ghost btn-sm" data-action="decline-upgrade" data-key="${s.key}" data-customer="${customer.id}" data-rental="${s.rentalId || ""}">Decline</button>
        ` : (!given && !s.inProgress && !s.historical && !s.notActive && !s.isNoCurrentRentalMarker ? `<button class="btn btn-orange btn-sm" data-action="quick-give-use" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}" data-upgrade-target="${s.upgradeTarget || ""}">${s.type === "return_privilege" ? "Use" : "Give"}</button>` : "")}
        <button class="btn btn-ghost btn-sm" data-action="edit-reward-full" data-key="${s.key}" data-customer="${customer.id}" data-type="${s.type}" data-rental="${s.rentalId || ""}">${given ? "Edit / Undo" : "Edit / override"}</button>
      </div>
    </div>
  `;
}

function renderLoyaltyCard(customer, stats, primary, all) {
  const status = loyaltyStatusDisplay(primary);
  const panelId = "detail-" + primary.key.replace(/[^a-zA-Z0-9]/g, "_");
  const headlineSub = primary.type === "return_privilege" && primary.eligible && !(primary.reward && primary.reward.given) && primary.upgradeTarget
    ? `Recommended upgrade: ${primary.upgradeTarget}`
    : primary.reason;
  const showRatesOnHeadline = primary.type === "return_privilege" && primary.eligible && !(primary.reward && primary.reward.given) && primary.normalRate;
  const badgeClass = status.cls === "given" ? "done" : status.cls === "eligible" ? "" : "neutral";

  return `
    <div class="loyalty-card">
      <div class="loyalty-head" style="align-items:flex-start;">
        <div style="display:flex; gap:12px; align-items:center;">
          ${icon(REWARD_ICON[primary.type] || "gift", badgeClass)}
          <div class="loyalty-name">${escapeHtml(REWARD_LABELS[primary.type])}</div>
        </div>
        <div class="loyalty-status ${status.cls}">${status.emoji} ${escapeHtml(status.text)}</div>
      </div>
      <div class="loyalty-sub">${escapeHtml(headlineSub)}</div>
      ${showRatesOnHeadline ? `
        <div class="status-line" style="margin-top:8px;">
          <span>Loyalty Rate: <b>${fmtMoney(primary.loyaltyRate)}/${escapeHtml(primary.rateUnit || "month")}</b></span>
          <span>Regular: <b>${fmtMoney(primary.normalRate)}/${escapeHtml(primary.rateUnit || "month")}</b></span>
        </div>
      ` : ""}
      ${primary.overridden ? `<span class="loyalty-override-tag">Manually set — system calculated ${primary.calculatedEligible ? "Eligible" : "Not eligible"}</span>` : ""}
      <button class="link-btn" data-toggle="${panelId}">View details</button>
      <div class="detail-panel" id="${panelId}" hidden>
        ${primary.type === "return_privilege" ? `<div class="card" style="padding-top:4px;margin-bottom:10px;">${renderLadder(customer, stats)}</div>` : ""}
        ${all.map((s) => renderRewardDetailRow(customer, s)).join("")}
      </div>
    </div>
  `;
}

function renderLoyaltySection(c, stats, suggestions) {
  const wk = primaryForType(suggestions, "welcome_kit");
  const jg = primaryForType(suggestions, "journey_gift");
  const rp = primaryForType(suggestions, "return_privilege");
  const pr = primaryForType(suggestions, "premium_ride");
  const vip = primaryForType(suggestions, "vip_extra_day");

  // Premium Ride Experience and VIP Extra Day are both now universal, dynamic benefits —
  // shown on every profile (even while Locked, so progress toward qualifying is visible),
  // not gated to a pre-selected group of customers.

  // Return Privilege has two alternative paths — a bigger bike (Ride Upgrade) or staying
  // on the same preferred bike/category (VIP Extra Day). When a customer genuinely
  // qualifies for BOTH at once, surface that as an explicit choice rather than letting
  // one silently take precedence — staff picks, nothing is ever auto-given.
  const rpPending = rp && rp.all.find((s) => s.type === "return_privilege" && s.upgradeTarget && s.eligible && !(s.reward && s.reward.given));
  const vipPending = vip && vip.all.find((s) => s.type === "vip_extra_day" && (s.cycleStatus === "ready" || s.cycleStatus === "reserved"));
  const showChoice = !!(rpPending && vipPending);

  return `
    <div class="rewards-panel">
      <div class="rewards-panel-title">AA Rewards</div>
      ${showChoice ? `
        <div class="reward-choice-card">
          <div class="reward-choice-title">Choose Return Privilege</div>
          <div class="reward-choice-sub">This customer qualifies for both — offer one, not both. See the matching cards below to act.</div>
          <div class="reward-choice-options">
            <div class="reward-choice-option">⬆ Ride Upgrade<span>${escapeHtml(rpPending.upgradeTarget)}</span></div>
            <div class="reward-choice-or">OR</div>
            <div class="reward-choice-option">+1 VIP Extra Day on Us<span>Same bike, one more day</span></div>
          </div>
        </div>
      ` : ""}
      ${wk ? renderRewardCardV2(c, wk.primary) : ""}
      ${jg ? renderRewardCardV2(c, jg.primary) : ""}
      ${rp ? renderRewardCardV2(c, rp.primary) : ""}
      ${pr ? renderRewardCardV2(c, pr.primary) : ""}
      ${vip ? renderRewardCardV2(c, vip.primary) : ""}
    </div>
  `;
}

function renderRentalCard(r) {
  // bikeModel is the internal loyalty-tier bucket (drives Journey Gift thresholds/Ride
  // Upgrade ladder); bikeNameRaw (when present, i.e. imported historical rentals) is the
  // actual bike as recorded in the source spreadsheet — always show that if we have it.
  const displayBike = r.bikeNameRaw || r.bikeModel;
  return `
    <div class="card">
      <div class="card-row">
        <div>
          <div style="font-weight:700;">${escapeHtml(displayBike)}</div>
          ${r.plate ? `<div class="muted mono">${escapeHtml(r.plate)}</div>` : ""}
        </div>
        <span class="pill ${r.status === "active" ? "pill-orange" : "pill-neutral"}">${r.status === "active" ? "Active" : "Completed"}</span>
      </div>
      <div class="divider"></div>
      <div class="grid-2">
        <div><div class="muted">Start (handover)</div><div class="mono">${fmtDate(r.startDate)}</div></div>
        <div><div class="muted">End (return)</div><div class="mono">${fmtDate(r.endDate)}</div></div>
        <div><div class="muted">Booked days</div><div class="mono">${r.bookedDays ?? "—"}</div></div>
        <div><div class="muted">Actual paid days</div><div class="mono">${r.paidDays}</div></div>
        <div><div class="muted">Revenue</div><div class="mono">${fmtMoney(r.revenue)}</div></div>
      </div>
      ${r.bikeHistory && r.bikeHistory.length > 1 ? `<div class="reward-note" style="margin-top:10px;">Bike changed during this rental: ${r.bikeHistory.map(escapeHtml).join(" → ")}</div>` : ""}
      ${r.sourceRows && r.sourceRows.length ? `<div class="muted" style="font-size:11.5px;margin-top:8px;">Source: ${r.sourceRows.map(escapeHtml).join(", ")}</div>` : ""}
      <div class="btn-row" style="margin-top:12px;">
        ${r.status === "active" ? `<button class="btn btn-outline btn-sm" data-action="complete-rental" data-id="${r.id}">Mark returned</button>` : ""}
        <button class="btn btn-ghost btn-sm" data-action="edit-rental" data-id="${r.id}">Edit rental</button>
      </div>
    </div>
  `;
}

// Compact "Customer Value" section — Lifetime Revenue, Reward Value Given, Actual Gift
// Cost, Reward-to-Revenue ratio, and a Loyalty Health status, with a link into the full
// Reward History for this customer. Read-only summary; all editing happens there.
function renderCustomerValueCard(c, stats) {
  const fin = customerFinancialSummary(c, stats);
  return `
    <div class="card" style="margin-bottom:14px;">
      <div class="section-label" style="margin-top:0;">Customer Value</div>
      <div class="grid-2" style="margin-bottom:10px;">
        <div><div class="muted" style="font-size:11.5px;">2026 Revenue</div><div style="font-weight:700;">${fmtMoney(fin.lifetimeRevenue)}</div></div>
        <div><div class="muted" style="font-size:11.5px;">Reward Value Given</div><div style="font-weight:700;">${fmtMoney(fin.totalRewardValue)}</div></div>
        <div><div class="muted" style="font-size:11.5px;">Actual Gift Cost</div><div style="font-weight:700;">${fmtMoney(fin.actualGiftCost)}</div></div>
        <div><div class="muted" style="font-size:11.5px;">Reward-to-Revenue</div><div style="font-weight:700;">${fin.ratioPct.toFixed(1)}%</div></div>
      </div>
      <span class="pill ${fin.health.cls === "green" ? "pill-green" : fin.health.cls === "amber" ? "pill-amber" : "pill-red"}">${fin.health.emoji} ${escapeHtml(fin.health.label)}</span>
      <button class="link-btn" data-action="view-reward-history" data-id="${c.id}" style="display:block;margin-top:10px;">View Reward History</button>
    </div>
  `;
}

function renderCustomerDetail() {
  const c = DB.data.customers.find((x) => x.id === state.customerId);
  if (!c) { navigate("customers"); return ""; }
  const stats = customerStats(c);
  const suggestions = getSuggestions(c, stats);
  // Current Bike = the raw bike name from the customer's latest active/ongoing rental row
  // only — never the standardized loyalty-tier category, never a fallback from Ride
  // Upgrade or any other field. If there's no active rental, this is the raw name from
  // their most recent past rental (still the actual bike, never a derived category).
  const latestBike = stats.current ? (stats.current.bikeNameRaw || stats.current.bikeModel) : (stats.rentals[0] ? (stats.rentals[0].bikeNameRaw || stats.rentals[0].bikeModel) : null);
  const custStatus = computeCustomerStatus(c, stats);
  const pendingBoundaries = DB.data.needsReview.filter((r) => !r.resolved && r.type === "rental_boundary" && r.customerId === c.id).length;

  return `
    <div class="profile-dark-header">
      <div class="profile-topbar">
        <button class="brand-topbar-icon" data-goto="customers" aria-label="Back">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div class="profile-topbar-title">Customer Profile</div>
        <button class="brand-topbar-icon" data-action="edit-customer" data-id="${c.id}" aria-label="Edit">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>
        </button>
      </div>
      <div class="profile-id-row">
        <div class="profile-avatar">${initials(c.name)}</div>
        <div class="profile-id-main">
          <div class="profile-name">${escapeHtml(c.name)}</div>
          <span class="profile-status-badge">${escapeHtml(custStatus.label)}</span>
          ${custStatus.detail ? `<div class="profile-rental-line"><span class="ongoing-dot-inline ${stats.current ? "" : "done"}"></span>${escapeHtml(custStatus.detail)} • ${stats.current ? "Ongoing" : "Completed"}</div>` : ""}
        </div>
      </div>
      <div class="profile-stat-strip">
        <div class="profile-stat">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#FFC107" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/></svg>
          <div class="profile-stat-label">Total Time<br/>with AA</div>
          <div class="profile-stat-value">${stats.paidRentalDays} <span>days</span></div>
        </div>
        <div class="profile-stat">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#FFC107" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17V12l3-3h4l3 5h3"/></svg>
          <div class="profile-stat-label">Current<br/>Bike</div>
          <div class="profile-stat-value" style="font-size:12.5px;">${latestBike ? escapeHtml(latestBike) : "—"}</div>
        </div>
        <div class="profile-stat">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#FFC107" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5z"/></svg>
          <div class="profile-stat-label">Customer<br/>Since</div>
          <div class="profile-stat-value" style="font-size:12.5px;">${fmtDate(c.firstSeen)}</div>
        </div>
      </div>
    </div>
    <div class="screen-body" style="margin-top:-14px;">

      ${pendingBoundaries > 0 ? `<div class="alert-strip amber" data-goto="needs-review" style="margin-bottom:10px;cursor:pointer;"><span class="dot dot-amber"></span>${pendingBoundaries} rental date${pendingBoundaries > 1 ? "s" : ""} for this customer need${pendingBoundaries > 1 ? "" : "s"} review</div>` : ""}

      ${renderLoyaltySection(c, stats, suggestions)}

      ${renderCustomerValueCard(c, stats)}

      <button class="link-btn" data-toggle="rental-history-panel" style="margin-top:10px;">View details</button>
      <div class="detail-panel" id="rental-history-panel" hidden>
        <div class="section-label">Rental &amp; revenue summary</div>
        <div class="stat-grid">
          <div class="stat-tile"><span class="stat-value">${stats.rentalCount}</span><span class="stat-label">Rental Visits</span></div>
          <div class="stat-tile"><span class="stat-value">${stats.qualifiedRentalCount}</span><span class="stat-label">Qualified Rentals</span></div>
          <div class="stat-tile"><span class="stat-value">${fmtMoney(stats.totalRevenue)}</span><span class="stat-label">Lifetime Rental Revenue</span></div>
          <div class="stat-tile"><span class="stat-value">${stats.paidRentalDays}</span><span class="stat-label">Total Paid Days</span></div>
        </div>
        <div class="reward-note" style="margin-top:10px;">
          A Rental Visit is any genuine rental after a previous one ended — it always counts toward this customer's history, however short. A <b>Qualified Rental</b> is one substantial enough (by paid days or paid value for its bike class) to count toward Ride Upgrade progression. Ride Upgrade needs ${RETURN_PRIVILEGE_MIN_QUALIFIED_RENTALS}+ Qualified Rentals <i>and</i> ${fmtMoney(RETURN_PRIVILEGE_MIN_REVENUE)}+ lifetime revenue — Long-Term/VIP status is calculated separately and doesn't require either.
        </div>
        ${c.mergedNames && c.mergedNames.length ? `<div class="reward-note" style="margin-top:10px;">Also on file as: ${c.mergedNames.map(escapeHtml).join(", ")}</div>` : ""}
        ${c.nationality ? `<div class="muted" style="margin-top:8px;">Nationality: ${escapeHtml(c.nationality)}${c.passport ? " · Passport: " + escapeHtml(c.passport) : ""}</div>` : ""}
        <div class="section-label">Rental history</div>
        <div class="btn-row" style="margin-bottom:12px;">
          <button class="btn btn-ghost btn-sm" data-action="log-rental" data-id="${c.id}">+ Log rental</button>
        </div>
        ${stats.rentals.length ? stats.rentals.map((r) => renderRentalCard(r)).join("") : `<p class="muted">No rentals logged yet.</p>`}
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* RENDER — VEHICLES                                                       */
/* ---------------------------------------------------------------------- */

function renewalEmoji(level) {
  if (level === "red") return "🔴";
  if (level === "amber" || level === "unset") return "🟠";
  return "🟢";
}
function renewalStatusText(info) {
  if (info.level === "unset") return "Not set";
  if (info.level === "green") return "OK";
  return info.label; // amber: "Due in Xd"; red: "Overdue by Xd"
}

function renderVehicleRow(v, st) {
  const worstLevel = st.tax.level === "red" || st.prb.level === "red" ? "alert" : (st.tax.level !== "green" || st.prb.level !== "green") ? "" : "done";
  return `
    <div class="compact-row" data-goto="vehicle" data-id="${v.id}">
      ${icon("document", worstLevel)}
      <div class="compact-row-main">
        <div class="compact-row-title">${escapeHtml(v.bikeName)}</div>
        <div class="compact-row-sub mono">${escapeHtml(v.plate)}</div>
        <div class="status-line" style="margin-top:6px;">
          <span>Tax ${renewalEmoji(st.tax.level)} ${escapeHtml(renewalStatusText(st.tax))}</span>
          <span>Por Ror Bor ${renewalEmoji(st.prb.level)} ${escapeHtml(renewalStatusText(st.prb))}</span>
        </div>
      </div>
      <span class="chev">${ICONS.chevronRight}</span>
    </div>`;
}

/* ---------------------------------------------------------------------- */
/* RENDER — REWARD HISTORY (search a customer, see everything: given,      */
/* available, pending — with full edit access via the existing sheets)     */
/* ---------------------------------------------------------------------- */

function renderRewardHistoryScreen() {
  if (state.rewardHistoryCustomerId) {
    const c = DB.data.customers.find((x) => x.id === state.rewardHistoryCustomerId);
    if (!c) { state.rewardHistoryCustomerId = null; return renderRewardHistoryScreen(); }
    const stats = customerStats(c);
    const suggestions = getSuggestions(c, stats);
    const byType = ["welcome_kit", "journey_gift", "return_privilege", "premium_ride", "vip_extra_day"];
    const filter = state.rewardHistoryFilter || "all";
    const filterTabs = [["all", "All"], ["used", "Used"], ["available", "Available"], ["archived", "Archived"],
      ["welcome_kit", "Welcome Gift"], ["return_privilege", "Ride Upgrade"], ["vip_extra_day", "VIP Extra Day"],
      ["premium_ride", "Premium Ride"], ["journey_gift", "Journey Gift"]];
    // "Used" and "Archived" both mean the same thing here — a completed, permanently
    // preserved past cycle — since this app never deletes a reward once given.
    const matchesFilter = (s) => {
      const isGiven = !!(s.reward && s.reward.given);
      if (filter === "all") return true;
      if (filter === "used" || filter === "archived") return isGiven;
      if (filter === "available") return !isGiven && (s.eligible || s.qualifiedPending);
      return s.type === filter;
    };
    return `
      <header class="screen-header">
        <button class="back-btn" data-action="reward-history-back">‹ Reward History</button>
        <h1 class="screen-title" style="margin-top:8px;">${escapeHtml(c.name)}</h1>
        <p class="screen-sub">Every reward on record — given, available, and pending</p>
      </header>
      <div class="screen-body">
        ${renderCustomerValueCard(c, stats)}
        <div class="period-tabs" style="margin-bottom:6px;">
          ${filterTabs.map(([id, label]) => `<button class="period-tab ${filter === id ? "active" : ""}" data-action="set-reward-history-filter" data-filter="${id}">${escapeHtml(label)}</button>`).join("")}
        </div>
        ${byType.map((type) => {
          const items = suggestions.filter((s) => s.type === type && !s.isNoCurrentRentalMarker && matchesFilter(s));
          if (!items.length) return "";
          return `<div class="section-label">${escapeHtml(REWARD_LABELS[type])}</div>${items.map((s) => renderRewardCardV2(c, s)).join("")}`;
        }).join("")}
      </div>
    `;
  }

  const q = state.rewardHistorySearch.trim().toLowerCase();
  const list = q ? DB.data.customers.filter((c) =>
    c.name.toLowerCase().includes(q) || (c.phone || "").toLowerCase().includes(q) || (c.passport || "").toLowerCase().includes(q)
  ).sort((a, b) => a.name.localeCompare(b.name)) : [];

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="customers">‹ Customer Loyalty</button>
      <h1 class="screen-title" style="margin-top:8px;">Reward History</h1>
      <p class="screen-sub">Search a customer to see every reward — given, available, or pending</p>
      <div class="home-search-wrap" style="margin-top:14px;">
        <span class="search-icon">${boldIcon("search")}</span>
        <input id="reward-history-search" type="search" inputmode="search" placeholder="Search by name, phone, or passport…" value="${escapeHtml(state.rewardHistorySearch)}" autocomplete="off" />
      </div>
    </header>
    <div class="screen-body">
      ${!q ? renderRecentlyGivenList()
        : list.length === 0 ? `<div class="empty"><div class="empty-icon">${boldIcon("search")}</div><h3>No matches</h3><p>Try a different name, phone number, or passport.</p></div>`
        : `<div class="cust-row-list">${list.map((c) => `
            <div class="cust-row" data-action="open-reward-history" data-id="${c.id}">
              <div class="cust-row-main"><div class="cust-row-name">${escapeHtml(c.name)}</div></div>
              <span class="cust-row-chevron">${ICONS.chevronRight}</span>
            </div>
          `).join("")}</div>`}
    </div>
  `;
}

// "Who did I just give a reward to?" — without this, the only way to find a customer again
// after giving them a reward is to remember and re-type their exact name. This lists the
// most recently given rewards (any type, any customer), most recent first, each one tapping
// straight into that customer's full history — the direct answer to that question.
function renderRecentlyGivenList() {
  // Recently Given = currently active USED/GIVEN rewards only. A reversed reward drops out
  // of this list automatically (given flips back to false) — it's not deleted, just no
  // longer an active "given" transaction; it's still fully visible in that customer's full
  // Reward History (the complete ledger, reversals included).
  const recent = DB.data.rewards
    .filter((r) => r.given)
    .sort((a, b) => (b.givenAt || b.dateGiven || "").localeCompare(a.givenAt || a.dateGiven || ""))
    .slice(0, 15);

  if (recent.length === 0) {
    return `<div class="empty"><div class="empty-icon">${boldIcon("gift")}</div><h3>Search for a customer</h3><p>Their full reward history, current value, and edit access will show up here. No rewards have been given yet.</p></div>`;
  }

  return `
    <div class="section-label" style="margin-top:0;">Recently Given</div>
    <div class="cust-row-list">
      ${recent.map((rw) => {
        const c = DB.data.customers.find((x) => x.id === rw.customerId);
        if (!c) return "";
        return `
          <div class="cust-row" data-action="open-reward-transaction" data-key="${rw.key}">
            <div class="cust-row-main">
              <div class="cust-row-name">${escapeHtml(c.name)}</div>
              <div class="cust-row-reward">
                ${boldIcon(REWARD_ICON[rw.type] || "gift", "row")}
                <span class="cust-row-reward-type">${escapeHtml(REWARD_LABELS[rw.type] || rw.type)}</span>
                <span class="cust-row-reward-detail"> · ${fmtDate(rw.dateGiven)}${rw.value ? " · " + fmtMoney(rw.value) : ""}</span>
              </div>
            </div>
            <span class="cust-row-chevron">${ICONS.chevronRight}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// The reward transaction detail sheet — opened from "Recently Given" (or anywhere else a
// specific reward key needs a closer look). Shows the full timeline and current status
// (Used or, if it's since been undone, Reversed — never silently treated as if nothing
// happened), and links both ways: to the customer's profile, and into Edit / Override.
function sheetRewardTransaction(key) {
  const rw = findReward(key);
  if (!rw) return;
  const customer = DB.data.customers.find((c) => c.id === rw.customerId);
  const wasReversed = !rw.given && rw.history && rw.history.some((h) => h.field === "Use Reversed");
  const statusLabel = rw.given ? "USED" : wasReversed ? "REVERSED" : "READY";
  const statusCls = rw.given ? "pill-green" : wasReversed ? "pill-neutral" : "pill-orange";

  openSheet(`
    <div class="sheet-title">${escapeHtml(REWARD_LABELS[rw.type] || rw.type)}</div>
    <div class="sheet-sub">${escapeHtml(customer ? customer.name : "Unknown customer")}</div>
    <span class="pill ${statusCls}" style="margin-bottom:12px; display:inline-block;">${statusLabel}</span>
    ${rw.given ? `<div class="reward-note">Used ${fmtDate(rw.dateGiven)}${rw.value ? " · " + fmtMoney(rw.value) : ""}${rw.bikeUsed ? " · " + escapeHtml(rw.bikeUsed) : ""}</div>` : ""}
    <div class="section-label" style="margin-top:14px;">Timeline</div>
    ${rw.history && rw.history.length ? rw.history.map((h) => `
      <div class="reward-note" style="margin-bottom:6px;">
        <b>${escapeHtml(h.field)}</b><br/>${escapeHtml(String(h.previous))} → ${escapeHtml(String(h.new))}<br/><span class="muted">${escapeHtml(h.changedOn)}</span>
      </div>
    `).join("") : `<p class="muted">No recorded events yet.</p>`}
    ${rw.notes ? `<div class="section-label">Staff Note</div><div class="reward-note">${escapeHtml(rw.notes)}</div>` : ""}
    <div class="btn-row" style="margin-top:16px;">
      ${customer ? `<button class="btn btn-outline btn-block" id="txn-view-customer">View Customer</button>` : ""}
    </div>
    <div class="btn-row" style="margin-top:8px;">
      ${rw.given ? `<button class="btn btn-primary btn-block" id="txn-edit-override">Edit / Override</button>` : ""}
    </div>
  `);
  if (customer) {
    document.getElementById("txn-view-customer").addEventListener("click", () => {
      closeSheet();
      navigate("customer", { customerId: customer.id });
    });
  }
  const editBtn = document.getElementById("txn-edit-override");
  if (editBtn) editBtn.addEventListener("click", () => {
    closeSheet();
    sheetRewardActionMenu(rw.key, rw.customerId, rw.type, rw.rentalId);
  });
}

/* ---------------------------------------------------------------------- */
/* RENDER — LOYALTY REPORTS (This Month / Last Month / This Year /         */
/* Lifetime — Customer Loyalty only, never touches Vehicle Renewal)        */
/* ---------------------------------------------------------------------- */

function reportsDateRange(period) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  if (period === "month") return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
  if (period === "lastMonth") return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
  if (period === "year") return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
  return { start: new Date(2000, 0, 1), end: new Date(2100, 0, 1) }; // lifetime
}

function renderLoyaltyReportsScreen() {
  const periods = [["month", "This Month"], ["lastMonth", "Last Month"], ["year", "This Year"], ["lifetime", "Lifetime"]];
  const { start, end } = reportsDateRange(state.reportsPeriod);
  const inRange = (iso) => { if (!iso) return false; const d = new Date(iso + "T00:00:00"); return d >= start && d < end; };

  const givenInRange = DB.data.rewards.filter((r) => r.given && inRange(r.dateGiven));
  const countByType = (t) => givenInRange.filter((r) => r.type === t).length;
  const actualCost = givenInRange.reduce((s, r) => s + (Number(r.actualCost ?? r.value) || 0), 0);
  const estValue = givenInRange.reduce((s, r) => s + (Number(r.value) || 0), 0);

  // Rewards Outstanding — eligible now, not yet given, across every customer (not period-filtered,
  // since this is a live "what's waiting on staff right now" figure).
  let outstanding = 0;
  const loyaltyCustomerIds = new Set(DB.data.rewards.filter((r) => r.given).map((r) => r.customerId));
  DB.data.customers.forEach((c) => {
    const stats = customerStats(c);
    const sugg = getSuggestions(c, stats);
    outstanding += sugg.filter((s) => s.eligible && !(s.reward && s.reward.given) && !s.isNoCurrentRentalMarker).length;
  });
  const loyaltyRevenue = [...loyaltyCustomerIds].reduce((s, id) => {
    const cust = DB.data.customers.find((c) => c.id === id);
    return cust ? s + customerStats(cust).totalRevenue : s;
  }, 0);
  const overallRatio = loyaltyRevenue > 0 ? (estValue / loyaltyRevenue) * 100 : 0;

  const tile = (label, value) => `<div class="report-tile"><div class="report-tile-value">${value}</div><div class="report-tile-label">${escapeHtml(label)}</div></div>`;

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="customers">‹ Customer Loyalty</button>
      <h1 class="screen-title" style="margin-top:8px;">Loyalty Reports</h1>
      <p class="screen-sub">Customer Loyalty only — separate from Vehicle Renewal</p>
    </header>
    <div class="screen-body">
      <div class="period-tabs">
        ${periods.map(([id, label]) => `<button class="period-tab ${state.reportsPeriod === id ? "active" : ""}" data-action="set-reports-period" data-period="${id}">${label}</button>`).join("")}
      </div>
      <div class="report-grid">
        ${tile("Welcome Gifts Given", countByType("welcome_kit"))}
        ${tile("Journey Gifts Given", countByType("journey_gift"))}
        ${tile("Ride Upgrades Used", countByType("return_privilege"))}
        ${tile("VIP Extra Days Used", countByType("vip_extra_day"))}
        ${tile("Premium Rides Used", countByType("premium_ride"))}
        ${tile("Rewards Outstanding", outstanding)}
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label" style="margin-top:0;">Loyalty Value</div>
        <div class="grid-2">
          <div><div class="muted" style="font-size:11.5px;">Actual Gift Cost</div><div style="font-weight:700;">${fmtMoney(actualCost)}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Estimated Complimentary Value</div><div style="font-weight:700;">${fmtMoney(estValue)}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Total Loyalty Value Given</div><div style="font-weight:700;">${fmtMoney(estValue)}</div></div>
          <div><div class="muted" style="font-size:11.5px;">Overall Reward-to-Revenue</div><div style="font-weight:700;">${overallRatio.toFixed(1)}%</div></div>
        </div>
        <div class="reward-note" style="margin-top:10px;">Revenue from loyalty customers (lifetime, all customers who have ever received a reward): ${fmtMoney(loyaltyRevenue)}.</div>
      </div>
    </div>
  `;
}

function renderVehiclesList() {
  const withStatus = DB.data.vehicles.map((v) => ({ v, st: vehicleStatus(v) }));
  const needsAttention = withStatus.filter((x) => x.st.tax.level !== "green" || x.st.prb.level !== "green");
  const allOk = withStatus.filter((x) => x.st.tax.level === "green" && x.st.prb.level === "green");

  needsAttention.sort((a, b) => {
    const ra = Math.min(RENEWAL_LEVEL_RANK[a.st.tax.level], RENEWAL_LEVEL_RANK[a.st.prb.level]);
    const rb = Math.min(RENEWAL_LEVEL_RANK[b.st.tax.level], RENEWAL_LEVEL_RANK[b.st.prb.level]);
    return ra - rb;
  });

  // Presentation-only grouping for the top summary strip — same underlying
  // vehicleStatus() computation, just tallied into three buckets for the headline.
  const expiredCount = withStatus.filter((x) => x.st.tax.level === "red" || x.st.prb.level === "red").length;
  const dueSoonCount = needsAttention.length - expiredCount;
  const okCount = allOk.length;

  return `
    <header class="screen-header">
      <div style="display:flex; align-items:center; gap:10px;">
        <button class="app-logo-btn" data-goto="home" aria-label="AA Scooter home">${ICONS.logoMark}</button>
        <span class="eyebrow">AA Scooter Rental · Chiang Mai</span>
      </div>
      <h1 class="screen-title" style="margin-top:6px;">Vehicle Renewal</h1>
      <p class="screen-sub">${DB.data.vehicles.length} vehicle(s) tracked</p>
    </header>
    <div class="screen-body">
      <div class="vehicle-summary-strip">
        <div class="vehicle-summary-tile red">
          <div class="vehicle-summary-count">${expiredCount}</div>
          <div class="vehicle-summary-label">Needs Attention</div>
        </div>
        <div class="vehicle-summary-tile amber">
          <div class="vehicle-summary-count">${dueSoonCount}</div>
          <div class="vehicle-summary-label">Due Soon</div>
        </div>
        <div class="vehicle-summary-tile green">
          <div class="vehicle-summary-count">${okCount}</div>
          <div class="vehicle-summary-label">All OK</div>
        </div>
      </div>

      ${DB.data.vehicles.length === 0 ? `
        <div class="empty">
          <div class="empty-icon">${ICONS.document}</div>
          <h3>No vehicles yet</h3>
          <p>Add your fleet to start tracking renewals.</p>
        </div>
      ` : `
        ${needsAttention.length > 0 ? `
          <div class="attention-header">Needs Attention <span class="attention-badge">${needsAttention.length}</span></div>
          ${needsAttention.map((x) => renderVehicleRow(x.v, x.st)).join("")}
        ` : `<div class="card"><p class="muted">Nothing needs attention — every Tax and Por Ror Bor date is more than 30 days out.</p></div>`}

        ${allOk.length > 0 ? `
          <div class="collapsed-header" data-toggle="all-other-vehicles">
            <span>All Other Vehicles (${allOk.length})</span>
            <span class="toggle-arrow">▾</span>
          </div>
          <div class="detail-panel" id="all-other-vehicles" hidden>
            ${allOk.map((x) => renderVehicleRow(x.v, x.st)).join("")}
          </div>
        ` : ""}
      `}
    </div>
    <button class="fab" id="add-vehicle-fab" aria-label="Add vehicle">+</button>
  `;
}

function renderVehicleDetail() {
  const v = DB.data.vehicles.find((x) => x.id === state.vehicleId);
  if (!v) { navigate("vehicles"); return ""; }
  const st = vehicleStatus(v);
  const taxHistory = (v.taxHistory || []).slice().sort((a, b) => (a.renewedOn < b.renewedOn ? 1 : -1));
  const prbHistory = (v.porRorBorHistory || []).slice().sort((a, b) => (a.renewedOn < b.renewedOn ? 1 : -1));
  const taxBtnLabel = (v.taxExpiryDate || v.taxOverduePending) ? "Renew Tax" : "Set Tax expiry";

  return `
    <header class="screen-header">
      <div class="card-row">
        <button class="back-btn" data-goto="vehicles">‹ Vehicle Renewal</button>
        <button class="btn btn-outline btn-sm" data-action="edit-vehicle" data-id="${v.id}">Edit</button>
      </div>
      <h1 class="screen-title" style="margin-top:8px;">${escapeHtml(v.bikeName)}</h1>
      <p class="screen-sub mono">${escapeHtml(v.plate)}${v.modelYear ? " · " + escapeHtml(String(v.modelYear)) : ""}</p>
    </header>
    <div class="screen-body">

      <div class="hero-card">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;">
          <span style="font-weight:600;color:var(--text-secondary);">Tax</span>
          <span style="font-weight:700;font-size:15px;">${renewalEmoji(st.tax.level)} ${escapeHtml(renewalStatusText(st.tax))}</span>
        </div>
        ${st.tax.pending && v.renewalNote ? `<div class="muted" style="font-size:13px;padding:0 0 6px;">Reason: ${escapeHtml(v.renewalNote)}</div>` : ""}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--line);">
          <span style="font-weight:600;color:var(--text-secondary);">Por Ror Bor</span>
          <span style="font-weight:700;font-size:15px;">${renewalEmoji(st.prb.level)} ${escapeHtml(renewalStatusText(st.prb))}</span>
        </div>
        <div class="btn-row" style="margin-top:16px;">
          <button class="btn btn-orange btn-sm" data-action="renew-doc" data-id="${v.id}" data-doc="tax">${taxBtnLabel}</button>
          <button class="btn btn-orange btn-sm" data-action="renew-doc" data-id="${v.id}" data-doc="prb">${v.porRorBorExpiryDate ? "Renew Por Ror Bor" : "Set Por Ror Bor expiry"}</button>
        </div>
      </div>

      <button class="link-btn" data-toggle="vehicle-details-panel" style="margin-top:10px;">View details</button>
      <div class="detail-panel" id="vehicle-details-panel" hidden>

        <div class="section-label">Tax</div>
        <div class="card">
          ${st.tax.pending
            ? `<div><span class="pill pill-red">Overdue — Renewal Pending</span></div>
               <div class="muted" style="margin-top:8px;">${v.renewalNote ? escapeHtml(v.renewalNote) : "No reason noted yet — add one via Edit."}</div>`
            : `<div><span class="mono" style="font-size:16px;font-weight:600;">${fmtDate(v.taxExpiryDate)}</span><span class="muted" style="margin-left:8px;">expiry date</span></div>`
          }
          ${taxHistory.length ? `
            <div class="divider"></div>
            <div class="muted" style="font-size:12px;font-weight:600;margin-bottom:8px;">Renewal history</div>
            ${taxHistory.map((h) => `<div class="reward-note" style="margin-bottom:6px;">Previously ${escapeHtml(h.previousExpiry)} · renewed ${fmtDate(h.renewedOn)}${h.note ? " · " + escapeHtml(h.note) : ""}</div>`).join("")}
          ` : ""}
        </div>

        <div class="section-label">Por Ror Bor</div>
        <div class="card">
          <div><span class="mono" style="font-size:16px;font-weight:600;">${fmtDate(v.porRorBorExpiryDate)}</span><span class="muted" style="margin-left:8px;">expiry date</span></div>
          ${prbHistory.length ? `
            <div class="divider"></div>
            <div class="muted" style="font-size:12px;font-weight:600;margin-bottom:8px;">Renewal history</div>
            ${prbHistory.map((h) => `<div class="reward-note" style="margin-bottom:6px;">Previously ${escapeHtml(h.previousExpiry)} · renewed ${fmtDate(h.renewedOn)}${h.note ? " · " + escapeHtml(h.note) : ""}</div>`).join("")}
          ` : ""}
        </div>

        <div class="section-label">Service &amp; operations</div>
        <div class="stat-grid">
          <div class="stat-tile"><span class="stat-value">${(Number(v.currentKm) || 0).toLocaleString()}</span><span class="stat-label">Current km</span></div>
          <div class="stat-tile"><span class="stat-value">${(Number(v.nextServiceKm) || 0).toLocaleString()}</span><span class="stat-label">Next service km</span></div>
        </div>
        ${st.service.level !== "green" ? `<div class="alert-strip ${st.service.level}" style="margin-top:10px;"><span class="dot dot-${st.service.level}"></span>${st.service.level === "red" ? `${Math.abs(st.service.kmLeft)}km past service` : `Service due in ${st.service.kmLeft}km`}</div>` : ""}

        <div class="card" style="margin-top:12px;">
          <span class="pill pill-neutral" style="text-transform:capitalize;">${escapeHtml(v.status)}</span>
          ${v.notes ? `<div class="reward-note" style="margin-top:12px;">${escapeHtml(v.notes)}</div>` : ""}
        </div>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* NEEDS REVIEW — historical ambiguity from the CSV import, resolved one   */
/* decision at a time. Decisions are permanent once made.                  */
/* ---------------------------------------------------------------------- */

// Merges can extend a rental's end date over time, so matching on start date alone is the
// reliable way to relocate the record a review item originally pointed at.
function findRentalByStart(customerId, startDate) {
  return DB.data.rentals.find((r) => r.customerId === customerId && r.startDate === startDate) || null;
}

function renderBoundaryReviewCard(item) {
  const cust = DB.data.customers.find((c) => c.id === item.customerId);
  const prevRental = findRentalByStart(item.customerId, item.prevStart);
  const nextRental = findRentalByStart(item.customerId, item.nextStart);
  const isOngoing = nextRental && nextRental.status === "active";
  return `
    <div class="review-card-v2">
      <div style="font-weight:700;font-size:15.5px;margin-bottom:2px;">${escapeHtml(item.customerName || (cust ? cust.name : "Unknown customer"))}</div>
      <div class="review-card-v2-question">What happened after the previous rental?</div>
      <div class="grid-2" style="margin-bottom:12px;">
        <div class="review-slot">
          <div class="review-slot-label">Previous Rental</div>
          <div class="review-slot-value">${fmtDate(item.prevStart)} → ${fmtDate(item.prevEnd)}</div>
          ${prevRental ? `<div class="muted" style="font-size:12px;margin-top:2px;">${escapeHtml(prevRental.bikeNameRaw || prevRental.bikeModel)}</div>` : ""}
        </div>
        <div class="review-slot">
          <div class="review-slot-label">Next Rental</div>
          <div class="review-slot-value">${fmtDate(item.nextStart)} → ${isOngoing ? "—" : fmtDate(item.nextEnd)}</div>
          <div class="muted" style="font-size:12px;margin-top:2px;">${escapeHtml(item.nextBike || "")}</div>
          ${isOngoing ? `<span class="ongoing-badge" style="margin-top:6px;"><span class="ongoing-dot"></span>Ongoing</span>` : ""}
        </div>
      </div>
      <div class="reward-note" style="margin-bottom:12px;">${item.gapDays}-day gap between rentals. The bike shown above is for reference only — it isn't used to decide this. ${item.nextSourceRow ? `Source: ${escapeHtml(item.nextSourceRow)}` : ""}</div>
      <div class="btn-row">
        <button class="btn btn-orange btn-sm" data-action="resolve-boundary" data-review-id="${item.id}" data-decision="same">Same Rental — Continued</button>
        <button class="btn btn-outline btn-sm" data-action="resolve-boundary" data-review-id="${item.id}" data-decision="new">New Rental — Returned Later</button>
        <button class="btn btn-ghost btn-sm" data-action="resolve-boundary" data-review-id="${item.id}" data-decision="later">Review Later</button>
      </div>
    </div>
  `;
}

function renderIdentityReviewCard(item) {
  const custA = DB.data.customers.find((c) => c.id === item.customerAId);
  const custB = DB.data.customers.find((c) => c.id === item.customerBId);
  if (!custA || !custB) return "";
  const statsA = customerStats(custA), statsB = customerStats(custB);
  const side = (c, stats) => `
    <div class="review-slot" style="flex:1;min-width:0;">
      <div style="font-weight:700;font-size:14.5px;color:var(--ink);">${escapeHtml(c.name)}</div>
      <div class="muted" style="font-size:12px;margin-top:4px;">${c.nationality ? escapeHtml(c.nationality) : "Nationality unknown"}</div>
      <div class="muted" style="font-size:12px;">${c.passport ? "Passport: " + escapeHtml(c.passport) : "No passport on file"}</div>
      <div class="muted" style="font-size:12px;margin-top:6px;">${stats.rentalCount} rental(s), ${stats.paidRentalDays} day(s)</div>
      <div class="muted" style="font-size:12px;">First seen: ${fmtDate(c.firstSeen)}</div>
    </div>
  `;
  return `
    <div class="review-card-v2">
      <div class="review-card-v2-question">Are these the same customer?</div>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        ${side(custA, statsA)}
        ${side(custB, statsB)}
      </div>
      <div class="reward-note" style="margin-bottom:12px;">${escapeHtml(item.reason)}</div>
      <div class="btn-row">
        <button class="btn btn-orange btn-sm" data-action="resolve-identity" data-review-id="${item.id}" data-decision="merge">Same Customer</button>
        <button class="btn btn-outline btn-sm" data-action="resolve-identity" data-review-id="${item.id}" data-decision="separate">Different Customer</button>
        <button class="btn btn-ghost btn-sm" data-action="resolve-identity" data-review-id="${item.id}" data-decision="later">Review Later</button>
      </div>
    </div>
  `;
}

function renderNeedsReview() {
  const boundaryItems = DB.data.needsReview.filter((r) => r.type === "rental_boundary" && !r.resolved);
  const identityItems = DB.data.needsReview.filter((r) => r.type === "customer_match" && !r.resolved);
  const resolvedCount = DB.data.needsReview.filter((r) => r.resolved).length;

  return `
    <header class="screen-header">
      <button class="back-btn" data-goto="customers">‹ Customer Loyalty</button>
      <h1 class="screen-title" style="margin-top:8px;">Needs Review</h1>
      <p class="needs-review-subheading">A few historical records need your confirmation.${resolvedCount ? ` (${resolvedCount} already resolved)` : ""}</p>
    </header>
    <div class="screen-body">
      ${boundaryItems.length === 0 && identityItems.length === 0 ? `
        <div class="empty">
          <div class="empty-icon">✓</div>
          <h3>All caught up</h3>
          <p>No pending decisions right now.</p>
        </div>
      ` : ""}

      ${boundaryItems.length ? `
        <div class="section-label">Uncertain rental dates (${boundaryItems.length})</div>
        ${boundaryItems.map(renderBoundaryReviewCard).join("")}
      ` : ""}

      ${identityItems.length ? `
        <div class="section-label">Possible duplicate customers (${identityItems.length})</div>
        <p class="muted" style="margin:-6px 0 12px;">Two records that might be the same person.</p>
        ${identityItems.map(renderIdentityReviewCard).join("")}
      ` : ""}
    </div>
  `;
}

function resolveBoundary(reviewId, decision) {
  const item = DB.data.needsReview.find((r) => r.id === reviewId);
  if (!item || item.resolved) return;

  if (decision === "later") {
    toast("Kept in Needs Review for later");
    return;
  }

  const prevRental = findRentalByStart(item.customerId, item.prevStart);
  const nextRental = findRentalByStart(item.customerId, item.nextStart);

  if (decision === "same" && prevRental && nextRental) {
    prevRental.endDate = nextRental.endDate;
    prevRental.status = nextRental.status; // carries "active" forward if the later leg is still ongoing
    prevRental.revenue = Math.round(((Number(prevRental.revenue) || 0) + (Number(nextRental.revenue) || 0)) * 100) / 100;
    prevRental.bookedDays = (Number(prevRental.bookedDays) || 0) + (Number(nextRental.bookedDays) || 0);
    prevRental.paidDays = (Number(prevRental.paidDays) || 0) + (Number(nextRental.paidDays) || 0);
    prevRental.bikeNameRaw = nextRental.bikeNameRaw || prevRental.bikeNameRaw; // most recent bike wins for display
    prevRental.sourceRows = [...(prevRental.sourceRows || []), ...(nextRental.sourceRows || [])];
    DB.data.rentals = DB.data.rentals.filter((r) => r.id !== nextRental.id);
    // Any reward tied to the now-removed rental record should point at the surviving one.
    DB.data.rewards.forEach((rw) => { if (rw.rentalId === nextRental.id) rw.rentalId = prevRental.id; });
  }

  item.resolved = true;
  item.resolution = decision === "same" ? "same_rental_continued" : "new_rental_returned_later";
  item.resolvedAt = todayISO();
  DB.save();
  toast(decision === "same" ? "Recorded as the same continuing rental" : "Recorded as a new rental — returned later");
  render();
}

function resolveIdentity(reviewId, decision) {
  const item = DB.data.needsReview.find((r) => r.id === reviewId);
  if (!item || item.resolved) return;

  if (decision === "later") {
    toast("Kept in Needs Review for later");
    return;
  }

  if (decision === "merge") {
    const custA = DB.data.customers.find((c) => c.id === item.customerAId);
    const custB = DB.data.customers.find((c) => c.id === item.customerBId);
    if (custA && custB) {
      DB.data.rentals.forEach((r) => { if (r.customerId === custB.id) r.customerId = custA.id; });
      DB.data.rewards.forEach((rw) => { if (rw.customerId === custB.id) rw.customerId = custA.id; });
      DB.data.needsReview.forEach((r) => {
        if (r.customerId === custB.id) r.customerId = custA.id;
        if (r.customerAId === custB.id) r.customerAId = custA.id;
        if (r.customerBId === custB.id) r.customerBId = custA.id;
      });
      if (!custA.mergedNames) custA.mergedNames = [];
      custA.mergedNames.push(custB.name, ...(custB.mergedNames || []));
      if (!custA.nationality && custB.nationality) custA.nationality = custB.nationality;
      if (!custA.passport && custB.passport) custA.passport = custB.passport;
      if (custB.firstSeen && (!custA.firstSeen || custB.firstSeen < custA.firstSeen)) custA.firstSeen = custB.firstSeen;
      DB.data.customers = DB.data.customers.filter((c) => c.id !== custB.id);
    }
  }

  item.resolved = true;
  item.resolution = decision === "merge" ? "merged" : "kept_separate";
  item.resolvedAt = todayISO();
  DB.save();
  toast(decision === "merge" ? "Customers merged" : "Kept as separate customers");
  navigate("needs-review");
}

/* ---------------------------------------------------------------------- */
/* RENDER — SETTINGS                                                       */
/* ---------------------------------------------------------------------- */

function renderSettings() {
  return `
    <header class="screen-header">
      <span class="eyebrow">AA Scooters · Chiang Mai</span>
      <h1 class="screen-title">Settings</h1>
      <p class="screen-sub">Internal configuration &amp; data</p>
    </header>
    <div class="screen-body">
      <div class="section-title">Data Audit</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Compares data currently stored on this device against the canonical data built into this version of the app — read-only, changes nothing. Useful after a code update to check whether this device's stored records are still current.</p>
        <button class="btn btn-outline btn-block" data-goto="data-audit">Run Data Audit (Read-Only)</button>
      </div>

      <div class="section-title">Loyalty Program Effective Date</div>
      <div class="card">
        <div class="field" style="margin-bottom:6px;">
          <label>Loyalty Program Effective Date</label>
          <input type="date" id="loyalty-effective-date" value="${DB.data.meta.loyaltyEffectiveDate}" />
        </div>
        <p class="muted">The AA Loyalty &amp; Rewards Program's official start date. Welcome Gift only applies to bookings handed over on or after this date; Journey Gift only applies to rentals that are still active, or that complete, on or after this date — a rental fully completed before it never creates a pending gift. Rental Visits and "Returning Customer" recognition still reflect full history back to 2025. Qualified Rentals, Total Paid Days, 2026 Revenue, and Ride Upgrade / Long-Term / VIP progress are all based on 2026-onward activity only — 2025 rentals establish that a customer is a real returning customer, but don't feed those figures. Changing this date recalculates gift eligibility live without deleting any rental history.</p>
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn btn-primary btn-sm" id="save-launch-date">Save date</button>
        </div>
      </div>

      <div class="section-title">Reward Costs &amp; Values</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Estimated Reward Value and Actual Cash Cost are tracked separately — giving a complimentary day has a rental value even though AA may not have spent that much cash. All figures here are starting defaults; correct them any time as real costs become clear.</p>
        <div class="field"><label>Welcome Gift — actual cost (THB)</label><input type="number" min="0" id="cost-welcomeGift" value="${DB.data.meta.rewardCosts.welcomeGift}" /></div>
        <div class="field"><label>Journey Gift — actual cost (THB)</label><input type="number" min="0" id="cost-journeyGift" value="${DB.data.meta.rewardCosts.journeyGift}" /></div>
        <div class="section-label" style="margin-top:4px;">Daily rental value by bike (THB/day)</div>
        <p class="muted" style="margin-bottom:8px;">Used for Premium Ride Experience (×2 days) and VIP Extra Day (×1 day), based on the actual bike given.</p>
        ${Object.keys(DEFAULT_DAILY_VALUES).map((k) => `<div class="field"><label>${escapeHtml(k)}</label><input type="number" min="0" id="daily-${escapeHtml(k)}" value="${DB.data.meta.dailyValues[k]}" /></div>`).join("")}
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn btn-primary btn-sm" id="save-reward-costs">Save values</button>
        </div>
      </div>

      <div class="section-title">VIP Extra Day Qualification</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Meaningful repeat rentals + cumulative paid days since the last Extra Day cycle — never just a raw visit count. Tier-aware, separately editable for each fleet level.</p>
        ${["125cc", "155cc", "300cc"].map((tier) => `
          <div class="grid-2" style="margin-bottom:10px;">
            <div class="field" style="margin-bottom:0;"><label>${escapeHtml(tier)} — min. episodes</label><input type="number" min="1" id="vip-${tier}-episodes" value="${DB.data.meta.vipThresholds[tier].episodes}" /></div>
            <div class="field" style="margin-bottom:0;"><label>${escapeHtml(tier)} — min. paid days</label><input type="number" min="1" id="vip-${tier}-days" value="${DB.data.meta.vipThresholds[tier].days}" /></div>
          </div>
        `).join("")}
        <div class="btn-row" style="margin-top:4px;">
          <button class="btn btn-primary btn-sm" id="save-vip-thresholds">Save thresholds</button>
        </div>
      </div>

      <div class="section-title">Loyalty Health Thresholds</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Reward-to-Revenue Ratio = Total Reward Value ÷ 2026 Revenue × 100. At or below the first number shows 🟢 Healthy, up to the second shows 🟡 Watch, above that shows 🔴 High. Individual rewards can still be manually overridden case by case via Edit / Undo.</p>
        <div class="field"><label>Healthy — up to (%)</label><input type="number" min="0" step="0.5" id="health-healthyMax" value="${DB.data.meta.healthThresholds.healthyMax}" /></div>
        <div class="field"><label>Watch — up to (%)</label><input type="number" min="0" step="0.5" id="health-watchMax" value="${DB.data.meta.healthThresholds.watchMax}" /></div>
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn btn-primary btn-sm" id="save-health-thresholds">Save thresholds</button>
        </div>
      </div>

      <div class="section-title">Bike Name Mapping</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Original Bike Name (exactly as it appears in historical records) → Standardized Vehicle Category. The category — not the raw name — drives Journey Gift thresholds, Qualified Rentals, and Ride Upgrade recommendations. Correcting a mapping here recalculates every affected customer immediately; the original historical name is never changed or lost, it stays visible under each rental's View Details.</p>
        <div style="max-height:340px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius-s);">
          ${Object.entries(DB.data.meta.bikeNameMap).sort((a, b) => a[0].localeCompare(b[0])).map(([name, cat]) => `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);">
              <span class="mono" style="flex:1;font-size:12.5px;text-transform:capitalize;">${escapeHtml(name)}</span>
              <select data-bike-map-key="${escapeHtml(name)}" style="width:auto;padding:6px 8px;font-size:12.5px;border:1px solid var(--line-strong);border-radius:6px;">
                ${CATEGORY_TIERS.map((t) => `<option value="${escapeHtml(t)}" ${t === cat ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
              </select>
            </div>
          `).join("")}
        </div>
        <div class="section-label" style="margin-top:16px;">Add a new mapping</div>
        <div class="field"><label>Original bike name</label><input id="f-new-bike-name" type="text" placeholder="e.g. GT Purple" /></div>
        <div class="field"><label>Standardized category</label>
          <select id="f-new-bike-category">${CATEGORY_TIERS.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}</select>
        </div>
        <div class="btn-row">
          <button class="btn btn-orange btn-sm" id="add-bike-mapping">Add mapping</button>
          <button class="btn btn-outline btn-sm" id="reset-bike-mapping">Reset to defaults</button>
        </div>
      </div>

      <div class="section-title">Import Existing Data</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Bring in customers, rentals, or vehicles from a spreadsheet (e.g. exported from Google Sheets as CSV). This is always a one-time or occasional manual action — nothing here runs automatically. Existing records are matched first; nothing is overwritten without your say-so.</p>
        <div class="btn-row">
          <button class="btn btn-orange btn-sm" id="start-import">Import from CSV…</button>
        </div>
      </div>

      <div class="section-title">Manager System</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Check for new or updated 2026 customer/rental records from the AA Scooters Manager/booking system. Read-only — this app never writes back to that Sheet. Only checks when you press the button, never automatically.</p>
        <div class="btn-row">
          <button class="btn btn-orange btn-sm" data-goto="manager-sync">Check for Updates from Manager…</button>
        </div>
      </div>

      <div class="section-title">Loyalty Data (Cloud)</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">The imported customer/rental baseline (name+nationality matched, from the spreadsheet history) now lives in a shared Google Drive folder instead of only here on this device, so it can be refreshed after someone re-runs the matching pipeline on fresh spreadsheets — without needing a new app deployment. Only replaces baseline records (source: imported spreadsheet history); anything added via Manager Sync or the "+" buttons is never touched. Only runs when you press the button.</p>
        <div class="btn-row">
          <button class="btn btn-orange btn-sm" id="check-cloud-loyalty-sync">Refresh Loyalty Baseline from Cloud</button>
        </div>
        ${state.cloudSyncStatus === "fetching" ? `<p class="muted" style="margin-top:10px;">Checking cloud…</p>` : ""}
        ${state.cloudSyncStatus === "error" ? `<p style="margin-top:10px; color:#c0392b;">${escapeHtml(state.cloudSyncError || "Something went wrong.")}</p>` : ""}
        ${state.cloudSyncStatus === "preview" && state.cloudSyncPreview ? `
          <div style="margin-top:12px; padding:12px; border-radius:10px; background:rgba(255,255,255,0.04);">
            <p style="margin-bottom:8px;">Cloud has <strong>${state.cloudSyncPreview.cloudCustomerCount}</strong> baseline customers and <strong>${state.cloudSyncPreview.cloudRentalCount}</strong> baseline rentals (currently on this device: ${state.cloudSyncPreview.localCustomerCount} / ${state.cloudSyncPreview.localRentalCount}).</p>
            <div class="btn-row">
              <button class="btn btn-primary btn-sm" id="apply-cloud-loyalty-sync">Apply</button>
              <button class="btn btn-outline btn-sm" id="cancel-cloud-loyalty-sync">Cancel</button>
            </div>
          </div>
        ` : ""}
        ${state.cloudSyncStatus === "done" ? `<p class="muted" style="margin-top:10px;">Baseline refreshed ✓</p>` : ""}
      </div>

      <div class="section-title">Data</div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px;">Data is stored locally on this device — this is this app's own standalone database, separate from any other AA Scooters system. Export regularly and keep a backup.</p>
        <div class="btn-row">
          <button class="btn btn-outline btn-sm" id="export-data">Export JSON</button>
          <button class="btn btn-outline btn-sm" id="import-data">Import JSON backup</button>
          <button class="btn btn-danger btn-sm" id="wipe-data">Reset all data</button>
        </div>
        <input type="file" id="import-file" accept="application/json" style="display:none;" />
      </div>

      <div class="section-title">About</div>
      <div class="card">
        <p class="muted">AA Scooter Rental — Customer &amp; Loyalty Manager. Internal tool only, not a customer-facing app. Rewards shown here are recommendations for staff — never promise a reward to a customer before checking availability.</p>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* RENDER — IMPORT WIZARD                                                  */
/* ---------------------------------------------------------------------- */

function getMappedValue(row, colIdx, type) {
  if (colIdx === undefined || colIdx === null || colIdx === -1) return "";
  let raw = row[colIdx] !== undefined ? row[colIdx] : "";
  raw = String(raw).trim();
  if (raw === "") return "";
  if (type === "date") return parseDateLoose(raw);
  if (type === "number") { const n = Number(raw.replace(/,/g, "")); return isNaN(n) ? "" : n; }
  return raw;
}

// Re-derives records fresh from the current mapping on every render — cheap at
// small-business scale and keeps the mapping UI and preview always in sync.
function buildImportRecords() {
  if (!importState || !importState.type || !importState.rows.length) return [];
  const schema = IMPORT_SCHEMAS[importState.type];
  return importState.rows.map((row) => {
    const rec = {};
    schema.fields.forEach((f) => { rec[f.key] = getMappedValue(row, importState.mapping[f.key], f.type); });
    rec._invalid = schema.fields.some((f) => f.required && (rec[f.key] === "" || rec[f.key] === undefined));
    if (importState.type === "vehicles" && !rec._invalid) {
      const taxInfo = parseTaxColumn(rec.taxRaw, rec.porRorBorExpiryDate);
      rec.taxExpiryDate = taxInfo.taxExpiryDate;
      rec.taxOverduePending = taxInfo.taxOverduePending;
      if (!rec.renewalNote) rec.renewalNote = taxInfo.renewalNote;
    }
    if (!rec._invalid) {
      if (importState.type === "customers") {
        rec._existing = DB.data.customers.find((c) => normalizeText(c.name) === normalizeText(rec.name)) || null;
      } else if (importState.type === "vehicles") {
        rec._existing = DB.data.vehicles.find((v) => normalizeText(v.plate) === normalizeText(rec.plate)) || null;
      } else if (importState.type === "rentals") {
        const cust = DB.data.customers.find((c) => normalizeText(c.name) === normalizeText(rec.customerName));
        // Duplicate identity = same customer + same real bike + overlapping dates. NEVER
        // compare standardized bikeModel-to-bikeModel — an existing (especially canonical
        // historical) record's bikeModel is a loyalty-tier classification label (e.g.
        // "Aerox Standard"), not the actual bike, while a freshly imported CSV row's bike
        // column lands in bikeModel as raw text (e.g. "GT silver 1") since this importer
        // does no classification step. Comparing those two never matches, which is exactly
        // why re-importing the same historical data previously created duplicate records.
        // Compare true raw bike identity instead — existing bikeNameRaw if present, falling
        // back to existing bikeModel only when no raw field was ever recorded for it.
        rec._existing = cust
          ? DB.data.rentals.find((r) => {
              if (r.customerId !== cust.id) return false;
              const existingRawBike = r.bikeNameRaw || r.bikeModel;
              const incomingRawBike = rec.bikeNameRaw || rec.bikeModel;
              if (normalizeText(existingRawBike) !== normalizeText(incomingRawBike)) return false;
              // Date/episode OVERLAP, not an exact start-date match — a canonical episode
              // merged from multiple original rows spans a wider range than any single
              // re-imported row's own start/end, so an exact-date requirement missed them.
              const existingEnd = r.endDate || r.startDate;
              const incomingEnd = rec.endDate || rec.startDate;
              return rec.startDate <= existingEnd && incomingEnd >= r.startDate;
            }) || null
          : null;
      }
      rec._duplicate = !!rec._existing;
    }
    return rec;
  });
}

function renderImportScreen() {
  if (!importState) resetImportState(null);

  // Step 1: choose what to import.
  if (!importState.type) {
    return `
      <header class="screen-header">
        <button class="back-btn" data-goto="settings">‹ Settings</button>
        <h1 class="screen-title">Import from CSV</h1>
        <p class="screen-sub">What are you importing?</p>
      </header>
      <div class="screen-body">
        ${Object.entries(IMPORT_SCHEMAS).map(([key, s]) => `
          <div class="list-item" data-import-choose-type="${key}">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(s.label)}</div>
              <div class="list-item-sub">Required: ${escapeHtml(s.fields.filter((f) => f.required).map((f) => f.label).join(", "))}</div>
            </div>
            <span class="chev">›</span>
          </div>
        `).join("")}
        <p class="muted" style="margin-top:14px;">In Google Sheets: File → Download → Comma-separated values (.csv), then upload that file here.</p>
      </div>
    `;
  }

  const schema = IMPORT_SCHEMAS[importState.type];

  // Step 3: result summary after commit.
  if (importState.result) {
    const r = importState.result;
    return `
      <header class="screen-header">
        <button class="back-btn" data-goto="settings">‹ Settings</button>
        <h1 class="screen-title">Import complete</h1>
        <p class="screen-sub">${escapeHtml(schema.label)} · ${escapeHtml(importState.fileName)}</p>
      </header>
      <div class="screen-body">
        <div class="stat-grid">
          <div class="stat-tile accent"><span class="stat-value">${r.created}</span><span class="stat-label">New records created</span></div>
          <div class="stat-tile"><span class="stat-value">${r.updated}</span><span class="stat-label">Existing records updated</span></div>
          <div class="stat-tile"><span class="stat-value">${r.skipped}</span><span class="stat-label">Duplicates skipped</span></div>
          <div class="stat-tile"><span class="stat-value">${r.invalid}</span><span class="stat-label">Rows missing required data</span></div>
        </div>
        ${importState.type === "vehicles" ? `
          <div class="section-label">Tax import breakdown</div>
          <div class="stat-grid">
            <div class="stat-tile"><span class="stat-value">${r.taxSameDate}</span><span class="stat-label">Same date as Por Ror Bor ("-")</span></div>
            <div class="stat-tile"><span class="stat-value">${r.taxIndependent}</span><span class="stat-label">Independent Tax date</span></div>
            <div class="stat-tile"><span class="stat-value">${r.taxPending}</span><span class="stat-label">Overdue — Renewal Pending</span></div>
            <div class="stat-tile"><span class="stat-value">${r.created + r.updated + r.skipped}</span><span class="stat-label">Total vehicles processed</span></div>
          </div>
        ` : ""}
        ${r.autoCreatedCustomers ? `<div class="card" style="margin-top:12px;"><p class="muted">${r.autoCreatedCustomers} new customer(s) were auto-created because their name didn't match anyone on file yet.</p></div>` : ""}
        <div class="btn-row" style="margin-top:16px;">
          <button class="btn btn-primary btn-sm" data-import-again>Import another file</button>
          <button class="btn btn-ghost btn-sm" data-goto="settings">Back to Settings</button>
        </div>
      </div>
    `;
  }

  // Step 2a: no file loaded yet.
  if (!importState.rows.length) {
    return `
      <header class="screen-header">
        <button class="back-btn" data-import-back-to-type>‹ Change type</button>
        <h1 class="screen-title">Import ${escapeHtml(schema.label)}</h1>
        <p class="screen-sub">Upload a CSV file</p>
      </header>
      <div class="screen-body">
        <div class="card">
          <p class="muted" style="margin-bottom:14px;">Fields the app understands: ${escapeHtml(schema.fields.map((f) => f.label + (f.required ? " (required)" : "")).join(", "))}. Column names don't need to match exactly — the app guesses the best mapping and you can adjust it on the next screen.</p>
          <button class="btn btn-primary btn-block" id="pick-csv-file">Choose CSV file</button>
          <input type="file" id="csv-file-input" accept=".csv,text/csv" style="display:none;" />
        </div>
      </div>
    `;
  }

  // Step 2b: mapping + preview + duplicate detection.
  const records = buildImportRecords();
  const invalidCount = records.filter((r) => r._invalid).length;
  const dupCount = records.filter((r) => r._duplicate).length;
  const newCount = records.length - invalidCount - dupCount;
  const previewRows = records.slice(0, 6);

  return `
    <header class="screen-header">
      <button class="back-btn" data-import-reset-rows>‹ Choose different file</button>
      <h1 class="screen-title">Map columns</h1>
      <p class="screen-sub">${escapeHtml(importState.fileName)} · ${importState.rows.length} row(s) found</p>
    </header>
    <div class="screen-body">
      <div class="section-title">Column mapping</div>
      <div class="card">
        ${schema.fields.map((f) => `
          <div class="field" style="margin-bottom:12px;">
            <label>${escapeHtml(f.label)}${f.required ? " *" : ""}</label>
            <select data-map-field="${f.key}">
              <option value="-1">— Not in this file —</option>
              ${importState.headers.map((h, i) => `<option value="${i}" ${importState.mapping[f.key] === i ? "selected" : ""}>${escapeHtml(h)}</option>`).join("")}
            </select>
          </div>
        `).join("")}
      </div>

      <div class="section-title">Preview — first ${previewRows.length} of ${records.length} row(s)</div>
      <div class="card" style="overflow-x:auto;padding:10px;">
        <table style="border-collapse:collapse;width:100%;font-size:12.5px;">
          <thead><tr>
            ${schema.fields.map((f) => `<th style="text-align:left;padding:6px 10px;color:var(--text-secondary);font-weight:600;white-space:nowrap;">${escapeHtml(f.label)}</th>`).join("")}
            <th style="text-align:left;padding:6px 10px;color:var(--text-secondary);font-weight:600;">Status</th>
          </tr></thead>
          <tbody>
            ${previewRows.map((r) => `<tr style="border-top:1px solid var(--line);">
              ${schema.fields.map((f) => `<td class="mono" style="padding:6px 10px;white-space:nowrap;">${escapeHtml(r[f.key] === "" ? "—" : r[f.key])}</td>`).join("")}
              <td style="padding:6px 10px;">${r._invalid ? '<span class="pill pill-red">Missing field</span>' : r._duplicate ? '<span class="pill pill-amber">Duplicate</span>' : '<span class="pill pill-green">New</span>'}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>

      <div class="section-title">Summary</div>
      <div class="stat-grid">
        <div class="stat-tile"><span class="stat-value">${newCount}</span><span class="stat-label">New records</span></div>
        <div class="stat-tile"><span class="stat-value">${dupCount}</span><span class="stat-label">Possible duplicates</span></div>
        <div class="stat-tile"><span class="stat-value">${invalidCount}</span><span class="stat-label">Missing required field</span></div>
        <div class="stat-tile"><span class="stat-value">${records.length}</span><span class="stat-label">Total rows</span></div>
      </div>

      ${dupCount > 0 ? `
        <div class="card">
          <div class="checkbox-row">
            <input type="checkbox" id="update-duplicates" ${importState.updateDuplicates ? "checked" : ""} />
            <label style="margin:0;text-transform:none;font-weight:500;">Update the ${dupCount} matched existing record(s) with the imported values</label>
          </div>
          <p class="muted">Unchecked (default): duplicates are left exactly as they are and skipped. Matching is by ${importState.type === "vehicles" ? "plate number" : importState.type === "customers" ? "name" : "customer + bike + start date"}.</p>
        </div>
      ` : ""}

      <button class="btn btn-primary btn-block" id="commit-import" ${newCount + dupCount === 0 ? "disabled" : ""}>Import ${newCount + (importState.updateDuplicates ? dupCount : 0)} record(s)</button>
    </div>
  `;
}

function commitImport() {
  const records = buildImportRecords();
  const schema = IMPORT_SCHEMAS[importState.type];
  const result = { created: 0, updated: 0, skipped: 0, invalid: 0, autoCreatedCustomers: 0, taxSameDate: 0, taxIndependent: 0, taxPending: 0 };

  records.forEach((rec) => {
    if (rec._invalid) { result.invalid++; return; }

    if (importState.type === "vehicles") {
      if (rec.taxOverduePending) result.taxPending++;
      else if (rec.taxRaw === "-") result.taxSameDate++;
      else if (rec.taxRaw) result.taxIndependent++;
    }

    if (importState.type === "customers") {
      if (rec._existing) {
        if (importState.updateDuplicates) {
          const c = rec._existing;
          if (rec.phone) c.phone = rec.phone;
          if (rec.firstSeen) c.firstSeen = rec.firstSeen;
          if (rec.notes) c.notes = rec.notes;
          result.updated++;
        } else result.skipped++;
      } else {
        DB.data.customers.push({ id: uid("c"), name: rec.name, phone: rec.phone || "", notes: rec.notes || "", firstSeen: rec.firstSeen || todayISO() });
        result.created++;
      }
    }

    if (importState.type === "vehicles") {
      if (rec._existing) {
        if (importState.updateDuplicates) {
          const v = rec._existing;
          if (rec.bikeName) v.bikeName = rec.bikeName;
          if (rec.modelYear !== "") v.modelYear = rec.modelYear;
          // Treat an imported Tax/Por Ror Bor change like a renewal: preserve history,
          // never touch the other document. Handles all three Tax cases (date / "-" / "Not yet").
          const newTaxIsPending = !!rec.taxOverduePending;
          const taxChanged = newTaxIsPending !== !!v.taxOverduePending || (rec.taxExpiryDate && rec.taxExpiryDate !== v.taxExpiryDate);
          if (taxChanged) {
            const previousDisplay = v.taxOverduePending ? "Overdue — Renewal Pending" : (v.taxExpiryDate ? fmtDate(v.taxExpiryDate) : "not set");
            if (v.taxExpiryDate || v.taxOverduePending) {
              if (!v.taxHistory) v.taxHistory = [];
              v.taxHistory.push({ previousExpiry: previousDisplay, renewedOn: todayISO(), note: "Updated via import" });
            }
            v.taxExpiryDate = newTaxIsPending ? "" : (rec.taxExpiryDate || v.taxExpiryDate);
            v.taxOverduePending = newTaxIsPending;
          }
          if (rec.renewalNote) v.renewalNote = rec.renewalNote;
          if (rec.porRorBorExpiryDate && rec.porRorBorExpiryDate !== v.porRorBorExpiryDate) {
            if (v.porRorBorExpiryDate) { if (!v.porRorBorHistory) v.porRorBorHistory = []; v.porRorBorHistory.push({ previousExpiry: fmtDate(v.porRorBorExpiryDate), renewedOn: todayISO(), note: "Updated via import" }); }
            v.porRorBorExpiryDate = rec.porRorBorExpiryDate;
          }
          if (rec.currentKm !== "") v.currentKm = rec.currentKm;
          if (rec.nextServiceKm !== "") v.nextServiceKm = rec.nextServiceKm;
          if (rec.status) v.status = rec.status;
          if (rec.notes) v.notes = rec.notes;
          result.updated++;
        } else result.skipped++;
      } else {
        DB.data.vehicles.push({
          id: uid("v"), bikeName: rec.bikeName, modelYear: rec.modelYear || "", plate: rec.plate,
          taxExpiryDate: rec.taxExpiryDate || "", porRorBorExpiryDate: rec.porRorBorExpiryDate || "",
          taxOverduePending: !!rec.taxOverduePending, renewalNote: rec.renewalNote || "",
          taxHistory: [], porRorBorHistory: [],
          currentKm: rec.currentKm || 0, nextServiceKm: rec.nextServiceKm || 0,
          status: rec.status || "active", notes: rec.notes || "",
        });
        result.created++;
      }
    }

    if (importState.type === "rentals") {
      let customer = DB.data.customers.find((c) => normalizeText(c.name) === normalizeText(rec.customerName));
      if (!customer) {
        customer = { id: uid("c"), name: rec.customerName, phone: "", notes: "Auto-created from rental import.", firstSeen: rec.startDate || todayISO() };
        DB.data.customers.push(customer);
        result.autoCreatedCustomers++;
      }
      if (rec._existing) {
        if (importState.updateDuplicates) {
          const r = rec._existing;
          if (rec.endDate) { r.endDate = rec.endDate; r.status = "completed"; }
          if (rec.bookedDays !== "") r.bookedDays = rec.bookedDays;
          if (rec.paidDays !== "") r.paidDays = rec.paidDays;
          if (rec.revenue !== "") r.revenue = rec.revenue;
          if (rec.plate) r.plate = rec.plate;
          result.updated++;
        } else result.skipped++;
      } else {
        DB.data.rentals.push({
          // bikeNameRaw is now populated on newly-imported rentals too, using the same raw
          // text as bikeModel — this is what makes future duplicate-detection actually work
          // for records created by THIS importer going forward (see the fixed match above).
          id: uid("r"), customerId: customer.id, bikeModel: rec.bikeModel, bikeNameRaw: rec.bikeModel, plate: rec.plate || "",
          startDate: rec.startDate, endDate: rec.endDate || null,
          bookedDays: rec.bookedDays || 0, paidDays: rec.paidDays || 0, revenue: rec.revenue || 0,
          status: rec.endDate ? "completed" : "active",
        });
        result.created++;
      }
    }
  });

  DB.save();
  importState.result = result;
}

/* ---------------------------------------------------------------------- */
/* MODALS / SHEETS                                                         */
/* ---------------------------------------------------------------------- */

function openSheet(html) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="sheet-backdrop" id="sheet-backdrop"><div class="sheet">${'<div class="sheet-handle"></div>'}${html}</div></div>`;
  root.querySelector("#sheet-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "sheet-backdrop") closeSheet();
  });
}
function closeSheet() { document.getElementById("modal-root").innerHTML = ""; }

// In-app confirmation, NOT the native browser confirm() — sandboxed preview iframes (and
// some embedded/PWA contexts) block or silently no-op window.confirm()/alert(), which would
// make "Continue anyway?" and "Undo Mark Used" appear to do nothing when tapped. This always
// works because it's just a normal sheet in the app's own DOM.
function confirmSheet(message, onConfirm, confirmLabel) {
  openSheet(`
    <div class="sheet-title">Please confirm</div>
    <div class="sheet-sub">${escapeHtml(message)}</div>
    <div class="btn-row" style="margin-top:16px;">
      <button class="btn btn-outline btn-block" id="confirm-sheet-cancel">Cancel</button>
      <button class="btn btn-primary btn-block" id="confirm-sheet-ok">${escapeHtml(confirmLabel || "Continue")}</button>
    </div>
  `);
  document.getElementById("confirm-sheet-cancel").addEventListener("click", () => closeSheet());
  document.getElementById("confirm-sheet-ok").addEventListener("click", () => {
    closeSheet();
    onConfirm();
  });
}

function sheetAddCustomer() {
  openSheet(`
    <div class="sheet-title">Add customer</div>
    <div class="sheet-sub">Creates a new customer record.</div>
    <div class="field"><label>Full name</label><input id="f-name" type="text" placeholder="e.g. Somchai Jaidee" /></div>
    <div class="field"><label>Phone</label><input id="f-phone" type="tel" placeholder="081-234-5678" /></div>
    <div class="field"><label>Notes (optional)</label><textarea id="f-notes" rows="2"></textarea></div>
    <button class="btn btn-primary btn-block" id="save-customer">Save customer</button>
  `);
  document.getElementById("save-customer").addEventListener("click", () => {
    const name = document.getElementById("f-name").value.trim();
    if (!name) { toast("Enter a name"); return; }
    const c = { id: uid("c"), name, phone: document.getElementById("f-phone").value.trim(), notes: document.getElementById("f-notes").value.trim(), firstSeen: todayISO() };
    DB.data.customers.push(c);
    DB.save();
    closeSheet();
    toast("Customer added");
    navigate("customer", { customerId: c.id });
  });
}

function sheetEditCustomer(id) {
  const c = DB.data.customers.find((x) => x.id === id);
  if (!c) return;
  openSheet(`
    <div class="sheet-title">Edit customer</div>
    <div class="field"><label>Full name</label><input id="f-name" type="text" value="${escapeHtml(c.name)}" /></div>
    <div class="field"><label>Phone</label><input id="f-phone" type="tel" value="${escapeHtml(c.phone || "")}" /></div>
    <div class="field"><label>First seen (for legacy check)</label><input id="f-first" type="date" value="${c.firstSeen}" /></div>
    <div class="field"><label>Notes</label><textarea id="f-notes" rows="2">${escapeHtml(c.notes || "")}</textarea></div>
    <button class="btn btn-primary btn-block" id="save-customer">Save changes</button>
  `);
  document.getElementById("save-customer").addEventListener("click", () => {
    c.name = document.getElementById("f-name").value.trim() || c.name;
    c.phone = document.getElementById("f-phone").value.trim();
    c.firstSeen = document.getElementById("f-first").value || c.firstSeen;
    c.notes = document.getElementById("f-notes").value.trim();
    DB.save();
    closeSheet();
    toast("Saved");
    render();
  });
}

function sheetLogRental(customerId) {
  openSheet(`
    <div class="sheet-title">Log rental</div>
    <div class="sheet-sub">Add a new rental for this customer, at handover.</div>
    <div class="field"><label>Bike model</label>
      <select id="f-bike">${ALL_BIKE_MODELS.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Plate number</label><input id="f-plate" type="text" placeholder="1กข-1234" /></div>
    <div class="field"><label>Start date (handover)</label><input id="f-start" type="date" value="${todayISO()}" /></div>
    <div class="field"><label>Confirmed paid booking duration (days)</label><input id="f-booked" type="number" min="0" value="1" /><p class="muted" style="margin-top:4px;">Drives Welcome Kit eligibility — the days paid for at booking.</p></div>
    <div class="field"><label>Actual paid/completed days so far</label><input id="f-days" type="number" min="0" value="1" /><p class="muted" style="margin-top:4px;">Drives the Journey Gift — update this as the stay continues, finalize at return.</p></div>
    <div class="field"><label>Revenue (THB)</label><input id="f-revenue" type="number" min="0" value="0" /></div>
    <div class="checkbox-row"><input type="checkbox" id="f-active" checked /><label style="margin:0;text-transform:none;font-weight:500;">This rental is ongoing (not yet returned)</label></div>
    <button class="btn btn-primary btn-block" id="save-rental">Save rental</button>
  `);
  document.getElementById("save-rental").addEventListener("click", () => {
    const bikeModel = document.getElementById("f-bike").value;
    const plate = document.getElementById("f-plate").value.trim();
    const startDate = document.getElementById("f-start").value || todayISO();
    const bookedDays = Number(document.getElementById("f-booked").value) || 0;
    const paidDays = Number(document.getElementById("f-days").value) || 0;
    const revenue = Number(document.getElementById("f-revenue").value) || 0;
    const active = document.getElementById("f-active").checked;
    const r = {
      id: uid("r"), customerId, bikeModel, plate,
      startDate, endDate: active ? null : todayISO(),
      bookedDays, paidDays, revenue, status: active ? "active" : "completed",
    };
    DB.data.rentals.push(r);
    DB.save();
    closeSheet();
    toast("Rental logged");
    render();
  });
}

function sheetEditRental(rentalId) {
  const r = DB.data.rentals.find((x) => x.id === rentalId);
  if (!r) return;
  openSheet(`
    <div class="sheet-title">Edit rental</div>
    <div class="sheet-sub">Correct any field that's wrong or incomplete.</div>
    <div class="field"><label>Bike model</label>
      <select id="f-bike">${ALL_BIKE_MODELS.map((m) => `<option value="${m}" ${m === r.bikeModel ? "selected" : ""}>${m}</option>`).join("")}</select>
    </div>
    <div class="field"><label>Plate number</label><input id="f-plate" type="text" value="${escapeHtml(r.plate)}" /></div>
    <div class="grid-2">
      <div class="field"><label>Start (handover)</label><input id="f-start" type="date" value="${r.startDate}" /></div>
      <div class="field"><label>End (return)</label><input id="f-end" type="date" value="${r.endDate || ""}" /></div>
    </div>
    <div class="field"><label>Confirmed paid booking duration (days)</label><input id="f-booked" type="number" min="0" value="${r.bookedDays ?? 0}" /><p class="muted" style="margin-top:4px;">Drives Welcome Kit eligibility.</p></div>
    <div class="field"><label>Actual paid/completed days so far</label><input id="f-days" type="number" min="0" value="${r.paidDays ?? 0}" /><p class="muted" style="margin-top:4px;">Drives the Journey Gift.</p></div>
    <div class="field"><label>Revenue (THB)</label><input id="f-revenue" type="number" min="0" value="${r.revenue}" /></div>
    <div class="field"><label>Status</label>
      <select id="f-status">
        <option value="active" ${r.status === "active" ? "selected" : ""}>Active (not yet returned)</option>
        <option value="completed" ${r.status === "completed" ? "selected" : ""}>Completed (returned)</option>
      </select>
    </div>
    <button class="btn btn-primary btn-block" id="save-rental-edit">Save changes</button>
  `);
  document.getElementById("save-rental-edit").addEventListener("click", () => {
    r.bikeModel = document.getElementById("f-bike").value;
    r.plate = document.getElementById("f-plate").value.trim();
    r.startDate = document.getElementById("f-start").value || r.startDate;
    r.endDate = document.getElementById("f-end").value || null;
    r.bookedDays = Number(document.getElementById("f-booked").value) || 0;
    r.paidDays = Number(document.getElementById("f-days").value) || 0;
    r.revenue = Number(document.getElementById("f-revenue").value) || 0;
    r.status = document.getElementById("f-status").value;
    if (r.status === "completed" && !r.endDate) r.endDate = todayISO();
    if (r.status === "active") r.endDate = null;
    DB.save();
    closeSheet();
    toast("Rental updated");
    render();
  });
}

function markRentalComplete(rentalId) {
  const r = DB.data.rentals.find((x) => x.id === rentalId);
  if (!r) return;
  openSheet(`
    <div class="sheet-title">Mark returned</div>
    <div class="sheet-sub">${escapeHtml(r.bikeModel)} · ${escapeHtml(r.plate)}</div>
    <div class="field"><label>Return date</label><input id="f-end" type="date" value="${todayISO()}" /></div>
    <div class="field"><label>Final paid days</label><input id="f-days" type="number" min="0" value="${r.paidDays}" /></div>
    <div class="field"><label>Final revenue (THB)</label><input id="f-revenue" type="number" min="0" value="${r.revenue}" /></div>
    <button class="btn btn-primary btn-block" id="save-return">Confirm return</button>
  `);
  document.getElementById("save-return").addEventListener("click", () => {
    r.endDate = document.getElementById("f-end").value || todayISO();
    r.paidDays = Number(document.getElementById("f-days").value) || 0;
    r.revenue = Number(document.getElementById("f-revenue").value) || 0;
    r.status = "completed";
    DB.save();
    closeSheet();
    toast("Rental marked as returned");
    render();
  });
}

// Full reward editor: given/not-given toggle, date/value/notes, and an optional manual
// override on eligibility. Overriding never discards the system's own calculation — it's
// always shown alongside ("system calculated: ..."). Lightweight change history is kept
// for the fields that matter (given, date given, value).
// One-tap Give/Use — the primary action for an eligible, not-yet-given reward.
// Records today's date and the current time automatically; no typing required.
// Corrections/undo/backdating still go through "Edit / Undo" (sheetEditRewardFull).
// AA normally offers one loyalty benefit per rental. If the customer has OTHER reward
// types currently sitting Ready/Reserved/qualified-at-return besides the one being acted
// on, warn staff before finalizing — they can still confirm and proceed if it's genuinely
// appropriate (e.g. Welcome Gift + Journey Gift on the same long booking is fine).
function otherRewardsCurrentlyReady(customer, excludeKey) {
  const stats = customerStats(customer);
  const sugg = getSuggestions(customer, stats);
  const seenTypes = new Set();
  sugg.forEach((s) => {
    if (s.key === excludeKey || (s.reward && s.reward.given) || s.isNoCurrentRentalMarker) return;
    const isReady = s.cycleStatus === "ready" || s.cycleStatus === "reserved" || s.qualifiedPending || (s.eligible && s.upgradeTarget);
    if (isReady) seenTypes.add(s.type);
  });
  return [...seenTypes];
}
// ATOMIC TRANSACTION WRAPPER — Mark Used / Undo / Edit / Override must succeed or fail as
// one complete change. There is deliberately only ONE source of truth (DB.data.rewards) —
// Customer Profile, Reward History, and Loyalty Reports all read it live on every render,
// never a separate cached copy — so the one risk to guard against is a mutation that throws
// partway through. This snapshots the rewards array first; if anything inside `fn` throws,
// the snapshot is restored before any DB.save(), so a failed transaction leaves zero trace
// rather than a Profile/History/Reports disagreement.
function withAtomicRewardUpdate(fn) {
  const snapshot = JSON.stringify(DB.data.rewards);
  try {
    fn();
    DB.save();
    return true;
  } catch (err) {
    DB.data.rewards = JSON.parse(snapshot);
    toast("Update failed — no changes were saved.");
    render();
    return false;
  }
}

function quickGiveOrUse(key, customerId, type, rentalId, upgradeTarget) {
  const customer0 = DB.data.customers.find((c) => c.id === customerId);

  const proceed = () => {
    let resultDateGiven = null, resultVerb = "Given";
    const ok = withAtomicRewardUpdate(() => {
      let rw = findReward(key);
      const isNew = !rw;
      if (!rw) {
        rw = { id: uid("rw"), key, type, customerId, rentalId: rentalId || null, given: false, history: [] };
        DB.data.rewards.push(rw);
      }
      if (!rw.history) rw.history = [];
      const now = new Date();
      const nowISO = now.toISOString();
      const wasGiven = !!rw.given;

      const customer = DB.data.customers.find((c) => c.id === customerId);
      // Look up the live suggestion (rate, estimated value, cycle counters) BEFORE mutating
      // the reward record — computing it after `given` flips true would make the customer's
      // own now-just-given reward shadow the pending one and always come back empty.
      const preStats = customer ? customerStats(customer) : null;
      const match = customer ? getSuggestions(customer, preStats).find((s) => s.key === key) : null;

      // VIP Extra Day is redeemed as +1 day on a qualifying rental of 7+ paid days (Pay 7 ->
      // Ride 8) — never a detached freestanding day. Soft warning only; staff stays in control.
      if (type === "vip_extra_day" && preStats && preStats.current && (Number(preStats.current.bookedDays) || 0) < 7) {
        toast("Note: VIP Extra Day is normally redeemed on a rental of 7+ paid days");
      }

      // Record the TRUE state immediately before Mark Used — never assume it was plain
      // "Ready". A reward can be Reserved (Premium Ride/VIP Extra Day) or Accepted (Ride
      // Upgrade) first; Undo Mark Used must restore exactly that, not silently downgrade an
      // accepted/reserved reward back to a bare Ready.
      const previousStatus = rw.reserved ? "reserved" : (rw.upgradeStatus === "accepted" ? "accepted" : "ready");

      rw.given = true;
      rw.reserved = false;
      rw.previousStatus = previousStatus;
      rw.dateGiven = todayISO();
      rw.givenAt = nowISO;
      if (upgradeTarget) rw.notes = rw.notes ? rw.notes : `Upgraded to ${upgradeTarget}`;

      // Estimated Reward Value defaults from the live Settings-editable rates at the moment
      // the reward is actually given — never invented later, never silently recalculated
      // after the fact. Actual Cost starts equal to the estimate but is a genuinely separate,
      // independently editable field (a complimentary day's rental value isn't the same as
      // AA's real cash cost).
      if (match && match.estimatedValue !== undefined && match.estimatedValue !== null && (rw.value === undefined || rw.value === null)) {
        rw.value = match.estimatedValue;
        if (rw.actualCost === undefined || rw.actualCost === null) rw.actualCost = match.estimatedValue;
      }

      // Premium Ride Experience / VIP Extra Day: using the reward starts a fresh qualification
      // cycle — the customer's cumulative paid days keep growing, but progress toward the NEXT
      // reward of this type counts only from this point on. VIP Extra Day also resets its
      // qualified-episode counter the same way.
      if ((type === "premium_ride" || type === "vip_extra_day") && preStats) {
        rw.cycleBaselinePaidDays = preStats.paidRentalDays;
        if (type === "vip_extra_day") rw.cycleBaselineQualifiedCount = preStats.qualifiedRentalCount;
        rw.baselineModel = "operational"; // this baseline is already on the 2026-only scale
      }

      // Ride Upgrade: lock in whichever rate applied to this specific transition at the moment
      // it was actually used (never assumed — only recorded if this step has a priced rate).
      if (type === "return_privilege" && match && match.normalRate) {
        rw.normalRate = match.normalRate;
        rw.loyaltyRate = match.loyaltyRate;
        rw.rateUnit = match.rateUnit;
      }

      if (isNew || !wasGiven) {
        rw.history.push({ field: "Marked Used", previous: "Ready", new: "Used", changedOn: nowDateTimeLabel() });
      }
      resultDateGiven = rw.dateGiven;
      resultVerb = ["return_privilege", "premium_ride", "vip_extra_day"].includes(type) ? "Used" : "Given";
    });

    if (ok) {
      toast(`${REWARD_LABELS[type] || "Reward"} ${resultVerb.toLowerCase()} · ${fmtDate(resultDateGiven)}`);
      render();
    }
  };

  const others = customer0 ? otherRewardsCurrentlyReady(customer0, key) : [];
  if (others.length > 0) {
    confirmSheet("Multiple rewards are available. AA normally uses one loyalty benefit per rental. Continue anyway?", proceed, "Continue Anyway");
  } else {
    proceed();
  }
}

// Undo Mark Used — a direct, one-tap reversal of a mistaken "Mark Used", distinct from the
// general Edit sheet. Because every screen (Profile, Reward History, Loyalty Reports,
// Reward-to-Revenue ratios) reads the SAME reward records live on every render — nothing is
// cached separately — simply flipping `given` back to false and clearing the cycle-start
// fields is sufficient for every downstream figure to already be correct on the next render.
// This also removes any higher-numbered cycle of the same type that exists ONLY as an
// unused, never-given placeholder — i.e. a "next cycle" that was created solely as a side
// effect of the mistaken Mark Used, never a real cycle with its own legitimate history.
// "Customer changed their mind" — distinct from Undo Mark Used. This is for a reward that
// was Reserved/Accepted but never actually Used: it goes back to Ready, stays fully
// available for later, earns no value, starts no new cycle, and is never treated as the
// customer losing what they already qualified for.
function returnToReady(key, customerId, type) {
  const rw = findReward(key);
  if (!rw || rw.given) return;
  const prevLabel = rw.reserved ? "Reserved" : (rw.upgradeStatus === "accepted" ? "Accepted" : "Ready");

  confirmSheet(
    `Return this ${REWARD_LABELS[type] || "reward"} to Ready? The customer keeps their eligibility for later — this is not a cancellation.`,
    () => {
      const ok = withAtomicRewardUpdate(() => {
        if (!rw.history) rw.history = [];
        rw.history.push({ field: "Returned to Ready", previous: prevLabel, new: "Ready — Customer did not use reward", changedOn: nowDateTimeLabel() });
        rw.reserved = false;
        rw.upgradeStatus = undefined;
      });
      if (ok) {
        toast("Returned to Ready — still available for later");
        render();
      }
    },
    "Return to Ready"
  );
}

function undoMarkUsed(key, customerId, type) {
  const rw = findReward(key);
  if (!rw || !rw.given) return;
  const restoreTo = rw.previousStatus || "ready"; // "ready" | "reserved" | "accepted"
  const restoreLabel = restoreTo === "reserved" ? "Reserved" : restoreTo === "accepted" ? "Accepted" : "Ready";

  openSheet(`
    <div class="sheet-title">Undo Mark Used</div>
    <div class="sheet-sub">Reverses this ${escapeHtml(REWARD_LABELS[type] || "reward")} back to ${restoreLabel} (its status just before it was marked used) and removes its value from this customer's totals.</div>
    <div class="field"><label>Reason (optional)</label><input id="f-undo-reason" type="text" placeholder="e.g. Customer changed mind" /></div>
    <div class="btn-row" style="margin-top:12px;">
      <button class="btn btn-outline btn-block" id="undo-cancel">Cancel</button>
      <button class="btn btn-primary btn-block" id="undo-confirm">Undo Mark Used</button>
    </div>
  `);
  document.getElementById("undo-cancel").addEventListener("click", () => closeSheet());
  document.getElementById("undo-confirm").addEventListener("click", () => {
    const reason = document.getElementById("f-undo-reason").value.trim();
    closeSheet();
    const ok = withAtomicRewardUpdate(() => {
      if (!rw.history) rw.history = [];
      rw.history.push({ field: "Use Reversed", previous: "Used", new: restoreLabel + (reason ? ` — Reason: ${reason}` : ""), changedOn: nowDateTimeLabel() });

      rw.given = false;
      rw.reserved = restoreTo === "reserved";
      rw.upgradeStatus = restoreTo === "accepted" ? "accepted" : undefined;
      rw.dateGiven = undefined;
      rw.givenAt = undefined;
      rw.bikeUsed = undefined;
      delete rw.previousStatus;
      delete rw.cycleBaselinePaidDays;
      delete rw.cycleBaselineQualifiedCount;
      delete rw.baselineModel;

      // Clean up an orphaned next-cycle placeholder: same customer + type, a higher cycle
      // number in the key, never actually given. A genuinely used later cycle is never
      // touched — only ever a still-pending one created by this now-undone Mark Used.
      const m = /^(.+):(\d+)$/.exec(key);
      if (m) {
        const prefix = m[1], n = Number(m[2]);
        DB.data.rewards = DB.data.rewards.filter((r) => {
          if (r.customerId !== customerId || r.type !== type || r.given) return true;
          const rm = /^(.+):(\d+)$/.exec(r.key);
          return !(rm && rm[1] === prefix && Number(rm[2]) > n);
        });
      }
    });

    if (ok) {
      toast(`Use reversed — back to ${restoreLabel}`);
      render();
    }
  });
}

// "Edit / Override" for a USED/ARCHIVED reward — a real, visible action sheet with the
// four correction options, so Undo Mark Used is a menu tap away from the reward card
// itself, never buried only in code. The three "change" options reuse the existing full
// edit form (which already has Date / Value / Cost / Notes all together and correctly
// wired into the same atomic-transaction + audit-trail machinery).
function sheetRewardActionMenu(key, customerId, type, rentalId) {
  const rw = findReward(key);
  openSheet(`
    <div class="sheet-title">${escapeHtml(REWARD_LABELS[type] || "Reward")} — Edit / Override</div>
    <div class="sheet-sub">Currently: ${rw && rw.given ? "Used" : "Ready"}${rw && rw.dateGiven ? " · " + fmtDate(rw.dateGiven) : ""}</div>
    <div class="action-menu">
      <button class="action-menu-item" id="menu-undo-used">
        <span>Undo Mark Used</span><span class="muted">Back to Ready</span>
      </button>
      <button class="action-menu-item" id="menu-change-date">
        <span>Change Used Date</span><span class="muted">${rw ? fmtDate(rw.dateGiven) : "—"}</span>
      </button>
      <button class="action-menu-item" id="menu-change-value">
        <span>Change Reward Value / Cost</span><span class="muted">${rw ? fmtMoney(rw.value) : "—"}</span>
      </button>
      <button class="action-menu-item" id="menu-add-note">
        <span>Add Staff Note</span><span class="muted">${rw && rw.notes ? "Has note" : "None"}</span>
      </button>
    </div>
  `);
  document.getElementById("menu-undo-used").addEventListener("click", () => {
    closeSheet();
    undoMarkUsed(key, customerId, type);
  });
  document.getElementById("menu-change-date").addEventListener("click", () => {
    closeSheet();
    sheetEditRewardFull(key, customerId, type, rentalId);
  });
  document.getElementById("menu-change-value").addEventListener("click", () => {
    closeSheet();
    sheetEditRewardFull(key, customerId, type, rentalId);
  });
  document.getElementById("menu-add-note").addEventListener("click", () => {
    closeSheet();
    sheetEditRewardFull(key, customerId, type, rentalId);
  });
}

// An intermediate state between Ready and Used, so staff can note a customer's
// preference without finalizing the reward (and its new cycle) until the experience
// actually happens. For Premium Ride Experience specifically, this is a noted preferred
// date only — never a guaranteed booking; final availability is confirmed 1 day before,
// after paid rentals. VIP Extra Day keeps its own separate "Reserved" wording.
function reserveReward(key, customerId, type, rentalId) {
  let rw = findReward(key);
  if (!rw) {
    rw = { id: uid("rw"), key, type, customerId, rentalId: rentalId || null, given: false, history: [] };
    DB.data.rewards.push(rw);
  }
  if (!rw.history) rw.history = [];
  rw.reserved = true;
  rw.reservedDate = todayISO();
  const isPremium = type === "premium_ride";
  rw.history.push({
    field: isPremium ? "Standby" : "Reserved",
    previous: isPremium ? "No date noted" : "Not reserved",
    new: (isPremium ? "Preferred date noted " : "Reserved ") + fmtDate(todayISO()),
    changedOn: nowDateTimeLabel(),
  });
  DB.save();
  toast(isPremium ? "Preferred date noted — standby, not guaranteed" : `${REWARD_LABELS[type] || "Reward"} reserved`);
  render();
}

// Ride Upgrade: Accept means "the customer said yes" — it does NOT consume the offer.
// Only actually marking it Used (quickGiveOrUse) progresses the ladder and locks in a rate.
function acceptRideUpgrade(key, customerId, rentalId) {
  let rw = findReward(key);
  if (!rw) {
    rw = { id: uid("rw"), key, type: "return_privilege", customerId, rentalId: rentalId || null, given: false, history: [] };
    DB.data.rewards.push(rw);
  }
  if (!rw.history) rw.history = [];
  rw.upgradeStatus = "accepted";
  rw.history.push({ field: "Ride Upgrade", previous: "Available", new: "Accepted " + fmtDate(todayISO()), changedOn: nowDateTimeLabel() });
  DB.save();
  toast("Ride Upgrade accepted");
  render();
}

// Declining a Ride Upgrade offer is just a logged note for staff — the reward stays fully
// Available afterward, exactly as if nothing happened, per "declining must not consume it".
function declineRideUpgrade(key, customerId, rentalId) {
  let rw = findReward(key);
  if (!rw) {
    rw = { id: uid("rw"), key, type: "return_privilege", customerId, rentalId: rentalId || null, given: false, history: [] };
    DB.data.rewards.push(rw);
  }
  if (!rw.history) rw.history = [];
  rw.upgradeStatus = undefined; // stays/returns to Available -- decline never blocks future acceptance
  rw.history.push({ field: "Ride Upgrade", previous: "Offered", new: "Declined " + fmtDate(todayISO()) + " — still Available", changedOn: nowDateTimeLabel() });
  DB.save();
  toast("Recorded as declined — offer stays available");
  render();
}

// Premium Ride Experience specifically needs to know which bike was actually used
// (Forza 300 or XMAX 300), so "Mark Used" is a short dedicated sheet rather than one tap.
function sheetMarkPremiumRideUsed(key, customerId, rentalId) {
  const existing = findReward(key);
  const customer0 = DB.data.customers.find((c) => c.id === customerId);
  let recommended = "Forza 300";
  if (customer0) {
    const stats0 = customerStats(customer0);
    const sugg0 = getSuggestions(customer0, stats0).find((s) => s.type === "premium_ride" && s.key === key);
    if (sugg0 && sugg0.experienceBike) recommended = sugg0.experienceBike;
  }
  const bikeOptions = ["Aerox Keyless/ABS 155cc", "NMAX Keyless/ABS 155cc", "Forza 300", "XMAX 300"];
  openSheet(`
    <div class="sheet-title">Mark Premium Ride Experience used</div>
    <div class="sheet-sub">Records today's date automatically. Defaults to the system-recommended Experience Bike — change if the customer actually took a different one.</div>
    <div class="field"><label>Bike used</label>
      <select id="f-bike-used">
        ${bikeOptions.map((b) => `<option value="${escapeHtml(b)}" ${b === recommended ? "selected" : ""}>${escapeHtml(b)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Notes (optional)</label><input id="f-notes" type="text" placeholder="e.g. overnight trip to Doi Suthep" /></div>
    <button class="btn btn-primary btn-block" id="save-premium-used">Mark used</button>
  `);
  document.getElementById("save-premium-used").addEventListener("click", () => {
    const proceedMarkPremium = () => {
      let bikeUsedResult = "";
      const ok = withAtomicRewardUpdate(() => {
        let rw = existing;
        const isNew = !rw;
        if (!rw) {
          rw = { id: uid("rw"), key, type: "premium_ride", customerId, rentalId: rentalId || null, given: false, history: [] };
          DB.data.rewards.push(rw);
        }
        if (!rw.history) rw.history = [];
        const wasGiven = !!rw.given;
        const previousStatus = rw.reserved ? "reserved" : "ready";
        rw.given = true;
        rw.reserved = false;
        rw.previousStatus = previousStatus;
        rw.dateGiven = todayISO();
        rw.givenAt = new Date().toISOString();
        rw.bikeUsed = document.getElementById("f-bike-used").value;
        rw.notes = document.getElementById("f-notes").value.trim();
        // Estimated Reward Value = the actual bike's daily rate × 2 days (live Settings-editable
        // rate for whichever bike staff actually picked, not necessarily the system's original
        // recommendation). Actual Cost starts equal but stays independently editable.
        rw.value = dailyValueFor(rw.bikeUsed) * 2;
        if (rw.actualCost === undefined || rw.actualCost === null) rw.actualCost = rw.value;
        const customer = DB.data.customers.find((c) => c.id === customerId);
        if (customer) rw.cycleBaselinePaidDays = customerStats(customer).paidRentalDays;
        rw.baselineModel = "operational";
        if (isNew || !wasGiven) {
          rw.history.push({ field: "Marked Used", previous: "Ready", new: `Used on ${rw.bikeUsed}`, changedOn: nowDateTimeLabel() });
        }
        bikeUsedResult = rw.bikeUsed;
      });
      if (ok) {
        closeSheet();
        toast(`Premium Ride Experience used · ${bikeUsedResult}`);
        render();
      }
    };

    const others = customer0 ? otherRewardsCurrentlyReady(customer0, key) : [];
    if (others.length > 0) {
      confirmSheet("Multiple rewards are available. AA normally uses one loyalty benefit per rental. Continue anyway?", proceedMarkPremium, "Continue Anyway");
    } else {
      proceedMarkPremium();
    }
  });
}

// "Send Invite" — generates the warm, natural Premium Ride Experience message with the
// customer's real first name, current bike, and recommended Experience Bike, ready to copy
// or (only if a phone number is actually on file) open directly in WhatsApp.
function sheetSendPremiumInvite(customerId, currentBikeRaw, experienceBike) {
  const customer = DB.data.customers.find((c) => c.id === customerId);
  if (!customer) return;
  const message = premiumInviteMessage(customer, currentBikeRaw, experienceBike);
  const hasPhone = !!(customer.phone && customer.phone.trim());
  openSheet(`
    <div class="sheet-title">Send Premium Ride Experience invite</div>
    <div class="sheet-sub">To ${escapeHtml(customer.name)}${hasPhone ? "" : " — no phone number on file, so WhatsApp isn't available; copy the message instead"}</div>
    <div class="field"><textarea id="f-invite-message" rows="9" style="font-size:13.5px;">${escapeHtml(message)}</textarea></div>
    <div class="btn-row">
      <button class="btn btn-primary btn-block" id="copy-invite-message">Copy Message</button>
    </div>
    ${hasPhone ? `<div class="btn-row" style="margin-top:8px;"><button class="btn btn-outline btn-block" id="open-whatsapp-invite">Open WhatsApp</button></div>` : ""}
  `);
  document.getElementById("copy-invite-message").addEventListener("click", () => {
    const text = document.getElementById("f-invite-message").value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("Message copied")).catch(() => toast("Couldn't copy — select and copy manually"));
    } else {
      toast("Couldn't copy — select and copy manually");
    }
  });
  const waBtn = document.getElementById("open-whatsapp-invite");
  if (waBtn) waBtn.addEventListener("click", () => {
    const text = document.getElementById("f-invite-message").value;
    const digits = customer.phone.replace(/[^\d]/g, "");
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, "_blank");
  });
}

function sheetEditRewardFull(key, customerId, type, rentalId) {
  const existing = findReward(key);
  const customer = DB.data.customers.find((c) => c.id === customerId);
  const stats = customerStats(customer);
  const sugg = getSuggestions(customer, stats);
  const match = sugg.find((s) => s.key === key);
  const calculatedEligible = match ? match.calculatedEligible : null;
  const currentOverride = existing && existing.overrideEligible !== undefined ? existing.overrideEligible : null;

  openSheet(`
    <div class="sheet-title">${escapeHtml(REWARD_LABELS[type] || "Reward")}</div>
    <div class="sheet-sub">Internal record only — confirm before offering anything to the customer.</div>
    <div class="checkbox-row"><input type="checkbox" id="f-given" ${existing && existing.given ? "checked" : ""} /><label style="margin:0;text-transform:none;font-weight:500;">Given / Used</label></div>
    ${type === "premium_ride" || type === "vip_extra_day" ? `<div class="checkbox-row"><input type="checkbox" id="f-reserved" ${existing && existing.reserved ? "checked" : ""} /><label style="margin:0;text-transform:none;font-weight:500;">${type === "premium_ride" ? "Preferred date noted (standby — not guaranteed, not yet used)" : "Reserved (booked, not yet used)"}</label></div>` : ""}
    <div class="field"><label>Date given</label><input id="f-date" type="date" value="${existing?.dateGiven || todayISO()}" /></div>
    ${type === "premium_ride" ? `
    <div class="field"><label>Bike used</label>
      <select id="f-bike-used">
        <option value="">— Not set —</option>
        <option value="Aerox Keyless/ABS 155cc" ${existing?.bikeUsed === "Aerox Keyless/ABS 155cc" ? "selected" : ""}>Aerox Keyless/ABS 155cc</option>
        <option value="NMAX Keyless/ABS 155cc" ${existing?.bikeUsed === "NMAX Keyless/ABS 155cc" ? "selected" : ""}>NMAX Keyless/ABS 155cc</option>
        <option value="Forza 300" ${existing?.bikeUsed === "Forza 300" ? "selected" : ""}>Forza 300</option>
        <option value="XMAX 300" ${existing?.bikeUsed === "XMAX 300" ? "selected" : ""}>XMAX 300</option>
      </select>
    </div>` : ""}
    <div class="field"><label>Estimated Reward Value (THB)</label><input id="f-value" type="number" min="0" value="${existing?.value ?? 0}" /></div>
    <div class="field"><label>Actual Cost (THB)</label><input id="f-actual-cost" type="number" min="0" value="${existing?.actualCost ?? existing?.value ?? 0}" />
      <p class="muted" style="margin-top:6px;">Estimated Value and Actual Cost are different things — e.g. a complimentary day's rental value may be ฿600, but AA's real cash cost is usually lower. Keep both accurate for reporting.</p>
    </div>
    <div class="field"><label>Notes</label><textarea id="f-notes" rows="2" placeholder="e.g. given at pickup, bike availability confirmed">${escapeHtml(existing?.notes || "")}</textarea></div>
    ${calculatedEligible !== null ? `
    <div class="field">
      <label>Manual override</label>
      <select id="f-override">
        <option value="" ${currentOverride === null ? "selected" : ""}>Use system calculation (currently ${calculatedEligible ? "Eligible" : "Not eligible"})</option>
        <option value="true" ${currentOverride === true ? "selected" : ""}>Force Eligible</option>
        <option value="false" ${currentOverride === false ? "selected" : ""}>Force Not eligible</option>
      </select>
      <p class="muted" style="margin-top:6px;">The system's own calculation is always kept in the background — this only changes what's shown as the current result.</p>
    </div>
    ` : ""}
    <button class="btn btn-primary btn-block" id="save-reward">Save</button>
  `);
  document.getElementById("save-reward").addEventListener("click", () => {
    const ok = withAtomicRewardUpdate(() => {
      let rw = existing;
      const isNew = !rw;
      if (!rw) {
        rw = { id: uid("rw"), key, type, customerId, rentalId: rentalId || null, given: false, history: [] };
        DB.data.rewards.push(rw);
      }
      if (!rw.history) rw.history = [];

      const newGiven = document.getElementById("f-given").checked;
      const reservedCheckbox = document.getElementById("f-reserved");
      const newDate = document.getElementById("f-date").value || todayISO();
      const newValue = Number(document.getElementById("f-value").value) || 0;
      const newActualCost = Number(document.getElementById("f-actual-cost").value) || 0;
      const newNotes = document.getElementById("f-notes").value.trim();
      const bikeUsedSelect = document.getElementById("f-bike-used");
      const overrideSelect = document.getElementById("f-override");
      const newOverride = overrideSelect ? (overrideSelect.value === "" ? null : overrideSelect.value === "true") : null;

      // Editing an already-used reward keeps a full audit trail — never silently overwritten.
      if (!isNew) {
        if (!!rw.given !== newGiven) rw.history.push({ field: newGiven ? "Marked Used" : "Use Reversed", previous: rw.given ? "Used" : "Ready", new: newGiven ? "Used" : "Ready", changedOn: nowDateTimeLabel() });
        if (newGiven && rw.dateGiven !== newDate) rw.history.push({ field: "Date given", previous: rw.dateGiven || "—", new: newDate, changedOn: nowDateTimeLabel() });
        if ((rw.value || 0) !== newValue) rw.history.push({ field: "Estimated Value", previous: fmtMoney(rw.value || 0), new: fmtMoney(newValue), changedOn: nowDateTimeLabel() });
        if ((rw.actualCost || 0) !== newActualCost) rw.history.push({ field: "Actual Cost", previous: fmtMoney(rw.actualCost || 0), new: fmtMoney(newActualCost), changedOn: nowDateTimeLabel() });
      } else if (newGiven) {
        rw.history.push({ field: "Marked Used", previous: "Ready", new: "Used", changedOn: nowDateTimeLabel() });
      }

      // If this edit is the moment "Given/Used" flips from false to true, this starts a new
      // reward cycle for Premium Ride / VIP Extra Day, same as the quick-action flows. If it
      // flips from true to false (an undo done through this sheet rather than the dedicated
      // Undo Mark Used button), clear the cycle-start fields the same way undoMarkUsed does,
      // so nothing downstream is left computing against a stale cycle baseline.
      if ((type === "premium_ride" || type === "vip_extra_day") && !rw.given && newGiven) {
        const customer2 = DB.data.customers.find((c) => c.id === customerId);
        if (customer2) {
          const cs2 = customerStats(customer2);
          rw.cycleBaselinePaidDays = cs2.paidRentalDays;
          if (type === "vip_extra_day") rw.cycleBaselineQualifiedCount = cs2.qualifiedRentalCount;
          rw.baselineModel = "operational";
        }
      } else if ((type === "premium_ride" || type === "vip_extra_day") && rw.given && !newGiven) {
        delete rw.cycleBaselinePaidDays;
        delete rw.cycleBaselineQualifiedCount;
        delete rw.baselineModel;
      }

      rw.given = newGiven;
      if (reservedCheckbox) rw.reserved = newGiven ? false : reservedCheckbox.checked;
      rw.dateGiven = newGiven ? newDate : undefined;
      rw.value = newValue;
      rw.actualCost = newActualCost;
      rw.notes = newNotes;
      if (bikeUsedSelect) rw.bikeUsed = bikeUsedSelect.value || undefined;
      if (overrideSelect) rw.overrideEligible = newOverride;
    });

    if (ok) {
      closeSheet();
      toast("Saved");
      render();
    }
  });
}

function sheetAddVehicle() {
  openSheet(`
    <div class="sheet-title">Add vehicle</div>
    <div class="field"><label>Bike name</label><input id="f-bikename" type="text" placeholder="e.g. Aerox Green" /></div>
    <div class="field"><label>Model year</label><input id="f-year" type="number" min="1990" max="2100" placeholder="e.g. 2022" /></div>
    <div class="field"><label>Plate number</label><input id="f-plate" type="text" placeholder="e.g. 3 กด 7084 ชม" /></div>
    <div class="field"><label>Tax expiry date</label><input id="f-tax" type="date" /></div>
    <div class="field"><label>Por Ror Bor expiry date</label><input id="f-por" type="date" /></div>
    <p class="muted" style="margin:-8px 0 14px;">Tax and Por Ror Bor are independent — they don't need to match.</p>
    <div class="grid-2">
      <div class="field"><label>Current km</label><input id="f-km" type="number" min="0" value="0" /></div>
      <div class="field"><label>Next service km</label><input id="f-nextkm" type="number" min="0" value="3000" /></div>
    </div>
    <div class="field"><label>Vehicle status</label>
      <select id="f-status"><option value="active">Active</option><option value="maintenance">In maintenance</option><option value="retired">Retired</option></select>
    </div>
    <button class="btn btn-primary btn-block" id="save-vehicle">Save vehicle</button>
  `);
  document.getElementById("save-vehicle").addEventListener("click", () => {
    const v = {
      id: uid("v"), bikeName: document.getElementById("f-bikename").value.trim(),
      modelYear: document.getElementById("f-year").value.trim(),
      plate: document.getElementById("f-plate").value.trim(),
      taxExpiryDate: document.getElementById("f-tax").value,
      porRorBorExpiryDate: document.getElementById("f-por").value,
      taxOverduePending: false, renewalNote: "",
      taxHistory: [], porRorBorHistory: [],
      currentKm: Number(document.getElementById("f-km").value) || 0,
      nextServiceKm: Number(document.getElementById("f-nextkm").value) || 0,
      status: document.getElementById("f-status").value, notes: "",
    };
    if (!v.bikeName) { toast("Enter a bike name"); return; }
    if (!v.plate) { toast("Enter a plate number"); return; }
    const dup = DB.data.vehicles.find((x) => normalizeText(x.plate) === normalizeText(v.plate));
    if (dup) { toast("That plate number is already in the fleet"); return; }
    DB.data.vehicles.push(v);
    DB.save();
    closeSheet();
    toast("Vehicle added");
    navigate("vehicle", { vehicleId: v.id });
  });
}

function sheetEditVehicle(id) {
  const v = DB.data.vehicles.find((x) => x.id === id);
  if (!v) return;
  openSheet(`
    <div class="sheet-title">Edit vehicle</div>
    <div class="sheet-sub">To change Tax or Por Ror Bor expiry, use the Renew buttons on the vehicle page instead — that keeps renewal history.</div>
    <div class="field"><label>Bike name</label><input id="f-bikename" type="text" value="${escapeHtml(v.bikeName)}" /></div>
    <div class="field"><label>Model year</label><input id="f-year" type="number" min="1990" max="2100" value="${escapeHtml(String(v.modelYear || ""))}" /></div>
    <div class="field"><label>Plate number</label><input id="f-plate" type="text" value="${escapeHtml(v.plate)}" /></div>
    <div class="grid-2">
      <div class="field"><label>Current km</label><input id="f-km" type="number" min="0" value="${v.currentKm}" /></div>
      <div class="field"><label>Next service km</label><input id="f-nextkm" type="number" min="0" value="${v.nextServiceKm}" /></div>
    </div>
    <div class="field"><label>Vehicle status</label>
      <select id="f-status">
        <option value="active" ${v.status === "active" ? "selected" : ""}>Active</option>
        <option value="maintenance" ${v.status === "maintenance" ? "selected" : ""}>In maintenance</option>
        <option value="retired" ${v.status === "retired" ? "selected" : ""}>Retired</option>
      </select>
    </div>
    <div class="field"><label>Renewal note / reason</label><input id="f-renewal-note" type="text" value="${escapeHtml(v.renewalNote || "")}" placeholder="e.g. waiting for vehicle inspection (ตรอ.)" /></div>
    <div class="field"><label>Notes</label><textarea id="f-notes" rows="2">${escapeHtml(v.notes || "")}</textarea></div>
    <button class="btn btn-primary btn-block" id="save-vehicle">Save changes</button>
  `);
  document.getElementById("save-vehicle").addEventListener("click", () => {
    const newPlate = document.getElementById("f-plate").value.trim();
    const dup = DB.data.vehicles.find((x) => x.id !== v.id && normalizeText(x.plate) === normalizeText(newPlate));
    if (!newPlate) { toast("Enter a plate number"); return; }
    if (dup) { toast("That plate number is already used by another vehicle"); return; }
    v.bikeName = document.getElementById("f-bikename").value.trim();
    v.modelYear = document.getElementById("f-year").value.trim();
    v.plate = newPlate;
    v.currentKm = Number(document.getElementById("f-km").value) || 0;
    v.nextServiceKm = Number(document.getElementById("f-nextkm").value) || 0;
    v.status = document.getElementById("f-status").value;
    v.renewalNote = document.getElementById("f-renewal-note").value.trim();
    v.notes = document.getElementById("f-notes").value.trim();
    DB.save();
    closeSheet();
    toast("Saved");
    render();
  });
}

// Renewal workflow: editing Tax or Por Ror Bor always goes through here so the previous
// expiry is preserved in history. Renewing one document never touches the other.
function sheetRenewDocument(vehicleId, docType) {
  const v = DB.data.vehicles.find((x) => x.id === vehicleId);
  if (!v) return;
  const isTax = docType === "tax";
  const label = isTax ? "Tax" : "Por Ror Bor";
  const currentExpiry = isTax ? v.taxExpiryDate : v.porRorBorExpiryDate;
  const currentlyPending = isTax && v.taxOverduePending;

  openSheet(`
    <div class="sheet-title">${currentExpiry || currentlyPending ? "Edit / Renew" : "Set"} ${label}</div>
    <div class="sheet-sub">${escapeHtml(v.bikeName)} · ${escapeHtml(v.plate)}${currentlyPending ? " — currently Overdue, Renewal Pending" : currentExpiry ? ` — current expiry ${fmtDate(currentExpiry)}` : ""}</div>

    ${isTax ? `
      <div class="checkbox-row"><input type="checkbox" id="f-pending" ${currentlyPending ? "checked" : ""} /><label style="margin:0;text-transform:none;font-weight:500;">Renewal not yet completed (e.g. waiting on ตรอ. inspection)</label></div>
    ` : ""}

    <div class="field" id="f-date-field"><label>New ${label} expiry date</label><input id="f-new-expiry" type="date" value="${currentExpiry || ""}" /></div>
    <div class="field"><label>Renewal note / reason (optional)</label><input id="f-note" type="text" value="${escapeHtml(v.renewalNote || "")}" placeholder="e.g. waiting for vehicle inspection (ตรอ.)" /></div>
    <p class="muted" style="margin-top:-8px;">This only changes ${label}. ${isTax ? "Por Ror Bor" : "Tax"} stays exactly as it is.</p>
    <button class="btn btn-primary btn-block" id="save-renewal">Save ${label}</button>
  `);

  if (isTax) {
    const pendingCheckbox = document.getElementById("f-pending");
    const dateField = document.getElementById("f-date-field");
    const syncDateVisibility = () => { dateField.style.display = pendingCheckbox.checked ? "none" : ""; };
    syncDateVisibility();
    pendingCheckbox.addEventListener("change", syncDateVisibility);
  }

  document.getElementById("save-renewal").addEventListener("click", () => {
    const note = document.getElementById("f-note").value.trim();

    if (isTax) {
      const markPending = document.getElementById("f-pending").checked;
      const previousDisplay = v.taxOverduePending ? "Overdue — Renewal Pending" : (v.taxExpiryDate ? fmtDate(v.taxExpiryDate) : "not set");

      if (markPending) {
        if (!v.taxHistory) v.taxHistory = [];
        if (v.taxExpiryDate || v.taxOverduePending) v.taxHistory.push({ previousExpiry: previousDisplay, renewedOn: todayISO(), note: note || "Marked Overdue — Renewal Pending" });
        v.taxExpiryDate = "";
        v.taxOverduePending = true;
        v.renewalNote = note;
      } else {
        const newExpiry = document.getElementById("f-new-expiry").value;
        if (!newExpiry) { toast("Enter a date, or check the pending box"); return; }
        if (!v.taxHistory) v.taxHistory = [];
        if (v.taxExpiryDate || v.taxOverduePending) v.taxHistory.push({ previousExpiry: previousDisplay, renewedOn: todayISO(), note });
        v.taxExpiryDate = newExpiry;
        v.taxOverduePending = false;
        v.renewalNote = note;
      }
    } else {
      const newExpiry = document.getElementById("f-new-expiry").value;
      if (!newExpiry) { toast("Enter a date"); return; }
      if (!v.porRorBorHistory) v.porRorBorHistory = [];
      if (v.porRorBorExpiryDate) v.porRorBorHistory.push({ previousExpiry: fmtDate(v.porRorBorExpiryDate), renewedOn: todayISO(), note });
      v.porRorBorExpiryDate = newExpiry;
    }
    DB.save();
    closeSheet();
    toast(`${label} updated`);
    render();
  });
}

/* ---------------------------------------------------------------------- */
/* MAIN RENDER + EVENTS                                                    */
/* ---------------------------------------------------------------------- */

function render() {
  const app = document.getElementById("app");
  let html = "";
  switch (state.route) {
    case "home": html = renderAppHome(); break;
    case "customers": html = renderCustomersHome(); break;
    case "customer": html = renderCustomerDetail(); break;
    case "needs-review": html = renderNeedsReview(); break;
    case "rewards-ready": html = renderRewardsReadyScreen(); break;
    case "active-riders": html = renderActiveRidersScreen(); break;
    case "reward-history": html = renderRewardHistoryScreen(); break;
    case "loyalty-reports": html = renderLoyaltyReportsScreen(); break;
    case "vehicles": html = renderVehiclesList(); break;
    case "vehicle": html = renderVehicleDetail(); break;
    case "settings": html = renderSettings(); break;
    case "data-audit": html = renderDataAuditScreen(); break;
    case "reconcile-preview": html = renderReconcilePreviewScreen(); break;
    case "sourcerow-diagnostic": html = renderSourceRowDiagnosticScreen(); break;
    case "nonimport-review": html = renderNonImportClassificationScreen(); break;
    case "customer-identity-diagnostic": html = renderCustomerIdentityDiagnosticScreen(); break;
    case "repair-preview": html = renderRepairPreviewScreen(); break;
    case "manager-sync": html = renderManagerSyncScreen(); break;
    case "reconcile-confirm": html = renderReconcileConfirmScreen(); break;
    case "reconcile-result": html = renderReconcileResultScreen(); break;
    case "import": html = renderImportScreen(); break;
    default: html = renderAppHome();
  }
  app.innerHTML = html;
  wireScreenEvents();
}

function wireScreenEvents() {
  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const route = el.dataset.goto;
      const id = el.dataset.id;
      if (route === "customer") navigate("customer", { customerId: id });
      else if (route === "vehicle") navigate("vehicle", { vehicleId: id });
      else navigate(route);
    });
  });

  document.querySelectorAll("[data-insight-toggle]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-goto]")) return; // let the row's own navigation win
      const id = el.dataset.insightToggle;
      state.expandedCard = state.expandedCard === id ? null : id;
      render();
    });
  });

  // Generic progressive-disclosure toggle ("View Details" etc.) — pure DOM swap,
  // no re-render needed, so it never loses scroll position or other UI state.
  document.querySelectorAll("[data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const panel = document.getElementById(el.dataset.toggle);
      if (!panel) return;
      const isHidden = panel.hasAttribute("hidden");
      const swapText = !el.classList.contains("collapsed-header");
      if (isHidden) {
        panel.removeAttribute("hidden");
        if (swapText) el.textContent = el.dataset.openLabel || "Hide details";
        el.classList.add("is-expanded");
      } else {
        panel.setAttribute("hidden", "");
        if (swapText) el.textContent = el.dataset.closeLabel || "View details";
        el.classList.remove("is-expanded");
      }
    });
  });

  const searchInput = document.getElementById("customer-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => { state.search = e.target.value; render(); searchFocusFix(); });
  }
  const rewardHistorySearchInput = document.getElementById("reward-history-search");
  if (rewardHistorySearchInput) {
    rewardHistorySearchInput.addEventListener("input", (e) => { state.rewardHistorySearch = e.target.value; render(); searchFocusFix(); });
  }
  document.querySelectorAll('[data-action="open-reward-history"]').forEach((el) => {
    el.addEventListener("click", () => { state.rewardHistoryCustomerId = el.dataset.id; render(); });
  });
  document.querySelectorAll('[data-action="view-reward-history"]').forEach((el) => {
    el.addEventListener("click", () => { state.rewardHistoryCustomerId = el.dataset.id; navigate("reward-history"); });
  });
  document.querySelectorAll('[data-action="reward-history-back"]').forEach((el) => {
    el.addEventListener("click", () => { state.rewardHistoryCustomerId = null; state.rewardHistorySearch = ""; render(); });
  });
  document.querySelectorAll('[data-action="open-reward-history-fresh"]').forEach((el) => {
    el.addEventListener("click", () => { state.rewardHistoryCustomerId = null; state.rewardHistorySearch = ""; navigate("reward-history"); });
  });
  document.querySelectorAll('[data-action="set-reports-period"]').forEach((el) => {
    el.addEventListener("click", () => { state.reportsPeriod = el.dataset.period; render(); });
  });
  document.querySelectorAll('[data-action="set-reward-history-filter"]').forEach((el) => {
    el.addEventListener("click", () => { state.rewardHistoryFilter = el.dataset.filter; render(); });
  });

  const addCustomerFab = document.getElementById("add-customer-fab");
  if (addCustomerFab) addCustomerFab.addEventListener("click", sheetAddCustomer);

  const addVehicleFab = document.getElementById("add-vehicle-fab");
  if (addVehicleFab) addVehicleFab.addEventListener("click", sheetAddVehicle);

  document.querySelectorAll('[data-action="edit-customer"]').forEach((el) => el.addEventListener("click", () => sheetEditCustomer(el.dataset.id)));
  document.querySelectorAll('[data-action="log-rental"]').forEach((el) => el.addEventListener("click", () => sheetLogRental(el.dataset.id)));
  document.querySelectorAll('[data-action="complete-rental"]').forEach((el) => el.addEventListener("click", () => markRentalComplete(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-rental"]').forEach((el) => el.addEventListener("click", () => sheetEditRental(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-vehicle"]').forEach((el) => el.addEventListener("click", () => sheetEditVehicle(el.dataset.id)));
  document.querySelectorAll('[data-action="renew-doc"]').forEach((el) => el.addEventListener("click", () => sheetRenewDocument(el.dataset.id, el.dataset.doc)));
  document.querySelectorAll('[data-action="edit-reward-full"]').forEach((el) => {
    el.addEventListener("click", () => sheetEditRewardFull(el.dataset.key, el.dataset.customer, el.dataset.type, el.dataset.rental));
  });
  document.querySelectorAll('[data-action="quick-give-use"]').forEach((el) => {
    el.addEventListener("click", () => quickGiveOrUse(el.dataset.key, el.dataset.customer, el.dataset.type, el.dataset.rental, el.dataset.upgradeTarget));
  });
  document.querySelectorAll('[data-action="reserve-reward"]').forEach((el) => {
    el.addEventListener("click", () => reserveReward(el.dataset.key, el.dataset.customer, el.dataset.type, el.dataset.rental));
  });
  document.querySelectorAll('[data-action="undo-mark-used"]').forEach((el) => {
    el.addEventListener("click", () => undoMarkUsed(el.dataset.key, el.dataset.customer, el.dataset.type));
  });
  document.querySelectorAll('[data-action="return-to-ready"]').forEach((el) => {
    el.addEventListener("click", () => returnToReady(el.dataset.key, el.dataset.customer, el.dataset.type));
  });
  document.querySelectorAll('[data-action="open-reward-transaction"]').forEach((el) => {
    el.addEventListener("click", () => sheetRewardTransaction(el.dataset.key));
  });
  document.querySelectorAll('[data-action="reward-override-menu"]').forEach((el) => {
    el.addEventListener("click", () => sheetRewardActionMenu(el.dataset.key, el.dataset.customer, el.dataset.type, el.dataset.rental));
  });
  document.querySelectorAll('[data-action="open-search"]').forEach((el) => {
    el.addEventListener("click", () => { state.searchOpen = true; render(); });
  });
  document.querySelectorAll('[data-action="close-search"]').forEach((el) => {
    el.addEventListener("click", () => { state.searchOpen = false; state.search = ""; render(); });
  });
  document.querySelectorAll('[data-action="reports-soon"]').forEach((el) => {
    el.addEventListener("click", () => toast("Reports — coming soon"));
  });
  document.querySelectorAll('[data-action="mark-premium-used"]').forEach((el) => {
    el.addEventListener("click", () => sheetMarkPremiumRideUsed(el.dataset.key, el.dataset.customer, el.dataset.rental));
  });
  document.querySelectorAll('[data-action="send-premium-invite"]').forEach((el) => {
    el.addEventListener("click", () => sheetSendPremiumInvite(el.dataset.customer, el.dataset.currentBike, el.dataset.experienceBike));
  });
  document.querySelectorAll('[data-action="accept-upgrade"]').forEach((el) => {
    el.addEventListener("click", () => acceptRideUpgrade(el.dataset.key, el.dataset.customer, el.dataset.rental));
  });
  document.querySelectorAll('[data-action="decline-upgrade"]').forEach((el) => {
    el.addEventListener("click", () => declineRideUpgrade(el.dataset.key, el.dataset.customer, el.dataset.rental));
  });
  document.querySelectorAll('[data-action="resolve-boundary"]').forEach((el) => {
    el.addEventListener("click", () => resolveBoundary(el.dataset.reviewId, el.dataset.decision));
  });
  document.querySelectorAll('[data-action="resolve-identity"]').forEach((el) => {
    el.addEventListener("click", () => resolveIdentity(el.dataset.reviewId, el.dataset.decision));
  });

  const saveLaunchDate = document.getElementById("save-launch-date");
  if (saveLaunchDate) saveLaunchDate.addEventListener("click", () => {
    DB.data.meta.loyaltyEffectiveDate = document.getElementById("loyalty-effective-date").value;
    DB.save();
    toast("Loyalty Program Effective Date saved");
    render();
  });

  const saveRewardCosts = document.getElementById("save-reward-costs");
  if (saveRewardCosts) saveRewardCosts.addEventListener("click", () => {
    DB.data.meta.rewardCosts.welcomeGift = Number(document.getElementById("cost-welcomeGift").value) || 0;
    DB.data.meta.rewardCosts.journeyGift = Number(document.getElementById("cost-journeyGift").value) || 0;
    Object.keys(DEFAULT_DAILY_VALUES).forEach((k) => {
      const el = document.getElementById(`daily-${k}`);
      if (el) DB.data.meta.dailyValues[k] = Number(el.value) || 0;
    });
    DB.save();
    toast("Reward costs & values saved");
    render();
  });

  const saveVipThresholds = document.getElementById("save-vip-thresholds");
  if (saveVipThresholds) saveVipThresholds.addEventListener("click", () => {
    ["125cc", "155cc", "300cc"].forEach((tier) => {
      const epEl = document.getElementById(`vip-${tier}-episodes`);
      const dayEl = document.getElementById(`vip-${tier}-days`);
      if (epEl) DB.data.meta.vipThresholds[tier].episodes = Number(epEl.value) || 1;
      if (dayEl) DB.data.meta.vipThresholds[tier].days = Number(dayEl.value) || 1;
    });
    DB.save();
    toast("VIP Extra Day thresholds saved");
    render();
  });

  const saveHealthThresholds = document.getElementById("save-health-thresholds");
  if (saveHealthThresholds) saveHealthThresholds.addEventListener("click", () => {
    DB.data.meta.healthThresholds.healthyMax = Number(document.getElementById("health-healthyMax").value) || 0;
    DB.data.meta.healthThresholds.watchMax = Number(document.getElementById("health-watchMax").value) || 0;
    DB.save();
    toast("Loyalty Health thresholds saved");
    render();
  });

  document.querySelectorAll("[data-bike-map-key]").forEach((el) => {
    el.addEventListener("change", () => {
      DB.data.meta.bikeNameMap[el.dataset.bikeMapKey] = el.value;
      DB.save();
      toast("Mapping updated — recalculated");
      render();
    });
  });

  const addBikeMappingBtn = document.getElementById("add-bike-mapping");
  if (addBikeMappingBtn) addBikeMappingBtn.addEventListener("click", () => {
    const raw = document.getElementById("f-new-bike-name").value.trim();
    const cat = document.getElementById("f-new-bike-category").value;
    if (!raw) { toast("Enter a bike name"); return; }
    DB.data.meta.bikeNameMap[normalizeBikeName(raw)] = cat;
    DB.save();
    toast("Mapping added");
    render();
  });

  const resetBikeMappingBtn = document.getElementById("reset-bike-mapping");
  if (resetBikeMappingBtn) resetBikeMappingBtn.addEventListener("click", () => {
    confirmSheet("Reset the Bike Name Mapping to the default table? Any corrections you've made will be lost.", () => {
      DB.data.meta.bikeNameMap = Object.assign({}, DEFAULT_BIKE_NAME_MAP);
      DB.save();
      toast("Bike Name Mapping reset to defaults");
      render();
    }, "Reset to Defaults");
  });

  const exportBtn = document.getElementById("export-data");
  if (exportBtn) exportBtn.addEventListener("click", () => {
    const blob = new Blob([DB.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `aa-scooter-manager-backup-${todayISO()}.json`;
    a.click();
    toast("Exported");
  });

  // Same read-only export, offered from the Reconciliation Preview screen as a convenience
  // ahead of any future repair step — this button only downloads a copy, it never mutates
  // DB.data or localStorage.
  const exportBackupBtn = document.getElementById("export-backup-now");
  if (exportBackupBtn) exportBackupBtn.addEventListener("click", () => {
    const blob = new Blob([DB.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `aa-scooter-manager-backup-pre-reconcile-${todayISO()}.json`;
    a.click();
    toast("Backup exported");
  });

  // Manager Sync — staff-triggered only, fires exclusively from this click handler.
  // Nothing anywhere else in the app calls fetch() on MANAGER_SYNC_URL, and there is no
  // timer of any kind driving this.
  const checkManagerBtn = document.getElementById("check-manager-updates");
  if (checkManagerBtn) checkManagerBtn.addEventListener("click", () => {
    state.managerSyncStatus = "fetching";
    state.managerSyncError = null;
    render();
    fetch(MANAGER_SYNC_URL)
      .then((res) => {
        if (!res.ok) throw new Error("Server responded with status " + res.status);
        return res.json();
      })
      .then((data) => {
        if (!data || data.success !== true) throw new Error((data && data.error) || "Unexpected response shape.");
        const plan = buildManagerSyncPlan(data);
        state.managerSyncPlan = plan;
        state.managerSyncStatus = "preview";

        // Persist sync-status metadata ONLY on a genuinely successful check (fetch
        // succeeded AND the plan built without error) — display/status only, never
        // touches matching or loyalty logic. Adds fields to the EXISTING meta object
        // rather than replacing it, so this is safe for accounts that predate these
        // fields entirely.
        const newCustomerCount = plan.resolvedCustomers.filter((c) => c.isNew).length;
        const existingActivityCount = plan.resolvedCustomers.filter((c) => !c.isNew).length;
        if (!DB.data.meta) DB.data.meta = {};
        DB.data.meta.lastManagerCheckAt = new Date().toISOString();
        DB.data.meta.lastManagerRecordCount = (data.rows || []).length;
        DB.data.meta.lastManagerNewCustomerCount = newCustomerCount;
        DB.data.meta.lastManagerExistingActivityCount = existingActivityCount;
        DB.data.meta.lastManagerNeedsReviewCount = plan.needsReview.length;
        DB.save();

        toast(`Manager updated ✓ — ${newCustomerCount} new customer${newCustomerCount === 1 ? "" : "s"} found`);
        render();
      })
      .catch((err) => {
        // A failed fetch/parse NEVER touches lastManagerCheckAt or any other sync-status
        // field — whatever was last successfully recorded stays exactly as it was.
        state.managerSyncError = err.message || String(err);
        state.managerSyncStatus = "error";
        render();
      });
  });

  const applyManagerSyncBtn = document.getElementById("apply-manager-sync");
  if (applyManagerSyncBtn) applyManagerSyncBtn.addEventListener("click", () => {
    const plan = state.managerSyncPlan;
    if (!plan) return;
    const newCustomerCount = plan.resolvedCustomers.filter((c) => c.isNew).length;
    const totalRows = plan.resolvedCustomers.reduce((s, c) => s + c.rows.length, 0);
    confirmSheet(
      `This will use Manager Live rental data as the operational source for ${plan.resolvedCustomers.length} identified customer(s) (${newCustomerCount} new), covering ${totalRows} Manager row(s). Legacy Gift Tracker history stays archived, not deleted. Reward records are never touched. This app never writes back to the Manager Sheet.`,
      () => {
        const result = executeManagerSync(plan);
        if (result.success) {
          state.managerSyncResult = result;
          state.managerSyncStatus = "done";
          state.managerSyncPlan = null;
        } else {
          state.managerSyncError = result.reason;
          state.managerSyncStatus = "error";
        }
        render();
      },
      "Apply Updates"
    );
  });

  const cancelManagerSyncBtn = document.getElementById("cancel-manager-sync");
  if (cancelManagerSyncBtn) cancelManagerSyncBtn.addEventListener("click", () => {
    state.managerSyncPlan = null;
    state.managerSyncStatus = "idle";
    render();
  });

  // Loyalty Cloud Sync — staff-triggered only, fires exclusively from this click handler.
  // Only ever replaces the "imp_"-prefixed baseline (see LOYALTY_CLOUD_API_URL comment above);
  // records added via Manager Sync or the "+" forms are untouched, same guarantee Manager
  // Sync itself already makes for legacy history.
  const checkCloudSyncBtn = document.getElementById("check-cloud-loyalty-sync");
  if (checkCloudSyncBtn) checkCloudSyncBtn.addEventListener("click", () => {
    state.cloudSyncStatus = "fetching";
    state.cloudSyncError = null;
    render();
    fetch(LOYALTY_CLOUD_API_URL)
      .then((res) => {
        if (!res.ok) throw new Error("Server responded with status " + res.status);
        return res.json();
      })
      .then((data) => {
        if (!data || !Array.isArray(data.customers) || !Array.isArray(data.rentals)) {
          throw new Error("Unexpected response shape.");
        }
        state.cloudSyncPreview = {
          customers: data.customers,
          rentals: data.rentals,
          cloudCustomerCount: data.customers.length,
          cloudRentalCount: data.rentals.length,
          localCustomerCount: DB.data.customers.filter((c) => (c.id || "").indexOf("imp_") === 0).length,
          localRentalCount: DB.data.rentals.filter((r) => (r.id || "").indexOf("imp_") === 0).length,
        };
        state.cloudSyncStatus = "preview";
        render();
      })
      .catch((err) => {
        state.cloudSyncError = err.message || String(err);
        state.cloudSyncStatus = "error";
        render();
      });
  });

  const applyCloudSyncBtn = document.getElementById("apply-cloud-loyalty-sync");
  if (applyCloudSyncBtn) applyCloudSyncBtn.addEventListener("click", () => {
    const preview = state.cloudSyncPreview;
    if (!preview) return;
    confirmSheet(
      `This will replace the ${preview.localCustomerCount} imported baseline customer(s) and ${preview.localRentalCount} imported baseline rental(s) currently on this device with the ${preview.cloudCustomerCount} / ${preview.cloudRentalCount} version now in the cloud. Anything added via Manager Sync or the "+" buttons is never touched. This cannot be undone from within the app — use Export Backup first if unsure.`,
      () => {
        DB.data.customers = DB.data.customers.filter((c) => (c.id || "").indexOf("imp_") !== 0).concat(preview.customers);
        DB.data.rentals = DB.data.rentals.filter((r) => (r.id || "").indexOf("imp_") !== 0).concat(preview.rentals);
        DB.save();
        state.cloudSyncStatus = "done";
        state.cloudSyncPreview = null;
        toast(`Loyalty baseline refreshed ✓ — ${preview.cloudCustomerCount} customers`);
        render();
      },
      "Apply"
    );
  });

  const cancelCloudSyncBtn = document.getElementById("cancel-cloud-loyalty-sync");
  if (cancelCloudSyncBtn) cancelCloudSyncBtn.addEventListener("click", () => {
    state.cloudSyncPreview = null;
    state.cloudSyncStatus = "idle";
    render();
  });

  document.querySelectorAll("[data-new-customer-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.getAttribute("data-new-customer-toggle");
      state.managerSyncExpandedNewCustomer = state.managerSyncExpandedNewCustomer === key ? null : key;
      render();
    });
  });

  const exportBackupConfirmBtn = document.getElementById("export-backup-confirm-screen");
  if (exportBackupConfirmBtn) exportBackupConfirmBtn.addEventListener("click", () => {
    const blob = new Blob([DB.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `aa-scooter-manager-backup-pre-reconcile-${todayISO()}.json`;
    a.click();
    toast("Backup exported");
  });

  const backupConfirmCheckbox = document.getElementById("f-backup-confirmed");
  if (backupConfirmCheckbox) backupConfirmCheckbox.addEventListener("change", (e) => {
    state.backupConfirmed = e.target.checked;
    render();
  });

  // The ONLY button anywhere in the app that can lead to executeReconciliation() actually
  // running. Disabled until the backup checkbox is ticked (enforced both by the `disabled`
  // attribute in the markup and, belt-and-braces, by refusing to open the confirm sheet
  // here too). Even once clicked, it only opens an in-app confirmation sheet — the write
  // itself happens only from that sheet's own explicit second confirmation.
  const executeBtn = document.getElementById("reconcile-execute-btn");
  if (executeBtn) executeBtn.addEventListener("click", () => {
    if (!state.backupConfirmed) return;
    const { safe, review } = computeSafePlan();
    confirmSheet(
      `This will update local Gift Tracker rental records only, for ${safe.length} customer${safe.length === 1 ? "" : "s"} marked SAFE. The original worksheet will not be touched. Manual rentals and all reward records are preserved exactly. ${review.length} customer${review.length === 1 ? "" : "s"} marked REVIEW REQUIRED will NOT be changed. A backup snapshot is taken automatically the instant before anything is written.`,
      () => {
        const result = executeReconciliation();
        state.lastReconciliationResult = result;
        navigate("reconcile-result");
      },
      `Reconcile ${safe.length} Safe Customer${safe.length === 1 ? "" : "s"}`
    );
  });

  const importBtn = document.getElementById("import-data");
  const importFile = document.getElementById("import-file");
  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        DB.importJSON(text);
        toast("Data imported");
        navigate("customers");
      } catch (err) {
        toast("Import failed — invalid file");
      }
    });
  }

  const wipeBtn = document.getElementById("wipe-data");
  if (wipeBtn) wipeBtn.addEventListener("click", () => {
    confirmSheet("Reset all data on this device? This cannot be undone. Export a backup first if unsure.", () => {
      DB.wipe();
      toast("All data reset");
      navigate("customers");
    }, "Reset All Data");
  });

  const startImportBtn = document.getElementById("start-import");
  if (startImportBtn) startImportBtn.addEventListener("click", () => { resetImportState(null); navigate("import"); });

  wireImportScreenEvents();
}

function wireImportScreenEvents() {
  document.querySelectorAll("[data-import-choose-type]").forEach((el) => el.addEventListener("click", () => {
    resetImportState(el.dataset.importChooseType);
    render();
  }));

  const backToType = document.querySelector("[data-import-back-to-type]");
  if (backToType) backToType.addEventListener("click", () => { resetImportState(null); render(); });

  const resetRows = document.querySelector("[data-import-reset-rows]");
  if (resetRows) resetRows.addEventListener("click", () => { resetImportState(importState.type); render(); });

  const importAgain = document.querySelector("[data-import-again]");
  if (importAgain) importAgain.addEventListener("click", () => { resetImportState(null); render(); });

  const pickFile = document.getElementById("pick-csv-file");
  const fileInput = document.getElementById("csv-file-input");
  if (pickFile && fileInput) {
    pickFile.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = parseCSV(text);
        if (parsed.length < 2) { toast("No data rows found in that file"); return; }
        const headers = parsed[0].map((h) => h.trim());
        const rows = parsed.slice(1);
        importState.headers = headers;
        importState.rows = rows;
        importState.fileName = file.name;
        importState.mapping = guessColumnMapping(headers, IMPORT_SCHEMAS[importState.type]);
        render();
      } catch (err) {
        toast("Could not read that file — is it a CSV?");
      }
    });
  }

  document.querySelectorAll("[data-map-field]").forEach((el) => {
    el.addEventListener("change", () => {
      importState.mapping[el.dataset.mapField] = Number(el.value);
      render();
    });
  });

  const updateDupes = document.getElementById("update-duplicates");
  if (updateDupes) updateDupes.addEventListener("change", (e) => { importState.updateDuplicates = e.target.checked; render(); });

  const commitBtn = document.getElementById("commit-import");
  if (commitBtn) commitBtn.addEventListener("click", () => {
    commitImport();
    toast("Import complete");
    render();
  });
}

function searchFocusFix() {
  const el = document.getElementById("customer-search");
  if (el) { el.focus(); const v = el.value; el.value = ""; el.value = v; }
}

/* ---------------------------------------------------------------------- */
/* INIT                                                                     */
/* ---------------------------------------------------------------------- */

document.getElementById("tabbar").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  navigate(btn.dataset.route);
});

document.getElementById("gear-btn").addEventListener("click", () => navigate("settings"));

DB.load();
navigate("home");

})();
