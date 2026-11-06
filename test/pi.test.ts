// End-to-end tests with the real Pi: an in-process SDK session driven by Pi's
// scripted "faux" model, and the pi CLI in RPC mode for the user's ! commands.
// Both use the local fake sandbox; neither calls a real model provider.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, RpcClient, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_TOOLS } from "../src/index.ts";
import { startFakeSandbox, type FakeSandbox } from "./fake-sandbox.ts";

const extensionPath = resolve(import.meta.dirname, "../src/index.ts");
// The pi command, as installed by npm (package "bin").
const piCli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");

describe("real Pi", () => {
  let sandbox: FakeSandbox;
  let host: string;
  let project: string;
  before(async () => {
    // The host project directory Pi runs in; the fake sandbox mounts it at a different guest path.
    // Resolved like the host paths real servers report (macOS reaches its temp directory through a symlink).
    host = await realpath(await mkdtemp(join(tmpdir(), "external-sandbox-pi-host-")));
    sandbox = await startFakeSandbox({
      mounts: (root) => [{ name: "project", hostPath: host, guestPath: join(root, "mnt/project"), mode: "rw", preservedPaths: [] }],
    });
    project = join(sandbox.guestRoot, "mnt/project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "existing.txt"), "from the guest\n");
  });
  after(async () => {
    await sandbox.close();
    await rm(host, { recursive: true, force: true });
  });

  test("model tool calls run in the sandbox through Pi's agent loop", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "external-sandbox-pi-agent-"));
    const faux = registerFauxProvider();
    process.env.EXTERNAL_SANDBOX_API_URL = sandbox.url;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "pwd; uname -s" })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "written.txt", content: "hello\n" })]),
      fauxAssistantMessage([fauxToolCall("read", { path: "existing.txt" })]),
      fauxAssistantMessage([fauxToolCall("edit", { path: "written.txt", edits: [{ oldText: "hello", newText: "goodbye" }] })]),
      fauxAssistantMessage([fauxToolCall("ls", {})]),
      fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt" })]),
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "goodbye" })]),
      fauxAssistantMessage([fauxToolCall("powershell", { command: "Get-ChildItem" })]),
      fauxAssistantMessage("done"),
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd: host, agentDir, noExtensions: true, additionalExtensionPaths: [extensionPath],
      noSkills: true, noPromptTemplates: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    // Declare the scripted model as a custom provider. Its api is the faux API, so requests never
    // leave this process; the unreachable baseUrl and placeholder key exist only to satisfy Pi.
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, JSON.stringify({
      providers: { faux: { baseUrl: "http://127.0.0.1:9", api: faux.api, apiKey: "placeholder", models: [{ id: "faux-1" }] } },
    }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
    const model = modelRuntime.getModel("faux", "faux-1");
    assert.equal(model?.api, faux.api);
    const { session } = await createAgentSession({
      cwd: host, agentDir, model, modelRuntime, resourceLoader,
      sessionManager: SessionManager.inMemory(host),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    try {
      const extensionErrors: string[] = [];
      await session.bindExtensions({ onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`) });
      assert.deepEqual(session.getActiveToolNames().sort(), [...SANDBOX_TOOLS].sort());
      await session.prompt("Use the tools");
      const results = session.messages.filter((message) => message.role === "toolResult") as any[];
      const output = (name: string) => {
        const result = results.find((message) => message.toolName === name);
        assert.ok(result, `no ${name} result`);
        return { text: result.content.map((part: any) => part.text ?? "").join(""), isError: result.isError };
      };
      assert.equal(output("bash").text, `${project}\n${process.platform === "darwin" ? "Darwin" : "Linux"}\n`);
      assert.equal(await readFile(join(project, "written.txt"), "utf8"), "goodbye\n");
      assert.match(output("read").text, /from the guest/);
      assert.match(output("ls").text, /existing\.txt\nwritten\.txt/);
      assert.match(output("find").text, /existing\.txt/);
      assert.equal(output("grep").text, "written.txt:1: goodbye");
      assert.equal(output("powershell").isError, true);
      assert.deepEqual(extensionErrors, []);
      // The model receives the sandbox description as a section of its system message.
      const system = session.messages.find((message: any) => message.role === "system") as any;
      assert.match(system.sections.sandbox, /All of your tools run inside a Linux sandbox \(fake\)/);
      assert.match(system.sections.sandbox, new RegExp(`working directory is ${project}`));
      assert.deepEqual(await readdir(host), [], "nothing was written on the host");
    } finally {
      session.dispose();
      faux.unregister();
      delete process.env.EXTERNAL_SANDBOX_API_URL;
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  async function rpc(args: string[], callback: (client: RpcClient) => Promise<void>) {
    const agentDir = await mkdtemp(join(tmpdir(), "external-sandbox-pi-agent-"));
    const client = new RpcClient({
      cliPath: piCli, cwd: host,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
        "--no-builtin-tools", "-e", extensionPath, ...args],
    });
    await client.start();
    try {
      await callback(client);
    } finally {
      await client.stop();
      await rm(agentDir, { recursive: true, force: true });
    }
  }

  test("the user's ! commands run in the sandbox with the pi CLI", { timeout: 60_000 }, async () => {
    await rpc(["--sandbox-url", sandbox.url], async (client) => {
      const result = await client.bash("pwd; printf proof > rpc.txt; exit 3");
      assert.equal(result.output.trim(), project);
      assert.equal(result.exitCode, 3);
      assert.equal(await readFile(join(project, "rpc.txt"), "utf8"), "proof");
      assert.equal(existsSync(join(host, "rpc.txt")), false);
    });
  });

  test("the user's ! commands fail closed when the sandbox is unreachable", { timeout: 60_000 }, async () => {
    await rpc(["--sandbox-url", "http://127.0.0.1:9"], async (client) => {
      await assert.rejects(client.bash("printf leaked > leaked.txt"), /Cannot connect to sandbox/);
      assert.equal(existsSync(join(host, "leaked.txt")), false);
    });
  });
});
