// Bash execution in the sandbox for the model's bash tool and the user's ! commands.
// Output is bounded on the host; when it is truncated, the full output is saved
// inside the sandbox, so every path the model sees exists in the guest.
import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_BYTES, formatSize, truncateTail, type BashOperations } from "@earendil-works/pi-coding-agent";
import { MAX_TIMEOUT_MS, SandboxClient, SandboxError } from "./client.ts";
import { GuestFs } from "./guest.ts";

/** Combined stdout and stderr a single command may produce. */
const OUTPUT_LIMIT = 16 * 1024 * 1024;
/** Output limit of structuredContent.output, matching Pi's built-in bash tool. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const UPDATE_INTERVAL_MS = 100;

export interface Runtime {
  client: SandboxClient;
  url: string;
  cwd: string;
  home: string;
  timeoutMs: number;
}

type Outcome = { exitCode: number; output: Buffer; error?: undefined } | { exitCode?: undefined; output: Buffer; error: Error };

/** Convert a timeout in seconds to milliseconds within the protocol's range. */
export function timeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid timeout: must be a positive number of seconds.");
  const value = Math.ceil(seconds * 1000);
  if (value > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: the sandbox allows at most ${MAX_TIMEOUT_MS / 1000} seconds.`);
  return value;
}

async function execute(runtime: Runtime, command: string, timeout: number, signal: AbortSignal | undefined,
  onChunk: (data: Buffer) => void): Promise<Outcome> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const result = await runtime.client.exec(command, {
      cwd: runtime.cwd, signal, timeoutMs: timeout, maxOutputBytes: OUTPUT_LIMIT,
      onData(data) {
        size += data.length;
        chunks.push(data);
        onChunk(data);
      },
    });
    return { exitCode: result.exitCode, output: Buffer.concat(chunks, size) };
  } catch (error) {
    return { output: Buffer.concat(chunks, size), error: error as Error };
  }
}

/** Save output in the guest and return its path, or an explanation when that fails. */
async function saveInGuest(runtime: Runtime, output: Buffer): Promise<{ path?: string; problem?: string }> {
  const path = `/tmp/pi-bash-${randomUUID()}.log`;
  try {
    // A fresh request: the command's own signal may already be aborted.
    await new GuestFs(runtime.client, runtime.cwd).writeFile(path, output);
    return { path };
  } catch (error) {
    return { problem: `Full output could not be saved in the sandbox: ${(error as Error).message}` };
  }
}

function appendStatus(text: string, status: string): string {
  return `${text ? `${text}\n\n` : ""}${status}`;
}

/** Bound output for scripts the way Pi's bash tool does: whole, or the first and last half. */
function structuredOutput(output: Buffer): { content: string; truncated: boolean } {
  if (output.length <= STRUCTURED_OUTPUT_MAX_BYTES) return { content: output.toString("utf8"), truncated: false };
  const half = STRUCTURED_OUTPUT_MAX_BYTES / 2;
  const head = output.subarray(0, half).toString("utf8");
  const tail = output.subarray(output.length - half).toString("utf8");
  return { content: `${head}\n\n[... ${formatSize(output.length - STRUCTURED_OUTPUT_MAX_BYTES)} omitted ...]\n\n${tail}`, truncated: true };
}

function failureStatus(error: Error, signal: AbortSignal | undefined, seconds: number): string {
  if (signal?.aborted || error.name === "AbortError") return "Command aborted";
  if (error instanceof SandboxError && /timed out/.test(error.message)) return `Command timed out after ${seconds} seconds`;
  return error.message;
}

export interface BashParams {
  command: string;
  timeout?: number;
}

/** The model's bash tool, matching the result shape of Pi's built-in tool. */
export async function runBashTool(runtime: Runtime, params: BashParams, signal: AbortSignal | undefined,
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined) {
  const timeout = params.timeout === undefined ? runtime.timeoutMs : timeoutMs(params.timeout);
  const startedAt = performance.now();
  const decoder = new TextDecoder();
  let preview = "";
  let lastUpdate = 0;
  const outcome = await execute(runtime, params.command, timeout, signal, (data) => {
    if (!onUpdate) return;
    preview = truncateTail(preview + decoder.decode(data, { stream: true })).content;
    if (Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
      lastUpdate = Date.now();
      onUpdate({ content: [{ type: "text", text: preview }], details: undefined });
    }
  });

  const full = outcome.output.toString("utf8");
  const truncation = truncateTail(full);
  let text = truncation.content;
  let fullOutputPath: string | undefined;
  if (truncation.truncated) {
    const saved = await saveInGuest(runtime, outcome.output);
    fullOutputPath = saved.path;
    const location = saved.path ? `Full output in the sandbox: ${saved.path}` : saved.problem;
    const start = truncation.totalLines - truncation.outputLines + 1;
    const range = `lines ${start}-${truncation.totalLines} of ${truncation.totalLines}`;
    const limit = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
    text += `\n\n[Showing ${range}${limit}. ${location}]`;
  }
  const details = truncation.truncated ? { truncation, fullOutputPath } : undefined;

  if (outcome.error) {
    throw new Error(appendStatus(text, failureStatus(outcome.error, signal, timeout / 1000)), { cause: outcome.error });
  }
  const structured = structuredOutput(outcome.output);
  const structuredContent = {
    output: structured.content,
    truncated: structured.truncated,
    ...(structured.truncated && fullOutputPath ? { full_output_path: fullOutputPath } : {}),
    exit_code: outcome.exitCode,
    wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
  };
  if (outcome.exitCode !== 0) {
    return {
      content: [{ type: "text" as const, text: appendStatus(text || "(no output)", `Command exited with code ${outcome.exitCode}`) }],
      details, structuredContent, isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: text || "(no output)" }], details, structuredContent };
}

// What the user's ! commands pass to Pi. Pi saves output beyond its display limit
// (2000 lines or 50 KB) to a host file; staying under that keeps the model from being
// pointed at a host path its sandboxed read tool cannot open.
const USER_PREFIX_BYTES = 16 * 1024;
const USER_PREFIX_LINES = 400;
const USER_TAIL = { maxBytes: 24 * 1024, maxLines: 1000 };

/** BashOperations for the user's ! and !! commands. The host cwd Pi passes is ignored. */
export function userShellOperations(getRuntime: () => Promise<Runtime>): BashOperations {
  return {
    async exec(command, _hostCwd, { onData, signal, timeout }) {
      const runtime = await getRuntime();
      const limit = timeout === undefined ? runtime.timeoutMs : timeoutMs(timeout);
      const decoder = new TextDecoder();
      let shownBytes = 0;
      let shownLines = 0;
      let abbreviated = false;
      const show = (text: string) => {
        if (abbreviated) return;
        let visible = "";
        for (const character of text) {
          const size = Buffer.byteLength(character);
          if (shownBytes + size > USER_PREFIX_BYTES || (character === "\n" && shownLines >= USER_PREFIX_LINES)) {
            abbreviated = true;
            break;
          }
          visible += character;
          shownBytes += size;
          if (character === "\n") shownLines++;
        }
        if (visible) onData(Buffer.from(visible));
      };
      const outcome = await execute(runtime, command, limit, signal, (data) => show(decoder.decode(data, { stream: true })));
      show(decoder.decode());
      if (abbreviated) {
        const tail = truncateTail(outcome.output.toString("utf8"), USER_TAIL).content;
        const saved = await saveInGuest(runtime, outcome.output);
        const location = saved.path ? `Full output in the sandbox: ${saved.path}` : saved.problem;
        onData(Buffer.from(`\n\n[Output abbreviated; the end follows]\n${tail}\n\n[${location}]\n`));
      }
      if (outcome.error) {
        if (signal?.aborted || outcome.error.name === "AbortError") throw new Error("aborted");
        if (outcome.error instanceof SandboxError && /timed out/.test(outcome.error.message)) {
          throw new Error(`timeout:${limit / 1000}`);
        }
        throw outcome.error;
      }
      return { exitCode: outcome.exitCode };
    },
  };
}
