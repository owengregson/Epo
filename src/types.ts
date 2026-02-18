// ── Aggressiveness Profiles ──────────────────────────────────────────────────

export type AggressivenessProfile = 'ghost' | 'cautious' | 'normal' | 'aggressive' | 'turbo';

export interface TimingProfile {
  label: string;
  description: string;
  /** Delay after opening a dialog before interacting (ms) */
  dialogOpenDelay: [number, number];
  /** Delay between scroll actions in the followers dialog (ms) */
  scrollDelay: [number, number];
  /** Delay after scrolling when stuck / aggressive scroll (ms) */
  scrollStuckDelay: [number, number];
  /** Delay before/after visiting a user profile for validation (ms) */
  profileVisitDelay: [number, number];
  /** Delay between follow/unfollow actions (ms) */
  actionDelay: [number, number];
  /** Delay after page navigation completes (ms) */
  navigationDelay: [number, number];
  /** Max unchanged rounds before giving up on scrolling */
  maxUnchangedRounds: number;
}

export const TIMING_PROFILES: Record<AggressivenessProfile, TimingProfile> = {
  ghost: {
    label: 'Ghost',
    description: 'Ultra-safe. Very slow, mimics careful human browsing.',
    dialogOpenDelay: [3000, 5000],
    scrollDelay: [2000, 4000],
    scrollStuckDelay: [4000, 7000],
    profileVisitDelay: [3000, 6000],
    actionDelay: [2000, 4000],
    navigationDelay: [2000, 4000],
    maxUnchangedRounds: 20,
  },
  cautious: {
    label: 'Cautious',
    description: 'Slow and safe. Longer pauses between actions.',
    dialogOpenDelay: [2000, 3500],
    scrollDelay: [1500, 3000],
    scrollStuckDelay: [3000, 5000],
    profileVisitDelay: [2000, 4000],
    actionDelay: [1500, 3000],
    navigationDelay: [1500, 3000],
    maxUnchangedRounds: 18,
  },
  normal: {
    label: 'Normal',
    description: 'Balanced speed and safety. Default profile.',
    dialogOpenDelay: [1000, 2000],
    scrollDelay: [800, 2000],
    scrollStuckDelay: [2000, 4000],
    profileVisitDelay: [1500, 3000],
    actionDelay: [1000, 2000],
    navigationDelay: [1000, 2000],
    maxUnchangedRounds: 15,
  },
  aggressive: {
    label: 'Aggressive',
    description: 'Fast actions with short delays. Higher detection risk.',
    dialogOpenDelay: [600, 1200],
    scrollDelay: [400, 1000],
    scrollStuckDelay: [1000, 2000],
    profileVisitDelay: [800, 1500],
    actionDelay: [600, 1200],
    navigationDelay: [600, 1200],
    maxUnchangedRounds: 12,
  },
  turbo: {
    label: 'Turbo',
    description: 'Maximum speed. High ban risk. Use at your own risk.',
    dialogOpenDelay: [300, 700],
    scrollDelay: [200, 500],
    scrollStuckDelay: [500, 1000],
    profileVisitDelay: [400, 800],
    actionDelay: [300, 700],
    navigationDelay: [300, 700],
    maxUnchangedRounds: 10,
  },
};

// ── Settings ──────────────────────────────────────────────────────────────────

export interface Settings {
  target: string;
  headless: boolean;
  dryRun: boolean;
  maxActionsPerDay: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  jitterPercent: number;
  scrapeChunkSize: number;
  unfollowAfterHours: number;
  slowMo: number;
  /** Aggressiveness profile controlling timing of browser actions */
  aggressiveness: AggressivenessProfile;
  /** Minimum following count a candidate must have */
  minFollowing: number;
  /** Max ratio deviation: following must be within this % of followers (above/below) */
  followRatioTolerance: number;
}

export const DEFAULT_SETTINGS: Settings = {
  target: '',
  headless: true,
  dryRun: false,
  maxActionsPerDay: 20,
  minDelayMinutes: 3,
  maxDelayMinutes: 7,
  activeHoursStart: 8,
  activeHoursEnd: 22,
  jitterPercent: 30,
  scrapeChunkSize: 200,
  unfollowAfterHours: 24,
  slowMo: 0,
  aggressiveness: 'normal',
  minFollowing: 600,
  followRatioTolerance: 50,
};

// ── Follower Data ─────────────────────────────────────────────────────────────

export interface FollowerEntry {
  username: string;
  userId?: string;
  fullName?: string;
  isVerified?: boolean;
  followingCount?: number;
  followerCount?: number;
  scrapedAt: string;
}

// ── Scrape Cursor ─────────────────────────────────────────────────────────────

export interface ScrapeCursor {
  targetUsername: string;
  totalCollected: number;
  lastUserId: string;
  collectedUsernames: string[];
  isComplete: boolean;
  lastScrapedAt: string;
  endCursor: string;
  hasNextPage: boolean;
}

// ── Scheduled Actions ─────────────────────────────────────────────────────────

export interface ScheduledAction {
  username: string;
  scheduledAt: string;
}

export interface HistoryEntry {
  username: string;
  followedAt: string;
}

// ── App State ─────────────────────────────────────────────────────────────────

export interface AppState {
  target: string;
  generatedAt: string;
  scrapeCursor: ScrapeCursor | null;
  followerList: FollowerEntry[];
  nextFollowIndex: number;
  followQueue: ScheduledAction[];
  followHistory: HistoryEntry[];
  pendingUnfollows: ScheduledAction[];
  lastDailyPlan: string | null;
}

// ── Bot Status (sent to renderer) ─────────────────────────────────────────────

export interface BotStatus {
  running: boolean;
  busy: boolean;
  lastAction: string;
  target: string;
  followerCount: number;
  nextFollowIndex: number;
  queuedFollows: number;
  pendingUnfollows: number;
  nextFollowAt: string | null;
  nextUnfollowAt: string | null;
  scrapeProgress: {
    totalCollected: number;
    isComplete: boolean;
    isActive: boolean;
  } | null;
}

// ── Log Entry (sent to renderer) ──────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

// ── IPC Channel Types ─────────────────────────────────────────────────────────

export interface PeanutAPI {
  getSettings(): Promise<Settings>;
  updateSettings(settings: Partial<Settings>): Promise<Settings>;
  getStatus(): Promise<BotStatus>;
  getFollowerList(): Promise<{ followerList: FollowerEntry[]; nextFollowIndex: number }>;
  startBot(): Promise<void>;
  stopBot(): Promise<void>;
  startScraping(): Promise<void>;
  clearSession(): Promise<void>;
  getLogs(): Promise<LogEntry[]>;
  onLog(callback: (entry: LogEntry) => void): void;
  onStatus(callback: (status: BotStatus) => void): void;
}
