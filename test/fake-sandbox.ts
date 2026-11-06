// A local stand-in for an External Sandbox server, for tests only. It implements
// GET /health and WebSocket /exec/ws by running commands with Bash on this machine
// inside a temporary "guest" directory. python3 is the uv-managed Python unless
// EXTERNAL_SANDBOX_PI_TEST_PYTHON names another interpreter.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Mount } from "../src/client.ts";

export interface FakeSandboxOptions {
  mounts?: (guestRoot: string) => Mount[];
  /** Replace the handling of a whole /exec/ws connection. */
  onConnection?: (socket: WebSocket) => void;
}

export interface FakeSandbox {
  url: string;
  /** A temporary directory that plays the guest's filesystem root for tests. */
  guestRoot: string;
  /** Commands started, in order. */
  commands: string[];
  close(): Promise<void>;
}

function pythonPath(): string {
  const configured = process.env.EXTERNAL_SANDBOX_PI_TEST_PYTHON;
  if (configured) return configured;
  return execFileSync("uv", ["python", "find"], { encoding: "utf8" }).trim();
}

export async function startFakeSandbox(options: FakeSandboxOptions = {}): Promise<FakeSandbox> {
  // Resolved, because macOS's temporary directory is reached through a symlink.
  const guestRoot = await realpath(await mkdtemp(join(tmpdir(), "external-sandbox-pi-guest-")));
  const bin = join(guestRoot, ".bin");
  const home = join(guestRoot, "home");
  await mkdir(bin);
  await mkdir(home);
  await symlink(pythonPath(), join(bin, "python3"));
  const mounts = options.mounts?.(guestRoot) ?? [];
  const commands: string[] = [];
  const children = new Set<ChildProcess>();

  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ready", backend: "fake", architecture: "test", shell: "/bin/bash",
        defaultCwd: guestRoot, activeCommands: children.size, mounts }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  const sockets = new WebSocketServer({ server, path: "/exec/ws" });
  sockets.on("connection", (socket) => {
    if (options.onConnection) return options.onConnection(socket);
    let child: ChildProcess | undefined;
    let outputBytes = 0;
    const send = (message: object) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message));
    const kill = () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    };
    socket.on("close", kill);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "start") {
        commands.push(message.command);
        const started = Date.now();
        let timedOut = false;
        let outputLimitExceeded = false;
        child = spawn("/bin/bash", ["-c", message.command], {
          cwd: message.cwd, detached: true,
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: "C.UTF-8" },
          stdio: [message.stdin === false ? "ignore" : "pipe", "pipe", "pipe"],
        });
        children.add(child);
        const timer = setTimeout(() => { timedOut = true; kill(); }, message.timeoutMs ?? 30_000);
        const output = (type: "stdout" | "stderr") => (data: Buffer) => {
          outputBytes += data.length;
          if (outputBytes > (message.maxOutputBytes ?? 4 * 1024 * 1024)) {
            outputLimitExceeded = true;
            kill();
            return;
          }
          send({ type, data: data.toString("base64") });
        };
        child.stdout!.on("data", output("stdout"));
        child.stderr!.on("data", output("stderr"));
        child.stdin?.on("error", () => {});
        child.on("error", (error) => {
          send({ type: "error", error: error.message });
          socket.close();
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          children.delete(child!);
          const signals: Record<string, number> = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2 };
          send({ type: "exit", exitCode: signal ? null : code, signal: signal ? signals[signal] ?? 15 : null,
            timedOut, outputLimitExceeded, durationMs: Date.now() - started });
          socket.close(1000);
        });
        send({ type: "started", processId: String(child.pid) });
      } else if (message.type === "stdin") {
        child!.stdin!.write(Buffer.from(message.data, "base64"), () => send({ type: "stdin_ack", id: message.id }));
      } else if (message.type === "stdin_eof") {
        child!.stdin!.end(() => send({ type: "stdin_closed" }));
      } else if (message.type === "cancel") {
        kill();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    guestRoot,
    commands,
    async close() {
      for (const child of children) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      }
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(guestRoot, { recursive: true, force: true });
    },
  };
}
