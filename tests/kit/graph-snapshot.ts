import { GRAPH_NODE_STATUSES, type GraphSnapshot } from '@/types';

/** One known person, with measured followers and a current lifecycle, for renderer tests. */
export const graphSnapshot = (pk = '42', username = 'person'): GraphSnapshot => ({
  at: 1, pks: [pk], usernames: [username], hubs: [], statuses: Uint8Array.from([GRAPH_NODE_STATUSES.indexOf('held')]),
  progress: Float32Array.from([0.5]), hubIndex: Int32Array.from([-1]), followers: Float64Array.from([42]),
  counts: Object.fromEntries(GRAPH_NODE_STATUSES.map((s) => [s, s === 'held' ? 1 : 0])) as GraphSnapshot['counts'],
});
