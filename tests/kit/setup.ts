/**
 * Jest `setupFilesAfterEach` hook: the one place the test log level is set.
 * Individual suites no longer need `beforeAll(() => setLevel('error'))`.
 */
import { setLevel } from '@/utils/logger';

setLevel('error');
