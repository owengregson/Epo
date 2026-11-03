/**
 * The read pipeline's per-version declarations (spec Appendix D.1): every key, flag, wrapper and
 * signature a surface version is read by. Types only; each capture fills them in `versions/*`.
 */

import type { EndpointKind } from '@/surface/schema/endpoints';

/** The transport keys: the JSON guard, the streaming final flag, incremental payloads, routing headers. */
export interface TransportDecl {
  readonly jsonGuards: readonly string[];
  /** Dotted path of the streaming final flag; `false` on the last payload makes the body partial. */
  readonly finalFlagPath: string | null;
  /** Incremental payload keys: `{path, data}` merges, `{path, items}` appends, `list` wraps parts. */
  readonly incremental: { readonly path: string; readonly data: string; readonly items: string; readonly list: string;
    readonly errors: string };
  /** The form field naming a GraphQL operation (read only with the optional request-field capture). */
  readonly formOpKey: string;
  readonly rootFieldHeader: string;
  readonly friendlyNameHeader: string;
  /** Media types whose 2xx body is data (anything else on an API URL is a wall or not data). */
  readonly parseableMime: RegExp;
}

/** The GraphQL envelope keys. */
export interface GraphqlDecl {
  readonly errorsKey: string;
  readonly dataKey: string;
  readonly errorTextKeys: readonly string[];
}

/** A list's continuation keys. */
export interface ContinuationDecl {
  /** The page's rows key (a connection's nodes are read into it). */
  readonly rowsKey: string;
  readonly cursorKeys: readonly string[];
  readonly moreFlags: readonly string[];
  /** A cursor that is a row offset; anything else is opaque. */
  readonly offsetCursor: RegExp;
  /** Root keys a real page carries that say nothing about continuation (corpus-derived). */
  readonly explainedPageKeys: readonly string[];
  /** Names that mark a cursor-like key inside an unexplained container. */
  readonly cursorName: RegExp;
  /** Names under which `true` reads as "more". */
  readonly moreFlagName: RegExp;
  /** How each list is requested: page by page, or the whole list in one response. */
  readonly composedForm: { readonly followers: 'paged'; readonly following: 'whole-list' };
}

/** The relationship key names every relationship record is read by (by presence). */
export interface RelationshipKeys {
  readonly following: string;
  readonly outgoingRequest: string;
  readonly followedBy: string;
  readonly incomingRequest: string;
}

/** Id keys: the canonical key first, then its aliases; foreign ids are named so they never vote. */
export interface IdDecl {
  readonly idKeys: readonly string[];
  readonly foreignIdKeys: readonly string[];
}

/** A profile's count keys, read as one pair. */
export interface CountKeys {
  readonly followers: string;
  readonly following: string;
  readonly mutuals: string;
}

/** Where a definition's record or page sits: the canonical container first, then declared alternates. */
export interface ContainerDecl {
  /** A dotted path; '' is the body itself. */
  readonly at: string;
  readonly kind: 'object' | 'connection';
  /** A connection's edge list, node, cursor and more-flag, relative to the container. */
  readonly connection?: { readonly edges: string; readonly node: string; readonly cursor: string; readonly hasNext: string };
  /** The container present and `null` is Instagram's own "gone" answer. */
  readonly absentWhenNull?: true;
  /** What the declaration rests on (a capture and its count). */
  readonly evidence: string;
}

/** The keys the field readers and the bounded recovery read by (spec §10.3, §10.6). */
export interface RecoveryDecl extends IdDecl {
  readonly handleKey: string;
  readonly handleRe: RegExp;
  readonly profileCountKeys: CountKeys;
  readonly relationshipKeys: RelationshipKeys;
  /** Containers that hold other accounts (embedded copies, suggestions): never a located record. */
  readonly foreignContainers: Readonly<Partial<Record<EndpointKind, readonly string[]>>>;
  /** Story types as decimal text: identifiers, compared as text. */
  readonly followStoryTypes: readonly string[];
  readonly knownStoryTypes: readonly string[];
  readonly storyActorKey: string;
  readonly storyActorAliases: readonly string[];
  readonly followText: RegExp;
  /** The node key a C2 requester row must carry `true` at (I8). */
  readonly requesterMarker: string;
  /** Operation-name families, in order, for an unrouted GraphQL body. */
  readonly opFamilies: ReadonlyArray<{ readonly kind: EndpointKind; readonly pattern: RegExp }>;
  readonly mutationFamily: RegExp;
}

/** A refusal signature the GraphQL envelope matches error text with. */
export interface SignatureDecl {
  readonly pattern: RegExp;
  readonly status: string;
}

/** Everything one surface version is read by. */
export interface ReadDecls {
  readonly transport: TransportDecl;
  readonly graphql: GraphqlDecl;
  readonly continuation: ContinuationDecl;
  readonly recovery: RecoveryDecl;
  readonly signatures: readonly SignatureDecl[];
  /** Decision-bearing paths present in every real body: an absence is `expected-absent`. */
  readonly expected: Readonly<Partial<Record<EndpointKind, readonly string[]>>>;
  /** Unknown paths already seen in the corpora: never reported as new. */
  readonly novelty: Readonly<Partial<Record<EndpointKind, readonly string[]>>>;
}
