# Gemini Orchestrator Server

This server acts as a secure middle layer between a client app and Google Gemini APIs. It keeps multiple Gemini API keys in environment variables, rotates them automatically when one key reaches its quota, and exposes a single API for text and multimodal requests.

## Features

- Automatic Gemini key rotation across multiple keys
- Quota-aware cooldown when Google returns `429 RESOURCE_EXHAUSTED`
- Secure API token check and CORS restrictions
- Rate limiting
- Text API endpoints and multimodal image input support
- Gemini-compatible REST routes, including model discovery, token counting, embeddings, and streaming

## Local setup

1. Install dependencies:
   npm install
2. Copy `.env.example` to `.env` and update the values.
3. Start the server:
   npm start

## Vercel deployment

Deploy `AI_Manager` as the Vercel project root. Vercel detects `api/index.js` as the serverless function and routes all paths through the Express app using `vercel.json`.

1. Create a Vercel project with **Root Directory** set to `AI_Manager`.
2. Add these Vercel Environment Variables for Production, Preview, and Development: `API_TOKEN`, `ADMIN_TOKEN`, `GEMINI_API_KEYS`, `ALLOWED_ORIGINS`, `GEMINI_MODEL`, and `GOOGLE_API_BASE_URL`.
3. Set `ALLOWED_ORIGINS` to the exact browser origins that may call the API. Do not use `*` with credentials.
4. Deploy with the Vercel dashboard or `npx vercel --prod` from this directory.

Vercel functions have ephemeral filesystems and multiple instances. `api-keys.json` is therefore not written on Vercel; keys and runtime usage are loaded from environment variables and runtime changes are instance-local. For durable admin add/edit/remove operations across deployments and instances, connect the key store to a managed database or secret manager before enabling those operations in production.

Never commit `.env`, `api-keys.json`, or real Gemini keys. Rotate any credential that has been exposed.

## Environment variables

- `PORT` — app port
- `API_TOKEN` — proxy key required for client requests; clients can send it as `x-goog-api-key`, `x-api-key`, `Authorization: Bearer ...`, or `?key=...`
- `ADMIN_TOKEN` — separate token for the admin dashboard and key-management API
- `ALLOWED_ORIGINS` — comma-separated allowed origins
- `GEMINI_API_KEYS` — comma-separated list of Google Gemini API keys
- `GEMINI_MODEL` — default model such as `gemini-2.5-flash`
- `GOOGLE_API_BASE_URL` — default `https://generativelanguage.googleapis.com`
- `KEY_COOLDOWN_MS` — cooldown in milliseconds for exhausted keys
- `MAX_REQUESTS_PER_MINUTE` — request throttle limit

## Example requests

### Health

GET /health

### Text generation

POST /api/v1/chat/completions
Authorization: Bearer <API_TOKEN>

```json
{
  "model": "gemini-2.5-flash",
  "messages": [
    { "role": "user", "content": "Write a short summary of the system design." }
  ]
}
```

### Multimodal image prompt

POST /api/vision
Authorization: Bearer <API_TOKEN>

```json
{
  "model": "gemini-2.5-flash",
  "prompt": "Describe this image in detail.",
  "image": "https://example.com/image.jpg"
}
```

### Google-style endpoint

POST /v1beta/models/gemini-2.5-flash/generateContent
x-goog-api-key: <API_TOKEN>

```json
{
  "contents": [
    { "parts": [{ "text": "Explain the benefits of microservices." }] }
  ]
}
```

The `/v1beta/*` and `/v1/*` paths are passed through with the same HTTP method and JSON body as the official Gemini API. This means Gemini clients can use this server as their base URL and keep their normal model selection and method calls. Supported examples include:

- `GET /v1beta/models`
- `GET /v1beta/models/{model}`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `POST /v1beta/models/{model}:countTokens`
- `POST /v1beta/models/{model}:embedContent`
- `POST /v1beta/models/{model}:batchEmbedContents`

For every proxied request, the client key is used only to authenticate with this middleware. It is removed and replaced upstream by one of the server-side keys in `GEMINI_API_KEYS`; upstream responses, status codes, and streaming bodies are returned to the client.

## Notes

- If a Gemini key gets rate-limited or quota-exhausted, the server automatically retries with the next healthy key.
- When all keys are exhausted, the server responds with a `429` and tells the caller to retry later.
- Sensitive credentials should be kept in server-side environment variables and never exposed in the client app.
- Open `http://localhost:3000/admin` to manage keys. Runtime changes are stored in the local, ignored `api-keys.json` file and survive restarts on a single server instance.
- The dashboard exposes masked key values only. Use a shared database or secret manager before running multiple server instances.
