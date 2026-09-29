import { describe, expect, it } from 'vitest';
import { sortCronJobsByCreatedAt } from './cronJobSort.js';

describe('sortCronJobsByCreatedAt', () => {
  it('sorts valid ISO timestamps newest first', () => {
    const jobs = [
      { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
    ];

    expect(sortCronJobsByCreatedAt(jobs).map((job) => job.id)).toEqual(['new', 'old']);
  });

  it('places missing and invalid timestamps after valid timestamps', () => {
    const jobs = [
      { id: 'missing' },
      { id: 'valid', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'invalid', createdAt: 'not-a-date' },
    ];

    expect(sortCronJobsByCreatedAt(jobs).map((job) => job.id)).toEqual([
      'valid',
      'missing',
      'invalid',
    ]);
  });

  it('preserves input order for equal or invalid timestamps', () => {
    const jobs = [
      { id: 'equal-a', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'equal-b', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'invalid-a', createdAt: 'invalid-a' },
      { id: 'invalid-b', createdAt: 'invalid-b' },
    ];

    expect(sortCronJobsByCreatedAt(jobs).map((job) => job.id)).toEqual([
      'equal-a',
      'equal-b',
      'invalid-a',
      'invalid-b',
    ]);
  });

  it('does not mutate the input array', () => {
    const jobs = [
      { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
    ];
    const originalOrder = [...jobs];

    const sorted = sortCronJobsByCreatedAt(jobs);

    expect(jobs).toEqual(originalOrder);
    expect(sorted).not.toBe(jobs);
  });
});
