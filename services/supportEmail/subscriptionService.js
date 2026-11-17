'use strict';

const crypto = require('crypto');
const GraphSubscription = require('../../models/GraphSubscription');
const GraphSubscriptionOperation = require('../../models/GraphSubscriptionOperation');
const SupportEmailAuditLog = require('../../models/SupportEmailAuditLog');
const { GraphClient } = require('./graphClient');
const { signalMailboxSync } = require('./mailboxSyncService');
const { SUBSCRIPTION_STATUSES } = require('../../constants/supportEmail');
const { logOperationalEvent, incrementMetric, summarizeError } = require('./observability');
const {
  AMBIGUOUS_RECOVERY_POLICY,
  isAmbiguousUnresolvedOperation,
  ambiguousRecoveryDisposition,
  operationPreventsOrphanDeletion,
  findUnresolvedAmbiguousOperations,
  recoverAmbiguousSubscriptionOperation
} = require('./ambiguousSubscriptionRecovery');

const HASH_SCHEMES = Object.freeze({
  HMAC_SHA256: 'hmac-sha256',
  SHA256: 'sha256'
});

/**
 * Validates that HMAC-SHA256 key configuration is valid before creating a subscription.
 *
 * Rules:
 * - MS_GRAPH_CLIENT_STATE_SECRET must be present (non-empty string).
 * - MS_GRAPH_CLIENT_STATE_KEY_ID must be present (non-empty string).
 * - If a previous key is set, its ID must differ from the primary key ID to prevent ambiguous
 *   key selection during rotation (a collision would cause the verifier to try two copies of the
 *   same key, harmlessly, but indicates a misconfiguration).
 *
 * Throws an Error when configuration is invalid. Never silently falls back to unkeyed SHA-256
 * for new subscriptions unless `allowUnkeyed` is explicitly set (test-only escape hatch).
 *
 * @param {Object} [env] Environment override (defaults to process.env)
 * @param {boolean} [allowUnkeyed] If true, skip validation (for explicitly-testing unkeyed path)
 * @returns {{ primarySecret: string, primaryKeyId: string, scheme: string }} Validated credentials
 */
function validateHmacKeyConfig(env = process.env, allowUnkeyed = false) {
  const primarySecret = env.MS_GRAPH_CLIENT_STATE_SECRET || '';
  const primaryKeyId = env.MS_GRAPH_CLIENT_STATE_KEY_ID || '';
  const previousSecret = env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS || '';
  const previousKeyId = env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID || '';

  const isProductionOrStaging = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';

  if (isProductionOrStaging && allowUnkeyed) {
    throw new Error(
      '[SubscriptionService] SECURITY ERROR: Creating unkeyed subscriptions is strictly forbidden in production and staging environments.'
    );
  }

  if (!allowUnkeyed) {
    if (!primarySecret) {
      throw new Error(
        '[SubscriptionService] CONFIGURATION ERROR: MS_GRAPH_CLIENT_STATE_SECRET is required. ' +
        'Creating unkeyed subscriptions is not permitted. ' +
        'Set MS_GRAPH_CLIENT_STATE_SECRET to a strong random secret before creating Graph subscriptions.'
      );
    }
    if (!primaryKeyId) {
      throw new Error(
        '[SubscriptionService] CONFIGURATION ERROR: MS_GRAPH_CLIENT_STATE_KEY_ID is required when ' +
        'MS_GRAPH_CLIENT_STATE_SECRET is configured. Set it to a stable identifier (e.g. "primary", "v1") ' +
        'that uniquely names this key version for safe rotation tracking.'
      );
    }
    if (previousSecret && !previousKeyId) {
      throw new Error(
        '[SubscriptionService] CONFIGURATION ERROR: MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID is required ' +
        'when MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS is configured. ' +
        'Each key must have a distinct identifier for unambiguous key selection.'
      );
    }
    if (previousKeyId && primaryKeyId === previousKeyId) {
      throw new Error(
        '[SubscriptionService] CONFIGURATION ERROR: MS_GRAPH_CLIENT_STATE_KEY_ID and ' +
        'MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID must not be identical ("' + primaryKeyId + '"). ' +
        'Identical key IDs make versioned key selection ambiguous during rotation. ' +
        'Use distinct identifiers such as "v1" and "v2".'
      );
    }
  }

  return {
    primarySecret,
    primaryKeyId: primarySecret ? primaryKeyId : 'unkeyed',
    scheme: primarySecret ? HASH_SCHEMES.HMAC_SHA256 : HASH_SCHEMES.SHA256
  };
}

// Microsoft Graph subscription limits:
// For message resources, maximum lifetime is 4230 minutes (~2.93 days).
// Default expiration: 4200 minutes (~2.91 days).
const DEFAULT_EXPIRATION_MINUTES = 4200;
const MIN_EXPIRATION_MARGIN_HOURS = 24;

/**
 * Computes SHA-256 hash or keyed HMAC of clientState for secure verification at rest.
 * An explicit HMAC scheme with no secret throws rather than downgrading to unkeyed SHA-256.
 * Unkeyed SHA-256 is only produced when the effective scheme is explicitly 'sha256'.
 */
function hashClientState(
  clientState,
  secret = process.env.MS_GRAPH_CLIENT_STATE_SECRET,
  scheme = null
) {
  if (!clientState || typeof clientState !== 'string') return '';
  const effectiveScheme = scheme || (secret ? HASH_SCHEMES.HMAC_SHA256 : HASH_SCHEMES.SHA256);
  if (effectiveScheme === HASH_SCHEMES.HMAC_SHA256) {
    if (!secret) {
      // Fail closed: an HMAC-labelled record must never be hashed with unkeyed SHA-256.
      throw new Error(
        '[SubscriptionService] HMAC-SHA256 clientState hashing requested without a secret. ' +
        'Refusing to silently fall back to unkeyed SHA-256.'
      );
    }
    return crypto.createHmac('sha256', secret).update(clientState).digest('hex');
  }
  return crypto.createHash('sha256').update(clientState).digest('hex');
}

/**
 * Generates a cryptographically strong random clientState string.
 */
function generateClientState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Constant-time comparison for secrets to prevent timing attacks.
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Network/transport error codes that never prove the request failed before reaching Graph.
 * A socket may have been reset after Microsoft processed the POST, so these are always ambiguous.
 */
const AMBIGUOUS_NETWORK_CODES = Object.freeze([
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
]);

/**
 * Classifies a Graph API error into confirmed rejection vs ambiguous network failure.
 *
 * Confirmed rejections (HTTP 400, 401, 403, 404, 405, 413, 422) prove that Microsoft Graph
 * explicitly parsed and rejected the request without creating a subscription.
 * HTTP 409 on POST /subscriptions means a subscription with the same changeType and
 * resource already exists. It is ambiguous: the reservation stays held and discovery
 * runs. This classifier is only applied to subscription creation. Other 4xx stay
 * confirmed rejections.
 *
 * Ambiguous outcomes mean the client cannot prove Graph did not create the subscription:
 * request timeouts, connection resets, socket hang-ups, HTTP 408, HTTP 429, HTTP 5xx, malformed
 * success responses, and any unknown failure. A network timeout never proves the POST failed.
 *
 * @param {Error} err
 * @returns {'confirmed_rejection' | 'ambiguous'}
 */
function classifyGraphError(err) {
  if (!err) return 'ambiguous';
  // GraphClient sets this when a non-idempotent POST must not be treated as a
  // confirmed rejection, including a 401 that did not prove pre-processing rejection.
  if (err.ambiguousOutcome === true) return 'ambiguous';

  const status = Number(err.statusCode || err.response?.status || 0);
  const code = String(err.code || '').toUpperCase();

  // Transport-level failures are always ambiguous, even when a wrapper attaches a status.
  if (AMBIGUOUS_NETWORK_CODES.includes(code)) {
    return 'ambiguous';
  }

  // HTTP 408 is a client-visible timeout: the request may still have been processed by Graph.
  if (status === 408) {
    return 'ambiguous';
  }

  // Duplicate changeType + resource. Graph may already hold the subscription from this
  // POST or from an earlier one. Do not treat that as proof nothing was created.
  if (status === 409) {
    return 'ambiguous';
  }

  // Throttling and server/gateway errors may occur after Graph committed the subscription.
  if (status === 429 || (status >= 500 && status <= 599)) {
    return 'ambiguous';
  }

  // Other 4xx responses are authoritative rejection decisions from Graph.
  if (status >= 400 && status < 500) {
    return 'confirmed_rejection';
  }

  // Unknown status (network failure, malformed response, no status) -> fail safe.
  return 'ambiguous';
}

/**
 * Builds the deterministic reservation key for a mailbox/folder pair.
 */
