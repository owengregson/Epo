const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmptyState, loadState, saveState } = require('../src/state');

describe('state persistence', () => {
  it('creates empty state when file missing', () => {
    const state = createEmptyState('target');
    expect(state.target).toBe('target');
    expect(state.followerList).toEqual([]);
  });

  it('loads and saves state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-'));
    const file = path.join(dir, 'state.json');

    const state = createEmptyState('target');
    state.nextFollowIndex = 5;
    saveState(file, state);

    const loaded = loadState(file, 'target');
    expect(loaded.nextFollowIndex).toBe(5);
  });
});
