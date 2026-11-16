// graphql.ts — GitHub GraphQL v4 at POST /api/graphql: a small hand-written parser +
// executor for exactly the documents gh and github-mcp-server send (plus introspection
// __type). No GraphQL library; Node 22 stdlib only.

import { FIXED_ISO, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { squashMerge } from './rest.ts';

// ---------------------------------------------------------------- global ids

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`).toString('base64');
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64');
}
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64');
}
export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return Buffer.from(`IssueComment:${repo.id}:${issueNumber}:${commentId}`).toString('base64');
}

type DecodedId =
  | { kind: 'Repository'; repoDbId: number }
  | { kind: 'Issue'; repoDbId: number; number: number }
  | { kind: 'PullRequest'; repoDbId: number; number: number }
  | { kind: 'IssueComment'; repoDbId: number; issueNumber: number; commentId: number }
  | null;

export function decodeGlobalId(id: string): DecodedId {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'Repository' && parts.length === 2) return { kind: 'Repository', repoDbId: Number(parts[1]) };
    if (parts[0] === 'Issue' && parts.length === 3) return { kind: 'Issue', repoDbId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'PullRequest' && parts.length === 3) return { kind: 'PullRequest', repoDbId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'IssueComment' && parts.length === 4) {
      return { kind: 'IssueComment', repoDbId: Number(parts[1]), issueNumber: Number(parts[2]), commentId: Number(parts[3]) };
    }
    return null;
  } catch {
    return null;
  }
}

function findRepoByDbId(store: Store, dbId: number): Repo | undefined {
  for (const repo of store.repoOrder) if (repo.id === dbId) return repo;
  return undefined;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface SelectionNode {
  kind: 'field' | 'fragment';
  name?: string;
  alias?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
  typeCondition?: string;
}

export interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variableDefinitions: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  fragments = new Map<string, FragmentDef>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''} in GraphQL document`);
    }
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        this.fragments.set(name, { typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek() as Token;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next && next.kind === 'name') name = this.next().value;
    } else if (token.kind === 'punct' && token.value === '{') {
      operation = 'query';
    } else {
      throw new Error('expected query or mutation in GraphQL document');
    }
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selections };
  }

  parseType(): string {
    let type = '';
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        const fragment = this.fragments.get(name);
        if (!fragment) throw new Error(`unknown fragment ${name}`);
        return { kind: 'fragment', typeCondition: fragment.typeCondition, selections: fragment.selections };
      }
      throw new Error('bad fragment spread in GraphQL document');
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
      this.next();
      args = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (e.g. @include) are accepted and ignored.
    while (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

type GqlValue = unknown;

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = ctx.variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsMap(selection: SelectionNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.args ?? []) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

interface NodeObject {
  __type: string;
  [key: string]: unknown;
}

function repoNode(repo: Repo): NodeObject {
  return { __type: 'Repository', repo };
}
function issueNode(repo: Repo, issue: Issue): NodeObject {
  return { __type: 'Issue', repo, issue };
}
function pullNode(repo: Repo, pull: Pull): NodeObject {
  return { __type: 'PullRequest', repo, pull };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function executeSelections(parent: NodeObject, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> | null {
  return executeSelectionsWithPayloads(parent, selections, ctx);
}

// (Kept for readability: the plain name above delegates to the payload-aware
// executor, which also handles IssueCommentEdge / IssueComment nodes.)

function resolveField(parent: NodeObject, field: string, selection: SelectionNode, ctx: Ctx): GqlValue {
  if (field === '__typename') return parent.__type;
  if (field === '__type') {
    const args = argsMap(selection, ctx);
    const name = String(args.name ?? '');
    const fields = TYPE_FIELDS[name];
    const enumValues = ENUM_VALUES[name];
    const node: NodeObject = {
      __type: '__Type',
      _introspectionName: name,
      _introspectionFields: fields ?? null,
      _introspectionEnum: enumValues ?? null,
    };
    return selection.selections ? executeSelections(node, selection.selections, ctx) : node;
  }

  const type = parent.__type;
  const knownFields: Readonly<Record<string, readonly string[]>> = {
    Query: ['viewer', 'repository', 'node', '__type'],
    User: ['login'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    Issue: ['id', 'number', 'title', 'state', 'body'],
    IssueConnection: ['nodes', 'pageInfo'],
    PageInfo: ['hasNextPage', 'endCursor'],
    PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
    PullRequestConnection: ['nodes'],
    PullRequestChangedFileConnection: ['nodes'],
    PullRequestChangedFile: ['path'],
    __Type: ['fields', 'enumValues'],
    __Field: ['name'],
    __EnumValue: ['name'],
  };
  if (type === '__Type') {
    if (field === 'fields') {
      const list = (parent as unknown as { _introspectionFields: readonly string[] | null })._introspectionFields;
      if (!list) return null;
      return list.map((name) => ({ __type: '__Field', name }));
    }
    if (field === 'enumValues') {
      const list = (parent as unknown as { _introspectionEnum: readonly string[] | null })._introspectionEnum;
      if (!list) return null;
      return list.map((name) => ({ __type: '__EnumValue', name }));
    }
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (field === 'name') return (parent as unknown as { name: string }).name;
  }

  const known = knownFields[type];
  if (known && !known.includes(field)) {
    ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
    return undefined;
  }

  if (type === 'Query') return resolveQueryField(parent, field, selection, ctx);
  if (type === 'User') {
    if (field === 'login') return (parent as unknown as { login: string }).login;
  }
  if (type === 'Repository') return resolveRepositoryField(parent, field, selection, ctx);
  if (type === 'Issue') return resolveIssueField(parent, field, selection, ctx);
  if (type === 'IssueConnection') return resolveIssueConnectionField(parent, field, selection, ctx);
  if (type === 'PageInfo') {
    if (field === 'hasNextPage') return (parent as unknown as { hasNextPage: boolean }).hasNextPage;
    if (field === 'endCursor') return (parent as unknown as { endCursor: string | null }).endCursor;
  }
  if (type === 'PullRequest') return resolvePullField(parent, field, selection, ctx);
  if (type === 'PullRequestConnection') {
    if (field === 'nodes') {
      const nodes = (parent as unknown as { nodes: NodeObject[] }).nodes;
      if (!selection.selections) return nodes;
      return nodes.map((node) => executeSelections(node, selection.selections as SelectionNode[], ctx));
    }
  }
  if (type === 'PullRequestChangedFileConnection') {
    if (field === 'nodes') {
      const nodes = (parent as unknown as { nodes: NodeObject[] }).nodes;
      if (!selection.selections) return nodes;
      return nodes.map((node) => executeSelections(node, selection.selections as SelectionNode[], ctx));
    }
  }
  if (type === 'PullRequestChangedFile') {
    if (field === 'path') return (parent as unknown as { path: string }).path;
  }
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
  return undefined;
}

function resolveQueryField(parent: NodeObject, field: string, selection: SelectionNode, ctx: Ctx): GqlValue {
  void parent;
  if (field === 'viewer') {
    const user: NodeObject = { __type: 'User', login: VIEWER_LOGIN };
    return selection.selections ? executeSelections(user, selection.selections, ctx) : user;
  }
  if (field === 'repository') {
    const args = argsMap(selection, ctx);
    const owner = String(args.owner ?? '');
    const name = String(args.name ?? '');
    const repo = owner === VIEWER_LOGIN ? ctx.store.getRepo(owner, name) : undefined;
    if (!repo) return null;
    const node = repoNode(repo);
    return selection.selections ? executeSelections(node, selection.selections, ctx) : node;
  }
  if (field === 'node') {
    const args = argsMap(selection, ctx);
    const decoded = decodeGlobalId(String(args.id ?? ''));
    if (!decoded) return null;
    if (decoded.kind === 'Repository') {
      const repo = findRepoByDbId(ctx.store, decoded.repoDbId);
      if (!repo) return null;
      const node = repoNode(repo);
      return selection.selections ? executeSelections(node, selection.selections, ctx) : node;
    }
    return null;
  }
  ctx.errors.push({ message: `Cannot query field "${field}" on type "Query".` });
  return undefined;
}

function resolveRepositoryField(parent: NodeObject, field: string, selection: SelectionNode, ctx: Ctx): GqlValue {
  const repo = (parent as unknown as { repo: Repo }).repo;
  switch (field) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner': {
      const user: NodeObject = { __type: 'User', login: repo.owner };
      return selection.selections ? executeSelections(user, selection.selections, ctx) : user;
    }
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      const ref: NodeObject = { __type: 'Ref', name: repo.defaultBranch };
      if (!selection.selections) return ref;
      const out: Record<string, unknown> = {};
      for (const sub of selection.selections) {
        if (sub.kind === 'field' && sub.name === 'name') out[sub.alias ?? 'name'] = repo.defaultBranch;
      }
      return out;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const args = argsMap(selection, ctx);
      const number = Number(args.number);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return null;
      const node = issueNode(repo, issue);
      return selection.selections ? executeSelections(node, selection.selections, ctx) : node;
    }
    case 'issues': {
      const args = argsMap(selection, ctx);
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy && orderBy.field === 'CREATED_AT') {
        list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      } else {
        list.sort((a, b) => a.seq - b.seq);
      }
      // Cursor pagination: `after` is base64("cursor:<number>").
      let startIndex = 0;
      if (typeof args.after === 'string' && args.after) {
        try {
          const text = Buffer.from(args.after, 'base64').toString('utf8');
          const match = /^cursor:(\d+)$/.exec(text);
          if (match) {
            const afterNumber = Number(match[1]);
            const index = list.findIndex((i) => i.number === afterNumber);
            if (index >= 0) startIndex = index + 1;
          }
        } catch {
          // Ignore a bad cursor.
        }
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(startIndex, startIndex + first);
      const hasNextPage = startIndex + first < list.length;
      const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1].number}`).toString('base64') : null;
      const connection: NodeObject = {
        __type: 'IssueConnection',
        _nodes: page.map((i) => issueNode(repo, i)),
        _hasNextPage: hasNextPage,
        _endCursor: endCursor,
      };
      return selection.selections ? executeSelections(connection, selection.selections, ctx) : connection;
    }
    case 'pullRequests': {
      const args = argsMap(selection, ctx);
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const nodes = repo.pulls.slice(0, first).map((p) => pullNode(repo, p));
      const connection: NodeObject = { __type: 'PullRequestConnection', nodes };
      return selection.selections ? executeSelections(connection, selection.selections, ctx) : connection;
    }
    case 'pullRequest': {
      const args = argsMap(selection, ctx);
      const number = Number(args.number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return null;
      const node = pullNode(repo, pull);
      return selection.selections ? executeSelections(node, selection.selections, ctx) : node;
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field}" on type "Repository".` });
      return undefined;
  }
}

