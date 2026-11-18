'use strict';

const ACTIVATION_TIME_ZONE = 'Asia/Kolkata';

function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  });
  map.hour %= 24;
  return map;
}

function timeZoneOffsetMs(timeZone, instant) {
  const parts = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

function formatActivationLocal(date, timeZone = ACTIVATION_TIME_ZONE) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const parts = zoneParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)} IST`;
}

/**
 * A value with Z or a numeric offset is an absolute instant.
 * A value without a zone is a wall-clock time in the configured timezone.
 * Nothing here substitutes the current time.
 */
function parseActivationInput(value, timeZone = ACTIVATION_TIME_ZONE) {
  const text = String(value == null ? '' : value).trim();
  const zone = String(timeZone || ACTIVATION_TIME_ZONE).trim();
  if (!text || zone !== ACTIVATION_TIME_ZONE) return null;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(text)) {
    const absolute = new Date(text);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = timeZoneOffsetMs(zone, new Date(wallAsUtc));
  let utc = wallAsUtc - offset;
  const offsetAtResult = timeZoneOffsetMs(zone, new Date(utc));
  if (offsetAtResult !== offset) utc = wallAsUtc - offsetAtResult;
  const date = new Date(utc);
  const local = zoneParts(date, zone);
  if (local.year !== year || local.month !== month || local.day !== day || local.hour !== hour || local.minute !== minute) {
    return null;
  }
  return date;
}

module.exports = {
  ACTIVATION_TIME_ZONE,
  formatActivationLocal,
  parseActivationInput
};
