import type { PluginContext } from "@paperclipai/plugin-sdk";
import { councilNativeRequest } from "./decision-adapter.js";
import type { NativeRunReadback } from "./g4-native.js";
import { MissionError } from "./missions.js";

const LOG_TAIL_BYTES = 131072;

// The host log is NDJSON of stream chunks; Codex CLI stdout is itself NDJSON.
// Read the final message, never a tool's echoed report or an earlier matching one.
function terminalMessage(content: string, offset: number): unknown {
  const lines = content.split("\n");
  if (offset > 0) {
    try { JSON.parse(lines[0]!); } catch { lines.shift(); } // Discard only a partial first row.
  }
  let stdout = "";
  for (const line of lines.filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.stream === "stdout" && typeof row.chunk === "string") stdout += row.chunk;
  }
  let message: unknown; let finalEvent: unknown;
  for (const line of stdout.split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { finalEvent = undefined; continue; } // Host notices and a possible first partial CLI event.
    finalEvent = event.type;
    if (event.type === "turn.started") message = undefined;
    if (event.type === "item.completed" && event.item?.type === "agent_message") message = event.item.text;
  }
  return finalEvent === "turn.completed" ? message : undefined;
}

/** The run has already passed exact company/actor/issue binding and terminal settlement. */
export async function readOrdinaryRunSummary(ctx: PluginContext, run: NativeRunReadback): Promise<unknown> {
  if (!run.resultJson?.truncated || run.resultJson.truncationReason !== "oversized_result_json") {
    return run.resultJson?.summary;
  }
  if (!Number.isSafeInteger(run.logBytes) || run.logBytes! <= 0) {
    throw new MissionError(409, "ordinary_report_missing", "Truncated Council summary requires its completed native run log");
  }
  const offset = Math.max(0, run.logBytes! - LOG_TAIL_BYTES);
  const response = await councilNativeRequest(ctx, run.companyId, `/api/heartbeat-runs/${run.id}/log`,
    { logRead: { offset, limitBytes: LOG_TAIL_BYTES } });
  const log = response.body as { runId?: string; content?: string; nextOffset?: number } | null;
  if (response.status !== 200 || log?.runId !== run.id || typeof log.content !== "string" || log.nextOffset !== undefined) {
    throw new MissionError(409, "ordinary_report_missing", "Exact completed Council run log is unavailable");
  }
  try { return terminalMessage(log.content, offset); }
  catch { throw new MissionError(409, "ordinary_report_missing", "Native Council log tail is not complete NDJSON"); }
}
