'use strict';

const { GraphClient, GraphDeltaTokenExpiredError } = require('./graphClient');
const { getMailboxActivationAt, ingestMessageBatch } = require('./emailIngestionService');
const SupportEmail = require('../../models/SupportEmail');

const DEFAULT_GRAPH_SELECT = [
  'id',
  'internetMessageId',
  'conversationId',
  'receivedDateTime',
  'sentDateTime',
  'from',
  'toRecipients',
  'ccRecipients',
  'subject',
  'bodyPreview',
  'body',
  'hasAttachments',
  'importance',
  'isRead',
  'isDraft',
  'webLink'
].join(',');

const DEFAULT_REBASELINE_OVERLAP_MS = 5 * 60 * 1000; // 5-minute safety overlap window
const DEFAULT_HANDOFF_OVERLAP_MS = 5 * 60 * 1000; // 5-minute safety overlap window for delta handoff
const DELTA_FILTER_MAX_SAFE_THRESHOLD = 4500; // Safe threshold well below 5,000 Graph delta cap
const DEFAULT_CATCHUP_PAGE_SIZE = 50;

/**
 * Constructs the standard messages catch-up URL with New-Only activation boundary.
 * Unlike the delta endpoint, the standard messages endpoint does NOT have a 5,000-message limit.
 */
function buildCatchUpUrl({
  mailbox,
  folder = 'inbox',
  activationAt,
  top = DEFAULT_CATCHUP_PAGE_SIZE,
  selectFields = DEFAULT_GRAPH_SELECT
}) {
  const encodedMailbox = encodeURIComponent(mailbox.trim().toLowerCase());
  const encodedFolder = encodeURIComponent(folder.trim().toLowerCase());
  const path = `/users/${encodedMailbox}/mailFolders/${encodedFolder}/messages`;

  const params = new URLSearchParams({
    $select: selectFields,
    $orderby: 'receivedDateTime asc',
    $top: String(top)
  });

  if (activationAt instanceof Date && !isNaN(activationAt.getTime())) {
    params.set('$filter', `receivedDateTime ge ${activationAt.toISOString()}`);
  }

  return `${path}?${params.toString()}`;
}

/**
 * Constructs the Microsoft Graph delta query URL.
 */
function buildInitialDeltaUrl({
  mailbox,
  folder = 'inbox',
  activationAt = null,
  selectFields = DEFAULT_GRAPH_SELECT
}) {
  const encodedMailbox = encodeURIComponent(mailbox.trim().toLowerCase());
  const encodedFolder = encodeURIComponent(folder.trim().toLowerCase());
  const path = `/users/${encodedMailbox}/mailFolders/${encodedFolder}/messages/delta`;

  const params = new URLSearchParams({
    $select: selectFields
  });

  if (activationAt instanceof Date && !isNaN(activationAt.getTime())) {
    params.set('$filter', `receivedDateTime ge ${activationAt.toISOString()}`);
  }

  return `${path}?${params.toString()}`;
}

/**
 * Paginates through the standard messages endpoint to drain any backlog.
 * Standard messages endpoint has NO 5,000-item delta truncation limit.
 *
 * @param {Object} params
 * @param {GraphClient} params.graphClient
 * @param {string} params.initialUrl
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {Date} [params.activationAt]
 * @param {Object} [params.queueSvc]
 * @returns {Promise<{ count: number, historicalCount: number, duplicateCount: number, pages: number, maxReceivedDateTime: Date|null }>}
 */
async function paginateStandardMessages({
  graphClient,
  initialUrl,
  mailbox,
  folder = 'inbox',
  activationAt = null,
  queueSvc
}) {
  let currentUrl = initialUrl;
  let totalCount = 0;
  let totalHistorical = 0;
  let totalDuplicates = 0;
  let totalQuarantined = 0;
  let pageCount = 0;
  let maxReceivedDateTime = null;

  while (currentUrl) {
    pageCount++;
    const pageData = await graphClient.get(currentUrl);

    if (!pageData || !Array.isArray(pageData.value)) {
      throw new Error(`[deltaSyncService] Malformed Graph response in catch-up on page ${pageCount} (missing value array)`);
    }

    const messages = pageData.value;
    if (messages.length > 0) {
      for (const msg of messages) {
        if (msg.receivedDateTime) {
          const dt = new Date(msg.receivedDateTime);
          if (!isNaN(dt.getTime())) {
            if (!maxReceivedDateTime || dt > maxReceivedDateTime) {
              maxReceivedDateTime = dt;
            }
          }
        }
      }

      const batchResult = await ingestMessageBatch({
        messages,
        mailbox,
        folder,
        activationAt,
        queueSvc
      });

      totalCount += batchResult.ingestedCount;
      totalHistorical += batchResult.historicalCount;
      totalDuplicates += batchResult.duplicateCount;
      totalQuarantined += (batchResult.quarantinedCount || 0);
    }

    currentUrl = pageData['@odata.nextLink'] || null;
  }

  return {
    count: totalCount,
    historicalCount: totalHistorical,
    duplicateCount: totalDuplicates,
    quarantinedCount: totalQuarantined,
    pages: pageCount,
    maxReceivedDateTime
  };
}

