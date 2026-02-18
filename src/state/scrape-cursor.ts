import * as fs from 'fs';
import { ScrapeCursor } from '../types';

export const createEmptyCursor = (targetUsername: string): ScrapeCursor => ({
  targetUsername,
  totalCollected: 0,
  lastUserId: '',
  collectedUsernames: [],
  isComplete: false,
  lastScrapedAt: new Date().toISOString(),
  endCursor: '',
  hasNextPage: true,
});

export const loadCursor = (filePath: string, targetUsername: string): ScrapeCursor => {
  if (!fs.existsSync(filePath)) {
    return createEmptyCursor(targetUsername);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<ScrapeCursor>;
  if (parsed.targetUsername !== targetUsername) {
    return createEmptyCursor(targetUsername);
  }
  return { ...createEmptyCursor(targetUsername), ...parsed };
};

export const saveCursor = (filePath: string, cursor: ScrapeCursor): void => {
  fs.writeFileSync(filePath, JSON.stringify(cursor, null, 2));
};
