import "dotenv/config";
import Dedalus from "dedalus-labs";

const client = new Dedalus({
  xAPIKey: process.env.DEDALUS_API_KEY,
  baseURL: "https://dev.dcs.dedaluslabs.ai",
});

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

const ENV = [
  "export PATH=/home/machine/.npm-global/bin:$PATH",
  "export HOME=/home/machine",
  "export OPENCLAW_STATE_DIR=/home/machine/.openclaw",
  "export NODE_COMPILE_CACHE=/home/machine/.compile-cache",
  "export OPENCLAW_NO_RESPAWN=1",
].join(" && ");

async function exec(
  mid: string,
  cmd: string,
  label: string,
  timeoutMs = 120000,
): Promise<string> {
  console.log(`\n> ${label}`);
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

  const stdout = output.stdout?.trim() ?? "";
  const stderr = output.stderr?.trim() ?? "";
  if (stdout) console.log(stdout);
  if (stderr) console.error("[stderr]", stderr);
  if (result.status === "failed") {
    console.error(`[FAILED] ${label}`);
    throw new Error(`${label}: ${stderr || stdout || "no output"}`);
  }
  return stdout;
}

async function waitForRunning(mid: string) {
  let ws = await client.machines.retrieve({ machine_id: mid });
  while (ws.status.phase !== "running") {
    if (ws.status.phase === "failed") {
      throw new Error(`Machine failed: ${ws.status.reason}`);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
    ws = await client.machines.retrieve({ machine_id: mid });
  }
  console.log(" running.");
  await new Promise((r) => setTimeout(r, 5000));
}

// 1. Create machine (4096 MiB fits within dev ceiling of 6144 MiB)
console.log("Creating machine...");
const ws = await client.machines.create({
  vcpu: 2,
  memory_mib: 4096,
  storage_gib: 10,
});
const mid = ws.machine_id;
process.stdout.write(`Machine: ${mid}`);
await waitForRunning(mid);

// 2. Install Node.js + OpenClaw
await exec(
  mid,
  "curl -fsSL https://deb.nodesource.com/setup_22.x 2>&1 | bash - 2>&1 | tail -3 " +
    "&& apt-get install -y nodejs 2>&1 | tail -3",
  "Install Node.js 22",
);

await exec(
  mid,
  "mkdir -p /home/machine/.npm-global /home/machine/.npm-cache " +
    "/home/machine/.tmp /home/machine/.openclaw /home/machine/.compile-cache && " +
    "NPM_CONFIG_PREFIX=/home/machine/.npm-global " +
    "NPM_CONFIG_CACHE=/home/machine/.npm-cache " +
    "TMPDIR=/home/machine/.tmp " +
    "npm install -g openclaw@latest 2>&1 | tail -5",
  "Install OpenClaw",
);

await exec(mid, `${ENV} && openclaw --version`, "Verify OpenClaw");

// 3. Configure (enable HTTP chat API before starting gateway)
await exec(
  mid,
  `${ENV} && openclaw config set gateway.mode local 2>&1`,
  "Configure gateway mode",
);
await exec(
  mid,
  `${ENV} && openclaw config set env.vars.ANTHROPIC_API_KEY "${ANTHROPIC_KEY}" 2>&1`,
  "Set Anthropic API key",
);
await exec(
  mid,
  `${ENV} && openclaw config set gateway.http.endpoints.chatCompletions.enabled true 2>&1`,
  "Enable /v1/chat/completions",
);

// 4. Write startup script (echo commands -- heredocs don't work through the exec API)
await exec(
  mid,
  `echo '#!/bin/bash' > /home/machine/start-gateway.sh && ` +
    `echo 'export PATH=/home/machine/.npm-global/bin:$PATH' >> /home/machine/start-gateway.sh && ` +
    `echo 'export HOME=/home/machine' >> /home/machine/start-gateway.sh && ` +
    `echo 'export OPENCLAW_STATE_DIR=/home/machine/.openclaw' >> /home/machine/start-gateway.sh && ` +
    `echo 'export NODE_COMPILE_CACHE=/home/machine/.compile-cache' >> /home/machine/start-gateway.sh && ` +
    `echo 'export OPENCLAW_NO_RESPAWN=1' >> /home/machine/start-gateway.sh && ` +
    `echo 'exec openclaw gateway run --auth none > /home/machine/.openclaw/gateway.log 2>&1' >> /home/machine/start-gateway.sh && ` +
    `chmod +x /home/machine/start-gateway.sh && echo 'script written'`,
  "Write startup script",
);

// 5. Start gateway
await exec(
  mid,
  "setsid /home/machine/start-gateway.sh </dev/null &>/dev/null & disown && sleep 12 && echo 'launched'",
  "Start gateway",
);

// 6. Verify
await exec(mid, "ss -tlnp | grep 18789 || echo 'NOT LISTENING'", "Port 18789");
await exec(
  mid,
  "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/",
  "HTTP health check",
);
await exec(
  mid,
  `${ENV} && openclaw gateway call health 2>&1 | head -5`,
  "Gateway RPC health",
);

// 7. Chat via OpenAI-compatible HTTP API (synchronous response)
console.log("\n=== Chatting with OpenClaw ===");

const chatResponse = await exec(
  mid,
  `curl -sS http://127.0.0.1:18789/v1/chat/completions ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"model":"openclaw/default","messages":[{"role":"user","content":"Hello! Reply in one sentence: what are you?"}]}'`,
  "POST /v1/chat/completions",
  120000,
);

try {
  const parsed = JSON.parse(chatResponse);
  console.log("\nAssistant:", parsed.choices[0].message.content);
} catch {
  console.log("\n(Raw response printed above)");
}

// 8. Multi-turn conversation (same session via `user` field)
const followUp = await exec(
  mid,
  `curl -sS http://127.0.0.1:18789/v1/chat/completions ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"model":"openclaw/default","user":"demo-session","messages":[{"role":"user","content":"What is 2+2? Reply in one word."}]}'`,
  "POST /v1/chat/completions (follow-up)",
  120000,
);

try {
  const parsed = JSON.parse(followUp);
  console.log("\nAssistant:", parsed.choices[0].message.content);
} catch {
  console.log("\n(Raw response printed above)");
}

await exec(mid, "free -h", "Final memory");

console.log("\n========================================");
console.log(`  Machine: ${mid}`);
console.log(`  Chat API:  http://127.0.0.1:18789/v1/chat/completions`);
console.log("========================================");
