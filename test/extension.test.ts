import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import externalSandbox, { SANDBOX_TOOLS } from "../src/index.ts";
import { startFakeSandbox, type FakeSandbox } from "./fake-sandbox.ts";

const HOST_PROJECT = "/Users/someone/project";

/** A minimal stand-in for Pi's ExtensionAPI that records what the extension registers. */
function loadExtension(flags: Record<string, string>, env: Record<string, string> = {}) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const values = new Map(Object.entries(flags));
  const statuses: string[] = [];
  const notices: string[] = [];
  let activeTools: string[] = [];
  const pi = {
    registerFlag(name: string, options: { default?: string }) {
      if (!values.has(name) && options.default !== undefined) values.set(name, options.default);
    },
    getFlag: (name: string) => values.get(name),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler),
    setActiveTools: (names: string[]) => { activeTools = names; },
  };
  externalSandbox(pi as any, { env });
  const ctx = (cwd: string) => ({
    cwd, hasUI: false, model: undefined,
    ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify: (text: string) => notices.push(text) },
  });
  return {
    tools, handlers, statuses, notices,
    get activeTools() { return activeTools; },
    start: (cwd: string) => handlers.get("session_start")!({ type: "session_start" }, ctx(cwd)),
    run: (name: string, params: object, signal?: AbortSignal, onUpdate?: (update: any) => void) =>
      tools.get(name).execute("call-1", params, signal, onUpdate, ctx(HOST_PROJECT)),
  };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((part) => part.text ?? "").join("");

