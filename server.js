const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const dotenv = require('dotenv');
const { loadKeys, saveKeys, publicKey } = require('./key-store');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const AUTH_TOKEN = process.env.API_TOKEN || (isProduction ? '' : 'change-me');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (isProduction ? '' : AUTH_TOKEN);
const GOOGLE_API_BASE_URL = process.env.GOOGLE_API_BASE_URL || 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY_COOLDOWN_MS = Number(process.env.KEY_COOLDOWN_MS || 60000);
const MAX_REQUESTS_PER_MINUTE = Number(process.env.MAX_REQUESTS_PER_MINUTE || 120);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const rawKeys = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);

if (isProduction && (!AUTH_TOKEN || !ADMIN_TOKEN)) {
  throw new Error('API_TOKEN and ADMIN_TOKEN must be configured in production.');
}

const apiKeys = loadKeys(rawKeys);

let keyCursor = 0;

function logInfo(message, details = undefined) {
  if (details) {
    console.log(message, JSON.stringify(details));
  } else {
    console.log(message);
  }
}

function getHealthyKey() {
  if (apiKeys.length === 0) return null;

  for (let offset = 0; offset < apiKeys.length; offset += 1) {
    const candidate = apiKeys[(keyCursor + offset) % apiKeys.length];
    const now = Date.now();

    if (candidate.enabled && (candidate.status === 'healthy' || now >= candidate.cooldownUntil)) {
      keyCursor = (keyCursor + offset + 1) % apiKeys.length;
      return candidate;
    }
  }

  return null;
}

function markKeyCooldown(key, { reason, retryDelayMs = KEY_COOLDOWN_MS }) {
  key.status = 'cooldown';
  key.cooldownUntil = Date.now() + retryDelayMs;
  key.consecutiveFailures += 1;
  logInfo(`Key ${key.id} marked cooldown due to ${reason}`, {
    cooldownUntil: new Date(key.cooldownUntil).toISOString(),
    retryDelayMs,
  });
}

function resetKeyHealth(key) {
  key.status = 'healthy';
  key.cooldownUntil = 0;
  key.consecutiveFailures = 0;
}

function recordUsage(key, responseData, succeeded) {
  key.usage.requests += 1;
  key.usage.lastUsedAt = new Date().toISOString();
  key.usage[succeeded ? 'successes' : 'failures'] += 1;
  const usage = responseData?.usageMetadata || {};
  key.usage.promptTokens += Number(usage.promptTokenCount || 0);
  key.usage.outputTokens += Number(usage.candidatesTokenCount || 0);
  key.usage.totalTokens += Number(usage.totalTokenCount || 0);
  saveKeys(apiKeys);
}

function parseImageData(imageValue) {
  if (!imageValue) return null;

  if (typeof imageValue === 'string') {
    if (imageValue.startsWith('data:')) {
      const [header, data] = imageValue.split(',');
      const mime = header.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
      return { inlineData: { mimeType: mime, data } };
    }

    if (/^https?:\/\//i.test(imageValue)) {
      return { fileData: { mimeType: 'image/jpeg', fileUri: imageValue } };
    }

    if (imageValue.startsWith('http')) {
      return { fileData: { mimeType: 'image/jpeg', fileUri: imageValue } };
    }

    if (/^\s*base64:/i.test(imageValue)) {
      const cleaned = imageValue.replace(/^\s*base64:/i, '');
      return { inlineData: { mimeType: 'image/jpeg', data: cleaned } };
    }

    return { inlineData: { mimeType: 'image/jpeg', data: imageValue } };
  }

  if (typeof imageValue === 'object' && imageValue.url) {
    return { fileData: { mimeType: imageValue.mimeType || 'image/jpeg', fileUri: imageValue.url } };
  }

  return null;
}

