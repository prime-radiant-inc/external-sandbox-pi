# external-sandbox-pi

[![GitHub repo](https://img.shields.io/badge/github-repo-green)](https://github.com/prime-radiant-inc/external-sandbox-pi)
[![npm](https://img.shields.io/npm/v/external-sandbox-pi.svg)](https://www.npmjs.com/package/external-sandbox-pi)
[![Changelog](https://img.shields.io/github/v/release/prime-radiant-inc/external-sandbox-pi?include_prereleases&label=changelog)](https://github.com/prime-radiant-inc/external-sandbox-pi/blob/main/CHANGELOG.md)
[![Tests](https://github.com/prime-radiant-inc/external-sandbox-pi/workflows/Test/badge.svg)](https://github.com/prime-radiant-inc/external-sandbox-pi/actions?query=workflow%3ATest)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/prime-radiant-inc/external-sandbox-pi/blob/main/LICENSE)

A [Pi](https://pi.dev) extension that runs Pi's coding tools inside an [External Sandbox](https://github.com/prime-radiant-inc/external-sandbox): a Linux virtual machine or container that sees only the folders you choose and reaches only the network destinations you allow.

Pi itself keeps running on your computer. Every file operation and command it performs on your behalf goes to the sandbox instead:

- The model's `bash`, `read`, `write`, `edit`, `grep`, `find` and `ls` tools.
- Your own `!command` and `!!command` shell commands.

If the sandbox cannot be reached, these fail with an error. They never fall back to running on your computer.

## Requirements

- [Pi](https://pi.dev) 1.5 or later, on Node.js 22.19 or later.
- A running External Sandbox server. Any of these works:

  | Server | Start it with | URL |
  | --- | --- | --- |
  | [external-sandbox-v86](https://github.com/prime-radiant-inc/external-sandbox-v86): Linux in WebAssembly | `npx external-sandbox-v86 --preserve-paths --mount-rw "project=$PWD"` | `http://127.0.0.1:8686` |
  | [external-sandbox-container](https://github.com/prime-radiant-inc/external-sandbox-container): Apple Containers | `uvx external-sandbox-container --preserve-paths --mount-rw "project=$PWD"` | `http://127.0.0.1:8687` |
  | [external-sandbox-quicksand](https://github.com/prime-radiant-inc/external-sandbox-quicksand): QEMU virtual machine | `uvx external-sandbox-quicksand --preserve-paths --mount-rw "project=$PWD"` | `http://127.0.0.1:8688` |

- `python3` (3.12 or later) and `rg` (ripgrep) inside the sandbox. The default images of all three servers include both.

## Quick start

Start a sandbox server from your project directory, for example:

```bash
npx external-sandbox-v86 --preserve-paths --mount-rw "project=$PWD"
```

Then, in another terminal in the same directory, start Pi with this extension:

```bash
pi -e npm:external-sandbox-pi --no-builtin-tools --sandbox-url http://127.0.0.1:8686
```

`-e npm:external-sandbox-pi` downloads the extension for this run only. `--no-builtin-tools` starts Pi without its own local tools, so nothing can run on your computer if the extension fails to load.

Check that the status bar shows `Sandbox: ...` before you start. Ask Pi to run `uname -a` or try `!uname -a`: the answer should come from Linux.

## Install it permanently

```bash
pi install npm:external-sandbox-pi
```

An installed extension loads in every Pi session. Sessions then need a sandbox URL, from `--sandbox-url` or the `EXTERNAL_SANDBOX_API_URL` environment variable; without one, the tools report that no sandbox is configured. To keep the sandbox opt-in, use `pi -e npm:external-sandbox-pi` for the sessions that need it instead.

Remove it again with `pi remove npm:external-sandbox-pi`.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--sandbox-url URL` | `$EXTERNAL_SANDBOX_API_URL` | The sandbox server, such as `http://127.0.0.1:8686`. Required. |
| `--sandbox-cwd PATH` | See below | Working directory inside the sandbox. |
| `--sandbox-timeout SECONDS` | `120` | Default timeout for bash commands. The maximum is 300. |

`EXTERNAL_SANDBOX_API_URL` is the same variable the [Claude Code integration](https://github.com/prime-radiant-inc/external-sandbox/tree/main/claude-code) uses, so one setting serves both.

## Paths and the working directory

The sandbox server reports which host folders it mounts, and where. The extension uses that to translate paths:

- If you start Pi inside a mounted folder, the sandbox working directory is the same folder inside the sandbox. Otherwise it is the server's default directory, unless `--sandbox-cwd` says otherwise.
- An absolute path inside a mounted host folder is translated to its location in the sandbox. Other absolute paths are paths inside the sandbox.
- Relative paths resolve against the sandbox working directory, and `~` is the sandbox user's home directory.

Start the server with `--preserve-paths` and your project appears inside the sandbox at the same absolute path as on your computer. Paths then look identical on both sides, which avoids confusion for the model and for you.

The extension also adds a short section to the system prompt telling the model that its tools run in a Linux sandbox, with the working directory and the shared folders.

## Limits

- Each bash command starts a fresh shell: `cd` and shell variables do not carry over between commands. Files do.
- A command can produce at most 16 MiB of output. The model sees the last 2000 lines or 50 KB; when output is longer, the full output is saved to `/tmp/pi-bash-*.log` inside the sandbox and the model is told where.
- `read`, `write` and `edit` transfer files of up to about 12 MiB.
- The sandbox's network access is whatever its server's proxy policy allows. By default, none.

## What is and is not sandboxed

The sandbox contains the commands and file changes Pi makes through these tools. It does not contain Pi itself:

- Pi's model traffic, sessions, settings, skills, context files and prompt templates stay on your computer.
- Other Pi extensions are code running on your computer. This extension blocks every tool call other than its seven sandboxed tools, so tools from other extensions, MCP servers and Pi's code mode cannot run. That blocking is not a sandbox for the other extensions' own code.
- Writable mounts are real host folders. Anything the model changes there changes on your computer immediately; use version control.

## Development

```bash
npm ci
npm run check   # type check
npm test        # unit tests and end-to-end tests with the real Pi
```

The tests run against a local stand-in for a sandbox server, which runs commands on your machine in a temporary directory. They need `rg`, and [uv](https://docs.astral.sh/uv/) to provide Python (set `EXTERNAL_SANDBOX_PI_TEST_PYTHON` to use another interpreter). The end-to-end tests drive the real Pi with a scripted model, so they need no model provider or API key.

To test against a real sandbox server:

```bash
EXTERNAL_SANDBOX_PI_TEST_URL=http://127.0.0.1:8686 npm run test:integration
```

Releases are published to npm by GitHub Actions when a GitHub release is published; see [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

## License

Apache 2.0
