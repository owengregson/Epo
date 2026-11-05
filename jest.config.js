// Jest config — SWC-transformed (TS7-native compatible; ts-jest dropped the
// JS compiler API TS7 no longer exposes). SWC only strips/transpiles types;
// type-checking is a separate gate (`tsc --noEmit`). Two transforms so `.ts`
// angle-bracket casts and `.tsx` JSX (Preact automatic runtime, `preact/jsx-runtime`)
// each parse under the correct parser flags.

// Set the real process timezone before Jest creates its workers. Mutating TZ
// inside a test's sandbox does not update Date's timezone on UTC CI runners.
// A DST-observing zone keeps local plan-day fixtures deterministic everywhere.
process.env.TZ = 'America/Los_Angeles';

/** @type {import('jest').Config} */
const swc = (tsx) => [
  '@swc/jest',
  {
    jsc: {
      parser: { syntax: 'typescript', tsx },
      transform: tsx
        ? { react: { runtime: 'automatic', importSource: 'preact' } }
        : undefined,
      target: 'es2022',
      keepClassNames: true,
    },
    module: { type: 'commonjs' },
  },
];

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFilesAfterEnv: ['<rootDir>/tests/kit/setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/kit/'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx$': swc(true),
    '^.+\\.ts$': swc(false),
    '^.+\\.jsx?$': swc(true),
  },
};