describe("extension", () => {
  let sandbox: FakeSandbox;
  let project: string;
  let preserved: string;
  before(async () => {
    sandbox = await startFakeSandbox({
      mounts: (root) => [
        { name: "project", hostPath: HOST_PROJECT, guestPath: join(root, "mnt/project"), mode: "rw", preservedPaths: [] },
        { name: "same", hostPath: join(root, "same"), guestPath: join(root, "mnt/same"), mode: "rw", preservedPaths: [join(root, "same")] },
      ],
    });
    project = join(sandbox.guestRoot, "mnt/project");
    preserved = join(sandbox.guestRoot, "same");
    await mkdir(join(project, "sub"), { recursive: true });
    await mkdir(preserved);
    await writeFile(join(project, "notes.txt"), "alpha\nbeta\ngamma\n");
  });
  after(() => sandbox.close());

  test("registers the sandboxed tools and its flags", () => {
    const extension = loadExtension({ "sandbox-url": sandbox.url });
    assert.deepEqual([...extension.tools.keys()].sort(), [...SANDBOX_TOOLS].sort());
    for (const event of ["user_bash", "tool_call", "session_start", "session_shutdown", "before_agent_start"]) {
      assert.ok(extension.handlers.has(event), event);
    }
  });

  test("activates only sandboxed tools and shows the sandbox in the status bar", async () => {
    const extension = loadExtension({ "sandbox-url": sandbox.url });
    await extension.start(HOST_PROJECT);
    assert.deepEqual(extension.activeTools, SANDBOX_TOOLS);
    assert.deepEqual(extension.statuses, [`Sandbox: fake ${sandbox.url} ${project}`]);
  });

  test("fails closed when no sandbox is configured", async () => {
    const extension = loadExtension({});
    await extension.start(HOST_PROJECT);
    assert.deepEqual(extension.statuses, ["Sandbox unavailable"]);
    assert.equal(extension.notices[0], "Sandbox unavailable: No sandbox configured. Start Pi with --sandbox-url "
      + "http://127.0.0.1:PORT or set EXTERNAL_SANDBOX_API_URL. Tools will fail until it is reachable.");
    await assert.rejects(extension.run("bash", { command: "echo hi" }), /No sandbox configured/);
    await assert.rejects(extension.run("read", { path: "notes.txt" }), /No sandbox configured/);
    const { operations } = extension.handlers.get("user_bash")!({ type: "user_bash", command: "echo hi", cwd: HOST_PROJECT });
    await assert.rejects(operations.exec("echo hi", HOST_PROJECT, { onData() {} }), /No sandbox configured/);
  });

  test("reports an unreachable sandbox as one sentence per problem", async () => {
    const extension = loadExtension({ "sandbox-url": "http://127.0.0.1:9" });
    await extension.start(HOST_PROJECT);
    assert.match(extension.notices[0], /^Sandbox unavailable: Cannot connect to sandbox at http:\/\/127\.0\.0\.1:9: .*\d\. Tools will fail until it is reachable\.$/);
  });

  test("reads the URL from EXTERNAL_SANDBOX_API_URL", async () => {
    const extension = loadExtension({}, { EXTERNAL_SANDBOX_API_URL: sandbox.url });
    await extension.start(HOST_PROJECT);
    assert.equal(text(await extension.run("bash", { command: "echo from-env" })).trim(), "from-env");
  });

  describe("with a sandbox", () => {
    let extension: ReturnType<typeof loadExtension>;
    before(async () => {
      extension = loadExtension({ "sandbox-url": sandbox.url });
      await extension.start(`${HOST_PROJECT}/sub`);
    });

    test("follows Pi's host directory into the mounted guest directory", async () => {
      assert.equal(text(await extension.run("bash", { command: "pwd" })).trim(), join(project, "sub"));
    });

    test("keeps host paths unchanged for mounts with preserved paths", async () => {
      const other = loadExtension({ "sandbox-url": sandbox.url });
      await other.start(preserved);
      assert.equal(text(await other.run("bash", { command: "pwd" })).trim(), preserved);
    });

    test("write, read and edit act on guest files, translating host paths", async () => {
      await extension.run("write", { path: "created.txt", content: "one\ntwo\n" });
      assert.equal(await readFile(join(project, "sub/created.txt"), "utf8"), "one\ntwo\n");
      assert.match(text(await extension.run("read", { path: `${HOST_PROJECT}/notes.txt` })), /alpha\nbeta\ngamma/);
      await extension.run("edit", { path: `${HOST_PROJECT}/notes.txt`, edits: [{ oldText: "beta", newText: "BETA" }] });
      assert.equal(await readFile(join(project, "notes.txt"), "utf8"), "alpha\nBETA\ngamma\n");
    });

    test("ls, find and grep search the guest", async () => {
      assert.match(text(await extension.run("ls", { path: HOST_PROJECT })), /notes\.txt\nsub\//);
      assert.match(text(await extension.run("find", { pattern: "*.txt", path: HOST_PROJECT })), /notes\.txt/);
      assert.equal(text(await extension.run("grep", { pattern: "gamma", path: HOST_PROJECT })), "notes.txt:3: gamma");
    });

    test("bash returns Pi's result shape, marking nonzero exits as errors", async () => {
      const ok = await extension.run("bash", { command: "echo hello" });
      assert.equal(text(ok), "hello\n");
      assert.equal(ok.structuredContent.exit_code, 0);
      const failed = await extension.run("bash", { command: "echo oops; exit 4" });
      assert.equal(failed.isError, true);
      assert.equal(text(failed), "oops\n\n\nCommand exited with code 4");
      assert.equal(failed.structuredContent.exit_code, 4);
    });

    test("bash streams updates", async () => {
      const updates: string[] = [];
      await extension.run("bash", { command: "echo a; sleep 0.3; echo b" }, undefined, (update) => updates.push(text(update)));
      assert.ok(updates.length >= 1 && updates[0].startsWith("a"), updates.join("|"));
    });

    test("bash saves truncated output inside the sandbox", async () => {
      const result = await extension.run("bash", { command: "seq 1 3000" });
      const path = result.details.fullOutputPath as string;
      assert.match(text(result), /^1001\n/);
      assert.match(text(result), /\n3000\n\n\[Showing lines 1001-3000 of 3000\. Full output in the sandbox: \/tmp\/pi-bash-[\w-]+\.log\]$/);
      const saved = await extension.run("bash", { command: `wc -l < ${path}; rm ${path}` });
      assert.equal(text(saved).trim(), "3000");
    });

    test("bash enforces its timeout", async () => {
      await assert.rejects(extension.run("bash", { command: "sleep 5", timeout: 0.3 }), /Command timed out after 0.3 seconds/);
    });

    test("the user's ! commands run in the sandbox", async () => {
      const { operations } = extension.handlers.get("user_bash")!({ type: "user_bash", command: "pwd", cwd: HOST_PROJECT });
      const chunks: Buffer[] = [];
      const result = await operations.exec("pwd; exit 2", HOST_PROJECT, { onData: (data: Buffer) => chunks.push(data) });
      assert.equal(Buffer.concat(chunks).toString().trim(), join(project, "sub"));
      assert.equal(result.exitCode, 2);
    });

    test("long ! output is abbreviated and saved in the sandbox", async () => {
      const { operations } = extension.handlers.get("user_bash")!({ type: "user_bash", command: "", cwd: HOST_PROJECT });
      const chunks: Buffer[] = [];
      await operations.exec("seq 1 5000", HOST_PROJECT, { onData: (data: Buffer) => chunks.push(data) });
      const shown = Buffer.concat(chunks).toString();
      assert.ok(Buffer.byteLength(shown) < 50 * 1024 && shown.split("\n").length < 2000);
      assert.match(shown, /^1\n2\n/);
      assert.match(shown, /\n5000\n\n\[Full output in the sandbox: \/tmp\/pi-bash-/);
    });

    test("blocks tools that do not run in the sandbox", () => {
      const toolCall = extension.handlers.get("tool_call")!;
      assert.deepEqual(toolCall({ toolName: "powershell", input: {} }), {
        block: true, reason: "powershell is not available: only tools that run in the sandbox are enabled.",
      });
      assert.equal(toolCall({ toolName: "bash", input: {} }), undefined);
    });

    test("describes the sandbox in a system prompt section", async () => {
      const event = { type: "before_agent_start", messageType: "user", systemPromptOptions: { sections: {} as Record<string, string> } };
      await extension.handlers.get("before_agent_start")!(event);
      const section = event.systemPromptOptions.sections.sandbox;
      assert.match(section, new RegExp(`working directory is ${join(project, "sub")}`));
      assert.match(section, new RegExp(`${HOST_PROJECT} \\(host\\) is ${project} in the sandbox, writable`));
    });
  });
});
