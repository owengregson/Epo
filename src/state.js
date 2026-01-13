const fs = require('fs');

const createEmptyState = (target) => ({
  target,
  generatedAt: new Date().toISOString(),
  followerList: [],
  nextFollowIndex: 0,
  followQueue: [],
  followHistory: [],
  pendingUnfollows: [],
  lastDailyPlan: null,
});

const loadState = (filePath, target) => {
  if (!fs.existsSync(filePath)) {
    return createEmptyState(target);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    ...createEmptyState(target),
    ...parsed,
    target: target || parsed.target,
  };
};

const saveState = (filePath, state) => {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
};

module.exports = {
  createEmptyState,
  loadState,
  saveState,
};
