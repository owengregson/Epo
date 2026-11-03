/**
 * The Boost copy deck (Appendix B.10, C.15 and the recorded answers: Boost may lift a day up to Epo's fullest
 * automatic day; the user-facing word for cleanup is Prune). `{name}` marks a value the caller fills from a
 * projection; no number lives in copy. The Settings section and the sidebar control share it.
 */

export const BOOST_COPY = {
  settings: {
    lead: 'Boost has Epo spend the next hours finding and following new people. Unfollowing, pruning and routine checks wait until it ends. Your daily safety limits never change.',
    defaultLength: 'Default length',
    keepAccepting: 'Keep accepting follow requests during Boost',
    keepAcceptingHelp: 'Matters only for private accounts: their follow-backs arrive as requests.',
    checklist: [
      'More follows and more exploring of new accounts',
      'Unfollows, pruning and follow-back checks wait',
      'Quiet hours and days off still apply',
      'Your daily and hourly limits never go up',
    ],
    whereToStart: 'This is where you choose how long a Boost lasts. Start or end one with the Boost button in the left panel.',
    showMe: 'Show me',
    on: 'Boost is on until {time} · {n} follows so far',
    end: 'End Boost',
  },
  control: {
    start: '⚡ Boost for {h} h',
    startAndRun: 'Start Epo and Boost',
    preview: 'Until {time} · about +{n} follows today, within your usual limits · {k} unfollows will wait',
    changeLength: 'Change length in Settings',
    actNowOnly: 'Boost starts working now instead of at {time}. Today is already at Epo\'s fullest day, so follows stay about {n}.',
    nothingToShift: 'Today is already at Epo\'s fullest day, and Epo is already working.',
    backlog: 'Too many unfollows are still waiting from earlier Boosts. Boost is available again in about {d} days.',
    quietHours: 'Most of this falls in your quiet hours; Boost starts at {time}.',
    limitReached: 'Today\'s limit is already reached; Boost starts helping tomorrow.',
    paused: '⚡ Boost on until {time} — Epo is stopped. Press Start to use it.',
    on: '⚡ Boost on · ends {time} · {h} h {m} m left',
    waiting: '⚡ Boost starts at {time} (quiet hours)',
    end: 'End Boost',
    ended: 'Boost ended. Unfollows that waited will be spread over the next sessions.',
  },
  unavailable: {
    signedOut: 'Sign in to use Boost',
    noSeed: 'Choose a starting account first',
    attention: 'Epo needs your attention first',
  },
  explain: 'Boost has Epo spend the next hours finding and following new people. Unfollowing, pruning and routine checks wait until it ends. Your daily safety limits never change.',
  pill: '⚡ Boost',
} as const;
