import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const CLAUDE_CODE_EXECUTABLE_ENV = "BB_CLAUDE_CODE_EXECUTABLE";

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function wellKnownClaudeExecutablePaths(env: NodeJS.ProcessEnv): string[] {
  if (process.getuid?.() === 0) return [];
  if (process.platform === "win32") {
    const home = env.USERPROFILE?.trim();
    return home ? [path.win32.join(home, ".local", "bin", "claude.exe")] : [];
  }
  const home = env.HOME?.trim();
  return [
    ...(home
      ? [
          path.posix.join(home, ".local", "bin", "claude"),
          path.posix.join(home, ".claude", "local", "claude"),
        ]
      : []),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

export function findClaudeCodeExecutable({
  env,
  useWindowsPathExt = false,
}: {
  env: NodeJS.ProcessEnv;
  useWindowsPathExt?: boolean;
}): string | null {
  const paths = process.platform === "win32" ? path.win32 : path.posix;
  const explicit = env[CLAUDE_CODE_EXECUTABLE_ENV]?.trim();
  if (explicit) {
    return isExecutableFile(explicit) ? paths.resolve(explicit) : null;
  }

  const names =
    process.platform !== "win32"
      ? ["claude"]
      : useWindowsPathExt
        ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .map((extension) => extension.trim().toLowerCase())
            .filter((extension) => extension.startsWith("."))
            .map((extension) => `claude${extension}`)
        : ["claude.exe"];
  const pathEnv = env.PATH ?? env.Path;
  const directories =
    pathEnv === undefined ? [] : pathEnv.split(paths.delimiter);
  if (process.platform === "win32" && useWindowsPathExt) {
    directories.unshift(process.cwd());
  }
  for (const directory of directories) {
    if (process.platform === "win32" && !directory) continue;
    for (const name of names) {
      const candidate = paths.resolve(directory, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return wellKnownClaudeExecutablePaths(env).find(isExecutableFile) ?? null;
}

export function resolveClaudeCodeExecutable(args: {
  env: NodeJS.ProcessEnv;
}): string | null {
  const executable = findClaudeCodeExecutable(args);
  const explicit = args.env[CLAUDE_CODE_EXECUTABLE_ENV]?.trim();
  if (executable === null && explicit) {
    throw new Error(
      `${CLAUDE_CODE_EXECUTABLE_ENV} must point to an executable Claude CLI path: ${explicit}`,
    );
  }
  return executable;
}
