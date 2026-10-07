import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Set<string>());

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  accessSync: (candidate: string) => {
    if (!files.has(candidate)) throw new Error("ENOENT");
  },
  statSync: (candidate: string) => ({ isFile: () => files.has(candidate) }),
}));

import {
  findClaudeCodeExecutable,
  resolveClaudeCodeExecutable,
} from "./claude-executable.js";

const originalPlatform = process.platform;

beforeEach(() => {
  files.clear();
  if (process.getuid !== undefined) {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
  }
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
});

describe("Claude executable platform discovery", () => {
  it.each([
    {
      name: "Windows native install",
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\test", PATH: "C:\\Windows" },
      installed: ["C:\\Users\\test\\.local\\bin\\claude.exe"],
      expected: "C:\\Users\\test\\.local\\bin\\claude.exe",
    },
    {
      name: "Windows Path spelling and semicolon-separated directories",
      platform: "win32",
      env: {
        USERPROFILE: "C:\\Users\\test",
        Path: "C:\\missing;C:\\tools",
      },
      installed: [
        "C:\\Users\\test\\.local\\bin\\claude.exe",
        "C:\\tools\\claude.exe",
      ],
      expected: "C:\\tools\\claude.exe",
    },
    {
      name: "Windows explicit override",
      platform: "win32",
      env: {
        PATH: "C:\\tools",
        BB_CLAUDE_CODE_EXECUTABLE: "  C:\\custom\\claude.exe  ",
      },
      installed: ["C:\\tools\\claude.exe", "C:\\custom\\claude.exe"],
      expected: "C:\\custom\\claude.exe",
    },
    {
      name: "Apple Silicon Homebrew install",
      platform: "darwin",
      env: { HOME: "/users/test", PATH: "/missing" },
      installed: ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
      expected: "/opt/homebrew/bin/claude",
    },
    {
      name: "Intel Homebrew install",
      platform: "darwin",
      env: { HOME: "/users/test", PATH: "/missing" },
      installed: ["/usr/local/bin/claude"],
      expected: "/usr/local/bin/claude",
    },
    {
      name: "native install before legacy and system installs",
      platform: "linux",
      env: { HOME: "/home/test", PATH: "/missing" },
      installed: [
        "/home/test/.local/bin/claude",
        "/home/test/.claude/local/claude",
        "/usr/local/bin/claude",
      ],
      expected: "/home/test/.local/bin/claude",
    },
  ])("finds $name", ({ platform, env, installed, expected }) => {
    Object.defineProperty(process, "platform", { value: platform });
    installed.forEach((file) => files.add(file));

    expect(findClaudeCodeExecutable({ env })).toBe(expected);
    expect(resolveClaudeCodeExecutable({ env })).toBe(expected);
  });

  it("rejects an invalid Windows override without selecting a PATH install", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    files.add("C:\\tools\\claude.exe");
    const env = {
      PATH: "C:\\tools",
      BB_CLAUDE_CODE_EXECUTABLE: "C:\\missing\\claude.exe",
    };

    expect(findClaudeCodeExecutable({ env })).toBeNull();
    expect(() => resolveClaudeCodeExecutable({ env })).toThrow(
      "BB_CLAUDE_CODE_EXECUTABLE must point to an executable",
    );
  });

  it("keeps Windows npm shims discoverable for maintenance without passing them to the SDK", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const env = { USERPROFILE: "C:\\Users\\test", Path: "C:\\npm" };
    const native = "C:\\Users\\test\\.local\\bin\\claude.exe";
    files.add("C:\\npm\\claude.cmd");
    files.add(native);

    expect(findClaudeCodeExecutable({ env, useWindowsPathExt: true })).toBe(
      "C:\\npm\\claude.cmd",
    );
    expect(resolveClaudeCodeExecutable({ env })).toBe(native);
  });
});
