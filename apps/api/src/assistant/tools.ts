import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { buildTask, initiative, repositoryEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { bugCreateSchema } from '@sdlc/schemas';
import type { GitHubService } from '../github-service.js';
import type { PreviewService } from '../previews.js';
import { searchSections } from './docs.js';
import type { DocSection } from './docs.js';
import type { ToolSpec } from './model.js';

export interface Proposal {
  id: string;
  kind: 'retry_task' | 'start_preview' | 'file_bug' | 'open_screen';
  label: string;
  why: string;
  params: Record<string, unknown>;
  state: 'proposed' | 'done' | 'dismissed';
}

export interface Step {
  tool: string;
  summary: string;
}

export interface ToolDeps {
  db: Db;
  github: Pick<GitHubService, 'readFile' | 'listFiles' | 'pullRequestFiles'>;
  previews: () => PreviewService | null;
  /** Reads one of the platform's own routes as the person who is asking, so what they may see is all they get. */
  api: (path: string) => Promise<{ status: number; body: unknown }>;
  docs: () => Promise<DocSection[]>;
  doFetch?: typeof fetch;
}

/** The platform routes the assistant may read. Reading only, and nothing that is not about work the person can see. */
const READABLE: RegExp[] = [
  /^\/api\/initiatives$/,
  /^\/api\/initiatives\/[0-9a-f-]{36}$/,
  /^\/api\/initiatives\/[0-9a-f-]{36}\/(map|plan|stages|releases|preview)$/,
  /^\/api\/interactions$/,
  /^\/api\/interactions\/[0-9a-f-]{36}$/,
  /^\/api\/interactions\/[0-9a-f-]{36}\/(smoke|security|preview)$/,
  /^\/api\/runs\/[0-9a-f-]{36}$/,
  /^\/api\/runs\/[0-9a-f-]{36}\/events$/,
  /^\/api\/bugs$/,
  /^\/api\/costs$/,
  /^\/api\/costs\/budget$/,
  /^\/api\/portfolio$/,
  /^\/api\/repositories$/,
  /^\/api\/repositories\/[0-9a-f-]{36}\/readiness$/,
  /^\/api\/integrations$/,
  /^\/api\/assumptions$/,
  /^\/api\/standing-decisions$/,
  /^\/api\/autopilot$/,
  /^\/api\/metrics\/interruptions$/,
];

const MAX_TEXT = 9000;
const LIST_MAX = 40;
const EXEC_MS = 30_000;
const MAX_EXEC = 6;
/** Signing in to the app under test is the one write a request may make. */
const SIGN_IN_PATH = /(login|signin|sign-in|auth|session|token)/i;

export const clip = (s: string, max = MAX_TEXT): string =>
  s.length > max ? `${s.slice(0, max)}\n[cut: ${s.length - max} more characters]` : s;

/** Keeps a long list to what fits: the newest events, or the first of anything else. */
function shape(value: unknown, newestLast: boolean): unknown {
  if (Array.isArray(value) && value.length > LIST_MAX)
    return newestLast ? value.slice(-LIST_MAX) : value.slice(0, LIST_MAX);
  return value;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'platform_api',
    description:
      "Reads one of the platform's own pages of data, as the person who is asking. Use it for anything about initiatives, runs, reviews, tasks, bugs, costs and checks. Give the path. Available:\n" +
      '/api/initiatives (all initiatives)\n' +
      '/api/initiatives/{id} (one initiative)\n' +
      '/api/initiatives/{id}/map (its stages: spec and design, build and review, release, with the runs and asks in each)\n' +
      '/api/initiatives/{id}/plan (the build plan and each task T1.. with its state and why it failed)\n' +
      '/api/initiatives/{id}/stages (the spec and design steps)\n' +
      '/api/initiatives/{id}/releases\n' +
      '/api/initiatives/{id}/preview (the preview of what the build produced)\n' +
      '/api/interactions (open asks for the person; add ?state=answered for settled ones)\n' +
      '/api/interactions/{id} (one ask or review)\n' +
      '/api/interactions/{id}/smoke, /security, /preview (the checks on a pull request review)\n' +
      '/api/runs/{id} and /api/runs/{id}/events (one agent run and what it did)\n' +
      '/api/bugs?initiativeId={id}\n' +
      '/api/costs?days=30&initiativeId={id}, /api/costs/budget\n' +
      '/api/portfolio, /api/repositories, /api/repositories/{id}/readiness, /api/integrations, /api/assumptions, /api/standing-decisions, /api/autopilot, /api/metrics/interruptions',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A path above, with its query string if it has one.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_platform_docs',
    description:
      "Searches the platform's own documents (the README, the adoption guide and the design record) for how the platform works: concepts, rules, roles, checks, settings. Returns the best matching sections.",
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'read_repo_file',
    description:
      "Reads one file of an initiative's repository from GitHub, at a branch, tag or commit (default: the integration branch, usually main). Use it to read the built app's code, a spec or a design.",
    input_schema: {
      type: 'object',
      properties: {
        initiative_id: { type: 'string' },
        path: {
          type: 'string',
          description: 'For example apps/api/src/auth.ts or docs/design/foo.md',
        },
        ref: { type: 'string', description: 'A branch, tag or commit. Optional.' },
      },
      required: ['initiative_id', 'path'],
    },
  },
  {
    name: 'list_repo_files',
    description: "Lists the files in one folder of an initiative's repository.",
    input_schema: {
      type: 'object',
      properties: {
        initiative_id: { type: 'string' },
        dir: { type: 'string', description: 'A folder, or empty for the top.' },
        ref: { type: 'string' },
      },
      required: ['initiative_id'],
    },
  },
  {
    name: 'pull_request_files',
    description:
      "The files a pull request changed, with each file's patch (cut). Use the number from a review's card.",
    input_schema: {
      type: 'object',
      properties: { initiative_id: { type: 'string' }, pr_number: { type: 'number' } },
      required: ['initiative_id', 'pr_number'],
    },
  },
  {
    name: 'preview_logs',
    description:
      "What a running preview of the built app printed (install, build, server output), newest lines. Get the preview id from /api/initiatives/{id}/preview (id) or from a review's /preview (platform.id).",
    input_schema: {
      type: 'object',
      properties: { preview_id: { type: 'string' }, lines: { type: 'number' } },
      required: ['preview_id'],
    },
  },
  {
    name: 'preview_request',
    description:
      'Makes one HTTP request to a RUNNING preview of the built app, to see how it behaves. GET and HEAD for any path. POST only to a sign-in path (login, signin, auth, session, token), so you can sign in and read the token; then pass it in headers on later GETs. Returns the status, a few headers and the start of the body.',
    input_schema: {
      type: 'object',
      properties: {
        preview_id: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST'] },
        path: { type: 'string', description: 'Starts with /, for example /api/health' },
        headers: {
          type: 'object',
          description: 'authorization, content-type, accept or cookie only',
        },
        body: { type: 'string', description: 'JSON text, for a sign-in POST' },
      },
      required: ['preview_id', 'path'],
    },
  },
  {
    name: 'preview_exec',
    description:
      "Runs one shell command inside a RUNNING preview's sandbox, in the folder holding the app's code (for example `ls`, `cat package.json`, `npm test`, `node -e ...`). The sandbox has no secrets and almost no network, and stops by itself. 30 seconds at most. Use it to reproduce a problem or inspect files that are on the server.",
    input_schema: {
      type: 'object',
      properties: { preview_id: { type: 'string' }, command: { type: 'string' } },
      required: ['preview_id', 'command'],
    },
  },
  {
    name: 'propose_action',
    description:
      'Suggests one action to the person. They see a button and nothing happens until they click it. Kinds: retry_task (params planId, key: run a failed build task again), start_preview (params initiativeId: run the built app in a sandbox), file_bug (params initiativeId, title, description, steps, severity low|medium|high: the Bug Agent then reproduces and fixes it), open_screen (params href such as #/queue/{id} or #/map/{id}). Give a short label for the button and why.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['retry_task', 'start_preview', 'file_bug', 'open_screen'] },
        label: { type: 'string' },
        why: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['kind', 'label', 'why', 'params'],
    },
  },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Runs the assistant's tools for one answer. It keeps what it looked at and what it suggested. */
