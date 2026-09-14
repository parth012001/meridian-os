// Sample data for Meridian Door & Hardware. Dates are relative to TODAY so the demo works any day.
import { resetDb, db } from "./db.js";
import { today, addDays } from "./world.js";
import { log } from "./ledger.js";

export function seed() {
  const t = today(); const d = (n: number) => addDays(t, n);   // computed per seed, so a long-running server does not drift from today()
  const D = resetDb();
  const run = (sql: string, rows: unknown[][]) => { const s = D.prepare(sql); for (const r of rows) s.run(...r); };

  run("INSERT INTO customers VALUES (?,?,?,?)", [
    ["CUST_ACME", "Acme General Contractors", "contractor", "pm@acmegc.example"],
    ["CUST_BRIDGE", "Bridgewater Builders", "builder", "orders@bridgewater.example"],
    ["CUST_MERCY", "Mercy Regional Hospital", "facility", "facilities@mercy.example"],
    ["CUST_NORTH", "Northgate Door Co (dealer)", "dealer", "buy@northgate.example"],
    ["CUST_LINCOLN", "Lincoln County Schools", "facility", "ops@lcs.example"],
    ["CUST_PEAK", "Peak Commercial Interiors", "contractor", "field@peakci.example"],
    ["CUST_HARBOR", "Harbor Point Development", "builder", "construction@harborpt.example"],
    ["CUST_SUMMIT", "Summit Property Mgmt", "facility", "maint@summitpm.example"],
  ]);

  run("INSERT INTO suppliers VALUES (?,?,?,?,?,?)", [
    ["SUP_IRON", "Ironline Metal Doors & Frames", "hollow metal doors, hollow metal frames", 60, 450, 7],
    ["SUP_OAK", "Oakridge Architectural Wood", "wood doors", 84, 600, 14],
    ["SUP_KEY", "Keystone Hardware Group", "locks, closers, hinges, exit devices", 45, 150, 5],
    ["SUP_APEX", "Apex Frame Works", "hollow metal frames", 50, 400, 6],
  ]);

  // skus: id, supplier, category, description, unit_cost, list_price, fire_rating, substitutable_group
  run("INSERT INTO skus VALUES (?,?,?,?,?,?,?,?)", [
    ["HMD-3070-16", "SUP_IRON", "door", "HM door 3'0x7'0 16ga, non-rated", 310, 465, null, "hmd-3070"],
    ["HMD-3070-16-90", "SUP_IRON", "door", "HM door 3'0x7'0 16ga, 90-min label", 385, 578, "90min", "hmd-3070-fr"],
    ["HMD-3670-16", "SUP_IRON", "door", "HM door 3'6x7'0 16ga, non-rated", 340, 510, null, null],
    ["HMF-3070-DW", "SUP_IRON", "frame", "HM frame 3'0x7'0, 4-7/8 drywall, non-rated", 145, 218, null, "hmf-3070-dw"],
    ["HMF-3070-MAS", "SUP_IRON", "frame", "HM frame 3'0x7'0, 5-3/4 masonry, non-rated", 160, 240, null, "hmf-3070-mas"],
    ["HMF-3070-DW-90", "SUP_IRON", "frame", "HM frame 3'0x7'0, 4-7/8 drywall, 90-min label", 185, 278, "90min", "hmf-3070-dw-fr"],
    ["HMF-6070-DW", "SUP_IRON", "frame", "HM pair frame 6'0x7'0, 4-7/8 drywall, non-rated", 240, 360, null, null],
    ["APX-F3070-DW", "SUP_APEX", "frame", "Apex HM frame 3'0x7'0, 4-7/8 drywall, non-rated (equiv)", 150, 225, null, "hmf-3070-dw"],
    ["APX-F3070-DW-90", "SUP_APEX", "frame", "Apex HM frame 3'0x7'0, 4-7/8 drywall, 90-min label (equiv)", 192, 288, "90min", "hmf-3070-dw-fr"],
    ["APX-F3070-MAS", "SUP_APEX", "frame", "Apex HM frame 3'0x7'0, 5-3/4 masonry, non-rated (equiv)", 165, 248, null, "hmf-3070-mas"],
    ["WD-3070-BIRCH", "SUP_OAK", "door", "Flush wood door 3'0x7'0, birch veneer, non-rated", 265, 398, null, "wd-3070"],
    ["WD-3070-OAK", "SUP_OAK", "door", "Flush wood door 3'0x7'0, red oak veneer, non-rated", 290, 435, null, "wd-3070"],
    ["WD-3070-BIRCH-20", "SUP_OAK", "door", "Flush wood door 3'0x7'0, birch, 20-min label", 305, 458, "20min", null],
    ["HW-HINGE-45", "SUP_KEY", "hardware", "Hinge 4.5x4.5 ball bearing, US26D (pair of 3)", 28, 42, null, null],
    ["HW-LOCK-F75", "SUP_KEY", "hardware", "Cylindrical lock F75 storeroom, US26D", 165, 248, null, null],
    ["HW-LOCK-F82", "SUP_KEY", "hardware", "Cylindrical lock F82 classroom, US26D", 178, 267, null, null],
    ["HW-LOCK-F04", "SUP_KEY", "hardware", "Cylindrical lever F04 passage, US26D", 85, 128, null, null],
    ["HW-CLOSER-4040", "SUP_KEY", "hardware", "Surface closer 4040 series, AL", 210, 315, null, null],
    ["HW-EXIT-RIM", "SUP_KEY", "hardware", "Rim exit device, fire-rated, US32D", 520, 780, "fire", null],
    ["HW-STOP-WALL", "SUP_KEY", "hardware", "Wall stop, US26D", 6, 9, null, null],
    ["HW-KICK-8", "SUP_KEY", "hardware", "Kick plate 8x34, US32D", 34, 51, null, null],
  ]);

  // inventory: sku, branch, on_hand, allocated
  run("INSERT INTO inventory VALUES (?,?,?,?)", [
    ["HMD-3070-16", "main", 14, 6], ["HMD-3070-16", "east", 8, 0],
    ["HMF-3070-DW", "main", 4, 4], ["HMF-3070-DW", "east", 12, 0], ["HMF-3070-DW", "west", 3, 3],
    ["HMF-3070-MAS", "main", 2, 2], ["HMF-3070-MAS", "east", 0, 0],
    ["HMF-3070-DW-90", "main", 1, 1],
    ["APX-F3070-DW-90", "main", 8, 0],          // the C3-safe substitute for order C
    ["APX-F3070-DW", "main", 10, 2],            // non-rated equiv; must NOT be offered for a rated opening
    ["WD-3070-BIRCH", "main", 6, 6], ["WD-3070-OAK", "main", 5, 0],
    ["HW-HINGE-45", "main", 200, 60], ["HW-LOCK-F75", "main", 30, 12], ["HW-LOCK-F82", "main", 18, 10],
    ["HW-LOCK-F04", "main", 40, 8], ["HW-CLOSER-4040", "main", 25, 9], ["HW-EXIT-RIM", "main", 4, 4],
    ["HW-STOP-WALL", "main", 300, 40], ["HW-KICK-8", "main", 60, 12],
  ]);

  run("INSERT INTO hardware_sets VALUES (?,?)", [
    ["HS-01", "Set 01: Storeroom (F75, closer, hinges, stop)"],
    ["HS-02", "Set 02: Classroom (F82, closer, hinges, kick, stop)"],
    ["HS-03", "Set 03: Passage (F04, hinges, stop)"],
    ["HS-04", "Set 04: Fire exit (rim device, closer, hinges)"],
  ]);
  run("INSERT INTO hardware_set_items VALUES (?,?,?)", [
    ["HS-01", "HW-LOCK-F75", 1], ["HS-01", "HW-CLOSER-4040", 1], ["HS-01", "HW-HINGE-45", 1], ["HS-01", "HW-STOP-WALL", 1],
    ["HS-02", "HW-LOCK-F82", 1], ["HS-02", "HW-CLOSER-4040", 1], ["HS-02", "HW-HINGE-45", 1], ["HS-02", "HW-KICK-8", 1], ["HS-02", "HW-STOP-WALL", 1],
    ["HS-03", "HW-LOCK-F04", 1], ["HS-03", "HW-HINGE-45", 1], ["HS-03", "HW-STOP-WALL", 1],
    ["HS-04", "HW-EXIT-RIM", 1], ["HS-04", "HW-CLOSER-4040", 1], ["HS-04", "HW-HINGE-45", 1],
  ]);

  // orders: id, customer, project, promise, status, value, margin, ship_policy, branch, shipped_at
  run("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?)", [
    // ── the three the scenario will hit ──
    ["ORD-1041", "CUST_ACME", "Acme: Riverside Office TI, floor 3", d(12), "open", 9800, 0.24, "complete", "main", null],
    ["ORD-1042", "CUST_HARBOR", "Harbor Point: Building B core", d(14), "open", 18500, 0.21, "complete", "main", null],
    ["ORD-1043", "CUST_MERCY", "Mercy Regional: ER corridor fire doors", d(9), "open", 6200, 0.27, "complete", "main", null],
    // ── one pre-existing amber (wood door slip) with partial-ship policy ──
    ["ORD-1035", "CUST_PEAK", "Peak: Lakeview Dental suite", d(6), "open", 7400, 0.22, "partial_ok", "main", null],
    // ── healthy ──
    ["ORD-1036", "CUST_BRIDGE", "Bridgewater: Maple Ridge phase 2", d(21), "open", 22400, 0.19, "partial_ok", "main", null],
    ["ORD-1037", "CUST_NORTH", "Northgate stock replenishment", d(10), "open", 5100, 0.15, "partial_ok", "east", null],
    ["ORD-1038", "CUST_LINCOLN", "LCS: Jefferson Elementary classroom doors", d(28), "open", 31200, 0.23, "complete", "main", null],
    ["ORD-1039", "CUST_SUMMIT", "Summit: Parkway Plaza tenant doors", d(8), "open", 3900, 0.30, "complete", "main", null],
    ["ORD-1040", "CUST_ACME", "Acme: Riverside Office TI, floor 2", d(5), "open", 8800, 0.24, "complete", "main", null],
    ["ORD-1044", "CUST_PEAK", "Peak: Westfield clinic", d(35), "open", 12600, 0.22, "complete", "main", null],
    ["ORD-1045", "CUST_HARBOR", "Harbor Point: Building A punch list", d(4), "open", 1450, 0.33, "partial_ok", "main", null],
    // ── shipped history for the on-time KPI ──
    ["ORD-1029", "CUST_BRIDGE", "Bridgewater: Maple Ridge phase 1", d(-12), "shipped", 19800, 0.2, "complete", "main", d(-13)],
    ["ORD-1030", "CUST_LINCOLN", "LCS: Admin building", d(-20), "shipped", 14200, 0.22, "complete", "main", d(-18)],
    ["ORD-1031", "CUST_SUMMIT", "Summit: Oak St suites", d(-9), "shipped", 4300, 0.31, "complete", "main", d(-9)],
    ["ORD-1032", "CUST_NORTH", "Northgate stock", d(-15), "shipped", 6100, 0.14, "partial_ok", "east", d(-15)],
    ["ORD-1033", "CUST_ACME", "Acme: Riverside Office TI, floor 1", d(-6), "shipped", 9100, 0.24, "complete", "main", d(-4)],
    ["ORD-1034", "CUST_MERCY", "Mercy: Pharmacy remodel", d(-3), "shipped", 5600, 0.26, "complete", "main", d(-3)],
  ]);

  // openings: id, order, opening_no, door, frame, hardware_set, fire_rated
  const op: unknown[][] = [];
  const mk = (order: string, n: number, door: string, frame: string, hs: string, fr = 0, start = 101) => {
    for (let i = 0; i < n; i++) op.push([`${order}-${start + i}`, order, String(start + i), door, frame, hs, fr]);
  };
  mk("ORD-1041", 10, "HMD-3070-16", "HMF-3070-DW", "HS-01");
  mk("ORD-1042", 24, "HMD-3070-16", "HMF-3070-MAS", "HS-03");
  mk("ORD-1043", 6, "HMD-3070-16-90", "HMF-3070-DW-90", "HS-04", 1);
  mk("ORD-1035", 8, "WD-3070-BIRCH", "HMF-3070-DW", "HS-03");
  mk("ORD-1036", 30, "WD-3070-OAK", "APX-F3070-DW", "HS-03");
  mk("ORD-1037", 12, "HMD-3070-16", "HMF-3070-DW", "HS-01");
  mk("ORD-1038", 36, "WD-3070-BIRCH-20", "APX-F3070-DW-90", "HS-02", 1);
  mk("ORD-1039", 4, "HMD-3070-16", "HMF-3070-DW", "HS-01");
  mk("ORD-1040", 9, "HMD-3070-16", "HMF-3070-DW", "HS-01");
  mk("ORD-1044", 14, "HMD-3070-16", "APX-F3070-DW", "HS-01");
  mk("ORD-1045", 2, "HMD-3070-16", "HMF-3070-DW", "HS-03");
  run("INSERT INTO openings VALUES (?,?,?,?,?,?,?)", op);

  // purchase orders: id, supplier, order, sku, qty, placed, acked_ship, current_ship, transit, status, expedited
  run("INSERT INTO purchase_orders VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
    // scenario A: frames from Ironline, on time today; after +10 slip → late 6d; east branch has 12 in stock
    ["PO-7101", "SUP_IRON", "ORD-1041", "HMF-3070-DW", 10, d(-52), d(5), d(5), 3, "open", 0],
    ["PO-7102", "SUP_IRON", "ORD-1041", "HMD-3070-16", 10, d(-52), d(4), d(4), 3, "open", 0],
    // scenario B: masonry frames, nothing in stock anywhere; expedite closes (7+3=10 ≤ 14) but $450 > $250 authority and > 2% ($370)
    ["PO-7103", "SUP_IRON", "ORD-1042", "HMF-3070-MAS", 24, d(-48), d(6), d(6), 3, "open", 0],
    ["PO-7104", "SUP_IRON", "ORD-1042", "HMD-3070-16", 24, d(-48), d(3), d(3), 3, "open", 0],
    // scenario C: 90-min frames; expedite 7+3=10 > promise 9, no transfer; Apex 90-min equivalent in stock → substitution (C2), non-rated Apex must be filtered (C3)
    ["PO-7105", "SUP_IRON", "ORD-1043", "HMF-3070-DW-90", 6, d(-55), d(4), d(4), 3, "open", 0],
    ["PO-7106", "SUP_IRON", "ORD-1043", "HMD-3070-16-90", 6, d(-55), d(2), d(2), 3, "open", 0],
    // pre-existing amber: wood doors 2 days late, partial_ok, 8 openings, doors are the late item so 0 ready... give it 2 extra passage openings with HM doors
    ["PO-7090", "SUP_OAK", "ORD-1035", "WD-3070-BIRCH", 8, d(-80), d(5), d(5), 3, "open", 0],
    // healthy
    ["PO-7091", "SUP_OAK", "ORD-1036", "WD-3070-OAK", 30, d(-70), d(14), d(14), 3, "open", 0],
    ["PO-7092", "SUP_APEX", "ORD-1036", "APX-F3070-DW", 30, d(-45), d(12), d(12), 3, "open", 0],
    ["PO-7093", "SUP_APEX", "ORD-1038", "APX-F3070-DW-90", 36, d(-40), d(20), d(20), 3, "open", 0],
    ["PO-7094", "SUP_OAK", "ORD-1038", "WD-3070-BIRCH-20", 36, d(-40), d(22), d(22), 3, "open", 0],
    ["PO-7095", "SUP_KEY", "ORD-1038", "HW-LOCK-F82", 36, d(-30), d(18), d(18), 2, "open", 0],
    ["PO-7096", "SUP_APEX", "ORD-1044", "APX-F3070-DW", 14, d(-20), d(28), d(28), 3, "open", 0],
    ["PO-7097", "SUP_IRON", "ORD-1044", "HMD-3070-16", 14, d(-20), d(27), d(27), 3, "open", 0],
    ["PO-7098", "SUP_KEY", "ORD-1039", "HW-LOCK-F75", 4, d(-30), d(3), d(3), 2, "open", 0],
  ]);
  // make ORD-1035 have 2 openings that are ready (HM door, not the late wood PO)
  run("INSERT INTO openings VALUES (?,?,?,?,?,?,?)", [
    ["ORD-1035-109", "ORD-1035", "109", "HMD-3070-16", "HMF-3070-DW", "HS-03", 0],
    ["ORD-1035-110", "ORD-1035", "110", "HMD-3070-16", "HMF-3070-DW", "HS-03", 0],
  ]);

  log({ role: "system", kind: "observe", summary: `World seeded for ${t}: 11 open orders, 6 shipped, 15 open POs` });
  return { today: t };
}

if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const r = seed();
  const c = db().prepare("SELECT (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM openings) op, (SELECT COUNT(*) FROM purchase_orders) po, (SELECT COUNT(*) FROM skus) s").get();
  console.log("seeded", r, c);
}
