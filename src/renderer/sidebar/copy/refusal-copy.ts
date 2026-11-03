/**
 * Refusals (spec Appendix C.15.4, "Prune" wording, §18.3 Q5): the Now zone's reason line for a command the
 * person gave that Epo did not carry out, in plain words — never a silent no-op and never the raw key.
 */
import { BOOST_COPY } from '@/renderer/copy/boost';

const DIDNT_WORK = 'That didn’t work. Diagnostics has details.';

const REFUSAL: Readonly<Record<string, string | null>> = {
  'prune-running': 'A prune is using Instagram. Epo starts when it finishes.',
  'manual-running': 'Epo is finishing a quick task. Try again in a moment.',
  starting: 'One moment — Epo is finishing starting up.',
  'runtime-not-ready': 'Epo needs your attention first (see above).',
  'runtime-blocked': BOOST_COPY.unavailable.attention,
  offline: 'You’re offline. Epo starts when you’re back online.',
  'not-logged-in': 'Sign in to Instagram first.',
  'signed-out': BOOST_COPY.unavailable.signedOut,
  'engine-running': 'Epo is busy. Pause it first.',
  'boost-active': 'Boost is on. End Boost to prune now.',
  'nothing-to-shift': BOOST_COPY.control.nothingToShift,
  backlog: 'Too many unfollows are still waiting from earlier Boosts. Boost is available again once more of them are done.',
  'no-seed': BOOST_COPY.unavailable.noSeed,
  'seed-missing': 'Choose a starting account first.',
  'account-changed': 'A different Instagram account is signed in. Check the Live tab.',
  'bad-duration': 'Choose Boost’s length in Settings, then try again.',
  // A Stop cancelled the Start it answered, and a second press of a running Boost changes nothing: no line.
  'runtime-intent-changed': null,
  'already-on': null,
  'not-on': null,
};

/** The reason line for a typed refusal; null when the refusal needs no words. */
export function refusalText(reason: string): string | null {
  return Object.hasOwn(REFUSAL, reason) ? (REFUSAL[reason] ?? null) : DIDNT_WORK;
}

/** A command that failed outright (the bridge rejected it). */
export const COMMAND_FAILED = DIDNT_WORK;