export class AssistantTools {
  readonly steps: Step[] = [];
  readonly proposals: Proposal[] = [];
  private execs = 0;

  constructor(private readonly deps: ToolDeps) {}

  /** Runs one tool. Never throws: a failure is the tool's answer, so the model can say so or try another way. */
  async run(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ text: string; error: boolean }> {
    try {
      const out = await this.dispatch(name, input);
      this.note(name, out.step);
      return { text: clip(out.text), error: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.note(name, `failed: ${message.slice(0, 120)}`);
      return { text: `That did not work: ${message}`, error: true };
    }
  }

  private note(tool: string, summary: string) {
    this.steps.push({ tool, summary: summary.slice(0, 160) });
  }

  private async dispatch(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ text: string; step: string }> {
    switch (name) {
      case 'platform_api':
        return this.platformApi(str(input.path));
      case 'search_platform_docs':
        return this.searchDocs(str(input.query));
      case 'read_repo_file':
        return this.readFile(str(input.initiative_id), str(input.path), str(input.ref));
      case 'list_repo_files':
        return this.listFiles(str(input.initiative_id), str(input.dir), str(input.ref));
      case 'pull_request_files':
        return this.prFiles(str(input.initiative_id), Number(input.pr_number));
      case 'preview_logs':
        return this.previewLogs(str(input.preview_id), Number(input.lines) || 120);
      case 'preview_request':
        return this.previewRequest(input);
      case 'preview_exec':
        return this.previewExec(str(input.preview_id), str(input.command));
      case 'propose_action':
        return this.propose(input);
      default:
        throw new Error(`there is no tool called ${name}`);
    }
  }

  private async platformApi(raw: string) {
    const [path = '', query = ''] = raw.split('?');
    if (!READABLE.some((r) => r.test(path)))
      throw new Error(`${path || 'that path'} is not one of the pages of data you may read`);
    const res = await this.deps.api(query ? `${path}?${query}` : path);
    if (res.status === 404)
      return { text: 'Nothing is there (404).', step: `read ${path}: nothing` };
    if (res.status >= 400)
      return {
        text: `The platform answered ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`,
        step: `read ${path}: ${res.status}`,
      };
    return {
      text: JSON.stringify(shape(res.body, path.endsWith('/events'))),
      step: `read ${path}`,
    };
  }

  private async searchDocs(query: string) {
    const hits = searchSections(await this.deps.docs(), query);
    if (hits.length === 0)
      return {
        text: 'No section of the documents matches that.',
        step: `searched the docs for "${query.slice(0, 60)}": nothing`,
      };
    return {
      text: hits.map((h) => `## ${h.heading} (${h.source})\n${h.text}`).join('\n\n---\n\n'),
      step: `searched the docs for "${query.slice(0, 60)}"`,
    };
  }

  private async repoOf(initiativeId: string) {
    const [row] = await this.deps.db
      .select({ repo: repositoryEntry.fullName, branch: repositoryEntry.integrationBranch })
      .from(initiative)
      .innerJoin(repositoryEntry, eq(repositoryEntry.id, initiative.repositoryId))
      .where(eq(initiative.id, initiativeId));
    if (!row) throw new Error('there is no such initiative');
    return row;
  }

  private async readFile(initiativeId: string, path: string, ref: string) {
    const { repo, branch } = await this.repoOf(initiativeId);
    if (!path || path.includes('..')) throw new Error('give a path inside the repository');
    const text = await this.deps.github.readFile(repo, path, ref || branch);
    if (text === null)
      return {
        text: `There is no file ${path} at ${ref || branch}.`,
        step: `read ${path}: not there`,
      };
    return { text: text.includes('\0') ? '(a binary file)' : text, step: `read ${repo}:${path}` };
  }

  private async listFiles(initiativeId: string, dir: string, ref: string) {
    const { repo, branch } = await this.repoOf(initiativeId);
    const files = await this.deps.github.listFiles(
      repo,
      dir.replace(/^\/+|\/+$/g, ''),
      ref || branch,
    );
    return {
      text: files.length > 0 ? files.join('\n') : 'No files there (folders are not listed).',
      step: `listed ${repo}:${dir || '/'}`,
    };
  }

  private async prFiles(initiativeId: string, number: number) {
    const { repo } = await this.repoOf(initiativeId);
    if (!Number.isInteger(number) || number < 1) throw new Error('give the pull request number');
    const files = await this.deps.github.pullRequestFiles(repo, number, 40);
    return {
      text: files
        .map((f) => `### ${f.path} (${f.status})\n${clip(f.patch ?? '(no patch)', 1500)}`)
        .join('\n\n'),
      step: `read the files of ${repo}#${number}`,
    };
  }

  private async liveRow(id: string) {
    const svc = this.deps.previews();
    if (!svc) throw new Error('this platform does not run previews');
    const row = await svc.get(id);
    if (!row) throw new Error('there is no such preview');
    if (row.state !== 'ready' && row.state !== 'starting')
      throw new Error(
        `that preview is ${row.state}, not running. Suggest starting one with propose_action.`,
      );
    return { svc, row };
  }

  private async previewLogs(id: string, lines: number) {
    const { svc } = await this.liveRow(id);
    const out = await svc.logs(id, Math.min(Math.max(lines, 10), 300));
    return {
      text: out.trim() || '(the preview has printed nothing yet, or this host cannot show it)',
      step: "read the preview's output",
    };
  }

  private async previewRequest(input: Record<string, unknown>) {
    const { row } = await this.liveRow(str(input.preview_id));
    const method = (str(input.method) || 'GET').toUpperCase();
    const path = str(input.path);
    if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path))
      throw new Error('the path must start with a single / and hold no spaces');
    if (!['GET', 'HEAD', 'POST'].includes(method))
      throw new Error('only GET, HEAD and a sign-in POST are allowed');
    if (method === 'POST' && !SIGN_IN_PATH.test(path))
      throw new Error(
        'POST is only for signing in (a path with login, signin, auth, session or token)',
      );
    const base = row.target ?? row.url;
    if (!base) throw new Error('the preview has no address yet');
    const headers: Record<string, string> = {};
    const given = (input.headers ?? {}) as Record<string, unknown>;
    for (const k of ['authorization', 'content-type', 'accept', 'cookie'])
      for (const [name, v] of Object.entries(given))
        if (name.toLowerCase() === k && typeof v === 'string') headers[k] = v.slice(0, 2000);
    const res = await (this.deps.doFetch ?? fetch)(new URL(path, base).toString(), {
      method,
      headers,
      ...(method === 'POST' ? { body: str(input.body).slice(0, 4000) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const body = method === 'HEAD' ? '' : (await res.text()).slice(0, 4000);
    const shown = ['content-type', 'location', 'www-authenticate'].flatMap((h) => {
      const v = res.headers.get(h);
      return v ? [`${h}: ${v}`] : [];
    });
    return {
      text: `HTTP ${res.status}\n${shown.join('\n')}\n\n${body}`,
      step: `${method} ${path} on the preview: ${res.status}`,
    };
  }

  private async previewExec(id: string, command: string) {
    const { svc } = await this.liveRow(id);
    if (!command.trim() || command.length > 400)
      throw new Error('give one command of at most 400 characters');
    if (this.execs >= MAX_EXEC) throw new Error(`at most ${MAX_EXEC} commands for one answer`);
    this.execs++;
    const out = await svc.exec(id, command, EXEC_MS);
    if (!out) throw new Error('this host cannot run commands in a preview');
    return {
      text: `exit ${out.exitCode}\n${out.output.slice(-4000)}`,
      step: `ran \`${command.slice(0, 80)}\` in the preview: exit ${out.exitCode}`,
    };
  }

  private async propose(input: Record<string, unknown>) {
    const kind = str(input.kind) as Proposal['kind'];
    const params = (input.params ?? {}) as Record<string, unknown>;
    const { db } = this.deps;
    if (kind === 'retry_task') {
      const planId = str(params.planId);
      const key = str(params.key);
      const [task] = planId
        ? await db
            .select({ state: buildTask.state })
            .from(buildTask)
            .where(and(eq(buildTask.planId, planId), eq(buildTask.key, key)))
        : [];
      if (!task)
        throw new Error('that task does not exist (use the plan id and the task key from /plan)');
      if (task.state !== 'failed')
        throw new Error(`${key} is ${task.state}, and only a failed task can be retried`);
    } else if (kind === 'start_preview') {
      await this.repoOf(str(params.initiativeId));
    } else if (kind === 'file_bug') {
      await this.repoOf(str(params.initiativeId));
      const parsed = bugCreateSchema.safeParse(params);
      if (!parsed.success)
        throw new Error(
          `the bug report is not complete: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        );
    } else if (kind === 'open_screen') {
      if (!/^#\/[a-z0-9/-]*$/i.test(str(params.href)))
        throw new Error('href must look like #/queue/{id}');
    } else {
      throw new Error(`${kind || 'that'} is not a kind of action`);
    }
    const proposal: Proposal = {
      id: randomUUID(),
      kind,
      label: str(input.label).slice(0, 80) || kind,
      why: str(input.why).slice(0, 300),
      params,
      state: 'proposed',
    };
    this.proposals.push(proposal);
    return {
      text: 'Proposed. The person sees a button for it. Nothing has happened yet, so do not say it has.',
      step: `suggested: ${proposal.label}`,
    };
  }
}
