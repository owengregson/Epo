import { Fragment, type JSX } from 'preact';
import { legendColor, STATUS_GLYPHS } from '@/renderer/graph/palette';
import { commas, withAt } from '@/renderer/lib/format';
import { Badge } from '@/renderer/ui/Badge';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { Icon } from '@/renderer/ui/Icon';
import type { ChainTargetDetail, GraphNodeStatus } from '@/types';

export interface TargetFunnelCardProps {
  detail: ChainTargetDetail | null;
  /** True when Epo explores this source now. */
  current: boolean;
}

/** One row: where people from this source are now, in the graph's colours. */
interface FunnelRow {
  status: GraphNodeStatus;
  label: string;
  n: number;
  hazard?: boolean;
}

/**
 * Funnel-local fill overrides — colours tuned for the card's track, not the
 * canvas ground: the spent-graphite `unfollowed` reads as a dot on the canvas
 * but vanishes as a 3 px fill, so the funnel lifts its lightness.
 */
const FUNNEL_COLOR_OVERRIDES: Partial<Record<GraphNodeStatus, string>> = {
  unfollowed: 'hsl(240 6% 37%)',
};

function funnelColor(status: GraphNodeStatus): string {
  return FUNNEL_COLOR_OVERRIDES[status] ?? legendColor(status);
}

/** The source's state in one badge (a source with no follows says so). */
function statusBadge(detail: ChainTargetDetail, current: boolean): JSX.Element {
  const step = (detail.chainIndex ?? 0) + 1;
  if (current) return <Badge tone="live">Exploring now · Step {step}</Badge>;
  if (detail.status === 'exhausted') {
    return <Badge>{detail.yield.total === 0 ? 'Explored · no one new to follow' : 'Explored'}</Badge>;
  }
  if (detail.status === 'retired') return <Badge>Set aside when you restarted</Badge>;
  if (detail.status === 'retained') return <Badge>Kept</Badge>;
  return <Badge>Step {step}</Badge>;
}

/**
 * Where the people found through one source are now, one row per lifecycle
 * state, in the words the lanes use and the graph's colours. "People found" is
 * the crowd the rows draw from, shown above them and kept out of the bar scale
 * so the stage bars stay legible. Two rare rows appear only when non-zero: people
 * Epo stopped trying after repeated errors (red, with why), and people you
 * changed yourself. Counts move during walks — the page re-reads on every chain
 * push (docs/PRINCIPLES.md §2).
 */
export function TargetFunnelCard({ detail, current }: TargetFunnelCardProps): JSX.Element {
  const rows: FunnelRow[] =
    detail === null
      ? []
      : [
          { status: 'queued', label: 'Up next', n: detail.funnel.queued },
          { status: 'waiting', label: 'Waiting', n: detail.funnel.pending_followback },
          { status: 'held', label: 'Following back', n: detail.funnel.followed_back },
          { status: 'unfollow_queued', label: 'Leaving soon', n: detail.funnel.unfollow_queued },
          { status: 'unfollowed', label: 'Unfollowed', n: detail.funnel.unfollowed },
          { status: 'kept', label: 'Kept', n: detail.funnel.kept },
        ];
  if (detail !== null && detail.funnel.abandoned > 0) {
    rows.push({ status: 'abandoned', label: 'Stopped after repeated errors', n: detail.funnel.abandoned, hazard: true });
  }
  if (detail !== null && detail.funnel.external > 0) {
    rows.push({ status: 'external', label: 'Changed by you', n: detail.funnel.external });
  }
  const denom = Math.max(1, ...rows.map((r) => r.n));

  return (
    <Card raised>
      <CardHeader icon="filter" aux={detail !== null ? withAt(detail.username) || detail.accountPk : undefined}>
        Through this source
      </CardHeader>
      <CardBody>
        {detail === null ? (
          <div class="hint">Epo isn’t exploring a source yet.</div>
        ) : (
          <Fragment>
            <div class="funnel-status">{statusBadge(detail, current)}</div>
            <div class="funnel-pool num">
              <span class="dot" style={`background:${funnelColor('known')}`} />
              <span class="fl">People found</span>
              <span class="fn">{commas(detail.scanned)}</span>
            </div>
            <div class="funnel num">
              {rows.map((r) => {
                const glyph = STATUS_GLYPHS[r.status];
                return (
                  <div key={r.status} class={r.hazard ? 'frow hazard' : 'frow'}>
                    {glyph !== undefined ? (
                      <span class="dot glyph" style={`color:${funnelColor(r.status)}`}>
                        <Icon name={glyph} />
                      </span>
                    ) : (
                      <span class="dot" style={`background:${funnelColor(r.status)}`} />
                    )}
                    <span class="fl">{r.label}</span>
                    <span class="fbar">
                      {r.n > 0 ? (
                        <i
                          style={`width:${Math.min(100, (r.n / denom) * 100)}%;background:${funnelColor(r.status)}`}
                        />
                      ) : null}
                    </span>
                    <span class="fn">{commas(r.n)}</span>
                  </div>
                );
              })}
            </div>
            {detail.funnel.abandoned > 0 ? (
              <div class="hint">
                Epo stopped trying these after its attempts kept failing (for example while Instagram was
                limiting actions). They were not judged a poor fit.
              </div>
            ) : null}
          </Fragment>
        )}
      </CardBody>
    </Card>
  );
}
