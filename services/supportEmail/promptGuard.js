'use strict';

const INJECTION_PATTERNS = [
  { code: 'instruction_override', pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i },
  { code: 'role_override', pattern: /you\s+are\s+now\b/i },
  { code: 'prompt_exfiltration', pattern: /reveal\s+(your\s+)?(system\s+)?prompt/i },
  { code: 'tool_request', pattern: /\b(send\s+(an\s+)?email|exfiltrate|dump\s+the\s+database)\b/i }
];

/**
 * Scans untrusted email and attachment text for instruction-hijacking patterns.
 * Returned reasons are codes, never excerpts of the message.
 */
function inspectUntrustedText(text) {
  const source = String(text || '');
  const reasons = [];
  INJECTION_PATTERNS.forEach((entry) => {
    if (entry.pattern.test(source) && !reasons.includes(entry.code)) reasons.push(entry.code);
  });
  return { flagged: reasons.length > 0, reasons };
}

module.exports = {
  inspectUntrustedText
};
