// Harvest records made by the plugin before 1.0 (grouping, ablation, stacks,
// PR drafts, publishing). v1 no longer makes them: agents harvest with
// `bb study evidence`, `measure` and `gate` (skills/study-harvest). These are
// the pure helpers the Harvest tab, `bb study harvest` and the report still
// use to show the old records read-only.

export interface Layer {
  host: number;
  members: number[];
}

/** A stack of an old harvest (harvests.stacks_json). */
export interface StackRecord {
  stack: number;
  /** Every changeset in the stack, in PR order (folded ones right after their host). */
  members: number[];
  /** The stack's PRs bottom first: each host with the changesets it ships (absent before v0.2.4). */
  layers?: Layer[];
  status: "pending" | "measured" | "not_needed" | "conflict" | "gate_failed" | "error";
  estimate: Estimate | null;
  n: number | null;
  detail: string | null;
}

/**
 * What a set of commits cost a guardrail in an old harvest, relative to best
 * (positive = the commits make the guardrail worse).
 */
export interface GuardrailCost {
  value: number;
  lo: number | null;
  hi: number | null;
  n: number;
}

/**
 * The stored dependency reason ("depends on #4: reverting …; depends on #5:
 * …") split per dependency k. Text without that prefix (older rows) is kept
 * whole under null.
 */
export function dependencyReasons(stored: string | null): Map<number | null, string[]> {
  const out = new Map<number | null, string[]>();
  if (!stored) return out;
  const parts = stored.split(/;\s*(?=depends on #\d+:)/u);
  for (const part of parts) {
    const m = /^\s*depends on #(\d+):\s*(.*)$/su.exec(part);
    const key = m ? Number(m[1]) : null;
    const text = (m ? m[2]! : part).trim();
    if (text) out.set(key, [...(out.get(key) ?? []), text]);
  }
  return out;
}

/**
 * PR order: independent changesets and stacks interleaved by their smallest
 * k, each stack's layers bottom first (folded changesets right after their
 * host).
 */
export function prOrder<T extends { id: number; k: number; stack: number | null; layer: number | null; folded_into: number | null }>(rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const host = (r: T): T => {
    let cur = r;
    for (let i = 0; i < 1000 && cur.folded_into !== null && byId.has(cur.folded_into); i++) cur = byId.get(cur.folded_into)!;
    return cur;
  };
  const stackMin = new Map<number, number>();
  for (const r of rows) if (r.stack !== null) stackMin.set(r.stack, Math.min(stackMin.get(r.stack) ?? Infinity, r.k));
  const key = (r: T): number[] => {
    const h = host(r);
    const group = h.stack !== null ? (stackMin.get(h.stack) ?? h.k) : h.k;
    return [group, h.stack ?? 0, h.layer ?? 0, h.k, r.id === h.id ? 0 : 1, r.k];
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return 0;
  });
}

export interface Estimate {
  value: number;
  lo: number | null;
  hi: number | null;
}

export interface AccountingItem {
  label: string;
  /** Changeset ids this term covers. */
  ids: number[];
  estimate: Estimate | null;
  /** "changeset": its own ablation; "stack": a joint ablation of a stack whose members couldn't be ablated alone. */
  source: "changeset" | "stack" | "missing";
}

export interface Accounting {
  items: AccountingItem[];
  sum: number | null;
  /** Half-width of the sum's CI (independent errors: root sum of squares). */
  sumHalfWidth: number | null;
  total: Estimate | null;
  gap: number | null;
  gapHalfWidth: number | null;
  /** The gap exceeds its CI: the changesets interact (or something wasn't measured). */
  interaction: boolean;
  missing: string[];
}

function halfWidth(e: Estimate): number {
  if (e.lo === null || e.hi === null) return 0;
  return Math.abs(e.hi - e.lo) / 2;
}

/**
 * Sum of contributions vs the total gain. Every term is relative to best, so
 * they add. A stack whose members all have their own ablation contributes
 * the sum of its members; otherwise its joint ablation stands in for them.
 */
export function harvestAccounting(input: {
  changesets: ReadonlyArray<{ id: number; k: number; title: string; estimate: Estimate | null }>;
  stacks: ReadonlyArray<{ members: number[]; estimate: Estimate | null }>;
  total: Estimate | null;
}): Accounting {
  const items: AccountingItem[] = [];
  const missing: string[] = [];
  const inStack = new Set(input.stacks.flatMap((s) => s.members));
  for (const c of input.changesets) {
    if (inStack.has(c.id)) continue;
    items.push({ label: `#${c.k} ${c.title}`, ids: [c.id], estimate: c.estimate, source: c.estimate ? "changeset" : "missing" });
    if (!c.estimate) missing.push(`#${c.k}`);
  }
  input.stacks.forEach((s, i) => {
    const members = s.members.map((id) => input.changesets.find((c) => c.id === id)!).filter(Boolean);
    if (members.every((m) => m.estimate)) {
      for (const m of members) items.push({ label: `#${m.k} ${m.title} (stack ${i + 1})`, ids: [m.id], estimate: m.estimate, source: "changeset" });
    } else {
      items.push({ label: `stack ${i + 1} (${members.map((m) => `#${m.k}`).join(", ")}) ablated together`, ids: s.members, estimate: s.estimate, source: s.estimate ? "stack" : "missing" });
      if (!s.estimate) missing.push(`stack ${i + 1}`);
    }
  });
  const measured = items.filter((i) => i.estimate);
  const sum = measured.length ? measured.reduce((a, i) => a + i.estimate!.value, 0) : null;
  const sumHalfWidth = measured.length ? Math.sqrt(measured.reduce((a, i) => a + halfWidth(i.estimate!) ** 2, 0)) : null;
  const total = input.total;
  const gap = total && sum !== null ? total.value - sum : null;
  const gapHalfWidth = total && sumHalfWidth !== null ? Math.sqrt(sumHalfWidth ** 2 + halfWidth(total) ** 2) : null;
  const interaction = gap !== null && gapHalfWidth !== null && (Math.abs(gap) > gapHalfWidth || missing.length > 0);
  return { items, sum, sumHalfWidth, total, gap, gapHalfWidth, interaction, missing };
}

/** The fields of a changeset row the PR order and fold words read. */
export interface FoldRow {
  id: number;
  k: number;
  stack: number | null;
  layer: number | null;
  folded_into: number | null;
  fold_reason: string | null;
}

/** Folds in words: "#6 ships inside #7's PR: #6 needs src/x.py, which #7 adds or changes, so it doesn't apply on #5 alone." */
export function foldLines<T extends FoldRow>(cs: readonly T[]): string[] {
  return prOrder(cs)
    .filter((c) => c.folded_into !== null)
    .map((c) => {
      const host = cs.find((x) => x.id === c.folded_into);
      return `#${c.k} ships inside #${host?.k ?? "?"}'s PR${c.fold_reason ? `: ${c.fold_reason}` : ""}.`;
    });
}

/** A stack in PR order: "#3 → #2 (with #5) → #4". */
export function stackOrderText<T extends FoldRow>(cs: readonly T[], stack: number): string {
  return prOrder(cs.filter((c) => c.stack === stack && c.folded_into === null))
    .map((c) => {
      const inside = cs.filter((x) => x.folded_into === c.id).sort((a, b) => a.k - b.k);
      return `#${c.k}${inside.length ? ` (with ${inside.map((x) => `#${x.k}`).join(", ")})` : ""}`;
    })
    .join(" → ");
}