/**
 * Paginates through all pages of a Microsoft Graph delta query.
 *
 * CRITICAL ZERO-DATA-LOSS GUARANTEES:
 * 1. Follows every @odata.nextLink until the final page.
 * 2. Ingests each page's messages before requesting the next page.
 * 3. If any page fails, the pass aborts and throws WITHOUT advancing the delta cursor.
 * 4. Extracts and returns the final @odata.deltaLink for persistence.
 *
 * @param {Object} params
 * @param {GraphClient} params.graphClient
 * @param {string} params.initialUrl Initial URL or persisted deltaLink
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {Date} [params.activationAt]
 * @param {Object} [params.queueSvc]
 * @returns {Promise<{ nextDeltaLink: string, count: number, historicalCount: number, duplicateCount: number, pages: number }>}
 */
async function paginateDeltaQuery({
  graphClient,
  initialUrl,
  mailbox,
  folder = 'inbox',
  activationAt = null,
  queueSvc
}) {
  let currentUrl = initialUrl;
  let nextDeltaLink = null;
  let totalCount = 0;
  let totalHistorical = 0;
  let totalDuplicates = 0;
  let totalQuarantined = 0;
  let pageCount = 0;

  while (currentUrl) {
    pageCount++;
    const pageData = await graphClient.get(currentUrl);

    if (!pageData || !Array.isArray(pageData.value)) {
      throw new Error(`[deltaSyncService] Malformed Graph response on delta page ${pageCount} (missing value array)`);
    }

    const messages = pageData.value;
    if (messages.length > 0) {
      const batchResult = await ingestMessageBatch({
        messages,
        mailbox,
        folder,
        activationAt,
        queueSvc
      });

      totalCount += batchResult.ingestedCount;
      totalHistorical += batchResult.historicalCount;
      totalDuplicates += batchResult.duplicateCount;
      totalQuarantined += (batchResult.quarantinedCount || 0);
    }

    // Determine pagination state
    if (pageData['@odata.nextLink']) {
      currentUrl = pageData['@odata.nextLink'];
    } else if (pageData['@odata.deltaLink']) {
      nextDeltaLink = pageData['@odata.deltaLink'];
      currentUrl = null; // Reached end of delta stream
    } else {
      currentUrl = null;
    }
  }

  if (!nextDeltaLink) {
    throw new Error(`[deltaSyncService] Graph delta sync completed ${pageCount} pages but returned no @odata.deltaLink`);
  }

  // Guard against silent 5,000 delta filter truncation:
  // If Graph returned 5,000 or more items across pagination ON A FILTERED QUERY,
  // it terminated the delta stream prematurely. On UNFILTERED delta queries, pagination is unlimited.
  const hasFilter = typeof initialUrl === 'string' && initialUrl.includes('$filter=');
  const totalItemsEncountered = totalCount + totalHistorical + totalDuplicates + totalQuarantined;
  if (hasFilter && pageCount > 0 && totalItemsEncountered >= 5000) {
    throw new Error(`[deltaSyncService] Graph delta filter truncated at ${totalItemsEncountered} messages; refusing to accept incomplete deltaLink`);
  }

  return {
    nextDeltaLink,
    count: totalCount,
    historicalCount: totalHistorical,
    duplicateCount: totalDuplicates,
    quarantinedCount: totalQuarantined,
    pages: pageCount
  };
}

/**
 * Calculates a safe delta attachment start timestamp that covers delayed transport commits,
 * clock skew, and boundary gaps while strictly respecting the 5,000-message delta filter cap.
 *
 * @param {Object} params
 * @param {Date|null} params.maxReceivedDateTime Latest message receivedDateTime seen in catch-up
 * @param {Date} params.activationAt Mailbox activation timestamp
 * @param {string} params.mailbox Mailbox address
 * @param {number} [params.requestedOverlapMs=DEFAULT_HANDOFF_OVERLAP_MS]
 * @returns {Promise<Date>} Safe delta attachment timestamp
 */
