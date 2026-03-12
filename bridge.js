/**
 * opencode-proxy
 * Translates OpenAI-compatible API requests → OpenCode REST API → response
 * so any OpenAI-compatible client (OpenClaw, etc.) can use models
 * available through an OpenCode server instance (e.g. GitHub Copilot).
 *
 * https://github.com/crazyboy24/opencode-proxy
 */

import express from "express"

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT         || "5000", 10)
const OPENCODE_URL = (process.env.OPENCODE_URL         || "http://localhost:4096").replace(/\/$/, "")
const PROVIDER_ID  = process.env.OPENCODE_PROVIDER_ID  || "github-copilot"
const DEFAULT_MODEL= process.env.DEFAULT_MODEL         || "gpt-4o"
const BRIDGE_KEY   = process.env.OPENCODE_PROXY_API_KEY        || ""
const LOG_LEVEL    = process.env.LOG_LEVEL             || "info"
const TIMEOUT_MS   = parseInt(process.env.TIMEOUT_MS       || "120000", 10)

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
  if (!res.ok) throw new Error(`OpenCode ${path} → ${res.status}`)
  return res.json()
}

async function ocDelete(path) {
  const res = await fetch(`${OPENCODE_URL}${path}`, { method: "DELETE" })
  return res.ok
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flattenMessages(messages) {
  return messages
    .map(m => {
      const role    = m.role.toUpperCase()
      const content = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text ?? "").join("\n")
          : ""
      return `[${role}]\n${content}`
    })
    .join("\n\n")
}

function authMiddleware(req, res, next) {
  if (!BRIDGE_KEY) return next()
  const header = req.headers["authorization"] ?? ""
  const token  = header.startsWith("Bearer ") ? header.slice(7) : header
  if (token !== BRIDGE_KEY) {
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
    res.json({
      status:         "ok",
      bridge_version: "1.0.0",
      opencode:       { connected: true, ...data },
      provider:       PROVIDER_ID,
    })
  } catch (err) {
    res.json({
      status:         "ok",
      bridge_version: "1.0.0",
      opencode:       { connected: false, error: err.message },
      provider:       PROVIDER_ID,
    })
  }
})

// ─── Models ──────────────────────────────────────────────────────────────────

app.get("/v1/models", authMiddleware, async (req, res) => {
  try {
    const data     = await ocGet("/provider")
    const provider = data.all?.find(p => p.id === PROVIDER_ID)

    if (provider?.models) {
      const models = Object.keys(provider.models).map(id => ({
        id,
        object:   "model",
        owned_by: PROVIDER_ID,
        created:  0,
      }))
      logger.debug(`Returning ${models.length} models from OpenCode provider`)
      return res.json({ object: "list", data: models })
    }

    throw new Error(`Provider "${PROVIDER_ID}" not found or has no models`)

  } catch (err) {
    logger.error("Failed to fetch models from OpenCode, using fallback:", err.message)

    const fallback = [
      "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
      "o3", "o4-mini",
      "claude-sonnet-4-5", "claude-3.5-sonnet",
      "gemini-2.0-flash-001",
    ].map(id => ({ id, object: "model", owned_by: PROVIDER_ID, created: 0 }))

    res.json({ object: "list", data: fallback })
  }
})

// ─── Chat completions ────────────────────────────────────────────────────────

app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  const reqId = `req_${Date.now()}`
  const { messages, model } = req.body

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: "`messages` must be a non-empty array", type: "invalid_request_error" }
    })
  }

  const modelID = model || DEFAULT_MODEL
  logger.info(`[${reqId}] → model=${modelID} messages=${messages.length}`)

  let sessionId = null
  const startMs = Date.now()

  try {
    // 1. Create session
    const session = await ocPost("/session", { title: `bridge-${reqId}` })
    sessionId = session.id
    logger.debug(`[${reqId}] session created: ${sessionId}`)

    // 2. Send prompt
    const result = await ocPost(`/session/${sessionId}/message`, {
      model: { providerID: PROVIDER_ID, modelID },
      parts: [{ type: "text", text: flattenMessages(messages) }],
    })

    // 3. Extract response
    const parts        = result.parts ?? []
    const textPart     = parts.find(p => p.type === "text")
    const responseText = textPart?.text ?? ""

    const usage = {
      prompt_tokens:     result.info?.tokens?.input  ?? 0,
      completion_tokens: result.info?.tokens?.output ?? 0,
      total_tokens:      result.info?.tokens?.total  ?? 0,
    }

    logger.info(`[${reqId}] ✓ ${Date.now() - startMs}ms tokens=${usage.total_tokens}`)

    return res.json({
      id:      `chatcmpl-${sessionId}`,
      object:  "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model:   modelID,
      choices: [{
        index:         0,
        message:       { role: "assistant", content: responseText },
        finish_reason: "stop",
      }],
      usage,
    })

  } catch (err) {
    logger.error(`[${reqId}] ✗ ${Date.now() - startMs}ms`, err.message)
    return res.status(502).json({ error: { message: err.message, type: "bridge_error" } })

  } finally {
    if (sessionId) ocDelete(`/session/${sessionId}`).catch(() => {})
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
  logger.info(`  Auth      : ${BRIDGE_KEY ? "enabled" : "disabled (set OPENCODE_PROXY_API_KEY to enable)"}`)
  logger.info(`  Timeout   : ${TIMEOUT_MS}ms`)

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
