import { bioMatchesFilter } from '@/engine/prune-bio-filter';

describe('bioMatchesFilter — protected-word match on a profile bio', () => {
  test('case-insensitive substring match, words or phrases', () => {
    expect(bioMatchesFilter('Dog mom 🐶 | photographer', ['dog'])).toBe(true);
    expect(bioMatchesFilter('DOG MOM', ['dog mom'])).toBe(true);
    expect(bioMatchesFilter('photographer in Oslo', ['Dog', 'oslo'])).toBe(true);
    expect(bioMatchesFilter('photographer in Oslo', ['dog', 'cat'])).toBe(false);
  });

  test('no configured words never matches', () => {
    expect(bioMatchesFilter('anything at all', [])).toBe(false);
  });

  test('an empty or unknown bio never matches', () => {
    expect(bioMatchesFilter('', ['dog'])).toBe(false);
    expect(bioMatchesFilter(undefined, ['dog'])).toBe(false);
  });

  test('blank filter entries are ignored (a stray space must not match every bio)', () => {
    expect(bioMatchesFilter('anything', [' ', ''])).toBe(false);
  });
});
