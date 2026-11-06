import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import type { WebSocket } from "ws";
import { SandboxClient, SandboxError, parseSandboxUrl } from "../src/client.ts";
import { startFakeSandbox, type FakeSandbox } from "./fake-sandbox.ts";

async function unusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** A server that replies to the start message with the given frames, then closes. */
async function scripted(frames: Array<object | string | Buffer>, closeCode = 1000) {
  return startFakeSandbox({
    onConnection(socket: WebSocket) {
      socket.once("message", () => {
        for (const frame of frames) {
          if (Buffer.isBuffer(frame)) socket.send(frame, { binary: true });
          else socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
        }
        socket.close(closeCode);
      });
    },
  });
}

describe("SandboxClient", () => {
  let sandbox: FakeSandbox;
  let client: SandboxClient;
  before(async () => {
    sandbox = await startFakeSandbox({
      mounts: (root) => [{ name: "project", hostPath: "/Users/me/project", guestPath: `${root}/project`, mode: "rw", preservedPaths: [] }],
    });
    client = new SandboxClient({ url: sandbox.url, timeoutMs: 10_000 });
  });
  after(() => sandbox.close());

  test("rejects URLs that are not a bare http(s) origin", () => {
    for (const url of ["ftp://host", "http://user:pass@host", "http://host/path", "http://host/?q", "not a url"]) {
      assert.throws(() => parseSandboxUrl(url), SandboxError, url);
    }
    assert.equal(parseSandboxUrl("http://127.0.0.1:8686").origin, "http://127.0.0.1:8686");
  });

  test("reads /health including mounts", async () => {
    const health = await client.health();
    assert.equal(health.backend, "fake");
    assert.equal(health.defaultCwd, sandbox.guestRoot);
    assert.deepEqual(health.mounts.map((m) => [m.name, m.hostPath, m.mode]), [["project", "/Users/me/project", "rw"]]);
  });

  test("keeps stdout and stderr separate and reports nonzero exits as results", async () => {
    const result = await client.exec("printf out; printf err >&2; exit 3", { cwd: sandbox.guestRoot });
    assert.equal(result.stdout.toString(), "out");
    assert.equal(result.stderr.toString(), "err");
    assert.equal(result.exitCode, 3);
  });

  test("runs in the requested working directory", async () => {
    const result = await client.exec("pwd", { cwd: "/" });
    assert.equal(result.stdout.toString().trim(), "/");
  });

  test("streams output to onData", async () => {
    const seen: string[] = [];
    const result = await client.exec("echo one; echo two >&2", { cwd: "/", onData: (data, stream) => seen.push(`${stream}:${data}`) });
    assert.equal(result.exitCode, 0);
    assert.ok(seen.includes("stdout:one\n") && seen.includes("stderr:two\n"), seen.join());
    assert.equal(result.stdout.length, 0, "streamed output is not also collected");
  });

  test("sends stdin larger than one chunk, then EOF", async () => {
    const input = Buffer.alloc(100_000, "x");
    const result = await client.exec("wc -c", { cwd: "/", stdin: input });
    assert.equal(result.stdout.toString().trim(), "100000");
  });

  test("starts with stdin closed when none is given", async () => {
    const result = await client.exec("cat; echo done", { cwd: "/" });
    assert.equal(result.stdout.toString(), "done\n");
  });

  test("reports a server-side timeout as an error", async () => {
    await assert.rejects(client.exec("sleep 5", { cwd: "/", timeoutMs: 200 }), /timed out/);
  });

  test("aborting cancels the remote command", async () => {
    const controller = new AbortController();
    const marker = `${sandbox.guestRoot}/aborted-${Date.now()}`;
    const running = client.exec(`sleep 2; touch ${marker}`, { cwd: "/", signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(running, { name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const check = await client.exec(`test -e ${marker} && echo ran || echo cancelled`, { cwd: "/" });
    assert.equal(check.stdout.toString().trim(), "cancelled");
  });

  test("validates commands and working directories before connecting", async () => {
    await assert.rejects(client.exec("   ", { cwd: "/" }), /nonblank/);
    await assert.rejects(client.exec("true", { cwd: "relative" }), /absolute/);
    assert.throws(() => new SandboxClient({ url: sandbox.url, timeoutMs: 400_000 }), /timeout/);
  });

  test("fails clearly when nothing is listening", async () => {
    const offline = new SandboxClient({ url: await unusedUrl() });
    await assert.rejects(offline.health(), /Cannot connect to sandbox/);
    await assert.rejects(offline.exec("true", { cwd: "/" }), /Cannot connect to sandbox/);
  });

  const protocolFailures: Array<[string, Array<object | string | Buffer>, RegExp]> = [
    ["invalid base64", [{ type: "started", processId: "1" }, { type: "stdout", data: "not base64!" }], /invalid base64/],
    ["output before started", [{ type: "stdout", data: "" }], /before the command started/],
    ["a server error", [{ type: "error", error: "concurrency exhausted" }], /concurrency exhausted/],
    ["a close without exit", [{ type: "started", processId: "1" }], /without an exit result/],
    ["a binary frame", [{ type: "started", processId: "1" }, Buffer.from("x")], /binary/],
    ["an invalid exit", [{ type: "started", processId: "1" }, { type: "exit", exitCode: "0", signal: null, timedOut: false, outputLimitExceeded: false }], /invalid exit/],
  ];
  for (const [name, frames, expected] of protocolFailures) {
    test(`rejects ${name}`, async () => {
      const bad = await scripted(frames);
      try {
        await assert.rejects(new SandboxClient({ url: bad.url }).exec("true", { cwd: "/" }), expected);
      } finally {
        await bad.close();
      }
    });
  }

  test("reports a signal as 128 + signal number", async () => {
    const bad = await scripted([{ type: "started", processId: "1" },
      { type: "exit", exitCode: null, signal: 9, timedOut: false, outputLimitExceeded: false, durationMs: 1 }]);
    try {
      const result = await new SandboxClient({ url: bad.url }).exec("true", { cwd: "/" });
      assert.equal(result.exitCode, 137);
    } finally {
      await bad.close();
    }
  });
});
