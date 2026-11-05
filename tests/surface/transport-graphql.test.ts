/**
 * The GraphQL envelope (spec §10.5): the error text over every entry and text key; a refusal
 * signature is a wall; errors without data wait like a wall; errors beside data are partial.
 */
import { graphqlEnvelope, graphqlErrorText } from '@/surface/transport/graphql';
import { GRAPHQL } from '@/surface/versions/2026-08-12/transport-decl';

const SIGNATURES = [
  { pattern: /feedback_required|try again later/i, status: 'action-blocked' },
  { pattern: /login_required/i, status: 'logged-out' },
  { pattern: /checkpoint_required/i, status: 'challenge' },
];
const userPresent = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && (data as { user?: unknown }).user != null;
const envelope = (json: unknown) => graphqlEnvelope(json, userPresent, GRAPHQL, SIGNATURES);

describe('graphqlErrorText', () => {
  test('joins message, summary and description over every entry (U07 M2)', () => {
    const json = { errors: [{ message: 'oops', summary: 'Try Again Later' }, { description: 'We limit how often' }] };
    expect(graphqlErrorText(json, GRAPHQL)).toBe('oops — Try Again Later — We limit how often');
  });

  test('null without an errors array or text', () => {
    expect(graphqlErrorText({ data: {} }, GRAPHQL)).toBeNull();
    expect(graphqlErrorText({ errors: [{ code: 1 }] }, GRAPHQL)).toBeNull();
  });
});

describe('graphqlEnvelope', () => {
  test('a body with neither errors nor data is not GraphQL', () => {
    expect(envelope({ users: [] })).toEqual({ kind: 'not-graphql' });
    expect(envelope('text')).toEqual({ kind: 'not-graphql' });
  });

  test('a clean body is data', () => {
    expect(envelope({ data: { user: { pk: '1' } } })).toEqual({ kind: 'data', errors: 0 });
  });

  test('a refusal signature in any entry or text key is a wall', () => {
    expect(envelope({ data: null, errors: [{ message: 'x' }, { summary: 'Try Again Later' }] })).toEqual({
      kind: 'wall', status: 'action-blocked', text: 'x — Try Again Later',
    });
    expect(envelope({ data: { user: { pk: '1' } }, errors: [{ message: 'login_required' }] })).toMatchObject({
      kind: 'wall', status: 'logged-out',
    });
  });

  test('errors without the declared root are an error to wait out; errors beside it are partial data', () => {
    expect(envelope({ data: { user: null }, errors: [{ message: 'unknown' }] })).toEqual({ kind: 'error', text: 'unknown' });
    expect(envelope({ errors: [{ message: 'unknown' }] })).toEqual({ kind: 'error', text: 'unknown' });
    expect(envelope({ data: { user: { pk: '1' } }, errors: [{ message: 'unknown' }] })).toEqual({ kind: 'data', errors: 1 });
  });
});