function resolveIssueField(parent: NodeObject, field: string, selection: SelectionNode, ctx: Ctx): GqlValue {
  void selection;
  void ctx;
  const { repo, issue } = parent as unknown as { repo: Repo; issue: Issue };
  switch (field) {
    case 'id':
      return issueGlobalId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issueState(issue);
    case 'body':
      return issue.body;
    default:
      return undefined;
  }
}

function resolveIssueConnectionField(parent: NodeObject, field: string, selection: SelectionNode, ctx: Ctx): GqlValue {
  const nodes = (parent as unknown as { _nodes: NodeObject[] })._nodes;
  if (field === 'nodes') {
    if (!selection.selections) return nodes;
    return nodes.map((node) => executeSelections(node, selection.selections as SelectionNode[], ctx));
  }
  if (field === 'pageInfo') {
    const pageInfo: NodeObject = {
      __type: 'PageInfo',
      hasNextPage: (parent as unknown as { _hasNextPage: boolean })._hasNextPage,
      endCursor: (parent as unknown as { _endCursor: string | null })._endCursor,
    };
    return selection.selections ? executeSelections(pageInfo, selection.selections, ctx) : pageInfo;
  }
  return undefined;
}

function resolvePullField(parent: NodeObject, field: string, selection: SelectionNode, ctx: Ctx): GqlValue {
  const { repo, pull } = parent as unknown as { repo: Repo; pull: Pull };
  switch (field) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'state':
      return pullState(pull);
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable': {
      // Honest best effort: MERGEABLE when the head can merge cleanly onto the
      // CURRENT base tip (another PR may have advanced it since the PR opened).
      const baseTip = ctx.store.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
      const base = ctx.store.mergeBase(repo, baseTip, pull.headSha);
      if (!base) return 'UNKNOWN';
      const headChanges = ctx.store.diffCommits(repo, base, pull.headSha);
      const baseChanges = ctx.store.diffCommits(repo, base, baseTip);
      const baseChanged = new Map<string, string | null>();
      for (const change of baseChanges) baseChanged.set(change.path, change.newOid);
      for (const change of headChanges) {
        if (baseChanged.has(change.path) && baseChanged.get(change.path) !== change.newOid) return 'CONFLICTING';
      }
      return 'MERGEABLE';
    }
    case 'files': {
      const args = argsMap(selection, ctx);
      const first = typeof args.first === 'number' ? args.first : 100;
      const base = ctx.store.mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
      const changes = ctx.store.diffCommits(repo, base, pull.headSha);
      const nodes = changes.slice(0, first).map((change) => ({ __type: 'PullRequestChangedFile', path: change.path }) as NodeObject);
      const connection: NodeObject = { __type: 'PullRequestChangedFileConnection', nodes };
      return selection.selections ? executeSelections(connection, selection.selections, ctx) : connection;
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field}" on type "PullRequest".` });
      return undefined;
  }
}

