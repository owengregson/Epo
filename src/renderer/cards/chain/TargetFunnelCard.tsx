/** @jsx h */
import { Fragment, h } from 'preact';
import { LEGEND_LABELS, legendColor } from '@/renderer/graph/palette';
import { commas, withAt } from '@/renderer/lib/format';
import { Badge } from '@/renderer/ui/Badge';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import type { ChainTargetDetail, GraphNodeStatus } from '@/types';

export interface TargetFunnelCardProps {
  detail: ChainTargetDetail | null;
  /** True when this target is the engine's active one. */
  current: boolean;
  /** Entrance-stagger index (`--i`). */
  index?: number;
}

/** One funnel row: a lifecycle segment with its graph-palette identity. */
interface FunnelRow {
  status: GraphNodeStatus;
  label: string;
  n: number;
  hazard?: boolean;
}

/**
 * Funnel-local fill overrides — colors tuned for the card's track, not the
 * canvas ground. The `unfollowed` spent-graphite reads on `--bg` as a dot but
 * vanishes as a 3px fill on the card track, so the funnel lifts its lightness
 * ~10 points; the graph palette itself is untouched.
 */
const FUNNEL_COLOR_OVERRIDES: Partial<Record<GraphNodeStatus, string>> = {
  unfollowed: 'hsl(240 6% 37%)',
};

/** The fill/dot color for one funnel row (palette color unless overridden). */
function funnelColor(status: GraphNodeStatus): string {
  return FUNNEL_COLOR_OVERRIDES[status] ?? legendColor(status);
}

/**
 * Truthful status tail for the header: an exhausted target that never yielded
 * a follow reads "exhausted (unworked)" — drained without work is a different
 * fact from poached out.
 */
function statusBadge(detail: ChainTargetDetail, current: boolean): h.JSX.Element {
  if (current) return <Badge tone="live">Current · Hop {detail.chainIndex ?? 0}</Badge>;
  if (detail.status === 'exhausted') {
    return <Badge>{detail.yield.total === 0 ? 'exhausted (unworked)' : 'exhausted'}</Badge>;
  }
  if (detail.status === 'retained') return <Badge>retired</Badge>;
  return <Badge>Hop {detail.chainIndex ?? 0}</Badge>;
}

/**
 * Tier 2 of the Targets console — the live funnel for the detailed target,
 * one row per lifecycle segment over the REAL FollowState union. Vocabulary
 * and colors come from the graph palette (`LEGEND_LABELS` / `legendColor`),
 * so this funnel and the GraphStage legend describe the lifecycle in the same
 * words and hues. "Held" is not a state — the `followed_back` segment's
 * legend label ("Followed back · holding") carries the holding meaning
 * explicitly. The two terminal oddities are never folded away silently:
 * `abandoned` renders as a hazard row whose copy explains the red (an earlier
 * systemic failure — a requeue healer lands separately), and `external` is
 * labeled hands-off. The observed pool renders as a context stat ABOVE the
 * funnel, never as a funnel row: it is the crowd the stages draw from, and
 * keeping it out of the bar denominator keeps the stage bars legible. Counts
 * tick during walks — the hosting view re-reads the detail on every chain
 * push (§2).
 */
export function TargetFunnelCard({ detail, current, index = 0 }: TargetFunnelCardProps): h.JSX.Element {
  const rows: FunnelRow[] =
    detail === null
      ? []
      : [
          { status: 'queued', label: LEGEND_LABELS.queued, n: detail.funnel.queued },
          { status: 'waiting', label: LEGEND_LABELS.waiting, n: detail.funnel.pending_followback },
          { status: 'held', label: LEGEND_LABELS.held, n: detail.funnel.followed_back },
          {
            status: 'unfollow_queued',
            label: LEGEND_LABELS.unfollow_queued,
            n: detail.funnel.unfollow_queued,
          },
          { status: 'unfollowed', label: LEGEND_LABELS.unfollowed, n: detail.funnel.unfollowed },
        ];
  if (detail !== null && detail.funnel.abandoned > 0) {
    rows.push({
      status: 'abandoned',
      label: `${LEGEND_LABELS.abandoned} · earlier systemic failure`,
      n: detail.funnel.abandoned,
      hazard: true,
    });
  }
  if (detail !== null && detail.funnel.external > 0) {
    rows.push({ status: 'external', label: LEGEND_LABELS.external, n: detail.funnel.external });
  }
  // Widths are relative to the largest LIFECYCLE segment only. The observed
  // pool (thousands after a walk) is context, not a stage — folding it into
  // the denominator would crush every lifecycle bar to sub-pixel widths.
  const denom = Math.max(1, ...rows.map((r) => r.n));

  return (
    <Card raised index={index}>
      <CardHeader
        icon="filter"
        aux={detail !== null ? withAt(detail.username) || detail.accountPk : undefined}
      >
        Target Funnel
      </CardHeader>
      <CardBody>
        {detail === null ? (
          <div class="hint">No target adopted yet — set a seed and press Start.</div>
        ) : (
          <Fragment>
            <div class="funnel-status">{statusBadge(detail, current)}</div>
            <div class="funnel-pool num">
              <span class="dot" style={`background:${funnelColor('known')}`} />
              <span class="fl">Pool observed</span>
              <span class="fn">{commas(detail.scanned)}</span>
            </div>
            <div class="funnel num">
              {rows.map((r) => (
                <div key={r.status} class={r.hazard ? 'frow hazard' : 'frow'}>
                  <span class="dot" style={`background:${funnelColor(r.status)}`} />
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
              ))}
            </div>
            {detail.funnel.abandoned > 0 ? (
              <div class="hint">
                Abandoned records came from an earlier systemic failure (retries ran out under a
                block or outage) — they are not score rejections.
              </div>
            ) : null}
          </Fragment>
        )}
      </CardBody>
    </Card>
  );
}
