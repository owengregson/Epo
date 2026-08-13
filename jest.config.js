// Jest config — SWC-transformed (TS7-native compatible; ts-jest dropped the
// JS compiler API TS7 no longer exposes). SWC only strips/transpiles types;
// type-checking is a separate gate (`tsc --noEmit`). Two transforms so `.ts`
// angle-bracket casts and `.tsx` JSX (Preact classic runtime, `h`/`Fragment`)
// each parse under the correct parser flags.
/** @type {import('jest').Config} */
const swc = (tsx) => [
  '@swc/jest',
  {
    jsc: {
      parser: { syntax: 'typescript', tsx },
      transform: tsx
        ? { react: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } }
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
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx$': swc(true),
    '^.+\\.ts$': swc(false),
    '^.+\\.jsx?$': swc(true),
  },
};
