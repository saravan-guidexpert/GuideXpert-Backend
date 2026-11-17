'use strict';

function formatScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available';
  return String(value);
}

function formatScorePair(obtained, total) {
  const hasTotal = typeof total === 'number' && Number.isFinite(total);
  if (typeof obtained !== 'number' || !Number.isFinite(obtained)) {
    return hasTotal ? `Not available / ${formatScore(total)}` : 'Not available';
  }
  if (!hasTotal) return formatScore(obtained);
  return `${formatScore(obtained)} / ${formatScore(total)}`;
}

function formatPercentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}%`;
}

function formatDuration(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 'Not available';
  const totalSeconds = Math.round(minutes * 60);
  if (totalSeconds <= 0) return '0 min';
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hr`);
  if (mins) parts.push(`${mins} min`);
  if (secs) parts.push(`${secs} sec`);
  return parts.join(' ') || '0 min';
}

function formatInvitedOn(iso) {
  if (!iso) return 'Not available';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

module.exports = {
  formatScore,
  formatScorePair,
  formatPercentage,
  formatDuration,
  formatInvitedOn,
};
