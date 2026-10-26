'use strict';

const { CrmError } = require('./crmError');
const {
  CRM_ANALYTICS_MAX_DAYS,
  CRM_CALENDAR_MAX_DAYS,
  CRM_VOLUME_MAX_MONTHS,
} = require('../constants/crm');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const PERIODS = ['7', '30', '90', 'month', 'year', 'custom', 'all'];

function pad(value) {
  return String(value).padStart(2, '0');
}

function assertTimeZone(value) {
  const timeZone = value == null || value === '' ? 'UTC' : String(value).trim();
  if (!timeZone || timeZone.length > 64) {
    throw new CrmError(400, 'timeZone is not a valid IANA timezone.', 'invalid_timezone');
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone });
  } catch (err) {
    throw new CrmError(400, 'timeZone is not a valid IANA timezone.', 'invalid_timezone');
  }
  return timeZone;
}

function partsInZone(date, timeZone) {
  const bag = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') bag[part.type] = part.value;
  });
  let year = Number(bag.year);
  let month = Number(bag.month);
  let day = Number(bag.day);
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year,
    month,
    day,
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function zonedTimeToUtc(year, month, day, hour, minute, second, millisecond, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  for (let pass = 0; pass < 3; pass += 1) {
    const local = partsInZone(new Date(utc), timeZone);
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, millisecond);
    const desired = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    const delta = asUtc - desired;
    if (delta === 0) return new Date(utc);
    utc -= delta;
  }
  return new Date(utc);
}

function parseDateKey(value, label) {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) {
    throw new CrmError(400, `${label} must be a YYYY-MM-DD date.`, 'invalid_date');
  }
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new CrmError(400, `${label} is not a real calendar date.`, 'invalid_date');
  }
  return value;
}

