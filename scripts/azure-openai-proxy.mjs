import http from 'node:http'
import { Readable } from 'node:stream'

const listenPort = Number(process.env.AZURE_OPENAI_PROXY_PORT || 18791)
const upstreamBase =
  process.env.AZURE_OPENAI_BASE_URL || 'https://hack-aoai-1.openai.azure.com'
const apiKey = process.env.AZURE_OPENAI_API_KEY || ''

/** Max tokens to inject into chat completions requests that don't set one. */
const DEFAULT_MAX_TOKENS = 2048

/** Maximum number of retry attempts on 429 responses. */
const MAX_RETRIES = 3

/** Base backoff delay in ms (doubles each retry). */
const BASE_BACKOFF_MS = 1000

// ── Path detection ──────────────────────────────────────────────

function isChatCompletionsPath(pathname) {
  return (
    pathname.endsWith('/chat/completions') ||
    pathname === '/chat/completions' ||
    pathname === '/v1/chat/completions'
  )
}

// ── Request body helpers ────────────────────────────────────────

async function readRequestBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Normalize chat completions body:
 * - Inject max_tokens if not set (reduces Azure TPM estimation)
 */
function normalizeChatCompletionsBody(buffer) {
  if (buffer.length === 0) return undefined
  try {
    const payload = JSON.parse(buffer.toString('utf8'))
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (payload.max_tokens == null && payload.max_completion_tokens == null) {
        payload.max_tokens = DEFAULT_MAX_TOKENS
      }
      if (payload.model == null || payload.model === '') {
        payload.model = 'gpt-4'
      }
      return Buffer.from(JSON.stringify(payload))
    }
  } catch {}
  return buffer
}

// ── Retry-aware fetch ───────────────────────────────────────────

/**
 * Fetch with automatic retry on 429 (Too Many Requests).
 * Respects Retry-After header; falls back to exponential backoff.
 */
async function fetchWithRetry(url, options, attempt = 0) {
  const response = await fetch(url, options)

  if (response.status === 429 && attempt < MAX_RETRIES) {
    try { await response.text() } catch {}

    const retryAfter = response.headers.get('retry-after')
    let delayMs
    if (retryAfter) {
      const parsed = Number(retryAfter)
      delayMs = Number.isFinite(parsed) ? parsed * 1000 : BASE_BACKOFF_MS * 2 ** attempt
    } else {
      delayMs = BASE_BACKOFF_MS * 2 ** attempt
    }
    delayMs = Math.min(delayMs, 30_000)

    console.log(
      `[azure-proxy] 429 on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${delayMs}ms`,
    )
    await new Promise((r) => setTimeout(r, delayMs))
    return fetchWithRetry(url, options, attempt + 1)
  }

  return response
}

// ── HTTP server ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (!apiKey) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('AZURE_OPENAI_API_KEY is not set')
    return
  }

  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const isChat = isChatCompletionsPath(url.pathname)

    const rawBody = await readRequestBody(req)
    const requestBody = isChat
      ? normalizeChatCompletionsBody(rawBody)
      : (rawBody.length > 0 ? rawBody : undefined)

    const upstreamUrl = `${upstreamBase}${url.pathname}${url.search}`

    const upstream = await fetchWithRetry(upstreamUrl, {
      method: req.method,
      headers: {
        'api-key': apiKey,
        accept: req.headers.accept || 'application/json',
        'content-type': req.headers['content-type'] || 'application/json',
      },
      body: requestBody,
    })

    const headers = {}
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-length') {
        headers[key] = value
      }
    })

    res.writeHead(upstream.status, headers)

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res)
    } else {
      res.end()
    }
  } catch (error) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`azure proxy error: ${error.message}`)
  }
})

server.listen(listenPort, '127.0.0.1', () => {
  console.log(
    `[azure-proxy] listening on http://127.0.0.1:${listenPort} -> ${upstreamBase} (max_tokens=${DEFAULT_MAX_TOKENS}, retries=${MAX_RETRIES})`,
  )
})
