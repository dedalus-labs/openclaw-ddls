# Running OpenClaw on Dedalus Machines

## Overview

[OpenClaw](https://docs.openclaw.ai) is an open-source, self-hosted AI assistant with a WebSocket gateway, 50+ messaging integrations, multi-agent routing, and a browser Control UI. This spec covers deploying and operating it on [Dedalus Machines](https://dev.dcs.dedaluslabs.ai) -- isolated Linux microVMs (Ubuntu 24.04) with persistent storage.

Everything runs through the **Dedalus SDK execution API** -- no SSH required.

## Prerequisites

- **Dedalus API key** (`x-api-key` format)
- **LLM provider API key** -- Anthropic, OpenAI, Google, etc.
- **Local tooling** -- Node.js, `dedalus-labs`, `dotenv`

```bash
npm install dedalus-labs dotenv
```

```env
# .env
DEDALUS_API_KEY=<your-dedalus-key>
ANTHROPIC_API_KEY=<your-anthropic-key>
```

## Machine Requirements

| Resource | Minimum | Notes |
|----------|---------|-------|
| vCPU | 1 | 2 recommended for concurrent agent + gateway |
| Memory | 2048 MiB | Gateway idles at ~300 MiB; agent turns spike higher |
| Storage | 10 GiB | Persistent volume at `/home/machine` |

**Key constraints:**
- Root filesystem (`/`) is ~2.4 GB, 60-70% used by the OS. All packages must install to `/home/machine`.
- No systemd user services -- gateway runs as a detached foreground process via `setsid`.
- Dev environment memory ceiling is **6144 MiB**. Production allows up to 129024 MiB.
- Heredocs (`cat << 'EOF'`) do not work reliably through the execution API. Use `echo` commands instead.

## SDK Setup

```typescript
import "dotenv/config";
import Dedalus from "dedalus-labs";

const client = new Dedalus({
  xAPIKey: process.env.DEDALUS_API_KEY,
  baseURL: "https://dev.dcs.dedaluslabs.ai",
});
```

### Exec helper

All commands run inside the machine via the execution API:

```typescript
async function exec(mid: string, cmd: string, timeoutMs = 120000): Promise<string> {
  const e = await client.machines.executions.create({
    machine_id: mid,
    command: ["/bin/bash", "-c", cmd],
    timeout_ms: timeoutMs,
  });

  let result = e;
  while (result.status !== "succeeded" && result.status !== "failed") {
    await new Promise((r) => setTimeout(r, 1000));
    result = await client.machines.executions.retrieve({
      machine_id: mid,
      execution_id: e.execution_id,
    });
  }

  const output = await client.machines.executions.output({
    machine_id: mid,
    execution_id: e.execution_id,
  });

  if (result.status === "failed") throw new Error(output.stderr ?? "exec failed");
  return output.stdout?.trim() ?? "";
}
```

## Step 1: Create and Wait for Machine

```typescript
const ws = await client.machines.create({
  vcpu: 2,
  memory_mib: 4096,
  storage_gib: 10,
});
const mid = ws.machine_id;

// Wait for running (phases: accepted -> placement_pending -> starting -> running)
let machine = ws;
while (machine.status.phase !== "running") {
  if (machine.status.phase === "failed") {
    throw new Error(`Machine failed: ${machine.status.reason}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  machine = await client.machines.retrieve({ machine_id: mid });
}

// Wait for guest agent to initialize
await new Promise((r) => setTimeout(r, 5000));
```

## Step 2: Install Node.js + OpenClaw

```typescript
// Install Node.js 22 (OpenClaw requires 22.14+, recommends 24)
await exec(mid,
  "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -3 " +
  "&& apt-get install -y nodejs 2>&1 | tail -3"
);

// Install OpenClaw -- all paths redirected to /home/machine to avoid ENOSPC on root fs
await exec(mid,
  "mkdir -p /home/machine/.npm-global /home/machine/.npm-cache " +
  "/home/machine/.tmp /home/machine/.openclaw /home/machine/.compile-cache && " +
  "NPM_CONFIG_PREFIX=/home/machine/.npm-global " +
  "NPM_CONFIG_CACHE=/home/machine/.npm-cache " +
  "TMPDIR=/home/machine/.tmp " +
  "npm install -g openclaw@latest 2>&1 | tail -5"
);
```

### Environment variables

Every exec that calls `openclaw` needs these exports:

```typescript
const ENV =
  "export PATH=/home/machine/.npm-global/bin:$PATH " +
  "&& export HOME=/home/machine " +
  "&& export OPENCLAW_STATE_DIR=/home/machine/.openclaw " +
  "&& export NODE_COMPILE_CACHE=/home/machine/.compile-cache " +
  "&& export OPENCLAW_NO_RESPAWN=1";

