import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dailyOutlook, parsePeriods, type Period } from './outlook.ts';

const p = (o: Partial<Period>): Period => ({
  name: 'Today',
  start: Date.parse('2026-09-04T12:00:00Z'),
  end: Date.parse('2026-09-04T23:00:00Z'),
  isDaytime: true,
  temp: 88,
  tempUnit: 'F',
  windSpeed: '10 mph',
  windDirection: 'SE',
  short: 'Sunny',
  detailed: '',
  pop: null,
  ...o,
});

describe('parsePeriods', () => {
  it('reads the server payload', () => {
    const out = parsePeriods({
      periods: [
        {
          name: 'This Afternoon',
          start: '2026-09-04T17:00:00Z',
          end: '2026-09-04T23:00:00Z',
          isDaytime: true,
          temp: 88,
          tempUnit: 'F',
          windSpeed: '10 mph',
          windDirection: 'SE',
          short: 'Scattered Showers',
          detailed: 'Showers likely.',
          pop: 60,
        },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.temp, 88);
    assert.equal(out[0]!.pop, 60);
    assert.equal(out[0]!.start, Date.parse('2026-09-04T17:00:00Z'));
  });

  it('skips a period with an unusable time rather than dating it to 1970', () => {
    assert.deepEqual(parsePeriods({ periods: [{ name: 'x', start: 'nope' }] }), []);
    assert.deepEqual(parsePeriods(null), []);
  });
});

describe('dailyOutlook', () => {
  // NWS publishes day and night as separate periods. A 7-day strip wants one
  // column per day carrying the high, the low, and the worse of the two
  // precipitation chances.
  it('folds day and night into one column', () => {
    const days = dailyOutlook([
      p({ name: 'Thursday', isDaytime: true, temp: 88, pop: 20, short: 'Sunny' }),
      p({
        name: 'Thursday Night',
        isDaytime: false,
        temp: 74,
        pop: 60,
        short: 'Showers',
        start: Date.parse('2026-09-05T00:00:00Z'),
        end: Date.parse('2026-09-05T12:00:00Z'),
      }),
    ]);
    assert.equal(days.length, 1);
    assert.equal(days[0]!.label, 'Thursday');
    assert.equal(days[0]!.high, 88);
    assert.equal(days[0]!.low, 74);
    assert.equal(days[0]!.pop, 60, 'the worse of the two chances');
    assert.equal(days[0]!.short, 'Sunny', 'the daytime headline');
    // The ruler positions each day at its real place on the time axis, so a
    // column has to carry its own span, not just its label.
    assert.equal(days[0]!.start, Date.parse('2026-09-04T12:00:00Z'));
    assert.equal(days[0]!.end, Date.parse('2026-09-05T12:00:00Z'), 'closed by the night period');
  });

  it('keeps a night-only trailing period as its own column', () => {
    const days = dailyOutlook([p({ name: 'Tonight', isDaytime: false, temp: 74 })]);
    assert.equal(days.length, 1);
    assert.equal(days[0]!.label, 'Tonight');
    assert.equal(days[0]!.low, 74);
    assert.equal(days[0]!.high, null);
    assert.equal(days[0]!.end, Date.parse('2026-09-04T23:00:00Z'));
  });

  it('caps at seven days', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      p({ name: `D${i}`, isDaytime: i % 2 === 0, start: Date.parse('2026-09-04T12:00:00Z') + i * 12 * 3600_000 }),
    );
    assert.equal(dailyOutlook(many).length, 7);
  });
});
