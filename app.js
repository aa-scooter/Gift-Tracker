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
/* Sourced from "Customer list 2025" and "Customer list 2026" only.       */
/* Validated, deduplicated, and continuous-rental-merged per the agreed   */
/* rules. Original spreadsheet rows are preserved via sourceRows on each  */
/* rental for historical reference. This is real business data, not a    */
/* fabricated demo set.                                                   */
/* ---------------------------------------------------------------------- */

const IMPORTED_CUSTOMERS = [
{id:"imp_c1",name:"Patrick",mergedNames:[],nationality:"Malasian",passport:null,phone:"",notes:"",firstSeen:"2025-02-02",source:"import"},
{id:"imp_c2",name:"Guy-Oliver Charles",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-02-27",source:"import"},
{id:"imp_c3",name:"Mr.Leich JR Sean Patrick",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-03-05",source:"import"},
{id:"imp_c4",name:"Mr.Gregory Keith Woodard",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-03-06",source:"import"},
{id:"imp_c5",name:"Kamthon Suksirithon",mergedNames:[],nationality:"Thai",passport:null,phone:"",notes:"",firstSeen:"2025-03-07",source:"import"},
{id:"imp_c6",name:"Guy-Goddard Lilian Hope",mergedNames:[],nationality:"Australian",passport:null,phone:"",notes:"",firstSeen:"2025-03-07",source:"import"},
{id:"imp_c7",name:"Ye Yint aung",mergedNames:[],nationality:"Myanmar",passport:null,phone:"",notes:"",firstSeen:"2025-03-09",source:"import"},
{id:"imp_c8",name:"Paul Gary Smart",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-03-10",source:"import"},
{id:"imp_c9",name:"Peter Barabas",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-03-10",source:"import"},
{id:"imp_c10",name:"Robert Skrobar",mergedNames:[],nationality:"Hungarian",passport:null,phone:"",notes:"",firstSeen:"2025-03-10",source:"import"},
{id:"imp_c11",name:"Olivia Jade Catusse",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-03-14",source:"import"},
{id:"imp_c12",name:"Chernets Vladimir",mergedNames:[],nationality:"Russian",passport:null,phone:"",notes:"",firstSeen:"2025-03-15",source:"import"},
{id:"imp_c13",name:"Charles Kaa Bach",mergedNames:[],nationality:"Denish",passport:null,phone:"",notes:"",firstSeen:"2025-03-17",source:"import"},
{id:"imp_c14",name:"Elo Silas Knight Andersen",mergedNames:[],nationality:"Swedish",passport:null,phone:"",notes:"",firstSeen:"2025-03-20",source:"import"},
{id:"imp_c15",name:"Mr.Tian Haotong",mergedNames:[],nationality:"Chinese",passport:null,phone:"",notes:"",firstSeen:"2025-03-20",source:"import"},
{id:"imp_c16",name:"Lavinia-Elena Dimache",mergedNames:[],nationality:"Romanian",passport:null,phone:"",notes:"",firstSeen:"2025-03-22",source:"import"},
{id:"imp_c17",name:"Ion Machis",mergedNames:[],nationality:"Romanian",passport:null,phone:"",notes:"",firstSeen:"2025-03-22",source:"import"},
{id:"imp_c18",name:"Goffin Andre-Marie",mergedNames:[],nationality:"Belgium",passport:null,phone:"",notes:"",firstSeen:"2025-03-29",source:"import"},
{id:"imp_c19",name:"Mr.Brimioulle Adrien Benoit",mergedNames:[],nationality:"Belgium",passport:null,phone:"",notes:"",firstSeen:"2025-03-29",source:"import"},
{id:"imp_c20",name:"Lambert Leonard Pierre Camile",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-03-30",source:"import"},
{id:"imp_c21",name:"Mr.Karol Lempochner",mergedNames:[],nationality:"Slovekian",passport:null,phone:"",notes:"",firstSeen:"2025-03-31",source:"import"},
{id:"imp_c22",name:"Lenna Douglas Francis",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-04-01",source:"import"},
{id:"imp_c23",name:"Jenkins Scott Laurence",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-04-03",source:"import"},
{id:"imp_c24",name:"Warayut Prasopchokchai (Frank)",mergedNames:["Warayut Prasopchokchai"],nationality:"Thai/Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-04-07",source:"import"},
{id:"imp_c25",name:"Michael Duggan ( Mike)",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-04-08",source:"import"},
{id:"imp_c26",name:"Mita Wulandari",mergedNames:[],nationality:"Indonesia",passport:null,phone:"",notes:"",firstSeen:"2025-04-11",source:"import"},
{id:"imp_c27",name:"Mr.Ozdmemir Dennis",mergedNames:[],nationality:"Russian",passport:null,phone:"",notes:"",firstSeen:"2025-04-12",source:"import"},
{id:"imp_c28",name:"Farat Mohammad",mergedNames:[],nationality:"Syrian",passport:null,phone:"",notes:"",firstSeen:"2025-04-13",source:"import"},
{id:"imp_c29",name:"Brady Joseph Philip",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-04-18",source:"import"},
{id:"imp_c30",name:"Clement Romain",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-04-19",source:"import"},
{id:"imp_c31",name:"Byunghee Hwang",mergedNames:[],nationality:"Sounth Korean",passport:null,phone:"",notes:"",firstSeen:"2025-04-23",source:"import"},
{id:"imp_c32",name:"Rutter Rueben Jude",mergedNames:[],nationality:"England",passport:null,phone:"",notes:"",firstSeen:"2025-04-24",source:"import"},
{id:"imp_c33",name:"Mr.Daly Ethan Hunter",mergedNames:[],nationality:"Australian",passport:null,phone:"",notes:"",firstSeen:"2025-04-24",source:"import"},
{id:"imp_c34",name:"Wachirawan Kewkaew",mergedNames:[],nationality:"Thai",passport:null,phone:"",notes:"",firstSeen:"2025-04-27",source:"import"},
{id:"imp_c35",name:"Kim Kyungjik",mergedNames:[],nationality:"Korean",passport:null,phone:"",notes:"",firstSeen:"2025-05-01",source:"import"},
{id:"imp_c36",name:"Rudder Hannah Lee",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-05-02",source:"import"},
{id:"imp_c37",name:"Farah Michele",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-05-05",source:"import"},
{id:"imp_c38",name:"Antoni Sabate",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-05-05",source:"import"},
{id:"imp_c39",name:"Amma",mergedNames:[],nationality:"Chinese",passport:null,phone:"",notes:"",firstSeen:"2025-05-08",source:"import"},
{id:"imp_c40",name:"Ramahi Nael",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-05-08",source:"import"},
{id:"imp_c41",name:"Pangilinan Julian",mergedNames:[],nationality:"Philippines",passport:null,phone:"",notes:"",firstSeen:"2025-05-09",source:"import"},
{id:"imp_c42",name:"John Seung Yop Lee",mergedNames:[],nationality:"Canadian",passport:null,phone:"",notes:"",firstSeen:"2025-05-12",source:"import"},
{id:"imp_c43",name:"David Jean Albert Barthelat",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-05-13",source:"import"},
{id:"imp_c44",name:"Lashawn Antionne Amos",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-05-16",source:"import"},
{id:"imp_c45",name:"Santino Giorgio Gulino",mergedNames:[],nationality:"Indonisian",passport:null,phone:"",notes:"",firstSeen:"2025-05-21",source:"import"},
{id:"imp_c46",name:"Timon Yan Jiun",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-05-21",source:"import"},
{id:"imp_c47",name:"Folkert Kerckoffs",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-05-21",source:"import"},
{id:"imp_c48",name:"Ding Xiaoke (Denise)",mergedNames:[],nationality:"USA",passport:"A35767109",phone:"",notes:"",firstSeen:"2025-05-22",source:"import"},
{id:"imp_c49",name:"Texada Destini Ronna",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-05-23",source:"import"},
{id:"imp_c50",name:"Seth David Bayram",mergedNames:[],nationality:"UK",passport:"148449526.0",phone:"",notes:"",firstSeen:"2025-05-24",source:"import"},
{id:"imp_c51",name:"Tiago Dias Da Silva",mergedNames:[],nationality:"Portuguese",passport:null,phone:"",notes:"",firstSeen:"2025-05-30",source:"import"},
{id:"imp_c52",name:"wildwood brook homestay",mergedNames:[],nationality:"Thai",passport:null,phone:"",notes:"",firstSeen:"2025-06-01",source:"import"},
{id:"imp_c53",name:"Sanguk Lee",mergedNames:[],nationality:"Korea",passport:null,phone:"",notes:"",firstSeen:"2025-06-01",source:"import"},
{id:"imp_c54",name:"Alexander Vincent",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-06-01",source:"import"},
{id:"imp_c55",name:"Nicholas John",mergedNames:[],nationality:"Zembabwe",passport:null,phone:"",notes:"",firstSeen:"2025-06-02",source:"import"},
{id:"imp_c56",name:"Glovanni Mang",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-06-03",source:"import"},
{id:"imp_c57",name:"Jerzy Franciszek Grzelak (Jurek)",mergedNames:[],nationality:"Polish",passport:null,phone:"",notes:"",firstSeen:"2025-06-04",source:"import"},
{id:"imp_c58",name:"Almozaini Abdulaziz Saleh A",mergedNames:["Almozaini Abdulaziz Salah A"],nationality:"Saudi",passport:"CA99083",phone:"",notes:"",firstSeen:"2025-06-06",source:"import"},
{id:"imp_c59",name:"Aaron Tinotenda Mutisi",mergedNames:[],nationality:"New Zealand",passport:null,phone:"",notes:"",firstSeen:"2025-06-08",source:"import"},
{id:"imp_c60",name:"Nyi Nyi Kyaw Min",mergedNames:[],nationality:"Burmese",passport:"M1517342",phone:"",notes:"",firstSeen:"2025-06-08",source:"import"},
{id:"imp_c61",name:"Stefano Vaghi",mergedNames:[],nationality:"Italy",passport:null,phone:"",notes:"",firstSeen:"2025-06-10",source:"import"},
{id:"imp_c62",name:"Paras Ladwal",mergedNames:[],nationality:"Indian",passport:"Z5830384",phone:"",notes:"",firstSeen:"2025-06-10",source:"import"},
{id:"imp_c63",name:"Kit Henry Langdale",mergedNames:["Kit Henry Langale"],nationality:"UK",passport:"135858608.0",phone:"",notes:"",firstSeen:"2025-06-13",source:"import"},
{id:"imp_c64",name:"Mr.Simon Alain Deflesselle",mergedNames:[],nationality:"Oman",passport:null,phone:"",notes:"",firstSeen:"2025-06-14",source:"import"},
{id:"imp_c65",name:"Vincent Pinot Heidemann",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-06-15",source:"import"},
{id:"imp_c66",name:"Ahmed Abdulaziz Alnaseif",mergedNames:[],nationality:"Saudi",passport:null,phone:"",notes:"",firstSeen:"2025-06-17",source:"import"},
{id:"imp_c67",name:"Liu Yi-Ting",mergedNames:[],nationality:"Taiwan",passport:null,phone:"",notes:"",firstSeen:"2025-06-17",source:"import"},
{id:"imp_c68",name:"Marianne Audhuy",mergedNames:[],nationality:"Canada",passport:null,phone:"",notes:"",firstSeen:"2025-06-18",source:"import"},
{id:"imp_c69",name:"Mr.Mohamed Rizwan Bin Rafeek",mergedNames:["Mohammed Rizwan Bin Rafeek"],nationality:"Malaysia",passport:"A71189884",phone:"",notes:"",firstSeen:"2025-06-18",source:"import"},
{id:"imp_c70",name:"Zack",mergedNames:[],nationality:"New Zealand",passport:null,phone:"",notes:"",firstSeen:"2025-06-19",source:"import"},
{id:"imp_c71",name:"Maentawan Rachad Na Chiang Mai",mergedNames:[],nationality:"Thai",passport:null,phone:"",notes:"",firstSeen:"2025-06-20",source:"import"},
{id:"imp_c72",name:"Mr.Cory Joe Larsen",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-06-21",source:"import"},
{id:"imp_c73",name:"Vladimir Popov",mergedNames:[],nationality:"Russian",passport:null,phone:"",notes:"",firstSeen:"2025-06-22",source:"import"},
{id:"imp_c74",name:"Alistair Edward Carter",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-06-23",source:"import"},
{id:"imp_c75",name:"Itamar Bluemenfeld",mergedNames:[],nationality:"Isrel",passport:null,phone:"",notes:"",firstSeen:"2025-06-27",source:"import"},
{id:"imp_c76",name:"Ariane Chevalier",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-06-30",source:"import"},
{id:"imp_c77",name:"Riadh Mimouni",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-07-01",source:"import"},
{id:"imp_c78",name:"Mr.Jared Lee Strayer",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-07-01",source:"import"},
{id:"imp_c79",name:"Nathan Reilly",mergedNames:[],nationality:"Irish",passport:null,phone:"",notes:"",firstSeen:"2025-07-02",source:"import"},
{id:"imp_c80",name:"Lin Khant Phyo",mergedNames:[],nationality:"Burmese",passport:null,phone:"",notes:"",firstSeen:"2025-07-02",source:"import"},
{id:"imp_c81",name:"Dennis Krezer",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-07-03",source:"import"},
{id:"imp_c82",name:"Olivier Rodrigue",mergedNames:[],nationality:"Canada",passport:null,phone:"",notes:"",firstSeen:"2025-07-04",source:"import"},
{id:"imp_c83",name:"Mathias Kassa Belaouchat",mergedNames:[],nationality:"Belgium",passport:null,phone:"",notes:"",firstSeen:"2025-07-05",source:"import"},
{id:"imp_c84",name:"Kuba Szutowicz",mergedNames:[],nationality:"Poland",passport:null,phone:"",notes:"",firstSeen:"2025-07-05",source:"import"},
{id:"imp_c85",name:"Jana Maren Kunisch",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-07-06",source:"import"},
{id:"imp_c86",name:"Nicholas Mario Spano",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-07-06",source:"import"},
{id:"imp_c87",name:"David Long",mergedNames:[],nationality:"Romanian",passport:null,phone:"",notes:"",firstSeen:"2025-07-06",source:"import"},
{id:"imp_c88",name:"David Stepp",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-07-06",source:"import"},
{id:"imp_c89",name:"Ashmon Maruthikkunnel Chacko",mergedNames:[],nationality:"Indian",passport:null,phone:"",notes:"",firstSeen:"2025-07-07",source:"import"},
{id:"imp_c90",name:"Ryan David Lynch",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-07-09",source:"import"},
{id:"imp_c91",name:"Jerzy Teichmon",mergedNames:[],nationality:"Russian",passport:null,phone:"",notes:"",firstSeen:"2025-07-09",source:"import"},
{id:"imp_c92",name:"Camille Lang",mergedNames:[],nationality:"Canadian",passport:null,phone:"",notes:"",firstSeen:"2025-07-11",source:"import"},
{id:"imp_c93",name:"Randall Kim",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-07-12",source:"import"},
{id:"imp_c94",name:"Dan Khon Aung",mergedNames:[],nationality:"Burmese",passport:null,phone:"",notes:"",firstSeen:"2025-07-13",source:"import"},
{id:"imp_c95",name:"Adam Drygalo",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-07-14",source:"import"},
{id:"imp_c96",name:"Luis Henrique Minizoni",mergedNames:[],nationality:"Brazilian",passport:null,phone:"",notes:"",firstSeen:"2025-07-15",source:"import"},
{id:"imp_c97",name:"Youngseop Lee",mergedNames:[],nationality:"Korean",passport:null,phone:"",notes:"",firstSeen:"2025-07-17",source:"import"},
{id:"imp_c98",name:"Amazir Manniez",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-07-17",source:"import"},
{id:"imp_c99",name:"John Alain Piccin",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-07-18",source:"import"},
{id:"imp_c100",name:"Simon Anton Kurth",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-07-18",source:"import"},
{id:"imp_c101",name:"Mr.Torsten Preub",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-07-18",source:"import"},
{id:"imp_c102",name:"Tomer Levy",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-07-22",source:"import"},
{id:"imp_c103",name:"Lisa Huang",mergedNames:[],nationality:"USA",passport:"567940321.0",phone:"",notes:"",firstSeen:"2025-07-22",source:"import"},
{id:"imp_c104",name:"Anna Egea Fornas",mergedNames:[],nationality:"Spain",passport:null,phone:"",notes:"",firstSeen:"2025-07-22",source:"import"},
{id:"imp_c105",name:"Mehdi Marwan",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-07-24",source:"import"},
{id:"imp_c106",name:"Mr.Paul Louis Pertuet",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-07-24",source:"import"},
{id:"imp_c107",name:"Mr.Michael Egon Wuchael",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-07-24",source:"import"},
{id:"imp_c108",name:"Tik Lung Ho",mergedNames:[],nationality:"Australia",passport:"PB3662412",phone:"",notes:"",firstSeen:"2025-07-26",source:"import"},
{id:"imp_c109",name:"Jorden Chudmick",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-07-27",source:"import"},
{id:"imp_c110",name:"Mr.Benjamin Andrew Van Herten",mergedNames:["Benjamin Andrew Van Harten"],nationality:"Canada",passport:"AB768624",phone:"",notes:"",firstSeen:"2025-07-28",source:"import"},
{id:"imp_c111",name:"Rassam Farddoust",mergedNames:[],nationality:"UK",passport:"525370111.0",phone:"",notes:"",firstSeen:"2025-07-28",source:"import"},
{id:"imp_c112",name:"Kittisak Busara",mergedNames:[],nationality:"Thai",passport:null,phone:"",notes:"",firstSeen:"2025-07-30",source:"import"},
{id:"imp_c113",name:"Yeow Jia Le",mergedNames:[],nationality:"Malaysia",passport:null,phone:"",notes:"",firstSeen:"2025-07-30",source:"import"},
{id:"imp_c114",name:"Byron George Edward Stevens",mergedNames:[],nationality:"UK",passport:"136147468.0",phone:"",notes:"",firstSeen:"2025-07-31",source:"import"},
{id:"imp_c115",name:"Burak Emre Akkaya",mergedNames:[],nationality:"Turky",passport:null,phone:"",notes:"",firstSeen:"2025-08-01",source:"import"},
{id:"imp_c116",name:"Aneesha M Pagaria",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-08-05",source:"import"},
{id:"imp_c117",name:"Bob Yannieck Van Zijverden",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-08-05",source:"import"},
{id:"imp_c118",name:"Aleksei Perov",mergedNames:[],nationality:"Russian",passport:null,phone:"",notes:"",firstSeen:"2025-08-10",source:"import"},
{id:"imp_c119",name:"Yang Liu (Linni)",mergedNames:[],nationality:"Chinese",passport:null,phone:"",notes:"",firstSeen:"2025-08-11",source:"import"},
{id:"imp_c120",name:"Marc Hagendijk",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-08-13",source:"import"},
{id:"imp_c121",name:"Zwe Htet Paing",mergedNames:[],nationality:"Burmese",passport:null,phone:"",notes:"",firstSeen:"2025-08-17",source:"import"},
{id:"imp_c122",name:"Albert Strdrmann",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-08-17",source:"import"},
{id:"imp_c123",name:"imilian Kieinle",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-08-24",source:"import"},
{id:"imp_c124",name:"Selemon Amare Asyehegn Setaregu",mergedNames:[],nationality:"Sweden",passport:null,phone:"",notes:"",firstSeen:"2025-08-27",source:"import"},
{id:"imp_c125",name:"Jonas Altelbyed",mergedNames:[],nationality:"Dutch",passport:null,phone:"",notes:"",firstSeen:"2025-08-28",source:"import"},
{id:"imp_c126",name:"Ismail Junior Adesine Adisa",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-08-28",source:"import"},
{id:"imp_c127",name:"Yassine Tazi",mergedNames:[],nationality:"Morocco",passport:null,phone:"",notes:"",firstSeen:"2025-08-28",source:"import"},
{id:"imp_c128",name:"Leila De Pril",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-08-29",source:"import"},
{id:"imp_c129",name:"Peng Hengshi (Poly)",mergedNames:[],nationality:"Chinese",passport:null,phone:"",notes:"",firstSeen:"2025-08-29",source:"import"},
{id:"imp_c130",name:"Thomas Ricky Carmouche",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-08-29",source:"import"},
{id:"imp_c131",name:"Benjamin Anthony Klein",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-09-01",source:"import"},
{id:"imp_c132",name:"Michael Korashi",mergedNames:[],nationality:"AUS",passport:null,phone:"",notes:"",firstSeen:"2025-09-02",source:"import"},
{id:"imp_c133",name:"Valentin Prata",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-09-07",source:"import"},
{id:"imp_c134",name:"Chong Junrui",mergedNames:[],nationality:"Singapore",passport:null,phone:"",notes:"",firstSeen:"2025-09-03",source:"import"},
{id:"imp_c135",name:"George Thomas Baxter",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-09-03",source:"import"},
{id:"imp_c136",name:"Ye Ming- Zhen ( Alvin)",mergedNames:[],nationality:"Taiwan",passport:null,phone:"",notes:"",firstSeen:"2025-09-04",source:"import"},
{id:"imp_c137",name:"Claire Louise Laing",mergedNames:[],nationality:"AUS",passport:null,phone:"",notes:"",firstSeen:"2025-09-06",source:"import"},
{id:"imp_c138",name:"John Scott Brown",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-09-08",source:"import"},
{id:"imp_c139",name:"Charles Luc Leibovici",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-09-11",source:"import"},
{id:"imp_c140",name:"Bryce Michael Raney",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-09-11",source:"import"},
{id:"imp_c141",name:"Htal War ( Franky)",mergedNames:[],nationality:"Burmese",passport:null,phone:"",notes:"",firstSeen:"2025-09-11",source:"import"},
{id:"imp_c142",name:"Essa HMY Alazmi",mergedNames:[],nationality:"Kuwait",passport:null,phone:"",notes:"",firstSeen:"2025-09-12",source:"import"},
{id:"imp_c143",name:"Stephane Herve Billat",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-09-13",source:"import"},
{id:"imp_c144",name:"Ramazan Uigun",mergedNames:[],nationality:"Kazusatan",passport:null,phone:"",notes:"",firstSeen:"2025-09-13",source:"import"},
{id:"imp_c145",name:"Yang Yu",mergedNames:[],nationality:"Chinese",passport:null,phone:"",notes:"",firstSeen:"2025-09-14",source:"import"},
{id:"imp_c146",name:"Luis Felipe Garcia",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-09-15",source:"import"},
{id:"imp_c147",name:"Michaela Stankova",mergedNames:[],nationality:"Czech",passport:null,phone:"",notes:"",firstSeen:"2025-09-15",source:"import"},
{id:"imp_c148",name:"Mr.Hong Hai Chen ( Jacob)",mergedNames:[],nationality:"AUS",passport:null,phone:"",notes:"",firstSeen:"2025-09-17",source:"import"},
{id:"imp_c149",name:"Joao Carlos Belo De Silva",mergedNames:[],nationality:"Protuguese",passport:null,phone:"",notes:"",firstSeen:"2025-09-23",source:"import"},
{id:"imp_c150",name:"Ebubekir Yilmaz",mergedNames:[],nationality:"Turkish",passport:"U15574681",phone:"",notes:"",firstSeen:"2025-09-26",source:"import"},
{id:"imp_c151",name:"Silas Liam Nowlin",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-09-26",source:"import"},
{id:"imp_c152",name:"Mr.David Lee Jimenez",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-09-27",source:"import"},
{id:"imp_c153",name:"Sagi Stolbunski",mergedNames:[],nationality:"Israel",passport:null,phone:"",notes:"",firstSeen:"2025-09-27",source:"import"},
{id:"imp_c154",name:"Nicholas Austin Sims",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-09-29",source:"import"},
{id:"imp_c155",name:"He Meng",mergedNames:[],nationality:"Chianese",passport:null,phone:"",notes:"",firstSeen:"2025-09-29",source:"import"},
{id:"imp_c156",name:"Mr.Matthew Francis Ayres",mergedNames:[],nationality:"AUS",passport:null,phone:"",notes:"",firstSeen:"2025-10-01",source:"import"},
{id:"imp_c157",name:"Graeme John Clarke",mergedNames:[],nationality:"AUS",passport:"RA4076121",phone:"",notes:"",firstSeen:"2025-09-02",source:"import"},
{id:"imp_c158",name:"Robert Artur Michon",mergedNames:[],nationality:"Poland",passport:null,phone:"",notes:"",firstSeen:"2025-09-04",source:"import"},
{id:"imp_c159",name:"Anthony Decremer",mergedNames:[],nationality:"Belgium",passport:null,phone:"",notes:"",firstSeen:"2025-10-05",source:"import"},
{id:"imp_c160",name:"Christian Jay Verona",mergedNames:[],nationality:"Philippines",passport:"P2334417C",phone:"",notes:"",firstSeen:"2025-09-09",source:"import"},
{id:"imp_c161",name:"Zackary Corbin Meyerle",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-10-07",source:"import"},
{id:"imp_c162",name:"Mr.Louis-Marle Prud Homme Lacroix",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-10-08",source:"import"},
{id:"imp_c163",name:"Berwin Tagdulang Tolero",mergedNames:[],nationality:"Philippines",passport:null,phone:"",notes:"",firstSeen:"2025-10-10",source:"import"},
{id:"imp_c164",name:"Mr.Theo Sebastien Paul Gonzales",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-10-11",source:"import"},
{id:"imp_c165",name:"Guerric Henri Marcel Galle",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-10-14",source:"import"},
{id:"imp_c166",name:"Mr.Mike Vos",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-10-15",source:"import"},
{id:"imp_c167",name:"Mr.Louis Morgan Coyne",mergedNames:[],nationality:"Ireland",passport:null,phone:"",notes:"",firstSeen:"2025-10-15",source:"import"},
{id:"imp_c168",name:"Guiliaume Sauget",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-10-15",source:"import"},
{id:"imp_c169",name:"Taekyeong Lee",mergedNames:[],nationality:"Korea",passport:null,phone:"",notes:"",firstSeen:"2025-10-16",source:"import"},
{id:"imp_c170",name:"Mr.Timothy Alan Igneri",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-10-19",source:"import"},
{id:"imp_c171",name:"Magnus Kristoffer Laaksonen",mergedNames:[],nationality:"Norway",passport:null,phone:"",notes:"",firstSeen:"2025-10-19",source:"import"},
{id:"imp_c172",name:"Rafael Castilhd Borges",mergedNames:[],nationality:"USA",passport:"592387303.0",phone:"",notes:"",firstSeen:"2025-10-20",source:"import"},
{id:"imp_c173",name:"Charles Saidler",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-10-22",source:"import"},
{id:"imp_c174",name:"Tobias David Reuben",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-10-22",source:"import"},
{id:"imp_c175",name:"Zak George Benario Bartfeld",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-10-22",source:"import"},
{id:"imp_c176",name:"Oliver Willaim Murooch",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-10-22",source:"import"},
{id:"imp_c177",name:"Youngjin Lee",mergedNames:[],nationality:"Korea",passport:null,phone:"",notes:"",firstSeen:"2025-10-24",source:"import"},
{id:"imp_c178",name:"Mr.Nicola Modari",mergedNames:[],nationality:"Italy",passport:null,phone:"",notes:"",firstSeen:"2025-10-27",source:"import"},
{id:"imp_c179",name:"Mr.Yurii Braha",mergedNames:[],nationality:"Ukraine",passport:null,phone:"",notes:"",firstSeen:"2025-10-27",source:"import"},
{id:"imp_c180",name:"Stefanos Kontogeorgis",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-10-28",source:"import"},
{id:"imp_c181",name:"Mr.Yehonatan Maly",mergedNames:[],nationality:"Israeli",passport:"32375138.0",phone:"",notes:"",firstSeen:"2025-10-28",source:"import"},
{id:"imp_c182",name:"Ben Slatter",mergedNames:[],nationality:"UK",passport:"542613664.0",phone:"",notes:"",firstSeen:"2025-10-28",source:"import"},
{id:"imp_c183",name:"Mr.Thomas stanley Williams",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-10-28",source:"import"},
{id:"imp_c184",name:"Martin Christian Richter",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-10-29",source:"import"},
{id:"imp_c185",name:"Mr.Bruce Buchan",mergedNames:[],nationality:"Ireland",passport:null,phone:"",notes:"",firstSeen:"2025-10-30",source:"import"},
{id:"imp_c186",name:"Mr.Miguel Angel Cortes",mergedNames:[],nationality:"Brazil",passport:null,phone:"",notes:"",firstSeen:"2025-10-30",source:"import"},
{id:"imp_c187",name:"Oceane Perrot",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-11-01",source:"import"},
{id:"imp_c188",name:"Kauan Ventura Da Silva",mergedNames:[],nationality:"Brazil",passport:null,phone:"",notes:"",firstSeen:"2025-11-01",source:"import"},
{id:"imp_c189",name:"William David Sloat",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-11-04",source:"import"},
{id:"imp_c190",name:"Mr.Kallum Thomson (Danyela)",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-11-06",source:"import"},
{id:"imp_c191",name:"Quentin Martus Paulo Gouzy",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-11-06",source:"import"},
{id:"imp_c192",name:"Omerine Florie G Lannoy",mergedNames:[],nationality:"Belgium",passport:null,phone:"",notes:"",firstSeen:"2025-11-07",source:"import"},
{id:"imp_c193",name:"Pablo Reinaldo Cosculluela",mergedNames:[],nationality:"Spain",passport:"PAU47126",phone:"",notes:"",firstSeen:"2025-11-08",source:"import"},
{id:"imp_c194",name:"Ezra Raiatua Keaoha Marama",mergedNames:[],nationality:"USA",passport:"673992297.0",phone:"",notes:"",firstSeen:"2025-11-08",source:"import"},
{id:"imp_c195",name:"Roberto Carlos Borja",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-11-08",source:"import"},
{id:"imp_c196",name:"Amanda Jean Dixon",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-11-11",source:"import"},
{id:"imp_c197",name:"Mr.Josilin Suillivan Alain Vincent",mergedNames:[],nationality:"French",passport:null,phone:"",notes:"",firstSeen:"2025-11-13",source:"import"},
{id:"imp_c198",name:"Mr.Kevin Tom Antony",mergedNames:[],nationality:"Ireland",passport:null,phone:"",notes:"",firstSeen:"2025-11-13",source:"import"},
{id:"imp_c199",name:"Martin Patzold",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-11-14",source:"import"},
{id:"imp_c200",name:"Mr.Oliver Bowett",mergedNames:[],nationality:"UK",passport:"548563810.0",phone:"",notes:"",firstSeen:"2025-11-16",source:"import"},
{id:"imp_c201",name:"Maarten Van den Adel",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-11-18",source:"import"},
{id:"imp_c202",name:"Cyrill Keng Yew Pang",mergedNames:[],nationality:"Netherland",passport:"NR2277KF1",phone:"",notes:"",firstSeen:"2025-11-19",source:"import"},
{id:"imp_c203",name:"Randall Kitchener Cochrane",mergedNames:[],nationality:"Canada",passport:null,phone:"",notes:"",firstSeen:"2025-11-20",source:"import"},
{id:"imp_c204",name:"Eric Trebing",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-11-20",source:"import"},
{id:"imp_c205",name:"William Jonathan Butler",mergedNames:[],nationality:"Ireland",passport:null,phone:"",notes:"",firstSeen:"2025-11-22",source:"import"},
{id:"imp_c206",name:"Kevin Dean Callow",mergedNames:[],nationality:"Ireland",passport:null,phone:"",notes:"",firstSeen:"2025-11-22",source:"import"},
{id:"imp_c207",name:"Pierre Alian Claude Picq",mergedNames:[],nationality:"France",passport:null,phone:"",notes:"",firstSeen:"2025-11-25",source:"import"},
{id:"imp_c208",name:"Maximilian Olaf Maser",mergedNames:[],nationality:"Germany",passport:"CGWHGJ7FW",phone:"",notes:"",firstSeen:"2025-11-26",source:"import"},
{id:"imp_c209",name:"Ryan Luke Connolly",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-11-27",source:"import"},
{id:"imp_c210",name:"Jack Laycock",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-11-27",source:"import"},
{id:"imp_c211",name:"Charles Carson Lawler",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-11-28",source:"import"},
{id:"imp_c212",name:"Kyungjik Kim (Paul)",mergedNames:[],nationality:"Korean",passport:null,phone:"",notes:"",firstSeen:"2025-11-28",source:"import"},
{id:"imp_c213",name:"Danai Chaisan",mergedNames:[],nationality:"Thai",passport:null,phone:"",notes:"",firstSeen:"2025-11-29",source:"import"},
{id:"imp_c214",name:"Jason Seo",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2025-12-01",source:"import"},
{id:"imp_c215",name:"Mr.Aldo Felicissimo De Souza Junior",mergedNames:[],nationality:"Brazil",passport:null,phone:"",notes:"",firstSeen:"2025-12-01",source:"import"},
{id:"imp_c216",name:"Adam Cheshin",mergedNames:[],nationality:"Israel",passport:null,phone:"",notes:"",firstSeen:"2025-12-02",source:"import"},
{id:"imp_c217",name:"Mr.Jason Kershaw",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-12-03",source:"import"},
{id:"imp_c218",name:"Samer James Tawil",mergedNames:["er James Tawil"],nationality:"USA",passport:"A80956259",phone:"",notes:"",firstSeen:"2025-12-03",source:"import"},
{id:"imp_c219",name:"Lim Peng Young",mergedNames:[],nationality:"Malasia",passport:null,phone:"",notes:"",firstSeen:"2025-12-06",source:"import"},
{id:"imp_c220",name:"Massimo Reverberi",mergedNames:[],nationality:"Italy",passport:null,phone:"",notes:"",firstSeen:"2025-12-07",source:"import"},
{id:"imp_c221",name:"Raife Harvie Phoenix Godfrey",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-12-08",source:"import"},
{id:"imp_c222",name:"Carmen Citizen Renoldi-Mateos",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-12-08",source:"import"},
{id:"imp_c223",name:"Nikita Ovdienko",mergedNames:[],nationality:"Russian",passport:null,phone:"",notes:"",firstSeen:"2025-12-10",source:"import"},
{id:"imp_c224",name:"Itai Shechter",mergedNames:[],nationality:"Romania",passport:"62420001.0",phone:"",notes:"",firstSeen:"2025-12-11",source:"import"},
{id:"imp_c225",name:"Patryk Jan Stefanski",mergedNames:[],nationality:"Poland",passport:null,phone:"",notes:"",firstSeen:"2025-12-13",source:"import"},
{id:"imp_c226",name:"Ziyang Liu",mergedNames:[],nationality:"China",passport:null,phone:"",notes:"",firstSeen:"2025-12-13",source:"import"},
{id:"imp_c227",name:"Han Paing Htet",mergedNames:[],nationality:"Burmese",passport:null,phone:"",notes:"",firstSeen:"2025-12-15",source:"import"},
{id:"imp_c228",name:"Ohanma Northito (wife uses)",mergedNames:[],nationality:"Japan",passport:null,phone:"",notes:"",firstSeen:"2025-12-15",source:"import"},
{id:"imp_c229",name:"Ohanma Northito",mergedNames:[],nationality:"Japan",passport:null,phone:"",notes:"",firstSeen:"2025-12-15",source:"import"},
{id:"imp_c230",name:"Mr.Jeremy Aymeric",mergedNames:[],nationality:"Franch",passport:null,phone:"",notes:"",firstSeen:"2025-12-15",source:"import"},
{id:"imp_c231",name:"Daniele Terrasi",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-12-16",source:"import"},
{id:"imp_c232",name:"Irie Eden Marchevsky Gottlieb",mergedNames:[],nationality:"Poland",passport:null,phone:"",notes:"",firstSeen:"2025-12-16",source:"import"},
{id:"imp_c233",name:"Alp Mustafa Tastah",mergedNames:[],nationality:"Turky",passport:null,phone:"",notes:"",firstSeen:"2025-12-17",source:"import"},
{id:"imp_c234",name:"Mr.Rafael Carranza Melendez",mergedNames:[],nationality:"Spain",passport:null,phone:"",notes:"",firstSeen:"2025-12-18",source:"import"},
{id:"imp_c235",name:"Till Alexander Lukat",mergedNames:[],nationality:"Germany",passport:"C3JLT9CGT",phone:"",notes:"",firstSeen:"2025-12-19",source:"import"},
{id:"imp_c236",name:"OR Perel",mergedNames:[],nationality:"Isael",passport:null,phone:"",notes:"",firstSeen:"2025-12-20",source:"import"},
{id:"imp_c237",name:"Darious Luke",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-12-20",source:"import"},
{id:"imp_c238",name:"Leon Moulos",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-12-20",source:"import"},
{id:"imp_c239",name:"Cody Harrison",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-12-20",source:"import"},
{id:"imp_c240",name:"Milind",mergedNames:[],nationality:"India",passport:"U6090203",phone:"",notes:"",firstSeen:"2025-12-24",source:"import"},
{id:"imp_c241",name:"Erkan Yapi",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-12-25",source:"import"},
{id:"imp_c242",name:"Janik Andreas Felten",mergedNames:[],nationality:"Netherland",passport:null,phone:"",notes:"",firstSeen:"2025-12-25",source:"import"},
{id:"imp_c243",name:"Leroy Michael Husar",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-12-25",source:"import"},
{id:"imp_c244",name:"Silvija Prvulovic",mergedNames:[],nationality:"Germany",passport:null,phone:"",notes:"",firstSeen:"2025-12-25",source:"import"},
{id:"imp_c245",name:"Stephen Anthony Wilson",mergedNames:[],nationality:"Ireland",passport:"135150121.0",phone:"",notes:"",firstSeen:"2025-12-26",source:"import"},
{id:"imp_c246",name:"Fabrizio Belliere",mergedNames:[],nationality:"Italy",passport:"YB1698961",phone:"",notes:"",firstSeen:"2025-12-28",source:"import"},
{id:"imp_c247",name:"Sangkyun Kim",mergedNames:[],nationality:"Korea",passport:null,phone:"",notes:"",firstSeen:"2025-12-30",source:"import"},
{id:"imp_c248",name:"Ms.Karina Van Rooyen Cowell",mergedNames:["Karina Van Rooyen Cowell"],nationality:"UK",passport:"549865971.0",phone:"",notes:"",firstSeen:"2025-12-30",source:"import"},
{id:"imp_c249",name:"Alexander Herbert Wichmann",mergedNames:[],nationality:"Germany",passport:"C798334XN",phone:"",notes:"",firstSeen:"2025-12-31",source:"import"},
{id:"imp_c250",name:"Natalee Jade Jenkin-Parrott",mergedNames:[],nationality:"UK",passport:null,phone:"",notes:"",firstSeen:"2025-12-31",source:"import"},
{id:"imp_c251",name:"Daniel Joseph Perry",mergedNames:[],nationality:"USA",passport:null,phone:"",notes:"",firstSeen:"2026-01-01",source:"import"},
{id:"imp_c252",name:"Paul Da Luz Soares",mergedNames:[],nationality:"Portugul",passport:"CE068730",phone:"",notes:"",firstSeen:"2026-01-01",source:"import"},
{id:"imp_c253",name:"Noah Rachel Whiting",mergedNames:[],nationality:"USA",passport:"566850931.0",phone:"",notes:"",firstSeen:"2026-01-03",source:"import"},
{id:"imp_c254",name:"Landry Lucas Maxence Veron",mergedNames:[],nationality:"France",passport:"25CH11660",phone:"",notes:"",firstSeen:"2026-01-03",source:"import"},
{id:"imp_c255",name:"Ismael Garcia Britos",mergedNames:[],nationality:"Uraguy",passport:"D348357",phone:"",notes:"",firstSeen:"2026-01-06",source:"import"},
{id:"imp_c256",name:"Farahnaaz Azrah Nain",mergedNames:[],nationality:"UK",passport:"153524135.0",phone:"",notes:"",firstSeen:"2026-01-07",source:"import"},
{id:"imp_c257",name:"Richard William Jones",mergedNames:[],nationality:"UK",passport:"130261259.0",phone:"",notes:"",firstSeen:"2026-01-08",source:"import"},
{id:"imp_c258",name:"Chad Milo Toner",mergedNames:[],nationality:"USA",passport:"640279173.0",phone:"",notes:"",firstSeen:"2026-01-09",source:"import"},
{id:"imp_c259",name:"Roberto Thawani Magwani",mergedNames:[],nationality:"Spain",passport:"PAY068620",phone:"",notes:"",firstSeen:"2026-01-10",source:"import"},
{id:"imp_c260",name:"Rain Pailvar",mergedNames:[],nationality:"Estonia",passport:"KE0267018",phone:"",notes:"",firstSeen:"2026-01-13",source:"import"},
{id:"imp_c261",name:"Emmauel Gilles Floret",mergedNames:[],nationality:"Canada",passport:"AT600013",phone:"",notes:"",firstSeen:"2026-01-14",source:"import"},
{id:"imp_c262",name:"Jackson Windsor Kenelm Baird",mergedNames:[],nationality:"UK",passport:"152334677.0",phone:"",notes:"",firstSeen:"2026-01-14",source:"import"},
{id:"imp_c263",name:"Noel Marc Marchetti",mergedNames:[],nationality:"France",passport:"23FA28186",phone:"",notes:"",firstSeen:"2026-01-19",source:"import"},
{id:"imp_c264",name:"Christopher Manguerra Catilago",mergedNames:[],nationality:"Philippines",passport:"P8378588B",phone:"",notes:"",firstSeen:"2026-01-20",source:"import"},
{id:"imp_c265",name:"Mr, Nicola Lucchini",mergedNames:[],nationality:"Italy",passport:"YC5823135",phone:"",notes:"",firstSeen:"2026-01-21",source:"import"},
{id:"imp_c266",name:"Ms.Shin Hye Um",mergedNames:[],nationality:"Korea",passport:"M14882673",phone:"",notes:"",firstSeen:"2026-01-21",source:"import"},
{id:"imp_c267",name:"Erica Fernanda Mendonca Montes",mergedNames:[],nationality:"Spain",passport:"XDF131276",phone:"",notes:"",firstSeen:"2026-01-22",source:"import"},
{id:"imp_c268",name:"Nina Lea Wadl",mergedNames:[],nationality:"Germany",passport:"CF8XJ9RR8",phone:"",notes:"",firstSeen:"2026-01-24",source:"import"},
{id:"imp_c269",name:"Mr.Marcel Weishaupl",mergedNames:[],nationality:"Germany",passport:"C2CTG2P0T",phone:"",notes:"",firstSeen:"2025-12-30",source:"import"},
{id:"imp_c270",name:"Hitoshi Horio",mergedNames:[],nationality:"Japan",passport:"TS4212191",phone:"",notes:"",firstSeen:"2026-01-30",source:"import"},
{id:"imp_c271",name:"Hu Peng",mergedNames:[],nationality:"Chinese",passport:"ER0218747",phone:"",notes:"",firstSeen:"2026-01-31",source:"import"},
{id:"imp_c272",name:"Andrey Volkov",mergedNames:[],nationality:"Russia",passport:"550847519.0",phone:"",notes:"",firstSeen:"2026-02-02",source:"import"},
{id:"imp_c273",name:"Ilona Bianca Vermeulen",mergedNames:[],nationality:"Netherland",passport:"NSF58DJ63",phone:"",notes:"",firstSeen:"2026-02-04",source:"import"},
{id:"imp_c274",name:"Mr.Nikola Vidovic",mergedNames:[],nationality:"Croatia",passport:"322062365.0",phone:"",notes:"",firstSeen:"2026-02-04",source:"import"},
{id:"imp_c275",name:"Mr.Alistair James Mcauley",mergedNames:[],nationality:"UK",passport:"551462569.0",phone:"",notes:"",firstSeen:"2026-02-04",source:"import"},
{id:"imp_c276",name:"Eda Ovet",mergedNames:[],nationality:"Turky",passport:"U37730017",phone:"",notes:"",firstSeen:"2026-02-07",source:"import"},
{id:"imp_c277",name:"Andrei Matiukhin",mergedNames:[],nationality:"Russia",passport:"66N4016478",phone:"",notes:"",firstSeen:"2026-02-08",source:"import"},
{id:"imp_c278",name:"Ms.Indra Lancien",mergedNames:[],nationality:"Franch",passport:"25DA19739",phone:"",notes:"",firstSeen:"2026-02-10",source:"import"},
{id:"imp_c279",name:"Florian Eicke Wedell",mergedNames:[],nationality:"Germany",passport:"CH1HK3JX4",phone:"",notes:"",firstSeen:"2026-02-10",source:"import"},
{id:"imp_c280",name:"Abigail Nimshimri Jamang",mergedNames:[],nationality:"India",passport:"Z6269500",phone:"",notes:"",firstSeen:"2026-02-11",source:"import"},
{id:"imp_c281",name:"Shane David Moore",mergedNames:[],nationality:"UK",passport:"560975457.0",phone:"",notes:"",firstSeen:"2026-02-11",source:"import"},
{id:"imp_c282",name:"Mr.Kartik Chandrasheker",mergedNames:[],nationality:"India",passport:"Z4921006",phone:"",notes:"",firstSeen:"2026-02-12",source:"import"},
{id:"imp_c283",name:"Jamie Charles Wilkes",mergedNames:[],nationality:"UK",passport:"156625918.0",phone:"",notes:"",firstSeen:"2026-02-12",source:"import"},
{id:"imp_c284",name:"Nikolai Egorov",mergedNames:[],nationality:"Russia",passport:"77 4891143",phone:"",notes:"",firstSeen:"2026-02-14",source:"import"},
{id:"imp_c285",name:"Alex John Milne",mergedNames:[],nationality:"UK",passport:"124804604.0",phone:"",notes:"",firstSeen:"2026-02-14",source:"import"},
{id:"imp_c286",name:"Hayleigh Quigg",mergedNames:[],nationality:"Ireland",passport:"PW0485684",phone:"",notes:"",firstSeen:"2026-02-16",source:"import"},
{id:"imp_c287",name:"Marcin Stanislaw Solarski",mergedNames:[],nationality:"Poland",passport:"FD5315792",phone:"",notes:"",firstSeen:"2026-02-17",source:"import"},
{id:"imp_c288",name:"Kimi Sue Bruurema",mergedNames:[],nationality:"USA",passport:"A76305304",phone:"",notes:"",firstSeen:"2026-02-17",source:"import"},
{id:"imp_c289",name:"Mr.Nitchakul Amborisut",mergedNames:[],nationality:"Thai",passport:"AC755776",phone:"",notes:"",firstSeen:"2026-02-18",source:"import"},
{id:"imp_c290",name:"Giovanni Giorgio Calvia",mergedNames:[],nationality:"Germany",passport:"C782RZ13R",phone:"",notes:"",firstSeen:"2026-02-19",source:"import"},
{id:"imp_c291",name:"Philipp Wagner",mergedNames:[],nationality:"Austria",passport:"U7939117",phone:"",notes:"",firstSeen:"2026-02-20",source:"import"},
{id:"imp_c292",name:"Ivan Zhirnov",mergedNames:[],nationality:"Russia",passport:"76 6613703",phone:"",notes:"",firstSeen:"2026-02-20",source:"import"},
{id:"imp_c293",name:"Eris Beganovic",mergedNames:[],nationality:"Montenego",passport:"P937F4543",phone:"",notes:"",firstSeen:"2026-02-24",source:"import"},
{id:"imp_c294",name:"Po Kwa Si",mergedNames:[],nationality:"USA",passport:"552933574.0",phone:"",notes:"",firstSeen:"2026-02-26",source:"import"},
{id:"imp_c295",name:"John Adedayo Bamisaye",mergedNames:[],nationality:"UK",passport:"156833423.0",phone:"",notes:"",firstSeen:"2026-02-28",source:"import"},
{id:"imp_c296",name:"Alex Donnam Miller",mergedNames:[],nationality:"USA",passport:"591737269.0",phone:"",notes:"",firstSeen:"2026-02-28",source:"import"},
{id:"imp_c297",name:"Johanna Johanne Moemie Delcroix",mergedNames:[],nationality:"France",passport:"24EH87735",phone:"",notes:"",firstSeen:"2026-03-01",source:"import"},
{id:"imp_c298",name:"Ivan Boiko",mergedNames:[],nationality:"Russia",passport:"76 1305726",phone:"",notes:"",firstSeen:"2026-03-03",source:"import"},
{id:"imp_c299",name:"Ms.Emma Jeanne Venus Chevreux",mergedNames:[],nationality:"France",passport:"20DK02498",phone:"",notes:"",firstSeen:"2026-03-04",source:"import"},
{id:"imp_c300",name:"Matias Ignacio Belmartino",mergedNames:[],nationality:"Argentina",passport:"AAF868957",phone:"",notes:"",firstSeen:"2026-03-05",source:"import"},
{id:"imp_c301",name:"Bartlomiej Olichwirowicz",mergedNames:[],nationality:"Poland",passport:"FK0194944",phone:"",notes:"",firstSeen:"2026-03-07",source:"import"},
{id:"imp_c302",name:"Justin Elihu Whiteman",mergedNames:[],nationality:"USA",passport:"A04524172",phone:"",notes:"",firstSeen:"2026-03-10",source:"import"},
{id:"imp_c303",name:"Mr.Peter Lopez",mergedNames:[],nationality:"USA",passport:"567268894.0",phone:"",notes:"",firstSeen:"2026-03-10",source:"import"},
{id:"imp_c304",name:"Marcus Thomas Walter",mergedNames:[],nationality:"Germany",passport:"C6YR2WPV6",phone:"",notes:"",firstSeen:"2026-03-11",source:"import"},
{id:"imp_c305",name:"Florian Pontet",mergedNames:[],nationality:"France",passport:"22HF50353",phone:"",notes:"",firstSeen:"2026-03-11",source:"import"},
{id:"imp_c306",name:"Robert Flipse",mergedNames:[],nationality:"Netherland",passport:"NWL6D33D2",phone:"",notes:"",firstSeen:"2026-03-12",source:"import"},
{id:"imp_c307",name:"Deng Xu",mergedNames:[],nationality:"China",passport:"EE9859121",phone:"",notes:"",firstSeen:"2026-03-13",source:"import"},
{id:"imp_c308",name:"Hannah Sophia Lute",mergedNames:[],nationality:"USA",passport:"A35994062",phone:"",notes:"",firstSeen:"2026-03-14",source:"import"},
{id:"imp_c309",name:"Ms.Julie Gombart",mergedNames:[],nationality:"Germany",passport:"C75YW4N5G",phone:"",notes:"",firstSeen:"2026-03-16",source:"import"},
{id:"imp_c310",name:"Clara Paule Thiery",mergedNames:[],nationality:"France",passport:"17C129924",phone:"",notes:"",firstSeen:"2026-03-17",source:"import"},
{id:"imp_c311",name:"Adomas Krunevicius",mergedNames:[],nationality:"Lituania",passport:"27176173.0",phone:"",notes:"",firstSeen:"2026-03-17",source:"import"},
{id:"imp_c312",name:"Allina Nicolis",mergedNames:[],nationality:"Australia",passport:"PA9974396",phone:"",notes:"",firstSeen:"2026-03-18",source:"import"},
{id:"imp_c313",name:"Dovydas Rokas",mergedNames:[],nationality:"Lituania",passport:"25204710.0",phone:"",notes:"",firstSeen:"2026-03-19",source:"import"},
{id:"imp_c314",name:"Jonathan Tristan Yong Phelps",mergedNames:[],nationality:"Australia",passport:"RA3387301",phone:"",notes:"",firstSeen:"2026-03-19",source:"import"},
{id:"imp_c315",name:"Ms.Franziska Thinius",mergedNames:[],nationality:"Germany",passport:"C3T4LFTCH",phone:"",notes:"",firstSeen:"2026-03-22",source:"import"},
{id:"imp_c316",name:"Valentin Paul Kainz",mergedNames:[],nationality:"Germany",passport:"C9TNH22Y6",phone:"",notes:"",firstSeen:"2026-03-23",source:"import"},
{id:"imp_c317",name:"Jakob Meyland",mergedNames:[],nationality:"Denmark",passport:"216195811.0",phone:"",notes:"",firstSeen:"2026-03-23",source:"import"},
{id:"imp_c318",name:"Huang Qiaoling",mergedNames:[],nationality:"Chinese",passport:"EK6561725",phone:"",notes:"",firstSeen:"2026-03-24",source:"import"},
{id:"imp_c319",name:"Mr.Gregory Gabriel Barabas",mergedNames:[],nationality:"France",passport:"24EH44530",phone:"",notes:"",firstSeen:"2026-03-24",source:"import"},
{id:"imp_c320",name:"Rebecca Louise Nunan",mergedNames:[],nationality:"Australia",passport:"RA5999098",phone:"",notes:"",firstSeen:"2026-03-24",source:"import"},
{id:"imp_c321",name:"Mohamed Tahar Chemaou",mergedNames:[],nationality:"France",passport:"24ID04907",phone:"",notes:"",firstSeen:"2026-03-25",source:"import"},
{id:"imp_c322",name:"Martinus Jeffrey Ariawan",mergedNames:[],nationality:"Indonisia",passport:"E7276914",phone:"",notes:"",firstSeen:"2026-03-26",source:"import"},
{id:"imp_c323",name:"Zwe Thu Rein",mergedNames:[],nationality:"Burmese",passport:null,phone:"",notes:"",firstSeen:"2026-03-27",source:"import"},
{id:"imp_c324",name:"Mr.Alhumaidi Abdulaziz Abdullah J",mergedNames:[],nationality:"Saudi Arabia",passport:"AK04521",phone:"",notes:"",firstSeen:"2026-03-29",source:"import"},
{id:"imp_c325",name:"Zhan Qilin (mumu)",mergedNames:[],nationality:"Chinese",passport:"ER4464224",phone:"",notes:"",firstSeen:"2026-03-29",source:"import"},
{id:"imp_c326",name:"Erin Audrey Laramee",mergedNames:[],nationality:"USA",passport:"A46697856",phone:"",notes:"",firstSeen:"2026-03-30",source:"import"},
{id:"imp_c327",name:"Majnheiv Sainfort",mergedNames:[],nationality:"USA",passport:"566596767.0",phone:"",notes:"",firstSeen:"2026-03-30",source:"import"},
{id:"imp_c328",name:"Ronald Duncan Hamilton",mergedNames:[],nationality:"USA",passport:"564119304.0",phone:"",notes:"",firstSeen:"2026-03-30",source:"import"},
{id:"imp_c329",name:"Ms.Damar Kentjana Isherwood",mergedNames:[],nationality:"Australia",passport:"PB5721453",phone:"",notes:"",firstSeen:"2026-03-31",source:"import"},
{id:"imp_c330",name:"Attis Jovan Rudolphe Bijleveld",mergedNames:[],nationality:"Switzerland",passport:"X6867671",phone:"",notes:"",firstSeen:"2026-03-31",source:"import"},
{id:"imp_c331",name:"Mr.Christian August Oellers",mergedNames:[],nationality:"Germany",passport:"C6YR8F293",phone:"",notes:"",firstSeen:"2026-04-07",source:"import"},
{id:"imp_c332",name:"Mr.Calogero Audino",mergedNames:[],nationality:"Belgium",passport:"GA8144919",phone:"",notes:"",firstSeen:"2026-04-07",source:"import"},
{id:"imp_c333",name:"Nicolas Vincent Parra",mergedNames:[],nationality:"France",passport:"17EE49672",phone:"",notes:"",firstSeen:"2026-04-09",source:"import"},
{id:"imp_c334",name:"Niklas Mulhaupt",mergedNames:[],nationality:"Germany",passport:"C9HPZVH4N",phone:"",notes:"",firstSeen:"2026-04-09",source:"import"},
{id:"imp_c335",name:"Elliot Thomas Coates",mergedNames:[],nationality:"UK",passport:"157675069.0",phone:"",notes:"",firstSeen:"2026-04-09",source:"import"},
{id:"imp_c336",name:"William Liange",mergedNames:[],nationality:"France",passport:"23HK74225",phone:"",notes:"",firstSeen:"2026-04-09",source:"import"},
{id:"imp_c337",name:"Liangfu Zhou",mergedNames:[],nationality:"China",passport:"EP0522633",phone:"",notes:"",firstSeen:"2026-04-11",source:"import"},
{id:"imp_c338",name:"Mr.Pyay Phyo OO",mergedNames:[],nationality:"Myanmar",passport:"MF782344",phone:"",notes:"",firstSeen:"2026-04-11",source:"import"},
{id:"imp_c339",name:"Mr.Arron David Ryan",mergedNames:[],nationality:"UK",passport:"156305113.0",phone:"",notes:"",firstSeen:"2026-04-12",source:"import"},
{id:"imp_c340",name:"Mr.Petro Maria Moreira Nogueira",mergedNames:[],nationality:"Portugues",passport:"CC702234",phone:"",notes:"",firstSeen:"2026-04-15",source:"import"},
{id:"imp_c341",name:"Ferit Yilmaz",mergedNames:[],nationality:"Netherland",passport:"NMDJ488L2",phone:"",notes:"",firstSeen:"2026-04-17",source:"import"},
{id:"imp_c342",name:"Matcha Yasamut",mergedNames:[],nationality:"Thai",passport:"68011499.0",phone:"",notes:"",firstSeen:"2026-04-18",source:"import"},
{id:"imp_c343",name:"Hadrien David Auguste Cazier",mergedNames:[],nationality:"France",passport:"22HA90790",phone:"",notes:"",firstSeen:"2026-04-18",source:"import"},
{id:"imp_c344",name:"Mr.Alexandru- Nicusor Epure",mergedNames:[],nationality:"Romania",passport:"59430144.0",phone:"",notes:"",firstSeen:"2026-04-20",source:"import"},
{id:"imp_c345",name:"Alexander Vincent Torre",mergedNames:[],nationality:"USA",passport:"A54819589",phone:"",notes:"",firstSeen:"2026-05-01",source:"import"},
{id:"imp_c346",name:"Wai Kim Liu",mergedNames:[],nationality:"Ireland",passport:"130907462.0",phone:"",notes:"",firstSeen:"2026-04-24",source:"import"},
{id:"imp_c347",name:"Bo-Anthony Bogers",mergedNames:[],nationality:"Netherland",passport:"NWJC5F631",phone:"",notes:"",firstSeen:"2026-04-24",source:"import"},
{id:"imp_c348",name:"Antonio Cascio",mergedNames:[],nationality:"Italy",passport:"YB2375959",phone:"",notes:"",firstSeen:"2026-04-25",source:"import"},
{id:"imp_c349",name:"Ye Changzhan",mergedNames:[],nationality:"Chinese",passport:"EF8645171",phone:"",notes:"",firstSeen:"2026-04-25",source:"import"},
{id:"imp_c350",name:"Lubin Pierre Simon Jouan",mergedNames:[],nationality:"France",passport:"23CR18642",phone:"",notes:"",firstSeen:"2026-04-26",source:"import"},
{id:"imp_c351",name:"Telio Henaff",mergedNames:["Teilo Henaff"],nationality:"France",passport:"22HA61086",phone:"",notes:"",firstSeen:"2026-04-26",source:"import"},
{id:"imp_c352",name:"Juliette Guillon",mergedNames:[],nationality:"France",passport:"26CE35197",phone:"",notes:"",firstSeen:"2026-04-27",source:"import"},
{id:"imp_c353",name:"Yuki Nowak",mergedNames:[],nationality:"Poland",passport:"FH3402515",phone:"",notes:"",firstSeen:"2026-04-27",source:"import"},
{id:"imp_c354",name:"Jared Anthony Shipp",mergedNames:[],nationality:"USA",passport:"A64197281",phone:"",notes:"",firstSeen:"2026-04-30",source:"import"},
{id:"imp_c355",name:"Arbind Shakya",mergedNames:[],nationality:"Nepal",passport:"11786683.0",phone:"",notes:"",firstSeen:"2026-04-30",source:"import"},
{id:"imp_c356",name:"Mylo Chante Ferrier",mergedNames:[],nationality:"Netherland",passport:"NS9735B46",phone:"",notes:"",firstSeen:"2026-05-01",source:"import"},
{id:"imp_c357",name:"Luke Alexander Allsopp",mergedNames:[],nationality:"UK",passport:"141599845.0",phone:"",notes:"",firstSeen:"2026-05-04",source:"import"},
{id:"imp_c358",name:"Mohamed Shafiq Bin Jawead",mergedNames:[],nationality:"Malaysia",passport:"A56690968",phone:"",notes:"",firstSeen:"2026-05-05",source:"import"},
{id:"imp_c359",name:"Tishauna Sakeila Bailey Kennedy",mergedNames:[],nationality:"USA",passport:"A35885926",phone:"",notes:"",firstSeen:"2026-05-05",source:"import"},
{id:"imp_c360",name:"Lee Jer Yan",mergedNames:[],nationality:"Malaysia",passport:"A59718774",phone:"",notes:"",firstSeen:"2026-05-06",source:"import"},
{id:"imp_c361",name:"Angkana Bamber",mergedNames:[],nationality:"Thai",passport:"AC2299854",phone:"",notes:"",firstSeen:"2026-05-06",source:"import"},
{id:"imp_c362",name:"Yukun Chen",mergedNames:[],nationality:"Chinese",passport:"EM5052843",phone:"",notes:"",firstSeen:"2026-05-06",source:"import"},
{id:"imp_c363",name:"Kathryn Janine Noble",mergedNames:[],nationality:"UK",passport:"538843570.0",phone:"",notes:"",firstSeen:"2026-05-07",source:"import"},
{id:"imp_c364",name:"Hugo Peyre",mergedNames:[],nationality:"France",passport:"25AD22725",phone:"",notes:"",firstSeen:"2026-05-07",source:"import"},
{id:"imp_c365",name:"Rohit Dayanand Nimbalkar",mergedNames:[],nationality:"India",passport:"P8744193",phone:"",notes:"",firstSeen:"2026-05-07",source:"import"},
{id:"imp_c366",name:"Benjamin George Hargreves",mergedNames:[],nationality:"UK",passport:"131767421.0",phone:"",notes:"",firstSeen:"2026-05-07",source:"import"},
{id:"imp_c367",name:"Cetin Yonca",mergedNames:[],nationality:"Netherland",passport:"NYCH7C9L3",phone:"",notes:"",firstSeen:"2026-05-08",source:"import"},
{id:"imp_c368",name:"Albina Vafina",mergedNames:[],nationality:"Russia",passport:"75 6056615",phone:"",notes:"",firstSeen:"2026-05-08",source:"import"},
{id:"imp_c369",name:"Benjamin Lindon Smith",mergedNames:[],nationality:"UK",passport:"1300639925.0",phone:"",notes:"",firstSeen:"2026-05-11",source:"import"},
{id:"imp_c370",name:"Mr.Antoine Pierre A Missuwe",mergedNames:[],nationality:"Belgium",passport:"GC9517837",phone:"",notes:"",firstSeen:"2026-05-11",source:"import"},
{id:"imp_c371",name:"Mr.Paul Pierre Richard Lamayle",mergedNames:[],nationality:"France",passport:"23E141580",phone:"",notes:"",firstSeen:"2026-05-12",source:"import"},
{id:"imp_c372",name:"Leonard Karl Zandbergen",mergedNames:[],nationality:"Luxembourg",passport:"LC3E4C5F",phone:"",notes:"",firstSeen:"2026-05-13",source:"import"},
{id:"imp_c373",name:"Alexandre Meira Domingues",mergedNames:[],nationality:"Portugul",passport:"CE573797",phone:"",notes:"",firstSeen:"2026-05-18",source:"import"},
{id:"imp_c374",name:"Ms.Aalyiyah Celeste Handal",mergedNames:[],nationality:"USA",passport:"680212827.0",phone:"",notes:"",firstSeen:"2026-05-20",source:"import"},
{id:"imp_c375",name:"Ms.Jillian Mary Fox",mergedNames:[],nationality:"USA",passport:"A26413024",phone:"",notes:"",firstSeen:"2026-05-20",source:"import"},
{id:"imp_c376",name:"Marvin Meyer Lowe",mergedNames:[],nationality:"Germany",passport:"C2CTY2RYM",phone:"",notes:"",firstSeen:"2026-05-20",source:"import"},
{id:"imp_c377",name:"Martin Yukang Hanley",mergedNames:[],nationality:"Australia",passport:"PB5727481",phone:"",notes:"",firstSeen:"2026-05-21",source:"import"},
{id:"imp_c378",name:"Morgane Celine Estelle Geraudie",mergedNames:[],nationality:"France",passport:"23EC82489",phone:"",notes:"",firstSeen:"2026-05-23",source:"import"},
{id:"imp_c379",name:"Art Chepra",mergedNames:[],nationality:"USA",passport:"561145899.0",phone:"",notes:"",firstSeen:"2026-05-23",source:"import"},
{id:"imp_c380",name:"Gregory James Spruill",mergedNames:[],nationality:"USA",passport:"A73610335",phone:"",notes:"",firstSeen:"2026-05-25",source:"import"},
{id:"imp_c381",name:"Riyad Bouazer",mergedNames:[],nationality:"Canada",passport:"P216899HO",phone:"",notes:"",firstSeen:"2026-05-25",source:"import"},
{id:"imp_c382",name:"Romeo Manuel Bartholomeus",mergedNames:[],nationality:"Netherland",passport:"NRCHRRDg",phone:"",notes:"",firstSeen:"2026-05-27",source:"import"},
{id:"imp_c383",name:"Aldi Rama",mergedNames:[],nationality:"Indonesia",passport:"X1681517",phone:"",notes:"",firstSeen:"2026-05-27",source:"import"},
{id:"imp_c384",name:"Anthony Fusto",mergedNames:[],nationality:"Thai Driving Lisence",passport:"67011028.0",phone:"",notes:"",firstSeen:"2026-05-30",source:"import"},
{id:"imp_c385",name:"Andrears Markus Kahlert",mergedNames:[],nationality:"Germany",passport:"C293TL126",phone:"",notes:"",firstSeen:"2026-05-31",source:"import"},
{id:"imp_c386",name:"Renat Ibragimov",mergedNames:[],nationality:"Russian",passport:"55 0101294",phone:"",notes:"",firstSeen:"2026-06-01",source:"import"},
{id:"imp_c387",name:"Vynerfes Valerian",mergedNames:[],nationality:"Malaysia",passport:"H55817848",phone:"",notes:"",firstSeen:"2026-06-01",source:"import"},
{id:"imp_c388",name:"Panida Boonthep",mergedNames:[],nationality:"Thai",passport:"5 5505 00204 07 8",phone:"",notes:"",firstSeen:"2026-06-01",source:"import"},
{id:"imp_c389",name:"Miss.Khalidah Erica Campbell",mergedNames:[],nationality:"USA",passport:"A81620762",phone:"",notes:"",firstSeen:"2026-06-01",source:"import"},
{id:"imp_c390",name:"Thana Charoenkaew",mergedNames:[],nationality:"Thai",passport:"1 9098 02919 68 3",phone:"",notes:"",firstSeen:"2026-06-02",source:"import"},
{id:"imp_c391",name:"Nicole Patrizia Dolezych",mergedNames:[],nationality:"Germany",passport:"C5HX6W4PZ",phone:"",notes:"",firstSeen:"2026-06-04",source:"import"},
{id:"imp_c392",name:"Mr.Louis Dominik Peter",mergedNames:[],nationality:"Germany",passport:"C349NVZVW",phone:"",notes:"",firstSeen:"2026-06-04",source:"import"},
{id:"imp_c393",name:"Nathan James Scarrott",mergedNames:[],nationality:"UK",passport:"130986772.0",phone:"",notes:"",firstSeen:"2026-06-06",source:"import"},
{id:"imp_c394",name:"Hugo Fragne-Benaissi",mergedNames:[],nationality:"France",passport:"2DED33903",phone:"",notes:"",firstSeen:"2026-06-08",source:"import"},
{id:"imp_c395",name:"Grant Christian Inman",mergedNames:[],nationality:"USA",passport:"A67973703",phone:"",notes:"",firstSeen:"2026-06-11",source:"import"},
{id:"imp_c396",name:"Filip Rubenov Filipov",mergedNames:[],nationality:"Bulgaria",passport:"388747303.0",phone:"",notes:"",firstSeen:"2026-06-11",source:"import"},
{id:"imp_c397",name:"Mr.Matthew Joseph Gordon Mcmullin",mergedNames:[],nationality:"Canada",passport:"HM490925",phone:"",notes:"",firstSeen:"2026-06-12",source:"import"},
{id:"imp_c398",name:"Mr.Antoine Jean Allain",mergedNames:[],nationality:"France",passport:"18HC92788",phone:"",notes:"",firstSeen:"2026-06-15",source:"import"},
{id:"imp_c399",name:"Souad Lazar",mergedNames:[],nationality:"France",passport:"241K82446",phone:"",notes:"",firstSeen:"2026-06-16",source:"import"},
{id:"imp_c400",name:"Mr.Pedro Vicente Fernandes Prado",mergedNames:[],nationality:"Brazilian",passport:"GN449041",phone:"",notes:"",firstSeen:"2026-06-16",source:"import"},
{id:"imp_c401",name:"Timothy David Lemkuil",mergedNames:[],nationality:"USA",passport:"A75760861",phone:"",notes:"",firstSeen:"2026-06-17",source:"import"},
{id:"imp_c402",name:"Carlo Dominic Berry",mergedNames:[],nationality:"UK",passport:"140264192.0",phone:"",notes:"",firstSeen:"2026-06-17",source:"import"},
{id:"imp_c403",name:"Nicolas Quillevere",mergedNames:[],nationality:"France",passport:"23DD83579",phone:"",notes:"",firstSeen:"2026-06-18",source:"import"},
{id:"imp_c404",name:"Kaito Otomo",mergedNames:[],nationality:"Japan",passport:"TT2272866",phone:"",notes:"",firstSeen:"2026-06-19",source:"import"},
{id:"imp_c405",name:"Chu Lueng Chu",mergedNames:[],nationality:"China",passport:"H21155754",phone:"",notes:"",firstSeen:"2026-06-22",source:"import"},
{id:"imp_c406",name:"Emilien Pierre Celestin Delecroix",mergedNames:[],nationality:"France",passport:"26DF64313",phone:"",notes:"",firstSeen:"2026-06-23",source:"import"},
{id:"imp_c407",name:"Harsh Bajpai",mergedNames:[],nationality:"India",passport:"Z7069942",phone:"",notes:"",firstSeen:"2026-06-24",source:"import"},
{id:"imp_c408",name:"Paul Anthony Dzingarov-chubb",mergedNames:[],nationality:"UK",passport:"560942184.0",phone:"",notes:"",firstSeen:"2026-06-26",source:"import"},
{id:"imp_c409",name:"Murtadha Ramzi Subhi Al Maroof",mergedNames:[],nationality:"Canada",passport:"AM892474",phone:"",notes:"",firstSeen:"2026-06-27",source:"import"},
{id:"imp_c410",name:"Morgane Michelle Claudia Poulain",mergedNames:[],nationality:"France",passport:"19DK87008",phone:"",notes:"",firstSeen:"2026-06-28",source:"import"},
{id:"imp_c411",name:"Andrew Robert Thompson",mergedNames:[],nationality:"UK",passport:"148545865.0",phone:"",notes:"",firstSeen:"2026-06-29",source:"import"},
{id:"imp_c412",name:"Sean Francis Brochmann",mergedNames:[],nationality:"USA",passport:"583938186.0",phone:"",notes:"",firstSeen:"2026-06-30",source:"import"},
{id:"imp_c413",name:"Jade Diana Askew",mergedNames:[],nationality:"UK",passport:"543741665.0",phone:"",notes:"",firstSeen:"2026-07-01",source:"import"},
{id:"imp_c414",name:"Yang Liu",mergedNames:[],nationality:"Chinese",passport:"EQ0694953",phone:"",notes:"",firstSeen:"2026-07-03",source:"import"},
{id:"imp_c415",name:"Mr.Mounir Michael Chraibi",mergedNames:[],nationality:"France",passport:"24DF20589",phone:"",notes:"",firstSeen:"2026-07-04",source:"import"},
{id:"imp_c416",name:"Mr.Ding Hairui",mergedNames:[],nationality:"China",passport:"EN9475837",phone:"",notes:"",firstSeen:"2026-07-06",source:"import"},
{id:"imp_c417",name:"Sam Robert Kennedy",mergedNames:[],nationality:"United Kingdom",passport:"158411204.0",phone:"",notes:"",firstSeen:"2026-07-08",source:"import"},
{id:"imp_c418",name:"Paris Denver Senior",mergedNames:[],nationality:"United Kingdom",passport:"154117813.0",phone:"",notes:"",firstSeen:"2026-07-08",source:"import"},
{id:"imp_c419",name:"Yen Jen Chen",mergedNames:[],nationality:"China",passport:"365573365.0",phone:"",notes:"",firstSeen:"2026-07-09",source:"import"},
{id:"imp_c420",name:"KADILYN DEL KNIEF",mergedNames:[],nationality:"United States",passport:"585933910.0",phone:"",notes:"",firstSeen:"2026-07-11",source:"import"},
{id:"imp_c421",name:"SCOTT ADAM KELLY",mergedNames:[],nationality:"Australia",passport:"RB2612658",phone:"",notes:"",firstSeen:"2026-07-13",source:"import"},
{id:"imp_c422",name:"Zvi Gur",mergedNames:[],nationality:"Israel",passport:"40830022.0",phone:"",notes:"",firstSeen:"2026-07-15",source:"import"},
{id:"imp_c423",name:"Xue Feng",mergedNames:[],nationality:"China",passport:"EM7897341",phone:"",notes:"",firstSeen:"2026-07-16",source:"import"},
{id:"imp_c424",name:"Joseph Martin",mergedNames:[],nationality:"United Kingdom",passport:"142465661.0",phone:"",notes:"",firstSeen:"2026-07-17",source:"import"},
{id:"imp_c425",name:"Amin Karimi Malekabadi",mergedNames:[],nationality:"Brazil",passport:"GM960663",phone:"",notes:"",firstSeen:"2026-07-18",source:"import"},
{id:"imp_c426",name:"Kim Kassandra Henke",mergedNames:[],nationality:"Germany",passport:"C3MJKNYNJ",phone:"",notes:"",firstSeen:"2026-07-24",source:"import"},
{id:"imp_c427",name:"Elden Campbell Wrightson",mergedNames:[],nationality:"United Kingdom",passport:"310197319.0",phone:"",notes:"",firstSeen:"2026-07-25",source:"import"},
{id:"imp_c428",name:"Charlotte Alice Genevieve Vienot",mergedNames:[],nationality:"France",passport:"17EK461627",phone:"",notes:"",firstSeen:"2026-07-26",source:"import"},
{id:"imp_c429",name:"Samuel Harold Edwards",mergedNames:[],nationality:"Australia",passport:"PB4798449",phone:"",notes:"",firstSeen:"2026-07-28",source:"import"},
{id:"imp_c430",name:"Yassine Zagri",mergedNames:[],nationality:"Morocco",passport:"WR5607572",phone:"",notes:"",firstSeen:"2026-08-01",source:"import"},
{id:"imp_c431",name:"Omer Primo",mergedNames:[],nationality:"Portugal",passport:"CH036942",phone:"",notes:"",firstSeen:"2026-08-02",source:"import"},
{id:"imp_c432",name:"Daniel Eduardo Serrati",mergedNames:[],nationality:"Argentina",passport:"AAF538398",phone:"",notes:"",firstSeen:"2026-08-05",source:"import"},
{id:"imp_c433",name:"Kangyu Li",mergedNames:[],nationality:"China",passport:"EA5824695",phone:"",notes:"",firstSeen:"2026-08-06",source:"import"},
{id:"imp_c434",name:"Leonid Nakonechnyi",mergedNames:[],nationality:"Ukraine",passport:"FL737639",phone:"",notes:"",firstSeen:"2026-08-06",source:"import"},
];

const IMPORTED_RENTALS = [
{id:"imp_r1",customerId:"imp_c1",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-02-02",endDate:"2025-02-10",bookedDays:8,paidDays:8,revenue:5700.0,status:"completed",sourceRows:["Customer list 2025 row 2"],pendingReviewBoundary:false},
{id:"imp_r2",customerId:"imp_c2",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2025-02-27",endDate:"2025-02-27",bookedDays:1,paidDays:1,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 3"],pendingReviewBoundary:false},
{id:"imp_r3",customerId:"imp_c3",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2025-03-05",endDate:"2025-03-07",bookedDays:2,paidDays:2,revenue:800.0,status:"completed",sourceRows:["Customer list 2025 row 5"],pendingReviewBoundary:false},
{id:"imp_r4",customerId:"imp_c4",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-03-06",endDate:"2025-03-10",bookedDays:3,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2025 row 6","Customer list 2025 row 10"],pendingReviewBoundary:false},
{id:"imp_r5",customerId:"imp_c5",bikeModel:"Aerox Standard",bikeNameRaw:"Click Red",plate:"",startDate:"2025-03-07",endDate:"2025-03-09",bookedDays:2,paidDays:2,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 7"],pendingReviewBoundary:false},
{id:"imp_r6",customerId:"imp_c6",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2025-03-07",endDate:"2025-03-28",bookedDays:21,paidDays:21,revenue:4000.0,status:"completed",sourceRows:["Customer list 2025 row 8"],pendingReviewBoundary:false},
{id:"imp_r7",customerId:"imp_c7",bikeModel:"Aerox Standard",bikeNameRaw:"Click red",plate:"",startDate:"2025-03-09",endDate:"2025-06-09",bookedDays:61,paidDays:92,revenue:8500.0,status:"completed",sourceRows:["Customer list 2025 row 9","Customer list 2025 row 48"],pendingReviewBoundary:false},
{id:"imp_r8",customerId:"imp_c8",bikeModel:"NMAX",bikeNameRaw:"Nmax",plate:"",startDate:"2025-03-10",endDate:"2025-03-16",bookedDays:6,paidDays:6,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 11"],pendingReviewBoundary:false},
{id:"imp_r9",customerId:"imp_c9",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-03-10",endDate:"2025-03-22",bookedDays:12,paidDays:12,revenue:2650.0,status:"completed",sourceRows:["Customer list 2025 row 12"],pendingReviewBoundary:false},
{id:"imp_r10",customerId:"imp_c10",bikeModel:"Aerox Standard",bikeNameRaw:"Click Red",plate:"",startDate:"2025-03-10",endDate:"2025-03-22",bookedDays:12,paidDays:12,revenue:1900.0,status:"completed",sourceRows:["Customer list 2025 row 13"],pendingReviewBoundary:false},
{id:"imp_r11",customerId:"imp_c11",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-03-14",endDate:"2025-03-15",bookedDays:1,paidDays:1,revenue:500.0,status:"completed",sourceRows:["Customer list 2025 row 14"],pendingReviewBoundary:false},
{id:"imp_r12",customerId:"imp_c12",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Red",plate:"",startDate:"2025-03-15",endDate:"2025-03-16",bookedDays:1,paidDays:1,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 15"],pendingReviewBoundary:false},
{id:"imp_r13",customerId:"imp_c13",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue / change to red",plate:"",startDate:"2025-03-17",endDate:"2025-04-16",bookedDays:30,paidDays:30,revenue:4000.0,status:"completed",sourceRows:["Customer list 2025 row 16"],pendingReviewBoundary:false},
{id:"imp_r14",customerId:"imp_c13",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-04-27",endDate:"2025-05-14",bookedDays:5,paidDays:17,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 40","Customer list 2025 row 44"],pendingReviewBoundary:false},
{id:"imp_r15",customerId:"imp_c14",bikeModel:"NMAX",bikeNameRaw:"Nmax",plate:"",startDate:"2025-03-20",endDate:"2025-06-13",bookedDays:58,paidDays:85,revenue:11200.0,status:"completed",sourceRows:["Customer list 2025 row 17","Customer list 2025 row 53","Customer list 2025 row 65"],pendingReviewBoundary:false},
{id:"imp_r16",customerId:"imp_c15",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-03-20",endDate:"2025-03-22",bookedDays:2,paidDays:2,revenue:700.0,status:"completed",sourceRows:["Customer list 2025 row 18"],pendingReviewBoundary:false},
{id:"imp_r17",customerId:"imp_c16",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Red",plate:"",startDate:"2025-03-22",endDate:"2025-03-27",bookedDays:5,paidDays:5,revenue:1800.0,status:"completed",sourceRows:["Customer list 2025 row 19"],pendingReviewBoundary:false},
{id:"imp_r18",customerId:"imp_c17",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-03-22",endDate:"2025-03-27",bookedDays:5,paidDays:5,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 20"],pendingReviewBoundary:false},
{id:"imp_r19",customerId:"imp_c18",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-03-29",endDate:"2025-04-22",bookedDays:24,paidDays:24,revenue:2700.0,status:"completed",sourceRows:["Customer list 2025 row 21"],pendingReviewBoundary:false},
{id:"imp_r20",customerId:"imp_c19",bikeModel:"Aerox Standard",bikeNameRaw:"Click Red",plate:"",startDate:"2025-03-29",endDate:"2025-04-22",bookedDays:24,paidDays:24,revenue:2550.0,status:"completed",sourceRows:["Customer list 2025 row 22"],pendingReviewBoundary:false},
{id:"imp_r21",customerId:"imp_c20",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-03-30",endDate:"2025-04-27",bookedDays:28,paidDays:28,revenue:3500.0,status:"completed",sourceRows:["Customer list 2025 row 23"],pendingReviewBoundary:false},
{id:"imp_r22",customerId:"imp_c21",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-03-31",endDate:"2025-04-04",bookedDays:3,paidDays:4,revenue:1350.0,status:"completed",sourceRows:["Customer list 2025 row 27","Customer list 2025 row 24"],pendingReviewBoundary:false},
{id:"imp_r23",customerId:"imp_c22",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2025-04-01",endDate:"2025-04-05",bookedDays:4,paidDays:4,revenue:1600.0,status:"completed",sourceRows:["Customer list 2025 row 26"],pendingReviewBoundary:false},
{id:"imp_r24",customerId:"imp_c23",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-04-03",endDate:"2025-04-10",bookedDays:7,paidDays:7,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 28"],pendingReviewBoundary:false},
{id:"imp_r25",customerId:"imp_c24",bikeModel:"Aerox Standard",bikeNameRaw:"GT2",plate:"",startDate:"2025-04-07",endDate:"2025-04-13",bookedDays:6,paidDays:6,revenue:1380.0,status:"completed",sourceRows:["Customer list 2025 row 29"],pendingReviewBoundary:false},
{id:"imp_r26",customerId:"imp_c24",bikeModel:"Aerox Standard",bikeNameRaw:"GT 4 Red",plate:"",startDate:"2025-05-14",endDate:"2025-05-22",bookedDays:6,paidDays:8,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 57","Customer list 2025 row 59"],pendingReviewBoundary:false},
{id:"imp_r27",customerId:"imp_c25",bikeModel:"Aerox Standard",bikeNameRaw:"GT mint",plate:"",startDate:"2025-04-08",endDate:"2025-07-28",bookedDays:61,paidDays:111,revenue:7500.0,status:"completed",sourceRows:["Customer list 2025 row 30","Customer list 2025 row 85","Customer list 2025 row 126"],pendingReviewBoundary:false},
{id:"imp_r28",customerId:"imp_c25",bikeModel:"Aerox Standard",bikeNameRaw:"GT Red 2",plate:"",startDate:"2025-09-16",endDate:"2025-11-30",bookedDays:30,paidDays:75,revenue:5200.0,status:"completed",sourceRows:["Customer list 2025 row 224","Customer list 2025 row 268","Customer list 2025 row 314"],pendingReviewBoundary:false},
{id:"imp_r29",customerId:"imp_c25",bikeModel:"Aerox Standard",bikeNameRaw:"GT Burgandy",plate:"",startDate:"2025-12-26",endDate:"2026-03-26",bookedDays:31,paidDays:90,revenue:10000.0,status:"completed",sourceRows:["Customer list 2025 row 391","Customer list 2026 row 34","Customer list 2026 row 80","Customer list 2026 row 130"],pendingReviewBoundary:false},
{id:"imp_r30",customerId:"imp_c26",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-04-11",endDate:"2025-04-17",bookedDays:6,paidDays:6,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 31"],pendingReviewBoundary:false},
{id:"imp_r31",customerId:"imp_c27",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-04-12",endDate:"2025-04-13",bookedDays:1,paidDays:1,revenue:500.0,status:"completed",sourceRows:["Customer list 2025 row 32"],pendingReviewBoundary:false},
{id:"imp_r32",customerId:"imp_c28",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-04-13",endDate:"2025-04-18",bookedDays:5,paidDays:5,revenue:1600.0,status:"completed",sourceRows:["Customer list 2025 row 33"],pendingReviewBoundary:false},
{id:"imp_r33",customerId:"imp_c29",bikeModel:"Aerox Standard",bikeNameRaw:"GT2",plate:"",startDate:"2025-04-18",endDate:"2025-04-18",bookedDays:1,paidDays:1,revenue:200.0,status:"completed",sourceRows:["Customer list 2025 row 34"],pendingReviewBoundary:false},
{id:"imp_r34",customerId:"imp_c30",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-04-19",endDate:"2025-04-27",bookedDays:8,paidDays:8,revenue:4750.0,status:"completed",sourceRows:["Customer list 2025 row 35"],pendingReviewBoundary:false},
{id:"imp_r35",customerId:"imp_c31",bikeModel:"Aerox Standard",bikeNameRaw:"GT red",plate:"",startDate:"2025-04-23",endDate:"2025-05-14",bookedDays:21,paidDays:21,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 36"],pendingReviewBoundary:false},
{id:"imp_r36",customerId:"imp_c32",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-04-24",endDate:"2025-05-18",bookedDays:24,paidDays:24,revenue:2300.0,status:"completed",sourceRows:["Customer list 2025 row 37"],pendingReviewBoundary:false},
{id:"imp_r37",customerId:"imp_c33",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Red",plate:"",startDate:"2025-04-24",endDate:"2025-05-22",bookedDays:5,paidDays:28,revenue:3800.0,status:"completed",sourceRows:["Customer list 2025 row 38","Customer list 2025 row 41"],pendingReviewBoundary:false},
{id:"imp_r38",customerId:"imp_c34",bikeModel:"Aerox Standard",bikeNameRaw:"GT2",plate:"",startDate:"2025-04-27",endDate:"2025-04-29",bookedDays:2,paidDays:2,revenue:500.0,status:"completed",sourceRows:["Customer list 2025 row 39"],pendingReviewBoundary:false},
{id:"imp_r39",customerId:"imp_c35",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-05-01",endDate:"2025-05-29",bookedDays:14,paidDays:28,revenue:4500.0,status:"completed",sourceRows:["Customer list 2025 row 43","Customer list 2025 row 56"],pendingReviewBoundary:false},
{id:"imp_r40",customerId:"imp_c35",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox black",plate:"",startDate:"2025-06-09",endDate:"2025-07-09",bookedDays:30,paidDays:30,revenue:3850.0,status:"completed",sourceRows:["Customer list 2025 row 82"],pendingReviewBoundary:false},
{id:"imp_r41",customerId:"imp_c35",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-07-24",endDate:"2025-09-07",bookedDays:31,paidDays:45,revenue:4800.0,status:"completed",sourceRows:["Customer list 2025 row 152","Customer list 2025 row 183"],pendingReviewBoundary:false},
{id:"imp_r42",customerId:"imp_c36",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-05-02",endDate:"2025-05-05",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 45"],pendingReviewBoundary:false},
{id:"imp_r43",customerId:"imp_c37",bikeModel:"Aerox Standard",bikeNameRaw:"GT 5 mint",plate:"",startDate:"2025-05-05",endDate:"2025-05-08",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 46"],pendingReviewBoundary:false},
{id:"imp_r44",customerId:"imp_c38",bikeModel:"Aerox Standard",bikeNameRaw:"GT 5",plate:"",startDate:"2025-05-05",endDate:"2025-05-08",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 47"],pendingReviewBoundary:false},
{id:"imp_r45",customerId:"imp_c39",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-05-08",endDate:"2025-05-11",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 49"],pendingReviewBoundary:false},
{id:"imp_r46",customerId:"imp_c40",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-05-08",endDate:"2025-06-08",bookedDays:31,paidDays:31,revenue:3500.0,status:"completed",sourceRows:["Customer list 2025 row 51"],pendingReviewBoundary:false},
{id:"imp_r47",customerId:"imp_c41",bikeModel:"Aerox Standard",bikeNameRaw:"Click red",plate:"",startDate:"2025-05-09",endDate:"2025-10-09",bookedDays:31,paidDays:153,revenue:12500.0,status:"completed",sourceRows:["Customer list 2025 row 52","Customer list 2025 row 81","Customer list 2025 row 127","Customer list 2025 row 174","Customer list 2025 row 211"],pendingReviewBoundary:false},
{id:"imp_r48",customerId:"imp_c42",bikeModel:"Aerox Standard",bikeNameRaw:"GT 5 Mint",plate:"",startDate:"2025-05-12",endDate:"2025-06-12",bookedDays:31,paidDays:31,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 54"],pendingReviewBoundary:false},
{id:"imp_r49",customerId:"imp_c43",bikeModel:"Aerox Standard",bikeNameRaw:"GT 1",plate:"",startDate:"2025-05-13",endDate:"2025-07-13",bookedDays:31,paidDays:61,revenue:5000.0,status:"completed",sourceRows:["Customer list 2025 row 55","Customer list 2025 row 87"],pendingReviewBoundary:false},
{id:"imp_r50",customerId:"imp_c44",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-05-16",endDate:"2025-05-17",bookedDays:1,paidDays:1,revenue:250.0,status:"completed",sourceRows:["Customer list 2025 row 58"],pendingReviewBoundary:false},
{id:"imp_r51",customerId:"imp_c45",bikeModel:"Aerox Standard",bikeNameRaw:"Rax 1 gold",plate:"",startDate:"2025-05-21",endDate:"2025-05-28",bookedDays:7,paidDays:7,revenue:1900.0,status:"completed",sourceRows:["Customer list 2025 row 60"],pendingReviewBoundary:false},
{id:"imp_r52",customerId:"imp_c46",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-05-21",endDate:"2025-07-21",bookedDays:31,paidDays:61,revenue:9000.0,status:"completed",sourceRows:["Customer list 2025 row 61","Customer list 2025 row 101"],pendingReviewBoundary:false},
{id:"imp_r53",customerId:"imp_c47",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-05-21",endDate:"2025-06-09",bookedDays:19,paidDays:19,revenue:1700.0,status:"completed",sourceRows:["Customer list 2025 row 62"],pendingReviewBoundary:false},
{id:"imp_r54",customerId:"imp_c48",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 1",plate:"",startDate:"2025-05-22",endDate:"2026-05-28",bookedDays:9,paidDays:371,revenue:49750.0,status:"completed",sourceRows:["Customer list 2025 row 63","Customer list 2025 row 68","Customer list 2025 row 99","Customer list 2025 row 144","Customer list 2025 row 181","Customer list 2025 row 226","Customer list 2025 row 273","Customer list 2025 row 324","Customer list 2025 row 380","Customer list 2026 row 73","Customer list 2026 row 124","Customer list 2026 row 180","Customer list 2026 row 231"],pendingReviewBoundary:false},
{id:"imp_r55",customerId:"imp_c49",bikeModel:"Aerox Standard",bikeNameRaw:"GT Red",plate:"",startDate:"2025-05-23",endDate:"2025-06-08",bookedDays:16,paidDays:16,revenue:1700.0,status:"completed",sourceRows:["Customer list 2025 row 64"],pendingReviewBoundary:false},
{id:"imp_r56",customerId:"imp_c50",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Red",plate:"",startDate:"2025-05-24",endDate:"2026-04-30",bookedDays:31,paidDays:341,revenue:39220.0,status:"completed",sourceRows:["Customer list 2025 row 66","Customer list 2025 row 105","Customer list 2025 row 151","Customer list 2025 row 185","Customer list 2025 row 230","Customer list 2025 row 278","Customer list 2025 row 329","Customer list 2025 row 359","Customer list 2026 row 78","Customer list 2026 row 126","Customer list 2026 row 185","Customer list 2026 row 229"],pendingReviewBoundary:false},
{id:"imp_r57",customerId:"imp_c51",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-05-30",endDate:"2025-06-08",bookedDays:3,paidDays:9,revenue:1930.0,status:"completed",sourceRows:["Customer list 2025 row 67","Customer list 2025 row 71","Customer list 2025 row 77"],pendingReviewBoundary:false},
{id:"imp_r58",customerId:"imp_c52",bikeModel:"Aerox Standard",bikeNameRaw:"Mio Carbu",plate:"",startDate:"2025-06-01",endDate:"2025-09-30",bookedDays:29,paidDays:121,revenue:4000.0,status:"completed",sourceRows:["Customer list 2025 row 69","Customer list 2025 row 110","Customer list 2025 row 167","Customer list 2025 row 199"],pendingReviewBoundary:false},
{id:"imp_r59",customerId:"imp_c53",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-06-01",endDate:"2025-06-02",bookedDays:1,paidDays:1,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 72"],pendingReviewBoundary:false},
{id:"imp_r60",customerId:"imp_c54",bikeModel:"Aerox Standard",bikeNameRaw:"GT Black",plate:"",startDate:"2025-06-01",endDate:"2025-07-03",bookedDays:30,paidDays:32,revenue:2700.0,status:"completed",sourceRows:["Customer list 2025 row 73","Customer list 2025 row 114"],pendingReviewBoundary:false},
{id:"imp_r61",customerId:"imp_c54",bikeModel:"Aerox Standard",bikeNameRaw:"GT mint",plate:"",startDate:"2025-07-22",endDate:"2025-12-22",bookedDays:31,paidDays:153,revenue:12500.0,status:"completed",sourceRows:["Customer list 2025 row 150","Customer list 2025 row 182","Customer list 2025 row 228","Customer list 2025 row 272","Customer list 2025 row 325"],pendingReviewBoundary:false},
{id:"imp_r62",customerId:"imp_c55",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2025-06-02",endDate:"2025-06-10",bookedDays:8,paidDays:8,revenue:1600.0,status:"completed",sourceRows:["Customer list 2025 row 74"],pendingReviewBoundary:false},
{id:"imp_r63",customerId:"imp_c56",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-06-03",endDate:"2025-07-01",bookedDays:14,paidDays:28,revenue:4000.0,status:"completed",sourceRows:["Customer list 2025 row 75","Customer list 2025 row 92"],pendingReviewBoundary:false},
{id:"imp_r64",customerId:"imp_c56",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 1",plate:"",startDate:"2025-07-06",endDate:"2025-08-22",bookedDays:31,paidDays:47,revenue:3850.0,status:"completed",sourceRows:["Customer list 2025 row 120","Customer list 2025 row 171"],pendingReviewBoundary:true},
{id:"imp_r65",customerId:"imp_c57",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-06-04",endDate:"2025-06-18",bookedDays:14,paidDays:14,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 76"],pendingReviewBoundary:false},
{id:"imp_r66",customerId:"imp_c58",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-06-06",endDate:"2025-07-16",bookedDays:9,paidDays:40,revenue:4600.0,status:"completed",sourceRows:["Customer list 2025 row 78","Customer list 2025 row 89"],pendingReviewBoundary:false},
{id:"imp_r67",customerId:"imp_c58",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 4",plate:"",startDate:"2025-08-07",endDate:"2025-10-07",bookedDays:31,paidDays:61,revenue:8600.0,status:"completed",sourceRows:["Customer list 2025 row 173","Customer list 2025 row 210","Customer list 2025 row 232"],pendingReviewBoundary:false},
{id:"imp_r68",customerId:"imp_c58",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2025-10-13",endDate:"2025-11-27",bookedDays:31,paidDays:45,revenue:6000.0,status:"completed",sourceRows:["Customer list 2025 row 259","Customer list 2025 row 310"],pendingReviewBoundary:true},
{id:"imp_r69",customerId:"imp_c58",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 1",plate:"",startDate:"2026-06-02",endDate:"2026-07-20",bookedDays:48,paidDays:48,revenue:6300.0,status:"completed",sourceRows:["Customer list 2026 row 302"],pendingReviewBoundary:false},
{id:"imp_r70",customerId:"imp_c59",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2025-06-08",endDate:"2025-06-11",bookedDays:3,paidDays:3,revenue:900.0,status:"completed",sourceRows:["Customer list 2025 row 79"],pendingReviewBoundary:false},
{id:"imp_r71",customerId:"imp_c60",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-06-08",endDate:"2025-06-10",bookedDays:2,paidDays:2,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 80"],pendingReviewBoundary:false},
{id:"imp_r72",customerId:"imp_c60",bikeModel:"Aerox Standard",bikeNameRaw:"GT red",plate:"",startDate:"2025-06-23",endDate:"2025-06-25",bookedDays:2,paidDays:2,revenue:700.0,status:"completed",sourceRows:["Customer list 2025 row 103"],pendingReviewBoundary:false},
{id:"imp_r73",customerId:"imp_c60",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2025-06-28",endDate:"2026-05-23",bookedDays:25,paidDays:329,revenue:36500.0,status:"completed",sourceRows:["Customer list 2025 row 104","Customer list 2025 row 145","Customer list 2025 row 186","Customer list 2025 row 227","Customer list 2025 row 271","Customer list 2025 row 328","Customer list 2025 row 381","Customer list 2026 row 75","Customer list 2026 row 125","Customer list 2026 row 182","Customer list 2026 row 233"],pendingReviewBoundary:true},
{id:"imp_r74",customerId:"imp_c61",bikeModel:"Aerox Standard",bikeNameRaw:"GT 1",plate:"",startDate:"2025-06-10",endDate:"2025-06-12",bookedDays:2,paidDays:2,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 83"],pendingReviewBoundary:false},
{id:"imp_r75",customerId:"imp_c62",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-06-10",endDate:"2025-08-10",bookedDays:30,paidDays:61,revenue:7000.0,status:"completed",sourceRows:["Customer list 2025 row 84","Customer list 2025 row 130"],pendingReviewBoundary:false},
{id:"imp_r76",customerId:"imp_c62",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-03-31",endDate:"2026-04-05",bookedDays:5,paidDays:5,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 205"],pendingReviewBoundary:false},
{id:"imp_r77",customerId:"imp_c63",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-06-13",endDate:"2025-07-04",bookedDays:21,paidDays:21,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 86"],pendingReviewBoundary:false},
{id:"imp_r78",customerId:"imp_c63",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 2",plate:"",startDate:"2026-05-28",endDate:"2026-06-19",bookedDays:22,paidDays:22,revenue:2750.0,status:"completed",sourceRows:["Customer list 2026 row 288"],pendingReviewBoundary:false},
{id:"imp_r79",customerId:"imp_c64",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-06-14",endDate:"2025-06-16",bookedDays:2,paidDays:2,revenue:500.0,status:"completed",sourceRows:["Customer list 2025 row 88"],pendingReviewBoundary:false},
{id:"imp_r80",customerId:"imp_c65",bikeModel:"Aerox Standard",bikeNameRaw:"N (extend 1 days)",plate:"",startDate:"2025-06-15",endDate:"2025-06-23",bookedDays:7,paidDays:8,revenue:1925.0,status:"completed",sourceRows:["Customer list 2025 row 90","Customer list 2025 row 95"],pendingReviewBoundary:false},
{id:"imp_r81",customerId:"imp_c66",bikeModel:"Aerox Standard",bikeNameRaw:"GT red",plate:"",startDate:"2025-06-17",endDate:"2025-06-19",bookedDays:2,paidDays:2,revenue:500.0,status:"completed",sourceRows:["Customer list 2025 row 91"],pendingReviewBoundary:false},
{id:"imp_r82",customerId:"imp_c67",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-06-17",endDate:"2025-07-04",bookedDays:17,paidDays:17,revenue:1700.0,status:"completed",sourceRows:["Customer list 2025 row 93"],pendingReviewBoundary:false},
{id:"imp_r83",customerId:"imp_c68",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2025-06-18",endDate:"2025-06-21",bookedDays:3,paidDays:3,revenue:900.0,status:"completed",sourceRows:["Customer list 2025 row 94"],pendingReviewBoundary:false},
{id:"imp_r84",customerId:"imp_c69",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2025-06-18",endDate:"2025-06-22",bookedDays:4,paidDays:4,revenue:900.0,status:"completed",sourceRows:["Customer list 2025 row 96"],pendingReviewBoundary:false},
{id:"imp_r85",customerId:"imp_c69",bikeModel:"Aerox Standard",bikeNameRaw:"rax red (155)",plate:"",startDate:"2026-07-05",endDate:"2026-07-10",bookedDays:5,paidDays:5,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 347"],pendingReviewBoundary:false},
{id:"imp_r86",customerId:"imp_c70",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-06-19",endDate:"2025-06-22",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 97"],pendingReviewBoundary:false},
{id:"imp_r87",customerId:"imp_c71",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-06-20",endDate:"2025-06-28",bookedDays:8,paidDays:8,revenue:1140.0,status:"completed",sourceRows:["Customer list 2025 row 98"],pendingReviewBoundary:false},
{id:"imp_r88",customerId:"imp_c72",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2025-06-21",endDate:"2025-10-21",bookedDays:30,paidDays:122,revenue:14000.0,status:"completed",sourceRows:["Customer list 2025 row 100","Customer list 2025 row 146","Customer list 2025 row 180","Customer list 2025 row 225"],pendingReviewBoundary:false},
{id:"imp_r89",customerId:"imp_c73",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2025-06-22",endDate:"2025-06-26",bookedDays:4,paidDays:4,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 102"],pendingReviewBoundary:false},
{id:"imp_r90",customerId:"imp_c74",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-06-23",endDate:"2025-07-03",bookedDays:10,paidDays:10,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 106"],pendingReviewBoundary:false},
{id:"imp_r91",customerId:"imp_c75",bikeModel:"Aerox Standard",bikeNameRaw:"GT Red",plate:"",startDate:"2025-06-27",endDate:"2025-06-30",bookedDays:3,paidDays:3,revenue:500.0,status:"completed",sourceRows:["Customer list 2025 row 107"],pendingReviewBoundary:false},
{id:"imp_r92",customerId:"imp_c76",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-06-30",endDate:"2025-07-01",bookedDays:1,paidDays:1,revenue:200.0,status:"completed",sourceRows:["Customer list 2025 row 108"],pendingReviewBoundary:false},
{id:"imp_r93",customerId:"imp_c77",bikeModel:"Aerox Standard",bikeNameRaw:"GT Red",plate:"",startDate:"2025-07-01",endDate:"2025-08-04",bookedDays:14,paidDays:34,revenue:3600.0,status:"completed",sourceRows:["Customer list 2025 row 111","Customer list 2025 row 136","Customer list 2025 row 160"],pendingReviewBoundary:false},
{id:"imp_r94",customerId:"imp_c78",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox cool 2",plate:"",startDate:"2025-07-01",endDate:"2025-08-01",bookedDays:31,paidDays:31,revenue:3800.0,status:"completed",sourceRows:["Customer list 2025 row 112"],pendingReviewBoundary:false},
{id:"imp_r95",customerId:"imp_c79",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-07-02",endDate:"2025-07-09",bookedDays:7,paidDays:7,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 113"],pendingReviewBoundary:false},
{id:"imp_r96",customerId:"imp_c80",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano",plate:"",startDate:"2025-07-02",endDate:"2025-07-04",bookedDays:2,paidDays:2,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 115"],pendingReviewBoundary:false},
{id:"imp_r97",customerId:"imp_c81",bikeModel:"Aerox Standard",bikeNameRaw:"GT Black",plate:"",startDate:"2025-07-03",endDate:"2025-07-05",bookedDays:2,paidDays:2,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 116"],pendingReviewBoundary:false},
{id:"imp_r98",customerId:"imp_c82",bikeModel:"Aerox Standard",bikeNameRaw:"aerox cool 2",plate:"",startDate:"2025-07-04",endDate:"2025-08-28",bookedDays:30,paidDays:55,revenue:5800.0,status:"completed",sourceRows:["Customer list 2025 row 117","Customer list 2025 row 166"],pendingReviewBoundary:false},
{id:"imp_r99",customerId:"imp_c83",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-07-05",endDate:"2025-07-06",bookedDays:1,paidDays:1,revenue:200.0,status:"completed",sourceRows:["Customer list 2025 row 118"],pendingReviewBoundary:false},
{id:"imp_r100",customerId:"imp_c84",bikeModel:"Aerox Standard",bikeNameRaw:"Grand filano",plate:"",startDate:"2025-07-05",endDate:"2025-07-17",bookedDays:12,paidDays:12,revenue:1400.0,status:"completed",sourceRows:["Customer list 2025 row 119"],pendingReviewBoundary:false},
{id:"imp_r101",customerId:"imp_c84",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-08-27",endDate:"2025-10-27",bookedDays:31,paidDays:61,revenue:5000.0,status:"completed",sourceRows:["Customer list 2025 row 189","Customer list 2025 row 236"],pendingReviewBoundary:false},
{id:"imp_r102",customerId:"imp_c85",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-07-06",endDate:"2025-07-09",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 121"],pendingReviewBoundary:false},
{id:"imp_r103",customerId:"imp_c86",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2025-07-06",endDate:"2025-07-10",bookedDays:4,paidDays:4,revenue:1100.0,status:"completed",sourceRows:["Customer list 2025 row 122"],pendingReviewBoundary:false},
{id:"imp_r104",customerId:"imp_c87",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-07-06",endDate:"2025-07-15",bookedDays:7,paidDays:9,revenue:1900.0,status:"completed",sourceRows:["Customer list 2025 row 123","Customer list 2025 row 133"],pendingReviewBoundary:false},
{id:"imp_r105",customerId:"imp_c88",bikeModel:"Aerox Standard",bikeNameRaw:"Zoomer X",plate:"",startDate:"2025-07-06",endDate:null,bookedDays:31,paidDays:427,revenue:30000.0,status:"active",sourceRows:["Customer list 2025 row 124","Customer list 2025 row 168","Customer list 2025 row 250","Customer list 2025 row 301","Customer list 2026 row 63","Customer list 2026 row 143","Customer list 2026 row 258","Customer list 2026 row 359"],pendingReviewBoundary:false},
{id:"imp_r106",customerId:"imp_c89",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3 ( extend to 29 th AUG)",plate:"",startDate:"2025-07-07",endDate:"2025-08-29",bookedDays:31,paidDays:53,revenue:5350.0,status:"completed",sourceRows:["Customer list 2025 row 125","Customer list 2025 row 172"],pendingReviewBoundary:false},
{id:"imp_r107",customerId:"imp_c90",bikeModel:"Aerox Standard",bikeNameRaw:"Click blue",plate:"",startDate:"2025-07-09",endDate:"2025-07-12",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 128"],pendingReviewBoundary:false},
{id:"imp_r108",customerId:"imp_c91",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-07-09",endDate:"2025-07-16",bookedDays:7,paidDays:7,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 129"],pendingReviewBoundary:false},
{id:"imp_r109",customerId:"imp_c92",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2025-07-11",endDate:"2025-07-12",bookedDays:1,paidDays:1,revenue:100.0,status:"completed",sourceRows:["Customer list 2025 row 131"],pendingReviewBoundary:false},
{id:"imp_r110",customerId:"imp_c93",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2025-07-12",endDate:"2025-07-21",bookedDays:9,paidDays:9,revenue:1800.0,status:"completed",sourceRows:["Customer list 2025 row 132"],pendingReviewBoundary:false},
{id:"imp_r111",customerId:"imp_c94",bikeModel:"Aerox Standard",bikeNameRaw:"Click blue",plate:"",startDate:"2025-07-13",endDate:"2025-07-17",bookedDays:4,paidDays:4,revenue:700.0,status:"completed",sourceRows:["Customer list 2025 row 134"],pendingReviewBoundary:false},
{id:"imp_r112",customerId:"imp_c95",bikeModel:"Aerox Standard",bikeNameRaw:"GT 1",plate:"",startDate:"2025-07-14",endDate:"2025-07-21",bookedDays:7,paidDays:7,revenue:1100.0,status:"completed",sourceRows:["Customer list 2025 row 135"],pendingReviewBoundary:false},
{id:"imp_r113",customerId:"imp_c96",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox black",plate:"",startDate:"2025-07-15",endDate:"2025-07-29",bookedDays:14,paidDays:14,revenue:2400.0,status:"completed",sourceRows:["Customer list 2025 row 137"],pendingReviewBoundary:false},
{id:"imp_r114",customerId:"imp_c97",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-07-17",endDate:"2025-07-24",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 138"],pendingReviewBoundary:false},
{id:"imp_r115",customerId:"imp_c98",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-07-17",endDate:"2025-08-22",bookedDays:36,paidDays:36,revenue:3000.0,status:"completed",sourceRows:["Customer list 2025 row 139"],pendingReviewBoundary:false},
{id:"imp_r116",customerId:"imp_c99",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-07-18",endDate:"2025-07-20",bookedDays:2,paidDays:2,revenue:800.0,status:"completed",sourceRows:["Customer list 2025 row 140","Customer list 2025 row 141"],pendingReviewBoundary:false},
{id:"imp_r117",customerId:"imp_c100",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 3",plate:"",startDate:"2025-07-18",endDate:"2025-07-20",bookedDays:2,paidDays:2,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 142"],pendingReviewBoundary:false},
{id:"imp_r118",customerId:"imp_c101",bikeModel:"Aerox Standard",bikeNameRaw:"Grand filano",plate:"",startDate:"2025-07-18",endDate:"2025-07-24",bookedDays:6,paidDays:6,revenue:900.0,status:"completed",sourceRows:["Customer list 2025 row 143"],pendingReviewBoundary:false},
{id:"imp_r119",customerId:"imp_c102",bikeModel:"Aerox Standard",bikeNameRaw:"GT 1",plate:"",startDate:"2025-07-22",endDate:"2025-07-24",bookedDays:2,paidDays:2,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 147"],pendingReviewBoundary:false},
{id:"imp_r120",customerId:"imp_c103",bikeModel:"NMAX",bikeNameRaw:"Nmax",plate:"",startDate:"2025-07-22",endDate:"2025-07-29",bookedDays:7,paidDays:7,revenue:1700.0,status:"completed",sourceRows:["Customer list 2025 row 148"],pendingReviewBoundary:false},
{id:"imp_r121",customerId:"imp_c103",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-07-02",endDate:"2026-07-10",bookedDays:8,paidDays:8,revenue:2100.0,status:"completed",sourceRows:["Customer list 2026 row 343"],pendingReviewBoundary:false},
{id:"imp_r122",customerId:"imp_c104",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2025-07-22",endDate:"2025-07-25",bookedDays:3,paidDays:3,revenue:900.0,status:"completed",sourceRows:["Customer list 2025 row 149"],pendingReviewBoundary:false},
{id:"imp_r123",customerId:"imp_c105",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-07-24",endDate:"2025-08-19",bookedDays:26,paidDays:26,revenue:2300.0,status:"completed",sourceRows:["Customer list 2025 row 153"],pendingReviewBoundary:false},
{id:"imp_r124",customerId:"imp_c106",bikeModel:"Aerox Standard",bikeNameRaw:"GT 1",plate:"",startDate:"2025-07-24",endDate:"2025-10-25",bookedDays:42,paidDays:93,revenue:7900.0,status:"completed",sourceRows:["Customer list 2025 row 154","Customer list 2025 row 204","Customer list 2025 row 231"],pendingReviewBoundary:false},
{id:"imp_r125",customerId:"imp_c107",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-07-24",endDate:"2025-07-28",bookedDays:4,paidDays:4,revenue:1100.0,status:"completed",sourceRows:["Customer list 2025 row 155"],pendingReviewBoundary:false},
{id:"imp_r126",customerId:"imp_c108",bikeModel:"Aerox Standard",bikeNameRaw:"Granfilano",plate:"",startDate:"2025-07-26",endDate:"2025-08-26",bookedDays:31,paidDays:31,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 156"],pendingReviewBoundary:false},
{id:"imp_r127",customerId:"imp_c108",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano",plate:"",startDate:"2025-09-11",endDate:"2026-05-13",bookedDays:30,paidDays:244,revenue:25200.0,status:"completed",sourceRows:["Customer list 2025 row 216","Customer list 2025 row 257","Customer list 2025 row 308","Customer list 2026 row 4","Customer list 2026 row 61","Customer list 2026 row 105","Customer list 2026 row 118","Customer list 2026 row 172","Customer list 2026 row 227"],pendingReviewBoundary:false},
{id:"imp_r128",customerId:"imp_c108",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano",plate:"",startDate:"2026-05-27",endDate:null,bookedDays:31,paidDays:85,revenue:6900.0,status:"active",sourceRows:["Customer list 2026 row 285","Customer list 2026 row 329","Customer list 2026 row 366"],pendingReviewBoundary:false},
{id:"imp_r129",customerId:"imp_c109",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2025-07-27",endDate:"2025-08-27",bookedDays:31,paidDays:31,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 157"],pendingReviewBoundary:false},
{id:"imp_r130",customerId:"imp_c110",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-07-28",endDate:"2025-09-28",bookedDays:31,paidDays:62,revenue:7000.0,status:"completed",sourceRows:["Customer list 2025 row 158","Customer list 2025 row 184"],pendingReviewBoundary:false},
{id:"imp_r131",customerId:"imp_c110",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-10-10",endDate:"2025-11-10",bookedDays:31,paidDays:31,revenue:3500.0,status:"completed",sourceRows:["Customer list 2025 row 255"],pendingReviewBoundary:false},
{id:"imp_r132",customerId:"imp_c110",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2026-02-20",endDate:"2026-04-05",bookedDays:21,paidDays:44,revenue:5950.0,status:"completed",sourceRows:["Customer list 2026 row 122","Customer list 2026 row 156","Customer list 2026 row 178"],pendingReviewBoundary:false},
{id:"imp_r133",customerId:"imp_c110",bikeModel:"Aerox Standard",bikeNameRaw:"RAX blue",plate:"",startDate:"2026-04-21",endDate:"2026-06-08",bookedDays:39,paidDays:48,revenue:10500.0,status:"completed",sourceRows:["Customer list 2026 row 230","Customer list 2026 row 292"],pendingReviewBoundary:false},
{id:"imp_r134",customerId:"imp_c111",bikeModel:"NMAX",bikeNameRaw:"nmax",plate:"",startDate:"2025-07-28",endDate:"2026-06-15",bookedDays:31,paidDays:322,revenue:37100.0,status:"completed",sourceRows:["Customer list 2025 row 159","Customer list 2025 row 190","Customer list 2025 row 235","Customer list 2025 row 287","Customer list 2025 row 336","Customer list 2025 row 392","Customer list 2026 row 84","Customer list 2026 row 134","Customer list 2026 row 194","Customer list 2026 row 243","Customer list 2026 row 289"],pendingReviewBoundary:false},
{id:"imp_r135",customerId:"imp_c112",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox black",plate:"",startDate:"2025-07-30",endDate:"2025-08-02",bookedDays:3,paidDays:3,revenue:900.0,status:"completed",sourceRows:["Customer list 2025 row 161"],pendingReviewBoundary:false},
{id:"imp_r136",customerId:"imp_c113",bikeModel:"NMAX",bikeNameRaw:"Nmax",plate:"",startDate:"2025-07-30",endDate:"2025-08-23",bookedDays:24,paidDays:24,revenue:3500.0,status:"completed",sourceRows:["Customer list 2025 row 162"],pendingReviewBoundary:false},
{id:"imp_r137",customerId:"imp_c114",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-07-31",endDate:null,bookedDays:61,paidDays:395,revenue:50100.0,status:"active",sourceRows:["Customer list 2025 row 163","Customer list 2025 row 197","Customer list 2025 row 243","Customer list 2025 row 293","Customer list 2025 row 340","Customer list 2026 row 46","Customer list 2026 row 91","Customer list 2026 row 139","Customer list 2026 row 204","Customer list 2026 row 247","Customer list 2026 row 295","Customer list 2026 row 338","Customer list 2026 row 381"],pendingReviewBoundary:false},
{id:"imp_r139",customerId:"imp_c115",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-08-01",endDate:"2025-09-01",bookedDays:31,paidDays:31,revenue:3500.0,status:"completed",sourceRows:["Customer list 2025 row 165"],pendingReviewBoundary:false},
{id:"imp_r140",customerId:"imp_c116",bikeModel:"Aerox Standard",bikeNameRaw:"GT Red",plate:"",startDate:"2025-08-05",endDate:"2025-10-05",bookedDays:31,paidDays:61,revenue:5150.0,status:"completed",sourceRows:["Customer list 2025 row 169","Customer list 2025 row 208"],pendingReviewBoundary:false},
{id:"imp_r141",customerId:"imp_c117",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-08-05",endDate:"2025-08-16",bookedDays:11,paidDays:11,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 170"],pendingReviewBoundary:false},
{id:"imp_r142",customerId:"imp_c118",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-08-10",endDate:"2025-08-16",bookedDays:6,paidDays:6,revenue:1450.0,status:"completed",sourceRows:["Customer list 2025 row 175"],pendingReviewBoundary:false},
{id:"imp_r143",customerId:"imp_c119",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 6",plate:"",startDate:"2025-08-11",endDate:"2026-02-03",bookedDays:36,paidDays:176,revenue:6150.0,status:"completed",sourceRows:["Customer list 2025 row 176","Customer list 2026 row 52"],pendingReviewBoundary:false},
{id:"imp_r144",customerId:"imp_c120",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2025-08-13",endDate:"2025-09-13",bookedDays:31,paidDays:31,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 177"],pendingReviewBoundary:false},
{id:"imp_r145",customerId:"imp_c121",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-08-17",endDate:"2025-08-19",bookedDays:2,paidDays:2,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 178"],pendingReviewBoundary:false},
{id:"imp_r146",customerId:"imp_c122",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-08-17",endDate:"2025-08-27",bookedDays:10,paidDays:10,revenue:1950.0,status:"completed",sourceRows:["Customer list 2025 row 179"],pendingReviewBoundary:false},
{id:"imp_r147",customerId:"imp_c123",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano",plate:"",startDate:"2025-08-24",endDate:"2025-08-27",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 187"],pendingReviewBoundary:false},
{id:"imp_r148",customerId:"imp_c124",bikeModel:"Aerox Standard",bikeNameRaw:"Click Blue",plate:"",startDate:"2025-08-27",endDate:"2025-09-27",bookedDays:23,paidDays:31,revenue:2673.0,status:"completed",sourceRows:["Customer list 2025 row 207","Customer list 2025 row 188"],pendingReviewBoundary:false},
{id:"imp_r149",customerId:"imp_c125",bikeModel:"NMAX",bikeNameRaw:"Nmax",plate:"",startDate:"2025-08-28",endDate:"2025-08-31",bookedDays:3,paidDays:3,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 191"],pendingReviewBoundary:false},
{id:"imp_r150",customerId:"imp_c126",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox blue",plate:"",startDate:"2025-08-28",endDate:"2025-08-31",bookedDays:3,paidDays:3,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 192"],pendingReviewBoundary:false},
{id:"imp_r151",customerId:"imp_c127",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2025-08-28",endDate:"2025-08-31",bookedDays:3,paidDays:3,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 193"],pendingReviewBoundary:false},
{id:"imp_r152",customerId:"imp_c128",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano",plate:"",startDate:"2025-08-29",endDate:"2025-08-31",bookedDays:2,paidDays:2,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 194"],pendingReviewBoundary:false},
{id:"imp_r153",customerId:"imp_c129",bikeModel:"Aerox Standard",bikeNameRaw:"GT Black 1",plate:"",startDate:"2025-08-29",endDate:"2025-09-24",bookedDays:26,paidDays:26,revenue:2300.0,status:"completed",sourceRows:["Customer list 2025 row 195"],pendingReviewBoundary:false},
{id:"imp_r154",customerId:"imp_c130",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-08-29",endDate:"2025-10-25",bookedDays:31,paidDays:57,revenue:4800.0,status:"completed",sourceRows:["Customer list 2025 row 196","Customer list 2025 row 242"],pendingReviewBoundary:false},
{id:"imp_r155",customerId:"imp_c131",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-09-01",endDate:"2025-09-08",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 200"],pendingReviewBoundary:false},
{id:"imp_r156",customerId:"imp_c132",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-09-02",endDate:"2025-09-14",bookedDays:12,paidDays:12,revenue:2100.0,status:"completed",sourceRows:["Customer list 2025 row 201"],pendingReviewBoundary:false},
{id:"imp_r157",customerId:"imp_c133",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2025-09-07",endDate:"2025-12-18",bookedDays:17,paidDays:102,revenue:5200.0,status:"completed",sourceRows:["Customer list 2025 row 202","Customer list 2025 row 318"],pendingReviewBoundary:false},
{id:"imp_r158",customerId:"imp_c134",bikeModel:"NMAX",bikeNameRaw:"Nmax",plate:"",startDate:"2025-09-03",endDate:"2025-10-14",bookedDays:41,paidDays:41,revenue:5600.0,status:"completed",sourceRows:["Customer list 2025 row 203"],pendingReviewBoundary:false},
{id:"imp_r159",customerId:"imp_c135",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2025-09-03",endDate:"2025-12-03",bookedDays:30,paidDays:91,revenue:7500.0,status:"completed",sourceRows:["Customer list 2025 row 205","Customer list 2025 row 247","Customer list 2025 row 296"],pendingReviewBoundary:false},
{id:"imp_r160",customerId:"imp_c136",bikeModel:"Aerox Standard",bikeNameRaw:"GT mint",plate:"",startDate:"2025-09-04",endDate:"2025-09-05",bookedDays:1,paidDays:1,revenue:500.0,status:"completed",sourceRows:["Customer list 2025 row 206"],pendingReviewBoundary:false},
{id:"imp_r161",customerId:"imp_c137",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-09-06",endDate:"2025-09-10",bookedDays:4,paidDays:4,revenue:750.0,status:"completed",sourceRows:["Customer list 2025 row 209"],pendingReviewBoundary:false},
{id:"imp_r162",customerId:"imp_c138",bikeModel:"Aerox Standard",bikeNameRaw:"Click blue",plate:"",startDate:"2025-09-08",endDate:"2025-10-09",bookedDays:31,paidDays:31,revenue:2600.0,status:"completed",sourceRows:["Customer list 2025 row 212"],pendingReviewBoundary:false},
{id:"imp_r163",customerId:"imp_c138",bikeModel:"Aerox Standard",bikeNameRaw:"GT Burgundy",plate:"",startDate:"2025-10-30",endDate:"2025-12-10",bookedDays:31,paidDays:41,revenue:3400.0,status:"completed",sourceRows:["Customer list 2025 row 289","Customer list 2025 row 345"],pendingReviewBoundary:false},
{id:"imp_r164",customerId:"imp_c139",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-09-11",endDate:"2025-10-30",bookedDays:30,paidDays:49,revenue:5450.0,status:"completed",sourceRows:["Customer list 2025 row 213","Customer list 2025 row 267"],pendingReviewBoundary:false},
{id:"imp_r165",customerId:"imp_c140",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-09-11",endDate:"2025-09-15",bookedDays:4,paidDays:4,revenue:700.0,status:"completed",sourceRows:["Customer list 2025 row 214"],pendingReviewBoundary:false},
{id:"imp_r166",customerId:"imp_c141",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 3",plate:"",startDate:"2025-09-11",endDate:"2025-09-13",bookedDays:2,paidDays:2,revenue:460.0,status:"completed",sourceRows:["Customer list 2025 row 215"],pendingReviewBoundary:false},
{id:"imp_r167",customerId:"imp_c142",bikeModel:"Aerox Standard",bikeNameRaw:"GT Red 3",plate:"",startDate:"2025-09-12",endDate:"2025-09-14",bookedDays:2,paidDays:2,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 217"],pendingReviewBoundary:false},
{id:"imp_r168",customerId:"imp_c143",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-09-13",endDate:"2025-10-19",bookedDays:30,paidDays:36,revenue:3000.0,status:"completed",sourceRows:["Customer list 2025 row 218","Customer list 2025 row 258"],pendingReviewBoundary:false},
{id:"imp_r169",customerId:"imp_c144",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 3",plate:"",startDate:"2025-09-13",endDate:"2025-09-15",bookedDays:2,paidDays:2,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 219"],pendingReviewBoundary:false},
{id:"imp_r170",customerId:"imp_c145",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 3",plate:"",startDate:"2025-09-14",endDate:"2025-10-26",bookedDays:42,paidDays:42,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 220"],pendingReviewBoundary:false},
{id:"imp_r171",customerId:"imp_c146",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 2",plate:"",startDate:"2025-09-15",endDate:"2025-10-15",bookedDays:30,paidDays:30,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 221"],pendingReviewBoundary:false},
{id:"imp_r172",customerId:"imp_c146",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 2",plate:"",startDate:"2025-10-20",endDate:"2025-11-15",bookedDays:26,paidDays:26,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 269"],pendingReviewBoundary:true},
{id:"imp_r173",customerId:"imp_c147",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-09-15",endDate:"2025-09-18",bookedDays:3,paidDays:3,revenue:0.0,status:"completed",sourceRows:["Customer list 2025 row 222"],pendingReviewBoundary:false},
{id:"imp_r174",customerId:"imp_c148",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2025-09-17",endDate:"2025-09-24",bookedDays:7,paidDays:7,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 223"],pendingReviewBoundary:false},
{id:"imp_r175",customerId:"imp_c149",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Greeen",plate:"",startDate:"2025-09-23",endDate:"2025-09-27",bookedDays:4,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2025 row 229"],pendingReviewBoundary:false},
{id:"imp_r176",customerId:"imp_c150",bikeModel:"Aerox Standard",bikeNameRaw:"GT burgandy",plate:"",startDate:"2025-09-26",endDate:"2026-04-26",bookedDays:30,paidDays:212,revenue:17500.0,status:"completed",sourceRows:["Customer list 2025 row 233","Customer list 2025 row 280","Customer list 2025 row 331","Customer list 2025 row 386","Customer list 2026 row 79","Customer list 2026 row 128","Customer list 2026 row 190"],pendingReviewBoundary:false},
{id:"imp_r177",customerId:"imp_c151",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 1",plate:"",startDate:"2025-09-26",endDate:"2025-10-10",bookedDays:14,paidDays:14,revenue:1800.0,status:"completed",sourceRows:["Customer list 2025 row 234"],pendingReviewBoundary:false},
{id:"imp_r178",customerId:"imp_c152",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2025-09-27",endDate:"2025-10-04",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 237"],pendingReviewBoundary:false},
{id:"imp_r179",customerId:"imp_c153",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-09-27",endDate:"2025-10-03",bookedDays:6,paidDays:6,revenue:1300.0,status:"completed",sourceRows:["Customer list 2025 row 238"],pendingReviewBoundary:false},
{id:"imp_r180",customerId:"imp_c154",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-09-29",endDate:"2025-09-29",bookedDays:1,paidDays:1,revenue:250.0,status:"completed",sourceRows:["Customer list 2025 row 239","Customer list 2025 row 240"],pendingReviewBoundary:false},
{id:"imp_r181",customerId:"imp_c155",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 3",plate:"",startDate:"2025-09-29",endDate:"2025-10-06",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 241"],pendingReviewBoundary:false},
{id:"imp_r182",customerId:"imp_c156",bikeModel:"DRONE",bikeNameRaw:"Drone",plate:"",startDate:"2025-10-01",endDate:"2025-10-30",bookedDays:29,paidDays:29,revenue:4000.0,status:"completed",sourceRows:["Customer list 2025 row 245"],pendingReviewBoundary:false},
{id:"imp_r183",customerId:"imp_c157",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 4 (blue)",plate:"",startDate:"2025-09-02",endDate:"2025-10-16",bookedDays:44,paidDays:44,revenue:2600.0,status:"completed",sourceRows:["Customer list 2025 row 246"],pendingReviewBoundary:false},
{id:"imp_r184",customerId:"imp_c157",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-02-10",endDate:"2026-02-16",bookedDays:6,paidDays:6,revenue:3300.0,status:"completed",sourceRows:["Customer list 2026 row 103"],pendingReviewBoundary:false},
{id:"imp_r185",customerId:"imp_c158",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-09-04",endDate:"2025-10-20",bookedDays:46,paidDays:46,revenue:2500.0,status:"completed",sourceRows:["Customer list 2025 row 248"],pendingReviewBoundary:false},
{id:"imp_r186",customerId:"imp_c159",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2025-10-05",endDate:"2025-10-14",bookedDays:9,paidDays:9,revenue:1150.0,status:"completed",sourceRows:["Customer list 2025 row 249"],pendingReviewBoundary:false},
{id:"imp_r187",customerId:"imp_c160",bikeModel:"Aerox Standard",bikeNameRaw:"Click red",plate:"",startDate:"2025-09-09",endDate:null,bookedDays:61,paidDays:365,revenue:27500.0,status:"active",sourceRows:["Customer list 2025 row 251","Customer list 2025 row 302","Customer list 2025 row 343","Customer list 2026 row 56","Customer list 2026 row 89","Customer list 2026 row 144","Customer list 2026 row 208","Customer list 2026 row 252","Customer list 2026 row 297","Customer list 2026 row 344","Customer list 2026 row 382"],pendingReviewBoundary:false},
{id:"imp_r188",customerId:"imp_c161",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-10-07",endDate:"2025-11-06",bookedDays:30,paidDays:30,revenue:4000.0,status:"completed",sourceRows:["Customer list 2025 row 252"],pendingReviewBoundary:false},
{id:"imp_r189",customerId:"imp_c162",bikeModel:"Aerox Standard",bikeNameRaw:"GT Black 3",plate:"",startDate:"2025-10-08",endDate:"2025-10-13",bookedDays:5,paidDays:5,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 253"],pendingReviewBoundary:false},
{id:"imp_r190",customerId:"imp_c163",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2025-10-10",endDate:"2025-10-28",bookedDays:18,paidDays:18,revenue:1900.0,status:"completed",sourceRows:["Customer list 2025 row 254"],pendingReviewBoundary:false},
{id:"imp_r191",customerId:"imp_c164",bikeModel:"Aerox Standard",bikeNameRaw:"GT Black 1",plate:"",startDate:"2025-10-11",endDate:"2025-12-05",bookedDays:31,paidDays:55,revenue:5600.0,status:"completed",sourceRows:["Customer list 2025 row 256","Customer list 2025 row 307"],pendingReviewBoundary:false},
{id:"imp_r192",customerId:"imp_c165",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 3",plate:"",startDate:"2025-10-14",endDate:"2025-10-28",bookedDays:14,paidDays:14,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 260"],pendingReviewBoundary:false},
{id:"imp_r193",customerId:"imp_c166",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2025-10-15",endDate:"2025-10-22",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 261"],pendingReviewBoundary:false},
{id:"imp_r194",customerId:"imp_c167",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2025-10-15",endDate:"2025-10-16",bookedDays:1,paidDays:1,revenue:200.0,status:"completed",sourceRows:["Customer list 2025 row 262"],pendingReviewBoundary:false},
{id:"imp_r195",customerId:"imp_c168",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-10-15",endDate:"2025-11-28",bookedDays:31,paidDays:44,revenue:5250.0,status:"completed",sourceRows:["Customer list 2025 row 263","Customer list 2025 row 315"],pendingReviewBoundary:false},
{id:"imp_r196",customerId:"imp_c169",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2025-10-16",endDate:"2025-10-20",bookedDays:4,paidDays:4,revenue:700.0,status:"completed",sourceRows:["Customer list 2025 row 264"],pendingReviewBoundary:false},
{id:"imp_r197",customerId:"imp_c170",bikeModel:"Aerox Standard",bikeNameRaw:"Cool Blue",plate:"",startDate:"2025-10-19",endDate:"2025-10-20",bookedDays:1,paidDays:1,revenue:350.0,status:"completed",sourceRows:["Customer list 2025 row 265"],pendingReviewBoundary:false},
{id:"imp_r198",customerId:"imp_c171",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2025-10-19",endDate:"2025-10-26",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 266"],pendingReviewBoundary:false},
{id:"imp_r199",customerId:"imp_c172",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue",plate:"",startDate:"2025-10-20",endDate:"2026-01-28",bookedDays:31,paidDays:100,revenue:19200.0,status:"completed",sourceRows:["Customer list 2025 row 270","Customer list 2025 row 321","Customer list 2025 row 374","Customer list 2026 row 21"],pendingReviewBoundary:false},
{id:"imp_r200",customerId:"imp_c172",bikeModel:"NMAX",bikeNameRaw:"Nmax Blue",plate:"",startDate:"2026-05-28",endDate:null,bookedDays:31,paidDays:92,revenue:14750.0,status:"active",sourceRows:["Customer list 2026 row 287","Customer list 2026 row 330","Customer list 2026 row 372"],pendingReviewBoundary:false},
{id:"imp_r201",customerId:"imp_c173",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Blue",plate:"",startDate:"2025-10-22",endDate:"2025-11-18",bookedDays:27,paidDays:27,revenue:3400.0,status:"completed",sourceRows:["Customer list 2025 row 274"],pendingReviewBoundary:false},
{id:"imp_r202",customerId:"imp_c174",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2025-10-22",endDate:"2025-11-18",bookedDays:27,paidDays:27,revenue:3400.0,status:"completed",sourceRows:["Customer list 2025 row 275"],pendingReviewBoundary:false},
{id:"imp_r203",customerId:"imp_c175",bikeModel:"Aerox Standard",bikeNameRaw:"CBR",plate:"",startDate:"2025-10-22",endDate:"2025-11-18",bookedDays:27,paidDays:27,revenue:3400.0,status:"completed",sourceRows:["Customer list 2025 row 276"],pendingReviewBoundary:false},
{id:"imp_r204",customerId:"imp_c176",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-10-22",endDate:"2025-11-18",bookedDays:27,paidDays:27,revenue:3400.0,status:"completed",sourceRows:["Customer list 2025 row 277"],pendingReviewBoundary:false},
{id:"imp_r205",customerId:"imp_c177",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-10-24",endDate:"2025-11-24",bookedDays:31,paidDays:31,revenue:4200.0,status:"completed",sourceRows:["Customer list 2025 row 279"],pendingReviewBoundary:false},
{id:"imp_r206",customerId:"imp_c178",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2025-10-27",endDate:"2025-11-07",bookedDays:11,paidDays:11,revenue:1600.0,status:"completed",sourceRows:["Customer list 2025 row 281"],pendingReviewBoundary:false},
{id:"imp_r207",customerId:"imp_c179",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2025-10-27",endDate:"2025-11-07",bookedDays:11,paidDays:11,revenue:1300.0,status:"completed",sourceRows:["Customer list 2025 row 282"],pendingReviewBoundary:false},
{id:"imp_r208",customerId:"imp_c180",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2025-10-28",endDate:"2025-11-04",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 283"],pendingReviewBoundary:false},
{id:"imp_r209",customerId:"imp_c181",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2025-10-28",endDate:"2026-02-18",bookedDays:31,paidDays:113,revenue:14950.0,status:"completed",sourceRows:["Customer list 2025 row 284","Customer list 2025 row 333","Customer list 2025 row 393","Customer list 2026 row 83","Customer list 2026 row 92"],pendingReviewBoundary:false},
{id:"imp_r210",customerId:"imp_c182",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-10-28",endDate:"2026-03-09",bookedDays:21,paidDays:132,revenue:15000.0,status:"completed",sourceRows:["Customer list 2025 row 285","Customer list 2025 row 317","Customer list 2026 row 49","Customer list 2026 row 95","Customer list 2026 row 147"],pendingReviewBoundary:false},
{id:"imp_r211",customerId:"imp_c182",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-03-29",endDate:"2026-04-06",bookedDays:8,paidDays:8,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 199"],pendingReviewBoundary:false},
{id:"imp_r212",customerId:"imp_c183",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-10-28",endDate:"2025-11-28",bookedDays:31,paidDays:31,revenue:3100.0,status:"completed",sourceRows:["Customer list 2025 row 286"],pendingReviewBoundary:false},
{id:"imp_r213",customerId:"imp_c184",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 3",plate:"",startDate:"2025-10-29",endDate:"2025-11-04",bookedDays:6,paidDays:6,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 288"],pendingReviewBoundary:false},
{id:"imp_r214",customerId:"imp_c185",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2025-10-30",endDate:"2025-11-02",bookedDays:3,paidDays:3,revenue:600.0,status:"completed",sourceRows:["Customer list 2025 row 290"],pendingReviewBoundary:false},
{id:"imp_r215",customerId:"imp_c186",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 3",plate:"",startDate:"2025-10-30",endDate:"2025-11-10",bookedDays:11,paidDays:11,revenue:1600.0,status:"completed",sourceRows:["Customer list 2025 row 291"],pendingReviewBoundary:false},
{id:"imp_r216",customerId:"imp_c187",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-11-01",endDate:"2025-11-08",bookedDays:7,paidDays:7,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 294"],pendingReviewBoundary:false},
{id:"imp_r217",customerId:"imp_c188",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 6",plate:"",startDate:"2025-11-01",endDate:"2025-12-18",bookedDays:9,paidDays:47,revenue:6450.0,status:"completed",sourceRows:["Customer list 2025 row 295","Customer list 2025 row 306","Customer list 2025 row 351","Customer list 2025 row 362"],pendingReviewBoundary:false},
{id:"imp_r218",customerId:"imp_c189",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-11-04",endDate:"2025-11-20",bookedDays:16,paidDays:16,revenue:3000.0,status:"completed",sourceRows:["Customer list 2025 row 297"],pendingReviewBoundary:false},
{id:"imp_r219",customerId:"imp_c190",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-11-06",endDate:"2025-11-11",bookedDays:5,paidDays:5,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 298"],pendingReviewBoundary:false},
{id:"imp_r220",customerId:"imp_c191",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-11-06",endDate:"2025-11-11",bookedDays:5,paidDays:5,revenue:1400.0,status:"completed",sourceRows:["Customer list 2025 row 299"],pendingReviewBoundary:false},
{id:"imp_r221",customerId:"imp_c192",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 3",plate:"",startDate:"2025-11-07",endDate:"2026-02-22",bookedDays:30,paidDays:107,revenue:9250.0,status:"completed",sourceRows:["Customer list 2025 row 300","Customer list 2025 row 350"],pendingReviewBoundary:false},
{id:"imp_r222",customerId:"imp_c193",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2025-11-08",endDate:"2026-02-08",bookedDays:30,paidDays:92,revenue:9000.0,status:"completed",sourceRows:["Customer list 2025 row 303","Customer list 2025 row 352","Customer list 2026 row 54"],pendingReviewBoundary:false},
{id:"imp_r223",customerId:"imp_c194",bikeModel:"NMAX",bikeNameRaw:"Nmax Blue",plate:"",startDate:"2025-11-08",endDate:"2026-05-08",bookedDays:10,paidDays:181,revenue:21100.0,status:"completed",sourceRows:["Customer list 2025 row 304","Customer list 2026 row 51","Customer list 2026 row 93","Customer list 2026 row 151","Customer list 2026 row 209"],pendingReviewBoundary:false},
{id:"imp_r224",customerId:"imp_c195",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-11-08",endDate:"2025-11-12",bookedDays:4,paidDays:4,revenue:800.0,status:"completed",sourceRows:["Customer list 2025 row 305"],pendingReviewBoundary:false},
{id:"imp_r225",customerId:"imp_c196",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-11-11",endDate:"2025-12-11",bookedDays:30,paidDays:30,revenue:3000.0,status:"completed",sourceRows:["Customer list 2025 row 309"],pendingReviewBoundary:false},
{id:"imp_r226",customerId:"imp_c197",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-11-13",endDate:"2025-11-13",bookedDays:1,paidDays:1,revenue:300.0,status:"completed",sourceRows:["Customer list 2025 row 311"],pendingReviewBoundary:false},
{id:"imp_r227",customerId:"imp_c198",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-11-13",endDate:"2025-11-26",bookedDays:13,paidDays:13,revenue:1900.0,status:"completed",sourceRows:["Customer list 2025 row 312"],pendingReviewBoundary:false},
{id:"imp_r228",customerId:"imp_c199",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-11-14",endDate:"2025-12-14",bookedDays:30,paidDays:30,revenue:4500.0,status:"completed",sourceRows:["Customer list 2025 row 313"],pendingReviewBoundary:false},
{id:"imp_r229",customerId:"imp_c200",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-11-16",endDate:"2026-04-16",bookedDays:30,paidDays:151,revenue:15500.0,status:"completed",sourceRows:["Customer list 2025 row 316","Customer list 2025 row 368","Customer list 2026 row 67","Customer list 2026 row 167"],pendingReviewBoundary:false},
{id:"imp_r230",customerId:"imp_c201",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2025-11-18",endDate:"2025-11-25",bookedDays:7,paidDays:7,revenue:3500.0,status:"completed",sourceRows:["Customer list 2025 row 319"],pendingReviewBoundary:false},
{id:"imp_r231",customerId:"imp_c202",bikeModel:"Aerox Standard",bikeNameRaw:"Freego white",plate:"",startDate:"2025-11-19",endDate:"2026-02-14",bookedDays:30,paidDays:87,revenue:12000.0,status:"completed",sourceRows:["Customer list 2025 row 320","Customer list 2025 row 363","Customer list 2026 row 18","Customer list 2026 row 68"],pendingReviewBoundary:false},
{id:"imp_r232",customerId:"imp_c203",bikeModel:"Aerox Standard",bikeNameRaw:"RAX blue",plate:"",startDate:"2025-11-20",endDate:"2025-11-27",bookedDays:7,paidDays:7,revenue:1900.0,status:"completed",sourceRows:["Customer list 2025 row 322"],pendingReviewBoundary:false},
{id:"imp_r233",customerId:"imp_c204",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2025-11-20",endDate:"2025-12-22",bookedDays:32,paidDays:32,revenue:3400.0,status:"completed",sourceRows:["Customer list 2025 row 323"],pendingReviewBoundary:false},
{id:"imp_r234",customerId:"imp_c205",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 6",plate:"",startDate:"2025-11-22",endDate:"2026-01-03",bookedDays:30,paidDays:42,revenue:4300.0,status:"completed",sourceRows:["Customer list 2025 row 326","Customer list 2025 row 379"],pendingReviewBoundary:false},
{id:"imp_r235",customerId:"imp_c206",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox black",plate:"",startDate:"2025-11-22",endDate:"2025-12-28",bookedDays:30,paidDays:36,revenue:7100.0,status:"completed",sourceRows:["Customer list 2025 row 327","Customer list 2025 row 382"],pendingReviewBoundary:false},
{id:"imp_r236",customerId:"imp_c207",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2025-11-25",endDate:"2026-01-11",bookedDays:47,paidDays:47,revenue:6800.0,status:"completed",sourceRows:["Customer list 2025 row 330"],pendingReviewBoundary:false},
{id:"imp_r237",customerId:"imp_c208",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2025-11-26",endDate:"2026-02-11",bookedDays:30,paidDays:77,revenue:11000.0,status:"completed",sourceRows:["Customer list 2025 row 332","Customer list 2025 row 385","Customer list 2026 row 81"],pendingReviewBoundary:false},
{id:"imp_r238",customerId:"imp_c208",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2026-03-28",endDate:"2026-03-29",bookedDays:1,paidDays:1,revenue:400.0,status:"completed",sourceRows:["Customer list 2026 row 195"],pendingReviewBoundary:false},
{id:"imp_r239",customerId:"imp_c209",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-11-27",endDate:"2025-12-04",bookedDays:7,paidDays:7,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 334"],pendingReviewBoundary:false},
{id:"imp_r240",customerId:"imp_c210",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-11-27",endDate:"2025-12-04",bookedDays:7,paidDays:7,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 335"],pendingReviewBoundary:false},
{id:"imp_r241",customerId:"imp_c211",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2025-11-28",endDate:"2025-12-01",bookedDays:3,paidDays:3,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 337"],pendingReviewBoundary:false},
{id:"imp_r242",customerId:"imp_c212",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox red 2",plate:"",startDate:"2025-11-28",endDate:"2026-01-04",bookedDays:37,paidDays:37,revenue:4350.0,status:"completed",sourceRows:["Customer list 2025 row 338"],pendingReviewBoundary:false},
{id:"imp_r243",customerId:"imp_c213",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-11-29",endDate:"2025-11-30",bookedDays:1,paidDays:1,revenue:300.0,status:"completed",sourceRows:["Customer list 2025 row 339"],pendingReviewBoundary:false},
{id:"imp_r244",customerId:"imp_c214",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-12-01",endDate:"2025-12-11",bookedDays:10,paidDays:10,revenue:2300.0,status:"completed",sourceRows:["Customer list 2025 row 342"],pendingReviewBoundary:false},
{id:"imp_r245",customerId:"imp_c215",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2025-12-01",endDate:"2025-12-25",bookedDays:24,paidDays:24,revenue:4000.0,status:"completed",sourceRows:["Customer list 2025 row 344"],pendingReviewBoundary:false},
{id:"imp_r246",customerId:"imp_c216",bikeModel:"Aerox Standard",bikeNameRaw:"gt red 2                             (under Irene)",plate:"",startDate:"2025-12-02",endDate:"2026-02-11",bookedDays:31,paidDays:71,revenue:7500.0,status:"completed",sourceRows:["Customer list 2025 row 346","Customer list 2026 row 45"],pendingReviewBoundary:false},
{id:"imp_r247",customerId:"imp_c217",bikeModel:"Aerox Standard",bikeNameRaw:"Cool Blue 2",plate:"",startDate:"2025-12-03",endDate:"2025-12-10",bookedDays:7,paidDays:7,revenue:1700.0,status:"completed",sourceRows:["Customer list 2025 row 347"],pendingReviewBoundary:false},
{id:"imp_r248",customerId:"imp_c218",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2025-12-03",endDate:"2026-02-03",bookedDays:31,paidDays:62,revenue:9000.0,status:"completed",sourceRows:["Customer list 2025 row 348","Customer list 2026 row 11","Customer list 2026 row 47"],pendingReviewBoundary:false},
{id:"imp_r249",customerId:"imp_c219",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2025-12-06",endDate:"2025-12-13",bookedDays:7,paidDays:7,revenue:2840.0,status:"completed",sourceRows:["Customer list 2025 row 349"],pendingReviewBoundary:false},
{id:"imp_r250",customerId:"imp_c220",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red",plate:"",startDate:"2025-12-07",endDate:"2025-12-18",bookedDays:11,paidDays:11,revenue:1800.0,status:"completed",sourceRows:["Customer list 2025 row 353"],pendingReviewBoundary:false},
{id:"imp_r251",customerId:"imp_c221",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red",plate:"",startDate:"2025-12-08",endDate:"2025-12-13",bookedDays:5,paidDays:5,revenue:2000.0,status:"completed",sourceRows:["Customer list 2025 row 354","Customer list 2025 row 355"],pendingReviewBoundary:false},
{id:"imp_r252",customerId:"imp_c222",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 1",plate:"",startDate:"2025-12-08",endDate:"2025-12-13",bookedDays:5,paidDays:5,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 356"],pendingReviewBoundary:false},
{id:"imp_r253",customerId:"imp_c223",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2025-12-10",endDate:"2026-02-10",bookedDays:31,paidDays:62,revenue:6000.0,status:"completed",sourceRows:["Customer list 2025 row 357","Customer list 2026 row 59"],pendingReviewBoundary:false},
{id:"imp_r254",customerId:"imp_c224",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 2",plate:"",startDate:"2025-12-11",endDate:"2026-03-09",bookedDays:31,paidDays:88,revenue:17400.0,status:"completed",sourceRows:["Customer list 2025 row 358","Customer list 2026 row 15","Customer list 2026 row 62","Customer list 2026 row 106","Customer list 2026 row 117","Customer list 2026 row 140"],pendingReviewBoundary:false},
{id:"imp_r255",customerId:"imp_c225",bikeModel:"Aerox Standard",bikeNameRaw:"GT Burgundy",plate:"",startDate:"2025-12-13",endDate:"2025-12-20",bookedDays:7,paidDays:7,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 360"],pendingReviewBoundary:false},
{id:"imp_r256",customerId:"imp_c226",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2025-12-13",endDate:"2026-01-13",bookedDays:28,paidDays:31,revenue:5900.0,status:"completed",sourceRows:["Customer list 2026 row 17","Customer list 2025 row 361"],pendingReviewBoundary:false},
{id:"imp_r257",customerId:"imp_c227",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-12-15",endDate:"2025-12-16",bookedDays:1,paidDays:1,revenue:400.0,status:"completed",sourceRows:["Customer list 2025 row 364"],pendingReviewBoundary:false},
{id:"imp_r258",customerId:"imp_c228",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 1",plate:"",startDate:"2025-12-15",endDate:"2025-12-16",bookedDays:1,paidDays:1,revenue:300.0,status:"completed",sourceRows:["Customer list 2025 row 365"],pendingReviewBoundary:false},
{id:"imp_r259",customerId:"imp_c229",bikeModel:"Aerox Standard",bikeNameRaw:"GT mint",plate:"",startDate:"2025-12-15",endDate:"2025-12-19",bookedDays:4,paidDays:4,revenue:800.0,status:"completed",sourceRows:["Customer list 2025 row 366"],pendingReviewBoundary:false},
{id:"imp_r260",customerId:"imp_c230",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2025-12-15",endDate:"2025-12-26",bookedDays:11,paidDays:11,revenue:4900.0,status:"completed",sourceRows:["Customer list 2025 row 367"],pendingReviewBoundary:false},
{id:"imp_r261",customerId:"imp_c231",bikeModel:"Aerox Standard",bikeNameRaw:"Freego black",plate:"",startDate:"2025-12-16",endDate:"2025-12-20",bookedDays:4,paidDays:4,revenue:1000.0,status:"completed",sourceRows:["Customer list 2025 row 369"],pendingReviewBoundary:false},
{id:"imp_r262",customerId:"imp_c232",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2025-12-16",endDate:"2025-12-30",bookedDays:14,paidDays:14,revenue:2700.0,status:"completed",sourceRows:["Customer list 2025 row 370"],pendingReviewBoundary:false},
{id:"imp_r263",customerId:"imp_c233",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 1",plate:"",startDate:"2025-12-17",endDate:"2025-12-31",bookedDays:14,paidDays:14,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 371"],pendingReviewBoundary:false},
{id:"imp_r264",customerId:"imp_c234",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2025-12-18",endDate:"2025-12-28",bookedDays:10,paidDays:10,revenue:1500.0,status:"completed",sourceRows:["Customer list 2025 row 372"],pendingReviewBoundary:false},
{id:"imp_r265",customerId:"imp_c235",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2025-12-19",endDate:"2026-01-10",bookedDays:14,paidDays:22,revenue:7800.0,status:"completed",sourceRows:["Customer list 2025 row 373","Customer list 2026 row 20"],pendingReviewBoundary:false},
{id:"imp_r266",customerId:"imp_c236",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2025-12-20",endDate:"2025-12-27",bookedDays:7,paidDays:7,revenue:1700.0,status:"completed",sourceRows:["Customer list 2025 row 375"],pendingReviewBoundary:false},
{id:"imp_r267",customerId:"imp_c237",bikeModel:"Aerox Standard",bikeNameRaw:"GT mint",plate:"",startDate:"2025-12-20",endDate:"2026-01-20",bookedDays:31,paidDays:31,revenue:3000.0,status:"completed",sourceRows:["Customer list 2025 row 376"],pendingReviewBoundary:false},
{id:"imp_r268",customerId:"imp_c238",bikeModel:"Aerox Standard",bikeNameRaw:"GT burgandy",plate:"",startDate:"2025-12-20",endDate:"2025-12-23",bookedDays:3,paidDays:3,revenue:800.0,status:"completed",sourceRows:["Customer list 2025 row 377"],pendingReviewBoundary:false},
{id:"imp_r269",customerId:"imp_c239",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red",plate:"",startDate:"2025-12-20",endDate:"2025-12-23",bookedDays:3,paidDays:3,revenue:800.0,status:"completed",sourceRows:["Customer list 2025 row 378"],pendingReviewBoundary:false},
{id:"imp_r270",customerId:"imp_c240",bikeModel:"Aerox Standard",bikeNameRaw:"Freego black",plate:"",startDate:"2025-12-24",endDate:"2026-02-13",bookedDays:22,paidDays:51,revenue:7800.0,status:"completed",sourceRows:["Customer list 2025 row 383","Customer list 2026 row 26","Customer list 2026 row 82"],pendingReviewBoundary:false},
{id:"imp_r271",customerId:"imp_c241",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2025-12-25",endDate:"2026-01-01",bookedDays:7,paidDays:7,revenue:1700.0,status:"completed",sourceRows:["Customer list 2025 row 384"],pendingReviewBoundary:false},
{id:"imp_r272",customerId:"imp_c242",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red",plate:"",startDate:"2025-12-25",endDate:"2026-01-02",bookedDays:8,paidDays:8,revenue:1300.0,status:"completed",sourceRows:["Customer list 2025 row 387"],pendingReviewBoundary:false},
{id:"imp_r273",customerId:"imp_c243",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4             (under (Maziar))",plate:"",startDate:"2025-12-25",endDate:"2026-02-01",bookedDays:35,paidDays:38,revenue:7000.0,status:"completed",sourceRows:["Customer list 2026 row 31","Customer list 2025 row 388"],pendingReviewBoundary:false},
{id:"imp_r274",customerId:"imp_c244",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1             (under (Maziar))",plate:"",startDate:"2025-12-25",endDate:"2026-02-01",bookedDays:35,paidDays:38,revenue:7000.0,status:"completed",sourceRows:["Customer list 2026 row 32","Customer list 2025 row 389"],pendingReviewBoundary:false},
{id:"imp_r275",customerId:"imp_c245",bikeModel:"Aerox Standard",bikeNameRaw:"RAX blue",plate:"",startDate:"2025-12-26",endDate:"2026-03-26",bookedDays:31,paidDays:90,revenue:12000.0,status:"completed",sourceRows:["Customer list 2025 row 390","Customer list 2026 row 77","Customer list 2026 row 129"],pendingReviewBoundary:false},
{id:"imp_r276",customerId:"imp_c246",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2025-12-28",endDate:"2026-01-11",bookedDays:9,paidDays:14,revenue:5400.0,status:"completed",sourceRows:["Customer list 2026 row 37","Customer list 2025 row 394"],pendingReviewBoundary:false},
{id:"imp_r277",customerId:"imp_c247",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2025-12-30",endDate:"2026-01-11",bookedDays:12,paidDays:12,revenue:6400.0,status:"completed",sourceRows:["Customer list 2025 row 395"],pendingReviewBoundary:false},
{id:"imp_r278",customerId:"imp_c248",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 1",plate:"",startDate:"2025-12-30",endDate:"2026-07-17",bookedDays:31,paidDays:199,revenue:19700.0,status:"completed",sourceRows:["Customer list 2025 row 396","Customer list 2026 row 85","Customer list 2026 row 135","Customer list 2026 row 198","Customer list 2026 row 244","Customer list 2026 row 290","Customer list 2026 row 334"],pendingReviewBoundary:false},
{id:"imp_r279",customerId:"imp_c249",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Black",plate:"",startDate:"2025-12-31",endDate:"2026-01-05",bookedDays:4,paidDays:5,revenue:3200.0,status:"completed",sourceRows:["Customer list 2025 row 397","Customer list 2026 row 40"],pendingReviewBoundary:false},
{id:"imp_r280",customerId:"imp_c250",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2025-12-31",endDate:"2026-01-03",bookedDays:3,paidDays:3,revenue:1200.0,status:"completed",sourceRows:["Customer list 2025 row 398"],pendingReviewBoundary:false},
{id:"imp_r281",customerId:"imp_c251",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2026-01-01",endDate:"2026-01-03",bookedDays:2,paidDays:2,revenue:900.0,status:"completed",sourceRows:["Customer list 2026 row 43"],pendingReviewBoundary:false},
{id:"imp_r282",customerId:"imp_c252",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-01-01",endDate:"2026-01-08",bookedDays:7,paidDays:7,revenue:2100.0,status:"completed",sourceRows:["Customer list 2026 row 44"],pendingReviewBoundary:false},
{id:"imp_r283",customerId:"imp_c253",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2026-01-03",endDate:"2026-01-24",bookedDays:21,paidDays:21,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 48"],pendingReviewBoundary:false},
{id:"imp_r284",customerId:"imp_c254",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red                          ( under Tiacas)",plate:"",startDate:"2026-01-03",endDate:"2026-02-03",bookedDays:31,paidDays:31,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 50"],pendingReviewBoundary:false},
{id:"imp_r285",customerId:"imp_c255",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox black",plate:"",startDate:"2026-01-06",endDate:"2026-03-13",bookedDays:31,paidDays:66,revenue:10100.0,status:"completed",sourceRows:["Customer list 2026 row 53","Customer list 2026 row 99","Customer list 2026 row 152"],pendingReviewBoundary:false},
{id:"imp_r286",customerId:"imp_c256",bikeModel:"Aerox Standard",bikeNameRaw:"RAX red                              (under Sabzi)",plate:"",startDate:"2026-01-07",endDate:"2026-01-22",bookedDays:15,paidDays:15,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 55"],pendingReviewBoundary:false},
{id:"imp_r287",customerId:"imp_c257",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2                                  ( under Melissa)",plate:"",startDate:"2026-01-08",endDate:"2026-01-18",bookedDays:10,paidDays:10,revenue:2200.0,status:"completed",sourceRows:["Customer list 2026 row 57"],pendingReviewBoundary:false},
{id:"imp_r288",customerId:"imp_c258",bikeModel:"NMAX",bikeNameRaw:"NMAX blue",plate:"",startDate:"2026-01-09",endDate:"2026-01-31",bookedDays:22,paidDays:22,revenue:3800.0,status:"completed",sourceRows:["Customer list 2026 row 58"],pendingReviewBoundary:false},
{id:"imp_r289",customerId:"imp_c259",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-01-10",endDate:"2026-02-11",bookedDays:32,paidDays:32,revenue:10000.0,status:"completed",sourceRows:["Customer list 2026 row 60"],pendingReviewBoundary:false},
{id:"imp_r290",customerId:"imp_c260",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2026-01-13",endDate:"2026-01-20",bookedDays:7,paidDays:7,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 64"],pendingReviewBoundary:false},
{id:"imp_r291",customerId:"imp_c261",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox blue                      (under Manufloret)",plate:"",startDate:"2026-01-14",endDate:"2026-02-04",bookedDays:21,paidDays:21,revenue:3300.0,status:"completed",sourceRows:["Customer list 2026 row 65"],pendingReviewBoundary:false},
{id:"imp_r292",customerId:"imp_c262",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2026-01-14",endDate:"2026-03-03",bookedDays:48,paidDays:48,revenue:4700.0,status:"completed",sourceRows:["Customer list 2026 row 66"],pendingReviewBoundary:false},
{id:"imp_r293",customerId:"imp_c263",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-01-19",endDate:"2026-02-12",bookedDays:24,paidDays:24,revenue:4000.0,status:"completed",sourceRows:["Customer list 2026 row 69"],pendingReviewBoundary:false},
{id:"imp_r294",customerId:"imp_c264",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-01-20",endDate:"2026-03-13",bookedDays:39,paidDays:52,revenue:4500.0,status:"completed",sourceRows:["Customer list 2026 row 70","Customer list 2026 row 133"],pendingReviewBoundary:false},
{id:"imp_r295",customerId:"imp_c265",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3 (upgraded from GT)",plate:"",startDate:"2026-01-21",endDate:"2026-03-17",bookedDays:30,paidDays:55,revenue:6700.0,status:"completed",sourceRows:["Customer list 2026 row 71","Customer list 2026 row 120"],pendingReviewBoundary:false},
{id:"imp_r296",customerId:"imp_c266",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2026-01-21",endDate:"2026-02-10",bookedDays:20,paidDays:20,revenue:3500.0,status:"completed",sourceRows:["Customer list 2026 row 72"],pendingReviewBoundary:false},
{id:"imp_r297",customerId:"imp_c266",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 2",plate:"",startDate:"2026-03-13",endDate:"2026-03-28",bookedDays:15,paidDays:15,revenue:2800.0,status:"completed",sourceRows:["Customer list 2026 row 163"],pendingReviewBoundary:false},
{id:"imp_r298",customerId:"imp_c267",bikeModel:"Aerox Standard",bikeNameRaw:"RAX red",plate:"",startDate:"2026-01-22",endDate:"2026-02-22",bookedDays:31,paidDays:31,revenue:4000.0,status:"completed",sourceRows:["Customer list 2026 row 74"],pendingReviewBoundary:false},
{id:"imp_r299",customerId:"imp_c268",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2026-01-24",endDate:"2026-02-15",bookedDays:22,paidDays:22,revenue:2850.0,status:"completed",sourceRows:["Customer list 2026 row 76"],pendingReviewBoundary:false},
{id:"imp_r300",customerId:"imp_c269",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2025-12-30",endDate:"2026-02-04",bookedDays:36,paidDays:36,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 86"],pendingReviewBoundary:false},
{id:"imp_r301",customerId:"imp_c270",bikeModel:"Aerox Standard",bikeNameRaw:"Cool Blue 1",plate:"",startDate:"2026-01-30",endDate:"2026-02-13",bookedDays:14,paidDays:14,revenue:2700.0,status:"completed",sourceRows:["Customer list 2026 row 87"],pendingReviewBoundary:false},
{id:"imp_r302",customerId:"imp_c271",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-01-31",endDate:"2026-02-27",bookedDays:27,paidDays:27,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 88"],pendingReviewBoundary:false},
{id:"imp_r303",customerId:"imp_c272",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red",plate:"",startDate:"2026-02-02",endDate:"2026-03-18",bookedDays:28,paidDays:44,revenue:4700.0,status:"completed",sourceRows:["Customer list 2026 row 94","Customer list 2026 row 146"],pendingReviewBoundary:false},
{id:"imp_r304",customerId:"imp_c273",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2026-02-04",endDate:"2026-03-12",bookedDays:24,paidDays:36,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 96","Customer list 2026 row 131"],pendingReviewBoundary:false},
{id:"imp_r305",customerId:"imp_c274",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 6",plate:"",startDate:"2026-02-04",endDate:"2026-03-30",bookedDays:28,paidDays:54,revenue:5600.0,status:"completed",sourceRows:["Customer list 2026 row 97","Customer list 2026 row 149"],pendingReviewBoundary:false},
{id:"imp_r306",customerId:"imp_c275",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Blue",plate:"",startDate:"2026-02-04",endDate:"2026-03-04",bookedDays:28,paidDays:28,revenue:4000.0,status:"completed",sourceRows:["Customer list 2026 row 98"],pendingReviewBoundary:false},
{id:"imp_r307",customerId:"imp_c276",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-02-07",endDate:"2026-02-12",bookedDays:5,paidDays:5,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 100"],pendingReviewBoundary:false},
{id:"imp_r308",customerId:"imp_c277",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Red 2",plate:"",startDate:"2026-02-08",endDate:"2026-03-08",bookedDays:28,paidDays:28,revenue:4000.0,status:"completed",sourceRows:["Customer list 2026 row 101"],pendingReviewBoundary:false},
{id:"imp_r309",customerId:"imp_c278",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-02-10",endDate:"2026-02-17",bookedDays:7,paidDays:7,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 102"],pendingReviewBoundary:false},
{id:"imp_r310",customerId:"imp_c279",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox White",plate:"",startDate:"2026-02-10",endDate:"2026-02-27",bookedDays:17,paidDays:17,revenue:3200.0,status:"completed",sourceRows:["Customer list 2026 row 104"],pendingReviewBoundary:false},
{id:"imp_r311",customerId:"imp_c280",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-02-11",endDate:"2026-02-14",bookedDays:3,paidDays:3,revenue:900.0,status:"completed",sourceRows:["Customer list 2026 row 107"],pendingReviewBoundary:false},
{id:"imp_r312",customerId:"imp_c281",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2026-02-11",endDate:"2026-02-18",bookedDays:7,paidDays:7,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 108"],pendingReviewBoundary:false},
{id:"imp_r313",customerId:"imp_c282",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 2",plate:"",startDate:"2026-02-12",endDate:"2026-04-25",bookedDays:17,paidDays:72,revenue:8200.0,status:"completed",sourceRows:["Customer list 2026 row 109","Customer list 2026 row 141","Customer list 2026 row 179","Customer list 2026 row 222","Customer list 2026 row 232"],pendingReviewBoundary:false},
{id:"imp_r314",customerId:"imp_c282",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 2",plate:"",startDate:"2026-05-01",endDate:"2026-05-07",bookedDays:6,paidDays:6,revenue:900.0,status:"completed",sourceRows:["Customer list 2026 row 251"],pendingReviewBoundary:true},
{id:"imp_r315",customerId:"imp_c283",bikeModel:"Aerox Standard",bikeNameRaw:"Cool  2",plate:"",startDate:"2026-02-12",endDate:"2026-03-07",bookedDays:23,paidDays:23,revenue:3800.0,status:"completed",sourceRows:["Customer list 2026 row 110"],pendingReviewBoundary:false},
{id:"imp_r316",customerId:"imp_c284",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-02-14",endDate:"2026-03-14",bookedDays:28,paidDays:28,revenue:4500.0,status:"completed",sourceRows:["Customer list 2026 row 111"],pendingReviewBoundary:false},
{id:"imp_r317",customerId:"imp_c285",bikeModel:"Aerox Standard",bikeNameRaw:"Freego black",plate:"",startDate:"2026-02-14",endDate:"2026-03-16",bookedDays:30,paidDays:30,revenue:3200.0,status:"completed",sourceRows:["Customer list 2026 row 112"],pendingReviewBoundary:false},
{id:"imp_r318",customerId:"imp_c285",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox red 2",plate:"",startDate:"2026-04-07",endDate:"2026-07-21",bookedDays:30,paidDays:105,revenue:13100.0,status:"completed",sourceRows:["Customer list 2026 row 212","Customer list 2026 row 255","Customer list 2026 row 310","Customer list 2026 row 349"],pendingReviewBoundary:false},
{id:"imp_r319",customerId:"imp_c286",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-02-16",endDate:"2026-02-20",bookedDays:4,paidDays:4,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 113"],pendingReviewBoundary:false},
{id:"imp_r320",customerId:"imp_c287",bikeModel:"Aerox Standard",bikeNameRaw:"Freego white",plate:"",startDate:"2026-02-17",endDate:"2026-04-27",bookedDays:28,paidDays:69,revenue:7000.0,status:"completed",sourceRows:["Customer list 2026 row 114","Customer list 2026 row 160"],pendingReviewBoundary:false},
{id:"imp_r321",customerId:"imp_c288",bikeModel:"Aerox Standard",bikeNameRaw:"Grand Filano 2",plate:"",startDate:"2026-02-17",endDate:null,bookedDays:28,paidDays:181,revenue:18000.0,status:"active",sourceRows:["Customer list 2026 row 115","Customer list 2026 row 168","Customer list 2026 row 213","Customer list 2026 row 268","Customer list 2026 row 311","Customer list 2026 row 352"],pendingReviewBoundary:false},
{id:"imp_r322",customerId:"imp_c289",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-02-18",endDate:"2026-03-05",bookedDays:10,paidDays:15,revenue:2100.0,status:"completed",sourceRows:["Customer list 2026 row 116","Customer list 2026 row 142"],pendingReviewBoundary:false},
{id:"imp_r323",customerId:"imp_c289",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-03-14",endDate:"2026-03-28",bookedDays:4,paidDays:14,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 165","Customer list 2026 row 173"],pendingReviewBoundary:false},
{id:"imp_r324",customerId:"imp_c289",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-05-21",endDate:"2026-05-24",bookedDays:3,paidDays:3,revenue:500.0,status:"completed",sourceRows:["Customer list 2026 row 277"],pendingReviewBoundary:false},
{id:"imp_r325",customerId:"imp_c290",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-02-19",endDate:"2026-02-23",bookedDays:4,paidDays:4,revenue:2300.0,status:"completed",sourceRows:["Customer list 2026 row 119"],pendingReviewBoundary:false},
{id:"imp_r326",customerId:"imp_c291",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2026-02-20",endDate:"2026-03-13",bookedDays:21,paidDays:21,revenue:3300.0,status:"completed",sourceRows:["Customer list 2026 row 121"],pendingReviewBoundary:false},
{id:"imp_r327",customerId:"imp_c292",bikeModel:"Aerox Standard",bikeNameRaw:"GT mint",plate:"",startDate:"2026-02-20",endDate:null,bookedDays:28,paidDays:181,revenue:18000.0,status:"active",sourceRows:["Customer list 2026 row 123","Customer list 2026 row 177","Customer list 2026 row 226","Customer list 2026 row 273","Customer list 2026 row 322","Customer list 2026 row 367"],pendingReviewBoundary:false},
{id:"imp_r328",customerId:"imp_c293",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 3",plate:"",startDate:"2026-02-24",endDate:"2026-04-07",bookedDays:28,paidDays:42,revenue:4400.0,status:"completed",sourceRows:["Customer list 2026 row 127","Customer list 2026 row 186"],pendingReviewBoundary:false},
{id:"imp_r329",customerId:"imp_c294",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-02-26",endDate:"2026-02-28",bookedDays:2,paidDays:2,revenue:750.0,status:"completed",sourceRows:["Customer list 2026 row 132"],pendingReviewBoundary:false},
{id:"imp_r330",customerId:"imp_c295",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-02-28",endDate:"2026-03-17",bookedDays:7,paidDays:17,revenue:2600.0,status:"completed",sourceRows:["Customer list 2026 row 136","Customer list 2026 row 154"],pendingReviewBoundary:false},
{id:"imp_r331",customerId:"imp_c296",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2026-02-28",endDate:"2026-03-05",bookedDays:5,paidDays:5,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 137"],pendingReviewBoundary:false},
{id:"imp_r332",customerId:"imp_c297",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-03-01",endDate:"2026-03-11",bookedDays:10,paidDays:10,revenue:2050.0,status:"completed",sourceRows:["Customer list 2026 row 145"],pendingReviewBoundary:false},
{id:"imp_r333",customerId:"imp_c298",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-03-03",endDate:"2026-03-07",bookedDays:4,paidDays:4,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 148"],pendingReviewBoundary:false},
{id:"imp_r334",customerId:"imp_c299",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2026-03-04",endDate:"2026-03-18",bookedDays:14,paidDays:14,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 150"],pendingReviewBoundary:false},
{id:"imp_r335",customerId:"imp_c300",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-03-05",endDate:"2026-03-11",bookedDays:6,paidDays:6,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 153"],pendingReviewBoundary:false},
{id:"imp_r336",customerId:"imp_c301",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox white",plate:"",startDate:"2026-03-07",endDate:"2026-03-25",bookedDays:18,paidDays:18,revenue:3700.0,status:"completed",sourceRows:["Customer list 2026 row 155"],pendingReviewBoundary:false},
{id:"imp_r337",customerId:"imp_c302",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-03-10",endDate:"2026-03-14",bookedDays:4,paidDays:4,revenue:1600.0,status:"completed",sourceRows:["Customer list 2026 row 157"],pendingReviewBoundary:false},
{id:"imp_r338",customerId:"imp_c303",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-03-10",endDate:"2026-03-17",bookedDays:7,paidDays:7,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 158"],pendingReviewBoundary:false},
{id:"imp_r339",customerId:"imp_c304",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2026-03-11",endDate:"2026-03-17",bookedDays:6,paidDays:6,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 159"],pendingReviewBoundary:false},
{id:"imp_r340",customerId:"imp_c305",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-03-11",endDate:"2026-03-30",bookedDays:19,paidDays:19,revenue:2500.0,status:"completed",sourceRows:["Customer list 2026 row 161"],pendingReviewBoundary:false},
{id:"imp_r341",customerId:"imp_c306",bikeModel:"NMAX",bikeNameRaw:"Nmax Black",plate:"",startDate:"2026-03-12",endDate:"2026-03-25",bookedDays:13,paidDays:13,revenue:2700.0,status:"completed",sourceRows:["Customer list 2026 row 162"],pendingReviewBoundary:false},
{id:"imp_r342",customerId:"imp_c307",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-03-13",endDate:"2026-03-29",bookedDays:16,paidDays:16,revenue:2200.0,status:"completed",sourceRows:["Customer list 2026 row 164"],pendingReviewBoundary:false},
{id:"imp_r343",customerId:"imp_c308",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2026-03-14",endDate:"2026-03-21",bookedDays:7,paidDays:7,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 166"],pendingReviewBoundary:false},
{id:"imp_r344",customerId:"imp_c309",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-03-16",endDate:"2026-03-19",bookedDays:3,paidDays:3,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 169"],pendingReviewBoundary:false},
{id:"imp_r345",customerId:"imp_c310",bikeModel:"Aerox Standard",bikeNameRaw:"Freego black",plate:"",startDate:"2026-03-17",endDate:"2026-03-26",bookedDays:9,paidDays:9,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 170"],pendingReviewBoundary:false},
{id:"imp_r346",customerId:"imp_c311",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-03-17",endDate:"2026-04-02",bookedDays:16,paidDays:16,revenue:2200.0,status:"completed",sourceRows:["Customer list 2026 row 171"],pendingReviewBoundary:false},
{id:"imp_r347",customerId:"imp_c312",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox black",plate:"",startDate:"2026-03-18",endDate:"2026-03-31",bookedDays:13,paidDays:13,revenue:2700.0,status:"completed",sourceRows:["Customer list 2026 row 174"],pendingReviewBoundary:false},
{id:"imp_r348",customerId:"imp_c313",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2026-03-19",endDate:"2026-03-26",bookedDays:7,paidDays:7,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 175"],pendingReviewBoundary:false},
{id:"imp_r349",customerId:"imp_c314",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2026-03-19",endDate:"2026-04-02",bookedDays:14,paidDays:14,revenue:2300.0,status:"completed",sourceRows:["Customer list 2026 row 176"],pendingReviewBoundary:false},
{id:"imp_r350",customerId:"imp_c315",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red",plate:"",startDate:"2026-03-22",endDate:"2026-04-05",bookedDays:14,paidDays:14,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 181"],pendingReviewBoundary:false},
{id:"imp_r351",customerId:"imp_c316",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox red 2",plate:"",startDate:"2026-03-23",endDate:"2026-04-07",bookedDays:15,paidDays:15,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 183"],pendingReviewBoundary:false},
{id:"imp_r352",customerId:"imp_c317",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-03-23",endDate:"2026-03-30",bookedDays:7,paidDays:7,revenue:2200.0,status:"completed",sourceRows:["Customer list 2026 row 184"],pendingReviewBoundary:false},
{id:"imp_r353",customerId:"imp_c318",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2026-03-24",endDate:"2026-04-24",bookedDays:31,paidDays:31,revenue:2600.0,status:"completed",sourceRows:["Customer list 2026 row 187"],pendingReviewBoundary:false},
{id:"imp_r354",customerId:"imp_c319",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2026-03-24",endDate:"2026-03-29",bookedDays:5,paidDays:5,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 188"],pendingReviewBoundary:false},
{id:"imp_r355",customerId:"imp_c320",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-03-24",endDate:"2026-03-31",bookedDays:7,paidDays:7,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 189"],pendingReviewBoundary:false},
{id:"imp_r356",customerId:"imp_c321",bikeModel:"NMAX",bikeNameRaw:"Nmax Black",plate:"",startDate:"2026-03-25",endDate:"2026-04-25",bookedDays:31,paidDays:31,revenue:4500.0,status:"completed",sourceRows:["Customer list 2026 row 191"],pendingReviewBoundary:false},
{id:"imp_r357",customerId:"imp_c322",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Blue",plate:"",startDate:"2026-03-26",endDate:"2026-03-31",bookedDays:5,paidDays:5,revenue:1600.0,status:"completed",sourceRows:["Customer list 2026 row 192"],pendingReviewBoundary:false},
{id:"imp_r358",customerId:"imp_c323",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2026-03-27",endDate:"2026-03-31",bookedDays:4,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 193"],pendingReviewBoundary:false},
{id:"imp_r359",customerId:"imp_c324",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-03-29",endDate:"2026-04-05",bookedDays:7,paidDays:7,revenue:1700.0,status:"completed",sourceRows:["Customer list 2026 row 196"],pendingReviewBoundary:false},
{id:"imp_r360",customerId:"imp_c325",bikeModel:"Aerox Standard",bikeNameRaw:"Freego black",plate:"",startDate:"2026-03-29",endDate:"2026-03-30",bookedDays:1,paidDays:1,revenue:300.0,status:"completed",sourceRows:["Customer list 2026 row 197"],pendingReviewBoundary:false},
{id:"imp_r361",customerId:"imp_c326",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2026-03-30",endDate:"2026-04-08",bookedDays:9,paidDays:9,revenue:2200.0,status:"completed",sourceRows:["Customer list 2026 row 200"],pendingReviewBoundary:false},
{id:"imp_r362",customerId:"imp_c327",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-03-30",endDate:"2026-04-17",bookedDays:18,paidDays:18,revenue:3100.0,status:"completed",sourceRows:["Customer list 2026 row 201"],pendingReviewBoundary:false},
{id:"imp_r363",customerId:"imp_c328",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-03-30",endDate:"2026-04-01",bookedDays:2,paidDays:2,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 202"],pendingReviewBoundary:false},
{id:"imp_r364",customerId:"imp_c329",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2026-03-31",endDate:"2026-04-04",bookedDays:4,paidDays:4,revenue:1650.0,status:"completed",sourceRows:["Customer list 2026 row 203"],pendingReviewBoundary:false},
{id:"imp_r365",customerId:"imp_c330",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 2",plate:"",startDate:"2026-03-31",endDate:"2026-07-30",bookedDays:30,paidDays:121,revenue:14000.0,status:"completed",sourceRows:["Customer list 2026 row 206","Customer list 2026 row 245","Customer list 2026 row 291","Customer list 2026 row 335"],pendingReviewBoundary:false},
{id:"imp_r366",customerId:"imp_c331",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-04-07",endDate:"2026-04-13",bookedDays:6,paidDays:6,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 210"],pendingReviewBoundary:false},
{id:"imp_r367",customerId:"imp_c332",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-04-07",endDate:"2026-04-17",bookedDays:10,paidDays:10,revenue:5000.0,status:"completed",sourceRows:["Customer list 2026 row 211"],pendingReviewBoundary:false},
{id:"imp_r368",customerId:"imp_c333",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 2",plate:"",startDate:"2026-04-09",endDate:"2026-05-06",bookedDays:27,paidDays:27,revenue:4000.0,status:"completed",sourceRows:["Customer list 2026 row 214"],pendingReviewBoundary:false},
{id:"imp_r369",customerId:"imp_c334",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-04-09",endDate:"2026-04-11",bookedDays:2,paidDays:2,revenue:600.0,status:"completed",sourceRows:["Customer list 2026 row 215"],pendingReviewBoundary:false},
{id:"imp_r370",customerId:"imp_c335",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2026-04-09",endDate:"2026-05-09",bookedDays:30,paidDays:30,revenue:3500.0,status:"completed",sourceRows:["Customer list 2026 row 216"],pendingReviewBoundary:false},
{id:"imp_r371",customerId:"imp_c336",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2026-04-09",endDate:"2026-04-10",bookedDays:1,paidDays:1,revenue:300.0,status:"completed",sourceRows:["Customer list 2026 row 217"],pendingReviewBoundary:false},
{id:"imp_r372",customerId:"imp_c337",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Blue, RAX Red and Cool Blue 2",plate:"",startDate:"2026-04-11",endDate:"2026-04-13",bookedDays:2,paidDays:2,revenue:2400.0,status:"completed",sourceRows:["Customer list 2026 row 218"],pendingReviewBoundary:false},
{id:"imp_r373",customerId:"imp_c338",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-04-11",endDate:"2026-04-13",bookedDays:2,paidDays:2,revenue:600.0,status:"completed",sourceRows:["Customer list 2026 row 219"],pendingReviewBoundary:false},
{id:"imp_r374",customerId:"imp_c339",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2026-04-12",endDate:"2026-04-15",bookedDays:3,paidDays:3,revenue:1160.0,status:"completed",sourceRows:["Customer list 2026 row 220"],pendingReviewBoundary:false},
{id:"imp_r375",customerId:"imp_c340",bikeModel:"Aerox Standard",bikeNameRaw:"RAX blue",plate:"",startDate:"2026-04-15",endDate:"2026-04-19",bookedDays:4,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 221"],pendingReviewBoundary:false},
{id:"imp_r376",customerId:"imp_c341",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 6",plate:"",startDate:"2026-04-17",endDate:"2026-05-11",bookedDays:24,paidDays:24,revenue:2800.0,status:"completed",sourceRows:["Customer list 2026 row 223"],pendingReviewBoundary:false},
{id:"imp_r377",customerId:"imp_c342",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-04-18",endDate:"2026-04-19",bookedDays:1,paidDays:1,revenue:700.0,status:"completed",sourceRows:["Customer list 2026 row 224"],pendingReviewBoundary:false},
{id:"imp_r378",customerId:"imp_c343",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 3",plate:"",startDate:"2026-04-18",endDate:"2026-05-01",bookedDays:13,paidDays:13,revenue:1900.0,status:"completed",sourceRows:["Customer list 2026 row 225"],pendingReviewBoundary:false},
{id:"imp_r379",customerId:"imp_c344",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-04-20",endDate:"2026-04-28",bookedDays:8,paidDays:8,revenue:2100.0,status:"completed",sourceRows:["Customer list 2026 row 228"],pendingReviewBoundary:false},
{id:"imp_r380",customerId:"imp_c345",bikeModel:"Aerox Standard",bikeNameRaw:"Freego white",plate:"",startDate:"2026-05-01",endDate:"2026-05-08",bookedDays:7,paidDays:7,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 234"],pendingReviewBoundary:false},
{id:"imp_r381",customerId:"imp_c346",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-04-24",endDate:"2026-04-24",bookedDays:1,paidDays:1,revenue:600.0,status:"completed",sourceRows:["Customer list 2026 row 235"],pendingReviewBoundary:false},
{id:"imp_r382",customerId:"imp_c347",bikeModel:"NMAX",bikeNameRaw:"Nmax black",plate:"",startDate:"2026-04-24",endDate:"2026-07-17",bookedDays:30,paidDays:84,revenue:12450.0,status:"completed",sourceRows:["Customer list 2026 row 236","Customer list 2026 row 279"],pendingReviewBoundary:false},
{id:"imp_r383",customerId:"imp_c348",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2026-04-25",endDate:"2026-04-29",bookedDays:4,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 237"],pendingReviewBoundary:false},
{id:"imp_r384",customerId:"imp_c349",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2026-04-25",endDate:"2026-05-02",bookedDays:7,paidDays:7,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 238"],pendingReviewBoundary:false},
{id:"imp_r385",customerId:"imp_c350",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2026-04-26",endDate:"2026-05-03",bookedDays:7,paidDays:7,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 239"],pendingReviewBoundary:false},
{id:"imp_r386",customerId:"imp_c350",bikeModel:"Aerox Standard",bikeNameRaw:"rax blue (155)",plate:"",startDate:"2026-07-09",endDate:"2026-07-13",bookedDays:4,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 354"],pendingReviewBoundary:false},
{id:"imp_r387",customerId:"imp_c351",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-04-26",endDate:"2026-05-03",bookedDays:7,paidDays:7,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 240"],pendingReviewBoundary:false},
{id:"imp_r388",customerId:"imp_c351",bikeModel:"NMAX",bikeNameRaw:"nmax white (155)",plate:"",startDate:"2026-07-09",endDate:"2026-07-13",bookedDays:4,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 355"],pendingReviewBoundary:false},
{id:"imp_r389",customerId:"imp_c352",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2026-04-27",endDate:"2026-04-29",bookedDays:2,paidDays:2,revenue:700.0,status:"completed",sourceRows:["Customer list 2026 row 241"],pendingReviewBoundary:false},
{id:"imp_r390",customerId:"imp_c353",bikeModel:"Aerox Standard",bikeNameRaw:"GT Burgandy",plate:"",startDate:"2026-04-27",endDate:"2026-05-11",bookedDays:14,paidDays:14,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 242"],pendingReviewBoundary:false},
{id:"imp_r391",customerId:"imp_c354",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2026-04-30",endDate:"2026-05-30",bookedDays:30,paidDays:30,revenue:4000.0,status:"completed",sourceRows:["Customer list 2026 row 246"],pendingReviewBoundary:false},
{id:"imp_r392",customerId:"imp_c355",bikeModel:"Aerox Standard",bikeNameRaw:"Freego black",plate:"",startDate:"2026-04-30",endDate:"2026-05-01",bookedDays:1,paidDays:1,revenue:600.0,status:"completed",sourceRows:["Customer list 2026 row 248"],pendingReviewBoundary:false},
{id:"imp_r393",customerId:"imp_c356",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-05-01",endDate:"2026-05-03",bookedDays:2,paidDays:2,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 250"],pendingReviewBoundary:false},
{id:"imp_r394",customerId:"imp_c357",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-05-04",endDate:"2026-05-18",bookedDays:14,paidDays:14,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 253"],pendingReviewBoundary:false},
{id:"imp_r395",customerId:"imp_c358",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-05-05",endDate:"2026-05-07",bookedDays:2,paidDays:2,revenue:900.0,status:"completed",sourceRows:["Customer list 2026 row 254"],pendingReviewBoundary:false},
{id:"imp_r396",customerId:"imp_c359",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 2",plate:"",startDate:"2026-05-05",endDate:"2026-07-05",bookedDays:31,paidDays:61,revenue:6000.0,status:"completed",sourceRows:["Customer list 2026 row 256","Customer list 2026 row 306"],pendingReviewBoundary:false},
{id:"imp_r397",customerId:"imp_c360",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-05-06",endDate:"2026-05-12",bookedDays:6,paidDays:6,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 257"],pendingReviewBoundary:false},
{id:"imp_r398",customerId:"imp_c361",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 3",plate:"",startDate:"2026-05-06",endDate:"2026-05-19",bookedDays:13,paidDays:13,revenue:1900.0,status:"completed",sourceRows:["Customer list 2026 row 259"],pendingReviewBoundary:false},
{id:"imp_r399",customerId:"imp_c361",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-06-03",endDate:"2026-06-13",bookedDays:10,paidDays:10,revenue:1600.0,status:"completed",sourceRows:["Customer list 2026 row 305"],pendingReviewBoundary:false},
{id:"imp_r400",customerId:"imp_c362",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 2",plate:"",startDate:"2026-05-06",endDate:"2026-05-13",bookedDays:7,paidDays:7,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 260"],pendingReviewBoundary:false},
{id:"imp_r401",customerId:"imp_c363",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2026-05-07",endDate:"2026-06-07",bookedDays:31,paidDays:31,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 261"],pendingReviewBoundary:false},
{id:"imp_r402",customerId:"imp_c364",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2026-05-07",endDate:"2026-05-11",bookedDays:4,paidDays:4,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 262"],pendingReviewBoundary:false},
{id:"imp_r403",customerId:"imp_c365",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-05-07",endDate:"2026-05-09",bookedDays:2,paidDays:2,revenue:800.0,status:"completed",sourceRows:["Customer list 2026 row 263"],pendingReviewBoundary:false},
{id:"imp_r404",customerId:"imp_c366",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-05-07",endDate:"2026-05-21",bookedDays:14,paidDays:14,revenue:2700.0,status:"completed",sourceRows:["Customer list 2026 row 264"],pendingReviewBoundary:false},
{id:"imp_r405",customerId:"imp_c367",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Red 1",plate:"",startDate:"2026-05-08",endDate:"2026-05-10",bookedDays:2,paidDays:2,revenue:800.0,status:"completed",sourceRows:["Customer list 2026 row 265"],pendingReviewBoundary:false},
{id:"imp_r406",customerId:"imp_c368",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-05-08",endDate:"2026-05-19",bookedDays:11,paidDays:11,revenue:4900.0,status:"completed",sourceRows:["Customer list 2026 row 266"],pendingReviewBoundary:false},
{id:"imp_r407",customerId:"imp_c369",bikeModel:"Aerox Standard",bikeNameRaw:"Freego white",plate:"",startDate:"2026-05-11",endDate:"2026-06-22",bookedDays:42,paidDays:42,revenue:4200.0,status:"completed",sourceRows:["Customer list 2026 row 267"],pendingReviewBoundary:false},
{id:"imp_r408",customerId:"imp_c369",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2026-07-31",endDate:null,bookedDays:1,paidDays:31,revenue:3500.0,status:"active",sourceRows:["Customer list 2026 row 378","Customer list 2026 row 380"],pendingReviewBoundary:false},
{id:"imp_r409",customerId:"imp_c370",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2026-05-11",endDate:"2026-05-14",bookedDays:3,paidDays:3,revenue:900.0,status:"completed",sourceRows:["Customer list 2026 row 269"],pendingReviewBoundary:false},
{id:"imp_r410",customerId:"imp_c371",bikeModel:"NMAX",bikeNameRaw:"Nmax Blue",plate:"",startDate:"2026-05-12",endDate:"2026-06-12",bookedDays:31,paidDays:31,revenue:5000.0,status:"completed",sourceRows:["Customer list 2026 row 270"],pendingReviewBoundary:false},
{id:"imp_r411",customerId:"imp_c372",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 2",plate:"",startDate:"2026-05-13",endDate:"2026-06-13",bookedDays:31,paidDays:31,revenue:4500.0,status:"completed",sourceRows:["Customer list 2026 row 271"],pendingReviewBoundary:false},
{id:"imp_r412",customerId:"imp_c373",bikeModel:"NMAX",bikeNameRaw:"Nmax grey",plate:"",startDate:"2026-05-18",endDate:"2026-05-20",bookedDays:2,paidDays:2,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 272"],pendingReviewBoundary:false},
{id:"imp_r413",customerId:"imp_c374",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2026-05-20",endDate:"2026-06-16",bookedDays:14,paidDays:27,revenue:4800.0,status:"completed",sourceRows:["Customer list 2026 row 274","Customer list 2026 row 303"],pendingReviewBoundary:false},
{id:"imp_r414",customerId:"imp_c375",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-05-20",endDate:"2026-06-20",bookedDays:31,paidDays:31,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 275"],pendingReviewBoundary:false},
{id:"imp_r415",customerId:"imp_c376",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1/ GT Red 2/ GT 3 and GT black 4",plate:"",startDate:"2026-05-20",endDate:"2026-05-23",bookedDays:3,paidDays:3,revenue:2400.0,status:"completed",sourceRows:["Customer list 2026 row 276"],pendingReviewBoundary:false},
{id:"imp_r416",customerId:"imp_c377",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox red 1",plate:"",startDate:"2026-05-21",endDate:"2026-05-24",bookedDays:3,paidDays:3,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 278"],pendingReviewBoundary:false},
{id:"imp_r417",customerId:"imp_c378",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 2",plate:"",startDate:"2026-05-23",endDate:"2026-05-29",bookedDays:6,paidDays:6,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 280"],pendingReviewBoundary:false},
{id:"imp_r418",customerId:"imp_c379",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 2",plate:"",startDate:"2026-05-23",endDate:"2026-06-23",bookedDays:31,paidDays:31,revenue:4500.0,status:"completed",sourceRows:["Customer list 2026 row 281"],pendingReviewBoundary:false},
{id:"imp_r419",customerId:"imp_c380",bikeModel:"NMAX",bikeNameRaw:"Nmax Grey",plate:"",startDate:"2026-05-25",endDate:"2026-06-25",bookedDays:31,paidDays:31,revenue:5000.0,status:"completed",sourceRows:["Customer list 2026 row 282"],pendingReviewBoundary:false},
{id:"imp_r420",customerId:"imp_c381",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 4",plate:"",startDate:"2026-05-25",endDate:"2026-05-30",bookedDays:5,paidDays:5,revenue:1100.0,status:"completed",sourceRows:["Customer list 2026 row 283"],pendingReviewBoundary:false},
{id:"imp_r421",customerId:"imp_c382",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-05-27",endDate:"2026-06-08",bookedDays:12,paidDays:12,revenue:5000.0,status:"completed",sourceRows:["Customer list 2026 row 284"],pendingReviewBoundary:false},
{id:"imp_r422",customerId:"imp_c383",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-05-27",endDate:"2026-05-30",bookedDays:3,paidDays:3,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 286"],pendingReviewBoundary:false},
{id:"imp_r423",customerId:"imp_c384",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2026-05-30",endDate:"2026-06-04",bookedDays:5,paidDays:5,revenue:1250.0,status:"completed",sourceRows:["Customer list 2026 row 293"],pendingReviewBoundary:false},
{id:"imp_r424",customerId:"imp_c385",bikeModel:"Aerox Standard",bikeNameRaw:"GT silver 1",plate:"",startDate:"2026-05-31",endDate:null,bookedDays:30,paidDays:92,revenue:9200.0,status:"active",sourceRows:["Customer list 2026 row 294","Customer list 2026 row 336","Customer list 2026 row 375"],pendingReviewBoundary:false},
{id:"imp_r425",customerId:"imp_c386",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Red",plate:"",startDate:"2026-06-01",endDate:"2026-06-18",bookedDays:17,paidDays:17,revenue:3500.0,status:"completed",sourceRows:["Customer list 2026 row 298"],pendingReviewBoundary:false},
{id:"imp_r426",customerId:"imp_c387",bikeModel:"Aerox Standard",bikeNameRaw:"Cool 1",plate:"",startDate:"2026-06-01",endDate:"2026-06-07",bookedDays:6,paidDays:6,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 299"],pendingReviewBoundary:false},
{id:"imp_r427",customerId:"imp_c388",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-06-01",endDate:"2026-06-04",bookedDays:3,paidDays:3,revenue:900.0,status:"completed",sourceRows:["Customer list 2026 row 300"],pendingReviewBoundary:false},
{id:"imp_r428",customerId:"imp_c389",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 3",plate:"",startDate:"2026-06-01",endDate:null,bookedDays:30,paidDays:92,revenue:9000.0,status:"active",sourceRows:["Customer list 2026 row 301","Customer list 2026 row 339","Customer list 2026 row 379"],pendingReviewBoundary:false},
{id:"imp_r429",customerId:"imp_c390",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox red 1",plate:"",startDate:"2026-06-02",endDate:"2026-06-05",bookedDays:3,paidDays:3,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 304"],pendingReviewBoundary:false},
{id:"imp_r430",customerId:"imp_c391",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2026-06-04",endDate:"2026-06-14",bookedDays:10,paidDays:10,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 307"],pendingReviewBoundary:false},
{id:"imp_r431",customerId:"imp_c392",bikeModel:"Aerox Standard",bikeNameRaw:"Freego Red",plate:"",startDate:"2026-06-04",endDate:"2026-06-14",bookedDays:10,paidDays:10,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 308"],pendingReviewBoundary:false},
{id:"imp_r432",customerId:"imp_c393",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2026-06-06",endDate:"2026-06-13",bookedDays:7,paidDays:7,revenue:1900.0,status:"completed",sourceRows:["Customer list 2026 row 309"],pendingReviewBoundary:false},
{id:"imp_r433",customerId:"imp_c394",bikeModel:"Aerox Standard",bikeNameRaw:"GT black 5",plate:"",startDate:"2026-06-08",endDate:"2026-07-08",bookedDays:30,paidDays:30,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 312"],pendingReviewBoundary:false},
{id:"imp_r434",customerId:"imp_c395",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox red 1",plate:"",startDate:"2026-06-11",endDate:null,bookedDays:30,paidDays:61,revenue:7000.0,status:"active",sourceRows:["Customer list 2026 row 313","Customer list 2026 row 356"],pendingReviewBoundary:false},
{id:"imp_r435",customerId:"imp_c396",bikeModel:"Aerox Standard",bikeNameRaw:"RAX blue",plate:"",startDate:"2026-06-11",endDate:"2026-06-14",bookedDays:3,paidDays:3,revenue:1400.0,status:"completed",sourceRows:["Customer list 2026 row 314"],pendingReviewBoundary:false},
{id:"imp_r436",customerId:"imp_c397",bikeModel:"Forza",bikeNameRaw:"Forza",plate:"",startDate:"2026-06-12",endDate:"2026-06-19",bookedDays:7,paidDays:7,revenue:3500.0,status:"completed",sourceRows:["Customer list 2026 row 315"],pendingReviewBoundary:false},
{id:"imp_r437",customerId:"imp_c398",bikeModel:"Aerox Standard",bikeNameRaw:"GT 3",plate:"",startDate:"2026-06-15",endDate:"2026-07-04",bookedDays:19,paidDays:19,revenue:2600.0,status:"completed",sourceRows:["Customer list 2026 row 316"],pendingReviewBoundary:false},
{id:"imp_r438",customerId:"imp_c399",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-06-16",endDate:"2026-06-23",bookedDays:7,paidDays:7,revenue:1400.0,status:"completed",sourceRows:["Customer list 2026 row 317"],pendingReviewBoundary:false},
{id:"imp_r439",customerId:"imp_c400",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2",plate:"",startDate:"2026-06-16",endDate:"2026-06-25",bookedDays:9,paidDays:9,revenue:1900.0,status:"completed",sourceRows:["Customer list 2026 row 318"],pendingReviewBoundary:false},
{id:"imp_r440",customerId:"imp_c401",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2026-06-17",endDate:"2026-06-20",bookedDays:3,paidDays:3,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 319"],pendingReviewBoundary:false},
{id:"imp_r441",customerId:"imp_c402",bikeModel:"Aerox Standard",bikeNameRaw:"Cool blue 1",plate:"",startDate:"2026-06-17",endDate:"2026-06-22",bookedDays:5,paidDays:5,revenue:1900.0,status:"completed",sourceRows:["Customer list 2026 row 320"],pendingReviewBoundary:false},
{id:"imp_r442",customerId:"imp_c403",bikeModel:"XMAX",bikeNameRaw:"Xmax",plate:"",startDate:"2026-06-18",endDate:null,bookedDays:6,paidDays:66,revenue:21700.0,status:"active",sourceRows:["Customer list 2026 row 321","Customer list 2026 row 325","Customer list 2026 row 368"],pendingReviewBoundary:false},
{id:"imp_r443",customerId:"imp_c404",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 3",plate:"",startDate:"2026-06-19",endDate:"2026-07-09",bookedDays:20,paidDays:20,revenue:3350.0,status:"completed",sourceRows:["Customer list 2026 row 323"],pendingReviewBoundary:false},
{id:"imp_r444",customerId:"imp_c405",bikeModel:"NMAX",bikeNameRaw:"RAX red/ Nmax white",plate:"",startDate:"2026-06-22",endDate:"2026-06-28",bookedDays:3,paidDays:6,revenue:3900.0,status:"completed",sourceRows:["Customer list 2026 row 324","Customer list 2026 row 328"],pendingReviewBoundary:false},
{id:"imp_r445",customerId:"imp_c406",bikeModel:"Aerox Standard",bikeNameRaw:"GT red 1",plate:"",startDate:"2026-06-23",endDate:"2026-06-30",bookedDays:7,paidDays:7,revenue:1300.0,status:"completed",sourceRows:["Customer list 2026 row 326"],pendingReviewBoundary:false},
{id:"imp_r446",customerId:"imp_c407",bikeModel:"Aerox Standard",bikeNameRaw:"RAX Blue",plate:"",startDate:"2026-06-24",endDate:"2026-07-05",bookedDays:11,paidDays:11,revenue:3000.0,status:"completed",sourceRows:["Customer list 2026 row 327"],pendingReviewBoundary:false},
{id:"imp_r447",customerId:"imp_c408",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox Green",plate:"",startDate:"2026-06-26",endDate:"2026-07-04",bookedDays:8,paidDays:8,revenue:2000.0,status:"completed",sourceRows:["Customer list 2026 row 331"],pendingReviewBoundary:false},
{id:"imp_r448",customerId:"imp_c409",bikeModel:"NMAX",bikeNameRaw:"Nmax grey 1",plate:"",startDate:"2026-06-27",endDate:null,bookedDays:30,paidDays:61,revenue:8200.0,status:"active",sourceRows:["Customer list 2026 row 332","Customer list 2026 row 374"],pendingReviewBoundary:false},
{id:"imp_r449",customerId:"imp_c410",bikeModel:"Aerox Standard",bikeNameRaw:"GT 2 / GT black 4",plate:"",startDate:"2026-06-28",endDate:"2026-07-01",bookedDays:3,paidDays:3,revenue:1500.0,status:"completed",sourceRows:["Customer list 2026 row 333"],pendingReviewBoundary:false},
{id:"imp_r450",customerId:"imp_c411",bikeModel:"Aerox Standard",bikeNameRaw:"Freego white",plate:"",startDate:"2026-06-29",endDate:"2026-07-04",bookedDays:5,paidDays:5,revenue:1200.0,status:"completed",sourceRows:["Customer list 2026 row 337"],pendingReviewBoundary:false},
{id:"imp_r451",customerId:"imp_c412",bikeModel:"Aerox Standard",bikeNameRaw:"Cool Blue 2",plate:"",startDate:"2026-06-30",endDate:null,bookedDays:30,paidDays:61,revenue:8000.0,status:"active",sourceRows:["Customer list 2026 row 340","Customer list 2026 row 377"],pendingReviewBoundary:false},
{id:"imp_r452",customerId:"imp_c413",bikeModel:"Aerox Standard",bikeNameRaw:"RAX 1",plate:"",startDate:"2026-07-01",endDate:null,bookedDays:92,paidDays:92,revenue:9500.0,status:"active",sourceRows:["Customer list 2026 row 342"],pendingReviewBoundary:false},
{id:"imp_r453",customerId:"imp_c414",bikeModel:"Aerox Standard",bikeNameRaw:"Freego white",plate:"",startDate:"2026-07-03",endDate:null,bookedDays:29,paidDays:43,revenue:4200.0,status:"active",sourceRows:["Customer list 2026 row 345","Customer list 2026 row 383"],pendingReviewBoundary:false},
{id:"imp_r454",customerId:"imp_c415",bikeModel:"Aerox Standard",bikeNameRaw:"GT Black 4",plate:"",startDate:"2026-07-04",endDate:"2026-07-07",bookedDays:3,paidDays:3,revenue:1000.0,status:"completed",sourceRows:["Customer list 2026 row 346"],pendingReviewBoundary:false},
{id:"imp_r455",customerId:"imp_c416",bikeModel:"Aerox Standard",bikeNameRaw:"aerox cool blue 1 (155)",plate:"",startDate:"2026-07-06",endDate:null,bookedDays:26,paidDays:26,revenue:4500.0,status:"active",sourceRows:["Customer list 2026 row 348"],pendingReviewBoundary:false},
{id:"imp_r456",customerId:"imp_c417",bikeModel:"NMAX",bikeNameRaw:"nmax grey 2 (155)",plate:"",startDate:"2026-07-08",endDate:null,bookedDays:24,paidDays:24,revenue:5000.0,status:"active",sourceRows:["Customer list 2026 row 350"],pendingReviewBoundary:false},
{id:"imp_r457",customerId:"imp_c418",bikeModel:"125cc",bikeNameRaw:"freego white  (125)",plate:"",startDate:"2026-07-08",endDate:"2026-08-01",bookedDays:3,paidDays:24,revenue:4100.0,status:"completed",sourceRows:["Customer list 2026 row 351","Customer list 2026 row 358"],pendingReviewBoundary:false},
{id:"imp_r458",customerId:"imp_c419",bikeModel:"125cc",bikeNameRaw:"gt  black 2  (125)",plate:"",startDate:"2026-07-09",endDate:null,bookedDays:45,paidDays:45,revenue:5000.0,status:"active",sourceRows:["Customer list 2026 row 353"],pendingReviewBoundary:false},
{id:"imp_r459",customerId:"imp_c420",bikeModel:"Aerox Standard",bikeNameRaw:"rax 3 (155)",plate:"",startDate:"2026-07-11",endDate:"2026-07-18",bookedDays:7,paidDays:7,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 357"],pendingReviewBoundary:false},
{id:"imp_r460",customerId:"imp_c421",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox cool 2",plate:"",startDate:"2026-07-13",endDate:null,bookedDays:33,paidDays:33,revenue:4800.0,status:"active",sourceRows:["Customer list 2026 row 360"],pendingReviewBoundary:false},
{id:"imp_r461",customerId:"imp_c422",bikeModel:"Aerox Standard",bikeNameRaw:"Rax blue",plate:"",startDate:"2026-07-15",endDate:"2026-07-21",bookedDays:4,paidDays:6,revenue:1800.0,status:"completed",sourceRows:["Customer list 2026 row 361","Customer list 2026 row 365"],pendingReviewBoundary:false},
{id:"imp_r462",customerId:"imp_c423",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox green",plate:"",startDate:"2026-07-16",endDate:"2026-07-31",bookedDays:15,paidDays:15,revenue:2700.0,status:"completed",sourceRows:["Customer list 2026 row 362"],pendingReviewBoundary:false},
{id:"imp_r463",customerId:"imp_c424",bikeModel:"NMAX",bikeNameRaw:"Nmax white",plate:"",startDate:"2026-07-17",endDate:null,bookedDays:39,paidDays:39,revenue:6500.0,status:"active",sourceRows:["Customer list 2026 row 363"],pendingReviewBoundary:false},
{id:"imp_r464",customerId:"imp_c425",bikeModel:"NMAX",bikeNameRaw:"Nmax black",plate:"",startDate:"2026-07-18",endDate:null,bookedDays:23,paidDays:23,revenue:4000.0,status:"active",sourceRows:["Customer list 2026 row 364"],pendingReviewBoundary:false},
{id:"imp_r465",customerId:"imp_c426",bikeModel:"Aerox Standard",bikeNameRaw:"Freego red",plate:"",startDate:"2026-07-24",endDate:"2026-07-27",bookedDays:3,paidDays:3,revenue:1100.0,status:"completed",sourceRows:["Customer list 2026 row 369"],pendingReviewBoundary:false},
{id:"imp_r466",customerId:"imp_c427",bikeModel:"Aerox Standard",bikeNameRaw:"Rax red",plate:"",startDate:"2026-07-25",endDate:"2026-07-26",bookedDays:1,paidDays:1,revenue:400.0,status:"completed",sourceRows:["Customer list 2026 row 370"],pendingReviewBoundary:false},
{id:"imp_r467",customerId:"imp_c428",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox cool 1",plate:"",startDate:"2026-07-26",endDate:"2026-07-31",bookedDays:5,paidDays:5,revenue:1600.0,status:"completed",sourceRows:["Customer list 2026 row 371"],pendingReviewBoundary:false},
{id:"imp_r468",customerId:"imp_c429",bikeModel:"Aerox Standard",bikeNameRaw:"Rax red",plate:"",startDate:"2026-07-28",endDate:null,bookedDays:3,paidDays:31,revenue:3500.0,status:"active",sourceRows:["Customer list 2026 row 373","Customer list 2026 row 376"],pendingReviewBoundary:false},
{id:"imp_r469",customerId:"imp_c430",bikeModel:"Aerox Standard",bikeNameRaw:"Aerox cool 1",plate:"",startDate:"2026-08-01",endDate:null,bookedDays:7,paidDays:7,revenue:2300.0,status:"active",sourceRows:["Customer list 2026 row 384"],pendingReviewBoundary:false},
{id:"imp_r470",customerId:"imp_c431",bikeModel:"Aerox Standard",bikeNameRaw:"Gt red 1",plate:"",startDate:"2026-08-02",endDate:null,bookedDays:7,paidDays:7,revenue:1300.0,status:"active",sourceRows:["Customer list 2026 row 385"],pendingReviewBoundary:false},
{id:"imp_r471",customerId:"imp_c432",bikeModel:"Aerox Standard",bikeNameRaw:"Gt red 2 papaya",plate:"",startDate:"2026-08-05",endDate:null,bookedDays:7,paidDays:7,revenue:1300.0,status:"active",sourceRows:["Customer list 2026 row 386"],pendingReviewBoundary:false},
{id:"imp_r472",customerId:"imp_c433",bikeModel:"Aerox Standard",bikeNameRaw:"Gt 2",plate:"",startDate:"2026-08-06",endDate:null,bookedDays:13,paidDays:13,revenue:1900.0,status:"active",sourceRows:["Customer list 2026 row 387"],pendingReviewBoundary:false},
{id:"imp_r473",customerId:"imp_c434",bikeModel:"NMAX",bikeNameRaw:"Nmax grey 2",plate:"",startDate:"2026-08-06",endDate:null,bookedDays:4,paidDays:4,revenue:1900.0,status:"active",sourceRows:["Customer list 2026 row 388"],pendingReviewBoundary:false},
];

const IMPORTED_NEEDS_REVIEW = [
{id:"nr_b1",type:"rental_boundary",customerId:"imp_c56",customerName:"Glovanni Mang",prevStart:"2025-06-03",prevEnd:"2025-07-01",nextStart:"2025-07-06",nextEnd:"2025-08-06",nextBike:"GT black 1",nextPrice:2500.0,gapDays:5,nextSourceRow:"Customer list 2025 row 120",resolved:true,resolution:"new_rental_returned_later"},
{id:"nr_b2",type:"rental_boundary",customerId:"imp_c58",customerName:"Almozaini Abdulaziz Saleh A",prevStart:"2025-08-07",prevEnd:"2025-10-07",nextStart:"2025-10-13",nextEnd:"2025-11-13",nextBike:"Cool 2",nextPrice:4000.0,gapDays:6,nextSourceRow:"Customer list 2025 row 259",resolved:false,resolution:null},
{id:"nr_b3",type:"rental_boundary",customerId:"imp_c60",customerName:"Nyi Nyi Kyaw Min",prevStart:"2025-06-23",prevEnd:"2025-06-25",nextStart:"2025-06-28",nextEnd:"2025-07-23",nextBike:"RAX 1",nextPrice:2500.0,gapDays:3,nextSourceRow:"Customer list 2025 row 104",resolved:false,resolution:null},
{id:"nr_b4",type:"rental_boundary",customerId:"imp_c114",customerName:"Byron George Edward Stevens",prevStart:"2025-07-31",prevEnd:"2025-10-30",nextStart:"2025-11-01",nextEnd:"2025-12-01",nextBike:"Drone",nextPrice:4000.0,gapDays:2,nextSourceRow:"Customer list 2025 row 293",resolved:true,resolution:"same_rental_continued"},
{id:"nr_b5",type:"rental_boundary",customerId:"imp_c146",customerName:"Luis Felipe Garcia",prevStart:"2025-09-15",prevEnd:"2025-10-15",nextStart:"2025-10-20",nextEnd:"2025-11-15",nextBike:"GT silver 2",nextPrice:2500.0,gapDays:5,nextSourceRow:"Customer list 2025 row 269",resolved:false,resolution:null},
{id:"nr_b6",type:"rental_boundary",customerId:"imp_c282",customerName:"Mr.Kartik Chandrasheker",prevStart:"2026-02-12",prevEnd:"2026-04-25",nextStart:"2026-05-01",nextEnd:"2026-05-07",nextBike:"GT red 2",nextPrice:900,gapDays:6,nextSourceRow:"Customer list 2026 row 251",resolved:false,resolution:null},
{id:"nr_c1",type:"customer_match",customerAId:"imp_c226",customerAName:"Ziyang Liu",customerBId:"imp_c414",customerBName:"Yang Liu",reason:"Similar name (\"Ziyang Liu\" vs \"Yang Liu\"), same nationality, but different passport-record coverage and rentals ~6 months apart. No positive evidence linking them.",resolved:false,resolution:null},
{id:"nr_c2",type:"customer_match",customerAId:"imp_c54",customerAName:"Alexander Vincent",customerBId:"imp_c345",customerBName:"Alexander Vincent Torre",reason:"Exact first+last name match, same nationality, but an additional surname (\"Torre\") appears in the 2026 record and the two clusters are ~4 months apart with no passport on the 2025 side to compare.",resolved:false,resolution:null},
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
    const customers = IMPORTED_CUSTOMERS;
    const rentals = IMPORTED_RENTALS;

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
  s = s.replace(/^(mr|mrs|ms|miss|dr)\.?\s*/i, "").trim();
  return s.split(/\s+/)[0] || s;
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

function runDataAudit() {
  const canonicalByCustomer = {};
  IMPORTED_RENTALS.forEach((r) => {
    (canonicalByCustomer[r.customerId] = canonicalByCustomer[r.customerId] || []).push(r);
  });

  const rows = [];
  IMPORTED_CUSTOMERS.forEach((seedCust) => {
    const custId = seedCust.id;
    const canonicalRentals = canonicalByCustomer[custId] || [];
    const canonicalVisits = canonicalRentals.length;
    const canonicalDays = canonicalRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const canonicalRevenue = canonicalRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    const canonicalIds = new Set(canonicalRentals.map((r) => r.id));

    // "Stored" = whatever is CURRENTLY loaded into DB.data for this customer right now, in
    // THIS browser — read only, via a plain .filter(), never written back anywhere.
    const storedCust = DB.data.customers.find((c) => c.id === custId);
    const displayName = storedCust ? storedCust.name : seedCust.name;
    const storedRentals = DB.data.rentals.filter((r) => r.customerId === custId);
    const storedVisits = storedRentals.length;
    const storedDays = storedRentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
    const storedRevenue = storedRentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);

    const isMatch = storedVisits === canonicalVisits && storedDays === canonicalDays && storedRevenue === canonicalRevenue;
    if (isMatch) return; // report only mismatches, per the requested format

    const custRewards = DB.data.rewards.filter((r) => r.customerId === custId);
    const hasRewardHistory = custRewards.some((r) => r.given || r.reserved);
    // A reward is "at risk" if it's already given/reserved AND it points at a specific
    // rental record that does NOT exist in the canonical set — meaning a blind swap to
    // canonical data would orphan that reward's link in any future repair.
    const riskyRewards = custRewards.filter((r) => (r.given || r.reserved) && r.rentalId && !canonicalIds.has(r.rentalId));

    rows.push({
      name: displayName,
      storedVisits, canonicalVisits,
      storedDays, canonicalDays,
      storedRevenue, canonicalRevenue,
      diffRevenue: storedRevenue - canonicalRevenue,
      excessRecords: storedVisits - canonicalVisits,
      hasRewardHistory,
      riskyRewardCount: riskyRewards.length,
      riskLevel: riskyRewards.length > 0 ? "NEEDS REVIEW" : "SAFE TO RECONCILE",
    });
  });

  const totalAudited = IMPORTED_CUSTOMERS.length;
  const mismatching = rows.length;
  const matching = totalAudited - mismatching;
  const totalDiffRevenue = rows.reduce((s, r) => s + r.diffRevenue, 0);
  const riskCustomers = rows.filter((r) => r.riskyRewardCount > 0).length;

  return {
    totalAudited, matching, mismatching, totalDiffRevenue, riskCustomers,
    rows: rows.sort((a, b) => Math.abs(b.diffRevenue) - Math.abs(a.diffRevenue)),
  };
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
  const canonicalByCustomer = {};
  IMPORTED_RENTALS.forEach((r) => {
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
    const storedRentals = DB.data.rentals.filter((r) => r.customerId === custId); // read-only filter
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
      <p class="screen-sub">Read-only — compares data currently stored on this device against the canonical data built into this version of the app. Nothing here can change any data.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value">${audit.totalAudited}</div><div class="report-tile-label">Customers Audited</div></div>
        <div class="report-tile"><div class="report-tile-value">${audit.matching}</div><div class="report-tile-label">Matching</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:${audit.mismatching > 0 ? "var(--red)" : "var(--ink)"};">${audit.mismatching}</div><div class="report-tile-label">Mismatching</div></div>
        <div class="report-tile"><div class="report-tile-value">${audit.riskCustomers}</div><div class="report-tile-label">Reward-Link Risk</div></div>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <div class="muted" style="font-size:12.5px;">Total excess/short revenue caused by stale records</div>
        <div style="font-family:var(--font-display); font-size:22px; font-weight:800; margin-top:4px;">${audit.totalDiffRevenue > 0 ? "+" : ""}${fmtMoney(audit.totalDiffRevenue)}</div>
      </div>

      ${audit.mismatching > 0 ? `
        <div class="card" style="margin-bottom:16px; border: 1.5px dashed var(--orange-soft-line);">
          <div style="font-weight:700; margin-bottom:6px;">Phase 2 — Reconciliation Preview</div>
          <p class="muted" style="margin-bottom:12px;">See exactly what a repair would change for each mismatched customer, before any repair exists. This preview cannot write any data — there is no repair button yet.</p>
          <button class="btn btn-outline btn-block" data-goto="reconcile-preview">View Reconciliation Preview</button>
        </div>
      ` : ""}

      ${audit.rows.length === 0 ? `
        <div class="empty"><div class="empty-icon">✓</div><h3>No mismatches found</h3><p>Every audited customer's stored data matches the canonical data exactly.</p></div>
      ` : audit.rows.map((r) => `
        <div class="card" style="margin-bottom:12px;">
          <div class="card-row" style="margin-bottom:8px;">
            <div style="font-weight:700; font-size:15px;">${escapeHtml(r.name)}</div>
            <span class="pill pill-red">MISMATCH</span>
          </div>
          <div class="grid-2" style="margin-bottom:8px;">
            <div><div class="muted" style="font-size:11px;">Rental Visits</div><div class="mono">${r.storedVisits} → ${r.canonicalVisits}</div></div>
            <div><div class="muted" style="font-size:11px;">Paid Days</div><div class="mono">${r.storedDays} → ${r.canonicalDays}</div></div>
            <div><div class="muted" style="font-size:11px;">Lifetime Revenue</div><div class="mono">${fmtMoney(r.storedRevenue)} → ${fmtMoney(r.canonicalRevenue)}</div></div>
            <div><div class="muted" style="font-size:11px;">Difference</div><div class="mono" style="color:${r.diffRevenue !== 0 ? "var(--red)" : "inherit"};">${r.diffRevenue > 0 ? "+" : ""}${fmtMoney(r.diffRevenue)}</div></div>
          </div>
          <div class="status-line" style="margin-bottom:8px;">
            <span>Excess/short records: <b>${r.excessRecords > 0 ? "+" : ""}${r.excessRecords}</b></span>
            <span>Reward History: <b>${r.hasRewardHistory ? "Yes" : "No"}</b></span>
            <span>Linked rewards at risk: <b>${r.riskyRewardCount}</b></span>
          </div>
          ${riskPill(r.riskLevel)}
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
      <p class="screen-sub">Preview only — shows exactly what a future repair would change. No write action exists on this screen yet.</p>
    </header>
    <div class="screen-body">
      <div class="report-grid" style="grid-template-columns: repeat(2, 1fr);">
        <div class="report-tile"><div class="report-tile-value">${plan.total}</div><div class="report-tile-label">Mismatched Customers</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--green);">${plan.safeCount}</div><div class="report-tile-label">SAFE</div></div>
        <div class="report-tile"><div class="report-tile-value" style="color:var(--red);">${plan.reviewCount}</div><div class="report-tile-label">Review Required</div></div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <p class="muted" style="margin-bottom:10px;">Optional: save a full backup of this device's current data now, ready for whenever a real repair step exists (this export itself changes nothing — it only downloads a copy).</p>
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

function customerStats(customer) {
  const rentals = customerRentals(customer.id);
  const current = rentals.find((r) => r.status === "active") || null;
  const completed = rentals.filter((r) => r.status === "completed");
  const paidRentalDays = rentals.reduce((s, r) => s + (Number(r.paidDays) || 0), 0);
  const lifetimeRentalDays = rentals.reduce((s, r) => {
    const end = r.endDate || todayISO();
    return s + Math.max(daysBetween(r.startDate, end), Number(r.paidDays) || 0);
  }, 0);
  const totalRevenue = rentals.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const previousBikes = [...new Set(completed.map((r) => rentalCategory(r)))];
  // Rental Visits = every genuine rental record (rentals.length). Qualified Rentals = the
  // subset substantial enough (by paid days or paid value) to count toward Ride Upgrade.
  const qualifiedRentals = rentals.filter(isQualifiedRental);

  return {
    rentals, current, completed,
    rentalCount: rentals.length,
    qualifiedRentalCount: qualifiedRentals.length,
    paidRentalDays, lifetimeRentalDays, totalRevenue,
    previousBikes,
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
    const cycleBaseline = lastUsed && lastUsed.cycleBaselinePaidDays !== undefined ? lastUsed.cycleBaselinePaidDays : 0;
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
    const cycleBaselineVip = lastUsedVip && lastUsedVip.cycleBaselinePaidDays !== undefined ? lastUsedVip.cycleBaselinePaidDays : 0;
    const cycleBaselineQualifiedVip = lastUsedVip && lastUsedVip.cycleBaselineQualifiedCount !== undefined ? lastUsedVip.cycleBaselineQualifiedCount : 0;
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

const state = { route: "home", customerId: null, vehicleId: null, search: "", expandedCard: null, searchOpen: false, rewardHistoryCustomerId: null, rewardHistorySearch: "", reportsPeriod: "month", rewardHistoryFilter: "all" };

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

  return `
    <div class="launcher-wrap dark-bg compact">
      <div class="launcher-compact-brand">
        <div class="launcher-compact-mark">AA</div>
        <div class="launcher-compact-text">
          <div class="launcher-compact-title">AA SCOOTER RENTAL</div>
          <div class="launcher-compact-sub">Chiang Mai · Internal Operations</div>
        </div>
      </div>
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
        <div class="cust-row-name">${escapeHtml(entry.customer.name)}</div>
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
  const list = insights.rewardsReady.slice().sort((a, b) => a.customer.name.localeCompare(b.customer.name));
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
        <div><div class="muted" style="font-size:11.5px;">Lifetime Revenue</div><div style="font-weight:700;">${fmtMoney(fin.lifetimeRevenue)}</div></div>
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
        <p class="muted">The AA Loyalty &amp; Rewards Program's official start date. Welcome Gift only applies to bookings handed over on or after this date; Journey Gift only applies to rentals that are still active, or that complete, on or after this date — a rental fully completed before it never creates a pending gift. Historical rentals before this date still count fully toward Times Rented, Qualified Rentals, Total Time with AA, Lifetime Revenue, and Ride Upgrade / Long-Term / VIP status — nothing about relationship history is lost, only physical gift obligations are not applied retroactively. Changing this date recalculates eligibility live without deleting any rental history.</p>
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
        <p class="muted" style="margin-bottom:12px;">Reward-to-Revenue Ratio = Total Reward Value ÷ Lifetime Revenue × 100. At or below the first number shows 🟢 Healthy, up to the second shows 🟡 Watch, above that shows 🔴 High. Individual rewards can still be manually overridden case by case via Edit / Undo.</p>
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
        <p class="muted" style="margin-bottom:12px;">Bring in customers, rentals, or vehicles from a spreadsheet (e.g. exported from Google Sheets as CSV). This app never reads live from a spreadsheet — import is a one-time or occasional action, and everything then runs from this device's own database. Existing records are matched first; nothing is overwritten without your say-so.</p>
        <div class="btn-row">
          <button class="btn btn-orange btn-sm" id="start-import">Import from CSV…</button>
        </div>
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
        rec._existing = cust
          ? DB.data.rentals.find((r) => r.customerId === cust.id && normalizeText(r.bikeModel) === normalizeText(rec.bikeModel) && r.startDate === rec.startDate) || null
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
          id: uid("r"), customerId: customer.id, bikeModel: rec.bikeModel, plate: rec.plate || "",
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
        }
      } else if ((type === "premium_ride" || type === "vip_extra_day") && rw.given && !newGiven) {
        delete rw.cycleBaselinePaidDays;
        delete rw.cycleBaselineQualifiedCount;
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
