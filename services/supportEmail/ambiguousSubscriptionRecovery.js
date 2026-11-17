'use strict';

const crypto = require('crypto');
const GraphSubscription = require('../../models/GraphSubscription');
const GraphSubscriptionOperation = require('../../models/GraphSubscriptionOperation');
const { logOperationalEvent, incrementMetric } = require('./observability');

/**
 * Ambiguous Microsoft Graph subscription-creation recovery policy.
 *
 * POST /subscriptions has no idempotency key. A timeout, connection reset, HTTP 408,
 * HTTP 429 or HTTP 5xx does not prove Graph failed to create the subscription, and it
 * does not prove Graph succeeded. This module does not invent such a guarantee.
 *
 * Listing subscriptions is also not a linearizable snapshot of a just-completed POST.
 * One complete enumeration that returns no match is NOT proof the POST failed, so it
 * must not authorize another POST.
 *
 * Policy:
 * 1. An expired pending operation whose POST was never dispatched may use ordinary
 *    stale-reservation recovery (the caller abandons it and may POST). That decision
 *    is not made here.
 * 2. An expired or due ambiguous operation — failed/ambiguous, or pending after
 *    graphPostDispatchedAt was set — enters this workflow. The reservation stays held.
 * 3. A known subscriptionId is loaded with GET /subscriptions/{id} and must match the
 *    operation's resource, notification URL, change type, lifecycle URL and clientState
 *    hash. A different subscription is never adopted in its place.
 * 4. Without a subscriptionId, GET /subscriptions is followed until @odata.nextLink is
 *    exhausted. List items are not identity-checked: Microsoft Graph does not return
 *    clientState on that collection. A truncated, failed or malformed enumeration
 *    adopts nothing and does not count as an absence observation.
 * 5. Candidates are the listed subscriptions whose resource, notification URL,
 *    change type, lifecycle URL and expiration match, plus any local GraphSubscription
 *    row already stored for this operation's clientState hash. Each candidate is
 *    loaded with GET /subscriptions/{id}. clientState is verified only on that
 *    detail body, using the caller's existing HMAC verification.
 * 6. Exactly one detail-verified match is upserted. The operation is marked completed
 *    and its reservation is released only after that write succeeds, and only by the
 *    worker that holds the recovery claim. A crash after the upsert is resumed from
 *    the stored row; it does not create a second local subscription and it does not
 *    POST.
 * 7. Zero configuration candidates on a complete enumeration increment
 *    absenceObservations and schedule the next check at least minRecheckDelayMs later.
 *    Observations that are closer together do not count.
 * 8. After requiredAbsenceObservations spaced complete misses, the terminal outcome is
 *    manual_required. The reservation stays held. Automatic workers must not POST.
 * 9. A failed detail GET, a detail body with no clientState, a detail clientState that
 *    does not verify, or more than one verified match is manual_required immediately.
 *    Nothing is adopted or deleted. Configuration matching alone is never enough.
 * 10. manual_required is not claimed by ordinary recovery. Only an authorized operator
 *    retry may claim it, and that retry still uses the same detail verification.
 * 9. Enumeration errors, pagination failures and malformed pages keep the operation
 *    unresolved and keep the reservation. They do not advance the absence count.
 *
 * Limitations:
 * - A POST that never reached Graph (for example a timeout after the socket was
 *   opened but before the request was written) cannot be distinguished from one that
 *   Graph committed. Both end in manual_required rather than another POST.
 * - manual_required does not expire and ordinary recovery will not claim it. An
 *   authorized operator retry may adopt a later exact detail match. The creation
 *   path will not poll forever and will not POST.
 * - Orphan deletion for the mailbox is suspended while one of these operations is
 *   unresolved, including after manual_required. This can retain a genuine extra
 *   remote subscription until an operator finishes recovery.
 * - clientState is verified and then discarded. It is never logged or persisted.
 */

