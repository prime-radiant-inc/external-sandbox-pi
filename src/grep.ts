// The grep tool: ripgrep runs in the guest; results are formatted here exactly as
// Pi's built-in grep formats them. Pi's own grep always runs ripgrep on the host,
// so it cannot be reused through GrepOperations.
import { posix } from "node:path";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import type { GuestFs } from "./guest.ts";

const DEFAULT_LIMIT = 100;
const MAX_LINE_LENGTH = 500;

export interface GrepParams {
  pattern: string;
  path: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export async function runGrepTool(fs: GuestFs, params: GrepParams) {
  const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT));
  const context = params.context && params.context > 0 ? Math.floor(params.context) : 0;
  let result;
  try {
    result = await fs.grep({ path: params.path, pattern: params.pattern, glob: params.glob, ignoreCase: params.ignoreCase,
      literal: params.literal, context, limit });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new Error(`Path not found: ${params.path}`);
    throw error;
  }
  if (!result.matches.length) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };

  const display = (file: string) => {
    if (result.isDirectory) {
      const relative = posix.relative(params.path, file);
      if (relative && !relative.startsWith("..")) return relative;
    }
    return posix.basename(file);
  };
  let linesTruncated = false;
  const rows: string[] = [];
  for (const match of result.matches) {
    const name = display(match.path);
    for (const [number, raw] of match.block) {
      const { text, wasTruncated } = truncateLine(raw.replace(/\r/g, ""));
      if (wasTruncated) linesTruncated = true;
      rows.push(number === match.line ? `${name}:${number}: ${text}` : `${name}-${number}- ${text}`);
    }
  }
  const truncation = truncateHead(rows.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const details: { matchLimitReached?: number; truncation?: typeof truncation; linesTruncated?: boolean } = {};
  const notices: string[] = [];
  if (result.limitReached) {
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    details.matchLimitReached = limit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length) output += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text" as const, text: output }], details: notices.length ? details : undefined };
}
