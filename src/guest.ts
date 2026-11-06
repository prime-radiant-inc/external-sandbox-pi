// Filesystem and search operations that run inside the sandbox. Each call runs a
// small Python helper in the guest with a JSON request on stdin, so paths, patterns
// and file contents never become shell source. Nothing here touches the host.
import type { SandboxClient } from "./client.ts";

/** Largest file the read operations transfer: base64 output must fit under the 16 MiB protocol cap. */
export const MAX_TRANSFER_BYTES = 12 * 1024 * 1024 - 4096;

// Python 3.12 or newer (the oldest Python in the supported sandbox images).
export const GUEST_HELPER = String.raw`
import base64, fnmatch, json, os, stat, subprocess, sys, tempfile

MAX_BYTES = ${MAX_TRANSFER_BYTES}
MAX_LINE = 2000

def segments(value):
    return [part for part in value.split("/") if part not in ("", ".")]

def glob_match(path_parts, pattern_parts):
    # fd-style glob: "**" spans any number of whole segments, other wildcards stay within one.
    memo = {}
    def match(i, j):
        key = (i, j)
        if key not in memo:
            if j == len(pattern_parts):
                memo[key] = i == len(path_parts)
            elif pattern_parts[j] == "**":
                memo[key] = any(match(k, j + 1) for k in range(i, len(path_parts) + 1))
            else:
                memo[key] = i < len(path_parts) and fnmatch.fnmatchcase(path_parts[i], pattern_parts[j]) and match(i + 1, j + 1)
        return memo[key]
    return match(0, 0)

def find_matches(relative, absolute, pattern):
    if "/" not in pattern:
        return fnmatch.fnmatchcase(relative.rsplit("/", 1)[-1], pattern)
    if pattern.startswith("/"):
        return glob_match(segments(absolute), segments(pattern))
    if not pattern.startswith("**/") and pattern != "**":
        pattern = "**/" + pattern
    return glob_match(segments(relative), segments(pattern))

def run_rg(args, cwd=None):
    # stderr goes to a file so a flood of warnings cannot block stdout.
    errors = tempfile.TemporaryFile()
    child = subprocess.Popen(["rg", "--no-config", *args], cwd=cwd, stdout=subprocess.PIPE, stderr=errors)
    child.errors = errors
    return child

def rg_failure(child):
    child.errors.seek(0)
    message = child.errors.read(65536).decode("utf-8", "replace").strip()
    return RuntimeError(message or "ripgrep exited with code %d" % child.returncode)

def read_bytes(path):
    with open(path, "rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("File is larger than the %d byte transfer limit; use bash to inspect part of it" % MAX_BYTES)
    return data

def file_lines(path, cache):
    if path not in cache:
        try:
            with open(path, "rb") as handle:
                text = handle.read(MAX_BYTES).decode("utf-8", "replace")
            cache[path] = text.replace("\r\n", "\n").split("\n")
        except OSError:
            cache[path] = []
    return cache[path]

def text_of(value):
    if "text" in value:
        return value["text"]
    return base64.b64decode(value.get("bytes", "")).decode("utf-8", "replace")

def operation(request):
    kind = request["op"]
    path = request.get("path")
    if kind == "read":
        return base64.b64encode(read_bytes(path)).decode("ascii")
    if kind == "write":
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(request["data"], validate=True))
        return None
    if kind == "mkdir":
        os.makedirs(path, exist_ok=True)
        return None
    if kind == "access":
        os.stat(path)
        mode = os.R_OK | (os.W_OK if request.get("write") else 0)
        if not os.access(path, mode):
            raise PermissionError(13, "Permission denied", path)
        return None
    if kind == "exists":
        return os.path.exists(path)
    if kind == "is_directory":
        return stat.S_ISDIR(os.stat(path).st_mode)
    if kind == "list":
        with os.scandir(path) as entries:
            return [[entry.name, entry.is_dir()] for entry in entries]
    if kind == "mime":
        with open(path, "rb") as handle:
            head = handle.read(16)
        signatures = [(b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"),
                      (b"GIF87a", "image/gif"), (b"GIF89a", "image/gif")]
        for prefix, mime in signatures:
            if head.startswith(prefix):
                return mime
        if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
            return "image/webp"
        return None
    if kind == "glob":
        args = ["--files", "--hidden", "--no-require-git", "--sort=path", "--null"]
        for ignored in request["ignore"]:
            args += ["--glob", "!" + ignored]
        child = run_rg(args, cwd=path)
        found, limit = [], request["limit"]
        for item in child.stdout.read().split(b"\0"):
            if not item:
                continue
            relative = os.fsdecode(item).removeprefix("./")
            if find_matches(relative, os.path.join(path, relative), request["pattern"]):
                found.append(relative)
                if len(found) >= limit:
                    break
        child.wait()
        if len(found) < limit and child.returncode not in (0, 1):
            raise rg_failure(child)
        return found
    if kind == "grep":
        is_directory = stat.S_ISDIR(os.stat(path).st_mode)
        args = ["--json", "--line-number", "--color=never", "--hidden"]
        if request.get("ignoreCase"):
            args.append("--ignore-case")
        if request.get("literal"):
            args.append("--fixed-strings")
        if request.get("glob"):
            args += ["--glob", request["glob"]]
        args += ["--", request["pattern"], path]
        child = run_rg(args)
        context, limit = request["context"], request["limit"]
        matches, cache, limited = [], {}, False
        for raw in child.stdout:
            event = json.loads(raw)
            if event["type"] != "match":
                continue
            data = event["data"]
            filename = text_of(data["path"])
            number = data["line_number"]
            if context:
                lines = file_lines(filename, cache)
                start, end = max(1, number - context), min(len(lines), number + context)
                block = [[n, lines[n - 1][:MAX_LINE]] for n in range(start, end + 1)]
            else:
                text = text_of(data["lines"]).replace("\r\n", "\n").replace("\r", "").removesuffix("\n")
                block = [[number, text[:MAX_LINE]]]
            matches.append({"path": filename, "line": number, "block": block})
            if len(matches) >= limit:
                limited = True
                break
        if limited:
            child.terminate()
        child.wait()
        if not limited and child.returncode not in (0, 1):
            raise rg_failure(child)
        return {"isDirectory": is_directory, "matches": matches, "limitReached": limited}
    raise ValueError("Unknown sandbox operation: " + kind)

try:
    result = {"ok": True, "value": operation(json.load(sys.stdin))}
except FileNotFoundError as error:
    result = {"ok": False, "code": "ENOENT", "error": "%s: %s" % (error.strerror, error.filename)}
except Exception as error:
    code = {13: "EACCES", 17: "EEXIST", 20: "ENOTDIR", 21: "EISDIR"}.get(getattr(error, "errno", None))
    result = {"ok": False, "code": code, "error": str(error)}
sys.stdout.write(json.dumps(result))
`;