function reservationKeyFor(mailbox, folder = 'inbox') {
  return `${String(mailbox).trim().toLowerCase()}|${String(folder).trim().toLowerCase()}`;
}

/**
 * Returns true when an operation document represents an active creation reservation that must
 * block other workers.
 *
 * Active means the lease has not expired AND the operation has not been conclusively resolved:
 * - `pending` operations always hold their reservation until the lease expires.
 * - `failed` operations hold it only when failureClassification === 'ambiguous'. A confirmed
 *   rejection is conclusive and must not block retries.
 * An expired ambiguous operation is not "active", but acquireCreationReservation must not
 * abandon it. That operation enters dedicated recovery instead.
 */
function isActiveOperationReservation(operation, now = new Date()) {
  if (!operation) return false;
  const leaseMs = operation.leaseExpiresAt ? new Date(operation.leaseExpiresAt).getTime() : 0;
  if (!Number.isFinite(leaseMs) || leaseMs <= now.getTime()) return false;
  if (operation.state === 'pending') return true;
  return operation.state === 'failed' && operation.failureClassification === 'ambiguous';
}

/**
 * Computes a reservation lease that strictly exceeds the complete Graph request and retry window.
 *
 * GraphClient may make (maxRetries + 1) attempts, each bounded by timeoutMs, and sleep up to
 * maxBackoffMs between attempts. A 60s completion margin covers scheduler jitter and DB writes.
 * Using the client's real configuration prevents a lease from expiring while a delayed request
 * is still executing and could still create a remote subscription.
 *
 * @param {Object} [graphClient]
 * @returns {number} Lease duration in milliseconds
 */
function calculateCreationLeaseMs(graphClient = {}) {
  const timeoutMs = Number.isFinite(graphClient.timeoutMs) && graphClient.timeoutMs > 0
    ? graphClient.timeoutMs
    : 15000;
  const maxRetries = Number.isFinite(graphClient.maxRetries) && graphClient.maxRetries >= 0
    ? graphClient.maxRetries
    : 3;
  const maxBackoffMs = Number.isFinite(graphClient.maxBackoffMs) && graphClient.maxBackoffMs > 0
    ? graphClient.maxBackoffMs
    : 30000;

  const requestWindowMs = timeoutMs * (maxRetries + 1);
  const retryBackoffMs = maxBackoffMs * maxRetries;
  const completionMarginMs = 60 * 1000;

  return Math.max(2 * 60 * 1000, requestWindowMs + retryBackoffMs + completionMarginMs);
}

const RESERVATION_ACQUIRE_MAX_ATTEMPTS = 5;

/**
 * Finds an active unresolved operation that predates the reservationKey mechanism (or was created
 * by an external tool). These records are still authoritative protection leases and must block
 * new creations even though we cannot take the unique reservation index for them.
 */
async function findActiveLegacyOperation({ mailbox, folder, now = new Date() }) {
  return GraphSubscriptionOperation.findOne({
    mailbox,
    folder,
    reservationKey: null,
    leaseExpiresAt: { $gt: now },
    $or: [
      { state: 'pending' },
      { state: 'failed', failureClassification: 'ambiguous' }
    ]
  })
    .sort({ leaseExpiresAt: -1 })
    .lean();
}

function blockerResult(operation, now) {
  return {
    acquired: false,
    operation,
    operationId: operation.operationId,
    reservationKey: operation.reservationKey ?? null,
    reason: ambiguousRecoveryDisposition(operation, now) || 'active_reservation'
  };
}

/**
 * Atomically acquires the single-flight creation reservation for a mailbox/folder.
 *
 * Two concurrent workers cannot both acquire it: a unique partial index on `reservationKey`
 * makes exactly one INSERT succeed. The loser observes the holder and:
 * - yields while the holder's lease is active,
 * - returns an ambiguous holder for dedicated recovery (the holder is never abandoned
 *   merely because its lease expired), or
 * - atomically marks an expired pending holder `abandoned` only when no POST was dispatched.
 *
 * @param {Object} params
 * @returns {Promise<{ acquired: boolean, operation?: Object, operationId?: string, reason?: string }>}
 */
async function acquireCreationReservation({
  mailbox,
  folder = 'inbox',
  resource,
  notificationUrl,
  lifecycleUrl = null,
  clientStateHash,
  clientStateHashScheme,
  clientStateKeyId,
  requestedExpirationMinutes,
  changeType = null,
  initialLeaseExpiresAt,
  now: nowInput = null
}) {
  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();
  const reservationKey = reservationKeyFor(normMailbox, normFolder);
  const nowFn = nowInput ? () => new Date(nowInput) : () => new Date();

  for (let attempt = 0; attempt < RESERVATION_ACQUIRE_MAX_ATTEMPTS; attempt++) {
    const now = nowFn();

    // 1. Ambiguous outcomes block a new POST whether or not they still hold the
    // reservation key and whether or not the lease has expired.
    const blockers = await findUnresolvedAmbiguousOperations({
      mailbox: normMailbox,
      folder: normFolder
    });
    if (blockers.length > 0) {
      const recoverable = blockers.find((op) => ambiguousRecoveryDisposition(op, now) === 'ambiguous_recovery_required');
      return blockerResult(recoverable || blockers[0], now);
    }

    // 2. Honour active pending leases created before the reservationKey field existed.
    const legacy = await findActiveLegacyOperation({
      mailbox: normMailbox,
      folder: normFolder,
      now
    });
    if (legacy && !isAmbiguousUnresolvedOperation(legacy)) {
      return {
        acquired: false,
        operation: legacy,
        operationId: legacy.operationId,
        reason: 'active_legacy_lease'
      };
    }

    // 3. Atomically claim the slot with a unique partial index.
    const operationId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    try {
      const created = await GraphSubscriptionOperation.create({
        operationId,
        mailbox: normMailbox,
        folder: normFolder,
        resource,
        notificationUrl,
        lifecycleUrl,
        state: 'pending',
        clientStateHash,
        clientStateHashScheme,
        clientStateKeyId,
        requestedExpirationMinutes,
        changeType,
        leaseExpiresAt: initialLeaseExpiresAt,
        reservationKey
      });

      return {
        acquired: true,
        operation: created.toObject ? created.toObject() : created,
        operationId,
        reservationKey
      };
    } catch (err) {
      if (err.code !== 11000) {
        throw new Error(`[SubscriptionService] Failed to acquire creation reservation: ${err.message}`);
      }
    }

    // 4. A holder exists. Re-read it and decide whether to yield, recover, or abandon.
    const holder = await GraphSubscriptionOperation.findOne({ reservationKey }).lean();
    if (!holder) {
      continue;
    }

    if (isAmbiguousUnresolvedOperation(holder)) {
      return blockerResult(holder, now);
    }

    if (isActiveOperationReservation(holder, now)) {
      return {
        acquired: false,
        operation: holder,
        operationId: holder.operationId,
        reason: 'active_reservation'
      };
    }

    // Expired pending operation whose POST was never dispatched. One worker may
    // release it. Any other expired holder is released only when it is not ambiguous.
    const expiredPendingWithoutPost = holder.state === 'pending' && !holder.graphPostDispatchedAt;
    const takeover = await GraphSubscriptionOperation.findOneAndUpdate(
      {
        _id: holder._id,
        reservationKey,
        leaseExpiresAt: { $lte: now },
        failureClassification: { $ne: 'ambiguous' },
        $or: [
          { graphPostDispatchedAt: null },
          { failureClassification: 'confirmed_rejection' },
          { state: 'completed' }
        ]
      },
      {
        $set: expiredPendingWithoutPost
          ? {
            reservationKey: null,
            state: 'abandoned',
            lastError: 'Creation reservation lease expired before the Graph POST was dispatched'
          }
          : {
            reservationKey: null
          }
      },
      { new: true }
    ).lean();

    if (!takeover) {
      continue;
    }
  }

  return {
    acquired: false,
    reason: 'reservation_contention'
  };
}

function presentRecoveryResult(recovery = {}) {
  const adopted = Boolean(recovery.adopted && recovery.subscription);
  const manualReasons = new Set([
    'manual_required',
    'multiple_matches',
    'invalid_known_subscription',
    'insufficient_identity',
    'insufficient_match',
    'detail_lookup_failed',
    'client_state_unavailable',
    'ambiguous_manual_recovery_required'
  ]);
  const subscription = adopted ? { ...recovery.subscription } : undefined;
  if (subscription) delete subscription.clientState;
  return {
    created: false,
    isExisting: adopted,
    inFlight: !adopted,
    recovered: adopted,
    adopted,
    manualRecoveryRequired: manualReasons.has(recovery.reason),
    operationId: recovery.operationId || null,
    reason: recovery.reason || null,
    subscription,
    absenceObservations: recovery.absenceObservations,
    recoveryState: recovery.recoveryState || null,
    message: adopted
      ? 'Adopted an existing Microsoft Graph subscription after an ambiguous create'
      : 'Ambiguous subscription creation is unresolved; another POST was not sent'
  };
}

