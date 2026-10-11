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
  /** First and last commit positions on best (first-parent order, 0-based); without them, k orders. */
  first?: number;
  last?: number;
}

/** T comes after S somewhere on best: one of T's commits is newer than S's oldest (k when positions are unknown). */
function hasLaterCommit(t: CsNode, s: CsNode): boolean {
  return t.last !== undefined && s.first !== undefined ? t.last > s.first : t.k > s.k;
}

/**
 * Who depends on S when reverting S from best conflicts or breaks gates:
 * changesets with a commit after one of S's (by commit order on best, not
 * by k: a group can start before S and still build on it) touching the
 * conflicting paths (or S's paths). When none share a file, every such
 * changeset is treated as dependent: stacking is always safe, just less
 * parallel.
 */
export function laterDependents(s: CsNode, all: readonly CsNode[], conflictPaths: readonly string[] = []): { ids: number[]; attributed: boolean } {
  const later = all.filter((x) => x.id !== s.id && hasLaterCommit(x, s));
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

/** Changesets T that S may need when S doesn't apply alone: T has a commit before one of S's (by commit order), preferring those touching the conflicting paths. */
export function earlierDependencies(s: CsNode, all: readonly CsNode[], conflictPaths: readonly string[]): { ids: number[]; attributed: boolean } {
  const earlier = all.filter((x) => x.id !== s.id && hasLaterCommit(s, x));
  const probe = new Set(conflictPaths.length ? conflictPaths : s.paths);
  const sharing = earlier.filter((x) => x.paths.some((p) => probe.has(p)));
  if (sharing.length) return { ids: sharing.map((x) => x.id), attributed: true };
  const prev = [...earlier].sort((a, b) => (a.last ?? a.k) - (b.last ?? b.k)).at(-1);
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

// ---- stack order: layers in dependency order, coupled groups folded ----

export interface OrderNode {
  id: number;
  k: number;
  /** Detected dependency edges: this changeset needs these (ids). */
  dependsOn: number[];
  /** Already ships inside another changeset's PR (id), or null. */
  foldedInto: number | null;
  /** Its commits: position on best (first-parent order) and the paths each touches. */
  commits: Array<{ pos: number; paths: string[] }>;
}

/** One PR of a stack: the host changeset and every changeset shipping inside it (host first). */
export interface Layer {
  host: number;
  members: number[];
}

export interface StackPlan {
  /** PR order, bottom first. */
  layers: Layer[];
}

export interface PlannedFold {
  id: number;
  into: number;
  /** Why, in words (the display prefixes "#a ships inside #b's PR: "). */
  reason: string;
}

/** Who changeset `id` ships inside (following chains), itself when not folded. */
function hostOf(byId: ReadonlyMap<number, OrderNode>, id: number): number {
  let cur = id;
  for (let i = 0; i < 1000; i++) {
    const n = byId.get(cur);
    if (!n || n.foldedInto === null || !byId.has(n.foldedInto)) return cur;
    cur = n.foldedInto;
  }
  return cur;
}

const listK = (ks: number[]) => ks.map((k) => `#${k}`).join(", ").replace(/, ([^,]*)$/u, " and $1");

/**
 * Stacks and their PR order. A stack is a connected component of the
 * detected dependency edges (and existing folds). Inside it, X needs Y when X
 * depends on Y, or when a commit of X and an earlier commit of Y (on best)
 * touch the same path. Layers are ordered topologically (ties by k). A cycle
 * (strongly connected component: commits interleaved on the same files, or
 * dependencies both ways) is one coupled group: it folds into one layer,
 * hosted by its smallest k.
 */
export function planStacks(nodes: readonly OrderNode[]): { stacks: StackPlan[]; folds: PlannedFold[] } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const kOf = (id: number) => byId.get(id)?.k ?? 0;
  // Components over dependency edges and folds.
  const parent = new Map(nodes.map((n) => [n.id, n.id] as const));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const join = (a: number, b: number) => {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  };
  for (const n of nodes) {
    for (const d of n.dependsOn) join(n.id, d);
    if (n.foldedInto !== null) join(n.id, n.foldedInto);
  }
  const comps = new Map<number, OrderNode[]>();
  for (const n of nodes) comps.set(find(n.id), [...(comps.get(find(n.id)) ?? []), n]);
  const stacks: StackPlan[] = [];
  const folds: PlannedFold[] = [];
  for (const comp of comps.values()) {
    if (comp.length < 2) continue;
    // Units: a host and the changesets already folded into it.
    const unitOf = new Map(comp.map((n) => [n.id, hostOf(byId, n.id)] as const));
    const units = new Map<number, number[]>();
    for (const n of comp) units.set(unitOf.get(n.id)!, [...(units.get(unitOf.get(n.id)!) ?? []), n.id]);
    const hosts = [...units.keys()];
    const commitsOf = (u: number) => units.get(u)!.flatMap((id) => byId.get(id)!.commits);
    // needs.get(u) = units u needs (must come before u), with the shared paths that made the edge.
    const needs = new Map<number, Map<number, Set<string>>>(hosts.map((u) => [u, new Map()] as const));
    const edge = (u: number, v: number, path: string | null) => {
      if (u === v) return;
      const m = needs.get(u)!;
      const s = m.get(v) ?? new Set<string>();
      if (path) s.add(path);
      m.set(v, s);
    };
    for (const n of comp) for (const d of n.dependsOn) if (unitOf.has(d)) edge(unitOf.get(n.id)!, unitOf.get(d)!, null);
    for (const u of hosts) {
      for (const v of hosts) {
        if (u === v) continue;
        for (const cu of commitsOf(u)) {
          const pu = new Set(cu.paths);
          for (const cv of commitsOf(v)) {
            if (cv.pos >= cu.pos) continue;
            for (const p of cv.paths) if (pu.has(p)) edge(u, v, p);
          }
        }
      }
    }
    // Tarjan's strongly connected components.
    let index = 0;
    const idx = new Map<number, number>();
    const low = new Map<number, number>();
    const onStack = new Set<number>();
    const st: number[] = [];
    const sccs: number[][] = [];
    const strong = (v: number) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      st.push(v);
      onStack.add(v);
      for (const w of [...needs.get(v)!.keys()].sort((a, b) => kOf(a) - kOf(b))) {
        if (!idx.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
      if (low.get(v) === idx.get(v)) {
        const scc: number[] = [];
        for (;;) {
          const w = st.pop()!;
          onStack.delete(w);
          scc.push(w);
          if (w === v) break;
        }
        sccs.push(scc);
      }
    };
    for (const u of [...hosts].sort((a, b) => kOf(a) - kOf(b))) if (!idx.has(u)) strong(u);
    // Fold each cycle into one layer, hosted by its smallest k.
    const layerOf = new Map<number, number>();
    const layers = new Map<number, number[]>();
    for (const scc of sccs) {
      const sorted = [...scc].sort((a, b) => kOf(a) - kOf(b));
      const host = sorted[0]!;
      const members = sorted.flatMap((u) => units.get(u)!);
      layers.set(host, [host, ...members.filter((m) => m !== host).sort((a, b) => kOf(a) - kOf(b))]);
      for (const u of scc) layerOf.set(u, host);
      if (scc.length > 1) {
        const paths = new Set<string>();
        let viaDeps = false;
        for (const u of scc) {
          for (const [v, ps] of needs.get(u)!) {
            if (!scc.includes(v)) continue;
            if (ps.size) for (const p of ps) paths.add(p);
            else viaDeps = true;
          }
        }
        const ks = sorted.map(kOf);
        const shown = [...paths].sort().slice(0, 3);
        const why = paths.size
          ? `${listK(ks)} need each other: their commits interleave on ${shown.join(", ")}${paths.size > shown.length ? ` and ${paths.size - shown.length} more file(s)` : ""}, so neither applies without the other`
          : `${listK(ks)} depend on each other${viaDeps ? " (reverting either from best fails while the other stays)" : ""}, so neither applies without the other`;
        for (const m of members) if (hostOf(byId, m) !== host) folds.push({ id: m, into: host, reason: why });
      }
    }
    // Topological order of the folded layers (Kahn), ties by k.
    const preds = new Map<number, Set<number>>([...layers.keys()].map((l) => [l, new Set<number>()] as const));
    for (const u of hosts) for (const v of needs.get(u)!.keys()) if (layerOf.get(u) !== layerOf.get(v)) preds.get(layerOf.get(u)!)!.add(layerOf.get(v)!);
    const order: number[] = [];
    const done = new Set<number>();
    while (order.length < layers.size) {
      const ready = [...layers.keys()].filter((l) => !done.has(l) && [...preds.get(l)!].every((p) => done.has(p))).sort((a, b) => kOf(a) - kOf(b));
      const next = ready[0] ?? [...layers.keys()].filter((l) => !done.has(l)).sort((a, b) => kOf(a) - kOf(b))[0]!;
      order.push(next);
      done.add(next);
    }
    stacks.push({ layers: order.map((host) => ({ host, members: layers.get(host)! })) });
  }
  const minK = (s: StackPlan) => Math.min(...s.layers.flatMap((l) => l.members.map(kOf)));
  stacks.sort((a, b) => minK(a) - minK(b));
  return { stacks, folds };
}

// ---- every PR applies on its PR base ----

export type FitOutcome<T> = { ok: true; value: T } | { ok: false; kind: "conflict" | "gate_failed"; paths: string[]; detail: string };

export interface FitFold {
  /** Changesets moving into `into`'s PR (with what was already folded into them). */
  ids: number[];
  into: number;
  reason: string;
}

export type FitResult<T> =
  | { ok: true; layers: Array<Layer & { value: T }>; folds: FitFold[] }
  | {
      ok: false;
      /** The first layer that did not apply, its PR base, and how the whole stack squashed onto the base failed. */
      failed: Layer;
      failure: FitOutcome<T> & { ok: false };
      squashed: FitOutcome<T> & { ok: false };
      /** Layers below the failing one (they apply). */
      layers: Array<Layer & { value: T }>;
    };

/**
 * Check each layer of a stack on its PR base (the previous layer's result;
 * the first on `base`) and fold until every layer applies and passes its
 * gates. A failing layer first merges with the next layer(s) in order (it
 * needs something a later one brings); if no later layer fixes it, it folds
 * into the previous layer and the check resumes there. Each fold removes a
 * layer, and the whole stack squashed onto the base is checked before any
 * fold, so this terminates: when even the squash fails, the stack needs
 * something outside it, and the caller probes the other changesets.
 */
export async function fitLayers<T>(
  input: readonly Layer[],
  base: T,
  apply: (layer: Layer, on: T) => Promise<FitOutcome<T>>,
  words: { k: (id: number) => number; paths: (ids: number[]) => string[]; baseLabel: string },
): Promise<FitResult<T>> {
  const layers: Layer[] = input.map((l) => ({ host: l.host, members: [...l.members] }));
  const values: T[] = [];
  const folds: FitFold[] = [];
  const all = layers.flatMap((l) => l.members);
  const label = (i: number) => (i < 0 ? words.baseLabel : `#${words.k(layers[i]!.host)}`);
  let squashOk = false;
  let i = 0;
  while (i < layers.length) {
    const on = i === 0 ? base : values[i - 1]!;
    const r = await apply(layers[i]!, on);
    if (r.ok) {
      values[i] = r.value;
      i++;
      continue;
    }
    if (!squashOk) {
      const s = await apply({ host: layers[0]!.host, members: all }, base);
      if (!s.ok) return { ok: false, failed: layers[i]!, failure: r, squashed: s, layers: layers.slice(0, i).map((l, j) => ({ ...l, value: values[j]! })) };
      squashOk = true;
    }
    const me = layers[i]!;
    const meK = `#${words.k(me.host)}`;
    const failure = r.kind === "conflict" ? `conflict in ${r.paths.slice(0, 3).join(", ") || "?"}` : clip(r.detail, 160);
    let merged = false;
    for (let j = i + 1; j < layers.length; j++) {
      const host = layers[j]!.host;
      const members = [host, ...layers.slice(i, j + 1).flatMap((l) => l.members).filter((m) => m !== host)];
      const r2 = await apply({ host, members }, on);
      if (!r2.ok) continue;
      const hostK = `#${words.k(host)}`;
      const brought = new Set(words.paths(layers.slice(i + 1, j + 1).flatMap((l) => l.members)));
      const needed = r.kind === "conflict" ? r.paths.filter((p) => brought.has(p)).slice(0, 3) : [];
      const reason =
        r.kind === "conflict"
          ? needed.length
            ? `${meK} needs ${needed.join(", ")}, which ${hostK} adds or changes, so it doesn't apply on ${label(i - 1)} alone`
            : `${meK} doesn't apply on ${label(i - 1)} alone (${failure}); together with ${hostK} it does`
          : `${meK} fails the gates on ${label(i - 1)} alone (${failure}); together with ${hostK} they pass`;
      folds.push({ ids: layers.slice(i, j).flatMap((l) => l.members), into: host, reason });
      layers.splice(i, j - i + 1, { host, members });
      values[i] = r2.value;
      values.length = i + 1;
      i++;
      merged = true;
      break;
    }
    if (merged) continue;
    // No later layer fixes it (i > 0 here: at 0 the forward merge of everything is the squash, which applies).
    if (i === 0) return { ok: false, failed: me, failure: r, squashed: r, layers: [] };
    const prev = layers[i - 1]!;
    const prevK = `#${words.k(prev.host)}`;
    folds.push({
      ids: me.members,
      into: prev.host,
      reason: `${meK} ${r.kind === "conflict" ? "doesn't apply" : "fails the gates"} on ${prevK} (${failure}) and no later layer fixes it, so it ships inside ${prevK}'s PR`,
    });
    layers.splice(i - 1, 2, { host: prev.host, members: [...prev.members, ...me.members] });
    values.length = i - 1;
    i--;
  }
  return { ok: true, layers: layers.map((l, j) => ({ ...l, value: values[j]! })), folds };
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/gu, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
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

/** Contribution of S from the ablation measurement (improvement of best-without-S over best): its negation, CI flipped. */
export function contributionFromAblation(effect: number, ciLo: number | null, ciHi: number | null): Estimate {
  return { value: -effect, lo: ciHi === null ? null : -ciHi, hi: ciLo === null ? null : -ciLo };
}

/** No evidence it helps: the contribution's CI reaches zero (deterministic: not above the tolerance). */
export function isDroppable(e: Estimate, tolerance = 0): boolean {
  const lo = e.lo ?? e.value;
  return lo <= tolerance;
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

/** The local branch of a changeset's PR: studies/<slug>/harvest/h<seq>/<kk>-<title>. */
export function harvestBranch(study: { slug: string }, h: { seq: number }, cs: { k: number; title: string }): string {
  return `studies/${study.slug}/harvest/h${h.seq}/${String(cs.k).padStart(2, "0")}-${branchSlug(cs.title)}`;
}

/** The export directory key: <slug>-harvest-h<seq>. */
export function harvestExportKey(study: { slug: string }, h: { seq: number }): string {
  return `${study.slug}-harvest-h${h.seq}`;
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
