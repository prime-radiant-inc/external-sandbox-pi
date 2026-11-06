// Translate paths between Pi's host view and the sandbox. Only the mounts the
// server advertises are translated; the host filesystem is never inspected.
import { posix } from "node:path";
import type { Mount } from "./client.ts";

const within = (value: string, root: string) => value === root || value.startsWith(root === "/" ? "/" : `${root}/`);

/** Map an absolute host path inside a mount to its guest path, or return undefined. */
export function hostToGuest(hostPath: string, mounts: Mount[]): string | undefined {
  const normalized = posix.normalize(hostPath);
  // Prefer the most specific mount when mounts are nested.
  const mount = [...mounts]
    .sort((a, b) => b.hostPath.length - a.hostPath.length)
    .find((candidate) => within(normalized, candidate.hostPath));
  if (!mount) return undefined;
  // With --preserve-paths the server also mounts the directory at its host path.
  if (mount.preservedPaths.includes(mount.hostPath)) return normalized;
  return posix.join(mount.guestPath, normalized.slice(mount.hostPath.length));
}

export interface PathContext {
  cwd: string;
  home: string;
  mounts: Mount[];
}

/** Resolve a tool path argument to an absolute guest path. */
export function toGuestPath(value: string, { cwd, home, mounts }: PathContext): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Path must be a string without NUL bytes.");
  let name = value.startsWith("@") ? value.slice(1) : value;
  if (name === "~") name = home;
  else if (name.startsWith("~/")) name = posix.join(home, name.slice(2));
  if (posix.isAbsolute(name)) return hostToGuest(name, mounts) ?? posix.normalize(name);
  return posix.resolve(cwd, name || ".");
}
