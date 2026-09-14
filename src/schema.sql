PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, contact TEXT
);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, product_lines TEXT NOT NULL,
  standard_lead_days INTEGER NOT NULL, expedite_fee_usd REAL NOT NULL, expedite_lead_days INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skus (
  id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  category TEXT NOT NULL, description TEXT NOT NULL, unit_cost REAL NOT NULL, list_price REAL NOT NULL,
  fire_rating TEXT, substitutable_group TEXT
);
CREATE TABLE IF NOT EXISTS inventory (
  sku_id TEXT NOT NULL REFERENCES skus(id), branch TEXT NOT NULL,
  qty_on_hand INTEGER NOT NULL, qty_allocated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sku_id, branch)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
  project_name TEXT NOT NULL, promise_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  order_value REAL NOT NULL, margin_pct REAL NOT NULL, ship_policy TEXT NOT NULL DEFAULT 'complete',
  branch TEXT NOT NULL DEFAULT 'main', shipped_at TEXT
);
CREATE TABLE IF NOT EXISTS hardware_sets (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hardware_set_items (
  set_id TEXT NOT NULL REFERENCES hardware_sets(id), sku_id TEXT NOT NULL REFERENCES skus(id), qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS openings (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), opening_no TEXT NOT NULL,
  door_sku TEXT REFERENCES skus(id), frame_sku TEXT REFERENCES skus(id),
  hardware_set_id TEXT REFERENCES hardware_sets(id), fire_rated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  order_id TEXT NOT NULL REFERENCES orders(id), sku_id TEXT NOT NULL REFERENCES skus(id), qty INTEGER NOT NULL,
  placed_at TEXT NOT NULL, acked_ship_date TEXT NOT NULL, current_ship_date TEXT NOT NULL,
  transit_days INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'open', expedited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL, order_id TEXT, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), opened_by TEXT NOT NULL,
  assigned_role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  risk_score REAL NOT NULL, days_late INTEGER NOT NULL, reason TEXT NOT NULL,
  outcome TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), order_id TEXT NOT NULL,
  role TEXT NOT NULL, type TEXT NOT NULL, params TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0,
  days_saved INTEGER NOT NULL DEFAULT 0, rationale TEXT,
  gate_verdict TEXT NOT NULL, gate_rule TEXT, status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), executed_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), requested_of TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', summary TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, to_contact TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  approval_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  role TEXT NOT NULL, on_behalf_of TEXT, kind TEXT NOT NULL, ref_type TEXT, ref_id TEXT,
  summary TEXT NOT NULL, detail TEXT, charter_rule TEXT, tokens_in INTEGER, tokens_out INTEGER
);
CREATE TABLE IF NOT EXISTS charter_proposals (
  id TEXT PRIMARY KEY, proposed_by TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL,
  patch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', decided_by TEXT, decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL DEFAULT 'running',
  turns INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY, scenario TEXT NOT NULL, rep INTEGER NOT NULL, mode TEXT NOT NULL,
  passed INTEGER NOT NULL, checks TEXT NOT NULL, summary TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
