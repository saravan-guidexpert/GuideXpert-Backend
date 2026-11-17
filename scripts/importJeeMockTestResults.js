'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { ensureJeeMockTestResultsImported } = require('../services/jeeMockTestResults/importResults');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  const refresh = process.argv.includes('--refresh');
  const result = await ensureJeeMockTestResultsImported({ refresh });
  console.log('[jee-results] import', result);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('[jee-results] import failed', error && error.message ? error.message : error);
  process.exit(1);
});
