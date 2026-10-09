// Pure harvest logic: grouping promotions into changesets (strategist
// proposal or the one-per-promotion fallback), dependency attribution,
// stacks, and the accounting that compares the sum of ablation
// contributions with the total gain. No I/O; harvest.ts drives it.

export interface Promotion {
  /** Commit on studies/<slug>/best (first-parent order, oldest first). */
  sha: string;
  /** Candidate number from the commit trailer (null for a commit the plugin didn't make). */
  n: number | null;
  title: string;
  paths: string[];
}

export interface ProposedGroup {
  title: string;
  candidates: number[];
  rationale: string;
}

export interface PlannedChangeset {
  title: string;
  rationale: string;
  /** Promotions in best order (oldest first). */
  promotions: Promotion[];
}

export type GroupingResult = { ok: true; changesets: PlannedChangeset[]; notes: string[] } | { ok: false; errors: string[] };

/** One changeset per promotion, in best order. */
export function fallbackGrouping(promotions: readonly Promotion[], reason = "no grouping proposed"): PlannedChangeset[] {
  return promotions.map((p) => ({ title: p.title, rationale: p.n !== null ? `Promotion c/${p.n} as its own changeset (${reason}).` : "Commit on best without a candidate trailer.", promotions: [p] }));
}

/**
 * Validate a strategist proposal against the promotions on best. Every
 * promoted candidate must be in exactly one group; unknown numbers are
 * errors (the strategist can fix and resubmit). Promotions it left out, and
 * commits without a candidate, get a changeset of their own (noted).
 * Changesets are ordered by their earliest commit on best.
 */
export function applyProposal(promotions: readonly Promotion[], groups: readonly ProposedGroup[]): GroupingResult {
  const byN = new Map<number, Promotion>();
  for (const p of promotions) if (p.n !== null) byN.set(p.n, p);
  const errors: string[] = [];
  const used = new Set<number>();
  const planned: PlannedChangeset[] = [];
  for (const g of groups) {
    const members: Promotion[] = [];
    for (const n of g.candidates) {
      const p = byN.get(n);
      if (!p) errors.push(`c/${n} is not a promotion on best (promoted: ${[...byN.keys()].map((x) => `c/${x}`).join(", ") || "none"})`);
      else if (used.has(n)) errors.push(`c/${n} is in more than one group`);
      else {
        used.add(n);
        members.push(p);
      }
    }
    if (members.length) planned.push({ title: g.title.trim() || members[0]!.title, rationale: g.rationale, promotions: members });
  }
  if (errors.length) return { ok: false, errors };
  const notes: string[] = [];
  const order = new Map(promotions.map((p, i) => [p.sha, i] as const));
  for (const p of promotions) {
    if (p.n !== null && used.has(p.n)) continue;
    planned.push({ title: p.title, rationale: p.n !== null ? `c/${p.n} was not in any proposed group.` : "Commit on best without a candidate trailer.", promotions: [p] });
    notes.push(p.n !== null ? `c/${p.n} was left out of the proposal: it gets its own changeset` : `commit ${p.sha.slice(0, 10)} has no candidate: it gets its own changeset`);
  }
  for (const c of planned) c.promotions.sort((a, b) => order.get(a.sha)! - order.get(b.sha)!);
  planned.sort((a, b) => order.get(a.promotions[0]!.sha)! - order.get(b.promotions[0]!.sha)!);
  return { ok: true, changesets: planned, notes };
}

export interface CsNode {
  id: number;
  /** Position on best (1-based, by earliest commit). */
  k: number;
  paths: string[];
  dependsOn: number[];
}

/**
 * Who depends on S when reverting S from best conflicts or breaks gates:
 * later changesets touching the conflicting paths (or S's paths). When none
 * share a file, every later changeset is treated as dependent: stacking is
 * always safe, just less parallel.
 */
export function laterDependents(s: CsNode, all: readonly CsNode[], conflictPaths: readonly string[] = []): { ids: number[]; attributed: boolean } {
  const later = all.filter((x) => x.k > s.k);
  const probe = new Set(conflictPaths.length ? conflictPaths : s.paths);
  const sharing = later.filter((x) => x.paths.some((p) => probe.has(p)));
  if (sharing.length) return { ids: sharing.map((x) => x.id), attributed: true };
  if (conflictPaths.length) {
    const own = new Set(s.paths);
    const touching = later.filter((x) => x.paths.some((p) => own.has(p)));
    if (touching.length) return { ids: touching.map((x) => x.id), attributed: true };
  }
  return { ids: later.map((x) => x.id), attributed: false };
}

/** Earlier changesets T that S depends on when S doesn't apply alone to the base. */
export function earlierDependencies(s: CsNode, all: readonly CsNode[], conflictPaths: readonly string[]): { ids: number[]; attributed: boolean } {
  const earlier = all.filter((x) => x.k < s.k);
  const probe = new Set(conflictPaths.length ? conflictPaths : s.paths);
  const sharing = earlier.filter((x) => x.paths.some((p) => probe.has(p)));
  if (sharing.length) return { ids: sharing.map((x) => x.id), attributed: true };
  const prev = earlier.at(-1);
  return { ids: prev ? [prev.id] : [], attributed: false };
}

/** Stacks: connected components of the dependency graph with more than one member, members in best order. Index by changeset id. */
export function computeStacks(nodes: readonly CsNode[]): { stacks: number[][]; stackOf: Map<number, number> } {
  const parent = new Map(nodes.map((n) => [n.id, n.id] as const));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const n of nodes) for (const d of n.dependsOn) if (parent.has(d)) parent.set(find(n.id), find(d));
  const groups = new Map<number, CsNode[]>();
  for (const n of nodes) groups.set(find(n.id), [...(groups.get(find(n.id)) ?? []), n]);
  const stacks = [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.k - b.k).map((x) => x.id));
  stacks.sort((a, b) => nodes.find((n) => n.id === a[0])!.k - nodes.find((n) => n.id === b[0])!.k);
  const stackOf = new Map<number, number>();
  stacks.forEach((s, i) => s.forEach((id) => stackOf.set(id, i + 1)));
  return { stacks, stackOf };
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

/** Contribution of S from the ablation measurement (improvement of best-without-S over best): its negation, CI flipped. */
export function contributionFromAblation(effect: number, ciLo: number | null, ciHi: number | null): Estimate {
  return { value: -effect, lo: ciHi === null ? null : -ciHi, hi: ciLo === null ? null : -ciLo };
}

/** No evidence it helps: the contribution's CI reaches zero (deterministic: not above the tolerance). */
export function isDroppable(e: Estimate, tolerance = 0): boolean {
  const lo = e.lo ?? e.value;
  return lo <= tolerance;
}

export function branchSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40)
      .replace(/-+$/u, "") || "change"
  );
}

/** POSIX single-quote a shell argument. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/gu, `'\\''`)}'`;
}
