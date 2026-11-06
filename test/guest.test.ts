import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxClient } from "../src/client.ts";
import { GuestFs, GUEST_HELPER } from "../src/guest.ts";
import { runGrepTool } from "../src/grep.ts";
import { startFakeSandbox, type FakeSandbox } from "./fake-sandbox.ts";

describe("GuestFs", () => {
  let sandbox: FakeSandbox;
  let fs: GuestFs;
  let root: string;
  before(async () => {
    sandbox = await startFakeSandbox();
    root = join(sandbox.guestRoot, "work");
    await mkdir(join(root, "src/nested"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await mkdir(join(root, "build"), { recursive: true });
    // Like Pi's grep, grep honours .gitignore inside git repositories.
    execFileSync("git", ["init", "--quiet", root]);
    await writeFile(join(root, ".gitignore"), "build/\nnode_modules/\n");
    await writeFile(join(root, "src/app.ts"), "const answer = 42;\n// TODO first\n");
    await writeFile(join(root, "src/app.spec.ts"), "test('answer');\n");
    await writeFile(join(root, "src/nested/deep.ts"), "line 1\nline 2\nTODO deep\nline 4\nline 5\n");
    await writeFile(join(root, "node_modules/pkg/index.ts"), "TODO ignored\n");
    await writeFile(join(root, "build/out.ts"), "TODO ignored\n");
    await writeFile(join(root, "README.md"), "# Readme\nTodo in readme\n");
    fs = new GuestFs(new SandboxClient({ url: sandbox.url }), root);
  });
  after(() => sandbox.close());

  test("the helper command stays within the protocol's 64 KiB command limit", () => {
    assert.ok(Buffer.byteLength(GUEST_HELPER) < 48 * 1024);
  });

  test("round-trips binary file contents", async () => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await fs.writeFile(join(root, "binary.bin"), data);
    assert.deepEqual(await readFile(join(root, "binary.bin")), data);
    assert.deepEqual(await fs.readFile(join(root, "binary.bin")), data);
  });

  test("creates directories and answers existence and type questions", async () => {
    await fs.mkdir(join(root, "a/b/c"));
    assert.equal(await fs.isDirectory(join(root, "a/b/c")), true);
    assert.equal(await fs.isDirectory(join(root, "README.md")), false);
    assert.equal(await fs.exists(join(root, "README.md")), true);
    assert.equal(await fs.exists(join(root, "missing")), false);
    await fs.access(join(root, "README.md"), true);
  });

  test("reports missing files with ENOENT", async () => {
    await assert.rejects(fs.readFile(join(root, "missing.txt")), { code: "ENOENT" });
    await assert.rejects(fs.access(join(root, "missing.txt")), { code: "ENOENT" });
  });

  test("lists entries with their directory flag", async () => {
    const entries = new Map(await fs.list(join(root, "src")));
    assert.equal(entries.get("nested"), true);
    assert.equal(entries.get("app.ts"), false);
  });

  test("detects image types from their contents", async () => {
    await writeFile(join(root, "image.dat"), Buffer.from("89504e470d0a1a0a0000", "hex"));
    assert.equal(await fs.imageMimeType(join(root, "image.dat")), "image/png");
    assert.equal(await fs.imageMimeType(join(root, "README.md")), null);
  });

  describe("glob", () => {
    const ignore = ["**/node_modules/**", "**/.git/**"];
    const glob = (pattern: string, limit = 100) => fs.glob(pattern, root, ignore, limit);

    test("matches file names when the pattern has no slash", async () => {
      assert.deepEqual(await glob("*.ts"), ["src/app.spec.ts", "src/app.ts", "src/nested/deep.ts"]);
    });

    test("matches paths, anywhere in the tree, when the pattern has a slash", async () => {
      assert.deepEqual(await glob("src/*.ts"), ["src/app.spec.ts", "src/app.ts"]);
      assert.deepEqual(await glob("nested/*.ts"), ["src/nested/deep.ts"]);
      assert.deepEqual(await glob("src/**/*.ts"), ["src/app.spec.ts", "src/app.ts", "src/nested/deep.ts"]);
    });

    test("respects .gitignore and the ignore list", async () => {
      const all = await glob("*");
      assert.ok(!all.some((path) => path.startsWith("node_modules/") || path.startsWith("build/")), all.join());
      assert.ok(all.includes(".gitignore"), "hidden files are included");
    });

    test("stops at the limit", async () => {
      assert.equal((await glob("*.ts", 2)).length, 2);
    });
  });

  describe("grep", () => {
    const grep = async (params: Record<string, unknown>) => {
      const result = await runGrepTool(fs, { path: root, pattern: "TODO", ...params } as never);
      return result.content[0].text;
    };
    // ripgrep searches files in parallel, so (as with Pi's grep) the order of files is not
    // fixed. Like Pi's grep, --hidden also searches .git, which holds TODOs in git's sample hooks.
    const files = (text: string) => text.split("\n").filter((line) => !line.startsWith(".git/")).sort().join("\n");

    test("formats matches like Pi's grep and skips ignored files", async () => {
      assert.equal(files(await grep({})), "src/app.ts:2: // TODO first\nsrc/nested/deep.ts:3: TODO deep");
    });

    test("supports context lines", async () => {
      assert.equal(await grep({ path: join(root, "src/nested"), context: 1 }),
        "deep.ts-2- line 2\ndeep.ts:3: TODO deep\ndeep.ts-4- line 4");
    });

    test("supports ignoreCase, literal and glob", async () => {
      assert.match(files(await grep({ ignoreCase: true })), /README\.md:2: Todo in readme/);
      assert.equal(await grep({ pattern: "answer = 4", literal: true }), "src/app.ts:1: const answer = 42;");
      assert.equal(await grep({ glob: "*.md", ignoreCase: true }), "README.md:2: Todo in readme");
    });

    test("names a single searched file by its basename", async () => {
      assert.equal(await grep({ path: join(root, "src/app.ts") }), "app.ts:2: // TODO first");
    });

    test("reports the match limit", async () => {
      const result = await runGrepTool(fs, { path: root, pattern: "TODO", limit: 1 });
      assert.match(result.content[0].text, /1 matches limit reached\. Use limit=2/);
      assert.deepEqual(result.details, { matchLimitReached: 1 });
    });

    test("reports no matches and missing paths", async () => {
      assert.equal(await grep({ pattern: "nothing-matches-this" }), "No matches found");
      await assert.rejects(runGrepTool(fs, { path: join(root, "missing"), pattern: "x" }), /Path not found/);
    });
  });
});
