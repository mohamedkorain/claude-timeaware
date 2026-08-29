#!/usr/bin/env node
/**
 * claude-timeaware CLI
 *
 *   npx claude-timeaware init [--refresh <minutes>] [--project]
 *   npx claude-timeaware uninstall [--project]
 *   npx claude-timeaware status [--project]
 *
 * init:
 *   - copies the hook runtime to ~/.claude/hooks/claude-timeaware.mjs
 *     (or ./.claude/hooks/ with --project, referenced via $CLAUDE_PROJECT_DIR
 *     so the committed settings work on every teammate's machine)
 *   - merges SessionStart (+ optional UserPromptSubmit) hooks into
 *     ~/.claude/settings.json (or ./.claude/settings.json with --project)
 *   - idempotent: re-running replaces our entries, never duplicates them,
 *     and preserves an existing --refresh interval unless you change it
 *   - writes a .bak of settings.json before every change
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "claude-timeaware";
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE = join(__dirname, "..", "src", "hook.mjs");

// ---------- arg parsing ----------
const args = process.argv.slice(2);
const command = args[0];
const flags = {
  project: args.includes("--project"),
  every: args.includes("--every"),
  refresh: (() => {
    const i = args.indexOf("--refresh");
    if (i === -1) return null; // null = not given; may inherit an installed value
    const v = Number(args[i + 1]);
    if (!Number.isFinite(v) || v <= 0) fail("--refresh requires a positive number of minutes, e.g. --refresh 30");
    return v;
  })(),
};

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function settingsPath() {
  return flags.project
    ? join(process.cwd(), ".claude", "settings.json")
    : join(homedir(), ".claude", "settings.json");
}

// Where the hook runtime file is written on disk.
function hookDest() {
  return flags.project
    ? join(process.cwd(), ".claude", "hooks", "claude-timeaware.mjs")
    : join(homedir(), ".claude", "hooks", "claude-timeaware.mjs");
}

// How the hook command refers to the runtime. Project installs use
// $CLAUDE_PROJECT_DIR (set by Claude Code for every hook) instead of an
// absolute path, so committed settings work for the whole team.
function hookRef() {
  return flags.project ? `"$CLAUDE_PROJECT_DIR/.claude/hooks/claude-timeaware.mjs"` : `"${hookDest()}"`;
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${path} is not valid JSON (${e.message}). Fix it manually before running this tool.`);
  }
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const bak = `${path}.bak`;
    copyFileSync(path, bak);
    console.log(`  backup: ${bak}`);
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

/** Remove every hook entry of ours from one event array; drop empty groups. */
function stripOurs(eventArr) {
  if (!Array.isArray(eventArr)) return [];
  return eventArr
    .map((group) => ({
      ...group,
      hooks: (group.hooks || []).filter(
        (h) => !(h && typeof h.command === "string" && h.command.includes(MARKER))
      ),
    }))
    .filter((group) => (group.hooks || []).length > 0);
}

/** Find the interval of an already-installed prompt hook: 0 = --every, null = none. */
function installedRefresh(settings) {
  for (const group of settings.hooks?.UserPromptSubmit || []) {
    for (const h of group.hooks || []) {
      const m = typeof h?.command === "string" && h.command.includes(MARKER)
        ? h.command.match(/ prompt (\d+(?:\.\d+)?)\s*$/)
        : null;
      if (m) return Number(m[1]);
    }
  }
  return null;
}

function hookCommand(mode, refreshMin) {
  const base = `node ${hookRef()} ${mode}`;
  return mode === "prompt" ? `${base} ${refreshMin}` : base;
}

// ---------- commands ----------
function init() {
  // 1. install hook runtime
  mkdirSync(dirname(hookDest()), { recursive: true });
  copyFileSync(HOOK_SOURCE, hookDest());
  console.log(`hook runtime installed: ${hookDest()}`);

  // 2. merge settings
  const path = settingsPath();
  const settings = readSettings(path);
  settings.hooks = settings.hooks || {};

  if (flags.every && flags.refresh != null) fail("use either --every or --refresh, not both");

  // keep a previously configured prompt mode unless --every/--refresh was given
  const prevInterval = installedRefresh(settings);
  const interval = flags.every ? 0 : flags.refresh ?? prevInterval; // 0 = every prompt, null = none
  const kept = flags.every === false && flags.refresh == null && prevInterval != null;

  settings.hooks.SessionStart = [
    ...stripOurs(settings.hooks.SessionStart),
    { hooks: [{ type: "command", command: hookCommand("session"), timeout: 10 }] },
  ];

  settings.hooks.UserPromptSubmit = stripOurs(settings.hooks.UserPromptSubmit);
  if (interval != null) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: "command", command: hookCommand("prompt", interval), timeout: 10 }],
    });
  }
  if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;

  writeSettings(path, settings);
  console.log(`settings updated: ${path}`);
  console.log(`  SessionStart: date/time injected at every session start and resume`);
  if (interval === 0) {
    console.log(`  UserPromptSubmit: injected on every user message${kept ? " (kept from previous install)" : ""}`);
  } else if (interval != null) {
    console.log(`  UserPromptSubmit: re-injected every ${interval} min in long sessions${kept ? " (kept from previous install)" : ""}`);
  } else {
    console.log(`  (no prompt hook — add one with: claude-timeaware init --refresh 30, or --every for each message)`);
  }
  console.log(`\nDone. New Claude Code sessions will know the current date and time.`);
}

function uninstall() {
  const path = settingsPath();
  if (!existsSync(path)) {
    console.log(`nothing to do: ${path} does not exist`);
    return;
  }
  const settings = readSettings(path);
  if (settings.hooks) {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const cleaned = stripOurs(settings.hooks[event]);
      if (cleaned.length > 0) settings.hooks[event] = cleaned;
      else delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeSettings(path, settings);
  console.log(`removed ${MARKER} hooks from ${path}`);
  console.log(`(hook runtime left at ${hookDest()} — delete it manually if you want)`);
}

function status() {
  const path = settingsPath();
  const settings = readSettings(path);
  const events = ["SessionStart", "UserPromptSubmit"];
  let found = false;
  for (const event of events) {
    for (const group of settings.hooks?.[event] || []) {
      for (const h of group.hooks || []) {
        if (h?.command?.includes(MARKER)) {
          console.log(`${event}: ${h.command}`);
          found = true;
        }
      }
    }
  }
  if (!found) console.log(`not installed in ${path}`);
  console.log(`hook runtime ${existsSync(hookDest()) ? "present" : "MISSING"}: ${hookDest()}`);
}

// ---------- dispatch ----------
switch (command) {
  case "init":
    init();
    break;
  case "uninstall":
    uninstall();
    break;
  case "status":
    status();
    break;
  default:
    console.log(`claude-timeaware — make Claude Code aware of the current date and time

usage:
  claude-timeaware init [--refresh <minutes> | --every] [--project]
  claude-timeaware uninstall [--project]
  claude-timeaware status [--project]

flags:
  --refresh <min>  re-inject the time every <min> minutes during long sessions
  --every          re-inject the time on every user message
  --project        write to ./.claude/ instead of ~/.claude/ (commit it so your team gets it too)`);
    process.exit(command ? 1 : 0);
}
