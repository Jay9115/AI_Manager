const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, process.env.KEY_STORE_FILE || 'api-keys.json');

function createRecord(value, index, existing = {}) {
  return {
    id: existing.id || `gemini-${index + 1}`,
    value,
    label: existing.label || `Gemini key ${index + 1}`,
    enabled: existing.enabled !== false,
    status: existing.status || 'healthy',
    cooldownUntil: existing.cooldownUntil || 0,
    consecutiveFailures: existing.consecutiveFailures || 0,
    usage: {
      requests: existing.usage?.requests || 0,
      successes: existing.usage?.successes || 0,
      failures: existing.usage?.failures || 0,
      promptTokens: existing.usage?.promptTokens || 0,
      outputTokens: existing.usage?.outputTokens || 0,
      totalTokens: existing.usage?.totalTokens || 0,
      lastUsedAt: existing.usage?.lastUsedAt || null,
    },
  };
}

function loadKeys(seedValues) {
  let records = [];
  if (fs.existsSync(STORE_PATH)) {
    try {
      records = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch (error) {
      throw new Error(`Could not read ${STORE_PATH}: ${error.message}`);
    }
  }

  if (!Array.isArray(records) || records.length === 0) {
    records = seedValues.map((value, index) => createRecord(value, index));
    saveKeys(records);
  } else {
    records = records.map((record, index) => createRecord(record.value, index, record));
  }
  return records;
}

function saveKeys(records) {
  if (process.env.VERCEL) return;
  const temporaryPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, STORE_PATH);
}

function maskKey(value) {
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function publicKey(record) {
  return {
    id: record.id,
    label: record.label,
    maskedKey: maskKey(record.value),
    enabled: record.enabled,
    status: record.status,
    cooldownUntil: record.cooldownUntil,
    consecutiveFailures: record.consecutiveFailures,
    usage: record.usage,
  };
}

module.exports = { loadKeys, saveKeys, publicKey };
