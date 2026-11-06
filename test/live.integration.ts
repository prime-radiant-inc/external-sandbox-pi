// Tests against a real External Sandbox server. Start one, then run:
//   EXTERNAL_SANDBOX_PI_TEST_URL=http://127.0.0.1:8686 npm run test:integration
// They work inside a fresh guest temporary directory and remove it afterwards.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, RpcClient, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SandboxClient } from "../src/client.ts";

const url = process.env.EXTERNAL_SANDBOX_PI_TEST_URL;
const skip = url ? false : "Set EXTERNAL_SANDBOX_PI_TEST_URL to a running External Sandbox server";
const extensionPath = resolve(import.meta.dirname, "../src/index.ts");
const piCli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");

describe("live sandbox", { skip }, () => {
  let client: SandboxClient;
  let guest: string;
  let host: string;
  before(async () => {
    client = new SandboxClient({ url: url! });
    const health = await client.health();
    const made = await client.exec("mktemp -d", { cwd: health.defaultCwd });
    guest = made.stdout.toString().trim();
    host = await realpath(await mkdtemp(join(tmpdir(), "external-sandbox-pi-live-")));
  });
  after(async () => {
    await client.exec(`rm -rf -- '${guest}'`, { cwd: "/" });
    await rm(host, { recursive: true, force: true });
  });

  test("model tools run in the sandbox", { timeout: 120_000 }, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "external-sandbox-pi-agent-"));
    const faux = registerFauxProvider();
    const file = `${guest}/notes.txt`;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "uname -s; whoami" })]),
      fauxAssistantMessage([fauxToolCall("write", { path: file, content: "alpha\nbeta\n" })]),
      fauxAssistantMessage([fauxToolCall("edit", { path: file, edits: [{ oldText: "beta", newText: "gamma" }] })]),
      fauxAssistantMessage([fauxToolCall("read", { path: file })]),
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "gamma", path: guest })]),
      fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt", path: guest })]),
      fauxAssistantMessage([fauxToolCall("ls", { path: guest })]),
      fauxAssistantMessage("done"),
    ]);
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, JSON.stringify({
      providers: { faux: { baseUrl: "http://127.0.0.1:9", api: faux.api, apiKey: "placeholder", models: [{ id: "faux-1" }] } },
    }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
    const resourceLoader = new DefaultResourceLoader({
      cwd: host, agentDir, noExtensions: true, additionalExtensionPaths: [extensionPath],
      noSkills: true, noPromptTemplates: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    process.env.EXTERNAL_SANDBOX_API_URL = url;
    const { session } = await createAgentSession({
      cwd: host, agentDir, model: modelRuntime.getModel("faux", "faux-1"), modelRuntime, resourceLoader,
      sessionManager: SessionManager.inMemory(host),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    try {
      await session.bindExtensions({});
      await session.prompt("Use the tools");
      const output = (name: string) => {
        const result = session.messages.find((message: any) => message.role === "toolResult" && message.toolName === name) as any;
        assert.ok(result && !result.isError, `${name} failed: ${JSON.stringify(result?.content)}`);
        return result.content.map((part: any) => part.text ?? "").join("");
      };
      assert.match(output("bash"), /^Linux\n/);
      assert.match(output("read"), /alpha\ngamma/);
      assert.equal(output("grep"), "notes.txt:2: gamma");
      assert.match(output("find"), /notes\.txt/);
      assert.match(output("ls"), /notes\.txt/);
      const check = await client.exec(`cat '${file}'`, { cwd: "/" });
      assert.equal(check.stdout.toString(), "alpha\ngamma\n");
      assert.deepEqual(await readdir(host), [], "nothing was written on the host");
    } finally {
      session.dispose();
      faux.unregister();
      delete process.env.EXTERNAL_SANDBOX_API_URL;
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  test("the user's ! commands run in the sandbox with the pi CLI", { timeout: 120_000 }, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "external-sandbox-pi-agent-"));
    const rpc = new RpcClient({
      cliPath: piCli, cwd: host,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
        "--no-builtin-tools", "-e", extensionPath, "--sandbox-url", url!, "--sandbox-cwd", guest],
    });
    await rpc.start();
    try {
      const result = await rpc.bash("uname -s; pwd; printf proof > rpc.txt");
      assert.equal(result.output, `Linux\n${guest}\n`);
      assert.equal(result.exitCode, 0);
      assert.equal((await client.exec(`cat '${guest}/rpc.txt'`, { cwd: "/" })).stdout.toString(), "proof");
      assert.equal(existsSync(join(host, "rpc.txt")), false);
    } finally {
      await rpc.stop();
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