// Verify
await exec(mid, `${ENV} && openclaw --version`);
```

## Step 3: Configure

Set gateway mode, LLM provider key, and enable the HTTP chat API **before** starting the gateway
to avoid a restart.

```typescript
await exec(mid, `${ENV} && openclaw config set gateway.mode local`);
await exec(mid, `${ENV} && openclaw config set env.vars.ANTHROPIC_API_KEY "${apiKey}"`);

// Enable the OpenAI-compatible HTTP API (disabled by default).
// This is the primary way to send messages and get synchronous responses.
await exec(mid, `${ENV} && openclaw config set gateway.http.endpoints.chatCompletions.enabled true`);
```

### Production config (optional)

For production, write `/home/machine/.openclaw/openclaw.json` directly:

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 18789,
    auth: { mode: "token", token: "<random-token>" },
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" }
    }
  }
}
```

Generate a token: `openclaw doctor --generate-gateway-token`

## Step 4: Start the Gateway

The gateway runs as `openclaw gateway run` (foreground mode), detached via `setsid` so the exec returns.

```typescript
// Write startup script (persists across machine sleep/wake).
// Use echo commands -- heredocs don't work reliably through the execution API.
await exec(mid,
  `echo '#!/bin/bash' > /home/machine/start-gateway.sh && ` +
  `echo 'export PATH=/home/machine/.npm-global/bin:$PATH' >> /home/machine/start-gateway.sh && ` +
  `echo 'export HOME=/home/machine' >> /home/machine/start-gateway.sh && ` +
  `echo 'export OPENCLAW_STATE_DIR=/home/machine/.openclaw' >> /home/machine/start-gateway.sh && ` +
  `echo 'export NODE_COMPILE_CACHE=/home/machine/.compile-cache' >> /home/machine/start-gateway.sh && ` +
  `echo 'export OPENCLAW_NO_RESPAWN=1' >> /home/machine/start-gateway.sh && ` +
  `echo 'exec openclaw gateway run --auth none > /home/machine/.openclaw/gateway.log 2>&1' >> /home/machine/start-gateway.sh && ` +
  `chmod +x /home/machine/start-gateway.sh`
);

// Launch (with duplicate check)
await exec(mid,
  "pgrep -f openclaw-gateway > /dev/null && echo 'already running' || " +
  "(setsid /home/machine/start-gateway.sh </dev/null &>/dev/null & disown && sleep 10 && echo 'launched')"
);
```

**Why `setsid`?** The execution API waits for the command to exit. `nohup ... &` alone doesn't reliably detach. `setsid` creates a new session so the exec returns.

**Avoid duplicates** -- each gateway uses ~300 MiB. Always check with `pgrep` before starting.

## Step 5: Verify

```typescript
// Port listening
await exec(mid, "ss -tlnp | grep 18789");

// HTTP (serves Control UI, expect 200)
await exec(mid, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/");

// Gateway RPC health
await exec(mid, `${ENV} && openclaw gateway call health`);
```

## Step 6: Chat with OpenClaw

### OpenAI-compatible HTTP API (recommended)

The gateway serves an OpenAI-compatible endpoint at `/v1/chat/completions` on the same port
(18789). This is the simplest way to send a message and get a synchronous response. It must be
enabled in config first (see Step 3).

```typescript
const response = await exec(mid,
  `curl -sS http://127.0.0.1:18789/v1/chat/completions ` +
  `-H 'Content-Type: application/json' ` +
  `-d '{"model":"openclaw/default","messages":[{"role":"user","content":"Hello!"}]}'`,
  120000
);
const parsed = JSON.parse(response);
console.log(parsed.choices[0].message.content);
```

Key details:

- `model` is an **agent target**, not a raw provider model id. `openclaw/default` routes to the
  configured default agent.
- To override the backend model, use the `x-openclaw-model` header
  (e.g. `x-openclaw-model: anthropic/claude-sonnet-4-6`).
- Streaming is supported with `"stream": true` (SSE, ends with `data: [DONE]`).
- When `gateway.auth.mode` is `"token"`, pass `Authorization: Bearer <token>`.
- The `user` field controls session routing: repeated calls with the same `user` string share a
  session.

Also available on the same surface:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat (synchronous or streaming) |
| `/v1/models` | GET | List agent targets |
| `/v1/models/{id}` | GET | Fetch one agent target |
| `/v1/embeddings` | POST | Embeddings |
| `/v1/responses` | POST | OpenResponses API |

### Gateway RPC (alternative)

The `chat.send` RPC method is **asynchronous** -- it returns `{"status":"started"}` immediately.
Use it when you need fire-and-forget or when polling for completion separately.

```typescript
// Send (returns immediately with runId)
await exec(mid,
  `${ENV} && openclaw gateway call chat.send ` +
  `--params '{"message":"Hello!","sessionKey":"my-session","idempotencyKey":"msg-'$(date +%s)'"}'`
);

