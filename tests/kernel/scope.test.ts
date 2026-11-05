import { type Resource, rootScope, type Scope, ScopeClosedError } from '@/kernel/scope';

/** A resource that writes to a shared trace so ordering is observable. */
const tracked = (name: string, trace: string[], onAcquire?: () => void): Resource<string> => ({
  acquire: () => {
    onAcquire?.();
    trace.push(`acquire:${name}`);
    return name;
  },
  release: () => {
    trace.push(`release:${name}`);
  },
});

describe('kernel/scope', () => {
  it('releases resources in reverse acquisition order', async () => {
    const trace: string[] = [];
    const scope = rootScope('run');
    await scope.use(tracked('a', trace));
    await scope.use(tracked('b', trace));
    await scope.use(tracked('c', trace));
    await scope.close();
    expect(trace).toEqual([
      'acquire:a',
      'acquire:b',
      'acquire:c',
      'release:c',
      'release:b',
      'release:a',
    ]);
  });

  it('closes children before its own finalizers, newest child first', async () => {
    const trace: string[] = [];
    const root = rootScope('run');
    await root.use(tracked('root-res', trace));
    const first = root.child('first');
    const second = root.child('second');
    await first.use(tracked('first-res', trace));
    await second.use(tracked('second-res', trace));
    await root.close('done');
    expect(trace.slice(3)).toEqual(['release:second-res', 'release:first-res', 'release:root-res']);
    expect(first.closed()).toBe(true);
    expect(second.closed()).toBe(true);
  });

  it('cascades the abort down the whole tree before any finalizer runs', async () => {
    const trace: string[] = [];
    const root = rootScope('run');
    const child = root.child('walk');
    const grandchild = child.child('page');
    const seen: boolean[] = [];
    await grandchild.use({
      acquire: () => 1,
      release: () => {
        seen.push(root.signal.aborted, child.signal.aborted, grandchild.signal.aborted);
        trace.push('release');
      },
    });
    expect(grandchild.signal.aborted).toBe(false);
    await root.close('user-stop');
    expect(seen).toEqual([true, true, true]);
    expect(root.signal.reason).toBe('user-stop');
    expect(grandchild.signal.reason).toBe('user-stop');
    expect(trace).toEqual(['release']);
  });

  it('close is idempotent — finalizers run exactly once', async () => {
    const trace: string[] = [];
    const scope = rootScope('run');
    await scope.use(tracked('a', trace));
    await Promise.all([scope.close(), scope.close()]);
    await scope.close('again');
    expect(trace).toEqual(['acquire:a', 'release:a']);
    expect(scope.closed()).toBe(true);
  });

  it('a failing acquire releases everything already acquired, then rethrows', async () => {
    const trace: string[] = [];
    const scope = rootScope('run');
    await scope.use(tracked('a', trace));
    await scope.use(tracked('b', trace));
    const boom = new Error('acquire exploded');
    await expect(
      scope.use({
        acquire: () => {
          throw boom;
        },
        release: () => {
          trace.push('release:never');
        },
      }),
    ).rejects.toBe(boom);
    expect(trace).toEqual(['acquire:a', 'acquire:b', 'release:b', 'release:a']);
    expect(scope.closed()).toBe(true);
  });

  it('a closed scope owns no more work: no children, no resources', async () => {
    const scope: Scope = rootScope('run');
    await scope.close();
    expect(() => scope.child('late')).toThrow(ScopeClosedError);
    await expect(scope.use(tracked('late', []))).rejects.toBeInstanceOf(ScopeClosedError);
  });

  it('a resource acquired while the scope closes is released, not leaked', async () => {
    const trace: string[] = [];
    const scope = rootScope('run');
    const slow = scope.use({
      acquire: async () => {
        await Promise.resolve();
        trace.push('acquire:slow');
        return 'slow';
      },
      release: () => {
        trace.push('release:slow');
      },
    });
    const rejected = expect(slow).rejects.toBeInstanceOf(ScopeClosedError);
    await scope.close();
    await rejected;
    expect(trace).toEqual(['acquire:slow', 'release:slow']);
  });

  it('reports finalizer failures instead of swallowing them', async () => {
    const scope = rootScope('run');
    await scope.use({
      acquire: () => 1,
      release: () => {
        throw new Error('release failed');
      },
    });
    await expect(scope.close()).rejects.toBeInstanceOf(AggregateError);
    expect(scope.closed()).toBe(true);
  });

  it('gives every scope a path-shaped id', () => {
    const root = rootScope('run');
    const a = root.child('growth');
    const b = root.child('prune');
    expect(root.id).toBe('run');
    expect(a.id).toBe('run/growth#1');
    expect(b.id).toBe('run/prune#2');
    expect(a.child('walk').id).toBe('run/growth#1/walk#1');
  });
});
