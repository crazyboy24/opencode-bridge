# opencode-bridge

> An OpenAI-compatible API bridge for [OpenCode](https://opencode.ai) — expose any of OpenCode's 75+ supported providers (GitHub Copilot, Anthropic, OpenAI, Ollama, OpenRouter, Azure and more) as a single OpenAI-compatible endpoint.

```
Your AI Client  →  POST /v1/chat/completions
                        ↓
               opencode-bridge  (this repo)
                        ↓  @opencode-ai/sdk
               OpenCode Server  (opencode serve)
                        ↓
        Any provider OpenCode supports (75+)
```

---

## Why does this exist?

[OpenCode](https://opencode.ai) supports **75+ LLM providers** and handles all the hard parts — OAuth flows, API key storage, token refresh, model routing. Meanwhile most AI clients and agent frameworks (OpenClaw, Continue, Aider, etc.) speak only **OpenAI's `/v1/chat/completions` format**.

This bridge sits between them. Whatever provider you've connected in OpenCode becomes a drop-in OpenAI-compatible endpoint, swappable with a single env var.

**Common use cases:**
- Use your **GitHub Copilot Pro/Enterprise** subscription with any AI client
- Use your **Anthropic Claude Pro/Max** subscription without a separate API key
- Route through **OpenRouter** to access hundreds of models under one key
- Use **local Ollama models** from a remote client or on a different machine
- **Switch providers** without touching client configuration — just change one env var and restart

---

## Features

- **OpenAI-compatible** — works with any client that supports `baseUrl` override
- **Provider-agnostic** — any of OpenCode's 75+ providers via a single env var
- **Dynamic model list** — `/v1/models` fetches live from your active OpenCode provider, with static fallback
- **Optional Bearer auth** — protect the bridge with `BRIDGE_API_KEY`
- **Structured logging** — timestamped, levelled (`silent` / `info` / `debug`)
- **Graceful shutdown** — handles `SIGTERM` / `SIGINT` cleanly (Docker/Coolify friendly)
- **Health endpoint** — `/health` pings OpenCode and reports live status
- **Multi-stage Docker build** — minimal image, non-root user

---

## Prerequisites

1. **OpenCode installed and running** as a server (`opencode serve`)
2. **A provider authenticated** in OpenCode via `/connect` (or env vars for providers like Bedrock/Vertex)
3. Node.js 22+ (or Docker)

---

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/yourusername/opencode-bridge
cd opencode-bridge
cp .env.example .env
# Edit .env — at minimum set OPENCODE_URL and OPENCODE_PROVIDER_ID
```

### 2. Run locally

```bash
npm install
npm start
```

### 3. Test it

```bash
# Health check (also confirms OpenCode is reachable)
curl http://localhost:5000/health

# List models from your active provider
curl http://localhost:5000/v1/models

# Chat
curl -X POST http://localhost:5000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_URL` | `http://localhost:4096` | URL of your OpenCode server |
| `OPENCODE_PROVIDER_ID` | `github-copilot` | Provider ID to route all requests through |
| `DEFAULT_MODEL` | `gpt-4o` | Fallback model when client doesn't specify one |
| `PORT` | `5000` | Port the bridge listens on |
| `BRIDGE_API_KEY` | _(empty)_ | Enable Bearer token auth on all `/v1/*` routes. Leave empty to disable |
| `LOG_LEVEL` | `info` | `silent` \| `info` \| `debug` |

---

## Supported Providers

This bridge works with **any provider OpenCode supports**. Set `OPENCODE_PROVIDER_ID` to the provider's ID as it appears in your OpenCode config.

| Provider | `OPENCODE_PROVIDER_ID` | Auth method in OpenCode |
|---|---|---|
| GitHub Copilot | `github-copilot` | Device OAuth via `/connect` |
| Anthropic (API key or Claude Pro/Max) | `anthropic` | OAuth or API key via `/connect` |
| OpenAI (API key or ChatGPT Plus/Pro) | `openai` | OAuth or API key via `/connect` |
| OpenRouter | `openrouter` | API key via `/connect` |
| Ollama (local) | `ollama` | No auth needed |
| Azure OpenAI | `azure` | API key + resource name |
| Amazon Bedrock | `amazon-bedrock` | AWS env vars |
| Google Vertex AI | `google-vertex` | `GOOGLE_APPLICATION_CREDENTIALS` |
| GitLab Duo | `gitlab` | OAuth or PAT via `/connect` |
| Groq | `groq` | API key via `/connect` |
| DeepSeek | `deepseek` | API key via `/connect` |
| xAI (Grok) | `xai` | API key via `/connect` |
| Cloudflare AI Gateway | `cloudflare-ai-gateway` | API key via `/connect` |

> Not sure of your provider's ID? Run `opencode /connect` in the OpenCode TUI and it will show you the ID, or check `~/.local/share/opencode/auth.json` after connecting.

For the full list of 75+ providers, see the [OpenCode provider docs](https://opencode.ai/docs/providers).

---

## Docker

### Build and run

```bash
docker build -t opencode-bridge .
docker run -p 5000:5000 \
  -e OPENCODE_URL=http://host.docker.internal:4096 \
  -e OPENCODE_PROVIDER_ID=github-copilot \
  opencode-bridge
```

### Docker Compose (local dev)

```bash
# Make sure OpenCode is running locally first (opencode serve)
docker compose up
```

---

## Deployment on Coolify

Full walkthrough for deploying alongside an existing OpenCode server on Coolify.

### Architecture on Coolify

```
Coolify VPS
├── opencode-server   (opencode serve, port 4096, internal only)
├── opencode-bridge   (this repo, port 5000, internal only)
└── your-ai-client    (OpenClaw / any client — points to bridge)
```

### Step 1 — Make sure OpenCode is running with your provider

If OpenCode isn't deployed yet, create a Coolify service with this Dockerfile:

```dockerfile
FROM node:22-alpine
RUN npm install -g opencode-ai
WORKDIR /workspace
EXPOSE 4096
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

Add a **persistent volume** in Coolify so auth tokens survive restarts:
```
/root/.local/share/opencode  →  opencode-auth-data
```

**Authenticate your provider (one-time, manual):**

```bash
# SSH into your VPS, then exec into the OpenCode container
docker exec -it <opencode-container-name> sh

# Inside the container — run the TUI to connect your provider
opencode
# Type /connect → select your provider → follow the prompts
# Ctrl+C once done — token is saved to the volume
```

For providers that use API keys instead of OAuth (Anthropic, OpenAI, etc.), you can skip the TUI step and pass the key as an environment variable on the OpenCode service instead:

```
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
```

### Step 2 — Deploy the bridge

1. **New Resource → GitHub Repository** → point to this repo
2. **Build Pack: Dockerfile**
3. Set environment variables:

```
OPENCODE_URL=http://<opencode-service-internal-name>:4096
OPENCODE_PROVIDER_ID=github-copilot
DEFAULT_MODEL=gpt-4o
PORT=5000
BRIDGE_API_KEY=your-optional-secret
```

> **Finding the internal hostname:** In Coolify, open your OpenCode service → Network tab → copy the internal URL. It looks something like `http://opencode_abc123:4096`.

4. Keep it **internal** (no public domain needed) if your AI client is in the same Coolify project.

### Step 3 — Point your AI client at the bridge

Use the bridge's internal Coolify hostname as your `baseUrl`. Example for OpenClaw:

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "http://<bridge-service-internal-name>:5000/v1",
      "apiKey": "your-optional-bridge-key"
    }
  }
}
```

The `apiKey` only needs to match `BRIDGE_API_KEY` if you set one — otherwise any value (or none) works.

---

## API Reference

### `GET /health`

Pings the downstream OpenCode server and returns status. Returns `503` if OpenCode is unreachable.

```json
{
  "status": "ok",
  "bridge_version": "1.0.0",
  "opencode": { "healthy": true, "version": "0.0.3" },
  "provider": "github-copilot"
}
```

### `GET /v1/models`

Returns available models in OpenAI list format. Fetches live from your active OpenCode provider. Falls back to a static list if the provider isn't reachable.

### `POST /v1/chat/completions`

Standard OpenAI chat completions endpoint.

**Supported fields:**

| Field | Type | Description |
|---|---|---|
| `messages` | array | Required. Array of `{ role, content }` objects |
| `model` | string | Model ID. Falls back to `DEFAULT_MODEL` if not set |

> **Note:** `stream`, `temperature`, `max_tokens` and other sampling params are accepted by the bridge but not currently forwarded — OpenCode handles inference parameters internally based on its own config. See the [OpenCode agents docs](https://opencode.ai/docs/agents) to configure these on the OpenCode side.

---

## How it works

1. Client sends `POST /v1/chat/completions`
2. Bridge flattens the `messages` array into a labelled prompt string
3. A temporary OpenCode session is created via `@opencode-ai/sdk`
4. Prompt is sent to OpenCode with your configured `providerID` and `modelID`
5. OpenCode calls the upstream provider using its stored credentials
6. Response text is extracted and wrapped in OpenAI response format
7. Session is deleted and the response is returned to the client

---

## Limitations

- **No streaming** — responses are returned in full. Streaming depends on a future OpenCode SDK update.
- **No tool/function calling** — OpenAI tool-use format is not translated.
- **Stateless** — a fresh session is created and deleted per request. No conversation memory between calls.
- **Sampling params not forwarded** — `temperature`, `top_p`, `max_tokens` etc. Configure these in your OpenCode agent config instead.

---

## Contributing

PRs welcome. Good areas to contribute:

- Streaming support (`text/event-stream`)
- Tool/function call translation
- Session reuse for multi-turn conversations
- Per-model limit/capability metadata in `/v1/models`

---

## License

MIT
