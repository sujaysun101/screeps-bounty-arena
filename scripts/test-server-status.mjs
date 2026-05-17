#!/usr/bin/env node

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { runOfflineSimulation, formatMarkdownReport } from "./simulate.mjs";
import { redactPrivateServerText, stripUrlUserInfo } from "./redact-url.mjs";

const DEFAULT_SERVER_URL = "http://127.0.0.1:21025";
const DEFAULT_BRANCH = "sandbox";
const DEFAULT_TIMEOUT_MS = 1500;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      ticks: { type: "string", short: "t", default: "1000" },
      seed: { type: "string", default: "private-test-server" },
      markdown: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
    },
  });

  const ticks = parsePositiveInteger(values.ticks, "--ticks");
  const timeoutMs = parsePositiveInteger(values["timeout-ms"], "--timeout-ms");

  const simulation = runOfflineSimulation({
    ticks,
    seed: values.seed,
    spawnConfig: "balanced",
  });

  const status = await readServerStatus(readStatusConfig(process.env, timeoutMs), simulation);
  printStatus(status, values);
}

export function readStatusConfig(env, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const serverUrl = env.SCREEPS_SERVER_URL || DEFAULT_SERVER_URL;
  const branch = env.SCREEPS_BRANCH || DEFAULT_BRANCH;
  const username = env.SCREEPS_USERNAME || "local-test-user";
  const token = env.SCREEPS_TOKEN || "";

  return {
    env,
    serverUrl,
    safeServerUrl: redactForReport(serverUrl, env),
    branch,
    username,
    room: env.SCREEPS_ROOM || "",
    hasToken: Boolean(token),
    token,
    timeoutMs,
  };
}

export async function readServerStatus(config, simulation, fetchImpl = fetch) {
  const base = normalizeBaseUrl(config.serverUrl);
  const status = {
    environment: "private/test-server status",
    serverUrl: config.safeServerUrl,
    branch: config.branch,
    user: config.username,
    tokenConfigured: config.hasToken,
    reachable: false,
    tick: null,
    rcl: null,
    probes: [],
    fallback: null,
    simulation,
  };

  if (!base.ok) {
    status.fallback = `invalid SCREEPS_SERVER_URL: ${redactForReport(base.error, config.env)}`;
    return status;
  }

  const headers = buildHeaders(config);
  const probes = [
    { name: "version", path: "/api/version", auth: false },
    { name: "time", path: "/api/game/time", auth: false },
    { name: "me", path: "/api/auth/me", auth: true },
    { name: "branches", path: "/api/user/branches", auth: true },
  ];

  if (config.room) {
    probes.push({
      name: "room",
      path: `/api/game/room-status?room=${encodeURIComponent(config.room)}`,
      auth: true,
    });
  }

  for (const probe of probes) {
    if (probe.auth && !config.hasToken) {
      status.probes.push({ name: probe.name, ok: false, skipped: true, reason: "token not configured" });
      continue;
    }

    const result = await probeJson(fetchImpl, `${base.url}${probe.path}`, {
      headers: probe.auth ? headers : {},
      timeoutMs: config.timeoutMs,
      env: config.env,
    });

    status.probes.push({ name: probe.name, ...result.summary });

    if (result.ok) {
      status.reachable = true;
      mergeStatusData(status, probe.name, result.data);
    }
  }

  if (!status.reachable) {
    status.fallback = "server/API unavailable; showing deterministic offline simulation smoke data";
  }

  return status;
}

export function printStatus(status, values) {
  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (values.markdown) {
    console.log(formatMarkdownReport(status.simulation));
    return;
  }

  console.log("Screeps private/test-server status");
  console.log(`server: ${status.serverUrl}`);
  console.log(`reachable: ${status.reachable ? "yes" : "no"}`);
  console.log(`branch: ${status.branch}`);
  console.log(`user: ${status.user}`);
  console.log(`token configured: ${status.tokenConfigured ? "yes (redacted)" : "no"}`);
  console.log(`tick: ${status.tick ?? "unavailable"}`);
  console.log(`RCL: ${status.rcl ?? "unavailable"}`);
  for (const probe of status.probes) {
    const detail = probe.skipped ? `skipped (${probe.reason})` : probe.ok ? "ok" : `failed (${probe.error})`;
    console.log(`probe ${probe.name}: ${detail}`);
  }
  if (status.fallback) {
    console.log(`fallback: ${status.fallback}`);
  }
  console.log(`offline ticks: ${status.simulation.ticks}`);
  console.log(`offline ok: ${status.simulation.ok}`);
  console.log(`offline final RCL: ${status.simulation.final.rcl}`);
  console.log(`offline creeps: ${status.simulation.final.creeps}`);
  console.log(`offline failures: ${status.simulation.failures.length}`);
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function normalizeBaseUrl(serverUrl) {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "must start with http:// or https://" };
    }
    url.username = "";
    url.password = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return { ok: true, url: stripUrlUserInfo(url.toString()) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function buildHeaders(config) {
  return {
    "X-Token": config.token,
    "X-Username": config.username,
  };
}

async function probeJson(fetchImpl, url, { headers, timeoutMs, env }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const text = redactForReport(await response.text(), env);
    const data = parseJson(text);
    return {
      ok: response.ok,
      data,
      summary: response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status, error: text || response.statusText || `HTTP ${response.status}` },
    };
  } catch (error) {
    const rawError = error?.message || error?.name || String(error || "fetch failed");
    return {
      ok: false,
      data: null,
      summary: { ok: false, error: redactForReport(rawError, env) || "fetch failed" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function redactForReport(value, env) {
  return redactPrivateServerText(value, env, { redactKnownTokenPatterns: true });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mergeStatusData(status, probeName, data) {
  if (!data || typeof data !== "object") return;

  if (probeName === "time") {
    status.tick = firstNumber(
      data.time,
      data.tick,
      data.gameTime,
      typeof data.result === "number" ? data.result : null,
    );
  }

  if (probeName === "me") {
    status.user = firstString(data.username, data.user?.username, status.user);
  }

  if (probeName === "branches") {
    const branchNames = extractBranchNames(data);
    if (branchNames.length > 0) {
      status.branchAvailable = branchNames.includes(status.branch);
    }
  }

  if (probeName === "room") {
    status.rcl = firstNumber(
      data.rcl,
      data.controller?.level,
      data.room?.controller?.level,
      data.objects?.controller?.level,
    );
  }
}

function extractBranchNames(data) {
  const branches = Array.isArray(data.branches)
    ? data.branches
    : Array.isArray(data.list)
      ? data.list
      : Array.isArray(data)
        ? data
        : [];

  return branches
    .map((branch) => (typeof branch === "string" ? branch : branch?.branch || branch?.name))
    .filter((branch) => typeof branch === "string" && branch.trim() !== "");
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