/**
 * Releases a reservation only if this worker still owns it.
 * Ownership is proven by operationId AND reservationKey, so a worker can never release another
 * worker's active reservation.
 */
async function releaseCreationReservation({
  operationId,
  reservationKey,
  updates = {}
}) {
  if (!operationId || !reservationKey) return null;
  const result = await GraphSubscriptionOperation.findOneAndUpdate(
    { operationId, reservationKey },
    { $set: { reservationKey: null, ...updates } },
    { new: true }
  ).lean();
  return result;
}

/**
 * Extends the protection lease for an in-progress ambiguous operation without releasing it.
 * Scoped by reservationKey so stale workers cannot extend a reservation they no longer own.
 */
async function extendCreationReservation({
  operationId,
  reservationKey,
  updates = {},
  leaseExpiresAt
}) {
  if (!operationId || !reservationKey) return null;
  return GraphSubscriptionOperation.findOneAndUpdate(
    { operationId, reservationKey },
    { $set: { ...updates, leaseExpiresAt } },
    { new: true }
  ).lean();
}

/**
 * Verifies an incoming clientState against a stored subscription record.
 * Uses trusted persisted subscription metadata to select the appropriate key and algorithm.
 * Never silently falls back between cryptographic algorithms without knowing which scheme was used.
 * Constant-time comparison prevents timing attacks.
 *
 * @param {Object} params
 * @param {string} params.clientState Incoming plaintext secret from Graph notification
 * @param {Object} params.subscription Stored GraphSubscription document
 * @param {Object} [params.env] Environment configuration override (defaults to process.env)
 * @returns {boolean} True if clientState is authentic
 */
function verifySubscriptionClientState({ clientState, subscription, env = process.env }) {
  if (!clientState || typeof clientState !== 'string' || !subscription) {
    return false;
  }

  const expectedHash = subscription.clientStateHash;
  if (!expectedHash || typeof expectedHash !== 'string') {
    return false;
  }

  const primarySecret = env.MS_GRAPH_CLIENT_STATE_SECRET || '';
  const primaryKeyId = env.MS_GRAPH_CLIENT_STATE_KEY_ID || 'primary';
  const previousSecret = env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS || '';
  const previousKeyId = env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID || 'previous';

  const scheme = subscription.clientStateHashScheme;
  const keyId = subscription.clientStateKeyId;

  // Case 1: Subscription was created with explicit 'hmac-sha256' scheme
  if (scheme === HASH_SCHEMES.HMAC_SHA256) {
    let candidateKeys = [];

    const isPrimaryKey = keyId === primaryKeyId || (!keyId && primaryKeyId === 'primary') || keyId === 'primary';
    const isPreviousKey = keyId === previousKeyId || keyId === 'previous';

    if (isPrimaryKey) {
      if (primarySecret) candidateKeys.push(primarySecret);
      // During rotation overlap, test previous key if present
      if (previousSecret && previousSecret !== primarySecret) candidateKeys.push(previousSecret);
    } else if (isPreviousKey) {
      if (previousSecret) candidateKeys.push(previousSecret);
      if (primarySecret && primarySecret !== previousSecret) candidateKeys.push(primarySecret);
    } else if (!keyId) {
      // Unversioned HMAC record (no keyId stored) — evaluate against configured secrets
      if (primarySecret) candidateKeys.push(primarySecret);
      if (previousSecret && previousSecret !== primarySecret) candidateKeys.push(previousSecret);
    } else {
      // Key ID is explicitly specified on record but unrecognized in environment — fail closed without guessing
      return false;
    }

    if (candidateKeys.length === 0) {
      return false;
    }

    for (const key of candidateKeys) {
      const computed = crypto.createHmac('sha256', key).update(clientState).digest('hex');
      if (timingSafeCompare(computed, expectedHash)) {
        return true;
      }
    }

    // Strictly DO NOT fall back to unkeyed SHA-256 for HMAC subscriptions
    return false;
  }

  // Case 2: Subscription was created with explicit unkeyed 'sha256' scheme
  if (scheme === HASH_SCHEMES.SHA256) {
    const computed = crypto.createHash('sha256').update(clientState).digest('hex');
    return timingSafeCompare(computed, expectedHash);
  }

  // Case 3: Legacy subscription record without explicit clientStateHashScheme (backward compatibility)
  if (primarySecret) {
    const computedPrimary = crypto.createHmac('sha256', primarySecret).update(clientState).digest('hex');
    if (timingSafeCompare(computedPrimary, expectedHash)) return true;
  }
  if (previousSecret) {
    const computedPrev = crypto.createHmac('sha256', previousSecret).update(clientState).digest('hex');
    if (timingSafeCompare(computedPrev, expectedHash)) return true;
  }
  const computedSha = crypto.createHash('sha256').update(clientState).digest('hex');
  return timingSafeCompare(computedSha, expectedHash);
}

/**
 * Formats standard Microsoft Graph mailbox message resource path.
 */
function formatGraphResource(mailbox, folder = 'inbox') {
  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();
  return `users/${encodeURIComponent(normMailbox)}/mailFolders('${encodeURIComponent(normFolder)}')/messages`;
}

/**
 * Subscription Lifecycle Service for Microsoft Graph
 */
class SubscriptionService {
  constructor(config = {}) {
    this.graphClient = config.graphClient || new GraphClient();
    this.defaultNotificationUrl =
      config.notificationUrl ||
      process.env.MS_GRAPH_WEBHOOK_URL ||
      '';
    this.defaultLifecycleUrl =
      config.lifecycleUrl ||
      process.env.MS_GRAPH_LIFECYCLE_URL ||
      this.defaultNotificationUrl;
    this.nowFn = config.nowFn || (() => new Date());
    this.recoveryPolicy = { ...AMBIGUOUS_RECOVERY_POLICY, ...(config.recoveryPolicy || {}) };
    this.recoveryMaxPages = config.recoveryMaxPages || 10;
  }

  async recoverAmbiguousOperation({
    operationId,
    reservationKey,
    workerId,
    allowManual = false,
    operator = null
  } = {}) {
    return recoverAmbiguousSubscriptionOperation({
      operationId,
      reservationKey,
      workerId,
      allowManual,
      operator,
      graphClient: this.graphClient,
      now: this.nowFn(),
      policy: this.recoveryPolicy,
      maxPages: this.recoveryMaxPages,
      verifyClientState: (clientState, operation) => verifySubscriptionClientState({
        clientState,
        subscription: {
          clientStateHash: operation.clientStateHash,
          clientStateHashScheme: operation.clientStateHashScheme,
          clientStateKeyId: operation.clientStateKeyId
        }
      })
    });
  }

  /**
   * Operator retry for an operation already in manual_required.
   * Does not POST. Discovery still requires a verified detail clientState.
   * Ordinary health checks and create requests do not call this.
   */
  async recoverManualAmbiguousOperation({ operationId, operator } = {}) {
    if (!operator?.adminId) {
      return { adopted: false, reason: 'unauthorized', operationId: operationId || null, reservationHeld: true };
    }
    const operation = await GraphSubscriptionOperation.findOne({ operationId }).lean();
    let recovery;
    if (!operation) {
      recovery = { adopted: false, reason: 'not_found', operationId, reservationHeld: false };
    } else if (operation.recoveryState !== 'manual_required') {
      recovery = {
        adopted: false,
        reason: 'not_manual_required',
        operationId,
        recoveryState: operation.recoveryState,
        reservationHeld: Boolean(operation.reservationKey)
      };
    } else {
      recovery = await this.recoverAmbiguousOperation({
        operationId,
        reservationKey: operation.reservationKey ?? null,
        allowManual: true,
        operator
      });
    }

    await SupportEmailAuditLog.create({
      adminId: operator.adminId,
      action: 'subscription_manual_recovery',
      targetType: 'graph_subscription_operation',
      targetId: String(operationId),
      ip: operator.ip || null,
      userAgent: operator.userAgent || null,
      metadata: {
        outcome: recovery.reason || null,
        adopted: Boolean(recovery.adopted),
        recoveryState: recovery.recoveryState || null,
        reservationHeld: recovery.reservationHeld !== false
      }
    });
    return recovery;
  }

