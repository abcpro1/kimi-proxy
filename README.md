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

## Quick Start

```bash
pnpm install
cp .env.example .env
cp model-config.example.yaml model-config.yaml
# Edit .env and model-config.yaml with your provider keys and models
pnpm run dev
```

The API runs on `http://127.0.0.1:8000` and serves the dashboard at `/`.

## Configuration

### Providers

Set environment variables in `.env`:

- **Generic OpenAI**: `OPENAI_BASE_URL`, `OPENAI_API_KEY`
- **OpenRouter**: `OPENROUTER_API_KEY`, `OPENROUTER_PROVIDERS` (optional), `OPENROUTER_ORDER` (optional)
- **Vertex AI**: `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`

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

The web dashboard shows request/response logs and metrics. Access it at the root path when running the proxy.

## Development

```bash
pnpm run dev      # Run with hot reload
pnpm run test     # Run unit tests
pnpm run build    # TypeScript build
```

## Docker

```bash
docker compose up --build -d  # Production stack with web dashboard
docker compose -f docker-compose.dev.yml watch  # Development with hot reload
```