function buildGeminiRequestBody(body = {}) {
  const model = body.model || DEFAULT_MODEL;
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const promptText = typeof body.prompt === 'string' ? body.prompt : body.text || '';

  if (rawMessages.length > 0) {
    const contents = rawMessages.map((message) => {
      const role = message.role === 'assistant' ? 'model' : 'user';
      const parts = [];

      if (typeof message.content === 'string') {
        parts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        message.content.forEach((piece) => {
          if (typeof piece === 'string') {
            parts.push({ text: piece });
            return;
          }

          if (piece && typeof piece === 'object') {
            if (piece.type === 'text' || piece.text) {
              parts.push({ text: piece.text || piece.content || '' });
            }

            const image = piece.image_url || piece.imageUrl || piece.image;
            const parsedImage = parseImageData(image);
            if (parsedImage) parts.push(parsedImage);
          }
        });
      }

      return {
        role,
        parts,
      };
    });

    return {
      model,
      contents,
      generationConfig: body.generationConfig || {},
      safetySettings: body.safetySettings || undefined,
      tools: body.tools || undefined,
      systemInstruction: body.systemInstruction || body.system || undefined,
    };
  }

  const imagePart = parseImageData(body.image || body.imageData || body.image_url || body.imageUrl);
  const parts = [{ text: promptText || 'Please provide a helpful response.' }];

  if (imagePart) {
    parts.push(imagePart);
  }

  return {
    model,
    contents: [{ role: 'user', parts }],
    generationConfig: body.generationConfig || {},
    safetySettings: body.safetySettings || undefined,
    tools: body.tools || undefined,
    systemInstruction: body.systemInstruction || body.system || undefined,
  };
}

function getResponseText(responseData) {
  const candidates = responseData?.candidates || [];
  const parts = candidates[0]?.content?.parts || [];
  const textSections = parts
    .filter((part) => part?.text)
    .map((part) => part.text)
    .join('\n');

  if (textSections) {
    return textSections;
  }

  return JSON.stringify(responseData || {}, null, 2);
}

async function callGeminiGenerativeApi(payload, modelName = DEFAULT_MODEL) {
  if (!apiKeys.length) {
    const error = new Error('No Gemini API keys are configured on the server.');
    error.statusCode = 503;
    throw error;
  }

  let lastError = null;

  for (let attempt = 0; attempt < apiKeys.length; attempt += 1) {
    const key = getHealthyKey();

    if (!key) {
      const error = new Error('All configured Gemini API keys are temporarily exhausted. Please retry later.');
      error.statusCode = 429;
      throw error;
    }

    const endpoint = `${GOOGLE_API_BASE_URL}/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(key.value)}`;

    try {
      const response = await axios.post(endpoint, payload, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: Number(process.env.UPSTREAM_TIMEOUT_MS || (process.env.VERCEL ? 55000 : 120000)),
      });

      recordUsage(key, response.data, true);
      resetKeyHealth(key);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const errorMessage = error.response?.data?.error?.message || error.message;
      lastError = error;
      recordUsage(key, error.response?.data, false);

      if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|daily limit/i.test(errorMessage)) {
        markKeyCooldown(key, { reason: 'quota or rate limit exceeded', retryDelayMs: KEY_COOLDOWN_MS });
        continue;
      }

      if (status === 401 || status === 403) {
        key.status = 'invalid';
        key.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
        logInfo(`Key ${key.id} was invalid or rejected by Google.`, { status, errorMessage });
        continue;
      }

      if (status && status >= 500) {
        markKeyCooldown(key, { reason: 'server-side API error', retryDelayMs: 15000 });
        continue;
      }

      const requestError = new Error(errorMessage || 'Gemini request failed.');
      requestError.statusCode = status || 500;
      throw requestError;
    }
  }

  if (lastError) {
    const finalError = new Error(lastError.response?.data?.error?.message || 'Gemini service is temporarily unavailable.');
    finalError.statusCode = lastError.response?.status || 429;
    throw finalError;
  }

  const fallbackError = new Error('Gemini request failed after trying all available API keys.');
  fallbackError.statusCode = 429;
  throw fallbackError;
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const apiKeyHeader = req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '';
  const queryApiKey = typeof req.query.key === 'string' ? req.query.key : '';
  const provided = authHeader.startsWith('Bearer ')
    ? authHeader.replace('Bearer ', '').trim()
    : apiKeyHeader || queryApiKey;

  if (provided && provided === AUTH_TOKEN) {
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Provide the proxy key with Authorization: Bearer <API_TOKEN>, X-Goog-Api-Key, X-API-Key, or the key query parameter.',
  });
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ')
    ? authHeader.replace('Bearer ', '').trim()
    : req.headers['x-admin-token'] || '';
  if (provided && provided === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized', message: 'Provide a valid admin token.' });
}

function getUpstreamPath(req) {
  const prefix = req.path.startsWith('/v1/') ? '/v1/' : '/v1beta/';
  return `${prefix}${req.path.slice(prefix.length)}`;
}

