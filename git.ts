// git.ts — git smart HTTP: info/refs (v0/v2 advertisement), ls-refs, fetch (v0/v2),
// receive-pack (push). Plain packs only on the wire out (no deltas); incoming packs
// may carry deltas and are resolved. No git binary anywhere.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
  type Packet,
} from './gitpack.ts';
import { FIXED_EPOCH, type Repo, type Store } from './store.ts';

const AGENT = 'makefun-git-forge/1.0';
const UPLOAD_CAPS_V0 =
  'symref=HEAD:refs/heads/main multi_ack_detailed thin-pack side-band-64k ofs-delta shallow agent=' + AGENT;
const RECEIVE_CAPS =
  'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=' + AGENT;

export interface GitRequest {
  method: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

/** Ref lines for a v0 advertisement: HEAD first (carrying caps), then refs, then peeled tags. */
function v0RefLines(repo: Repo, caps: string): string[] {
  const lines: string[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  lines.push(`${headOid} HEAD\0${caps}\n`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = parseTag(object.data).object;
      lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [
    encodePktLine(`# service=${service}\n`),
    pktFlush(),
    ...v0RefLines(repo, caps).map((line) => encodePktLine(line)),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function advertisementV2(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    pktFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter\n'),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

/** GET /<owner>/<repo>.git/info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, req: GitRequest): GitResponse {
  const service = req.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    return ok(contentType, advertisementV2(repo));
  }
  return ok(contentType, advertisementV0(repo, service));
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArg {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: Packet[]): LsRefsArg {
  const args: LsRefsArg = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line.startsWith('command=')) continue;
    if (line.startsWith('agent=')) continue;
    if (line.startsWith('object-format=')) continue;
    if (line === 'peel\n') args.peel = true;
    else if (line === 'symrefs\n') args.symrefs = true;
    else if (line === 'unborn\n') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length).trimEnd());
  }
  return args;
}

function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const args = parseLsRefsArgs(packets);
  const lines: string[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const peeledOf = (oid: string): string | undefined => {
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') return parseTag(object.data).object;
    return undefined;
  };
  if (keep('HEAD')) {
    if (headOid === ZERO_OID) {
      if (args.unborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    } else {
      lines.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (args.symrefs && name === `refs/heads/${repo.defaultBranch}`) {
      // HEAD already carries the symref; nothing extra per ref.
    }
    if (args.peel) {
      const peeled = peeledOf(oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return encodePktLines([...lines, 'flush' as const]);
}

// ---------------------------------------------------------------- fetch computation

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
}

function parseFetchArgsV2(packets: Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line.startsWith('command=')) continue;
    if (line.startsWith('agent=')) continue;
    if (line.startsWith('object-format=')) continue;
    if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress' || line === 'ofs-delta') continue;
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') continue;
  }
  args.wants = [...new Set(args.wants)];
  return args;
}

function parseFetchArgsV0(packets: Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim().split(/\s+/);
        args.wants.push(rest[0]);
        if (rest.includes('thin-pack')) args.thinPack = true;
      } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    }
  }
  args.wants = [...new Set(args.wants)];
  return args;
}

/** Closure of commits/objects from `roots`, stopping parent traversal at boundary
 *  commits (their own tree/blobs are included, their parents are not). */
function closureWithBoundaries(
  repo: Repo,
  roots: Iterable<string>,
  boundaries: ReadonlySet<string>,
): { commits: Set<string>; objects: Set<string> } {
  const commits = new Set<string>();
  const objects = new Set<string>();
  const queue: string[] = [];
  const peel = (oid: string): string | undefined => {
    const object = repo.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') return peel(parseTag(object.data).object);
    return undefined;
  };
  for (const root of roots) {
    const commit = peel(root);
    if (commit) queue.push(commit);
    else if (repo.objects.has(root)) objects.add(root);
  }
  const addTree = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (objects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') continue;
      objects.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  };
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (commits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    commits.add(oid);
    objects.add(oid);
    addTree(parseCommit(object.data).tree);
    if (!boundaries.has(oid)) {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return { commits, objects };
}

/** Commits reachable from `roots` within `depth` generations (roots = generation 1).
 *  Returns the commits per generation. Tags are peeled to their commit. */
function commitsWithinDepth(
  repo: Repo,
  roots: Iterable<string>,
  depth: number | null,
): Map<number, Set<string>> {
  const byGeneration = new Map<number, Set<string>>();
  const peel = (oid: string): string | undefined => {
    const object = repo.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') return peel(parseTag(object.data).object);
    return undefined;
  };
  const seen = new Set<string>();
  let frontier: string[] = [];
  for (const root of roots) {
    const commit = peel(root);
    if (commit && !seen.has(commit)) {
      seen.add(commit);
      frontier.push(commit);
    }
  }
  let generation = 1;
  while (frontier.length > 0 && (depth === null || generation <= depth)) {
    byGeneration.set(generation, new Set(frontier));
    if (depth !== null && generation >= depth) break;
    const next: string[] = [];
    for (const oid of frontier) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent) && repo.objects.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
    generation += 1;
  }
  return byGeneration;
}

export interface FetchPlan {
  /** Objects to send (ordered for pack emission). */
  objects: GitObject[];
  /** New shallow boundary oids. */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
  /** Whether every want resolved to an object the server holds. */
  allWantsKnown: boolean;
}

export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const boundarySet = new Set(args.shallow);
  const held = closureWithBoundaries(repo, args.haves, boundarySet);
  const byGeneration = commitsWithinDepth(repo, args.wants, args.depth);
  const wantCommits = new Set<string>();
  for (const set of byGeneration.values()) for (const oid of set) wantCommits.add(oid);
  const sendCommits = new Set<string>();
  for (const oid of wantCommits) if (!held.commits.has(oid)) sendCommits.add(oid);
  // The send closure must contain exactly the send set: closureWithBoundaries
  // includes a boundary commit (with its tree) while not walking its parents,
  // so the boundary here is the send set itself — a parent outside it is never
  // visited, which is what makes a depth-1 fetch send the tip only.
  const sendClosure = closureWithBoundaries(repo, sendCommits, sendCommits);
  const sendObjects = new Set<string>();
  for (const oid of sendClosure.objects) if (!held.objects.has(oid)) sendObjects.add(oid);
  // Wanted tag objects themselves must travel (their target commit is already in the closure).
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag' && !held.objects.has(want)) sendObjects.add(want);
  }
  // Emit commits first (generation order), then trees, then blobs/tags — deterministic.
  const ordered: GitObject[] = [];
  const emitted = new Set<string>();
  const emit = (oid: string): void => {
    if (!sendObjects.has(oid) || emitted.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    emitted.add(oid);
    ordered.push(object);
  };
  const generations = [...byGeneration.keys()].sort((a, b) => a - b);
  for (const gen of generations) {
    for (const oid of byGeneration.get(gen) as Set<string>) emit(oid);
  }
  // Trees and blobs reachable from the sent commits, in traversal order.
  const queue: string[] = [...sendCommits];
  const seenTree = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const tree = parseCommit(object.data).tree;
    const stack: string[] = [tree];
    while (stack.length > 0) {
      const treeOid = stack.pop() as string;
      if (seenTree.has(treeOid)) continue;
      seenTree.add(treeOid);
      emit(treeOid);
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') continue;
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else emit(entry.oid);
      }
    }
  }
  // Any remaining send objects (e.g. tag objects for wanted tags).
  for (const oid of sendObjects) emit(oid);

  // Shallow bookkeeping.
  const heldAfter = new Set<string>([...held.commits, ...sendCommits]);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    const deepest = byGeneration.get(args.depth);
    if (deepest) for (const oid of deepest) if (sendCommits.has(oid)) shallow.push(oid);
  }
  for (const boundary of args.shallow) {
    const object = repo.objects.get(boundary);
    let parent: string | undefined;
    if (object && object.type === 'commit') parent = parseCommit(object.data).parents[0];
    if (parent !== undefined && heldAfter.has(parent)) {
      if (!unshallow.includes(boundary)) unshallow.push(boundary);
    } else if (!shallow.includes(boundary)) {
      shallow.push(boundary);
    }
  }
  const allWantsKnown = args.wants.every((oid) => repo.objects.has(oid));
  return { objects: ordered, shallow, unshallow, allWantsKnown };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(encodePktLine(Buffer.from([1])));
  return out;
}

function buildPackForPlan(store: Store, repo: Repo, args: FetchArgs, plan: FetchPlan): Buffer {
  const keyParts = [
    store.key(repo.owner, repo.name),
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    String(args.depth),
  ];
  const key = keyParts.join('|');
  const cached = store.packCache.get(key);
  if (cached) return cached;
  const pack = writePack(plan.objects);
  store.packCache.set(key, pack);
  return pack;
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = buildPackForPlan(store, repo, args, plan);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (args.haves.length > 0) {
    parts.push(encodePktLine(`ACK ${args.haves[0]}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktFlush());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  const wantedRefs: string[] = [];
  for (const want of args.wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedRefs.push(`${want} ${name}\n`);
    }
  }
  if (wantedRefs.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(encodePktLine(line));
    parts.push(pktFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = buildPackForPlan(store, repo, args, plan);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (args.haves.length > 0) parts.push(encodePktLine(`ACK ${args.haves[0]}\n`));
  else parts.push(encodePktLine('NAK\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** POST /<owner>/<repo>.git/git-upload-pack */
export function handleUploadPack(store: Store, owner: string, repoName: string, req: GitRequest): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const isV2 = req.headers['git-protocol'] === 'version=2';
  const { packets } = decodePktLines(req.body);
  const first = packets.find((p) => p.kind === 'data');
  const firstLine = first ? first.payload.toString('utf8') : '';
  if (firstLine.startsWith('command=ls-refs')) {
    return ok('application/x-git-upload-pack-result', handleLsRefs(repo, req.body));
  }
  const args = isV2 ? parseFetchArgsV2(packets) : parseFetchArgsV0(packets);
  if (args.wants.length === 0) {
    // No wants: an empty pack in band 1 (a packfile section with zero packets is a client error).
    const emptyPack = writePack([]);
    return ok(
      'application/x-git-upload-pack-result',
      isV2
        ? Buffer.concat([
            encodePktLines(['acknowledgments\n', 'NAK\n', 'flush' as const, 'packfile\n']),
            ...sidebandPackets(emptyPack),
            pktFlush(),
          ])
        : Buffer.concat([encodePktLines(['NAK\n']), ...sidebandPackets(emptyPack), pktFlush()]),
    );
  }
  const body = isV2 ? fetchResponseV2(store, repo, args) : fetchResponseV0(store, repo, args);
  return ok('application/x-git-upload-pack-result', body);
}

// ---------------------------------------------------------------- receive-pack (push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /<owner>/<repo>.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, req: GitRequest): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const { packets, rest } = decodePktLines(req.body, { stopAtRaw: true });
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1).trim();
      if (caps.split(/\s+/).includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line.trimEnd());
    if (!match) continue;
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  // A new tip object must exist after unpack (unless this is a delete).
  if (unpackOk) {
    for (const command of commands) {
      if (command.newOid !== ZERO_OID && !repo.objects.has(command.newOid)) {
        unpackOk = false;
        unpackDetail = `object ${command.newOid} is missing`;
        break;
      }
    }
  }

  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        reportLines.push(`ng ${command.ref} invalid command\n`);
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reportLines.push(`ng ${command.ref} no such ref\n`);
        else if (command.oldOid !== current) reportLines.push(`ng ${command.ref} old oid mismatch\n`);
        else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reportLines.push(`ng ${command.ref} already exists\n`);
        else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
      } else {
        // Update: must fast-forward from the current tip.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} no such ref\n`);
        } else if (command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else if (!isAncestorOf(repo, current, command.newOid)) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
      }
    }
    store.invalidatePackCache(repo);
  } else {
    for (const command of commands) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
    }
  }

  const report = encodePktLines([
    `unpack ${unpackOk ? 'ok' : unpackDetail}\n`,
    ...reportLines,
  ]);
  let body: Buffer;
  if (sideband) {
    const banded = encodePktLine(Buffer.concat([Buffer.from([1]), report]));
    body = Buffer.concat([banded, pktFlush()]);
  } else {
    body = Buffer.concat([report, pktFlush()]);
  }
  return ok('application/x-git-receive-pack-result', body);
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
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

export { FIXED_EPOCH };
export type { GitObject };
export { hashObject };