const AMBIGUOUS_RECOVERY_POLICY = Object.freeze({
  requiredAbsenceObservations: 3,
  minRecheckDelayMs: 2 * 60 * 1000,
  recoveryClaimMs: 60 * 1000,
  leaseBufferMs: 60 * 1000,
  manualHoldMs: 24 * 60 * 60 * 1000,
  terminalOutcome: 'manual_required'
});

const DEFAULT_CHANGE_TYPE = 'created,updated';

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function normalizeChangeType(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

function isAmbiguousUnresolvedOperation(operation) {
  if (!operation) return false;
  if (operation.state === 'completed' || operation.state === 'abandoned') return false;
  if (operation.failureClassification === 'confirmed_rejection') return false;
  if (operation.state === 'failed' && operation.failureClassification === 'ambiguous') return true;
  if (operation.state === 'pending' && operation.graphPostDispatchedAt) return true;
  if (['enumerating', 'awaiting_recheck', 'manual_required', 'confirmed_absent'].includes(operation.recoveryState)) {
    return operation.state === 'pending' || operation.state === 'failed';
  }
  return false;
}

/**
 * Decides whether a holder may be abandoned, must stay blocked, or must enter recovery.
 * manual_required never falls through to a new POST, even after its lease date.
 * awaiting_recheck stays blocked until nextRecoveryAt, even if the lease is earlier.
 */
function ambiguousRecoveryDisposition(operation, now = new Date()) {
  if (!isAmbiguousUnresolvedOperation(operation)) return null;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (operation.recoveryState === 'manual_required') {
    return 'ambiguous_manual_recovery_required';
  }
  if (operation.recoveryState === 'awaiting_recheck') {
    const dueMs = operation.nextRecoveryAt ? new Date(operation.nextRecoveryAt).getTime() : 0;
    if (Number.isFinite(dueMs) && dueMs > nowMs) return 'active_reservation';
    return 'ambiguous_recovery_required';
  }
  const leaseMs = operation.leaseExpiresAt ? new Date(operation.leaseExpiresAt).getTime() : 0;
  if (!Number.isFinite(leaseMs) || leaseMs <= nowMs) return 'ambiguous_recovery_required';
  return 'active_reservation';
}

/**
 * Remote subscriptions that might belong to an unresolved creation must not be deleted.
 * This stays true after the creation lease expires. Confirmed rejections and abandoned
 * operations do not protect anything.
 */
function operationPreventsOrphanDeletion(operation, now = new Date()) {
  if (!operation) return false;
  if (operation.state === 'completed' || operation.state === 'abandoned') return false;
  if (operation.failureClassification === 'confirmed_rejection') return false;
  if (isAmbiguousUnresolvedOperation(operation)) return true;
  if (operation.subscriptionId && (operation.state === 'pending' || operation.state === 'failed')) return true;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const leaseMs = operation.leaseExpiresAt ? new Date(operation.leaseExpiresAt).getTime() : 0;
  if (!Number.isFinite(leaseMs) || leaseMs <= nowMs) return false;
  return operation.state === 'pending' || operation.state === 'failed';
}

async function findUnresolvedAmbiguousOperations({ mailbox, folder, excludeOperationId = null }) {
  const query = {
    mailbox,
    folder,
    state: { $in: ['pending', 'failed'] },
    // A confirmed rejection recorded graphPostDispatchedAt before Graph answered.
    // That timestamp must not keep a rejected create in the ambiguous workflow.
    failureClassification: { $ne: 'confirmed_rejection' },
    $or: [
      { failureClassification: 'ambiguous' },
      { state: 'pending', graphPostDispatchedAt: { $ne: null } },
      { recoveryState: { $in: ['enumerating', 'awaiting_recheck', 'manual_required', 'confirmed_absent'] } }
    ]
  };
  if (excludeOperationId) query.operationId = { $ne: excludeOperationId };
  return GraphSubscriptionOperation.find(query).sort({ updatedAt: 1 }).lean();
}

function reservationKeyFilter(reservationKey) {
  return reservationKey == null ? null : reservationKey;
}

function ownedFilter(operationId, reservationKey, workerId) {
  return {
    operationId,
    reservationKey: reservationKeyFilter(reservationKey),
    recoveryClaimedBy: workerId
  };
}

function sameReservationKey(left, right) {
  return reservationKeyFilter(left) === reservationKeyFilter(right);
}

function expectedChangeType(operation) {
  return operation.changeType || DEFAULT_CHANGE_TYPE;
}

function configurationMatches(remote, operation) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return false;
  if (!remote.id || typeof remote.id !== 'string') return false;
  const resourceOk = String(remote.resource || '').trim().toLowerCase() === String(operation.resource || '').trim().toLowerCase();
  const remoteUrl = normalizeUrl(remote.notificationUrl);
  const expectedUrl = normalizeUrl(operation.notificationUrl);
  const urlOk = Boolean(remoteUrl) && remoteUrl === expectedUrl;
  const remoteChange = normalizeChangeType(remote.changeType);
  const changeOk = Boolean(remoteChange) && remoteChange === normalizeChangeType(expectedChangeType(operation));
  let lifecycleOk = true;
  if (operation.lifecycleUrl) {
    const remoteLifecycle = normalizeUrl(remote.lifecycleNotificationUrl);
    lifecycleOk = Boolean(remoteLifecycle) && remoteLifecycle === normalizeUrl(operation.lifecycleUrl);
  }
  const expiration = remote.expirationDateTime ? new Date(remote.expirationDateTime) : null;
  const expirationOk = Boolean(expiration) && !Number.isNaN(expiration.getTime());
  return resourceOk && urlOk && changeOk && lifecycleOk && expirationOk;
}

