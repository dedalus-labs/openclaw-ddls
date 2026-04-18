import "dotenv/config";
import Dedalus from "dedalus-labs";

const client = new Dedalus({
  xAPIKey: process.env.DEDALUS_API_KEY,
  baseURL: "https://dev.dcs.dedaluslabs.ai",
});

const MACHINE_ID = process.argv[2];
if (!MACHINE_ID) {
  console.error("Usage: npx tsx chat.ts <machine-id> [message]");
  console.error("Example: npx tsx chat.ts dm-019d2c03-bb9d-7407-a156-5b0a941e8413 'Hello!'");
  process.exit(1);
}

const message = process.argv.slice(3).join(" ") || "Hello! What are you?";

async function exec(cmd: string, timeoutMs = 120000): Promise<string> {
  const e = await client.machines.executions.create({
    machine_id: MACHINE_ID,
    command: ["/bin/bash", "-c", cmd],
    timeout_ms: timeoutMs,
  });

  let result = e;
  while (result.status !== "succeeded" && result.status !== "failed") {
    await new Promise((r) => setTimeout(r, 1000));
    result = await client.machines.executions.retrieve({
      machine_id: MACHINE_ID,
      execution_id: e.execution_id,
    });
  }

  const output = await client.machines.executions.output({
    machine_id: MACHINE_ID,
    execution_id: e.execution_id,
  });

  if (result.status === "failed") {
    throw new Error(output.stderr ?? output.stdout ?? "exec failed");
  }
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
