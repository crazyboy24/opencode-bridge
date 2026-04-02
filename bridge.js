/**
 * opencode-bridge
 * Translates OpenAI-compatible API requests → OpenCode REST API → response
 * Supports both streaming (SSE) and non-streaming responses.
 *
 * https://github.com/crazyboy24/opencode-bridge
 */

import express from "express"

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT                || "5000",   10)
const OPENCODE_URL = (process.env.OPENCODE_URL                || "http://localhost:4096").replace(/\/$/, "")
const PROVIDER_ID  = process.env.OPENCODE_PROVIDER_ID         || "github-copilot"
const DEFAULT_MODEL= process.env.DEFAULT_MODEL                || "gpt-4o"
const OPENCODE_BRIDGE_API_KEY   = process.env.OPENCODE_BRIDGE_API_KEY       || ""
const LOG_LEVEL    = process.env.LOG_LEVEL                    || "info"
const TIMEOUT_MS      = parseInt(process.env.TIMEOUT_MS       || "600000", 10) // 10 min default
const HEARTBEAT_MS    = parseInt(process.env.HEARTBEAT_MS    || "15000",  10) // SSE comment every 15s to keep connection alive

// ─── Logger ──────────────────────────────────────────────────────────────────

const ts     = () => new Date().toISOString()
const logger = {
  info:  (...a) => LOG_LEVEL !== "silent" && console.log(`[${ts()}] INFO `, ...a),
  debug: (...a) => LOG_LEVEL === "debug"  && console.log(`[${ts()}] DEBUG`, ...a),
  error: (...a) => LOG_LEVEL !== "silent" && console.error(`[${ts()}] ERROR`, ...a),
}

// ─── OpenCode REST helpers ────────────────────────────────────────────────────

function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function ocGet(path) {
  const { signal, clear } = withTimeout(TIMEOUT_MS)
  const res = await fetch(`${OPENCODE_URL}${path}`, { signal }).finally(clear)
  if (!res.ok) throw new Error(`OpenCode ${path} → ${res.status}`)
  return res.json()
}

async function ocPost(path, body) {
  const { signal, clear } = withTimeout(TIMEOUT_MS)
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal,
  }).finally(clear)
  const text = await res.text()
  if (!res.ok) throw new Error(`OpenCode ${path} → ${res.status}: ${text.slice(0, 200)}`)
  if (!text)   throw new Error(`OpenCode ${path} → empty response`)
  try { return JSON.parse(text) }
  catch { throw new Error(`OpenCode ${path} → invalid JSON: ${text.slice(0, 200)}`) }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts OpenAI messages into OpenCode parts array.
 * Handles text, image_url (base64 data URI or remote URL).
 * Returns { parts, hasImg } where parts is the OpenCode-format array.
 */
function buildParts(messages) {
  const parts  = []
  let   hasImg = false

  for (const m of messages) {
    const role = m.role.toUpperCase()

    if (typeof m.content === "string") {
      parts.push({ type: "text", text: `[${role}]\n${m.content}` })
      continue
    }

    if (Array.isArray(m.content)) {
      parts.push({ type: "text", text: `[${role}]` })

      for (const c of m.content) {
        if (c.type === "text") {
          parts.push({ type: "text", text: c.text ?? "" })

        } else if (c.type === "image_url") {
          hasImg      = true
          const url   = c.image_url?.url ?? ""

          if (url.startsWith("data:")) {
            // Base64 data URI: "data:image/png;base64,iVBOR..."
            const [meta, data] = url.split(",")
            const mediaType    = meta.replace("data:", "").replace(";base64", "")
            parts.push({ type: "image", source: { type: "base64", mediaType, data } })
          } else {
            // Remote URL
            parts.push({ type: "image", source: { type: "url", url } })
          }
        }
        // audio / file parts silently skipped — not supported by OpenCode
      }
    }
  }

  return { parts, hasImg }
}

function authMiddleware(req, res, next) {
  if (!OPENCODE_BRIDGE_API_KEY) return next()
  const header = req.headers["authorization"] ?? ""
  const token  = header.startsWith("Bearer ") ? header.slice(7) : header
  if (token !== OPENCODE_BRIDGE_API_KEY) {
    return res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } })
  }
  next()
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: "4mb" }))

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/health", async (req, res) => {
  try {
    const data = await ocGet("/global/health")
    res.json({ status: "ok", bridge_version: "1.0.0", opencode: { connected: true, ...data }, provider: PROVIDER_ID })
  } catch (err) {
    res.json({ status: "ok", bridge_version: "1.0.0", opencode: { connected: false, error: err.message }, provider: PROVIDER_ID })
  }
})

// ─── Models ──────────────────────────────────────────────────────────────────

