import "dotenv/config";
import Dedalus from "dedalus";

const client = new Dedalus({
  xAPIKey: process.env.DEDALUS_API_KEY,
});

const MACHINE_ID = process.argv[2];
if (!MACHINE_ID) {
  console.error("Usage: npx tsx chat.ts <machine-id> [message]");
  console.error("Example: npx tsx chat.ts dm-019d2c03-bb9d-7407-a156-5b0a941e8413 'Hello!'");
  process.exit(1);
}

const message = process.argv.slice(3).join(" ") || "Hello! What are you?";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exec(cmd: string, timeoutMs = 120000): Promise<string> {
  let exc = await client.machines.executions.create({
    machine_id: MACHINE_ID,
    command: ["/bin/bash", "-c", cmd],
    timeout_ms: timeoutMs,
  });

  let delay = 100;
  while (!TERMINAL.has(exc.status)) {
    const wait = exc.status === "wake_in_progress" ? (exc.retry_after_ms ?? 0) : delay;
    await sleep(wait);
    delay = Math.min(delay * 2, 2000);
    exc = await client.machines.executions.retrieve({
      machine_id: MACHINE_ID,
      execution_id: exc.execution_id,
    });
  }

  if (exc.status !== "succeeded") {
    throw new Error(`${exc.status}: ${exc.error_code ?? ""}: ${exc.error_message ?? ""}`);
  }

  const output = await client.machines.executions.output({
    machine_id: MACHINE_ID,
    execution_id: exc.execution_id,
  });
  return output.stdout?.trim() ?? "";
}

const ws = await client.machines.retrieve({ machine_id: MACHINE_ID });
if (ws.status.phase !== "running") {
  console.error(`Machine is ${ws.status.phase}, not running.`);
  process.exit(1);
}

const escaped = message.replace(/'/g, "'\\''");
const response = await exec(
  `curl -sS http://127.0.0.1:18789/v1/chat/completions ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"model":"openclaw/default","messages":[{"role":"user","content":"${escaped}"}]}'`,
  120000,
);

try {
  const parsed = JSON.parse(response);
  console.log(parsed.choices[0].message.content);
} catch {
  console.log(response);
}