const HELPER_COMMAND = `python3 -c '${GUEST_HELPER.replaceAll("'", "'\\''")}'`;

export interface GrepMatch {
  path: string;
  line: number;
  /** [line number, text] pairs: the match line plus any context lines around it. */
  block: Array<[number, string]>;
}

export interface GrepResult {
  isDirectory: boolean;
  matches: GrepMatch[];
  limitReached: boolean;
}

export interface GrepRequest {
  path: string;
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context: number;
  limit: number;
}

export class GuestError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "GuestError";
    if (code) this.code = code;
  }
}

/** Typed wrapper around the guest helper. All paths must already be absolute guest paths. */
export class GuestFs {
  readonly client: SandboxClient;
  readonly cwd: string;
  readonly signal?: AbortSignal;

  constructor(client: SandboxClient, cwd: string, signal?: AbortSignal) {
    this.client = client;
    this.cwd = cwd;
    this.signal = signal;
  }

  async call<T>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    const request = Buffer.from(JSON.stringify({ op, ...fields }));
    const result = await this.client.exec(HELPER_COMMAND, { cwd: this.cwd, stdin: request, signal: this.signal });
    let reply: { ok: boolean; value?: T; error?: string; code?: string };
    try {
      reply = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      const detail = result.stderr.toString("utf8").trim();
      throw new GuestError(detail ? `Sandbox helper failed: ${detail}` : `Sandbox helper exited with code ${result.exitCode}; python3 is required in the sandbox.`);
    }
    if (!reply.ok) throw new GuestError(reply.error ?? "Sandbox operation failed", reply.code);
    return reply.value as T;
  }

  async readFile(path: string): Promise<Buffer> {
    return Buffer.from(await this.call<string>("read", { path }), "base64");
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.call("write", { path, data: Buffer.from(content).toString("base64") });
  }

  async mkdir(path: string): Promise<void> {
    await this.call("mkdir", { path });
  }

  async access(path: string, write = false): Promise<void> {
    await this.call("access", { path, write });
  }

  exists(path: string): Promise<boolean> {
    return this.call<boolean>("exists", { path });
  }

  isDirectory(path: string): Promise<boolean> {
    return this.call<boolean>("is_directory", { path });
  }

  /** Directory entries with whether each is a directory (following symlinks). */
  list(path: string): Promise<Array<[string, boolean]>> {
    return this.call<Array<[string, boolean]>>("list", { path });
  }

  async imageMimeType(path: string): Promise<string | null> {
    return this.call<string | null>("mime", { path });
  }

  glob(pattern: string, path: string, ignore: string[], limit: number): Promise<string[]> {
    return this.call<string[]>("glob", { pattern, path, ignore, limit });
  }

  grep(request: GrepRequest): Promise<GrepResult> {
    return this.call<GrepResult>("grep", { ...request });
  }
}
