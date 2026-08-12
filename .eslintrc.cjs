module.exports = {
  parser: '@typescript-eslint/parser',
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{ name: 'better-sqlite3', message: 'Only src/store/* may import better-sqlite3.' }],
    }],
  },
  overrides: [{ files: ['src/store/**/*.ts'], rules: { 'no-restricted-imports': 'off' } }],
};
