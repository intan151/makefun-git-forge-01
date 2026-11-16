// mcp.ts — Model Context Protocol at POST /mcp, modern era only (2026-07-28).
// Plain-JSON responses (no SSE), one shared in-memory store with REST/GraphQL.
// Node 22 stdlib only.

import { FIXED_ISO, VIEWER_LOGIN, issueJson, pullJson, repoJson, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { squashMerge } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28'] as const;

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      body: { type: 'string', description: 'Pull request body.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'integer', description: 'Pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
      },
    })),
  };
}

function rpcResult(id: unknown, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`;
}

function textResult(text: string, structured?: unknown, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    isError,
  };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const required of tool.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') return required;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function getRepoForTool(store: Store, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  if (owner !== VIEWER_LOGIN) return { error: `repository ${owner}/${repoName} not found` };
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { error: `repository ${owner}/${repoName} not found` };
  return { repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { rpcErrorCode?: number; result?: Record<string, unknown> } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { rpcErrorCode: -32602 };
  const missing = missingArgs(tool, args);
  if (missing) return { rpcErrorCode: -32602 };

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      if (store.getRepo(VIEWER_LOGIN, repoName)) {
        return { result: textResult(`repository ${VIEWER_LOGIN}/${repoName} already exists`, undefined, true) };
      }
      const repo = store.createRepo(repoName, description, isPrivate);
      const fullName = `${VIEWER_LOGIN}/${repoName}`;
      const structured = { ...repoJson(repo), full_name: fullName };
      return { result: textResult(`Created repository ${fullName} (id ${repo.id}).\n${JSON.stringify(structured)}`, structured) };
    }
    case 'get_repo': {
      const found = getRepoForTool(store, args);
      if ('error' in found) return { result: textResult(found.error, undefined, true) };
      const structured = { ...repoJson(found.repo), full_name: `${VIEWER_LOGIN}/${found.repo.name}` };
      return { result: textResult(`Repository ${VIEWER_LOGIN}/${found.repo.name} (id ${found.repo.id}).\n${JSON.stringify(structured)}`, structured) };
    }
    case 'create_issue': {
      const found = getRepoForTool(store, args);
      if ('error' in found) return { result: textResult(found.error, undefined, true) };
      const repo = found.repo;
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssue++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        userLogin: VIEWER_LOGIN,
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
        seq: repo.issues.length,
      };
      repo.issues.push(issue);
      const structured = issueJson(issue, repo);
      return { result: textResult(`Created issue #${issue.number}: ${issue.title}\n${JSON.stringify(structured)}`, structured) };
    }
    case 'list_issues': {
      const found = getRepoForTool(store, args);
      if ('error' in found) return { result: textResult(found.error, undefined, true) };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = found.repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const structured = list.map((issue) => issueJson(issue, found.repo));
      return { result: textResult(JSON.stringify(structured), { issues: structured }) };
    }
    case 'create_pull_request': {
      const found = getRepoForTool(store, args);
      if ('error' in found) return { result: textResult(found.error, undefined, true) };
      const repo = found.repo;
      const head = String(args.head);
      const base = String(args.base);
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (!headSha || !baseSha) {
        return { result: textResult(`head or base branch does not exist: head=${head} base=${base}`, undefined, true) };
      }
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextPull++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        seq: repo.pulls.length,
      };
      repo.pulls.push(pull);
      const structured = pullJson(pull, repo);
      return {
        result: textResult(
          `Created pull request #${pull.number}: ${pull.title} (${head} -> ${base})\n${JSON.stringify(structured)}`,
          structured,
        ),
      };
    }
    case 'merge_pull_request': {
      const found = getRepoForTool(store, args);
      if ('error' in found) return { result: textResult(found.error, undefined, true) };
      const repo = found.repo;
      const number = asNumber(args.pull_number);
      if (number === null) return { result: textResult('pull_number must be a number', undefined, true) };
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { result: textResult(`pull request #${number} not found`, undefined, true) };
      if (!pull.merged) {
        const mergeSha = squashMerge(store, repo, pull);
        if (mergeSha === null) {
          return { result: textResult(`pull request #${number} has a merge conflict`, undefined, true) };
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = mergeSha;
        pull.baseSha = mergeSha;
      }
      const structured = { ...pullJson(pull, repo), merged: true };
      return { result: textResult(`Merged pull request #${number}.\n${JSON.stringify(structured)}`, structured) };
    }
    default:
      return { rpcErrorCode: -32602 };
  }
}

function requestedVersion(params: Record<string, unknown> | undefined): string | undefined {
  const meta = params?._meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') return undefined;
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  if (typeof version === 'string') return version;
  if (typeof meta.protocolVersion === 'string') return meta.protocolVersion;
  return undefined;
}

/** Handles POST /mcp. `authorized` is true when the Authorization header matched. */
export function handleMcp(store: Store, body: Buffer, authorized: boolean): { status: number; body: Buffer; contentType?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // Parse error: extract the id from the truncated body with a regex.
    const text = body.toString('utf8');
    const match = /"id"\s*:\s*(\d+|"[^"]*")/.exec(text);
    let id: unknown = null;
    if (match) {
      const raw = match[1];
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    return { status: 400, body: Buffer.from(rpcError(id, -32700, 'Parse error: request body is not valid JSON'), 'utf8') };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: Buffer.from(rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'), 'utf8') };
  }
  const request = parsed as Record<string, unknown>;
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and expect no response.
  if (id === undefined) {
    return { status: 202, body: Buffer.alloc(0) };
  }

  if (!authorized) {
    return { status: 401, body: Buffer.from('{"message":"Requires authentication"}\n', 'utf8') };
  }

  if (method === 'server/discover') {
    const version = requestedVersion(params);
    if (version !== undefined && !SUPPORTED_VERSIONS.includes(version as '2026-07-28')) {
      return {
        status: 200,
        body: Buffer.from(
          rpcError(id, -32022, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS] }),
          'utf8',
        ),
      };
    }
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      body: Buffer.from(
        rpcResult(id, {
          resultType: 'DiscoverResult',
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          instructions: 'GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL, and MCP tools over one store.',
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }),
        'utf8',
      ),
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: Buffer.from(rpcResult(id, toolListResult()), 'utf8') };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, name, args);
    if (outcome.rpcErrorCode !== undefined) {
      return { status: 200, body: Buffer.from(rpcError(id, outcome.rpcErrorCode, `Invalid params: unknown tool or missing required arguments`), 'utf8') };
    }
    return { status: 200, body: Buffer.from(rpcResult(id, outcome.result), 'utf8') };
  }

  if (method === 'initialize') {
    // Legacy handshake is not implemented; the modern era is negotiated via
    // server/discover. Report method-not-found so a legacy client can tell.
    return { status: 200, body: Buffer.from(rpcError(id, -32601, 'Method not found: initialize'), 'utf8') };
  }

  return { status: 200, body: Buffer.from(rpcError(id, -32601, `Method not found: ${method}`), 'utf8') };
}
