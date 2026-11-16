// store.ts — the forge's in-memory store: one Repo per (owner, name), holding git objects,
// refs, issues, pull requests, labels and comments. Everything deterministic: ids and
// numbers come from counters, timestamps are one fixed value (never the wall clock),
// so two runs of the same request sequence leave identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitpack.ts';

/** The login the trial token names (scenario viewer, derived from the kit's published
 *  fixed seed: wire.ts buildScenario() -> users[0]). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Fixed timestamp for every created_at / merged_at / commit the server writes. */
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
export const FIXED_EPOCH = 1735689600;
/** Identity the server stamps on commits it creates (contents PUT, squash merges). */
export const SERVER_IDENT = 'ada iversen <adaiversen@example.invalid>';
export const COMMIT_TS = 1700000000;

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string; color: string }>;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  nextIssue: number;
  pulls: Pull[];
  nextPull: number;
  comments: Map<number, Comment[]>;
  nextCommentId: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  repoOrder: Repo[] = [];
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  /** Pack cache: key -> deflated pack bytes. Cleared per repo on any ref update. */
  packCache = new Map<string, Buffer>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      nextIssue: 1,
      pulls: [],
      nextPull: 1,
      comments: new Map(),
      nextCommentId: 1,
      seq: this.repoOrder.length,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    this.repoOrder = this.repoOrder.filter((r) => r !== repo);
    for (const key of [...this.packCache.keys()]) {
      if (key.startsWith(`${this.key(repo.owner, repo.name)}|`)) this.packCache.delete(key);
    }
  }

  invalidatePackCache(repo: Repo): void {
    const prefix = `${this.key(repo.owner, repo.name)}|`;
    for (const key of [...this.packCache.keys()]) {
      if (key.startsWith(prefix)) this.packCache.delete(key);
    }
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a ref name (branch, tag, full ref, or short name) to an oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const heads = `refs/heads/${ref}`;
    if (repo.refs.has(heads)) return repo.refs.get(heads);
    const tags = `refs/tags/${ref}`;
    if (repo.refs.has(tags)) return repo.refs.get(tags);
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return undefined;
  }

  /** The tree oid at a ref, or undefined when the ref (or its commit) is missing. */
  treeAt(repo: Repo, ref: string): string | undefined {
    const oid = this.resolveRef(repo, ref);
    if (!oid) return undefined;
    const object = repo.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'commit') return parseCommit(object.data).tree;
    if (object.type === 'tag') {
      const target = repo.objects.get((object.data.toString('utf8').match(/^object ([0-9a-f]{40})/m) ?? [])[1] ?? '');
      if (target && target.type === 'commit') return parseCommit(target.data).tree;
      return undefined;
    }
    if (object.type === 'tree') return oid;
    return undefined;
  }

  /** Flatten a tree into path -> {oid, mode} (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const full = path ? `${path}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, full);
        else out.set(full, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (or rebuild) the nested trees for a flat path map, returning the root tree oid.
   *  Intermediate trees are stored as objects. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const buildDir = (paths: Array<{ parts: string[]; oid: string; mode: string }>): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Array<{ parts: string[]; oid: string; mode: string }>>();
      for (const item of paths) {
        if (item.parts.length === 1) {
          entries.push({ mode: item.mode, name: item.parts[0], oid: item.oid });
        } else {
          const dir = item.parts[0];
          const rest = dirs.get(dir) ?? [];
          rest.push({ parts: item.parts.slice(1), oid: item.oid, mode: item.mode });
          dirs.set(dir, rest);
        }
      }
      for (const [name, children] of dirs) {
        entries.push({ mode: '40000', name, oid: buildDir(children) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    const items = [...flat.entries()].map(([path, value]) => ({
      parts: path.split('/'),
      oid: value.oid,
      mode: value.mode,
    }));
    return buildDir(items);
  }

  /** Create a commit on `branch` that sets `path` to `content` (or deletes it when
   *  content is null), with `message`. Returns the new commit oid. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): string {
    const parentOid = repo.refs.get(`refs/heads/${branch}`);
    let flat = new Map<string, { oid: string; mode: string }>();
    if (parentOid) {
      const parent = repo.objects.get(parentOid);
      if (parent && parent.type === 'commit') {
        flat = this.flattenTree(repo, parseCommit(parent.data).tree);
      }
    }
    if (content === null) flat.delete(path);
    else {
      const blobOid = this.putObject(repo, 'blob', content);
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const who = `${SERVER_IDENT} ${COMMIT_TS} +0000`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: parentOid ? [parentOid] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    this.invalidatePackCache(repo);
    return commitOid;
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Merge-base: the newest common ancestor of two commits (first found by BFS from both). */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsOf = (start: string): Set<string> => {
      const seen = new Set<string>();
      const queue: string[] = [start];
      while (queue.length > 0) {
        const oid = queue.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (object && object.type === 'commit') {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      }
      return seen;
    };
    const aAncestors = ancestorsOf(a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    return undefined;
  }

  /** Diff two trees: paths changed (added/modified/deleted) with old/new blob oids. */
  diffTrees(
    repo: Repo,
    oldTree: string | undefined,
    newTree: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'deleted'; oldOid: string | null; newOid: string | null }> {
    const oldFlat = oldTree ? this.flattenTree(repo, oldTree) : new Map<string, { oid: string; mode: string }>();
    const newFlat = this.flattenTree(repo, newTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; oldOid: string | null; newOid: string | null }> = [];
    for (const [path, value] of newFlat) {
      const old = oldFlat.get(path);
      if (!old) out.push({ path, status: 'added', oldOid: null, newOid: value.oid });
      else if (old.oid !== value.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: value.oid });
    }
    for (const [path, value] of oldFlat) {
      if (!newFlat.has(path)) out.push({ path, status: 'deleted', oldOid: value.oid, newOid: null });
    }
    return out;
  }

  /** Files changed between two commits' trees. */
  diffCommits(repo: Repo, oldCommit: string, newCommit: string): ReturnType<Store['diffTrees']> {
    const oldObj = repo.objects.get(oldCommit);
    const newObj = repo.objects.get(newCommit);
    if (!oldObj || !newObj) return [];
    const oldTree = oldObj.type === 'commit' ? parseCommit(oldObj.data).tree : undefined;
    const newTree = newObj.type === 'commit' ? parseCommit(newObj.data).tree : undefined;
    if (!newTree) return [];
    return this.diffTrees(repo, oldTree, newTree);
  }

  /** All objects reachable from a set of oids (throws on missing). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, (oid) => repo.objects.get(oid));
  }
}

/** REST/GraphQL view of a repo. */
export function repoJson(repo: Repo, baseUrl = ''): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: issue.userLogin, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: 0,
  };
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: true,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}