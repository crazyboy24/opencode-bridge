/**
 * opencode-proxy
 * Translates OpenAI-compatible API requests → OpenCode REST API → response
 * Supports streaming (SSE), multimodal images, multi-provider routing,
 * tool/function calling, retries, session cleanup, and request deduplication.
 *
 * https://github.com/crazyboy24/opencode-proxy
 */

import express from "express"
import fs      from "fs"
import nodePath from "path"

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT                 || "5000",    10)
const OPENCODE_URL  = (process.env.OPENCODE_URL                 || "http://localhost:4096").replace(/\/$/, "")
const OPENCODE_PASS = process.env.OPENCODE_SERVER_PASSWORD      || ""
const PROVIDER_ID   = process.env.OPENCODE_PROVIDER_ID          || "github-copilot"
const DEFAULT_MODEL = process.env.DEFAULT_MODEL                 || "gpt-4o"
const BRIDGE_KEY    = process.env.OPENCODE_PROXY_API_KEY        || ""
const LOG_LEVEL     = process.env.LOG_LEVEL                     || "info"
const LOG_FILE      = process.env.LOG_FILE                      || ""           // e.g. /data/logs/bridge.log
const TIMEOUT_MS    = parseInt(process.env.TIMEOUT_MS           || "600000",   10)
const HEARTBEAT_MS  = parseInt(process.env.HEARTBEAT_MS         || "15000",    10)
const RETRY_COUNT   = parseInt(process.env.RETRY_COUNT          || "2",        10)
const RETRY_DELAY   = parseInt(process.env.RETRY_DELAY_MS       || "2000",     10)
const SESSION_TTL_H = parseInt(process.env.SESSION_TTL_HOURS    || "2",        10)
const CLEANUP_EVERY = parseInt(process.env.CLEANUP_INTERVAL_MS  || "3600000",  10) // 1hr

// ─── Session map (conversation → OpenCode session) ──────────────────────────
// Keyed by x-conversation-id header or a hash of the first user message.
// Allows the same OpenCode session to be reused across a multi-turn conversation,
// giving OpenCode full context of files opened, edits made, bash history, etc.
const sessionMap = new Map() // conversationId → { sessionId, lastUsed }
const SESSION_MAP_TTL = SESSION_TTL_H * 60 * 60 * 1000

function pruneSessionMap() {
  const cutoff = Date.now() - SESSION_MAP_TTL
  for (const [k, v] of sessionMap.entries()) {
    if (v.lastUsed < cutoff) sessionMap.delete(k)
  }
}

// ─── Logger ──────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString()

let logStream = null
if (LOG_FILE) {
  const dir = nodePath.dirname(LOG_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" })
}

function writeLog(line) {
  console.log(line)
  if (logStream) logStream.write(line + "\n")
}

const logger = {
  info:  (...a) => LOG_LEVEL !== "silent" && writeLog(`[${ts()}] INFO  ${a.join(" ")}`),
  debug: (...a) => LOG_LEVEL === "debug"  && writeLog(`[${ts()}] DEBUG ${a.join(" ")}`),
  error: (...a) => LOG_LEVEL !== "silent" && writeLog(`[${ts()}] ERROR ${a.join(" ")}`),
}

// ─── OpenCode REST helpers ────────────────────────────────────────────────────

function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function baseHeaders() {
  const h = { "Content-Type": "application/json" }
  if (OPENCODE_PASS) h["Authorization"] = `Basic ${Buffer.from(`:${OPENCODE_PASS}`).toString("base64")}`
  return h
}

async function ocGet(path, timeoutMs = TIMEOUT_MS) {
  const { signal, clear } = withTimeout(timeoutMs)
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    headers: baseHeaders(),
    signal,
  }).finally(clear)
  if (!res.ok) throw new Error(`OpenCode GET ${path} → ${res.status}`)
  return res.json()
}

async function ocPost(path, body) {
  const { signal, clear } = withTimeout(TIMEOUT_MS)
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    method:  "POST",
    headers: baseHeaders(),
    body:    JSON.stringify(body),
    signal,
  }).finally(clear)
  const text = await res.text()
  if (!res.ok) throw new Error(`OpenCode POST ${path} → ${res.status}: ${text.slice(0, 300)}`)
  if (!text)   throw new Error(`OpenCode POST ${path} → empty response`)
  try { return JSON.parse(text) }
  catch { throw new Error(`OpenCode POST ${path} → invalid JSON: ${text.slice(0, 300)}`) }
}

