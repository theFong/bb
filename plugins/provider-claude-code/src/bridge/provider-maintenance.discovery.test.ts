import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClaudeProviderInstallationStatus } from "./provider-maintenance.js";
import { buildSessionOptions } from "./session-options.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: (...args: Parameters<typeof actual.accessSync>) => {
      if (
        args[0] === "/opt/homebrew/bin/claude" ||
        args[0] === "/usr/local/bin/claude"
      ) {
        throw new Error("System installations are outside the test fixture");
      }
      return actual.accessSync(...args);
    },
  };
});

describe.skipIf(process.platform === "win32")(
  "Claude native installation discovery",
  () => {
    let home: string;
    let bin: string;
    let nativePath: string;

    function sessionExecutable() {
      return buildSessionOptions(
        {
          cwd: home,
          instructionMode: "append",
          permissionMode: "default",
          permissionScope: "workspace",
          serviceTier: "default",
          workflowsEnabled: false,
          chromeEnabled: false,
          disable1MContext: false,
          sandboxEnabled: true,
        },
        process.env,
      ).pathToClaudeCodeExecutable;
    }

    beforeEach(async () => {
      const which = execFileSync("which", ["which"], {
        encoding: "utf8",
      }).trim();
      home = await mkdtemp(path.join(os.tmpdir(), "bb-claude-discovery-"));
      bin = path.join(home, "path-bin");
      nativePath = path.join(home, ".local", "bin", "claude");
      await mkdir(bin);
      await symlink(which, path.join(bin, "which"));
      vi.spyOn(os, "homedir").mockReturnValue(home);
      vi.spyOn(process, "getuid").mockReturnValue(1000);
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", bin);
      vi.stubEnv("BB_CLAUDE_CODE_EXECUTABLE", undefined);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    });

    async function installFixture(executable: string, version = "2.1.289") {
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(
        executable,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' '${version} (Claude Code)'\nelse\n  printf '%s\\n' 'Your organization requires remote managed settings to load, but they could not be loaded.' >&2\n  exit 1\nfi\n`,
        { mode: 0o755 },
      );
    }

    it("finds a native install outside PATH even when doctor cannot load managed settings", async () => {
      await installFixture(nativePath);

      const status = await getClaudeProviderInstallationStatus();

      expect(status).toMatchObject({
        executablePath: nativePath,
        installed: true,
        currentVersion: "2.1.289",
        installAction: null,
        versionUnsupported: false,
      });
      expect(sessionExecutable()).toBe(nativePath);
    });

    it("uses the same legacy installation for startup and maintenance", async () => {
      const legacy = path.join(home, ".claude", "local", "claude");
      await installFixture(legacy);

      expect(sessionExecutable()).toBe(legacy);
      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        installed: true,
        executablePath: legacy,
      });
    });

    it("honors empty PATH entries consistently without which", async () => {
      await installFixture(nativePath);
      const cwd = path.join(home, "cwd");
      const cwdExecutable = path.join(cwd, "claude");
      await installFixture(cwdExecutable, "2.1.290");
      vi.stubEnv("PATH", `:${path.join(home, "empty-bin")}`);
      const previousCwd = process.cwd();
      try {
        process.chdir(cwd);
        expect(sessionExecutable()).toBe(cwdExecutable);
        expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
          executablePath: cwdExecutable,
          currentVersion: "2.1.290",
        });
      } finally {
        process.chdir(previousCwd);
      }
    });

    it("does not use native fallback locations as root", async () => {
      await installFixture(nativePath);
      vi.spyOn(process, "getuid").mockReturnValue(0);

      expect(sessionExecutable()).toBeUndefined();
      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        installed: false,
        executablePath: null,
      });
    });

    it("discovers a newly installed native symlink on the next check", async () => {
      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        installed: false,
        installAction: { kind: "install" },
      });
      const versionPath = path.join(
        home,
        ".local",
        "share",
        "claude",
        "versions",
        "2.1.289",
      );
      await installFixture(versionPath);
      await mkdir(path.dirname(nativePath), { recursive: true });
      await symlink(versionPath, nativePath);

      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        executablePath: nativePath,
        installed: true,
        currentVersion: "2.1.289",
        installAction: null,
      });
    });

    it("prefers the executable on PATH over the native install", async () => {
      await installFixture(nativePath);
      const pathExecutable = path.join(bin, "claude");
      await installFixture(pathExecutable, "2.1.290");

      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        executablePath: pathExecutable,
        currentVersion: "2.1.290",
      });
      expect(sessionExecutable()).toBe(pathExecutable);
    });

    it("preserves PATH precedence when which is unavailable", async () => {
      await rm(path.join(bin, "which"));
      await installFixture(nativePath);
      const pathExecutable = path.join(bin, "claude");
      await installFixture(pathExecutable, "2.1.290");

      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        executablePath: pathExecutable,
        currentVersion: "2.1.290",
      });
    });

    it("preserves explicit executable overrides", async () => {
      await installFixture(nativePath);
      await installFixture(path.join(bin, "claude"));
      const explicit = path.join(home, "custom", "claude");
      await installFixture(explicit, "2.1.291");
      vi.stubEnv("BB_CLAUDE_CODE_EXECUTABLE", `  ${explicit}  `);

      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        executablePath: explicit,
        currentVersion: "2.1.291",
      });
    });

    it("does not replace an invalid explicit override with the native install", async () => {
      await installFixture(nativePath);
      vi.stubEnv("BB_CLAUDE_CODE_EXECUTABLE", path.join(home, "missing"));

      expect(sessionExecutable).toThrow(
        "BB_CLAUDE_CODE_EXECUTABLE must point to an executable",
      );
      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        installed: false,
        executablePath: null,
      });
    });

    it("does not report a non-executable native file as installed", async () => {
      await installFixture(nativePath);
      await chmod(nativePath, 0o644);

      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        installed: false,
        executablePath: null,
      });
    });

    it("does not report a directory at the native path as installed", async () => {
      await mkdir(nativePath, { recursive: true });

      expect(await getClaudeProviderInstallationStatus(false)).toMatchObject({
        installed: false,
        executablePath: null,
      });
    });
  },
);