// ---------------------------------------------------------------- mutations

function executeMutation(operation: OperationNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.name as string;
    const key = selection.alias ?? field;
    const args = argsMap(selection, ctx);
    const value = runMutation(field, args, selection, ctx);
    out[key] = value;
  }
  return out;
}

function runMutation(
  field: string,
  args: Record<string, unknown>,
  selection: SelectionNode,
  ctx: Ctx,
): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const store = ctx.store;
  if (field === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository') {
      ctx.errors.push({ message: 'createIssue: unknown repository' });
      return null;
    }
    const repo = findRepoByDbId(store, decoded.repoDbId);
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: unknown repository' });
      return null;
    }
    const issue: Issue = {
      id: store.nextIssueId++,
      number: repo.nextIssue++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      userLogin: VIEWER_LOGIN,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      seq: repo.issues.length,
    };
    repo.issues.push(issue);
    const payload: NodeObject = { __type: 'CreateIssuePayload', _issue: issueNode(repo, issue) };
    return selection.selections ? executeSelections(payload, selection.selections, ctx) : payload;
  }
  if (field === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'Issue') {
      ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return null;
    }
    const repo = findRepoByDbId(store, decoded.repoDbId);
    const issue = repo?.issues.find((i) => i.number === decoded.number);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: unknown issue' });
      return null;
    }
    issue.state = 'closed';
    issue.updatedAt = FIXED_ISO;
    const payload: NodeObject = { __type: 'CloseIssuePayload', _issue: issueNode(repo, issue) };
    return selection.selections ? executeSelections(payload, selection.selections, ctx) : payload;
  }
  if (field === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository') {
      ctx.errors.push({ message: 'createPullRequest: unknown repository' });
      return null;
    }
    const repo = findRepoByDbId(store, decoded.repoDbId);
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: unknown repository' });
      return null;
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = store.resolveRef(repo, headRef);
    const baseSha = store.resolveRef(repo, baseRef);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    const pull: Pull = {
      id: store.nextPullId++,
      number: repo.nextPull++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: repo.pulls.length,
    };
    repo.pulls.push(pull);
    const payload: NodeObject = { __type: 'CreatePullRequestPayload', _pull: pullNode(repo, pull) };
    return selection.selections ? executeSelections(payload, selection.selections, ctx) : payload;
  }
  if (field === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'PullRequest') {
      ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return null;
    }
    const repo = findRepoByDbId(store, decoded.repoDbId);
    const pull = repo?.pulls.find((p) => p.number === decoded.number);
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return null;
    }
    if (!pull.merged) {
      const mergeSha = squashMerge(store, repo, pull);
      if (mergeSha === null) {
        ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = FIXED_ISO;
      pull.mergeCommitSha = mergeSha;
      pull.baseSha = mergeSha;
    }
    const payload: NodeObject = { __type: 'MergePullRequestPayload', _pull: pullNode(repo, pull) };
    return selection.selections ? executeSelections(payload, selection.selections, ctx) : payload;
  }
  if (field === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'Issue') {
      ctx.errors.push({ message: 'addComment: unknown subject' });
      return null;
    }
    const repo = findRepoByDbId(store, decoded.repoDbId);
    const issue = repo?.issues.find((i) => i.number === decoded.number);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'addComment: unknown subject' });
      return null;
    }
    const comment = {
      id: repo.nextCommentId++,
      body: String(input.body ?? ''),
      userLogin: VIEWER_LOGIN,
      createdAt: FIXED_ISO,
    };
    const list = repo.comments.get(issue.number) ?? [];
    list.push(comment);
    repo.comments.set(issue.number, list);
    const node: NodeObject = {
      __type: 'IssueComment',
      id: commentGlobalId(repo, issue.number, comment.id),
      body: comment.body,
    };
    const edge: NodeObject = { __type: 'IssueCommentEdge', node };
    const payload: NodeObject = { __type: 'AddCommentPayload', _edge: edge };
    return selection.selections ? executeSelections(payload, selection.selections, ctx) : payload;
  }
  ctx.errors.push({ message: `Unknown mutation "${field}".` });
  return null;
}