async function ocDelete(path) {
  const { signal, clear } = withTimeout(10000)
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    method:  "DELETE",
    headers: baseHeaders(),
    signal,
  }).finally(clear)
  return res.ok
}

async function ocGetList(path) {
  const { signal, clear } = withTimeout(10000)
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    headers: baseHeaders(),
    signal,
  }).finally(clear)
  if (!res.ok) throw new Error(`OpenCode GET ${path} → ${res.status}`)
  return res.json()
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry(fn, retries = RETRY_COUNT, delayMs = RETRY_DELAY) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // Don't retry aborts (timeout) or 4xx errors
      if (err.name === "AbortError")              throw err
      if (err.message.match(/→ 4\d\d/))          throw err
      if (i < retries) {
        logger.error(`Attempt ${i + 1} failed: ${err.message} — retrying in ${delayMs}ms`)
        await new Promise(r => setTimeout(r, delayMs))
      }
    }
  }
  throw lastErr
}

// ─── Session cleanup ──────────────────────────────────────────────────────────

async function cleanupOldSessions() {
  try {
    const data     = await ocGetList("/session")
    const sessions = Array.isArray(data) ? data : (data.sessions ?? data.data ?? [])
    const cutoff   = Date.now() - SESSION_TTL_H * 60 * 60 * 1000
    let   deleted  = 0

    for (const s of sessions) {
      const created = s.time?.created ?? s.created ?? 0
      // Only delete sessions created by the bridge (title starts with "bridge-")
      if (created < cutoff && s.title?.startsWith("bridge-")) {
        const ok = await ocDelete(`/session/${s.id}`)
        if (ok) deleted++
      }
    }

    if (deleted > 0) logger.info(`Session cleanup: deleted ${deleted} old sessions (>${SESSION_TTL_H}h)`)
  } catch (err) {
    logger.error("Session cleanup failed:", err.message)
  }
}

// ─── Message builder ─────────────────────────────────────────────────────────

/**
 * Converts OpenAI messages → OpenCode parts array.
 *
 * Handles:
 * - text content (string or array)
 * - system prompts (passed as proper system part)
 * - image_url (base64 data URI or remote URL)
 * - tool calls and tool results
 * - silently skips unsupported types (audio, file)
 */
