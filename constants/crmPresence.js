'use strict';

/** Online only while a valid session's heartbeat is at least this recent. An unexpired session without one is idle. */
const PRESENCE_ONLINE_MS = 2 * 60 * 1000;

/** Skip a lastSeenAt write when the stored heartbeat is newer than this. The request still succeeds. */
const PRESENCE_WRITE_INTERVAL_MS = 30 * 1000;

const PRESENCE_HEARTBEAT_WINDOW_MS = 60 * 1000;

function heartbeatMaxPerWindow() {
  const raw = Number(process.env.CRM_PRESENCE_HEARTBEAT_MAX || 30);
  return Number.isInteger(raw) && raw > 0 ? raw : 30;
}

module.exports = {
  PRESENCE_ONLINE_MS,
  PRESENCE_WRITE_INTERVAL_MS,
  PRESENCE_HEARTBEAT_WINDOW_MS,
  heartbeatMaxPerWindow,
};
