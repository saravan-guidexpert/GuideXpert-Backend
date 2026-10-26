'use strict';

const { CrmError } = require('../../utils/crmError');
const { actorId } = require('./fields');
const {
  CONSULTANCY_FOLLOW_UP_STATUSES,
  CONSULTANCY_PIPELINE,
  CALLING_STATUSES,
  FOLLOW_UP_PIPELINE,
  PIPELINE_FOLLOW_UP,
  OPEN_FOLLOW_UP_STATUSES,
  REMARK_MAX,
} = require('../../constants/crm');

function actorName(actor) {
  return (actor && actor.name) || (actor && actor.actorType === 'crm-user' ? 'CRM user' : 'Platform admin');
}

function authorStamp(actor) {
  if (actor && actor.actorType === 'crm-user') {
    return {
      authorCrmUserId: actor._id,
      authorAdminId: null,
      createdByCrmUserId: actor._id,
      createdByAdminId: null,
      authorName: actorName(actor),
    };
  }
  return {
    authorAdminId: actorId(actor),
    authorCrmUserId: null,
    createdByAdminId: actorId(actor),
    createdByCrmUserId: null,
    authorName: actorName(actor),
  };
}

function sameAuthor(row, actor) {
  if (actor && actor.actorType === 'crm-user') {
    return Boolean(row.authorCrmUserId) && String(row.authorCrmUserId) === String(actor._id);
  }
  return Boolean(row.authorAdminId) && String(row.authorAdminId) === String(actorId(actor));
}

function boundedText(value, label, max, { required = false, min = 1 } = {}) {
  if (value == null || value === '') {
    if (required) throw new CrmError(400, `${label} must be ${min}–${max} characters.`, 'invalid_body');
    return '';
  }
  if (typeof value !== 'string') throw new CrmError(400, `${label} is not valid.`, 'invalid_body');
  const text = value.trim();
  if (required && text.length < min) {
    throw new CrmError(400, `${label} must be ${min}–${max} characters.`, 'invalid_body');
  }
  if (text.length > max) throw new CrmError(400, `${label} must be at most ${max} characters.`, 'invalid_body');
  return text;
}

function remarkText(value) {
  if (typeof value !== 'string') {
    throw new CrmError(400, `A remark needs 1–${REMARK_MAX} characters.`, 'invalid_body');
  }
  const text = value.trim();
  if (!text || text.length > REMARK_MAX) {
    throw new CrmError(400, `A remark needs 1–${REMARK_MAX} characters.`, 'invalid_body');
  }
  return text;
}

function parseDate(value, label) {
  const when = new Date(value);
  if (!value || Number.isNaN(when.getTime())) {
    throw new CrmError(400, `${label} is not a valid date.`, 'invalid_body');
  }
  return when;
}

function applyCallingChange(doc, calling, actor, now) {
  const next = calling || '';
  if ((doc.callingStatus || '') === next) return false;
  doc.callingStatus = next;
  doc.callingStatusChangedAt = now;
  if (actor && actor.actorType === 'crm-user') {
    doc.callingStatusChangedByCrmUserId = actor._id;
    doc.callingStatusChangedByAdminId = null;
  } else {
    doc.callingStatusChangedByAdminId = actorId(actor);
    doc.callingStatusChangedByCrmUserId = null;
  }
  if (next === 'Connected' || next === 'WhatsApp Call Connected') doc.lastContactAt = now;
  return true;
}

function applyWorkflow(doc, body, actor, now) {
  const source = body || {};
  const hasFollow = Object.prototype.hasOwnProperty.call(source, 'followUpStatus') && source.followUpStatus != null && source.followUpStatus !== '';
  const hasPipe = Object.prototype.hasOwnProperty.call(source, 'pipelineStage') && source.pipelineStage != null && source.pipelineStage !== '';
  const hasCalling = Object.prototype.hasOwnProperty.call(source, 'callingStatus');
  if (hasFollow) {
    if (!CONSULTANCY_FOLLOW_UP_STATUSES.includes(source.followUpStatus)) {
      throw new CrmError(400, 'Choose a consultancy status.', 'invalid_body');
    }
    const derived = FOLLOW_UP_PIPELINE[source.followUpStatus];
    if (hasPipe && source.pipelineStage !== derived) {
      throw new CrmError(400, 'Pipeline stage does not match the consultancy status.', 'invalid_body');
    }
    doc.followUpStatus = source.followUpStatus;
    doc.pipelineStage = derived;
  } else if (hasPipe) {
    if (!CONSULTANCY_PIPELINE.includes(source.pipelineStage)) {
      throw new CrmError(400, 'Choose a pipeline stage.', 'invalid_body');
    }
    doc.pipelineStage = source.pipelineStage;
    doc.followUpStatus = PIPELINE_FOLLOW_UP[source.pipelineStage];
  }
  if (hasCalling) {
    const calling = source.callingStatus == null ? '' : source.callingStatus;
    if (calling && !CALLING_STATUSES.includes(calling)) {
      throw new CrmError(400, 'Choose a calling status.', 'invalid_body');
    }
    applyCallingChange(doc, calling, actor, now);
  }
}

function blankWorkflow() {
  return {
    followUpStatus: 'Fresh Lead',
    callingStatus: '',
    pipelineStage: 'fresh',
    lastContactAt: null,
    nextFollowUpAt: null,
    callingStatusChangedAt: null,
    callingStatusChangedByAdminId: null,
    callingStatusChangedByCrmUserId: null,
  };
}

function earliestOpenFollowUp(rows) {
  const open = (rows || []).filter((row) => (
    row.scheduledAt
    && !row.completedAt
    && !row.cancelledAt
    && OPEN_FOLLOW_UP_STATUSES.includes(row.status)
  ));
  open.sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime());
  return open[0] || null;
}

module.exports = {
  actorName,
  authorStamp,
  sameAuthor,
  boundedText,
  remarkText,
  parseDate,
  applyCallingChange,
  applyWorkflow,
  blankWorkflow,
  earliestOpenFollowUp,
  OPEN_FOLLOW_UP_STATUSES,
  REMARK_MAX,
};
