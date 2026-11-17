'use strict';

const mongoose = require('mongoose');

const SUBSCRIPTION_OPERATION_STATES = Object.freeze([
  'pending',
  'completed',
  'failed',
  'abandoned'
]);

const graphSubscriptionOperationSchema = new mongoose.Schema(
  {
    operationId: {
      type: String,
      required: true,
      trim: true
    },
    mailbox: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    folder: {
      type: String,
      trim: true,
      default: 'inbox'
    },
    resource: {
      type: String,
      required: true,
      trim: true
    },
    notificationUrl: {
      type: String,
      required: true,
      trim: true
    },
    lifecycleUrl: {
      type: String,
      trim: true,
      default: null
    },
    state: {
      type: String,
      enum: SUBSCRIPTION_OPERATION_STATES,
      default: 'pending'
    },
    subscriptionId: {
      type: String,
      trim: true,
      default: null
    },
    clientStateHash: {
      type: String,
      trim: true,
      default: null
    },
    clientStateHashScheme: {
      type: String,
      enum: ['hmac-sha256', 'sha256'],
      default: null
    },
    clientStateKeyId: {
      type: String,
      trim: true,
      default: null
    },
    requestedExpirationMinutes: {
      type: Number,
      default: 4200
    },
    leaseExpiresAt: {
      type: Date,
      required: true
    },
    completedAt: {
      type: Date,
      default: null
    },
    lastError: {
      type: String,
      trim: true,
      default: null
    },
    failureClassification: {
      type: String,
      enum: ['ambiguous', 'confirmed_rejection', null],
      default: null
    },
    // Distributed creation reservation token. Exactly one operation per mailbox/folder may hold
    // this value at a time (enforced by a unique partial index). Released when the operation
    // completes or is confirmed rejected; retained for the full protection lease when the Graph
    // outcome is ambiguous. Never used for ownership checks without also checking leaseExpiresAt.
    reservationKey: {
      type: String,
      trim: true,
      default: null
    },
    // Change type sent on the creation POST. Recovery requires the remote subscription
    // to match it; resource + notification URL alone is not specific enough to adopt.
    changeType: {
      type: String,
      trim: true,
      default: null
    },
    // Set immediately before POST /subscriptions is dispatched. An expired pending
    // operation may be abandoned only when this is still null. Once it is set, the POST
    // may have reached Graph even if the process died before recording the response.
    graphPostDispatchedAt: {
      type: Date,
      default: null
    },
    // Counts recovery passes that actually queried Microsoft Graph.
    recoveryAttempts: {
      type: Number,
      default: 0
    },
    // Complete enumerations (or exact-id lookups) that found no acceptable match.
    // A single observation is not proof the POST failed. See AMBIGUOUS_RECOVERY_POLICY.
    absenceObservations: {
      type: Number,
      default: 0
    },
    // Earliest time a no-match recheck may run. Earlier workers must not POST and
    // must not count another absence observation.
    nextRecoveryAt: {
      type: Date,
      default: null
    },
    // Short claim so two recovery workers cannot adopt or release the same operation.
    // Mutations still also require operationId and reservationKey.
    recoveryClaimedBy: {
      type: String,
      trim: true,
      default: null
    },
    recoveryClaimExpiresAt: {
      type: Date,
      default: null
    },
    // none -> enumerating -> awaiting_recheck -> manual_required
    // enumerating -> completed (adoption) is recorded as state=completed, recoveryState=none
    // confirmed_absent is retained for legacy documents and is NOT assigned by the
    // current policy: absence is never treated as confirmed strongly enough to POST again.
    recoveryState: {
      type: String,
      enum: ['none', 'enumerating', 'awaiting_recheck', 'confirmed_absent', 'manual_required'],
      default: 'none'
    }
  },
  {
    timestamps: true
  }
);

graphSubscriptionOperationSchema.index({ operationId: 1 }, { unique: true });
graphSubscriptionOperationSchema.index({ mailbox: 1, folder: 1, state: 1 });
graphSubscriptionOperationSchema.index({ mailbox: 1, folder: 1, leaseExpiresAt: 1 });
graphSubscriptionOperationSchema.index({ subscriptionId: 1 }, { sparse: true });
graphSubscriptionOperationSchema.index({ leaseExpiresAt: 1 });
// Atomic single-flight reservation. Partial so historical operations (no reservationKey)
// remain untouched and do not violate uniqueness.
graphSubscriptionOperationSchema.index(
  { reservationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { reservationKey: { $type: 'string' } },
    name: 'reservationKey_1_unique_partial'
  }
);
graphSubscriptionOperationSchema.index({ mailbox: 1, folder: 1, recoveryState: 1 }, { name: 'mailbox_1_folder_1_recoveryState_1' });

module.exports = mongoose.model('GraphSubscriptionOperation', graphSubscriptionOperationSchema);

