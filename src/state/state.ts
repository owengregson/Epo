import * as fs from 'fs';
import { AppState } from '../types';

export const createEmptyState = (target: string): AppState => ({
  target,
  generatedAt: new Date().toISOString(),
  scrapeCursor: null,
  followerList: [],
  nextFollowIndex: 0,
  followQueue: [],
  followHistory: [],
  pendingUnfollows: [],
  lastDailyPlan: null,
});

export const loadState = (filePath: string, target: string): AppState => {
  if (!fs.existsSync(filePath)) {
    return createEmptyState(target);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<AppState>;
  return {
    ...createEmptyState(target),
    ...parsed,
    target: target || parsed.target || '',
  };
};

export const saveState = (filePath: string, state: AppState): void => {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
};