function parseMonthKey(value) {
  if (typeof value !== 'string' || !MONTH_KEY.test(value)) {
    throw new CrmError(400, 'month must be YYYY-MM.', 'invalid_date');
  }
  const [year, month] = value.split('-').map(Number);
  if (month < 1 || month > 12) {
    throw new CrmError(400, 'month is not a real calendar month.', 'invalid_date');
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${value}-01`,
    to: `${value}-${pad(last)}`,
  };
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function inclusiveDayCount(fromKey, toKey) {
  const [fromYear, fromMonth, fromDay] = fromKey.split('-').map(Number);
  const [toYear, toMonth, toDay] = toKey.split('-').map(Number);
  const diff = Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000
  );
  return diff + 1;
}

function todayKey(now, timeZone) {
  const parts = partsInZone(now, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function boundsForKeys(fromKey, toKey, timeZone) {
  return {
    from: fromKey,
    to: toKey,
    start: zonedTimeToUtc(...fromKey.split('-').map(Number), 0, 0, 0, 0, timeZone),
    end: zonedTimeToUtc(...toKey.split('-').map(Number), 23, 59, 59, 999, timeZone),
    days: inclusiveDayCount(fromKey, toKey),
  };
}

function assertOrdered(fromKey, toKey) {
  if (fromKey > toKey) {
    throw new CrmError(400, 'from must be on or before to.', 'invalid_range');
  }
}

function assertSpan(days, max) {
  if (days > max) {
    throw new CrmError(400, `Date ranges can cover at most ${max} days.`, 'range_too_long');
  }
}

function resolveListRange(query) {
  const source = query || {};
  const hasFrom = source.from != null && source.from !== '';
  const hasTo = source.to != null && source.to !== '';
  if (!hasFrom && !hasTo) {
    if (source.timeZone != null && source.timeZone !== '') assertTimeZone(source.timeZone);
    return null;
  }
  if (!hasFrom || !hasTo) {
    throw new CrmError(400, 'from and to must both be provided.', 'invalid_date');
  }
  const timeZone = assertTimeZone(source.timeZone);
  const from = parseDateKey(String(source.from), 'from');
  const to = parseDateKey(String(source.to), 'to');
  assertOrdered(from, to);
  const bounds = boundsForKeys(from, to, timeZone);
  assertSpan(bounds.days, CRM_ANALYTICS_MAX_DAYS);
  return { timeZone, ...bounds };
}

function resolveAnalyticsRange(query, now = new Date()) {
  const source = query || {};
  const timeZone = assertTimeZone(source.timeZone);
  const period = source.period == null || source.period === '' ? '30' : String(source.period);
  if (!PERIODS.includes(period)) {
    throw new CrmError(400, 'period must be 7, 30, 90, month, year, custom, or all.', 'invalid_query');
  }
  if (period === 'all') {
    return {
      timeZone,
      id: 'all',
      label: 'All time',
      start: null,
      end: null,
      from: null,
      to: null,
      days: null,
      grain: 'month',
    };
  }
  const today = todayKey(now, timeZone);
  let fromKey;
  let toKey;
  let label;
  if (period === '7' || period === '30' || period === '90') {
    const days = Number(period);
    toKey = today;
    fromKey = shiftDateKey(today, -(days - 1));
    label = `Last ${days} days`;
  } else if (period === 'month') {
    fromKey = `${today.slice(0, 7)}-01`;
    toKey = today;
    label = 'This month';
  } else if (period === 'year') {
    fromKey = `${today.slice(0, 4)}-01-01`;
    toKey = today;
    label = 'This year';
  } else {
    if (source.from == null || source.from === '' || source.to == null || source.to === '') {
      throw new CrmError(400, 'from and to are required for a custom period.', 'invalid_date');
    }
    fromKey = parseDateKey(String(source.from), 'from');
    toKey = parseDateKey(String(source.to), 'to');
    assertOrdered(fromKey, toKey);
    label = 'Custom range';
  }
  const bounds = boundsForKeys(fromKey, toKey, timeZone);
  assertSpan(bounds.days, CRM_ANALYTICS_MAX_DAYS);
  return {
    timeZone,
    id: period,
    label,
    grain: bounds.days <= 31 ? 'day' : 'month',
    ...bounds,
  };
}

function resolveCalendarRange(query) {
  const source = query || {};
  const timeZone = assertTimeZone(source.timeZone);
  const hasDay = source.day != null && source.day !== '';
  const hasMonth = source.month != null && source.month !== '';
  const hasFrom = source.from != null && source.from !== '';
  const hasTo = source.to != null && source.to !== '';
  const modes = [hasDay, hasMonth, hasFrom || hasTo].filter(Boolean).length;
  if (modes !== 1) {
    throw new CrmError(400, 'Provide a day, a month, or a from and to range.', 'invalid_query');
  }
  if ((hasFrom && !hasTo) || (!hasFrom && hasTo)) {
    throw new CrmError(400, 'from and to must both be provided.', 'invalid_date');
  }
  let fromKey;
  let toKey;
  if (hasDay) {
    fromKey = parseDateKey(String(source.day), 'day');
    toKey = fromKey;
  } else if (hasMonth) {
    const month = parseMonthKey(String(source.month));
    fromKey = month.from;
    toKey = month.to;
  } else {
    fromKey = parseDateKey(String(source.from), 'from');
    toKey = parseDateKey(String(source.to), 'to');
    assertOrdered(fromKey, toKey);
  }
  const bounds = boundsForKeys(fromKey, toKey, timeZone);
  assertSpan(bounds.days, CRM_CALENDAR_MAX_DAYS);
  return { timeZone, ...bounds };
}

function previousBounds(range) {
  // Same millisecond length as the demo previousRange. This is intentional.
  // A previous period aligned to local calendar dates is a separate product decision.
  if (!range || !range.start || !range.end) return null;
  const length = range.end.getTime() - range.start.getTime();
  const end = new Date(range.start.getTime() - 1);
  return { start: new Date(end.getTime() - length), end };
}

function eachDateKey(fromKey, toKey) {
  const keys = [];
  let cursor = fromKey;
  while (cursor && cursor <= toKey && keys.length < CRM_CALENDAR_MAX_DAYS + 1) {
    keys.push(cursor);
    const next = shiftDateKey(cursor, 1);
    if (next === cursor) break;
    cursor = next;
  }
  return keys;
}

function shiftMonthKey(monthKey, delta) {
  const [year, month] = monthKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}`;
}

function eachMonthKey(fromKey, toKey) {
  const keys = [];
  let year = Number(fromKey.slice(0, 4));
  let month = Number(fromKey.slice(5, 7));
  const endYear = Number(toKey.slice(0, 4));
  const endMonth = Number(toKey.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${pad(month)}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
    if (keys.length > CRM_VOLUME_MAX_MONTHS) break;
  }
  return keys;
}

function monthWindow(firstMonth, lastMonth, max = CRM_VOLUME_MAX_MONTHS) {
  const [fromYear, fromMonth] = firstMonth.split('-').map(Number);
  const [toYear, toMonth] = lastMonth.split('-').map(Number);
  const span = (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
  const start = span > max ? shiftMonthKey(lastMonth, -(max - 1)) : firstMonth;
  return {
    truncated: span > max,
    months: eachMonthKey(`${start}-01`, `${lastMonth}-01`),
  };
}

function dayLabel(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function monthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1, 12)));
}

module.exports = {
  assertTimeZone,
  parseDateKey,
  resolveListRange,
  resolveAnalyticsRange,
  resolveCalendarRange,
  previousBounds,
  eachDateKey,
  eachMonthKey,
  monthWindow,
  dayLabel,
  monthLabel,
  shiftDateKey,
  inclusiveDayCount,
  zonedTimeToUtc,
};