async function calculateSafeHandoffStartTime({
  maxReceivedDateTime,
  activationAt,
  mailbox,
  requestedOverlapMs = DEFAULT_HANDOFF_OVERLAP_MS
}) {
  if (!maxReceivedDateTime || isNaN(maxReceivedDateTime.getTime())) {
    return activationAt;
  }

  const maxTime = maxReceivedDateTime.getTime();
  const activationTime = activationAt ? activationAt.getTime() : 0;

  if (maxTime <= activationTime) {
    return activationAt;
  }

  let candidateTime = Math.max(activationTime, maxTime - requestedOverlapMs);

  try {
    const candidateDate = new Date(candidateTime);
    const countInWindow = await SupportEmail.countDocuments({
      'metadata.mailbox': mailbox.trim().toLowerCase(),
      receivedDateTime: { $gte: candidateDate, $lte: maxReceivedDateTime }
    });

    // If an extreme burst occurred (>= DELTA_FILTER_MAX_SAFE_THRESHOLD messages in overlap window),
    // shrink the overlap window to exact maxReceivedDateTime (0 ms overlap) so delta query does not truncate.
    if (countInWindow >= DELTA_FILTER_MAX_SAFE_THRESHOLD) {
      candidateTime = maxTime;
    }
  } catch (err) {
    // If DB check fails, fallback to maxReceivedDateTime safely
    candidateTime = maxTime;
  }

  return new Date(candidateTime);
}

/**
 * Executes a Two-Phase Baseline:
 * Phase 1: Drains backlog (even > 5,000 items) via standard filtered messages endpoint.
 * Phase 2: Attaches delta stream at the head of the stream (< 5,000 items) and returns valid @odata.deltaLink.
 */
async function executeTwoPhaseBaseline({
  graphClient,
  mailbox,
  folder = 'inbox',
  activationAt,
  queueSvc,
  selectFields = DEFAULT_GRAPH_SELECT,
  handoffOverlapMs = DEFAULT_HANDOFF_OVERLAP_MS
}) {
  let catchUpTotalCount = 0;
  let catchUpHistoricalCount = 0;
  let catchUpDuplicateCount = 0;
  let catchUpPages = 0;
  let maxReceivedDateTime = null;

  // Phase 1: Standard messages catch-up (no 5,000 truncation limit)
  // Iterative convergence loop: continues draining if pass count exceeds threshold
  const DRAIN_CONVERGENCE_THRESHOLD = 500;
  const MAX_CATCHUP_PASSES = 5;
  let passNumber = 0;
  let currentActivationAt = activationAt;

  while (passNumber < MAX_CATCHUP_PASSES) {
    passNumber++;
    const catchUpUrl = buildCatchUpUrl({
      mailbox,
      folder,
      activationAt: currentActivationAt,
      selectFields
    });

    const passResult = await paginateStandardMessages({
      graphClient,
      initialUrl: catchUpUrl,
      mailbox,
      folder,
      activationAt,
      queueSvc
    });

    catchUpTotalCount += passResult.count;
    catchUpHistoricalCount += passResult.historicalCount;
    catchUpDuplicateCount += passResult.duplicateCount;
    catchUpPages += passResult.pages;

    if (passResult.maxReceivedDateTime) {
      if (!maxReceivedDateTime || passResult.maxReceivedDateTime > maxReceivedDateTime) {
        maxReceivedDateTime = passResult.maxReceivedDateTime;
      }
    }

    // Stop iterating if pass processed fewer than threshold, or no messages returned
    if (passResult.count < DRAIN_CONVERGENCE_THRESHOLD || !passResult.maxReceivedDateTime) {
      break;
    }

    // Advance to latest timestamp for subsequent catch-up pass
    currentActivationAt = maxReceivedDateTime;
  }

  // Phase 2: Delta stream attachment at head of stream with safe handoff overlap
  const deltaStartTime = await calculateSafeHandoffStartTime({
    maxReceivedDateTime,
    activationAt,
    mailbox,
    requestedOverlapMs: handoffOverlapMs
  });

  const deltaInitUrl = buildInitialDeltaUrl({
    mailbox,
    folder,
    activationAt: deltaStartTime,
    selectFields
  });

  const deltaResult = await paginateDeltaQuery({
    graphClient,
    initialUrl: deltaInitUrl,
    mailbox,
    folder,
    activationAt,
    queueSvc
  });

  return {
    nextDeltaLink: deltaResult.nextDeltaLink,
    count: catchUpTotalCount + deltaResult.count,
    historicalCount: catchUpHistoricalCount + deltaResult.historicalCount,
    duplicateCount: catchUpDuplicateCount + deltaResult.duplicateCount,
    pages: catchUpPages + deltaResult.pages,
    catchUpCount: catchUpTotalCount,
    deltaCount: deltaResult.count,
    deltaStartTime
  };
}