// Poll for the response
await exec(mid,
  `${ENV} && openclaw gateway call sessions.get --params '{"sessionKey":"my-session"}'`
);
```

| RPC method | Description |
|------------|-------------|
| `health` | Gateway health + channel status |
| `chat.send` | Send a message (async, requires `message`, `sessionKey`, `idempotencyKey`) |
| `sessions.list` | List all active sessions |
| `sessions.get` | Get session messages (requires `sessionKey`) |
| `config.get` | Read current config |

## Wake After Sleep

When a machine wakes from sleep:
- `/home/machine` **persists** -- OpenClaw binary and config survive
- Root filesystem **resets** -- Node.js must be reinstalled
- Gateway process **is gone** -- must be restarted

```typescript
// Reinstall Node.js if missing
await exec(mid,
  "command -v node || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs) 2>&1 | tail -3"
);

// Restart gateway if not running
await exec(mid,
  "pgrep -f openclaw-gateway > /dev/null && echo 'already running' || " +
  "(setsid /home/machine/start-gateway.sh </dev/null &>/dev/null & disown && sleep 10 && echo 'launched')"
);
```

## Security

| Setting | Dev | Production |
|---------|-----|------------|
| Auth | `--auth none` | `--auth token --token <token>` |
| Bind | `loopback` (default) | `loopback` -- never expose without auth |
| Config perms | Default | `chmod 600 ~/.openclaw/openclaw.json` |
| Secrets | Env vars | `SecretRef` objects or `.env` files |
| Audit | `openclaw doctor` | `openclaw security audit --deep` |

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `ENOSPC` during install | Root fs full | Redirect `NPM_CONFIG_PREFIX`, `NPM_CONFIG_CACHE`, `TMPDIR` to `/home/machine/` |
| `EADDRINUSE` on 18789 | Duplicate gateway | `pkill -f openclaw-gateway` then restart |
| OOM / session closes | Memory exhaustion | Kill duplicate processes, check `free -h` |
| `machine_not_routable` | Sleeping or destroyed | Check status via SDK, wake or recreate |
| `StorageProvisioningFailed` | Dev environment capacity | Wait and retry |
| `503` on first exec | Guest agent not ready | Wait 5+ seconds after `running` phase |
| Agent returns "No API key" | Missing LLM key | Set key via `openclaw config set env.vars.ANTHROPIC_API_KEY` before starting gateway |
| `RuntimeWakeFailed` | Host node evicted the VM | Delete the failed machine, create a new one |
| `NoReadyHosts` / stuck in `placement_pending` | No host has capacity | Delete orphaned machines to free slots, or reduce `memory_mib` |
| `chat.send` returns empty messages | RPC is async | Use `/v1/chat/completions` instead |
| `memory_mib exceeds capacity` (400) | Dev ceiling is 6144 MiB | Request <= 6144 MiB, or use production environment |

## File Layout

```
/home/machine/
  .npm-global/bin/openclaw     # CLI binary
  .npm-global/lib/             # npm packages
  .npm-cache/                  # npm cache
  .tmp/                        # npm temp
  .compile-cache/              # Node.js compile cache
  .openclaw/
    openclaw.json              # Config
    gateway.log                # Gateway logs
    credentials/               # Channel credentials
    agents/main/sessions/      # Session store
  start-gateway.sh             # Startup script
```

## Quick Start

```bash
cp .env.example .env   # fill in your keys
npm install            # installs dedalus-labs SDK, dotenv, tsx
npx tsx openclaw.ts    # full end-to-end: create machine, install, chat
```

## Scripts

### `openclaw.ts` -- full end-to-end

Creates a new Dedalus machine, installs Node.js and OpenClaw inside it, configures the gateway
(including enabling the `/v1/chat/completions` HTTP API), starts the gateway, and sends two chat
messages to verify everything works. This is the "from zero to chatting" script.

```bash
npx tsx openclaw.ts
```

### `chat.ts` -- chat with an existing machine

Sends a single message to a machine that already has OpenClaw running. Skips all setup. Takes a
machine ID and an optional message as arguments, hits the gateway's `/v1/chat/completions`
endpoint via the Dedalus SDK execution API, and prints the assistant's reply.

```bash
npx tsx chat.ts <machine-id> "What is the meaning of life?"
```

If no message is provided, it defaults to "Hello! What are you?"