function buildParts(messages, tools) {
  const parts  = []
  let   hasImg = false

  // Extract system message first — pass as dedicated system part
  const systemMsg = messages.find(m => m.role === "system")
  if (systemMsg) {
    const text = typeof systemMsg.content === "string"
      ? systemMsg.content
      : systemMsg.content?.map(c => c.text ?? "").join("\n") ?? ""
    parts.push({ type: "system", text })
  }

  // Non-system messages
  for (const m of messages) {
    if (m.role === "system") continue
    const role = m.role.toUpperCase()

    // Assistant tool_calls (may also have text content)
    if (m.role === "assistant" && m.tool_calls?.length) {
      parts.push({ type: "text", text: `[${role}]` })
      // Preserve any text content alongside tool calls
      if (typeof m.content === "string" && m.content) {
        parts.push({ type: "text", text: m.content })
      }
      for (const tc of m.tool_calls) {
        parts.push({
          type:       "tool-call",
          toolName:   tc.function?.name ?? tc.name,
          toolArgs:   (() => { try { return JSON.parse(tc.function?.arguments ?? "{}") } catch { return {} } })(),
          toolCallId: tc.id,
        })
      }
      continue
    }

    // Tool result messages
    if (m.role === "tool") {
      parts.push({
        type:       "tool-result",
        toolCallId: m.tool_call_id,
        result:     m.content ?? "",
      })
      continue
    }

    // String content
    if (typeof m.content === "string") {
      parts.push({ type: "text", text: `[${role}]\n${m.content}` })
      continue
    }

    // Array content (multimodal)
    if (Array.isArray(m.content)) {
      parts.push({ type: "text", text: `[${role}]` })

      for (const c of m.content) {
        if (c.type === "text") {
          parts.push({ type: "text", text: c.text ?? "" })

        } else if (c.type === "image_url") {
          hasImg      = true
          const url   = c.image_url?.url ?? ""

          if (url.startsWith("data:")) {
            const commaIdx = url.indexOf(",")
            const meta = url.slice(0, commaIdx)
            const data = url.slice(commaIdx + 1)
            const mediaType    = meta.replace("data:", "").replace(";base64", "")
            parts.push({ type: "image", source: { type: "base64", mediaType, data } })
          } else {
            parts.push({ type: "image", source: { type: "url", url } })
          }
        }
        // audio / file silently skipped
      }
    }
  }

  // Append tool definitions if provided
  if (tools?.length) {
    parts.push({
      type:  "tools",
      tools: tools.map(t => ({
        name:        t.function?.name        ?? t.name,
        description: t.function?.description ?? t.description ?? "",
        parameters:  t.function?.parameters  ?? t.parameters  ?? {},
      })),
    })
  }

  return { parts, hasImg }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

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
app.use(express.json({ limit: "50mb" }))     // large enough for image payloads

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/health", async (req, res) => {
  try {
    const data = await ocGet("/global/health", 10000)
    res.json({ status: "ok", bridge_version: "1.2.0", opencode: { connected: true, ...data }, provider: PROVIDER_ID, active_sessions: sessionMap.size })
  } catch (err) {
    res.json({ status: "ok", bridge_version: "1.2.0", opencode: { connected: false, error: err.message }, provider: PROVIDER_ID, active_sessions: sessionMap.size })
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
    logger.error("Failed to fetch models:", err.message)
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
  const { messages, model, stream, tools, tool_choice } = req.body

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

  logger.info(`[${reqId}] → provider=${providerID} model=${modelID} messages=${messages.length} stream=${!!stream} tools=${tools?.length ?? 0}`)

  const startMs = Date.now()

  // Derive a conversation ID from the request:
  // 1. x-conversation-id header (OpenClaw or any client that sends it)
  // 2. Fallback: hash of the first user message content (stable per conversation start)
  const convId = req.headers["x-conversation-id"]
    ?? req.headers["x-session-id"]
    ?? (() => {
         const first = messages.find(m => m.role === "user")
         const text  = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content)
         let h = 0
         for (const c of (text ?? "")) { h = (Math.imul(31, h) + c.charCodeAt(0)) | 0 }
         return `hash_${Math.abs(h)}`
       })()

  try {
    // 1. Get or create OpenCode session for this conversation
    pruneSessionMap()
    let sessionId
    const existing = sessionMap.get(convId)
    // x-working-directory lets the client tell OpenCode which project to work in
    const workDir = req.headers["x-working-directory"] ?? null

    if (existing) {
      sessionId = existing.sessionId
      existing.lastUsed = Date.now()
      logger.debug(`[${reqId}] reusing session ${sessionId} for conv ${convId}`)
    } else {
      const sessionBody = { title: `bridge-${reqId}` }
      if (workDir) sessionBody.directory = workDir
      const session = await withRetry(() => ocPost("/session", sessionBody))
      sessionId = session.id
      sessionMap.set(convId, { sessionId, lastUsed: Date.now() })
      logger.debug(`[${reqId}] new session ${sessionId} for conv ${convId}${workDir ? ` dir=${workDir}` : ""}`)
    }

    // 2. Build parts — when reusing a session, send only the latest user message
    //    since OpenCode already has prior context in its session history.
    //    For new sessions, send full history for context bootstrapping.
    const msgsToSend = existing ? [messages[messages.length - 1]] : messages
    const { parts: msgParts, hasImg } = buildParts(msgsToSend, tools)
    if (hasImg) logger.info(`[${reqId}] multimodal — images detected`)

    // 3. Start SSE heartbeat before the slow OpenCode call
    let heartbeat = null
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream")
      res.setHeader("Cache-Control", "no-cache")
      res.setHeader("Connection", "keep-alive")
      res.flushHeaders()
      heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS)
    }

    // 4. Send to OpenCode (with retry)
    let result
    try {
      result = await withRetry(() => ocPost(`/session/${sessionId}/message`, {
        model: { providerID, modelID },
        parts: msgParts,
      }))
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }

    // 5. Extract response — join ALL text parts in order (OpenCode may produce
    //    multiple text parts across tool-use steps)
    const resParts  = result.parts ?? []

    // Collect text segments in document order, skipping step markers
    const textSegments  = resParts
      .filter(p => p.type === "text" && p.text)
      .map(p => p.text.trim())
      .filter(Boolean)
    const responseText  = textSegments.join("\n\n")

    // Collect OpenCode's own tool results (bash output, file reads, etc.)
    // and append as a structured block so the agent can see what happened
    const ocToolResults = resParts.filter(p => p.type === "tool-result")
    const toolResultBlock = ocToolResults.length
      ? "\n\n---\n**Tool outputs:**\n" + ocToolResults
          .map(r => `**${r.toolName ?? "tool"}:** ${typeof r.result === "string" ? r.result : JSON.stringify(r.result)}`)
          .join("\n")
      : ""
    const fullResponseText = responseText + toolResultBlock

    // Extract OpenAI-style tool calls from OpenCode response (if model called client tools)
    const toolCallParts = resParts.filter(p => p.type === "tool-call")
    const toolCalls     = toolCallParts.length
      ? toolCallParts.map((tc, i) => ({
          id:       tc.toolCallId ?? `call_${i}`,
          type:     "function",
          function: { name: tc.toolName, arguments: JSON.stringify(tc.toolArgs ?? {}) },
        }))
      : undefined

    const usage = {
      prompt_tokens:     result.info?.tokens?.input  ?? 0,
      completion_tokens: result.info?.tokens?.output ?? 0,
      total_tokens:      result.info?.tokens?.total  ?? 0,
    }

    const finishReason = toolCalls?.length ? "tool_calls" : "stop"
    logger.info(`[${reqId}] ✓ ${Date.now() - startMs}ms tokens=${usage.total_tokens} chars=${fullResponseText.length} steps=${textSegments.length} finish=${finishReason}`)

    const cmplId  = `chatcmpl-${sessionId}`
    const created = Math.floor(Date.now() / 1000)

    const message = {
      role:    "assistant",
      content: toolCalls ? (fullResponseText || null) : (fullResponseText ?? ""),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    }

    // 6a. Streaming response
    if (stream) {
      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: modelID,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`)

      if (toolCalls) {
        for (const [i, tc] of toolCalls.entries()) {
          res.write(`data: ${JSON.stringify({
            id: cmplId, object: "chat.completion.chunk", created, model: modelID,
            choices: [{ index: 0, delta: { tool_calls: [{ index: i, ...tc }] }, finish_reason: null }],
          })}\n\n`)
        }
      } else {
        res.write(`data: ${JSON.stringify({
          id: cmplId, object: "chat.completion.chunk", created, model: modelID,
          choices: [{ index: 0, delta: { content: fullResponseText }, finish_reason: null }],
        })}\n\n`)
      }

      res.write(`data: ${JSON.stringify({
        id: cmplId, object: "chat.completion.chunk", created, model: modelID,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage,
      })}\n\n`)

      res.write("data: [DONE]\n\n")
      return res.end()
    }

    // 6b. Non-streaming response
    return res.json({
      id: cmplId, object: "chat.completion", created, model: modelID,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    })

  } catch (err) {
    logger.error(`[${reqId}] ✗ ${Date.now() - startMs}ms ${err.message}`)
    // Remove from session map so next request starts a fresh session
    sessionMap.delete(convId)

    if (stream) {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        res.flushHeaders()
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
  logger.info(`opencode-bridge v1.2.0 started`)
  logger.info(`  Listening  : http://0.0.0.0:${PORT}`)
  logger.info(`  OpenCode   : ${OPENCODE_URL}`)
  logger.info(`  Provider   : ${PROVIDER_ID}`)
  logger.info(`  Auth       : ${BRIDGE_KEY    ? "enabled" : "disabled"}`)
  logger.info(`  OC Auth    : ${OPENCODE_PASS ? "enabled" : "disabled"}`)
  logger.info(`  Timeout    : ${TIMEOUT_MS}ms`)
  logger.info(`  Heartbeat  : ${HEARTBEAT_MS}ms`)
  logger.info(`  Retries    : ${RETRY_COUNT} × ${RETRY_DELAY}ms delay`)
  logger.info(`  Sessions   : cleanup every ${CLEANUP_EVERY / 60000}min, TTL ${SESSION_TTL_H}h`)
  logger.info(`  Log file   : ${LOG_FILE || "stdout only"}`)
  logger.info(`  Session map: persistent sessions per conversation (TTL ${SESSION_TTL_H}h)`)

  try {
    const h = await ocGet("/global/health", 10000)
    logger.info(`  OpenCode health: ✓ v${h.version ?? "unknown"}`)
  } catch {
    logger.error(`  OpenCode health: ✗ not reachable — check OPENCODE_URL`)
  }

  // Start session cleanup scheduler
  setInterval(cleanupOldSessions, CLEANUP_EVERY)
  // Run once after 30s on startup to clean any leftover sessions
  setTimeout(cleanupOldSessions, 30000)
})

// ─── Graceful shutdown ───────────────────────────────────────────────────────

const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down…`)
  if (logStream) logStream.end()
  server.close(() => { logger.info("Server closed"); process.exit(0) })
  setTimeout(() => process.exit(1), 5000)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT",  () => shutdown("SIGINT"))