async function proxyGeminiRequest(req, res) {
  if (!apiKeys.length) {
    return res.status(503).json({
      error: { code: 503, message: 'No Gemini API keys are configured on the server.', status: 'UNAVAILABLE' },
    });
  }

  let lastError = null;
  const isStreaming = req.path.endsWith(':streamGenerateContent');

  for (let attempt = 0; attempt < apiKeys.length; attempt += 1) {
    const key = getHealthyKey();
    if (!key) {
      return res.status(429).json({
        error: { code: 429, message: 'All configured Gemini API keys are temporarily exhausted. Please retry later.', status: 'RESOURCE_EXHAUSTED' },
      });
    }

    const query = new URLSearchParams(req.query);
    query.delete('key');
    query.set('key', key.value);
    const endpoint = `${GOOGLE_API_BASE_URL}${getUpstreamPath(req)}?${query.toString()}`;

    try {
      const response = await axios({
        method: req.method,
        url: endpoint,
        data: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
        responseType: isStreaming ? 'stream' : 'json',
        headers: {
          'Content-Type': req.get('content-type') || 'application/json',
          Accept: req.get('accept') || (isStreaming ? 'text/event-stream' : 'application/json'),
        },
        timeout: Number(process.env.UPSTREAM_TIMEOUT_MS || (process.env.VERCEL ? 55000 : 120000)),
        validateStatus: () => true,
      });

      if (response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403) {
        const errorMessage = response.data?.error?.message || `Gemini request failed with status ${response.status}.`;
        if (response.data?.destroy) response.data.destroy();
        if (response.status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|daily limit/i.test(errorMessage)) {
          markKeyCooldown(key, { reason: 'quota or rate limit exceeded', retryDelayMs: KEY_COOLDOWN_MS });
        } else if (response.status === 401 || response.status === 403) {
          key.status = 'invalid';
          key.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
        } else {
          markKeyCooldown(key, { reason: 'server-side API error', retryDelayMs: 15000 });
        }
        lastError = { status: response.status, data: response.data };
        continue;
      }

      recordUsage(key, response.data, true);
      resetKeyHealth(key);
      res.status(response.status);
      Object.entries(response.headers).forEach(([name, value]) => {
        if (value !== undefined && name.toLowerCase() !== 'content-length') res.setHeader(name, value);
      });
      if (isStreaming) {
        response.data.on('error', (error) => res.destroy(error));
        response.data.pipe(res);
      } else {
        res.send(response.data);
      }
      return;
    } catch (error) {
      lastError = error;
      if (error.code === 'ECONNABORTED' || error.response?.status >= 500) {
        markKeyCooldown(key, { reason: 'upstream connection failure', retryDelayMs: 15000 });
        continue;
      }
      return res.status(error.response?.status || 502).json({
        error: { code: error.response?.status || 502, message: error.message, status: 'BAD_GATEWAY' },
      });
    }
  }

  const status = lastError?.status || lastError?.response?.status || 429;
  const data = lastError?.data || lastError?.response?.data;
  return res.status(status).json(data || {
    error: { code: status, message: 'Gemini service is temporarily unavailable.', status: 'UNAVAILABLE' },
  });
}

app.use(helmet({
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('CORS policy blocked this request.'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '20mb' }));
app.use('/admin', express.static(require('path').join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'admin.html')));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: MAX_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please retry in a minute.',
  },
});
app.use(limiter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gemini-orchestrator',
    configuredKeys: apiKeys.length,
    healthyKeys: apiKeys.filter((key) => key.status === 'healthy').length,
    cooldownKeys: apiKeys.filter((key) => key.status === 'cooldown').length,
    defaultModel: DEFAULT_MODEL,
  });
});

app.get('/admin/api/keys', requireAdmin, (req, res) => {
  res.json({ keys: apiKeys.map(publicKey) });
});

app.post('/admin/api/keys', requireAdmin, (req, res) => {
  const value = typeof req.body.key === 'string' ? req.body.key.trim() : '';
  if (!value) return res.status(400).json({ message: 'A Gemini API key is required.' });
  if (apiKeys.some((key) => key.value === value)) return res.status(409).json({ message: 'That key is already configured.' });
  const record = {
    id: `gemini-${Date.now()}`,
    value,
    label: typeof req.body.label === 'string' && req.body.label.trim() ? req.body.label.trim() : `Gemini key ${apiKeys.length + 1}`,
    enabled: true,
    status: 'healthy',
    cooldownUntil: 0,
    consecutiveFailures: 0,
    usage: { requests: 0, successes: 0, failures: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, lastUsedAt: null },
  };
  apiKeys.push(record);
  saveKeys(apiKeys);
  return res.status(201).json({ key: publicKey(record) });
});