app.get("/v1/models", authMiddleware, async (req, res) => {
  try {
    const data      = await ocGet("/provider")
    const connected = data.connected ?? []
    const models    = []

    for (const provider of data.all ?? []) {
      if (!connected.includes(provider.id)) continue
      if (!provider.models) continue
      for (const modelId of Object.keys(provider.models)) {
        models.push({ id: `${provider.id}/${modelId}`, object: "model", owned_by: provider.id, created: 0 })
      }
    }

    if (models.length === 0) throw new Error("No connected providers found")
    logger.debug(`Returning ${models.length} models from ${connected.length} connected providers`)
    return res.json({ object: "list", data: models })

  } catch (err) {
    logger.error("Failed to fetch models from OpenCode, using fallback:", err.message)
    const fallback = [
      "github-copilot/gpt-4o", "github-copilot/gpt-4.1",
      "github-copilot/claude-sonnet-4-5", "github-copilot/gpt-5-mini",
    ].map(id => ({ id, object: "model", owned_by: id.split("/")[0], created: 0 }))
    res.json({ object: "list", data: fallback })
  }
})

// ─── Chat completions ────────────────────────────────────────────────────────

app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  const reqId = `req_${Date.now()}`
  const { messages, model, stream } = req.body

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: "`messages` must be a non-empty array", type: "invalid_request_error" }
    })
  }

  // Model can be bare "gpt-4o" or provider-prefixed "github-copilot/gpt-4o"
  let providerID = PROVIDER_ID
  let modelID    = model || DEFAULT_MODEL

  if (modelID.includes("/")) {
    const [p, ...m] = modelID.split("/")
    providerID = p
    modelID    = m.join("/")
  }

  logger.info(`[${reqId}] → provider=${providerID} model=${modelID} messages=${messages.length} stream=${!!stream}`)

  const startMs = Date.now()

  try {
    // 1. Create session
    const session   = await ocPost("/session", { title: `bridge-${reqId}` })
    const sessionId = session.id
    logger.debug(`[${reqId}] session created: ${sessionId}`)

    // 2. Build parts (text + optional images)
    const { parts: msgParts, hasImg } = buildParts(messages)
    if (hasImg) logger.info(`[${reqId}] multimodal request — images detected`)

    // 3. Send prompt — start heartbeat if streaming to keep connection alive
    let heartbeat = null
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream")
      res.setHeader("Cache-Control", "no-cache")
      res.setHeader("Connection", "keep-alive")
      res.flushHeaders()
      // SSE comment lines keep the connection alive while OpenCode processes
      heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS)
    }

    let result
    try {
      result = await ocPost(`/session/${sessionId}/message`, {
        model: { providerID, modelID },
        parts: msgParts,
      })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }

    // 3. Extract response text
    const parts        = result.parts ?? []
    const textPart     = parts.find(p => p.type === "text")
    const responseText = textPart?.text ?? ""

    const usage = {
      prompt_tokens:     result.info?.tokens?.input  ?? 0,
      completion_tokens: result.info?.tokens?.output ?? 0,
      total_tokens:      result.info?.tokens?.total  ?? 0,
    }

    logger.info(`[${reqId}] ✓ ${Date.now() - startMs}ms tokens=${usage.total_tokens} chars=${responseText.length}`)

    const cmplId  = `chatcmpl-${sessionId}`
    const created = Math.floor(Date.now() / 1000)

    // 4a. Streaming (SSE) response
    if (stream) {
      // Headers already sent via flushHeaders above

      // Role chunk
      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: modelID,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`)

      // Content chunk
      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: modelID,
        choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
      })}\n\n`)

      // Finish chunk
      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: modelID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      })}\n\n`)

      res.write("data: [DONE]\n\n")
      return res.end()
    }

    // 4b. Non-streaming response
    return res.json({
      id: cmplId, object: "chat.completion", created, model: modelID,
      choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
      usage,
    })

  } catch (err) {
    logger.error(`[${reqId}] ✗ ${Date.now() - startMs}ms`, err.message)

    if (stream) {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
      }
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "bridge_error" } })}\n\n`)
      res.write("data: [DONE]\n\n")
      return res.end()
    }

    if (!res.headersSent) {
      return res.status(502).json({ error: { message: err.message, type: "bridge_error" } })
    }
  }
})

// ─── 404 ─────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found` } })
})

// ─── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, "0.0.0.0", async () => {
  logger.info(`opencode-bridge started`)
  logger.info(`  Listening : http://0.0.0.0:${PORT}`)
  logger.info(`  OpenCode  : ${OPENCODE_URL}`)
  logger.info(`  Provider  : ${PROVIDER_ID}`)
  logger.info(`  Timeout   : ${TIMEOUT_MS}ms`)
  logger.info(`  Heartbeat : ${HEARTBEAT_MS}ms (SSE keep-alive)`)
  logger.info(`  Auth      : ${OPENCODE_BRIDGE_API_KEY ? "enabled" : "disabled (set OPENCODE_BRIDGE_API_KEY to enable)"}`)

  try {
    const h = await ocGet("/global/health")
    logger.info(`  OpenCode health: ✓ v${h.version ?? "unknown"}`)
  } catch {
    logger.error(`  OpenCode health: ✗ not reachable — check OPENCODE_URL`)
  }
})

// ─── Graceful shutdown ───────────────────────────────────────────────────────

const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down…`)
  server.close(() => { logger.info("Server closed"); process.exit(0) })
  setTimeout(() => process.exit(1), 5000)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT",  () => shutdown("SIGINT"))
