/**
 * One Advanced row, rendered generically from its `ParamView` (spec §6.5): label and help always visible,
 * the control by kind, "Recommended {v}" with "Why this number?", "Set by you" and "Use recommended" only
 * when overridden, the safe range and when a change applies, and the clamp, stale, inactive and conflict
 * notes. The pause rows also show what today's plan really uses.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Push } from '@/ipc/contract';
import type { ParamValue, RatioCurve } from '@/shared/settings-model';
import type { SettingsOp } from '@/shared/settings-ops';
import type { ParamView } from '@/shared/settings-view';
import { APPLIES_COPY, ROW_COPY } from '../copy/advanced';
import { PARAM_COPY } from '../copy/params';
import { ControlError, SwitchRow } from '../fields/controls';
import { fill, spanOf, valueLabel, waitLabel } from '../format';
import type { StageApi } from '../stage-api';
import { CurveEditor } from './CurveEditor';
import { NumberControl, RangeControl } from './ParamControl';
import { Provenance } from './Provenance';

const MS_PER_S = 1000;

/** What today's plan uses for a pause row ("4 m 21 s – 6 m 40 s"), or null when there is no built plan. */
export function todayOf(key: ParamView['key'], status: Push<'status'> | null): string | null {
  const plan = status?.basis === 'built' ? (status.plan ?? null) : null;
  if (plan === null || plan.detail.sessions.length === 0) return null;
  const pick = key === 'sessions.gapTypical' ? 'targetMeanMs' : key === 'sessions.gapMinimum' ? 'floorMs' : null;
  if (pick === null) return null;
  const all = plan.detail.sessions.map((x) => x.gap[pick] / MS_PER_S);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  return Math.round(lo) === Math.round(hi) ? waitLabel(lo) : `${waitLabel(lo)} – ${waitLabel(hi)}`;
}

/** The op a commit sends: the recommendation itself clears the override instead of pinning it. */
export function commitOps(p: ParamView, v: ParamValue): SettingsOp[] {
  const same = JSON.stringify(v) === JSON.stringify(p.recommended);
  if (same) return p.override === null ? [] : [{ op: 'clear-override', key: p.key }];
  return [{ op: 'override', key: p.key, value: v }];
}

function Control({ p, s, value, label, describedBy }: { p: ParamView; s: StageApi; value: ParamValue; label: string; describedBy?: string }): JSX.Element {
  const k = `param:${p.key}`;
  const send = (v: ParamValue): void => {
    const ops = commitOps(p, v);
    if (ops.length > 0) s.send(k, ops, v);
  };
  if (typeof value === 'boolean') {
    return <SwitchRow label={label} checked={value} onChange={send} s={s} k={k} />;
  }
  if (typeof value === 'number') {
    const b = p.bounds.kind === 'bool' ? { min: value, max: value } : p.bounds;
    return <NumberControl p={p} value={value} label={label} describedBy={describedBy} min={b.min} max={b.max} onCommit={send} />;
  }
  if ('min' in value) return <RangeControl p={p} value={value} label={label} onCommit={send} />;
  const edge = s.view.params.find((x) => x.key === 'audience.bandEdgeScore')?.value;
  return <CurveEditor p={p} value={value as RatioCurve} edge={typeof edge === 'number' ? edge : 0} label={label} onCommit={send} />;
}

function Notes({ p, s, label }: { p: ParamView; s: StageApi; label: string }): JSX.Element | null {
  const o = p.override;
  const conflict = s.c.state.conflicts.find((c) => c.key === p.key);
  const v = (x: ParamValue): string => valueLabel(x, p.unit);
  const lines: JSX.Element[] = [];
  if (p.inactive !== null) {
    lines.push(<span key="inactive">{p.inactive === 'mutuals-kept' ? ROW_COPY.inactiveMutuals : ROW_COPY.inactiveCleanup}</span>);
  }
  if (o?.clamped) {
    const above = typeof o.requested === 'number' && typeof p.value === 'number' && o.requested > p.value;
    lines.push(<span key="clamp">{fill(above ? ROW_COPY.clampedMax : ROW_COPY.clampedMin, { x: v(o.requested), y: v(p.value) })}</span>);
  }
  if (o?.stale) lines.push(<span key="stale">{fill(ROW_COPY.stale, { x: v(o.requested), b: v(o.basis), r: v(p.recommended) })}</span>);
  if (conflict !== undefined) {
    const r = v(conflict.recommendedNow);
    const x = v(conflict.yours);
    lines.push(
      <span key="conflict" class="set-conflict" role="status">
        {fill(ROW_COPY.conflict, { label, x, r })}{' '}
        <button type="button" class="set-btn" onClick={() => s.send(`param:${p.key}`, [{ op: 'clear-override', key: p.key }], p.recommended)}>
          {fill(ROW_COPY.useIt, { r })}
        </button>{' '}
        <button type="button" class="set-btn" onClick={s.c.dismissConflicts}>
          {fill(ROW_COPY.keep, { x })}
        </button>
      </span>,
    );
  }
  return lines.length === 0 ? null : <span class="set-param__notes">{lines}</span>;
}

export function ParamRow({ p, s, sharedDescription }: { p: ParamView; s: StageApi; sharedDescription?: string }): JSX.Element {
  const [why, setWhy] = useState(false);
  const copy = PARAM_COPY[p.key];
  const help = fill(copy.help, { p: Math.round((s.view.typical.automaticMax / Math.max(1, s.view.effective.dailyVolume)) * 100) });
  const value = s.c.value<ParamValue>(`param:${p.key}`, p.value);
  const today = todayOf(p.key, s.status);
  const range = p.bounds.kind === 'bool' ? null : fill(ROW_COPY.range, { span: spanOf(p.bounds.min, p.bounds.max, p.unit) });
  const metaId = `param-description-${p.key}`;
  return (
    <div class={`set-param${p.override !== null ? ' is-set' : ''}${sharedDescription ? ' set-param--compact' : ''}`} data-row={p.key}>
      <div class="set-param__copy">
        <span class="set-param__label">{copy.label}</span>
        {sharedDescription ? null : <span class="set-param__help">{help}</span>}
        <span class="set-param__rec num">
          {fill(ROW_COPY.recommended, { v: valueLabel(p.recommended, p.unit) })}
          {p.provenance.length > 0 ? (
            <button type="button" class="link-btn" aria-expanded={why} onClick={() => setWhy(!why)}>
              {why ? ROW_COPY.hideWhy : ROW_COPY.why}
            </button>
          ) : null}
        </span>
        {why ? <Provenance steps={p.provenance} view={s.view} /> : null}
      </div>
      <div class="set-param__control">
        <div class="set-param__line">
          <Control p={p} s={s} value={value} label={copy.label} describedBy={sharedDescription ? `${sharedDescription} ${metaId}` : undefined} />
          {today === null ? null : <span class="set-param__today num">{fill(ROW_COPY.today, { v: today })}</span>}
          {p.override !== null ? (
            <>
              <span class="set-tag set-tag--set">{ROW_COPY.setByYou}</span>
              <button type="button" class="link-btn" onClick={() => s.send(`param:${p.key}`, [{ op: 'clear-override', key: p.key }], p.recommended)}>
                {ROW_COPY.useRecommended}
              </button>
            </>
          ) : null}
        </div>
        <span id={metaId} class="set-param__meta num">{sharedDescription ? range : range === null ? APPLIES_COPY[p.applies] : `${range} · ${APPLIES_COPY[p.applies]}`}</span>
        <Notes p={p} s={s} label={copy.label} />
        <ControlError s={s} k={`param:${p.key}`} />
      </div>
    </div>
  );
}
