// Client for the External Sandbox protocol: GET /health and one streaming
// command per WebSocket connection to /exec/ws. It never runs host commands.
import http from "node:http";
import https from "node:https";
import WebSocket from "ws";

export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_TIMEOUT_MS = 300_000;
const MAX_COMMAND_BYTES = 64 * 1024;
const STDIN_CHUNK_BYTES = 32 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_HEALTH_BYTES = 256 * 1024;

export interface Mount {
  name: string;
  hostPath: string;
  guestPath: string;
  mode: "ro" | "rw";
  preservedPaths: string[];
}

export interface Health {
  backend: string;
  defaultCwd: string;
  mounts: Mount[];
}

export interface ExecOptions {
  cwd: string;
  /** Bytes for stdin, sent in acknowledged chunks followed by EOF. Omit to start with stdin closed. */
  stdin?: Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Receives output as it arrives. When set, output is not also collected. */
  onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
}

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /** Exit status; signals are reported as 128 + signal number, as a shell would. */
  exitCode: number;
}

export interface SandboxClientOptions {
  url: string;
  timeoutMs?: number;
}

export class SandboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxError";
  }
}

export function abortError(): Error {
  const error = new Error("Sandbox operation aborted.");
  error.name = "AbortError";
  return error;
}

export function isGuestPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0")
    && Buffer.byteLength(value) <= 4096;
}

function checkTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new SandboxError(`Sandbox timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return value;
}

/** Parse and validate a sandbox base URL: an http(s) origin with nothing else. */
export function parseSandboxUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SandboxError(`Invalid sandbox URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") {
    throw new SandboxError("Sandbox URL must be an http(s) origin such as http://127.0.0.1:8686, without a path, query or credentials.");
  }
  return url;
}

function parseMount(value: unknown): Mount | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mount = value as Record<string, unknown>;
  if (typeof mount.name !== "string" || !isGuestPath(mount.hostPath) || !isGuestPath(mount.guestPath)
      || (mount.mode !== "ro" && mount.mode !== "rw")) {
    return undefined;
  }
  const preserved = Array.isArray(mount.preservedPaths) ? mount.preservedPaths.filter(isGuestPath) : [];
  return { name: mount.name, hostPath: mount.hostPath, guestPath: mount.guestPath, mode: mount.mode, preservedPaths: preserved };
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string") throw new SandboxError("Sandbox output must be base64 text.");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) throw new SandboxError("Sandbox sent invalid base64 output.");
  return data;
}

function exitStatus(frame: Record<string, unknown>): number {
  const { exitCode, signal, timedOut, outputLimitExceeded } = frame;
  const validCode = exitCode === null || (Number.isInteger(exitCode) && (exitCode as number) >= 0 && (exitCode as number) <= 255);
  const validSignal = signal === null || (Number.isInteger(signal) && (signal as number) >= 1 && (signal as number) <= 127);
  if (!validCode || !validSignal || typeof timedOut !== "boolean" || typeof outputLimitExceeded !== "boolean") {
    throw new SandboxError("Sandbox sent an invalid exit message.");
  }
  if (timedOut) throw new SandboxError("Sandbox command timed out.");
  if (outputLimitExceeded) throw new SandboxError("Sandbox command exceeded its output limit.");
  if (exitCode === null && signal === null) throw new SandboxError("Sandbox reported neither an exit code nor a signal.");
  return signal === null ? (exitCode as number) : 128 + (signal as number);
}

export class SandboxClient {
  readonly url: URL;
  readonly timeoutMs: number;

  constructor({ url, timeoutMs = 120_000 }: SandboxClientOptions) {
    this.url = parseSandboxUrl(url);
    this.timeoutMs = checkTimeout(timeoutMs);
  }

