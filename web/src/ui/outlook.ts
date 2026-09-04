/**
 * The plain-language NWS outlook, folded into one column per day.
 *
 * Pure. NWS publishes day and night as separate periods with their own
 * headline and precipitation chance; a seven-day strip wants them paired.
 */

export type Period = {
  name: string;
  start: number;
  end: number;
  isDaytime: boolean;
  temp: number;
  tempUnit: string;
  windSpeed: string;
  windDirection: string;
  short: string;
  detailed: string;
  pop: number | null;
};

export type OutlookDay = {
  label: string;
  /** Span on the time axis, so the day ruler can place the column. */
  start: number;
  end: number;
  high: number | null;
  low: number | null;
  /** The worse of the day's and night's chances. */
  pop: number | null;
  short: string;
  wind: string;
  tempUnit: string;
};

const DAYS = 7;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parsePeriods(raw: unknown): Period[] {
  if (raw == null || typeof raw !== 'object') {
    return [];
  }
  const list = (raw as { periods?: unknown }).periods;
  if (!Array.isArray(list)) {
    return [];
  }
  const out: Period[] = [];
  for (const row of list) {
    if (row == null || typeof row !== 'object') {
      continue;
    }
    const r = row as Record<string, unknown>;
    const start = Date.parse(str(r.start));
    const end = Date.parse(str(r.end));
    // A period whose time will not parse would sort to 1970 and drag the
    // whole strip with it.
    if (!Number.isFinite(start)) {
      continue;
    }
    out.push({
      name: str(r.name),
      start,
      end: Number.isFinite(end) ? end : start,
      isDaytime: r.isDaytime === true,
      temp: int(r.temp) ?? 0,
      tempUnit: str(r.tempUnit) || 'F',
      windSpeed: str(r.windSpeed),
      windDirection: str(r.windDirection),
      short: str(r.short),
      detailed: str(r.detailed),
      pop: int(r.pop),
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * One column per day, capped at a week.
 *
 * A daytime period opens a column and a following night closes it, so
 * "Tonight" alone at the head of the list stays its own column rather than
 * being folded into a day that is already over.
 */
export function dailyOutlook(periods: Period[]): OutlookDay[] {
  const days: OutlookDay[] = [];
  for (const p of periods) {
    const open = days[days.length - 1];
    if (p.isDaytime || open == null || open.low != null) {
      if (days.length >= DAYS) {
        break;
      }
      days.push({
        label: p.name,
        start: p.start,
        end: p.end,
        high: p.isDaytime ? p.temp : null,
        low: p.isDaytime ? null : p.temp,
        pop: p.pop,
        short: p.short,
        wind: [p.windDirection, p.windSpeed].filter(Boolean).join(' '),
        tempUnit: p.tempUnit,
      });
      continue;
    }
    open.low = p.temp;
    open.end = p.end;
    if (p.pop != null && (open.pop == null || p.pop > open.pop)) {
      open.pop = p.pop;
    }
  }
  return days.slice(0, DAYS);
}
