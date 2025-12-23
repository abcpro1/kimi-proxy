# Kimi Proxy

> [!WARNING] ⚠️
> **Experimental**: This project is still in development. Use with caution in production.

Makes `kimi-k2-thinking` usable across multiple LLM providers by normalizing API formats, fixing tool call and thinking format issues, and optionally ensuring the model always uses a tool call for agentic workflows.

The proxy and transformation pipelines are built generically and can be easily extended to support any model and any provider.

## Features

<details>
<summary><strong>Multi-provider proxy</strong> for <code>kimi-k2-thinking</code> and other models</summary>

Seamlessly route requests to OpenAI-compatible APIs, OpenRouter, or Vertex AI using a unified client model name.

</details>

<details>
<summary><strong>Format fixes</strong> for tool calls and thinking blocks</summary>

For some providers, kimi-k2-thinking returns tool calls and thinking content in non-standard formats. The proxy normalizes these to the standard Anthropic format that clients expect.

**Example: Tool call normalization from content**

What the kimi-k2 provider returns (tool calls embedded in content with `<|tool_call_begin|>` markers):

```json
{
  "content": "Let me search for that.     <|tool_call_begin|>    functions.lookup:42  <|tool_call_argument_begin|>   {\"term\":\"express\"}   <|tool_call_begin|>  "
}
```

What clients receive (normalized):

```json
{
  "content": "Let me search for that.",
  "tool_calls": [
    {
      "id": "42",
      "type": "function",
      "function": {
        "name": "lookup",
        "arguments": "{\"term\":\"express\"}"
      }
    }
  ],
  "finish_reason": "tool_calls"
}
```

**Example: Thinking tags extraction and cleanup**

What kimi-k2 returns:

```
(no content)(no content)  Let me break down... </think>   The answer is 42.
```

What clients receive:

```json
{
  "content": "The answer is 42.",
  "thinking": "Let me break down..."
}
```

</details>

<details>
<summary><strong>Tool call enforcement (optional)</strong> for reliable agentic workflows</summary>

Enable with `ensure_tool_call: true` in model config. The proxy detects missing tool calls and re-prompts the model with a reminder.

When enabled, the proxy also injects a termination tool named `done` and a system instruction telling the model to call it when finished (optionally with `{"final_answer":"..."}`), then strips that termination tool call from the final response.

Control the maximum number of re-prompt attempts with `ENSURE_TOOL_CALL_MAX_ATTEMPTS` (default: `3`, max: `5`).

**Example enforcement flow:**

```
System: You are a helpful assistant with access to tools.
        Always reply with at least one tool call so the client can continue.

User: What's the weather in SF?

Assistant: Let me check that for you.

System: Reminder: The client will not continue unless you reply with a tool call.

Assistant: {
  "tool_calls": [{
    "id": "get_weather:0",
    "type": "function",
    "function": {
      "name": "get_weather",
      "arguments": "{\"location\": \"SF\"}"
    }
  }]
}
```

</details>

<details>
<summary><strong>Request/response logging</strong> with web dashboard</summary>

All requests and responses are logged to SQLite and viewable through a built-in web dashboard at the root path.

</details>

<details>
<summary><strong>Load balancing</strong> with multiple strategies</summary>

Distribute traffic across providers using round-robin, weighted random, random, or first strategies.

</details>

- **Extensible architecture** for adding new models and providers
- **Provider support**: OpenAI-compatible APIs, OpenRouter, Vertex AI
- **Hybrid logging pipeline**: SQLite metadata with filesystem blobs, LiveStore-backed dashboard with virtualized/lazy blob loading

## Quick Start (Bun)

```bash
bun install
cp .env.example .env
cp model-config.example.yaml model-config.yaml
# Edit .env and model-config.yaml with your provider keys and models
bun run dev            # backend
bun --cwd frontend dev # dashboard (Vite)
```

The API runs on `http://127.0.0.1:8000` and serves the dashboard (built assets) at `/`. The dev dashboard uses `VITE_API_URL` to point at the backend (defaults to same origin).

## Configuration

### Dashboard & LiveStore

Control LiveStore sync behavior via environment variables:

| Variable                | Default | Description                                                                                     |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `LIVESTORE_BATCH`       | 50      | Batch size for dashboard sync (range: 1-500)                                                    |
| `LIVESTORE_MAX_RECORDS` | 500     | Memory sliding window - max records to keep in LiveStore. Set to 0 to disable (not recommended) |

### Providers

Set environment variables in `.env`:

- **Generic OpenAI**: `OPENAI_BASE_URL`, `OPENAI_API_KEY`
- **Anthropic**: `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`
- **OpenRouter**: `OPENROUTER_API_KEY`, `OPENROUTER_PROVIDERS` (optional), `OPENROUTER_ORDER` (optional)
- **Vertex AI**: `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`
  - `GOOGLE_APPLICATION_CREDENTIALS` can be a path to the JSON key file or the JSON payload itself. Use `VERTEX_CHAT_ENDPOINT` to point at a private MaaS endpoint if needed.

### Models

Edit `model-config.yaml` to map client model names to upstream providers:

```yaml
default_strategy: round_robin
models:
  - name: kimi-k2-thinking
    provider: vertex
    model: moonshotai/kimi-k2-thinking-maas
    # Optional: enforce tool call consistency for reliable agentic workflows
    ensure_tool_call: true
  - name: kimi-k2-thinking
    provider: openrouter
    model: moonshot-ai/kimi-k2-thinking
    weight: 2
```

## Dashboard

The web dashboard shows request/response logs and metrics. Access it at the root path when running the proxy. LiveStore metadata sync pulls from `/api/livestore/pull` in batches (size controlled by `LIVESTORE_BATCH`) and lazily fetches blobs on expansion. Build the dashboard with `bun run build:all` to serve static assets from the backend.

### Performance Features

- **Reverse-chronological loading**: Data loads from newest to oldest, providing immediate access to recent logs
- **Memory-efficient virtualization**: Uses TanStack Virtual to render only visible rows
- **Configurable sliding window**: Limit browser memory usage by setting `LIVESTORE_MAX_RECORDS` (see `.env.example`)
- **Automatic garbage collection**: Old records beyond the window limit are automatically purged

The dashboard uses reactive queries with TanStack Table and TanStack Virtual for fast, efficient rendering of large datasets.

## Development

```bash
bun run dev         # Run backend with hot reload
bun --cwd frontend dev  # Run dashboard
bun test            # Run tests
bun run build:all   # Build server + dashboard
```

## Docker

```bash
docker compose up --build -d  # Production stack with web dashboard
docker compose -f docker-compose.dev.yml watch  # Development with hot reload
```
