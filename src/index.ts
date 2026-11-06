// Pi extension: route Pi's coding tools and the user's ! commands to an
// External Sandbox server (https://github.com/prime-radiant-inc/external-sandbox).
import { posix } from "node:path";
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SandboxClient, type Mount } from "./client.ts";
import { GuestFs } from "./guest.ts";
import { runGrepTool } from "./grep.ts";
import { hostToGuest, toGuestPath } from "./paths.ts";
import { runBashTool, timeoutMs, userShellOperations, type Runtime } from "./shell.ts";

export const SANDBOX_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const URL_ENV = "EXTERNAL_SANDBOX_API_URL";
const DEFAULT_TIMEOUT_SECONDS = "120";

export interface SandboxRuntime extends Runtime {
  backend: string;
  mounts: Mount[];
}

export interface ExtensionOptions {
  /** Replaces the protocol client, for tests. */
  createClient?: (options: { url: string; timeoutMs: number }) => SandboxClient;
  env?: NodeJS.ProcessEnv;
}

function flagString(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default function externalSandbox(pi: ExtensionAPI, options: ExtensionOptions = {}): void {
  const env = options.env ?? process.env;
  const createClient = options.createClient ?? ((settings) => new SandboxClient(settings));

  pi.registerFlag("sandbox-url", {
    description: `External Sandbox server URL, such as http://127.0.0.1:8686 (default: $${URL_ENV})`,
    type: "string",
  });
  pi.registerFlag("sandbox-cwd", {
    description: "Working directory inside the sandbox (default: the host directory's mounted path, else the server's default)",
    type: "string",
  });
  pi.registerFlag("sandbox-timeout", {
    description: "Default bash timeout in seconds, at most 300",
    type: "string",
    default: DEFAULT_TIMEOUT_SECONDS,
  });

  let hostCwd = process.cwd();
  let pending: Promise<SandboxRuntime> | undefined;
  const active = new Set<AbortController>();

  const connect = async (): Promise<SandboxRuntime> => {
    const url = flagString(pi, "sandbox-url") ?? env[URL_ENV]?.trim();
    if (!url) throw new Error(`No sandbox configured. Start Pi with --sandbox-url http://127.0.0.1:PORT or set ${URL_ENV}.`);
    const timeout = timeoutMs(Number(flagString(pi, "sandbox-timeout") ?? DEFAULT_TIMEOUT_SECONDS));
    const client = createClient({ url, timeoutMs: timeout });
    const health = await client.health();
    const requested = flagString(pi, "sandbox-cwd");
    if (requested && !requested.startsWith("/")) throw new Error("--sandbox-cwd must be an absolute path inside the sandbox.");
    const cwd = posix.normalize(requested ?? hostToGuest(hostCwd, health.mounts) ?? health.defaultCwd);
    const probe = await client.exec(`printf '%s' "$HOME"`, { cwd, timeoutMs: 10_000 });
    if (probe.exitCode !== 0) throw new Error(`The sandbox working directory is not usable: ${cwd}`);
    const home = probe.stdout.toString("utf8");
    if (!home.startsWith("/")) throw new Error("The sandbox reported an invalid HOME.");
    return { client, url: client.url.origin, backend: health.backend, cwd, home, timeoutMs: timeout, mounts: health.mounts };
  };
  const runtime = (): Promise<SandboxRuntime> => {
    pending ??= connect().catch((error) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };

  /** Run work against the sandbox, cancelling it if Pi aborts or the session ends. */
  const withSandbox = async <T>(signal: AbortSignal | undefined, work: (rt: SandboxRuntime, signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    active.add(controller);
    try {
      const rt = await runtime();
      if (controller.signal.aborted) throw new Error("Operation aborted");
      return await work(rt, controller.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      active.delete(controller);
    }
  };
  const guestPath = (value: string | undefined, rt: SandboxRuntime) => toGuestPath(value ?? ".", rt);
  /** Pi's tools resolve relative paths against ctx.cwd, which must be the guest directory. */
  const guestContext = <C extends ExtensionContext>(ctx: C, rt: SandboxRuntime): C => ({ ...ctx, cwd: rt.cwd });

  // read, write, edit, ls and find reuse Pi's own tools with guest-backed operations.
  const read = createReadToolDefinition("/");
  pi.registerTool({
    ...read,
    async execute(id, params, signal, onUpdate, ctx) {
      return withSandbox(signal, (rt, signal) => {
        const fs = new GuestFs(rt.client, rt.cwd, signal);
        const tool = createReadToolDefinition(rt.cwd, {
          operations: {
            readFile: (path) => fs.readFile(path),
            access: (path) => fs.access(path),
            detectImageMimeType: (path) => fs.imageMimeType(path),
          },
        });
        return tool.execute(id, { ...params, path: guestPath(params.path, rt) }, signal, onUpdate, guestContext(ctx, rt));
      });
    },
  });

  const write = createWriteToolDefinition("/");
  pi.registerTool({
    ...write,
    async execute(id, params, signal, onUpdate, ctx) {
      return withSandbox(signal, (rt, signal) => {
        const fs = new GuestFs(rt.client, rt.cwd, signal);
        const tool = createWriteToolDefinition(rt.cwd, {
          operations: { writeFile: (path, content) => fs.writeFile(path, content), mkdir: (dir) => fs.mkdir(dir) },
        });
        return tool.execute(id, { ...params, path: guestPath(params.path, rt) }, signal, onUpdate, guestContext(ctx, rt));
      });
    },
  });

  const edit = createEditToolDefinition("/");
  pi.registerTool({
    ...edit,
    async execute(id, params, signal, onUpdate, ctx) {
      return withSandbox(signal, (rt, signal) => {
        const fs = new GuestFs(rt.client, rt.cwd, signal);
        const tool = createEditToolDefinition(rt.cwd, {
          operations: {
            readFile: (path) => fs.readFile(path),
            writeFile: (path, content) => fs.writeFile(path, content),
            access: (path) => fs.access(path, true),
          },
        });
        return tool.execute(id, { ...params, path: guestPath(params.path, rt) }, signal, onUpdate, guestContext(ctx, rt));
      });
    },
  });

  const ls = createLsToolDefinition("/");
  pi.registerTool({
    ...ls,
    async execute(id, params, signal, onUpdate, ctx) {
      return withSandbox(signal, (rt, signal) => {
        const fs = new GuestFs(rt.client, rt.cwd, signal);
        // One listing answers the per-entry directory checks Pi makes afterwards.
        const known = new Map<string, boolean>();
        const tool = createLsToolDefinition(rt.cwd, {
          operations: {
            exists: (path) => fs.exists(path),
            async stat(path) {
              const directory = known.get(path) ?? await fs.isDirectory(path);
              return { isDirectory: () => directory };
            },
            async readdir(path) {
              const entries = await fs.list(path);
              for (const [name, directory] of entries) known.set(posix.join(path, name), directory);
              return entries.map(([name]) => name);
            },
          },
        });
        return tool.execute(id, { ...params, path: guestPath(params.path, rt) }, signal, onUpdate, guestContext(ctx, rt));
      });
    },
  });

  const find = createFindToolDefinition("/");
  pi.registerTool({
    ...find,
    async execute(id, params, signal, onUpdate, ctx) {
      return withSandbox(signal, (rt, signal) => {
        const fs = new GuestFs(rt.client, rt.cwd, signal);
        const tool = createFindToolDefinition(rt.cwd, {
          operations: {
            exists: (path) => fs.exists(path),
            glob: (pattern, path, { ignore, limit }) => fs.glob(pattern, path, ignore, limit),
          },
        });
        return tool.execute(id, { ...params, path: guestPath(params.path, rt) }, signal, onUpdate, guestContext(ctx, rt));
      });
    },
  });

  // grep and bash have sandbox implementations with Pi's result shapes.
  const grep = createGrepToolDefinition("/");
  pi.registerTool({
    ...grep,
    async execute(_id, params, signal) {
      return withSandbox(signal, (rt, signal) =>
        runGrepTool(new GuestFs(rt.client, rt.cwd, signal), { ...params, path: guestPath(params.path, rt) }));
    },
  });

  const bash = createBashToolDefinition("/", { exposeSessionEnvironment: false });
  pi.registerTool({
    ...bash,
    description: "Execute a bash command inside the Linux sandbox. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB; when truncated, the full output is saved to a file inside the sandbox. The default timeout is 120 seconds (set by --sandbox-timeout) and the maximum is 300.",
    promptGuidelines: [],
    async execute(_id, params, signal, onUpdate) {
      return withSandbox(signal, (rt, signal) => runBashTool(rt, params, signal, onUpdate));
    },
  });

  // The user's ! and !! commands. Pi aborts the command if this backend fails; it
  // never falls back to running it on the host.
  const userShell = userShellOperations(runtime);
  pi.on("user_bash", () => ({ operations: userShell }));

  // Only the sandboxed tools may run, whatever other extensions or flags enable.
  pi.on("tool_call", (event) => {
    if (!SANDBOX_TOOLS.includes(event.toolName)) {
      return { block: true, reason: `${event.toolName} is not available: only tools that run in the sandbox are enabled.` };
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    hostCwd = ctx.cwd;
    pi.setActiveTools(SANDBOX_TOOLS);
    try {
      const rt = await runtime();
      ctx.ui.setStatus("sandbox", `Sandbox: ${rt.backend} ${rt.url} ${rt.cwd}`);
    } catch (error) {
      ctx.ui.setStatus("sandbox", "Sandbox unavailable");
      ctx.ui.notify(`Sandbox unavailable: ${(error as Error).message} Tools will fail until it is reachable.`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    for (const controller of active) controller.abort();
    pending = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    let rt: SandboxRuntime;
    try {
      rt = await runtime();
    } catch {
      return;
    }
    const mounts = rt.mounts.map((m) => `${m.hostPath} (host) is ${m.guestPath} in the sandbox, ${m.mode === "ro" ? "read-only" : "writable"}`);
    event.systemPromptOptions.sections.sandbox = [
      `All of your tools run inside a Linux sandbox (${rt.backend}), not on the user's computer.`,
      `The sandbox working directory is ${rt.cwd} and its home directory is ${rt.home}. Relative paths resolve against the sandbox working directory.`,
      mounts.length ? `Shared folders:\n${mounts.map((line) => `- ${line}`).join("\n")}` : "No host folders are shared with the sandbox.",
      "Each bash command starts a fresh shell, so cd and shell variables do not persist between commands. Network access depends on the sandbox's proxy policy.",
    ].join("\n");
  });
}
