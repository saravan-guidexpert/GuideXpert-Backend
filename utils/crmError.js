'use strict';

class CrmError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.code = code || 'crm_error';
    this.data = data;
  }
}

module.exports = { CrmError };
