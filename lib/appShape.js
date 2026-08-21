// Converts loyaltyMatch.build()'s pipeline output (C0001/R00001-style ids)
// into the exact shape app.js's IMPORTED_CUSTOMERS/IMPORTED_RENTALS (and the
// Drive-backed loyalty_customers.json/loyalty_rentals.json files GET
// /api/loyalty serves) use -- imp_cN/imp_rN ids. JS port of
// transform_to_app_shape.py, same field mapping.
'use strict';

function custNum(cid) { return parseInt(cid.slice(1), 10); }
function rentalNum(rid) { return parseInt(rid.slice(1), 10); }

function toAppShape(customers, rentals) {
  const appCustomers = customers.map((c) => {
    const n = custNum(c.customer_id);
    const variants = c.name_variants.filter((v) => v !== c.name);
    const passports = c.passport_numbers;
    const phones = c.phone_numbers;
    return {
      id: `imp_c${n}`,
      name: c.name,
      mergedNames: variants,
      nationality: c.nationality || '',
      passport: passports.length === 1 ? passports[0] : (passports.length ? passports.join(', ') : null),
      phone: phones.length === 1 ? phones[0] : (phones.length ? phones.join(', ') : ''),
      notes: '',
      firstSeen: c.first_rental_date,
      source: 'import',
    };
  });

  const appRentals = rentals.map((r) => ({
    id: `imp_r${rentalNum(r.rental_id)}`,
    customerId: `imp_c${custNum(r.customer_id)}`,
    bikeModel: r.bike_model,
    bikeNameRaw: r.bike_name_raw,
    plate: '',
    startDate: r.start_date,
    endDate: r.end_date,
    bookedDays: r.booked_days,
    paidDays: r.paid_days,
    revenue: r.revenue,
    status: r.status,
    sourceRows: r.source_row ? [r.source_row] : [],
    pendingReviewBoundary: false,
    ...(r.consolidated_from ? { consolidatedFrom: r.consolidated_from } : {}),
  }));

  return { customers: appCustomers, rentals: appRentals };
}

module.exports = { toAppShape };