  /**
   * Runs dedicated recovery when an ambiguous operation is due.
   * Returns null when nothing is due, so a healthy mailbox is left unchanged.
   * Never issues POST /subscriptions.
   */
  async recoverDueAmbiguousOperation(mailbox, folder = 'inbox') {
    const now = this.nowFn();
    const normMailbox = String(mailbox || '').trim().toLowerCase();
    const normFolder = String(folder || 'inbox').trim().toLowerCase();
    const blockers = await findUnresolvedAmbiguousOperations({
      mailbox: normMailbox,
      folder: normFolder
    });
    if (!blockers.length) return null;

    const recoverable = blockers.find((op) => ambiguousRecoveryDisposition(op, now) === 'ambiguous_recovery_required');
    if (recoverable) {
      const recovery = await this.recoverAmbiguousOperation({
        operationId: recoverable.operationId,
        reservationKey: recoverable.reservationKey ?? null
      });
      return presentRecoveryResult(recovery);
    }

    const manual = blockers.find((op) => ambiguousRecoveryDisposition(op, now) === 'ambiguous_manual_recovery_required');
    if (!manual) return null;
    return presentRecoveryResult({
      adopted: false,
      reason: 'manual_required',
      operationId: manual.operationId,
      recoveryState: manual.recoveryState,
      absenceObservations: manual.absenceObservations || 0
    });
  }

