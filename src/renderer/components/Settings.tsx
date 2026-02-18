import { h, Fragment } from 'preact';
import { useRef } from 'preact/hooks';
import type { Settings as SettingsType, AggressivenessProfile } from '../../types';
import { TIMING_PROFILES } from '../../types';

interface Props {
  settings: SettingsType;
  onSave: (s: Partial<SettingsType>) => void;
  onClear: () => void;
}

const PROFILE_ORDER: AggressivenessProfile[] = ['ghost', 'cautious', 'normal', 'aggressive', 'turbo'];
const PROFILE_ICONS: Record<AggressivenessProfile, string> = {
  ghost: 'fa-ghost',
  cautious: 'fa-shield-halved',
  normal: 'fa-gauge',
  aggressive: 'fa-bolt',
  turbo: 'fa-rocket',
};
const PROFILE_COLORS: Record<AggressivenessProfile, string> = {
  ghost: 'var(--text-muted)',
  cautious: 'var(--accent)',
  normal: 'var(--success)',
  aggressive: 'var(--warning)',
  turbo: 'var(--danger)',
};

export function Settings({ settings: s, onSave, onClear }: Props) {
  const targetRef = useRef<HTMLInputElement>(null);
  const maxActionsRef = useRef<HTMLInputElement>(null);
  const minDelayRef = useRef<HTMLInputElement>(null);
  const maxDelayRef = useRef<HTMLInputElement>(null);
  const activeStartRef = useRef<HTMLInputElement>(null);
  const activeEndRef = useRef<HTMLInputElement>(null);
  const jitterRef = useRef<HTMLInputElement>(null);
  const chunkSizeRef = useRef<HTMLInputElement>(null);
  const unfollowHrsRef = useRef<HTMLInputElement>(null);
  const headlessRef = useRef<HTMLInputElement>(null);
  const dryRunRef = useRef<HTMLInputElement>(null);
  const aggressivenessRef = useRef<AggressivenessProfile>(s.aggressiveness);
  const minFollowingRef = useRef<HTMLInputElement>(null);
  const followRatioRef = useRef<HTMLInputElement>(null);

  const warnings: h.JSX.Element[] = [];
  if (s.maxActionsPerDay > 30 && s.maxActionsPerDay <= 50) {
    warnings.push(
      <div class="warning-badge yellow" key="w1">
        <i class="fa-solid fa-triangle-exclamation" /> {s.maxActionsPerDay} actions/day is aggressive. Consider lowering.
      </div>
    );
  }
  if (s.maxActionsPerDay > 50) {
    warnings.push(
      <div class="warning-badge red" key="w2">
        <i class="fa-solid fa-triangle-exclamation" /> HIGH BAN RISK: {s.maxActionsPerDay} actions/day exceeds safe limits.
      </div>
    );
  }
  if (s.minDelayMinutes < 1) {
    warnings.push(
      <div class="warning-badge red" key="w3">
        <i class="fa-solid fa-triangle-exclamation" /> Delays under 1 minute are dangerous.
      </div>
    );
  }

  const handleSave = () => {
    onSave({
      target: targetRef.current?.value.trim() ?? '',
      maxActionsPerDay: parseFloat(maxActionsRef.current?.value ?? '20'),
      minDelayMinutes: parseFloat(minDelayRef.current?.value ?? '3'),
      maxDelayMinutes: parseFloat(maxDelayRef.current?.value ?? '7'),
      activeHoursStart: parseFloat(activeStartRef.current?.value ?? '8'),
      activeHoursEnd: parseFloat(activeEndRef.current?.value ?? '22'),
      jitterPercent: parseFloat(jitterRef.current?.value ?? '30'),
      scrapeChunkSize: parseFloat(chunkSizeRef.current?.value ?? '200'),
      unfollowAfterHours: parseFloat(unfollowHrsRef.current?.value ?? '24'),
      headless: headlessRef.current?.checked ?? true,
      dryRun: dryRunRef.current?.checked ?? false,
      aggressiveness: aggressivenessRef.current,
      minFollowing: parseFloat(minFollowingRef.current?.value ?? '600'),
      followRatioTolerance: parseFloat(followRatioRef.current?.value ?? '50'),
    });
  };

  const selectedProfile = TIMING_PROFILES[s.aggressiveness];

  return (
    <>
      {/* ── Target ──────────────────────────────────────────────────────── */}
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title"><i class="fa-solid fa-bullseye" /> Target Account</div>
        </div>
        <div class="settings-grid">
          <div class="settings-field full-width">
            <label class="form-label"><i class="fa-solid fa-at" /> Target Username</label>
            <input type="text" class="form-input" ref={targetRef} defaultValue={s.target} placeholder="username (without @)" />
            <div class="form-hint">The account whose followers you want to follow.</div>
          </div>
        </div>
      </div>

      {/* ── Aggressiveness Profile ──────────────────────────────────────── */}
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title"><i class="fa-solid fa-gauge-high" /> Speed Profile</div>
        </div>
        <div class="settings-grid">
          <div class="settings-field full-width">
            <label class="form-label">Aggressiveness</label>
            <div class="profile-selector">
              {PROFILE_ORDER.map((key) => {
                const profile = TIMING_PROFILES[key];
                const isActive = s.aggressiveness === key;
                return (
                  <button
                    key={key}
                    class={`profile-option ${isActive ? 'active' : ''}`}
                    style={isActive ? { borderColor: PROFILE_COLORS[key], color: PROFILE_COLORS[key] } : undefined}
                    onClick={() => {
                      aggressivenessRef.current = key;
                      onSave({ aggressiveness: key });
                    }}
                  >
                    <i class={`fa-solid ${PROFILE_ICONS[key]}`} style={isActive ? { color: PROFILE_COLORS[key] } : undefined} />
                    <span class="profile-option-label">{profile.label}</span>
                  </button>
                );
              })}
            </div>
            <div class="profile-description">
              <i class="fa-solid fa-circle-info" style={{ color: PROFILE_COLORS[s.aggressiveness] }} />
              <span>{selectedProfile.description}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Candidate Filtering ──────────────────────────────────────────── */}
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title"><i class="fa-solid fa-filter" /> Candidate Filtering</div>
        </div>
        <div class="settings-grid">
          <div class="settings-field">
            <label class="form-label">Min Following Count</label>
            <input type="number" class="form-input" ref={minFollowingRef} defaultValue={s.minFollowing} min={0} max={50000} />
            <div class="form-hint">Skip users with fewer following than this.</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Ratio Tolerance %</label>
            <input type="number" class="form-input" ref={followRatioRef} defaultValue={s.followRatioTolerance} min={10} max={200} />
            <div class="form-hint">Following must be within this % of followers.</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Scrape Chunk Size</label>
            <input type="number" class="form-input" ref={chunkSizeRef} defaultValue={s.scrapeChunkSize} min={50} max={1000} />
            <div class="form-hint">Max validated users per scrape run.</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Unfollow After (hrs)</label>
            <input type="number" class="form-input" ref={unfollowHrsRef} defaultValue={s.unfollowAfterHours} min={1} max={168} />
            <div class="form-hint">Hours before auto-unfollowing.</div>
          </div>
        </div>
      </div>

      {/* ── Rate Limiting ────────────────────────────────────────────────── */}
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title"><i class="fa-solid fa-shield-halved" /> Rate Limiting</div>
        </div>
        <div class="settings-grid">
          <div class="settings-field">
            <label class="form-label">Max Actions / Day</label>
            <input type="number" class="form-input" ref={maxActionsRef} defaultValue={s.maxActionsPerDay} min={1} max={100} />
            <div class="form-hint">Follow + unfollow combined limit.</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Min Delay (min)</label>
            <input type="number" class="form-input" ref={minDelayRef} defaultValue={s.minDelayMinutes} min={0.5} step={0.5} />
            <div class="form-hint">Shortest wait between actions.</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Max Delay (min)</label>
            <input type="number" class="form-input" ref={maxDelayRef} defaultValue={s.maxDelayMinutes} min={1} step={0.5} />
            <div class="form-hint">Longest wait between actions.</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Jitter %</label>
            <input type="number" class="form-input" ref={jitterRef} defaultValue={s.jitterPercent} min={0} max={100} />
            <div class="form-hint">Randomness added to delays.</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Active Start (hr)</label>
            <input type="number" class="form-input" ref={activeStartRef} defaultValue={s.activeHoursStart} min={0} max={23} />
            <div class="form-hint">Hour to start operating (24h).</div>
          </div>
          <div class="settings-field">
            <label class="form-label">Active End (hr)</label>
            <input type="number" class="form-input" ref={activeEndRef} defaultValue={s.activeHoursEnd} min={0} max={23} />
            <div class="form-hint">Hour to stop operating (24h).</div>
          </div>
          {warnings.length > 0 && (
            <div class="settings-field full-width">
              <div class="settings-warnings">{warnings}</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Advanced ─────────────────────────────────────────────────────── */}
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title"><i class="fa-solid fa-sliders" /> Advanced</div>
        </div>
        <div class="settings-grid">
          <div class="settings-field full-width">
            <div class="toggle-wrap">
              <div class="toggle-label-text">
                <span>Headless Mode</span>
                <span>Run browser in the background (invisible).</span>
              </div>
              <label class="toggle">
                <input type="checkbox" ref={headlessRef} defaultChecked={s.headless} />
                <span class="toggle-slider" />
              </label>
            </div>
          </div>
          <div class="settings-field full-width">
            <div class="toggle-wrap">
              <div class="toggle-label-text">
                <span>Dry Run</span>
                <span>Simulate all actions without actually following anyone.</span>
              </div>
              <label class="toggle">
                <input type="checkbox" ref={dryRunRef} defaultChecked={s.dryRun} />
                <span class="toggle-slider" />
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <div class="settings-actions">
        <button class="btn btn-primary" onClick={handleSave}>
          <i class="fa-solid fa-floppy-disk" /> Save Settings
        </button>
        <button class="btn btn-danger" onClick={onClear}>
          <i class="fa-solid fa-trash-can" /> Clear Session
        </button>
      </div>
    </>
  );
}