/**
 * Verifies clientState from a GET /subscriptions/{id} body.
 * List responses are not passed here: Graph returns clientState as null on
 * GET /subscriptions, and that absence is not a hash mismatch.
 */
function identityMatches(remote, operation, verifyClientState) {
  if (!remote || typeof remote.clientState !== 'string' || !remote.clientState) return false;
  if (!operation.clientStateHash || !operation.clientStateHashScheme) return false;
  try {
    return verifyClientState(remote.clientState, operation) === true;
  } catch {
    return false;
  }
}

function dedupeById(subscriptions) {
  const byId = new Map();
  for (const subscription of subscriptions) {
    if (subscription && typeof subscription.id === 'string' && subscription.id && !byId.has(subscription.id)) {
      byId.set(subscription.id, subscription);
    }
  }
  return [...byId.values()];
}

function selectConfigurationCandidateIds(subscriptions, operation) {
  const ids = [];
  for (const remote of dedupeById(subscriptions)) {
    if (!configurationMatches(remote, operation)) continue;
    ids.push(remote.id);
  }
  return ids;
}

async function findPersistedAdoption(operation) {
  if (!operation?.clientStateHash || !operation?.clientStateHashScheme) return [];
  const query = {
    mailbox: operation.mailbox,
    folder: operation.folder || 'inbox',
    clientStateHash: operation.clientStateHash,
    clientStateHashScheme: operation.clientStateHashScheme,
    status: { $in: ['active', 'expired'] }
  };
  if (operation.clientStateKeyId) query.clientStateKeyId = operation.clientStateKeyId;
  return GraphSubscription.find(query).select('subscriptionId').lean();
}

/**
 * Loads every configuration candidate, and any local row already written for this
 * operation, with GET /subscriptions/{id}. clientState on the list payload is ignored.
 * A failed detail read or a detail body without clientState fails closed.
 */