  /**
   * Creates a new Microsoft Graph subscription for a mailbox folder.
   *
   * @param {Object} params
   * @param {string} params.mailbox Target mailbox address
   * @param {string} [params.folder='inbox'] Mailbox folder
   * @param {string} [params.notificationUrl] Public webhook URL
   * @param {string} [params.lifecycleUrl] Public lifecycle notification URL
   * @param {string} [params.clientState] Optional pre-configured secret; auto-generated if omitted
   * @param {string} [params.changeType='created,updated'] Graph change types
   * @param {number} [params.expirationMinutes=4200] Subscription duration in minutes
   * @param {boolean} [params.force=false] Force creation even if active subscription exists
   * @param {boolean} [params.allowUnkeyed=false] Test escape hatch to allow unkeyed SHA-256 (strictly forbidden in prod/staging)
   * @returns {Promise<Object>} Subscription outcome
   */
  async createSubscription({
    mailbox,
    folder = 'inbox',
    notificationUrl,
    lifecycleUrl,
    clientState,
    changeType = 'created,updated',
    expirationMinutes = DEFAULT_EXPIRATION_MINUTES,
    force = false,
    allowUnkeyed = false
  }) {
    if (!mailbox) {
      throw new Error('[SubscriptionService] mailbox is required to create subscription');
    }

    // 0. Enforce HMAC key configuration before any network or database action
    const validatedKeys = validateHmacKeyConfig(process.env, allowUnkeyed);
    const primarySecret = validatedKeys.primarySecret;
    const primaryKeyId = validatedKeys.primaryKeyId;
    const effectiveScheme = validatedKeys.scheme;
    const effectiveKeyId = primaryKeyId;

    const normMailbox = mailbox.trim().toLowerCase();
    const normFolder = folder.trim().toLowerCase();
    const targetUrl = notificationUrl || this.defaultNotificationUrl;

    if (!targetUrl) {
      throw new Error('[SubscriptionService] notificationUrl is required (set MS_GRAPH_WEBHOOK_URL or pass notificationUrl)');
    }

    const targetLifecycleUrl = lifecycleUrl || this.defaultLifecycleUrl || targetUrl;
    const now = this.nowFn();

    // 1. Concurrency & Duplicate Prevention: Check for existing active subscription.
    // An unresolved ambiguous operation must not stop here. Its local row may already
    // exist because adoption was persisted and the process stopped before completion.
    // Recovery below finishes that operation after verifying the remote detail.
    if (!force) {
      const existing = await GraphSubscription.findOne({
        mailbox: normMailbox,
        folder: normFolder,
        status: 'active',
        expirationDateTime: { $gt: now }
      }).lean();

      if (existing) {
        const unresolved = await findUnresolvedAmbiguousOperations({
          mailbox: normMailbox,
          folder: normFolder
        });
        if (unresolved.length === 0) {
          return {
            created: false,
            isExisting: true,
            subscription: existing
          };
        }
      }
    }

    // 2. Prepare payload
    const effectiveClientState = clientState || generateClientState();
    const clientStateHash = hashClientState(effectiveClientState, primarySecret, effectiveScheme);
    const expirationDateTime = new Date(now.getTime() + Math.min(expirationMinutes, 4230) * 60 * 1000);
    const resource = formatGraphResource(normMailbox, normFolder);

    const payload = {
      changeType,
      notificationUrl: targetUrl,
      lifecycleNotificationUrl: targetLifecycleUrl,
      resource,
      expirationDateTime: expirationDateTime.toISOString(),
      clientState: effectiveClientState
    };

    // 3. Atomically acquire the distributed creation reservation. This is the single-flight
    // gate for normal creation, forced creation, renewal fallbacks and overlapping cron runs.
    // Confirmed rejections stay retryable. Expired pending operations are reusable only when
    // no POST was dispatched. Ambiguous operations enter dedicated recovery and are never
    // abandoned here.
    const leaseDurationMs = calculateCreationLeaseMs(this.graphClient);
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const reservation = await acquireCreationReservation({
      mailbox: normMailbox,
      folder: normFolder,
      resource,
      notificationUrl: targetUrl,
      lifecycleUrl: targetLifecycleUrl,
      clientStateHash,
      clientStateHashScheme: effectiveScheme,
      clientStateKeyId: effectiveKeyId,
      requestedExpirationMinutes: expirationMinutes,
      changeType,
      initialLeaseExpiresAt: leaseExpiresAt,
      now
    });

    if (!reservation.acquired) {
      if (reservation.reason === 'ambiguous_recovery_required') {
        const recovery = await this.recoverAmbiguousOperation({
          operationId: reservation.operationId,
          reservationKey: reservation.reservationKey ?? null
        });
        return presentRecoveryResult(recovery);
      }
      if (reservation.reason === 'ambiguous_manual_recovery_required') {
        return presentRecoveryResult({
          adopted: false,
          reason: 'manual_required',
          operationId: reservation.operationId,
          recoveryState: 'manual_required',
          absenceObservations: reservation.operation?.absenceObservations || 0
        });
      }
      incrementMetric('subscription_creation_deferred', 1);
      logOperationalEvent('info', 'support_email_subscription_creation_deferred', {
        mailbox: normMailbox,
        folder: normFolder,
        reason: reservation.reason
      });
      return {
        created: false,
        isExisting: false,
        inFlight: true,
        operationId: reservation.operationId || null,
        message: 'Subscription creation operation already in flight under active lease',
        reason: reservation.reason
      };
    }

    const operationId = reservation.operationId;
    const reservationKey = reservation.reservationKey;

    // 4. Re-check for an existing active subscription AFTER acquiring the reservation.
    // The pre-reservation fast path is only an optimization; without this second check two
    // workers that both observed "no subscription" could serialize and create two subscriptions.
    if (!force) {
      const existingNow = await GraphSubscription.findOne({
        mailbox: normMailbox,
        folder: normFolder,
        status: 'active',
        expirationDateTime: { $gt: new Date() }
      }).lean();

      if (existingNow) {
        await releaseCreationReservation({
          operationId,
          reservationKey,
          updates: {
            state: 'completed',
            completedAt: new Date(),
            lastError: 'Superseded by an existing active subscription discovered after reservation acquisition'
          }
        });
        return {
          created: false,
          isExisting: true,
          subscription: existingNow
        };
      }
    }

    // A reservation acquired above must not POST while another ambiguous operation
    // for this mailbox still exists (legacy rows may not hold the unique key).
    const foreignAmbiguous = await findUnresolvedAmbiguousOperations({
      mailbox: normMailbox,
      folder: normFolder,
      excludeOperationId: operationId
    });
    if (foreignAmbiguous.length > 0) {
      await releaseCreationReservation({
        operationId,
        reservationKey,
        updates: {
          state: 'abandoned',
          lastError: 'Released before POST because an unresolved ambiguous operation already exists'
        }
      });
      const chosen = foreignAmbiguous.find((op) => ambiguousRecoveryDisposition(op, this.nowFn()) === 'ambiguous_recovery_required')
        || foreignAmbiguous[0];
      const disposition = ambiguousRecoveryDisposition(chosen, this.nowFn());
      if (disposition === 'ambiguous_recovery_required') {
        const recovery = await this.recoverAmbiguousOperation({
          operationId: chosen.operationId,
          reservationKey: chosen.reservationKey ?? null
        });
        return presentRecoveryResult(recovery);
      }
      return presentRecoveryResult({
        adopted: false,
        reason: disposition === 'ambiguous_manual_recovery_required' ? 'manual_required' : 'active_reservation',
        operationId: chosen.operationId,
        recoveryState: chosen.recoveryState,
        absenceObservations: chosen.absenceObservations || 0
      });
    }

    // Record the dispatch before the socket is opened. A crash after this write is
    // ambiguous even if the POST response is never observed. If we no longer own the
    // reservation, do not send the request.
    const dispatched = await extendCreationReservation({
      operationId,
      reservationKey,
      updates: {
        graphPostDispatchedAt: this.nowFn(),
        changeType
      },
      leaseExpiresAt: new Date(this.nowFn().getTime() + leaseDurationMs)
    });
    if (!dispatched) {
      throw new Error('[SubscriptionService] Lost creation reservation before Graph POST; request was not sent');
    }

    // 5. Invoke Microsoft Graph POST /subscriptions. The client also refuses to retry
    // ambiguous outcomes for this URL; the flag keeps the intent next to the call.
    let response;
    try {
      response = await this.graphClient.request({
        url: '/subscriptions',
        method: 'POST',
        data: payload,
        noRetryOnAmbiguous: true
      });
    } catch (graphErr) {
      const status = Number(graphErr.statusCode || graphErr.response?.status || 0);
      if (status === 409) {
        const conflictError = 'Microsoft Graph returned 409 Conflict for POST /subscriptions. The reservation is retained for remote discovery. No further POST will be sent for this operation';
        incrementMetric('subscription_creation_ambiguous', 1);
        logOperationalEvent('warn', 'support_email_subscription_creation_conflict', {
          mailbox: normMailbox,
          folder: normFolder,
          operationId,
          statusCode: 409
        });
        const marked = await extendCreationReservation({
          operationId,
          reservationKey,
          updates: {
            state: 'failed',
            failureClassification: 'ambiguous',
            lastError: conflictError
          },
          leaseExpiresAt: new Date(this.nowFn().getTime() + leaseDurationMs)
        });
        if (!marked) {
          return presentRecoveryResult({
            adopted: false,
            reason: 'ownership_mismatch',
            operationId,
            reservationHeld: true
          });
        }
        try {
          const recovery = await this.recoverAmbiguousOperation({
            operationId,
            reservationKey
          });
          return presentRecoveryResult(recovery);
        } catch (recoveryError) {
          logOperationalEvent('error', 'support_email_subscription_creation_conflict_discovery_failed', {
            mailbox: normMailbox,
            folder: normFolder,
            operationId,
            statusCode: 409
          });
          return presentRecoveryResult({
            adopted: false,
            reason: 'enumeration_incomplete',
            operationId,
            reservationHeld: true,
            recoveryState: 'awaiting_recheck'
          });
        }
      }

      const classification = classifyGraphError(graphErr);
      const isConfirmedRejection = classification === 'confirmed_rejection';

      if (isConfirmedRejection) {
        // Graph proved it rejected the request: release the reservation so retries are immediate.
        incrementMetric('subscription_creation_rejected', 1);
        logOperationalEvent('warn', 'support_email_subscription_creation_rejected', {
          mailbox: normMailbox,
          folder: normFolder,
          errorCode: graphErr.code || null,
          statusCode: graphErr.statusCode || graphErr.response?.status || null
        });
        await releaseCreationReservation({
          operationId,
          reservationKey,
          updates: {
            state: 'failed',
            failureClassification: classification,
            lastError: graphErr.message,
            leaseExpiresAt: new Date(this.nowFn().getTime() - 1000)
          }
        });
      } else {
        // The request may still execute or may already have created the subscription.
        // Keep the reservation (and its unexpired lease) to protect against duplicate creation.
        incrementMetric('subscription_creation_ambiguous', 1);
        logOperationalEvent('warn', 'support_email_subscription_creation_ambiguous', {
          mailbox: normMailbox,
          folder: normFolder,
          errorCode: graphErr.code || null,
          statusCode: graphErr.statusCode || graphErr.response?.status || null
        });
        await extendCreationReservation({
          operationId,
          reservationKey,
          updates: {
            state: 'failed',
            failureClassification: 'ambiguous',
            lastError: graphErr.message
          },
          leaseExpiresAt: new Date(this.nowFn().getTime() + leaseDurationMs)
        });
      }
      throw graphErr;
    }

    if (!response || !response.id) {
      // A 2xx without an id cannot prove a subscription exists; keep the protection lease.
      await extendCreationReservation({
        operationId,
        reservationKey,
        updates: {
          state: 'failed',
          failureClassification: 'ambiguous',
          lastError: 'Malformed Graph response (missing id)'
        },
        leaseExpiresAt: new Date(this.nowFn().getTime() + leaseDurationMs)
      });
      throw new Error('[SubscriptionService] Malformed Graph response for subscription creation (missing id)');
    }

    const subscriptionId = response.id;
    const actualExpiration = response.expirationDateTime ? new Date(response.expirationDateTime) : expirationDateTime;

    // 6. Immediately associate subscriptionId and keep the reservation during persistence.
    await extendCreationReservation({
      operationId,
      reservationKey,
      updates: { subscriptionId },
      leaseExpiresAt: new Date(this.nowFn().getTime() + 60000)
    });

    // 7. Persist subscription metadata. If MongoDB fails after Graph created the subscription,
    // retain the subscriptionId and an ambiguous protection lease so reconciliation cannot delete
    // a subscription that is still being established.
    try {
      // Mark any previous active subscriptions for this mailbox as expired
      await GraphSubscription.updateMany(
        {
          mailbox: normMailbox,
          folder: normFolder,
          subscriptionId: { $ne: subscriptionId },
          status: 'active'
        },
        {
          $set: { status: 'expired' }
        }
      );

      const doc = await GraphSubscription.findOneAndUpdate(
        { subscriptionId },
        {
          $set: {
            subscriptionId,
            mailbox: normMailbox,
            folder: normFolder,
            resource,
            expirationDateTime: actualExpiration,
            clientStateHash,
            clientStateHashScheme: effectiveScheme,
            clientStateKeyId: effectiveKeyId,
            status: 'active',
            notificationUrl: targetUrl,
            lifecycleUrl: targetLifecycleUrl,
            lastRenewedAt: now,
            lastError: null
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();

      // 8. Mark operation completed and release the reservation atomically (owner-scoped).
      await releaseCreationReservation({
        operationId,
        reservationKey,
        updates: {
          state: 'completed',
          completedAt: new Date(),
          subscriptionId
        }
      });

      incrementMetric('subscription_created', 1);
      logOperationalEvent('info', 'support_email_subscription_created', {
        mailbox: normMailbox,
        folder: normFolder,
        subscriptionId,
        operationId,
        expiresAt: actualExpiration
      });

      return {
        created: true,
        isExisting: false,
        subscription: doc,
        clientState: effectiveClientState,
        operationId
      };
    } catch (persistErr) {
      try {
        await extendCreationReservation({
          operationId,
          reservationKey,
          updates: {
            subscriptionId,
            state: 'failed',
            failureClassification: 'ambiguous',
            lastError: `Persistence failure after Graph created the subscription: ${persistErr.message}`
          },
          leaseExpiresAt: new Date(this.nowFn().getTime() + leaseDurationMs)
        });
      } catch (opErr) {
        // Log only non-sensitive identifiers; the reservation will expire on its own.
        logOperationalEvent('error', 'support_email_subscription_operation_persist_failed', {
          operationId,
          hasSubscriptionId: Boolean(subscriptionId),
          ...summarizeError(opErr)
        });
      }
      throw persistErr;
    }
  }

  /**
   * Renews an existing Microsoft Graph subscription before expiration.
   *
   * @param {Object} params
   * @param {string} params.subscriptionId
   * @param {number} [params.expirationMinutes=4200]
   * @returns {Promise<Object>} Renewal outcome
   */
  async renewSubscription({
    subscriptionId,
    expirationMinutes = DEFAULT_EXPIRATION_MINUTES
  }) {
    if (!subscriptionId) {
      throw new Error('[SubscriptionService] subscriptionId is required to renew subscription');
    }

    const now = new Date();
    const newExpiration = new Date(now.getTime() + Math.min(expirationMinutes, 4230) * 60 * 1000);

    try {
      const response = await this.graphClient.request({
        url: `/subscriptions/${subscriptionId}`,
        method: 'PATCH',
        data: {
          expirationDateTime: newExpiration.toISOString()
        }
      });

      const actualExpiration = response?.expirationDateTime
        ? new Date(response.expirationDateTime)
        : newExpiration;

      const updated = await GraphSubscription.findOneAndUpdate(
        { subscriptionId },
        {
          $set: {
            expirationDateTime: actualExpiration,
            lastRenewedAt: now,
            status: 'active',
            lastError: null
          }
        },
        { new: true }
      ).lean();

      incrementMetric('subscription_renewed', 1);
      logOperationalEvent('info', 'support_email_subscription_renewed', {
        subscriptionId,
        mailbox: updated?.mailbox,
        expiresAt: actualExpiration
      });

      return {
        renewed: true,
        subscription: updated
      };
    } catch (err) {
      // If Graph returns 404 Not Found, the subscription expired or was deleted in Exchange
      const isNotFound = err.statusCode === 404 || err.response?.status === 404;
      incrementMetric('subscription_renewal_failed', 1);
      logOperationalEvent(isNotFound ? 'warn' : 'error', 'support_email_subscription_renewal_failed', {
        subscriptionId,
        isNotFound,
        errorCode: err.code || null,
        statusCode: err.statusCode || err.response?.status || null
      });
      await GraphSubscription.updateOne(
        { subscriptionId },
        {
          $set: {
            status: isNotFound ? 'expired' : 'failed',
            lastError: err.message
          }
        }
      );

      throw err;
    }
  }

  /**
   * Deletes a Microsoft Graph subscription.
   *
   * @param {Object} params
   * @param {string} params.subscriptionId
   * @returns {Promise<Object>} Deletion outcome
   */
  async deleteSubscription({ subscriptionId }) {
    if (!subscriptionId) {
      throw new Error('[SubscriptionService] subscriptionId is required to delete subscription');
    }

    try {
      await this.graphClient.request({
        url: `/subscriptions/${subscriptionId}`,
        method: 'DELETE'
      });
    } catch (err) {
      // If already deleted in Graph (404), continue cleanly
      if (err.statusCode !== 404 && err.response?.status !== 404) {
        await GraphSubscription.updateOne(
          { subscriptionId },
          { $set: { lastError: err.message } }
        );
        throw err;
      }
    }

    const updated = await GraphSubscription.findOneAndUpdate(
      { subscriptionId },
      {
        $set: {
          status: 'deleted',
          lastError: null
        }
      },
      { new: true }
    ).lean();

    return {
      deleted: true,
      subscription: updated
    };
  }

  /**
   * Audits and repairs subscription health for a mailbox.
   * If subscription is missing, expired, or expiring within safety margin, renews or re-creates it.
   *
   * @param {Object} params
   * @param {string} params.mailbox
   * @param {string} [params.folder='inbox']
   * @param {number} [params.safetyMarginHours=24]
   * @param {string} [params.notificationUrl]
   * @param {string} [params.lifecycleUrl]
   * @returns {Promise<Object>} Health check outcome
   */
  async syncSubscriptionHealth({
    mailbox,
    folder = 'inbox',
    safetyMarginHours = MIN_EXPIRATION_MARGIN_HOURS,
    notificationUrl,
    lifecycleUrl
  }) {
    if (!mailbox) {
      throw new Error('[SubscriptionService] mailbox is required for subscription health check');
    }

    const normMailbox = mailbox.trim().toLowerCase();
    const normFolder = folder.trim().toLowerCase();
    const now = this.nowFn();
    const safetyMarginMs = safetyMarginHours * 60 * 60 * 1000;

    // Adopt a lost remote subscription before deciding to create another one.
    // This does not POST. A still-unresolved ambiguous operation blocks creation below.
    const priorRecovery = await this.recoverDueAmbiguousOperation(normMailbox, normFolder);

    const currentSub = await GraphSubscription.findOne({
      mailbox: normMailbox,
      folder: normFolder,
      status: 'active'
    }).sort({ expirationDateTime: -1 }).lean();

    // 1. Missing subscription: Create new, unless ambiguous recovery is still unresolved.
    if (!currentSub) {
      if (priorRecovery && !priorRecovery.adopted) {
        return priorRecovery;
      }
      return this.createSubscription({
        mailbox: normMailbox,
        folder: normFolder,
        notificationUrl,
        lifecycleUrl
      });
    }

    // 0. Proactively heal duplicate active subscriptions if multiple exist in local database
    await GraphSubscription.updateMany(
      {
        mailbox: normMailbox,
        folder: normFolder,
        status: 'active',
        _id: { $ne: currentSub._id }
      },
      { $set: { status: 'expired' } }
    );

    const expiresAtMs = new Date(currentSub.expirationDateTime).getTime();
    const timeRemainingMs = expiresAtMs - now.getTime();
    const needsReauthorizationRenewal = Boolean(
      currentSub.lastError && /reauthorization|reauthoriz/i.test(currentSub.lastError)
    );

    // 2. Already expired: Mark expired and create fresh subscription
    if (timeRemainingMs <= 0) {
      await GraphSubscription.updateOne(
        { _id: currentSub._id },
        { $set: { status: 'expired' } }
      );

      return this.createSubscription({
        mailbox: normMailbox,
        folder: normFolder,
        notificationUrl: notificationUrl || currentSub.notificationUrl,
        lifecycleUrl: lifecycleUrl || currentSub.lifecycleUrl,
        force: true
      });
    }

    // 3. Expiring within safety margin, or flagged by a reauthorizationRequired lifecycle event:
    // renew the existing subscription instead of creating a second one.
    if (needsReauthorizationRenewal || timeRemainingMs < safetyMarginMs) {
      try {
        const renewResult = await this.renewSubscription({
          subscriptionId: currentSub.subscriptionId
        });
        return {
          renewed: true,
          subscription: renewResult.subscription
        };
      } catch (err) {
        // If renewal failed because Graph purged the subscription (404), create a fresh one
        if (err.statusCode === 404 || err.response?.status === 404) {
          return this.createSubscription({
            mailbox: normMailbox,
            folder: normFolder,
            notificationUrl: notificationUrl || currentSub.notificationUrl,
            lifecycleUrl: lifecycleUrl || currentSub.lifecycleUrl,
            force: true
          });
        }
        throw err;
      }
    }

    // 4. Healthy and active
    return {
      healthy: true,
      renewed: false,
      subscription: currentSub,
      hoursRemaining: Math.round(timeRemainingMs / (3600 * 1000))
    };
  }

  /**
   * Handles Microsoft Graph lifecycle notifications.
   *
   * @param {Object} notification Lifecycle notification item
   * @returns {Promise<Object>} Outcome
   */
  async handleLifecycleNotification(notification = {}) {
    const { subscriptionId, lifecycleEvent } = notification;

    if (!subscriptionId) {
      return { handled: false, reason: 'missing_subscription_id' };
    }

    const sub = await GraphSubscription.findOne({ subscriptionId }).lean();
    if (!sub) {
      return { handled: false, reason: 'unknown_subscription' };
    }

    const mailbox = sub.mailbox;
    const folder = sub.folder || 'inbox';

    switch (lifecycleEvent) {
      case 'missed':
        // Graph missed sending one or more notifications -> Wake up delta sync engine!
        await signalMailboxSync({ mailbox, folder });
        return {
          handled: true,
          action: 'signaled_delta_sync',
          event: 'missed'
        };

      case 'subscriptionRemoved':
        // Graph removed the subscription (expiry, admin action, or policy change).
        // Mark it deleted and immediately signal delta catch-up so notifications that were
        // in flight at removal are not lost. The next cron health check recreates the subscription.
        await GraphSubscription.updateOne(
          { subscriptionId },
          { $set: { status: 'deleted', lastError: 'Removed by Graph lifecycle event' } }
        );
        await signalMailboxSync({ mailbox, folder });
        return {
          handled: true,
          action: 'marked_deleted',
          signaledDeltaSync: true,
          event: 'subscriptionRemoved'
        };

      case 'reauthorizationRequired':
        // Tenant consent / permissions changed. The subscription can still be recovered by
        // PATCH renewal, so flag it for the next health check (which renews before recreating)
        // and perform a delta catch-up in the meantime.
        await GraphSubscription.updateOne(
          { subscriptionId },
          { $set: { lastError: 'Reauthorization required by Microsoft 365 tenant' } }
        );
        await signalMailboxSync({ mailbox, folder });
        return {
          handled: true,
          action: 'flagged_reauth_required',
          signaledDeltaSync: true,
          event: 'reauthorizationRequired'
        };

      default:
        return {
          handled: false,
          reason: `unhandled_lifecycle_event: ${lifecycleEvent}`
        };
    }
  }

  /**
   * Lists webhook subscriptions registered in Microsoft Graph for this application.
   * Calls Graph GET /subscriptions and follows @odata.nextLink across pages.
   * Bounded to maxPages to protect against infinite loops and execution budget exhaustion.
   *
   * @param {Object} [options]
   * @param {number} [options.maxPages=10]
   * @returns {Promise<{ subscriptions: Array<Object>, completed: boolean, pages: number }>}
   */
  async listRemoteSubscriptions({ maxPages = 10 } = {}) {
    const allSubs = [];
    let nextUrl = '/subscriptions';
    let pages = 0;

    while (nextUrl && pages < maxPages) {
      pages++;
      const response = await this.graphClient.request({
        url: nextUrl,
        method: 'GET'
      });
      // A malformed 2xx must not be mistaken for a complete empty enumeration: that would make
      // reconciliation believe every local subscription is absent and permit destructive cleanup.
      if (!response || !Array.isArray(response.value)) {
        throw new Error('[SubscriptionService] Malformed Graph response while listing subscriptions (missing value array)');
      }
      allSubs.push(...response.value);
      nextUrl = response?.['@odata.nextLink'] || null;
    }

    allSubs.completed = !nextUrl;
    allSubs.pages = pages;
    // Keep the legacy array-with-properties shape, but expose a non-circular copy for callers
    // that read `result.subscriptions`.
    allSubs.subscriptions = allSubs.slice();
    return allSubs;
  }

  /**
   * Reconciles remote Graph subscriptions against local MongoDB subscriptions.
   * Enumerates remote subscriptions via GET /subscriptions (following @odata.nextLink),
   * filters by mailbox resource and application notification URL, cross-references with
   * MongoDB, and identifies remote and local orphans.
   *
   * Safety Constraints:
   * - Never deletes unknown subscriptions unless deleteOrphans=true AND ownership is proven
   *   (matching resource and matching application notificationUrl).
   * - Audit mode (deleteOrphans=false) performs zero mutations.
   * - In-flight grace windows protect newly created/persisted subscriptions from concurrent deletion.
   * - Local subscriptions missing remotely are marked expired ONLY when remote enumeration
   *   completed reliably without truncation or error, and the local subscription is older than grace.
   * - Partial deletion failures are captured and remain retryable on the next cycle.
   *
   * @param {Object} params
   * @param {string} params.mailbox
   * @param {string} [params.folder='inbox']
   * @param {boolean} [params.deleteOrphans=false] If true, deletes proven remote orphans from Graph and expires local orphans
   * @param {number} [params.maxPages=10] Bounded pagination ceiling for serverless execution
   * @param {number} [params.remoteCreationGraceMs=120000] In-flight grace period for newly created remote subscriptions (2m)
   * @param {number} [params.localAbsenceGraceMs=600000] In-flight grace period before marking local subscriptions expired (10m)
   * @returns {Promise<Object>} Reconciliation summary
   */
  async reconcileRemoteSubscriptions({
    mailbox,
    folder = 'inbox',
    deleteOrphans = false,
    maxPages = 10,
    remoteCreationGraceMs = 2 * 60 * 1000,
    localAbsenceGraceMs = 10 * 60 * 1000
  }) {
    if (!mailbox) {
      throw new Error('[SubscriptionService] mailbox is required to reconcile remote subscriptions');
    }

    const normMailbox = mailbox.trim().toLowerCase();
    const normFolder = folder.trim().toLowerCase();
    const expectedResource = formatGraphResource(normMailbox, normFolder);
    const expectedUrl = this.defaultNotificationUrl;
    const now = new Date();

    // 1. Fetch remote subscriptions from Microsoft Graph (following pagination)
    let remoteEnum = [];
    try {
      remoteEnum = await this.listRemoteSubscriptions({ maxPages });
    } catch (err) {
      throw new Error(`[SubscriptionService] Failed to list remote subscriptions from Graph: ${err.message}`);
    }

    // Helper: normalize URLs safely for exact comparison (trim, lowercase host, strip trailing slash)
    const normalizeUrl = (u) => {
      if (!u || typeof u !== 'string') return '';
      try {
        const parsed = new URL(u);
        const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`;
      } catch {
        return u.trim().replace(/\/+$/, '').toLowerCase();
      }
    };

    const normExpectedUrl = normalizeUrl(expectedUrl);
    const ownershipVerifiable = Boolean(normExpectedUrl);
    const normExpectedResource = expectedResource.trim().toLowerCase();

    // Filter to subscriptions matching this mailbox folder resource and application notification URL.
    // Without a configured notification URL, application ownership cannot be proven, so no remote
    // subscription may be classified as deletable.
    const relevantRemote = remoteEnum.filter((sub) => {
      const subResource = sub.resource ? sub.resource.trim().toLowerCase() : '';
      const resourceMatch = subResource === normExpectedResource;
      const subUrl = normalizeUrl(sub.notificationUrl);
      const urlMatch = ownershipVerifiable && subUrl === normExpectedUrl;
      return resourceMatch && urlMatch;
    });

    // 2. Fetch local subscriptions from MongoDB
    const localSubs = await GraphSubscription.find({
      mailbox: normMailbox,
      folder: normFolder
    }).lean();

    // Fetch local creation operation records from MongoDB
    const localOps = await GraphSubscriptionOperation.find({
      mailbox: normMailbox,
      folder: normFolder
    }).lean();

    const localMap = new Map();
    for (const sub of localSubs) {
      localMap.set(sub.subscriptionId, sub);
    }

    const opBySubId = new Map();
    let hasUnresolvedAmbiguousProtection = false;
    for (const op of localOps) {
      if (op.subscriptionId) {
        opBySubId.set(op.subscriptionId, op);
      }
      if (operationPreventsOrphanDeletion(op, now)) {
        hasUnresolvedAmbiguousProtection = true;
      }
    }

    const remoteMap = new Map();
    for (const sub of relevantRemote) {
      remoteMap.set(sub.id, sub);
    }

    const matched = [];
    const remoteOrphans = [];
    const localOrphans = [];
    const inFlightRemote = [];

    // Identify remote orphans (present in Graph, missing in local DB)
    for (const rSub of relevantRemote) {
      const lSub = localMap.get(rSub.id);
      if (lSub) {
        matched.push({ remote: rSub, local: lSub });
      } else {
        // Concurrency & Age Safety:
        // Do not infer subscription creation age from 'expirationDateTime - 4200 minutes'.
        // Establish actual creation age and lease status from GraphSubscriptionOperation records.
        let isRecent = false;
        let isUncertain = false;

        const rawExp = rSub.expirationDateTime;
        const nowMs = now.getTime();

        const directOp = opBySubId.get(rSub.id);

        if (hasUnresolvedAmbiguousProtection) {
          // An unresolved ambiguous create, a dispatched POST, or a known subscription id
          // protects every matching remote subscription. Lease expiry is not permission to
          // delete it; dedicated recovery adopts it or leaves it in place.
          isRecent = true;
        } else if (directOp) {
          const isLeaseActive = directOp.leaseExpiresAt && new Date(directOp.leaseExpiresAt).getTime() > nowMs;
          const isConfirmedRejection = directOp.failureClassification === 'confirmed_rejection';
          isRecent = Boolean(isLeaseActive && !isConfirmedRejection);
        } else {
          // No operation record found for this remote subscription.
          // Fall back to conservative validation:
          if (!rawExp) {
            // Rule 1: Missing timestamp -> preserve conservatively
            isUncertain = true;
          } else {
            const expMs = new Date(rawExp).getTime();
            const maxLifetimeMs = 4231 * 60 * 1000;
            const minLifetimeMs = 60 * 1000;

            if (isNaN(expMs) || expMs <= nowMs + minLifetimeMs || expMs > nowMs + maxLifetimeMs) {
              // Rule 2: Past, invalid, or beyond Graph ceiling -> preserve conservatively
              isUncertain = true;
            } else {
              // Rule 3: For untracked/legacy subscriptions without operation records,
              // check remaining lifetime against fresh creation window as fallback
              const clockSkewAllowanceMs = 60 * 1000;
              const remainingLifetimeMs = expMs - nowMs;
              const freshWindowMs = (DEFAULT_EXPIRATION_MINUTES * 60 * 1000) - remoteCreationGraceMs - clockSkewAllowanceMs;

              if (remainingLifetimeMs >= freshWindowMs) {
                isRecent = true;
              } else {
                // Rule 4: If any UNMATCHED local subscription for this mailbox was created/renewed within grace,
                // concurrent workers may have created this remote subscription while MongoDB write was delayed.
                const localCreationInFlight = localSubs.some((l) => {
                  if (remoteMap.has(l.subscriptionId)) return false; // Already matched 1:1
                  const cMs = l.createdAt ? new Date(l.createdAt).getTime() : 0;
                  const rMs = l.lastRenewedAt ? new Date(l.lastRenewedAt).getTime() : 0;
                  return (nowMs - cMs < remoteCreationGraceMs) || (nowMs - rMs < remoteCreationGraceMs);
                });

                if (localCreationInFlight) {
                  isUncertain = true;
                }
              }
            }
          }
        }

        if (isRecent || isUncertain) {
          inFlightRemote.push(rSub);
        } else {
          remoteOrphans.push(rSub);
        }
      }
    }

    // Identify local orphans (marked active in local DB, but missing in remote Graph)
    // CRITICAL: Local absence is ONLY reliably established if:
    // a) Remote enumeration completed all pages without truncation/error (remoteEnum.completed === true)
    // b) The local subscription is older than localAbsenceGraceMs (not a newly persisted in-flight subscription)
    if (remoteEnum.completed) {
      for (const lSub of localSubs) {
        if (lSub.status === 'active' && !remoteMap.has(lSub.subscriptionId)) {
          const createdAtMs = lSub.createdAt ? new Date(lSub.createdAt).getTime() : 0;
          const renewedAtMs = lSub.lastRenewedAt ? new Date(lSub.lastRenewedAt).getTime() : 0;
          const ageMs = Math.max(now.getTime() - createdAtMs, now.getTime() - renewedAtMs);

          if (ageMs > localAbsenceGraceMs) {
            localOrphans.push(lSub);
          }
        }
      }
    }

    let deletedRemoteCount = 0;
    let expiredLocalCount = 0;
    const failedDeletions = [];

    // 3. If cleanup requested, safely delete proven remote orphans and expire reliably absent
    // local orphans. Destructive cleanup is ONLY permitted when enumeration traversed the
    // entire remote collection AND application ownership is verifiable (notification URL known).
    // A truncated/incomplete page walk cannot prove absence.
    const cleanupSkippedIncompleteEnumeration = Boolean(deleteOrphans && !remoteEnum.completed);
    const cleanupSkippedUnverifiedOwnership = Boolean(deleteOrphans && !ownershipVerifiable);
    if (deleteOrphans && remoteEnum.completed && ownershipVerifiable) {
      for (const orphan of remoteOrphans) {
        try {
          await this.deleteSubscription({ subscriptionId: orphan.id });
          deletedRemoteCount++;
          // Mark associated operation as abandoned and release any held reservation.
          await GraphSubscriptionOperation.updateOne(
            {
              subscriptionId: orphan.id,
              state: { $nin: ['completed', 'abandoned'] },
              failureClassification: { $ne: 'ambiguous' },
              graphPostDispatchedAt: null
            },
            {
              $set: {
                state: 'abandoned',
                reservationKey: null,
                lastError: 'Remote orphan deleted during reconciliation'
              }
            }
          );
        } catch (delErr) {
          failedDeletions.push({ id: orphan.id, error: delErr.message });
        }
      }

      for (const orphan of localOrphans) {
        await GraphSubscription.updateOne(
          { _id: orphan._id },
          { $set: { status: 'expired', lastError: 'Remote subscription reliably established absent in Microsoft Graph' } }
        );
        expiredLocalCount++;
      }
    }

    return {
      mailbox: normMailbox,
      folder: normFolder,
      resource: expectedResource,
      remoteTotal: relevantRemote.length,
      localTotal: localSubs.length,
      matchedCount: matched.length,
      remoteOrphansCount: remoteOrphans.length,
      localOrphansCount: localOrphans.length,
      inFlightRemoteCount: inFlightRemote.length,
      deletedRemoteCount,
      expiredLocalCount,
      failedDeletions,
      completedEnumeration: remoteEnum.completed,
      ownershipVerifiable,
      cleanupSkippedIncompleteEnumeration,
      cleanupSkippedUnverifiedOwnership,
      pagesRetrieved: remoteEnum.pages,
      matched,
      remoteOrphans,
      localOrphans,
      inFlightRemote
    };
  }

  /**
   * Safely migrates a legacy subscription document (with clientStateHashScheme: null) to an
   * explicit scheme and key ID, but ONLY when the caller can demonstrate the hash is authentic
   * for the target scheme via a successful live verification attempt.
   *
   * Security invariants:
   * - Never relabels a SHA-256 hash as hmac-sha256 without proof of HMAC key provenance.
   * - Never assigns a key ID without evidence the corresponding key generated the stored hash.
   * - Only permits migration to 'sha256' (unkeyed) or 'hmac-sha256' (keyed, requires verifiedByKeyId).
   * - For hmac-sha256 migration, requires caller to supply the plaintext clientState and the
   *   key to verify against. This cannot be derived from the hash alone.
   * - For sha256 migration (downgrade), only allows setting scheme explicitly to 'sha256'.
   *   This is safe because sha256 is the original default for null-scheme records.
   *
   * @param {Object} params
   * @param {string} params.subscriptionId
   * @param {string} params.targetScheme - 'sha256' or 'hmac-sha256' (required)
   * @param {string} [params.targetKeyId] - Required when targetScheme is 'hmac-sha256'
   * @param {string} [params.clientState] - Plaintext clientState, required for hmac-sha256 migration
   * @param {string} [params.verificationSecret] - HMAC secret to verify against, required for hmac-sha256 migration
   * @returns {Promise<Object>} Migration result: { updated, migrated, reason }
   */
  async migrateLegacySubscriptionRecord({
    subscriptionId,
    targetScheme,
    targetKeyId,
    clientState,
    verificationSecret
  }) {
    if (!subscriptionId) {
      throw new Error('[SubscriptionService] subscriptionId is required to migrate subscription record');
    }

    if (!targetScheme) {
      throw new Error('[SubscriptionService] targetScheme is required to migrate subscription record');
    }

    const allowedSchemes = [HASH_SCHEMES.SHA256, HASH_SCHEMES.HMAC_SHA256];
    if (!allowedSchemes.includes(targetScheme)) {
      throw new Error(
        `[SubscriptionService] Invalid targetScheme '${targetScheme}'. Must be 'sha256' or 'hmac-sha256'.`
      );
    }

    // Fetch the existing legacy record (must have clientStateHashScheme: null)
    const existing = await GraphSubscription.findOne({
      subscriptionId,
      clientStateHashScheme: null
    }).lean();

    if (!existing) {
      return {
        migrated: false,
        reason: 'record_not_found_or_already_migrated',
        updated: null
      };
    }

    if (!existing.clientStateHash) {
      return {
        migrated: false,
        reason: 'no_stored_hash_to_verify_against',
        updated: null
      };
    }

    // Migration path: hmac-sha256
    // SAFETY: We must verify that the stored hash was actually produced by this key.
    // Without this check, a metadata update would relabel a sha256 hash as hmac-sha256,
    // causing all future notifications to fail verification silently.
    if (targetScheme === HASH_SCHEMES.HMAC_SHA256) {
      if (!targetKeyId) {
        throw new Error(
          '[SubscriptionService] targetKeyId is required when migrating to hmac-sha256 scheme.'
        );
      }
      if (!clientState || typeof clientState !== 'string') {
        throw new Error(
          '[SubscriptionService] clientState is required to verify hmac-sha256 migration. ' +
          'The hash cannot be migrated to hmac-sha256 without proving the stored hash ' +
          'was produced by the specified key.'
        );
      }
      if (!verificationSecret || typeof verificationSecret !== 'string') {
        throw new Error(
          '[SubscriptionService] verificationSecret is required to verify hmac-sha256 migration.'
        );
      }

      // Prove: does verificationSecret + clientState reproduce the stored hash?
      const candidateHash = crypto
        .createHmac('sha256', verificationSecret)
        .update(clientState)
        .digest('hex');

      if (!timingSafeCompare(candidateHash, existing.clientStateHash)) {
        return {
          migrated: false,
          reason: 'hmac_verification_failed_stored_hash_does_not_match_supplied_key',
          updated: null
        };
      }
      // Verification passed: safe to relabel as hmac-sha256 for this key
    }

    // Migration path: sha256 (explicit unkeyed)
    // This is safe: null-scheme records were originally defaulting to sha256.
    // We are only making the implicit algorithm explicit. No hash mutation.
    // No key provenance required.

    const updated = await GraphSubscription.findOneAndUpdate(
      { subscriptionId, clientStateHashScheme: null },
      {
        $set: {
          clientStateHashScheme: targetScheme,
          clientStateKeyId: targetScheme === HASH_SCHEMES.HMAC_SHA256 ? targetKeyId : 'unkeyed'
        }
      },
      { new: true }
    ).lean();

    if (!updated) {
      return {
        migrated: false,
        reason: 'concurrent_modification_or_already_migrated',
        updated: null
      };
    }

    return {
      migrated: true,
      reason: 'migration_successful',
      updated
    };
  }

}

module.exports = {
  SubscriptionService,
  GraphSubscriptionOperation,
  DEFAULT_EXPIRATION_MINUTES,
  MIN_EXPIRATION_MARGIN_HOURS,
  HASH_SCHEMES,
  hashClientState,
  generateClientState,
  timingSafeCompare,
  verifySubscriptionClientState,
  formatGraphResource,
  validateHmacKeyConfig,
  classifyGraphError,
  presentRecoveryResult,
  reservationKeyFor,
  isActiveOperationReservation,
  calculateCreationLeaseMs,
  acquireCreationReservation,
  releaseCreationReservation,
  extendCreationReservation,
  AMBIGUOUS_RECOVERY_POLICY
};

