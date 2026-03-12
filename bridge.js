/**
 * opencode-bridge
 * Translates OpenAI-compatible API requests → OpenCode SDK → response
 * so any OpenAI-compatible client (OpenClaw, etc.) can use models
 * available through an OpenCode server instance (e.g. GitHub Copilot).
 *
 * https://github.com/yourusername/opencode-bridge
 */

import express from "express"
import { createOpencodeClient } from "@opencode-ai/sdk"

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT         || "5000", 10)
const OPENCODE_URL = process.env.OPENCODE_URL           || "http://localhost:4096"
const PROVIDER_ID  = process.env.OPENCODE_PROVIDER_ID  || "github-copilot"
const DEFAULT_MODEL= process.env.DEFAULT_MODEL         || "gpt-4o"
const BRIDGE_KEY   = process.env.BRIDGE_API_KEY        || ""        // optional auth
const LOG_LEVEL    = process.env.LOG_LEVEL             || "info"    // info | debug | silent

// ─── Logger ──────────────────────────────────────────────────────────────────

const logger = {
  info:  (...a) => LOG_LEVEL !== "silent" && console.log(`[${ts()}] INFO `, ...a),
  debug: (...a) => LOG_LEVEL === "debug"  && console.log(`[${ts()}] DEBUG`, ...a),
  error: (...a) => LOG_LEVEL !== "silent" && console.error(`[${ts()}] ERROR`, ...a),
}
const ts = () => new Date().toISOString()

// ─── OpenCode client ─────────────────────────────────────────────────────────

const client = createOpencodeClient({ baseUrl: OPENCODE_URL })

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts an array of OpenAI-format messages into a single prompt string.
 * System messages are placed first, clearly labelled.
 */
function flattenMessages(messages) {
  return messages
    .map(m => {
      const role = m.role.toUpperCase()
      const content = typeof m.content === "string"
        ? m.content
        : m.content?.map(c => c.text ?? "").join("\n") ?? ""
      return `[${role}]\n${content}`
    })
    .join("\n\n")
}

/**
 * Optional bearer-token auth middleware.
 * Only enforced when BRIDGE_API_KEY is set.
 */
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

/**
 * GET /health
 * Pings the downstream OpenCode server to confirm it's reachable.
 */
app.get("/health", async (req, res) => {
  try {
    const result = await client.global.health()
    res.json({
      status:         "ok",
      bridge_version: "1.0.0",
      opencode:       result.data,
      provider:       PROVIDER_ID,
    })
  } catch (err) {
    res.status(503).json({
      status:  "degraded",
      error:   err.message,
      detail:  `Cannot reach OpenCode at ${OPENCODE_URL}`,
    })
  }
})

// ─── Models ──────────────────────────────────────────────────────────────────

/**
 * GET /v1/models
 * Fetches available models from the connected OpenCode provider and
 * returns them in OpenAI list format.
 * Falls back to a curated static list when the provider isn't reachable.
 */
app.get("/v1/models", authMiddleware, async (req, res) => {
  try {
    const result  = await client.provider.list()
    const all     = result.data?.all ?? []
    const provider = all.find(p => p.id === PROVIDER_ID)

    if (provider && provider.models) {
      const models = Object.keys(provider.models).map(id => ({
        id,
        object:    "model",
        owned_by:  PROVIDER_ID,
        created:   0,
      }))
      logger.debug(`Returning ${models.length} models from OpenCode provider`)
      return res.json({ object: "list", data: models })
    }

    throw new Error(`Provider "${PROVIDER_ID}" not found or has no models`)

  } catch (err) {
    logger.error("Failed to fetch models from OpenCode, using fallback:", err.message)

    // Static fallback — common GitHub Copilot models
    const fallback = [
      "gpt-4o",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o4-mini",
      "claude-sonnet-4-5",
      "claude-3.5-sonnet",
      "gemini-2.0-flash-001",
    ].map(id => ({ id, object: "model", owned_by: PROVIDER_ID, created: 0 }))

    res.json({ object: "list", data: fallback })
  }
})

// ─── Chat completions ────────────────────────────────────────────────────────

/**
 * POST /v1/chat/completions
 * Main endpoint. Creates a temporary OpenCode session, sends the prompt,
 * waits for the response, cleans up, and returns OpenAI-shaped JSON.
 */
app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  const reqId = `req_${Date.now()}`
  const { messages, model, user } = req.body

  // ── Validation ──────────────────────────────────────────────────────────
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
    // ── 1. Create a fresh session ──────────────────────────────────────────
    const sessionRes = await client.session.create({
      body: { title: `bridge-${reqId}` }
    })
    sessionId = sessionRes.data.id
    logger.debug(`[${reqId}] session created: ${sessionId}`)

    // ── 2. Build prompt ────────────────────────────────────────────────────
    const promptText = flattenMessages(messages)

    // ── 3. Send to OpenCode ────────────────────────────────────────────────
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: PROVIDER_ID, modelID },
        parts: [{ type: "text", text: promptText }],
      },
    })

    // ── 4. Extract text response ───────────────────────────────────────────
    const parts        = result.data?.parts ?? []
    const textPart     = parts.find(p => p.type === "text")
    const responseText = textPart?.text ?? ""

    // ── 5. Token estimates (best-effort from OpenCode if available) ────────
    const msgInfo  = result.data?.info ?? {}
    const usage = {
      prompt_tokens:     msgInfo?.tokens?.input      ?? 0,
      completion_tokens: msgInfo?.tokens?.output     ?? 0,
      total_tokens:      msgInfo?.tokens?.total      ?? 0,
    }

    const elapsed = Date.now() - startMs
    logger.info(`[${reqId}] ✓ ${elapsed}ms tokens=${usage.total_tokens}`)

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
    const elapsed = Date.now() - startMs
    logger.error(`[${reqId}] ✗ ${elapsed}ms`, err.message)

    const isUpstream = err.message?.toLowerCase().includes("connect")
    return res.status(502).json({
      error: {
        message: isUpstream
          ? `Cannot reach OpenCode server at ${OPENCODE_URL}`
          : err.message,
        type:    "bridge_error",
        code:    isUpstream ? "upstream_unavailable" : "internal_error",
      }
    })

  } finally {
    // ── 6. Always clean up the session ─────────────────────────────────────
    if (sessionId) {
      client.session.delete({ path: { id: sessionId } }).catch(() => {})
    }
  }
})

// ─── 404 catch-all ───────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found`, type: "not_found" } })
})

// ─── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, "0.0.0.0", async () => {
  logger.info(`opencode-bridge started`)
  logger.info(`  Listening : http://0.0.0.0:${PORT}`)
  logger.info(`  OpenCode  : ${OPENCODE_URL}`)
  logger.info(`  Provider  : ${PROVIDER_ID}`)
  logger.info(`  Auth      : ${BRIDGE_KEY ? "enabled" : "disabled (set BRIDGE_API_KEY to enable)"}`)

  // Warm-up ping
  try {
    const h = await client.global.health()
    logger.info(`  OpenCode health: ✓ v${h.data?.version ?? "unknown"}`)
  } catch {
    logger.error(`  OpenCode health: ✗ not reachable — check OPENCODE_URL`)
  }
})

// ─── Graceful shutdown ───────────────────────────────────────────────────────

const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully…`)
  server.close(() => {
    logger.info("Server closed")
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5000)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT",  () => shutdown("SIGINT"))
