import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("private test-server workflow", () => {
  it("prepares a credential-free sandbox deploy bundle", () => {
    const output = execFileSync("node", ["scripts/deploy-test-server.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SCREEPS_SERVER_URL: "http://deploy-user:deploy-pass@localhost:21025",
        SCREEPS_BRANCH: "agent-sandbox",
        SCREEPS_TOKEN: "secret-token",
      },
    });

    expect(output).toContain("Prepared Screeps private/test-server deploy bundle");
    expect(output).toContain("branch: agent-sandbox");
    expect(output).toContain("server: http://localhost:21025");
    expect(output).not.toContain("deploy-user");
    expect(output).not.toContain("deploy-pass");

    const bundlePath = join(process.cwd(), "dist", "main.js");
    expect(existsSync(bundlePath)).toBe(true);

    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle).toContain("Target: http://redacted:redacted@localhost:21025 / branch agent-sandbox");
    expect(bundle).not.toContain("secret-token");
    expect(bundle).not.toContain("deploy-user");
    expect(bundle).not.toContain("deploy-pass");
  });

  it("refuses non-dry-run mode without a token", () => {
    expect(() =>
      execFileSync("node", ["scripts/deploy-test-server.mjs"], {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_DRY_RUN: "0",
          SCREEPS_TOKEN: "",
        },
      }),
    ).toThrow(/SCREEPS_TOKEN/);
  });

  it("prints a status report with offline fallback data", () => {
    const output = execFileSync("node", ["scripts/test-server-status.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SCREEPS_SERVER_URL: "http://status-user:status-pass@127.0.0.1:1",
        SCREEPS_BRANCH: "agent-sandbox",
      },
    });

    expect(output).toContain("Screeps private/test-server status");
    expect(output).toContain("server: http://redacted:redacted@127.0.0.1:1");
    expect(output).toContain("reachable:");
    expect(output).toContain("branch: agent-sandbox");
    expect(output).toContain("offline final RCL:");
    expect(output).toContain("offline failures: 0");
    expect(output).not.toContain("status-user");
    expect(output).not.toContain("status-pass");
  });

  it("reports unreachable servers clearly in JSON mode", () => {
    const output = execFileSync(
      "node",
      ["scripts/test-server-status.mjs", "--json", "--timeout-ms", "200"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_SERVER_URL: "http://127.0.0.1:1",
          SCREEPS_BRANCH: "agent-sandbox",
        },
      },
    );

    const status = JSON.parse(output);
    expect(status.reachable).toBe(false);
    expect(status.fallback).toContain("server/API unavailable");
    expect(status.probes.some((probe: { ok: boolean }) => !probe.ok)).toBe(true);
    expect(status.simulation.final.rcl).toBeGreaterThanOrEqual(1);
    expect(output).not.toContain("failed ()");
  });

  it("redacts tokens and URL secrets from private-server status output", () => {
    const token = "super-secret-status-token";
    const urlUser = "embedded-user";
    const urlPassword = "embedded-password";
    const queryToken = "embedded-query-token";
    const queryPassword = "embedded-query-password";
    const output = execFileSync(
      "node",
      ["scripts/test-server-status.mjs", "--json", "--timeout-ms", "200"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_SERVER_URL: `http://${urlUser}:${urlPassword}@127.0.0.1:1?_token=${queryToken}&password=${queryPassword}`,
          SCREEPS_BRANCH: "agent-sandbox",
          SCREEPS_USERNAME: "agent-user",
          SCREEPS_TOKEN: token,
        },
      },
    );

    expect(output).not.toContain(token);
    expect(output).not.toContain(urlUser);
    expect(output).not.toContain(urlPassword);
    expect(output).not.toContain(queryToken);
    expect(output).not.toContain(queryPassword);
    const status = JSON.parse(output);
    expect(status.serverUrl).toContain("redacted");
    expect(status.user).toBe("agent-user");
    expect(status.tokenConfigured).toBe(true);
    expect(status.probes.some((probe: { reason?: string }) => probe.reason === "token not configured")).toBe(false);
  });

  it("uses narrow private-server probes and avoids broad credential headers", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "test-server-status.mjs"), "utf8");

    expect(script).toContain("/api/user/branches");
    expect(script).not.toContain("/api/user/code?branch=");
    expect(script).not.toContain("Authorization: Bearer");
    expect(script).not.toContain("Bearer ${");
    expect(script).not.toContain("Authorization: `Bearer");
    expect(script).not.toContain("data.email");
  });

  it("generates a local-server proof block without leaking tokens", () => {
    const output = execFileSync(
      "node",
      ["scripts/local-server-proof.mjs", "--compose-dir", "does-not-exist", "--markdown"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_SERVER_URL: "http://localhost:21025",
          SCREEPS_BRANCH: "agent-sandbox",
          SCREEPS_TOKEN: "super-secret-token",
        },
      },
    );

    expect(output).toContain("## Local Screeps private-server proof");
    expect(output).toContain("Server URL: http://localhost:21025");
    expect(output).toContain("Branch: agent-sandbox");
    expect(output).toContain("Token configured: yes (redacted)");
    expect(output).toContain("docker-compose.yml not found");
    expect(output).not.toContain("super-secret-token");
  });

  it("redacts URL credentials from local-server proof output", () => {
    const output = execFileSync(
      "node",
      ["scripts/local-server-proof.mjs", "--compose-dir", "does-not-exist", "--markdown"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_SERVER_URL: "http://local-user:local-pass@localhost:21025",
          SCREEPS_BRANCH: "agent-sandbox",
          SCREEPS_TOKEN: "super-secret-token",
        },
      },
    );

    expect(output).toContain("Server URL: http://localhost:21025");
    expect(output).not.toContain("local-user");
    expect(output).not.toContain("local-pass");
    expect(output).not.toContain("super-secret-token");
  });

  it("uses the local Compose env file when proof capture has one", () => {
    const output = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
          import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { buildComposeArgs } from "./scripts/local-server-proof.mjs";

          const dir = mkdtempSync(join(tmpdir(), "screeps-proof-"));
          try {
            const composeFile = join(dir, "docker-compose.yml");
            const envFile = join(dir, ".env");
            writeFileSync(composeFile, "services: {}\\n", "utf8");
            writeFileSync(envFile, "SCREEPS_LAUNCHER_HOST=127.0.0.1\\n", "utf8");
            console.log(JSON.stringify(buildComposeArgs({ composeFile, envFile, args: ["ps"] })));
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        `,
      ],
      { encoding: "utf8" },
    );

    const args = JSON.parse(output);
    expect(args).toContain("--env-file");
    expect(args.some((arg: string) => arg.endsWith(".env"))).toBe(true);
    expect(args).toEqual(expect.arrayContaining(["compose", "-f", "ps"]));
  });
});
