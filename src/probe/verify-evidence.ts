/** One verify run's fail-closed state, passive evidence and cancellable work. Never opens a graph or settings. */
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import { Reader } from '@/adapter/reader';
import { Sentinel } from '@/adapter/sentinel';
import type { InstagramTab } from '@/adapter/tab';
import { SystemClock } from '@/governors/clock';
import { TrafficRecorder } from '@/probe/recorder';
import { ProfileObserver } from '@/rim/profile-observer';
import { MemorySink } from '@/surface/sink';
import * as logger from '@/utils/logger';

export class VerifyEvidence {
  readonly abort = new AbortController();
  readonly result: Record<string, unknown> = {};
  readonly sink = new MemorySink();
  readonly reader = new Reader({ sink: {
    read: (...args) => this.sink.read(...args),
    drift: (signal, at) => {
      this.sink.drift(signal, at);
      if (signal.cls === 'shadow-disagreed') this.stop('shadow-disagreed', signal.endpoint);
    },
  } });
  observer: ProfileObserver | null = null;
  recorder: TrafficRecorder | null = null;
  failure: { step: string; reason: string; detail?: unknown } | null = null;
  step = 'initial-home';
  private readonly pending = new Set<Promise<void>>();
  private readonly disposers: Array<() => void> = [];
  private readonly bodies: Array<Record<string, unknown>> = [];
  private readonly sentinels: Array<{ step: string; status: string }> = [];
  private contents: WebContents | null = null;

  constructor(readonly out: string) {}

  /** Called synchronously when the tool's sole WebContents is created, BEFORE its first goto. */
  record(contents: WebContents): void {
    if (this.recorder !== null) { this.stop('ambiguous-recorder'); return; }
    this.contents = contents;
    this.recorder = new TrafficRecorder(contents, this.out, (failure) => this.stop('traffic', failure));
    this.recorder.setStep(this.step);
    this.recorder.start();
  }

  requireRecorder(contents: WebContents | undefined): void {
    if (this.recorder === null || contents !== this.contents || !contents?.debugger.isAttached()) this.stop('recorder-unavailable');
    this.assert();
    this.result.coverage = { initialHome: true, composedRequests: 0, scriptedMutations: 0 };
  }

  /** Installed immediately after synchronous tool construction, before awaiting its initial navigation. */
  observe(tab: InstagramTab): void {
    this.observer = new ProfileObserver({ tab, reader: this.reader, store: { observe: () => {} }, clock: new SystemClock() });
    this.disposers.push(this.observer.start(), tab.onResponse((response) => {
      const kind = this.reader.kindOf(response);
      if (kind !== 'profile-info' && kind !== 'profile-graphql' && kind !== 'activity-feed' && kind !== 'friend-requests') return;
      const step = this.step;
      const task = this.reader.observed.read(response)?.then(({ read }) => {
        this.bodies.push({ step, kind, method: response.method, status: response.status,
          ...(read.ok ? { tier: read.tier, partial: read.partial, followEvents: read.projection.events.length,
            rows: read.projection.facts.length, continuation: read.projection.continuation?.kind ?? null }
            : { failure: read.kind }) });
        if (!read.ok || read.tier !== 'canonical' || read.partial) this.stop('noncanonical-read', { step, kind });
      }).catch((error: unknown) => this.stop('body-unreadable', String(error))).finally(() => {
        if (task !== undefined) this.pending.delete(task);
      });
      if (task !== undefined) this.pending.add(task);
    }));
  }

  stop(reason: string, detail?: unknown): void {
    if (this.failure !== null) return;
    this.failure = { step: this.step, reason, ...(detail === undefined ? {} : { detail }) };
    logger.warn('probe.verify stopped', this.failure);
    this.abort.abort();
  }

  assert(): void {
    if (this.failure !== null) throw new Error(`verify stopped: ${this.failure.reason}`);
  }

  /** A wall wakes readiness, sleeps and stalled operations immediately; their input paths share the signal. */
  async wait<T>(work: Promise<T>): Promise<T> {
    const { signal } = this.abort;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('verify stopped'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const value = await Promise.race([work, cancelled]);
      this.assert(); // An already-resolved operation must not beat a same-turn wall's cancellation.
      return value;
    }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  async check(tab: InstagramTab): Promise<void> {
    this.assert();
    const status = await this.wait(new Sentinel(tab).check());
    this.sentinels.push({ step: this.step, status });
    if (status !== 'ok') this.stop('sentinel', status);
    this.assert();
  }

  begin(step: string): void { this.assert(); this.step = step; this.recorder?.setStep(step); }

  /** Independent writes: a failed screenshot/body/traffic write cannot suppress the run's stop evidence. */
  async finish(): Promise<void> {
    for (const dispose of this.disposers) dispose();
    this.recorder?.stop();
    await Promise.all([this.recorder?.drain(), ...this.pending]);
    const health = this.sink.snapshot();
    this.result.sentinels = this.sentinels;
    this.result.profileBodies = this.bodies.filter((body) => String(body.kind).startsWith('profile-'));
    this.result.drawerBodies = this.bodies.filter((body) => !String(body.kind).startsWith('profile-'));
    // A successful drawer click is not proof that its response was observed and parsed.
    const missing = ['activity-feed', 'friend-requests'].filter((kind) => !this.bodies.some((body) => body.kind === kind));
    if (this.failure === null && missing.length > 0) this.stop('missing-body-coverage', missing);
    this.result.surface = { tallies: health.tallies,
      drift: health.drift.map(({ signal }) => ({ endpoint: signal.endpoint, cls: signal.cls, path: signal.path })) };
    this.result.exchanges = this.recorder?.exchanges.length ?? 0;
    try { writeFileSync(path.join(this.out, 'traffic.json'), JSON.stringify(this.recorder?.exchanges ?? [], null, '  '), 'utf8'); }
    catch (error) { this.result.trafficWriteError = String(error); this.stop('traffic-write', String(error)); }
    this.result.outcome = this.failure === null ? 'passed' : 'stopped';
    this.result.stop = this.failure;
    writeFileSync(path.join(this.out, 'verify.json'), JSON.stringify(this.result, null, '  '), 'utf8');
  }
}