// Payload field resolution: the payload objects carry _issue/_pull/_edge.
const PAYLOAD_FIELDS: Readonly<Record<string, string>> = {
  CreateIssuePayload: '_issue',
  CloseIssuePayload: '_issue',
  CreatePullRequestPayload: '_pull',
  MergePullRequestPayload: '_pull',
  AddCommentPayload: '_edge',
};

// ---------------------------------------------------------------- entry point

export interface GraphqlRequest {
  body: Buffer;
  variables?: Record<string, unknown>;
}

function executeOne(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, errors: [] };
  let operations: OperationNode[];
  try {
    const parser = new Parser(tokenize(query));
    operations = parser.parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  let operation = operations[0];
  if (operations.length > 1 || operationName) {
    const named = operations.find((op) => op.name === operationName);
    if (named) operation = named;
    else if (operations.length > 1 && !operationName) {
      return { data: null, errors: [{ message: 'multiple operations: operationName is required' }] };
    }
  }
  if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
  // Apply variable defaults.
  for (const def of operation.variableDefinitions) {
    if (ctx.variables[def.name] === undefined && def.defaultValue !== undefined) {
      ctx.variables[def.name] = resolveValue(def.defaultValue, ctx);
    }
  }
  if (operation.operation === 'mutation') {
    const data = executeMutation(operation, ctx);
    return { data, errors: ctx.errors };
  }
  // Query root: resolve payload wrappers first.
  const root: NodeObject = { __type: 'Query' };
  // Payload objects (_issue/_pull/_edge) need field resolution via their inner node.
  const data = executeSelectionsWithPayloads(root, operation.selections, ctx);
  return { data, errors: ctx.errors };
}