app.patch('/admin/api/keys/:id', requireAdmin, (req, res) => {
  const key = apiKeys.find((candidate) => candidate.id === req.params.id);
  if (!key) return res.status(404).json({ message: 'Key not found.' });
  if (typeof req.body.enabled === 'boolean') key.enabled = req.body.enabled;
  if (typeof req.body.label === 'string' && req.body.label.trim()) key.label = req.body.label.trim();
  if (typeof req.body.key === 'string' && req.body.key.trim()) key.value = req.body.key.trim();
  saveKeys(apiKeys);
  return res.json({ key: publicKey(key) });
});

app.delete('/admin/api/keys/:id', requireAdmin, (req, res) => {
  const index = apiKeys.findIndex((key) => key.id === req.params.id);
  if (index === -1) return res.status(404).json({ message: 'Key not found.' });
  apiKeys.splice(index, 1);
  saveKeys(apiKeys);
  return res.json({ ok: true });
});

app.post('/api/v1/chat/completions', requireAuth, async (req, res) => {
  try {
    const model = req.body.model || DEFAULT_MODEL;
    const body = buildGeminiRequestBody({
      model,
      messages: req.body.messages || [{ role: 'user', content: req.body.prompt || 'Hello' }],
      systemInstruction: req.body.system || req.body.systemInstruction,
      generationConfig: req.body.generationConfig || {
        temperature: req.body.temperature ?? 0.7,
        maxOutputTokens: req.body.max_tokens ?? 1024,
      },
    });

    const result = await callGeminiGenerativeApi(body, model);
    const assistantText = getResponseText(result);
    const usage = result?.usageMetadata || {};

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: assistantText },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: Number(usage.promptTokenCount || 0),
        completion_tokens: Number(usage.candidatesTokenCount || 0),
        total_tokens: Number(usage.totalTokenCount || 0),
      },
      provider: 'google-gemini',
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: 'Gemini request failed',
      message: error.message,
    });
  }
});

app.post('/api/v1/generate', requireAuth, async (req, res) => {
  try {
    const model = req.body.model || DEFAULT_MODEL;
    const payload = buildGeminiRequestBody({
      model,
      prompt: req.body.prompt || req.body.text || 'Generate a response.',
      image: req.body.image || req.body.image_url || req.body.imageUrl,
      generationConfig: req.body.generationConfig || {},
      systemInstruction: req.body.system || req.body.systemInstruction,
    });

    const result = await callGeminiGenerativeApi(payload, model);
    res.json({
      model,
      text: getResponseText(result),
      provider: 'google-gemini',
      usage: result?.usageMetadata || {},
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: 'Gemini generation failed',
      message: error.message,
    });
  }
});

app.post('/api/vision', requireAuth, async (req, res) => {
  try {
    const model = req.body.model || DEFAULT_MODEL;
    const payload = buildGeminiRequestBody({
      model,
      prompt: req.body.prompt || 'Describe this image.',
      image: req.body.image || req.body.image_url || req.body.imageUrl,
      generationConfig: req.body.generationConfig || {},
    });

    const result = await callGeminiGenerativeApi(payload, model);
    res.json({
      model,
      description: getResponseText(result),
      provider: 'google-gemini',
      usage: result?.usageMetadata || {},
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: 'Vision request failed',
      message: error.message,
    });
  }
});

// Keep the official Gemini REST paths intact so SDKs can use this server as their base URL.
app.all(['/v1beta/*', '/v1/*'], requireAuth, proxyGeminiRequest);

app.use((error, req, res, next) => {
  if (error && error.message === 'CORS policy blocked this request.') {
    return res.status(403).json({ error: 'Forbidden', message: 'Origin is not allowed by the server.' });
  }

  return res.status(500).json({ error: 'Internal Server Error', message: error.message || 'Unexpected server failure.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    logInfo(`Gemini orchestrator running on http://localhost:${PORT}`);
    logInfo(`Configured key count: ${apiKeys.length}`);
    if (!apiKeys.length) {
      logInfo('No Google Gemini API keys found. Add GEMINI_API_KEYS to .env to enable live calls.');
    }
  });
}

module.exports = app;
