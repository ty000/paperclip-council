import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const checks = [
  { name: "operations", executable: "python3", args: ["-m", "unittest", "discover", "-s", "tests/operations", "-p", "test_*.py"] },
  { name: "typecheck", args: ["typecheck"] },
  { name: "test", args: ["test", "--", "--maxWorkers=2"] },
  { name: "build", args: ["build"] },
];

const children = new Set();

function prefixLines(stream, destination, name) {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => destination.write(`[${name}] ${line}\n`));
}

function runCheck(check) {
  const startedAt = process.hrtime.bigint();
  const executable = check.executable ?? "pnpm";
  const command = `${executable} ${check.args.join(" ")}`;

  console.log(`[${check.name}] START ${command}`);

  return new Promise((resolve) => {
    const child = spawn(executable, check.args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    children.add(child);
    prefixLines(child.stdout, process.stdout, check.name);
    prefixLines(child.stderr, process.stderr, check.name);

    child.on("error", (error) => {
      children.delete(child);
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      console.error(
        `[${check.name}] FAIL spawn error after ${durationSeconds.toFixed(3)}s: ${error.message}`,
      );
      resolve({ ...check, command, durationSeconds, exitCode: null, signal: null });
    });

    child.on("close", (exitCode, signal) => {
      children.delete(child);
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const passed = exitCode === 0 && signal === null;
      console.log(
        `[${check.name}] ${passed ? "PASS" : "FAIL"} duration=${durationSeconds.toFixed(3)}s exit=${exitCode ?? "none"} signal=${signal ?? "none"}`,
      );
      resolve({ ...check, command, durationSeconds, exitCode, signal });
    });
  });
}

function stopChildren(signal) {
  for (const child of children) {
    child.kill(signal);
  }
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

const suiteStartedAt = process.hrtime.bigint();
const results = await Promise.all(checks.map(runCheck));
const suiteDurationSeconds = Number(process.hrtime.bigint() - suiteStartedAt) / 1e9;
const failed = results.filter(
  ({ exitCode, signal }) => exitCode !== 0 || signal !== null,
);

console.log("\nCheck summary:");
for (const result of results) {
  const passed = result.exitCode === 0 && result.signal === null;
  console.log(
    `- ${result.name}: ${passed ? "PASS" : "FAIL"} (${result.durationSeconds.toFixed(3)}s, exit=${result.exitCode ?? "none"}, signal=${result.signal ?? "none"})`,
  );
}
console.log(`- total wall time: ${suiteDurationSeconds.toFixed(3)}s`);

if (failed.length > 0) {
  process.exitCode = 1;
}