async function verifyConfigurationCandidates({
  graphClient,
  operation,
  listed,
  verifyClientState
}) {
  const seen = new Set();
  const ids = [];
  for (const id of selectConfigurationCandidateIds(listed, operation)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const persisted = await findPersistedAdoption(operation);
  for (const row of persisted) {
    if (!row.subscriptionId || seen.has(row.subscriptionId)) continue;
    seen.add(row.subscriptionId);
    ids.push(row.subscriptionId);
  }
  if (ids.length === 0) return { kind: 'none' };

  const verified = [];
  let detailFailed = false;
  let clientStateMissing = false;
  let clientStateMismatch = false;

  for (const id of ids) {
    const lookup = await getRemoteSubscriptionById(graphClient, id);
    if (lookup.status !== 'found') {
      detailFailed = true;
      continue;
    }
    const remote = lookup.subscription;
    if (!configurationMatches(remote, operation)) {
      detailFailed = true;
      continue;
    }
    if (typeof remote.clientState !== 'string' || remote.clientState.length === 0) {
      clientStateMissing = true;
      continue;
    }
    if (identityMatches(remote, operation, verifyClientState)) verified.push(remote);
    else clientStateMismatch = true;
  }

  if (detailFailed) {
    return {
      kind: 'manual',
      reason: 'detail_lookup_failed',
      count: ids.length,
      lastError: 'A candidate subscription could not be loaded individually; automatic adoption was refused'
    };
  }
  if (clientStateMissing) {
    return {
      kind: 'manual',
      reason: 'client_state_unavailable',
      count: ids.length,
      lastError: 'A candidate subscription did not include clientState on its individual resource; automatic adoption was refused'
    };
  }
  if (verified.length > 1) {
    return {
      kind: 'manual',
      reason: 'multiple_matches',
      count: verified.length,
      lastError: 'Multiple Microsoft Graph subscriptions matched this operation; automatic adoption was refused'
    };
  }
  if (verified.length === 1) return { kind: 'one', match: verified[0] };
  if (clientStateMismatch) {
    return {
      kind: 'manual',
      reason: 'insufficient_match',
      count: ids.length,
      lastError: 'A remote subscription matched the mailbox configuration but not the clientState hash; automatic adoption was refused'
    };
  }
  return { kind: 'none' };
}

/**
 * Follows @odata.nextLink until the collection is complete.
 * A transport error, a malformed page, or a page ceiling returns an incomplete
 * result and drops every page already read so callers cannot adopt from a partial view.
 */
async function enumerateRemoteSubscriptions(graphClient, { maxPages = 10 } = {}) {
  const collected = [];
  let nextUrl = '/subscriptions';
  let pages = 0;

  while (nextUrl && pages < maxPages) {
    pages += 1;
    let response;
    try {
      response = await graphClient.request({ url: nextUrl, method: 'GET' });
    } catch (error) {
      return { completed: false, malformed: false, error, subscriptions: [], pages };
    }
    if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.value)) {
      return { completed: false, malformed: true, subscriptions: [], pages };
    }
    const nextLink = response['@odata.nextLink'];
    if (nextLink != null && typeof nextLink !== 'string') {
      return { completed: false, malformed: true, subscriptions: [], pages };
    }
    collected.push(...response.value);
    nextUrl = nextLink || null;
  }

  if (nextUrl) {
    return { completed: false, malformed: false, truncated: true, subscriptions: [], pages };
  }
  return { completed: true, malformed: false, subscriptions: collected, pages };
}

async function getRemoteSubscriptionById(graphClient, subscriptionId) {
  try {
    const data = await graphClient.request({
      url: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      method: 'GET'
    });
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'string' || !data.id) {
      return { status: 'malformed' };
    }
    if (data.id !== subscriptionId) return { status: 'malformed' };
    return { status: 'found', subscription: data };
  } catch (error) {
    if (error && (error.statusCode === 404 || error.response?.status === 404)) {
      return { status: 'not_found' };
    }
    return { status: 'error', error };
  }
}

function safeLog(level, event, fields) {
  logOperationalEvent(level, event, fields);
}

async function updateOwned(operationId, reservationKey, workerId, update) {
  return GraphSubscriptionOperation.findOneAndUpdate(
    ownedFilter(operationId, reservationKey, workerId),
    update,
    { new: true }
  ).lean();
}