/**
 * Executes an Unfiltered Initial Delta Baseline:
 * Queries /messages/delta WITHOUT any $filter parameter.
 * Follows all @odata.nextLink pages until the final @odata.deltaLink is returned.
 * Enforces the activation boundary locally in emailIngestionService:
 * - Messages with receivedDateTime >= activationAt are ingested into active pipeline.
 * - Messages with receivedDateTime < activationAt are marked isHistorical: true and bypass the queue.
 * - The 5,000-message filter limitation does NOT apply because NO $filter parameter is used.
 * - Returns the final official @odata.deltaLink for subsequent incremental synchronization.
 *
 * @param {Object} params
 * @param {GraphClient} params.graphClient
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {Date} params.activationAt
 * @param {Object} [params.queueSvc]
 * @param {string} [params.selectFields=DEFAULT_GRAPH_SELECT]
 * @returns {Promise<{ nextDeltaLink: string, count: number, historicalCount: number, duplicateCount: number, pages: number, isUnfilteredBaseline: boolean }>}
 */
async function executeUnfilteredDeltaBaseline({
  graphClient,
  mailbox,
  folder = 'inbox',
  activationAt,
  queueSvc,
  selectFields = DEFAULT_GRAPH_SELECT
}) {
  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();

  // Initial delta URL with strictly NO $filter parameter
  const initialDeltaUrl = buildInitialDeltaUrl({
    mailbox: normMailbox,
    folder: normFolder,
    activationAt: null, // UNFILTERED: strictly no $filter
    selectFields
  });

  const deltaResult = await paginateDeltaQuery({
    graphClient,
    initialUrl: initialDeltaUrl,
    mailbox: normMailbox,
    folder: normFolder,
    activationAt,
    queueSvc
  });

  return {
    nextDeltaLink: deltaResult.nextDeltaLink,
    count: deltaResult.count,
    historicalCount: deltaResult.historicalCount,
    duplicateCount: deltaResult.duplicateCount,
    quarantinedCount: deltaResult.quarantinedCount || 0,
    pages: deltaResult.pages,
    isUnfilteredBaseline: true
  };
}

/**
 * Checks if an error represents an invalidated or expired Microsoft Graph delta token.
 * Catches HTTP 410 Gone, ErrorDeltaTokenExpired, syncStateNotFound, resyncRequired,
 * and nested Graph error codes.
 */
function isDeltaTokenExpiredError(err) {
  if (!err) return false;
  if (err instanceof GraphDeltaTokenExpiredError) return true;
  if (err.statusCode === 410 || err.status === 410 || err.response?.status === 410) return true;

  const candidateCodes = [
    err.code,
    err.statusCode,
    err.innerCode,
    err.details?.code,
    err.response?.data?.error?.code,
    err.response?.data?.error?.innerError?.code,
    err.response?.data?.error?.innererror?.code
  ].filter(Boolean);

  const expiredTokens = ['ErrorDeltaTokenExpired', 'syncStateNotFound', 'resyncRequired', '410', 410];
  return candidateCodes.some((code) => expiredTokens.includes(code));
}

/**
 * Executes a delta synchronization pass for a mailbox, handling initial baseline,
 * incremental sync, and controlled HTTP 410 delta token expiration recovery.
 *
 * @param {Object} params
 * @param {Object} params.cursor EmailSyncCursor document (or lean object)
 * @param {string} params.mailbox
 * @param {string} [params.folder='inbox']
 * @param {GraphClient} [params.graphClient]
 * @param {number} [params.rebaselineOverlapMs=300000]
 * @param {string} [params.baselineStrategy='two-phase'] 'two-phase' | 'unfiltered'
 * @param {string} [params.selectFields=DEFAULT_GRAPH_SELECT]
 * @param {Object} [params.queueSvc]
 * @returns {Promise<{ nextDeltaLink: string, count: number, isRebaseline?: boolean }>}
 */
