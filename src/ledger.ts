import { db } from "./db.js";

export type LedgerKind = "observe" | "plan" | "tool_call" | "propose" | "gate" | "approve" | "reject" | "execute" | "outcome" | "message" | "charter_change" | "error" | "llm";

export interface LedgerEntry {
  role: string; kind: LedgerKind; summary: string;
  onBehalfOf?: string; refType?: string; refId?: string; detail?: unknown; charterRule?: string;
  tokensIn?: number; tokensOut?: number;
}

export function log(e: LedgerEntry): number {
  const r = db().prepare(
    `INSERT INTO ledger (role, on_behalf_of, kind, ref_type, ref_id, summary, detail, charter_rule, tokens_in, tokens_out)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(e.role, e.onBehalfOf ?? null, e.kind, e.refType ?? null, e.refId ?? null, e.summary,
        e.detail === undefined ? null : JSON.stringify(e.detail), e.charterRule ?? null, e.tokensIn ?? null, e.tokensOut ?? null);
  return Number(r.lastInsertRowid);
}

export function recentLedger(limit = 200, sinceId = 0) {
  return db().prepare(`SELECT * FROM ledger WHERE id > ? ORDER BY id DESC LIMIT ?`).all(sinceId, limit) as any[];
}
