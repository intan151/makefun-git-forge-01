// rest.ts — GitHub REST v3 under /api/v3: repos, branches, commits, contents, issues,
// comments, labels, pull requests and merges. Shares the Store with git/GraphQL/MCP.

import { FIXED_ISO, SERVER_IDENT, COMMIT_TS, VIEWER_LOGIN, VIEWER_ID, issueJson, pullJson, repoJson, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { hashObject, parseCommit } from './gitpack.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  const text = `${JSON.stringify(value)}\n`;
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), ...extraHeaders },
    body: Buffer.from(text, 'utf8'),
  };
}

export function errorResponse(status: number, message: string): RestResponse {
  return jsonResponse(status, { message });
}

function parseJsonBody(req: RestRequest): { ok: true; value: unknown } | { ok: false; response: RestResponse } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(req.body.toString('utf8')) };
  } catch {
    return { ok: false, response: errorResponse(400, 'Problems parsing JSON') };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Parse a page of a list: returns the slice and a Link header value (or ''). */
function paginate<T>(
  items: readonly T[],
  req: RestRequest,
  defaultPerPage = 30,
): { page: T[]; link: string } {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : defaultPerPage;
  const pageRaw = Number.parseInt(req.query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    const next = new URL(req.path, req.baseUrl);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next"`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(req.path, req.baseUrl);
    last.searchParams.set('page', String(lastPage));
    last.searchParams.set('per_page', String(perPage));
    link += `, <${last.toString()}>; rel="last"`;
  }
  return { page: slice as T[], link };
}

function withLink(res: RestResponse, link: string): RestResponse {
  if (link) res.headers.link = link;
  return res;
}

/** Resolve (owner, repo) from a path; 404 when the owner is not the viewer or the repo is missing. */
function lookupRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

function commitSummary(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return { sha, commit: { message: '' } };
  const commit = parseCommit(object.data);
  return {
    sha,
    commit: {
      // GitHub strips the trailing newline(s) of the raw commit message.
      message: commit.message.replace(/\n+$/, ''),
      author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_ISO },
      committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_ISO },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

/** Walk a branch's history, newest first. */
function historyFrom(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Line counts for a changed file (set-based line diff; exactness is not asserted). */
function lineCounts(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldContent === null ? [] : oldContent.toString('utf8').split('\n');
  const newLines = newContent === null ? [] : newContent.toString('utf8').split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let additions = 0;
  for (const line of newLines) if (!oldSet.has(line)) additions += 1;
  let deletions = 0;
  for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
  return { additions, deletions };
}

function pullFiles(store: Store, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const base = store.mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
  const changes = store.diffCommits(repo, base, pull.headSha);
  const out: Array<Record<string, unknown>> = [];
  for (const change of changes) {
    const oldBlob = change.oldOid ? repo.objects.get(change.oldOid)?.data ?? null : null;
    const newBlob = change.newOid ? repo.objects.get(change.newOid)?.data ?? null : null;
    const counts = lineCounts(oldBlob, newBlob);
    out.push({
      sha: change.newOid ?? change.oldOid,
      filename: change.path,
      status: change.status === 'deleted' ? 'removed' : change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

/** Squash-merge a PR: returns the merge commit oid, or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  // Merge against the CURRENT base tip, not the sha captured when the PR was
  // opened: another PR may have advanced the base branch since then, and a
  // file changed there must conflict with the same file changed on the head.
  const baseSha = store.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  const baseOid = store.mergeBase(repo, baseSha, pull.headSha);
  if (!baseOid) return null;
  const baseObj = repo.objects.get(baseOid);
  const headObj = repo.objects.get(pull.headSha);
  const baseTipObj = repo.objects.get(baseSha);
  if (!baseObj || !headObj || !baseTipObj) return null;
  const baseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const baseTipTree = parseCommit(baseTipObj.data).tree;
  const headChanges = store.diffTrees(repo, baseTree, headTree);
  const baseChanges = store.diffTrees(repo, baseTree, baseTipTree);
  const baseChanged = new Map<string, string | null>();
  for (const change of baseChanges) baseChanged.set(change.path, change.newOid);
  const merged = store.flattenTree(repo, baseTipTree);
  for (const change of headChanges) {
    if (baseChanged.has(change.path)) {
      // Same file changed on both sides: conflict only when the results differ.
      if (baseChanged.get(change.path) !== change.newOid) return null;
    }
    if (change.newOid === null) merged.delete(change.path);
    else merged.set(change.path, { oid: change.newOid, mode: '100644' });
  }
  const treeOid = store.buildTreeFromFlat(repo, merged);
  const who = `${SERVER_IDENT} ${COMMIT_TS} +0000`;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitData = Buffer.from(
    `tree ${treeOid}\nparent ${baseSha}\nauthor ${who}\ncommitter ${who}\n\n${message}`,
    'utf8',
  );
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  store.invalidatePackCache(repo);
  return commitOid;
}

export function handleRest(store: Store, req: RestRequest): RestResponse | null {
  const segments = req.path.split('/').filter((s) => s !== '');
  // All REST routes live under /api/v3.
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const method = req.method;

  // GET /api/v3/ — API root.
  if (rest.length === 0) {
    if (method !== 'GET') return errorResponse(404, 'Not Found');
    return jsonResponse(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errorResponse(404, 'Not Found');
    return jsonResponse(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return errorResponse(404, 'Not Found');
    return jsonResponse(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'ada iversen' });
  }

  // POST /api/v3/user/repos | GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.repoOrder, req, 30);
      return withLink(jsonResponse(200, page.map((r) => repoJson(r, req.baseUrl))), link);
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const body = asObject(parsed.value);
      const name = str(body.name);
      if (!name) return errorResponse(422, 'name is required');
      const existing = store.getRepo(VIEWER_LOGIN, name);
      if (existing) return errorResponse(422, 'name already exists on this account');
      const repo = store.createRepo(name, str(body.description), body.private === true);
      return jsonResponse(201, repoJson(repo, req.baseUrl));
    }
    return errorResponse(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repo = lookupRepo(store, owner, name);
    const tail = rest.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) return errorResponse(404, 'Not Found');
        return jsonResponse(200, repoJson(repo, req.baseUrl));
      }
      if (method === 'PATCH') {
        if (!repo) return errorResponse(404, 'Not Found');
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const body = asObject(parsed.value);
        if (typeof body.description === 'string') repo.description = body.description;
        return jsonResponse(200, repoJson(repo, req.baseUrl));
      }
      if (method === 'DELETE') {
        if (!repo) return errorResponse(404, 'Not Found');
        store.deleteRepo(repo);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      return errorResponse(404, 'Not Found');
    }

    if (!repo) return errorResponse(404, 'Not Found');

    // POST /repos/{o}/{r}/git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const body = asObject(parsed.value);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return errorResponse(422, 'Invalid request');
      if (!repo.objects.has(sha)) return errorResponse(422, 'Object does not exist');
      if (repo.refs.has(ref)) return errorResponse(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      store.invalidatePackCache(repo);
      return jsonResponse(201, { ref, object: { sha, type: 'commit' } });
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (tail.length === 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') {
      const branch = decodeURIComponent(tail[3]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return errorResponse(404, 'Not Found');
      return jsonResponse(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }

    // GET /repos/{o}/{r}/branches | /branches/{branch}
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
        return jsonResponse(200, branches);
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(tail[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return errorResponse(404, 'Not Found');
        return jsonResponse(200, { name: branch, commit: { sha } });
      }
      return errorResponse(404, 'Not Found');
    }

    // GET /repos/{o}/{r}/commits
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const shaParam = req.query.get('sha');
      const tip = shaParam ? store.resolveRef(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return jsonResponse(200, []);
      const history = historyFrom(repo, tip);
      return jsonResponse(200, history.map((sha) => commitSummary(repo, sha)));
    }

    // /repos/{o}/{r}/contents/{path...}
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'PUT') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const body = asObject(parsed.value);
        const branch = str(body.branch) || repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const branchTip = repo.refs.get(branchRef);
        const message = str(body.message) || 'Update file';
        const contentB64 = str(body.content);
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errorResponse(400, 'content is not valid base64');
        }
        // Stale-sha check.
        const currentTree = branchTip ? store.treeAt(repo, branchRef) : undefined;
        const currentFlat = currentTree ? store.flattenTree(repo, currentTree) : new Map();
        const existing = currentFlat.get(path);
        const givenSha = str(body.sha);
        if (givenSha) {
          if (!existing || existing.oid !== givenSha) return errorResponse(409, 'sha does not match the current file');
        }
        const isUpdate = existing !== undefined;
        const commitSha = store.commitFile(repo, branch, path, content, message);
        const blobSha = hashObject('blob', content);
        return jsonResponse(isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha },
        });
      }
      if (method === 'GET') {
        const refParam = req.query.get('ref');
        const treeOid = refParam ? store.treeAt(repo, refParam) : store.treeAt(repo, repo.defaultBranch);
        if (!treeOid) return errorResponse(404, 'Not Found');
        const flat = store.flattenTree(repo, treeOid);
        if (path === '') {
          // Root listing.
          const entries: Array<Record<string, unknown>> = [];
          const seen = new Set<string>();
          for (const [filePath, value] of flat) {
            const top = filePath.split('/')[0];
            if (seen.has(top)) continue;
            seen.add(top);
            entries.push({ type: filePath.includes('/') ? 'dir' : 'file', name: top, path: top, sha: value.oid });
          }
          return jsonResponse(200, entries);
        }
        const file = flat.get(path);
        if (file) {
          const blob = repo.objects.get(file.oid);
          const bytes = blob ? blob.data : Buffer.alloc(0);
          return jsonResponse(200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path.split('/').pop(),
            path,
            content: bytes.toString('base64'),
            sha: file.oid,
          });
        }
        // Directory?
        const prefix = `${path}/`;
        const children = new Map<string, { type: string; sha: string }>();
        for (const [filePath, value] of flat) {
          if (!filePath.startsWith(prefix)) continue;
          const restPath = filePath.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (!children.has(first)) {
            children.set(first, { type: restPath.includes('/') ? 'dir' : 'file', sha: value.oid });
          }
        }
        if (children.size === 0) return errorResponse(404, 'Not Found');
        const entries = [...children.entries()].map(([name, value]) => ({
          type: value.type,
          name,
          path: `${path}/${name}`,
          sha: value.sha,
        }));
        return jsonResponse(200, entries);
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const body = asObject(parsed.value);
        const branch = repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const treeOid = store.treeAt(repo, branchRef);
        if (!treeOid) return errorResponse(404, 'Not Found');
        const flat = store.flattenTree(repo, treeOid);
        const existing = flat.get(path);
        if (!existing) return errorResponse(404, 'Not Found');
        const message = str(body.message) || 'Delete file';
        const commitSha = store.commitFile(repo, branch, path, null, message);
        return jsonResponse(200, { commit: { sha: commitSha } });
      }
      return errorResponse(404, 'Not Found');
    }

    // POST /repos/{o}/{r}/labels
    if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const body = asObject(parsed.value);
      const name = str(body.name);
      if (!name) return errorResponse(422, 'name is required');
      const color = str(body.color) || 'ededed';
      repo.labels.set(name, { name, color });
      return jsonResponse(201, { name, color, description: '' });
    }
    if (tail.length === 1 && tail[0] === 'labels' && method === 'GET') {
      return jsonResponse(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    }

    // /repos/{o}/{r}/issues[...]
    if (tail[0] === 'issues') {
      // POST /repos/{o}/{r}/issues
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const body = asObject(parsed.value);
        const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
        const labels: Array<{ name: string; color: string }> = [];
        for (const label of labelsRaw) {
          const labelName = typeof label === 'string' ? label : str((label as Record<string, unknown>).name);
          const found = repo.labels.get(labelName);
          if (!found) return errorResponse(422, `Label does not exist: ${labelName}`);
          labels.push(found);
        }
        const issue: Issue = {
          id: store.nextIssueId++,
          number: repo.nextIssue++,
          title: str(body.title),
          body: str(body.body),
          state: 'open',
          labels,
          userLogin: VIEWER_LOGIN,
          createdAt: FIXED_ISO,
          updatedAt: FIXED_ISO,
          seq: repo.issues.length,
        };
        repo.issues.push(issue);
        return jsonResponse(201, issueJson(issue, repo));
      }
      // GET /repos/{o}/{r}/issues
      if (tail.length === 1 && method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let list = repo.issues;
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        const sorted = [...list];
        if (sort === 'created') {
          sorted.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, link } = paginate(sorted, req, 30);
        return withLink(jsonResponse(200, page.map((i) => issueJson(i, repo))), link);
      }
      // /issues/{n}[...]
      if (tail.length >= 2) {
        const number = Number.parseInt(tail[1], 10);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return errorResponse(404, 'Not Found');
        if (tail.length === 2) {
          if (method === 'GET') return jsonResponse(200, issueJson(issue, repo));
          if (method === 'PATCH') {
            const parsed = parseJsonBody(req);
            if (!parsed.ok) return parsed.response;
            const body = asObject(parsed.value);
            if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            issue.updatedAt = FIXED_ISO;
            return jsonResponse(200, issueJson(issue, repo));
          }
          return errorResponse(404, 'Not Found');
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'GET') {
            const list = repo.comments.get(number) ?? [];
            return jsonResponse(200, list.map((c) => ({ id: c.id, body: c.body, user: { login: c.userLogin, id: VIEWER_ID }, created_at: c.createdAt })));
          }
          if (method === 'POST') {
            const parsed = parseJsonBody(req);
            if (!parsed.ok) return parsed.response;
            const body = asObject(parsed.value);
            const comment = {
              id: repo.nextCommentId++,
              body: str(body.body),
              userLogin: VIEWER_LOGIN,
              createdAt: FIXED_ISO,
            };
            const list = repo.comments.get(number) ?? [];
            list.push(comment);
            repo.comments.set(number, list);
            return jsonResponse(201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_ISO });
          }
          return errorResponse(404, 'Not Found');
        }
        return errorResponse(404, 'Not Found');
      }
      return errorResponse(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls[...]
    if (tail[0] === 'pulls') {
      // POST /repos/{o}/{r}/pulls
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const body = asObject(parsed.value);
        const head = str(body.head);
        const base = str(body.base);
        const headSha = store.resolveRef(repo, head);
        const baseSha = store.resolveRef(repo, base);
        if (!headSha || !baseSha) return errorResponse(422, 'head or base branch does not exist');
        const pull: Pull = {
          id: store.nextPullId++,
          number: repo.nextPull++,
          title: str(body.title),
          body: str(body.body),
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
        return jsonResponse(201, pullJson(pull, repo));
      }
      // GET /repos/{o}/{r}/pulls
      if (tail.length === 1 && method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let list = repo.pulls;
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        const { page, link } = paginate(list, req, 30);
        return withLink(jsonResponse(200, page.map((p) => pullJson(p, repo))), link);
      }
      if (tail.length >= 2) {
        const number = Number.parseInt(tail[1], 10);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return errorResponse(404, 'Not Found');
        if (tail.length === 2 && method === 'GET') {
          return jsonResponse(200, pullJson(pull, repo));
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          return jsonResponse(200, pullFiles(store, repo, pull));
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (pull.merged) return errorResponse(405, 'Pull request already merged');
          const mergeSha = squashMerge(store, repo, pull);
          if (mergeSha === null) return errorResponse(405, 'Merge conflict');
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = FIXED_ISO;
          pull.mergeCommitSha = mergeSha;
          // Refresh base sha to the new tip.
          pull.baseSha = mergeSha;
          return jsonResponse(200, { sha: mergeSha, merged: true, message: `Pull request #${pull.number} merged` });
        }
        return errorResponse(404, 'Not Found');
      }
      return errorResponse(404, 'Not Found');
    }
  }

  return null;
}
