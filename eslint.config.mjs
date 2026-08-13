// ESLint flat config (ESLint 10 + typescript-eslint).
// Replaces the old .eslintrc.cjs; preserves its intent:
//   - TypeScript-aware parsing of src/**/*.{ts,tsx}
//   - better-sqlite3 may only be imported from src/store/**
// plus @eslint/js + typescript-eslint recommended rules, scoped so that
// pre-existing, intentional patterns in this codebase stay clean.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The codebase carries `eslint-disable-next-line react-hooks/exhaustive-deps`
// comments (Preact hooks) but eslint-plugin-react-hooks was never a dependency.
// A no-op stub keeps those directives resolvable without pulling in the plugin.
const reactHooksStub = {
  rules: {
    'exhaustive-deps': { meta: { schema: [] }, create: () => ({}) },
  },
};

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'tests/**', '*.js', '*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooksStub },
    linterOptions: {
      // Pre-existing disable comments (react-hooks stub above, no-var in
      // src/types.ts) would otherwise be reported as unused directives.
      reportUnusedDisableDirectives: false,
    },
    rules: {
      // Project rule carried over from .eslintrc.cjs.
      'no-restricted-imports': ['error', {
        paths: [{ name: 'better-sqlite3', message: 'Only src/store/* may import better-sqlite3.' }],
      }],
      // Scoped for this codebase (old config enabled no recommended set):
      // `h`/`Fragment` are Preact's JSX factory imports — used implicitly by JSX.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_|^(h|Fragment)$',
        caughtErrors: 'none',
      }],
      // New-in-recommended rules that flag pre-existing intentional patterns.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['src/store/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