async function scheduleAnotherLook({
  operationId,
  reservationKey,
  workerId,
  now,
  policy,
  absenceObservations,
  lastError,
  terminal
}) {
  if (terminal) {
    const holdUntil = new Date(now.getTime() + policy.manualHoldMs);
    const updated = await updateOwned(operationId, reservationKey, workerId, {
      $set: {
        recoveryState: 'manual_required',
        absenceObservations,
        nextRecoveryAt: null,
        leaseExpiresAt: holdUntil,
        recoveryClaimedBy: null,
        recoveryClaimExpiresAt: null,
        lastError
      }
    });
    return updated;
  }

  const nextRecoveryAt = new Date(now.getTime() + policy.minRecheckDelayMs);
  return updateOwned(operationId, reservationKey, workerId, {
    $set: {
      recoveryState: 'awaiting_recheck',
      absenceObservations,
      nextRecoveryAt,
      leaseExpiresAt: new Date(nextRecoveryAt.getTime() + policy.leaseBufferMs),
      recoveryClaimedBy: null,
      recoveryClaimExpiresAt: null,
      lastError
    }
  });
}

async function keepUnresolved({
  operationId,
  reservationKey,
  workerId,
  now,
  policy,
  reason,
  lastError,
  absenceObservations
}) {
  const updated = await scheduleAnotherLook({
    operationId,
    reservationKey,
    workerId,
    now,
    policy,
    absenceObservations,
    lastError,
    terminal: false
  });
  return {
    resolved: false,
    adopted: false,
    reason,
    operationId,
    absenceObservations,
    recoveryState: updated ? updated.recoveryState : 'awaiting_recheck',
    reservationHeld: true
  };
}

async function markManual({
  operationId,
  reservationKey,
  workerId,
  now,
  policy,
  reason,
  lastError,
  absenceObservations,
  count
}) {
  const updated = await scheduleAnotherLook({
    operationId,
    reservationKey,
    workerId,
    now,
    policy,
    absenceObservations,
    lastError,
    terminal: true
  });
  incrementMetric('subscription_recovery_manual_required', 1);
  safeLog('warn', 'support_email_subscription_recovery_manual_required', {
    operationId,
    reason,
    absenceObservations,
    matchCount: count || 0
  });
  return {
    resolved: false,
    adopted: false,
    reason,
    operationId,
    absenceObservations,
    recoveryState: updated ? updated.recoveryState : 'manual_required',
    reservationHeld: Boolean(updated && updated.reservationKey),
    count: count || 0
  };
}

