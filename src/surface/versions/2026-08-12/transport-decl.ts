/**
 * The transport keys of this capture (spec §10.5): the JSON guard, the streaming final flag and
 * incremental payload keys, the GraphQL envelope keys and the routing headers.
 */

import type { TransportDecl } from '@/surface/transport/decode';
import type { GraphqlDecl } from '@/surface/transport/graphql';
import { BODY_MIME_PARSEABLE, GRAPHQL_FRIENDLY_NAME_HEADER } from '@/surface/versions/2026-08-12/literals';

export const TRANSPORT: TransportDecl = {
  jsonGuards: ['for (;;);'],
  finalFlagPath: 'extensions.is_final',
  incremental: { path: 'path', data: 'data', items: 'items', list: 'incremental', errors: 'errors' },
  formOpKey: 'fb_api_req_friendly_name',
  rootFieldHeader: 'x-root-field-name',
  friendlyNameHeader: GRAPHQL_FRIENDLY_NAME_HEADER,
  parseableMime: BODY_MIME_PARSEABLE,
};

export const GRAPHQL: GraphqlDecl = {
  errorsKey: 'errors',
  dataKey: 'data',
  /** Throttle text has arrived in `summary` and `description` as well as `message`. */
  errorTextKeys: ['message', 'summary', 'description'],
};