function executeSelectionsWithPayloads(parent: NodeObject, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> | null {
  // Intercept payload field access: a payload node resolves its inner object field.
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== parent.__type) continue;
      const sub = executeSelectionsWithPayloads(parent, selection.selections ?? [], ctx);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const fieldName = selection.name as string;
    const key = selection.alias ?? fieldName;
    // Payload wrapper: field names are `issue`, `pullRequest`, `commentEdge`.
    const innerKey = PAYLOAD_FIELDS[parent.__type];
    if (innerKey) {
      const inner = (parent as unknown as Record<string, NodeObject>)[innerKey];
      if (!inner) {
        out[key] = null;
        continue;
      }
      if (fieldName === 'issue' || fieldName === 'pullRequest') {
        out[key] = selection.selections ? executeSelections(inner, selection.selections, ctx) : inner;
        continue;
      }
      if (fieldName === 'commentEdge') {
        out[key] = selection.selections ? executeSelections(inner, selection.selections, ctx) : inner;
        continue;
      }
    }
    if (parent.__type === 'IssueCommentEdge' && fieldName === 'node') {
      const node = (parent as unknown as { node: NodeObject }).node;
      out[key] = selection.selections ? executeSelections(node, selection.selections, ctx) : node;
      continue;
    }
    if (parent.__type === 'IssueComment') {
      if (fieldName === 'id') {
        out[key] = (parent as unknown as { id: string }).id;
        continue;
      }
      if (fieldName === 'body') {
        out[key] = (parent as unknown as { body: string }).body;
        continue;
      }
    }
    const value = resolveField(parent, fieldName, selection, ctx);
    if (value === undefined && ctx.errors.length > 0) continue;
    out[key] = value;
  }
  return out;
}

export function handleGraphql(store: Store, body: Buffer): { status: number; body: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: Buffer.from('{"errors":[{"message":"body is not valid JSON"}]}\n', 'utf8') };
  }
  const run = (entry: Record<string, unknown>): { data: unknown; errors: Array<{ message: string }> } => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const variables = (entry.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return executeOne(store, query, variables, operationName);
  };
  let result: unknown;
  if (Array.isArray(parsed)) {
    result = parsed.map((entry) => run(asObject(entry)));
  } else if (typeof parsed === 'object' && parsed !== null) {
    result = run(parsed as Record<string, unknown>);
  } else {
    return { status: 400, body: Buffer.from('{"errors":[{"message":"body must be a JSON object"}]}\n', 'utf8') };
  }
  return { status: 200, body: Buffer.from(`${JSON.stringify(result)}\n`, 'utf8') };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
