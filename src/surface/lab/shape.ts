/**
 * The SHAPE of a response schema, as a walkable tree.
 *
 * Two jobs need to know "what does this schema know about this path": the
 * NOVELTY pass (a key the schema does not know is the earliest drift signal
 * there is — zod strips unknown keys silently, which hides it) and the fixture
 * SCRUBBER (an allow-list is only safe if it can enumerate the allowed fields
 * and their PII class).
 *
 * Both derive from one source: `z.toJSONSchema()`, which inlines the `.meta()`
 * a field was declared with. That is what makes PII declared WHERE THE FIELD IS
 * DECLARED actually load-bearing rather than documentation.
 */

import { z } from 'zod';
import type { EndpointKind } from '@/surface/schema/endpoints';
import {
  ActivityStory,
  ListPageBody,
  ListUserRow,
  type PiiKind,
  ProfileUser,
  ShowManyStatus,
} from '@/surface/schema/endpoints';

/** One node of a schema's shape. */
export interface ShapeNode {
  /** The PII class declared on this node, when it carries one. */
  pii?: PiiKind;
  /** Known object properties. Absent ⇒ this node is not an object. */
  props?: Map<string, ShapeNode>;
  /** Array element shape. */
  items?: ShapeNode;
  /** Record value shape (`additionalProperties` with a schema). */
  values?: ShapeNode;
  /** PII class of a record's KEYS (pk-keyed maps). */
  keyPii?: PiiKind;
  /** True when the object accepts unknown keys (`.loose()`). */
  open: boolean;
}

type Json = Record<string, unknown>;

const asPii = (v: unknown): PiiKind | undefined =>
  typeof v === 'string' &&
  (v === 'handle' ||
    v === 'name' ||
    v === 'pk' ||
    v === 'url' ||
    v === 'text' ||
    v === 'cursor')
    ? v
    : undefined;

/** Resolve a `$ref` against the document's `$defs` (zod emits them for reuse). */
function deref(node: Json, defs: Json): Json {
  let current = node;
  for (let hop = 0; hop < 8; hop++) {
    const ref = current.$ref;
    if (typeof ref !== 'string') return current;
    const name = ref.replace(/^#\/\$defs\//, '');
    const target = defs[name];
    if (target === undefined || typeof target !== 'object') return current;
    current = target as Json;
  }
  return current;
}

/** Build a {@link ShapeNode} from a JSON-Schema node. */
function nodeOf(raw: Json, defs: Json): ShapeNode {
  const json = deref(raw, defs);
  const out: ShapeNode = { open: false };
  const pii = asPii(json.pii);
  if (pii !== undefined) out.pii = pii;

  // A union merges its branches: the first branch that knows a key wins, and
  // any branch's PII class marks the node (a field is PII if it can BE PII).
  const anyOf = json.anyOf ?? json.oneOf;
  if (Array.isArray(anyOf)) {
    for (const branch of anyOf) {
      if (typeof branch !== 'object' || branch === null) continue;
      const merged = nodeOf(branch as Json, defs);
      out.pii ??= merged.pii;
      out.open ||= merged.open;
      if (merged.props) {
        out.props ??= new Map();
        for (const [k, v] of merged.props) if (!out.props.has(k)) out.props.set(k, v);
      }
      out.items ??= merged.items;
      out.values ??= merged.values;
      out.keyPii ??= merged.keyPii;
    }
    return out;
  }

  const properties = json.properties;
  if (typeof properties === 'object' && properties !== null) {
    out.props = new Map();
    for (const [key, value] of Object.entries(properties as Json)) {
      if (typeof value === 'object' && value !== null) {
        out.props.set(key, nodeOf(value as Json, defs));
      }
    }
  }

  const additional = json.additionalProperties;
  if (typeof additional === 'object' && additional !== null) {
    const inner = additional as Json;
    // `{}` (no constraint) is `.loose()`'s catch-all: unknown keys are ALLOWED
    // through but the schema knows nothing about them, which is exactly what
    // the novelty pass wants to report.
    if (Object.keys(inner).length === 0) out.open = true;
    else out.values = nodeOf(inner, defs);
  }

  const names = json.propertyNames;
  if (typeof names === 'object' && names !== null) {
    out.keyPii = asPii((names as Json).pii);
  }

  const items = json.items;
  if (typeof items === 'object' && items !== null) {
    const inner = items as Json;
    if (Object.keys(inner).length > 0) out.items = nodeOf(inner, defs);
  }

  return out;
}

/** The shape of a zod schema. */
export function shapeOf(schema: z.ZodType): ShapeNode {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
  }) as Json;
  const defs = (json.$defs as Json | undefined) ?? {};
  return nodeOf(json, defs);
}

// ---------------------------------------------------------------------------
// Novelty
// ---------------------------------------------------------------------------

/** How many array elements the novelty pass looks at (the rest repeat). */
const NOVELTY_SAMPLE = 8;