async function adoptMatch({
  remote,
  operation,
  operationId,
  reservationKey,
  workerId,
  now,
  policy = AMBIGUOUS_RECOVERY_POLICY
}) {
  if (!operation.clientStateHash || !operation.clientStateHashScheme) {
    return markManual({
      operationId,
      reservationKey,
      workerId,
      now,
      policy,
      reason: 'insufficient_identity',
      lastError: 'Refusing to adopt a Graph subscription without local clientState hash metadata',
      absenceObservations: operation.absenceObservations || 0
    });
  }

  const subscriptionId = remote.id;
  const expirationDateTime = new Date(remote.expirationDateTime);
  const status = expirationDateTime.getTime() > now.getTime() ? 'active' : 'expired';
  let doc;
  try {
    doc = await GraphSubscription.findOneAndUpdate(
      { subscriptionId },
      {
        $set: {
          subscriptionId,
          mailbox: operation.mailbox,
          folder: operation.folder || 'inbox',
          resource: operation.resource,
          expirationDateTime,
          clientStateHash: operation.clientStateHash,
          clientStateHashScheme: operation.clientStateHashScheme,
          clientStateKeyId: operation.clientStateKeyId || null,
          status,
          notificationUrl: operation.notificationUrl,
          lifecycleUrl: operation.lifecycleUrl || null,
          lastRenewedAt: now,
          lastError: null
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    await GraphSubscription.updateMany(
      {
        mailbox: operation.mailbox,
        folder: operation.folder || 'inbox',
        subscriptionId: { $ne: subscriptionId },
        status: 'active'
      },
      { $set: { status: 'expired' } }
    );
  } catch (error) {
    await updateOwned(operationId, reservationKey, workerId, {
      $set: {
        recoveryState: 'awaiting_recheck',
        recoveryClaimedBy: null,
        recoveryClaimExpiresAt: null,
        nextRecoveryAt: new Date(now.getTime() + policy.minRecheckDelayMs),
        lastError: 'Adoption persistence failed; reservation retained'
      }
    });
    safeLog('error', 'support_email_subscription_recovery_persist_failed', {
      operationId,
      subscriptionId
    });
    return {
      resolved: false,
      adopted: false,
      reason: 'persistence_failed',
      operationId,
      reservationHeld: true,
      recoveryState: 'awaiting_recheck'
    };
  }

  let released;
  try {
    released = await updateOwned(operationId, reservationKey, workerId, {
      $set: {
        reservationKey: null,
        state: 'completed',
        completedAt: now,
        subscriptionId,
        recoveryState: 'none',
        recoveryClaimedBy: null,
        recoveryClaimExpiresAt: null,
        nextRecoveryAt: null,
        lastError: 'Adopted remote subscription during ambiguous recovery'
      }
    });
  } catch (error) {
    await updateOwned(operationId, reservationKey, workerId, {
      $set: {
        recoveryState: 'awaiting_recheck',
        recoveryClaimedBy: null,
        recoveryClaimExpiresAt: null,
        nextRecoveryAt: now,
        lastError: 'The Graph subscription was stored locally but the operation could not be completed. Reservation retained'
      }
    });
    safeLog('error', 'support_email_subscription_recovery_completion_failed', {
      operationId,
      subscriptionId
    });
    return {
      resolved: false,
      adopted: false,
      reason: 'completion_failed',
      operationId,
      subscription: doc,
      reservationHeld: true,
      recoveryState: 'awaiting_recheck'
    };
  }

  if (!released) {
    safeLog('warn', 'support_email_subscription_recovery_ownership_lost', {
      operationId,
      subscriptionId
    });
    return {
      resolved: false,
      adopted: false,
      reason: 'ownership_lost',
      operationId,
      subscription: doc,
      reservationHeld: true
    };
  }

  incrementMetric('subscription_recovery_adopted', 1);
  safeLog('info', 'support_email_subscription_recovery_adopted', {
    operationId,
    subscriptionId,
    mailbox: operation.mailbox,
    folder: operation.folder || 'inbox'
  });

  return {
    resolved: true,
    adopted: true,
    reason: 'adopted',
    operationId,
    subscription: doc,
    reservationHeld: false,
    recoveryState: 'none'
  };
}

async function recordAbsence({ operation, operationId, reservationKey, workerId, now, policy }) {
  const absenceObservations = (operation.absenceObservations || 0) + 1;
  const terminal = absenceObservations >= policy.requiredAbsenceObservations;
  if (operation.recoveryState === 'manual_required') {
    return markManual({
      operationId,
      reservationKey,
      workerId,
      now,
      policy,
      reason: 'manual_required',
      lastError: 'Ambiguous subscription recovery still requires manual resolution; a new POST will not be sent automatically',
      absenceObservations,
      count: 0
    });
  }
  if (terminal) {
    return markManual({
      operationId,
      reservationKey,
      workerId,
      now,
      policy,
      reason: 'manual_required',
      lastError: 'Bounded Graph rechecks did not establish a matching subscription. Absence is not treated as proof the POST failed, so another POST will not be sent automatically',
      absenceObservations,
      count: 0
    });
  }

  const updated = await scheduleAnotherLook({
    operationId,
    reservationKey,
    workerId,
    now,
    policy,
    absenceObservations,
    lastError: 'Complete Graph lookup found no matching subscription. This is not proof the original POST failed',
    terminal: false
  });
  incrementMetric('subscription_recovery_not_found', 1);
  safeLog('info', 'support_email_subscription_recovery_not_found', {
    operationId,
    mailbox: operation.mailbox,
    absenceObservations
  });
  return {
    resolved: false,
    adopted: false,
    reason: 'not_found_remotely',
    operationId,
    absenceObservations: updated ? updated.absenceObservations : absenceObservations,
    recoveryState: 'awaiting_recheck',
    reservationHeld: true,
    nextRecoveryAt: updated ? updated.nextRecoveryAt : null
  };
}

/**
 * Runs one recovery pass for an ambiguous creation operation.
 * Does not call POST /subscriptions and does not delete remote subscriptions.
 */
async function recoverAmbiguousSubscriptionOperation({
  operationId,
  reservationKey,
  graphClient,
  verifyClientState,
  now = new Date(),
  workerId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
  policy = AMBIGUOUS_RECOVERY_POLICY,
  maxPages = 10,
  allowManual = false,
  operator = null
}) {
  if (!operationId || !graphClient || typeof verifyClientState !== 'function') {
    return { resolved: false, adopted: false, reason: 'invalid_request', operationId: operationId || null };
  }

  const op = await GraphSubscriptionOperation.findOne({ operationId }).lean();
  if (!op) return { resolved: false, adopted: false, reason: 'not_found', operationId };
  if (!sameReservationKey(op.reservationKey, reservationKey)) {
    return { resolved: false, adopted: false, reason: 'ownership_mismatch', operationId, reservationHeld: true };
  }
  if (!isAmbiguousUnresolvedOperation(op)) {
    return { resolved: false, adopted: false, reason: 'not_ambiguous', operationId };
  }
  if (op.recoveryState === 'manual_required' && allowManual !== true) {
    return {
      resolved: false,
      adopted: false,
      reason: 'manual_required',
      operationId,
      recoveryState: 'manual_required',
      absenceObservations: op.absenceObservations || 0,
      reservationHeld: true
    };
  }
  if (op.recoveryState === 'manual_required' && !operator?.adminId) {
    return {
      resolved: false,
      adopted: false,
      reason: 'unauthorized',
      operationId,
      recoveryState: 'manual_required',
      reservationHeld: true
    };
  }
  if (
    op.recoveryState === 'awaiting_recheck' &&
    op.nextRecoveryAt &&
    new Date(op.nextRecoveryAt).getTime() > now.getTime()
  ) {
    return {
      resolved: false,
      adopted: false,
      reason: 'recheck_not_due',
      operationId,
      absenceObservations: op.absenceObservations || 0,
      nextRecoveryAt: op.nextRecoveryAt,
      recoveryState: op.recoveryState,
      reservationHeld: true
    };
  }

  const claimExpiresAt = new Date(now.getTime() + policy.recoveryClaimMs);
  const claim = await GraphSubscriptionOperation.findOneAndUpdate(
    {
      operationId,
      reservationKey: reservationKeyFilter(reservationKey),
      state: { $in: ['pending', 'failed'] },
      $and: [
        {
          $or: [
            { failureClassification: 'ambiguous' },
            { graphPostDispatchedAt: { $ne: null } },
            { recoveryState: { $in: ['enumerating', 'awaiting_recheck', 'manual_required', 'confirmed_absent'] } }
          ]
        },
        {
          $or: [
            { recoveryClaimedBy: null },
            { recoveryClaimExpiresAt: null },
            { recoveryClaimExpiresAt: { $lte: now } }
          ]
        }
      ]
    },
    {
      $set: {
        recoveryState: 'enumerating',
        recoveryClaimedBy: workerId,
        recoveryClaimExpiresAt: claimExpiresAt,
        failureClassification: 'ambiguous',
        ...(op.state === 'pending'
          ? {
            state: 'failed',
            lastError: op.lastError || 'Graph POST was dispatched but the outcome was not recorded'
          }
          : {})
      },
      $inc: { recoveryAttempts: 1 }
    },
    { new: true }
  ).lean();

  if (!claim) {
    const current = await GraphSubscriptionOperation.findOne({ operationId }).lean();
    if (current && current.recoveryClaimedBy && current.recoveryClaimExpiresAt && new Date(current.recoveryClaimExpiresAt).getTime() > now.getTime()) {
      return { resolved: false, adopted: false, reason: 'recovery_in_progress', operationId, reservationHeld: true };
    }
    return { resolved: false, adopted: false, reason: 'ownership_mismatch', operationId, reservationHeld: true };
  }

  if (claim.subscriptionId) {
    const lookup = await getRemoteSubscriptionById(graphClient, claim.subscriptionId);
    if (lookup.status === 'error' || lookup.status === 'malformed') {
      safeLog('warn', 'support_email_subscription_recovery_lookup_failed', {
        operationId,
        knownSubscription: true,
        malformed: lookup.status === 'malformed'
      });
      return keepUnresolved({
        operationId,
        reservationKey,
        workerId,
        now,
        policy,
        reason: lookup.status === 'malformed' ? 'malformed_response' : 'enumeration_incomplete',
        lastError: 'Exact subscription lookup did not complete; reservation retained',
        absenceObservations: claim.absenceObservations || 0
      });
    }
    if (lookup.status === 'not_found') {
      return recordAbsence({
        operation: claim,
        operationId,
        reservationKey,
        workerId,
        now,
        policy
      });
    }
    const remote = lookup.subscription;
    if (!configurationMatches(remote, claim) || !identityMatches(remote, claim, verifyClientState)) {
      return markManual({
        operationId,
        reservationKey,
        workerId,
        now,
        policy,
        reason: 'invalid_known_subscription',
        lastError: 'The known Microsoft Graph subscription did not match the expected mailbox configuration',
        absenceObservations: claim.absenceObservations || 0
      });
    }
    return adoptMatch({
      remote,
      operation: claim,
      operationId,
      reservationKey,
      workerId,
      now,
      policy
    });
  }

  const enumeration = await enumerateRemoteSubscriptions(graphClient, { maxPages });
  if (!enumeration.completed || enumeration.malformed || enumeration.error) {
    safeLog('warn', 'support_email_subscription_recovery_enumeration_failed', {
      operationId,
      mailbox: claim.mailbox,
      pages: enumeration.pages,
      malformed: Boolean(enumeration.malformed),
      truncated: Boolean(enumeration.truncated)
    });
    return keepUnresolved({
      operationId,
      reservationKey,
      workerId,
      now,
      policy,
      reason: enumeration.malformed ? 'malformed_response' : 'enumeration_incomplete',
      lastError: 'Graph subscription enumeration did not complete; reservation retained',
      absenceObservations: claim.absenceObservations || 0
    });
  }

  const decision = await verifyConfigurationCandidates({
    graphClient,
    operation: claim,
    listed: enumeration.subscriptions,
    verifyClientState
  });
  if (decision.kind === 'none') {
    return recordAbsence({
      operation: claim,
      operationId,
      reservationKey,
      workerId,
      now,
      policy
    });
  }
  if (decision.kind === 'manual') {
    return markManual({
      operationId,
      reservationKey,
      workerId,
      now,
      policy,
      reason: decision.reason,
      lastError: decision.lastError,
      absenceObservations: claim.absenceObservations || 0,
      count: decision.count
    });
  }

  return adoptMatch({
    remote: decision.match,
    operation: claim,
    operationId,
    reservationKey,
    workerId,
    now,
    policy
  });
}

module.exports = {
  AMBIGUOUS_RECOVERY_POLICY,
  DEFAULT_CHANGE_TYPE,
  isAmbiguousUnresolvedOperation,
  ambiguousRecoveryDisposition,
  operationPreventsOrphanDeletion,
  findUnresolvedAmbiguousOperations,
  enumerateRemoteSubscriptions,
  recoverAmbiguousSubscriptionOperation,
  selectConfigurationCandidateIds,
  verifyConfigurationCandidates,
  configurationMatches,
  normalizeChangeType,
  normalizeUrl
};
