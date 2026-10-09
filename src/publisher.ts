// PR publishing behind one interface.
//
// - DryRunPublisher (default): the local branches already exist (harvest
//   drafting creates them); this writes the report, one Markdown file per PR
//   body, and a manifest under the edit host's plugin data dir
//   (`<dataDir>/exports/<slug>-harvest-h<id>/`). Nothing leaves the machine.
// - GithubPublisher: only behind an explicit `bb study harvest <slug>
//   --publish`. Refuses when the repo has no GitHub remote or `gh` is
//   missing; pushes each branch and opens a DRAFT PR with `gh pr create
//   --draft`, stacked PRs based on the branch below them.
import type { HostRunner } from "./host/runner.ts";
import { shellQuote } from "./harvest-math.ts";
import { clip } from "./prompts.ts";

export interface PrDraft {
  changesetId: number;
  k: number;
  branch: string;
  /** The study's base branch (e.g. main), or the branch of the changeset below in its stack. */
  baseBranch: string;
  title: string;
  body: string;
  /** The branch tip; null when the changeset did not apply on its PR base (no branch, no PR). */
  sha: string | null;
  stacked: boolean;
}

export interface PublishInput {
  /** Export directory key, e.g. "<slug>-harvest-h3". */
  key: string;
  drafts: PrDraft[];
  report: string;
}

export interface PublishedPr {
  changesetId: number;
  k: number;
  branch: string;
  baseBranch: string;
  status: "branch" | "skipped" | "pushed" | "opened" | "failed";
  url: string | null;
  detail: string | null;
  bodyFile: string | null;
}

export interface PublishOutput {
  mode: "dry-run" | "github";
  exportDir: string;
  prs: PublishedPr[];
}

export interface PrPublisher {
  readonly mode: "dry-run" | "github";
  publish(input: PublishInput): Promise<PublishOutput>;
}

export class PublishRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRefused";
  }
}

export function prFileName(d: Pick<PrDraft, "k" | "branch">): string {
  const leaf = d.branch.split("/").pop() ?? "";
  return `prs/${/^\d+-/u.test(leaf) ? leaf : `${String(d.k).padStart(2, "0")}-${leaf}`}.md`;
}

function manifest(input: PublishInput, prs: PublishedPr[], mode: string): string {
  return JSON.stringify({ mode, prs: prs.map((p) => ({ ...p, title: input.drafts.find((d) => d.changesetId === p.changesetId)?.title })) }, null, 2);
}

async function writeFiles(runner: HostRunner, input: PublishInput, prs: PublishedPr[], mode: string): Promise<string> {
  const files = [
    { path: "report.md", content: input.report },
    ...input.drafts.map((d) => ({ path: prFileName(d), content: `# ${d.title}\n\nBranch: \`${d.branch}\` → base \`${d.baseBranch}\`${d.stacked ? " (stacked)" : ""}\n\n${d.body}\n` })),
    { path: "manifest.json", content: manifest(input, prs, mode) },
  ];
  return await runner.writeExport(input.key, files);
}

export class DryRunPublisher implements PrPublisher {
  readonly mode = "dry-run" as const;
  constructor(private readonly edit: HostRunner) {}
  async publish(input: PublishInput): Promise<PublishOutput> {
    const prs: PublishedPr[] = input.drafts.map((d) => ({
      changesetId: d.changesetId,
      k: d.k,
      branch: d.branch,
      baseBranch: d.baseBranch,
      status: d.sha ? "branch" : "skipped",
      url: null,
      detail: d.sha ? "local branch created; not pushed (dry-run)" : "did not apply on its PR base: no branch",
      bodyFile: prFileName(d),
    }));
    const exportDir = await writeFiles(this.edit, input, prs, "dry-run");
    return { mode: "dry-run", exportDir, prs };
  }
}

/** True for a GitHub remote URL (https, ssh, or git@). */
export function isGithubUrl(url: string): boolean {
  return /(^|[@/])github\.com[:/]/iu.test(url);
}

export class GithubPublisher implements PrPublisher {
  readonly mode = "github" as const;
  constructor(
    private readonly edit: HostRunner,
    private readonly repoPath: string,
    private readonly remote: string,
    /** The explicit `--publish` flag. Without it this publisher refuses. */
    private readonly confirmed: boolean,
  ) {}

  /** Refuse unless publishing was asked for explicitly and the repo has a GitHub remote. */
  async preflight(): Promise<{ remoteUrl: string }> {
    if (!this.confirmed) throw new PublishRefused("publishing to GitHub needs an explicit `bb study harvest <slug> --publish`; the default is a dry run");
    const remotes = await this.edit.gitRemotes(this.repoPath);
    const r = remotes.find((x) => x.name === this.remote);
    if (!r) throw new PublishRefused(`the repository has no remote named ${JSON.stringify(this.remote)}${remotes.length ? ` (remotes: ${remotes.map((x) => x.name).join(", ")})` : " (it has no remotes)"}; set [harvest].remote or add one`);
    if (!isGithubUrl(r.url)) throw new PublishRefused(`remote ${this.remote} (${r.url}) is not a GitHub remote; only GitHub is supported`);
    const gh = await this.edit.exec({ cwd: this.repoPath, command: "gh --version", timeoutMs: 30_000 });
    if (gh.exitCode !== 0) throw new PublishRefused("the GitHub CLI (gh) is not available on the edit host");
    return { remoteUrl: r.url };
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    await this.preflight();
    const prs: PublishedPr[] = [];
    // Write bodies first so `gh` reads them from files (no shell escaping of Markdown).
    const exportDir = await writeFiles(this.edit, input, prs, "github");
    const failedBranches = new Set<string>();
    for (const d of input.drafts) {
      const base: PublishedPr = { changesetId: d.changesetId, k: d.k, branch: d.branch, baseBranch: d.baseBranch, status: "skipped", url: null, detail: null, bodyFile: prFileName(d) };
      if (!d.sha) {
        prs.push({ ...base, detail: "did not apply on its PR base: no branch" });
        failedBranches.add(d.branch);
        continue;
      }
      if (d.stacked && failedBranches.has(d.baseBranch)) {
        prs.push({ ...base, detail: `its base ${d.baseBranch} was not published` });
        failedBranches.add(d.branch);
        continue;
      }
      const push = await this.edit.exec({ cwd: this.repoPath, command: `git push ${shellQuote(this.remote)} ${shellQuote(`refs/heads/${d.branch}:refs/heads/${d.branch}`)}`, timeoutMs: 5 * 60_000 });
      if (push.exitCode !== 0) {
        prs.push({ ...base, status: "failed", detail: clip(`git push failed: ${push.stderr || push.stdout}`, 500) });
        failedBranches.add(d.branch);
        continue;
      }
      const create = await this.edit.exec({
        cwd: this.repoPath,
        command: `gh pr create --draft --base ${shellQuote(d.baseBranch)} --head ${shellQuote(d.branch)} --title ${shellQuote(d.title)} --body-file ${shellQuote(`${exportDir}/${prFileName(d)}`)}`,
        timeoutMs: 5 * 60_000,
      });
      if (create.exitCode !== 0) {
        prs.push({ ...base, status: "pushed", detail: clip(`gh pr create failed: ${create.stderr || create.stdout}`, 500) });
        continue;
      }
      const url = /https?:\/\/\S+/u.exec(create.stdout)?.[0] ?? null;
      prs.push({ ...base, status: "opened", url, detail: "draft PR opened" });
    }
    await writeFiles(this.edit, input, prs, "github");
    return { mode: "github", exportDir, prs };
  }
}