/**
 * Keys present in `value` that `node` does not know, as dotted paths
 * (`users[].groups`). Capped and de-duplicated: a 50-row page with a new field
 * reports it ONCE, not fifty times.
 */
export function novelKeys(value: unknown, node: ShapeNode, prefix = ''): string[] {
  const found = new Set<string>();
  walkNovel(value, node, prefix, found, 0);
  return [...found].sort();
}

function walkNovel(
  value: unknown,
  node: ShapeNode,
  prefix: string,
  found: Set<string>,
  depth: number,
): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (!node.items) return;
    for (const entry of value.slice(0, NOVELTY_SAMPLE)) {
      walkNovel(entry, node.items, `${prefix}[]`, found, depth + 1);
    }
    return;
  }
  const record = value as Json;
  if (node.props === undefined) {
    // A record (pk-keyed map): every VALUE shares one shape, the keys are data.
    if (node.values) {
      for (const entry of Object.values(record).slice(0, NOVELTY_SAMPLE)) {
        walkNovel(entry, node.values, `${prefix}.*`, found, depth + 1);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    const known = node.props.get(key);
    if (known === undefined) {
      found.add(prefix === '' ? key : `${prefix}.${key}`);
      continue;
    }
    walkNovel(child, known, prefix === '' ? key : `${prefix}.${key}`, found, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Scrub shapes — the schemas the SCRUBBER walks
// ---------------------------------------------------------------------------

/**
 * The response schemas describe row containers as `z.array(z.unknown())` /
 * `z.record(…, z.unknown())`, because a malformed row must not reject a whole
 * page (see the version document). The scrubber needs the row shapes to keep
 * a row's known fields, so it walks these faithful twins instead — same fields,
 * containers typed.
 */
const ListPageScrub = z
  .object({
    users: z.array(ListUserRow),
    // A resume cursor is either a ROW OFFSET ("50") or an opaque server token.
    // The offset form is provably non-identity and survives verbatim; the
    // opaque form is an encrypted blob nobody can vouch for, so it is replaced
    // by a synthetic token of the same shape (see `Scrubber.pii('cursor')`).
    next_max_id: z
      .union([z.string(), z.number()])
      .meta({ pii: 'cursor' })
      .nullish(),
    has_more: z.boolean().optional(),
    big_list: z.boolean().optional(),
    page_size: z.number().optional(),
    status: z.string().optional(),
  })
  .loose();

const ShowManyScrub = z
  .object({
    friendship_statuses: z.record(
      z.string().meta({ pii: 'pk' }),
      ShowManyStatus,
    ),
    status: z.string().optional(),
  })
  .loose();

const FriendshipShowScrub = z
  .object({
    following: z.boolean().optional(),
    followed_by: z.boolean().optional(),
    outgoing_request: z.boolean().optional(),
    incoming_request: z.boolean().optional(),
    is_private: z.boolean().optional(),
    status: z.string().optional(),
  })
  .loose();

const ProfileInfoScrub = z
  .object({
    user: ProfileUser.nullable(),
    status: z.string().optional(),
  })
  .loose();

const ProfileGraphqlScrub = z
  .object({
    data: z.object({ user: ProfileUser.nullish() }).loose(),
    status: z.string().optional(),
  })
  .loose();

const ActivityStoriesScrub = z
  .object({
    new_stories: z.array(ActivityStory).optional(),
    old_stories: z.array(ActivityStory).optional(),
  })
  .loose();
/** The REST inbox, or the drawer's GraphQL feed wrapping it (since 2026-11). */
const ActivityFeedScrub = z.union([
  z.object({ data: z.object({ xdt_activity_inbox: ActivityStoriesScrub }).loose() }).loose(),
  ActivityStoriesScrub,
]);
/** `pending/`, or the GraphQL requests panel carrying the same rows as nodes (since 2026-11). */
const FriendRequestsScrub = z.union([
  z.object({ data: z.object({ xdt_friendships_pending_users: z.object({ users: z.object({
    edges: z.array(z.object({ node: ListUserRow }).loose()),
    page_info: z.object({ end_cursor: z.string().meta({ pii: 'cursor' }).nullish() }).loose().optional(),
  }).loose() }).loose() }).loose() }).loose(),
  ListPageScrub,
]);

/** The scrub shape for every endpoint kind. */
export const SCRUB_SHAPES: Record<EndpointKind, z.ZodType> = {
  'followers-list': ListPageScrub,
  'following-list': ListPageScrub,
  'friend-requests': FriendRequestsScrub,
  'show-many': ShowManyScrub,
  'friendship-show': FriendshipShowScrub,
  'profile-info': ProfileInfoScrub,
  'profile-graphql': ProfileGraphqlScrub,
  'activity-feed': ActivityFeedScrub,
};

/** The novelty shape for every endpoint kind (the ACTIVE response schemas' twins). */
export const NOVELTY_SHAPES: Record<EndpointKind, z.ZodType> = SCRUB_SHAPES;

/** `ListPageBody` re-exported so the replay test can name the envelope it checks. */
export { ListPageBody };
