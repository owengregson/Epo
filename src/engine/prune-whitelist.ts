/** The whitelist predicate lives in `src/shared` (renderer + engine); re-exported here for engine callers. */
export {
  filterPruneCandidates,
  isPruneWhitelisted,
  pruneWhitelistSet,
  type WhitelistSubject,
} from '@/shared/prune-whitelist';