  /** Fetch /health. Proxy environment variables and redirects are deliberately not used. */
  async health(signal?: AbortSignal): Promise<Health> {
    if (signal?.aborted) throw abortError();
    const target = new URL("/health", this.url);
    const body = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          request.destroy();
          reject(error);
        } else resolve(value!);
      };
      const onAbort = () => finish(abortError());
      const request = (target.protocol === "https:" ? https : http).get(target, {
        agent: false,
        headers: { Accept: "application/json" },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(new SandboxError(`Sandbox /health returned HTTP ${response.statusCode}.`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_HEALTH_BYTES) finish(new SandboxError("Sandbox /health response is too large."));
          else chunks.push(chunk);
        });
        response.on("error", (error) => finish(new SandboxError(`Sandbox /health failed: ${error.message}`, { cause: error })));
        response.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
      });
      request.on("error", (error) => finish(new SandboxError(`Cannot connect to sandbox at ${this.url.origin}: ${error.message}`, { cause: error })));
      const timer = setTimeout(() => finish(new SandboxError("Sandbox /health request timed out.")), CONNECT_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body);
    } catch {
      throw new SandboxError("Sandbox /health returned invalid JSON.");
    }
    if (!data || typeof data !== "object" || data.status !== "ready") throw new SandboxError("Sandbox server is not ready.");
    if (!isGuestPath(data.defaultCwd)) throw new SandboxError("Sandbox /health reported an invalid defaultCwd.");
    const mounts = Array.isArray(data.mounts) ? data.mounts.map(parseMount).filter((m): m is Mount => m !== undefined) : [];
    return { backend: typeof data.backend === "string" ? data.backend : "unknown", defaultCwd: data.defaultCwd, mounts };
  }

  /** Run one Bash command in the guest. A nonzero exit is a normal result, not an error. */
  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const { cwd, stdin, signal, onData } = options;
    const timeoutMs = checkTimeout(options.timeoutMs ?? this.timeoutMs);
    const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (signal?.aborted) return Promise.reject(abortError());
    if (!command.trim() || command.includes("\0") || Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
      return Promise.reject(new SandboxError("Sandbox command must be nonblank, at most 64 KiB, and free of NUL bytes."));
    }
    if (!isGuestPath(cwd)) return Promise.reject(new SandboxError(`Sandbox working directory must be an absolute guest path: ${cwd}`));
    const target = new URL("/exec/ws", this.url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";

    return new Promise<ExecResult>((resolve, reject) => {
      const socket = new WebSocket(target, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
        followRedirects: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let started = false;
      let received = 0;
      let offset = 0;
      let nextId = 0;
      let pendingId: number | null = null;
      let inputDone = stdin === undefined;
      // The server enforces timeoutMs; this guards against a server that stops responding.
      const deadline = setTimeout(() => finish(new SandboxError("Sandbox stopped responding before the command deadline.")),
        timeoutMs + CONNECT_TIMEOUT_MS);

      const finish = (error: Error | null, exitCode?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
        if (socket.readyState === WebSocket.OPEN) {
          // Closing the connection also cancels the process group; cancel says so explicitly.
          if (error) socket.send(JSON.stringify({ type: "cancel" }), () => {});
          socket.close(1000);
          setTimeout(() => socket.terminate(), 250).unref();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
        if (error) reject(error);
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: exitCode! });
      };
      const send = (message: object) => socket.send(JSON.stringify(message), (error) => {
        if (error) finish(new SandboxError(`Sandbox connection failed: ${error.message}`, { cause: error }));
      });
      const pumpStdin = () => {
        if (settled || !started || inputDone || pendingId !== null || stdin === undefined) return;
        if (offset >= stdin.length) {
          inputDone = true;
          send({ type: "stdin_eof" });
          return;
        }
        const chunk = stdin.subarray(offset, offset + STDIN_CHUNK_BYTES);
        offset += chunk.length;
        pendingId = nextId++;
        send({ type: "stdin", id: pendingId, data: chunk.toString("base64") });
      };
      const onAbort = () => finish(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });

      socket.on("open", () => {
        send({ type: "start", command, cwd, stdin: stdin !== undefined, timeoutMs, maxOutputBytes });
      });
      socket.on("message", (raw, isBinary) => {
        if (settled) return;
        try {
          if (isBinary) throw new SandboxError("Sandbox sent a binary WebSocket message.");
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(raw.toString());
          } catch {
            throw new SandboxError("Sandbox sent invalid JSON.");
          }
          if (!frame || typeof frame !== "object") throw new SandboxError("Sandbox sent an invalid message.");
          if (frame.type === "error") {
            throw new SandboxError(`Sandbox error: ${typeof frame.error === "string" ? frame.error : "unknown error"}`);
          }
          if (frame.type === "started") {
            if (started) throw new SandboxError("Sandbox sent a second started message.");
            started = true;
            pumpStdin();
            return;
          }
          if (!started) throw new SandboxError("Sandbox sent output before the command started.");
          switch (frame.type) {
            case "stdout":
            case "stderr": {
              const data = decodeBase64(frame.data);
              received += data.length;
              if (received > maxOutputBytes) throw new SandboxError("Sandbox command exceeded its output limit.");
              if (onData) onData(data, frame.type);
              else (frame.type === "stdout" ? stdout : stderr).push(data);
              return;
            }
            case "stdin_ack":
              if (pendingId === null || frame.id !== pendingId) throw new SandboxError("Sandbox sent an unexpected stdin acknowledgement.");
              pendingId = null;
              pumpStdin();
              return;
            case "stdin_closed":
              inputDone = true;
              pendingId = null;
              return;
            case "exit":
              finish(null, exitStatus(frame));
              return;
            default:
              throw new SandboxError(`Sandbox sent an unknown message type: ${String(frame.type)}`);
          }
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.on("error", (error) => finish(new SandboxError(`Cannot connect to sandbox at ${this.url.origin}: ${error.message}`, { cause: error })));
      socket.on("close", (code) => finish(new SandboxError(`Sandbox closed the connection without an exit result (WebSocket ${code}).`)));
    });
  }
}
