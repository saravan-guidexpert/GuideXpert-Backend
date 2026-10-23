'use strict';

/**
 * One in-flight Mongo connect per process.
 *
 * Mongoose 9 openUri() returns immediately when readyState is already "connecting"
 * and does not wait for the in-flight attempt. A second mongoose.connect() also
 * constructs a new driver client without closing the previous one. This gate makes
 * concurrent callers share one attempt, and it waits on an existing client before
 * replacing it.
 */
function createConnectionGate({
  getReadyState,
  hasClient,
  connect,
  closeExisting,
  recoverTimeoutMs = 12000,
  pollIntervalMs = 100,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof getReadyState !== 'function') throw new Error('getReadyState is required');
  if (typeof hasClient !== 'function') throw new Error('hasClient is required');
  if (typeof connect !== 'function') throw new Error('connect is required');
  if (typeof closeExisting !== 'function') throw new Error('closeExisting is required');

  let pending = null;

  async function waitForExistingClient() {
    const started = Date.now();
    while (Date.now() - started < recoverTimeoutMs) {
      if (getReadyState() === 1) return true;
      await sleep(pollIntervalMs);
    }
    return getReadyState() === 1;
  }

  async function run() {
    if (getReadyState() === 1) return;
    if (hasClient()) {
      const recovered = await waitForExistingClient();
      if (recovered || getReadyState() === 1) return;
      await closeExisting();
    }
    if (getReadyState() === 1) return;
    await connect();
  }

  function ensure() {
    if (getReadyState() === 1) return Promise.resolve();
    if (pending) return pending;
    const attempt = run();
    pending = attempt;
    const clear = () => {
      if (pending === attempt) pending = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  return { ensure };
}

module.exports = { createConnectionGate };