async function executeSyncPass({
  cursor,
  mailbox,
  folder = 'inbox',
  graphClient = new GraphClient(),
  rebaselineOverlapMs = DEFAULT_REBASELINE_OVERLAP_MS,
  baselineStrategy = 'two-phase',
  selectFields = DEFAULT_GRAPH_SELECT,
  queueSvc
}) {
  const normMailbox = mailbox.trim().toLowerCase();
  const normFolder = folder.trim().toLowerCase();

  // 1. Resolve activation boundary
  const policyActivationAt = await getMailboxActivationAt(normMailbox);
  const effectiveActivationAt = cursor.activationAt || policyActivationAt || new Date();

  // Resolve baseline strategy: explicit option > cursor config > default 'two-phase'
  const strategy = baselineStrategy || cursor.baselineStrategy || 'two-phase';

  // 2. Initial Baseline vs Incremental Sync
  if (!cursor.deltaLink) {
    let baselineResult;
    if (strategy === 'unfiltered') {
      baselineResult = await executeUnfilteredDeltaBaseline({
        graphClient,
        mailbox: normMailbox,
        folder: normFolder,
        activationAt: effectiveActivationAt,
        selectFields,
        queueSvc
      });
    } else {
      baselineResult = await executeTwoPhaseBaseline({
        graphClient,
        mailbox: normMailbox,
        folder: normFolder,
        activationAt: effectiveActivationAt,
        selectFields,
        handoffOverlapMs: rebaselineOverlapMs,
        queueSvc
      });
    }

    return {
      ...baselineResult,
      isRebaseline: false
    };
  }

  // 3. Incremental Delta Sync with Controlled 410 / Resync Recovery
  try {
    const result = await paginateDeltaQuery({
      graphClient,
      initialUrl: cursor.deltaLink,
      mailbox: normMailbox,
      folder: normFolder,
      activationAt: effectiveActivationAt,
      queueSvc
    });

    return {
      ...result,
      isRebaseline: false
    };
  } catch (err) {
    // Catch HTTP 410 / ErrorDeltaTokenExpired / syncStateNotFound / resyncRequired
    if (isDeltaTokenExpiredError(err)) {
      const lastSync = cursor.lastSuccessfulSyncAt ? new Date(cursor.lastSuccessfulSyncAt).getTime() : 0;
      const activationTime = effectiveActivationAt ? effectiveActivationAt.getTime() : 0;
      const rebaselineFromMs = Math.max(activationTime, lastSync - rebaselineOverlapMs);
      const rebaselineFrom = new Date(rebaselineFromMs);

      let recoveryResult;
      if (strategy === 'unfiltered') {
        recoveryResult = await executeUnfilteredDeltaBaseline({
          graphClient,
          mailbox: normMailbox,
          folder: normFolder,
          activationAt: effectiveActivationAt,
          selectFields,
          queueSvc
        });
      } else {
        recoveryResult = await executeTwoPhaseBaseline({
          graphClient,
          mailbox: normMailbox,
          folder: normFolder,
          activationAt: rebaselineFrom,
          selectFields,
          handoffOverlapMs: rebaselineOverlapMs,
          queueSvc
        });
      }

      return {
        ...recoveryResult,
        isRebaseline: true,
        rebaselineFrom: strategy === 'unfiltered' ? effectiveActivationAt : rebaselineFrom
      };
    }

    // Re-throw any other error
    throw err;
  }
}

/**
 * Creates a syncPassFn adapter for integration into mailboxSyncService.runCoalescedSync.
 *
 * @param {Object} options
 * @param {GraphClient} options.graphClient
 * @param {string} options.mailbox
 * @param {string} [options.folder='inbox']
 * @param {Object} [options.queueSvc]
 * @returns {Function} (cursor) => Promise<{ nextDeltaLink: string, count: number }>
 */
function createSyncPassFn({ graphClient, mailbox, folder = 'inbox', queueSvc } = {}) {
  return async function syncPassFn(cursor) {
    return executeSyncPass({
      cursor,
      mailbox,
      folder,
      graphClient,
      queueSvc
    });
  };
}

module.exports = {
  DEFAULT_GRAPH_SELECT,
  DEFAULT_REBASELINE_OVERLAP_MS,
  DEFAULT_HANDOFF_OVERLAP_MS,
  DELTA_FILTER_MAX_SAFE_THRESHOLD,
  buildCatchUpUrl,
  buildInitialDeltaUrl,
  calculateSafeHandoffStartTime,
  paginateStandardMessages,
  paginateDeltaQuery,
  executeTwoPhaseBaseline,
  executeUnfilteredDeltaBaseline,
  executeSyncPass,
  createSyncPassFn
};
