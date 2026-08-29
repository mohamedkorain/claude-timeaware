#!/usr/bin/env node
/**
 * claude-timeaware hook runtime.
 * Installed by `npx claude-timeaware init` to ~/.claude/hooks/ (or the
 * project's .claude/hooks/ with --project).
 *
 * Modes:
 *   session               -> always print the current date/time line (SessionStart)
 *   prompt 0              -> print the line on EVERY user prompt (--every)
 *   prompt <refreshMin>   -> print the line only if >= refreshMin minutes have
 *                            passed since the last injection for this session
 *                            (UserPromptSubmit; keeps long sessions fresh
 *                            without a line on every message)
 *
 * stdout on exit 0 is injected into Claude's context for both events.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const MODE = process.argv[2] || "session";
const REFRESH_MIN = Math.max(0, Number(process.argv[3]) || 0);
const STATE_FILE = join(homedir(), ".claude", "hooks", ".claude-timeaware-state.json");
const STATE_TTL_MS = 24 * 60 * 60 * 1000; // prune session entries older than 24h

function timeLine() {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `[claude-timeaware] Current date/time: ${weekday} ${date}, ${time} ${offset} (${tz}). Trust this over any date you assume from training data or earlier in this conversation.`;
}

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = readFileSync(0, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    /* state is best-effort; never fail the hook over it */
  }
}

function main() {
  if (MODE === "session") {
    console.log(timeLine());
    return;
  }

  if (MODE === "prompt") {
    // interval 0 = --every: inject on each user prompt, no state needed
    if (REFRESH_MIN === 0) {
      console.log(timeLine());
      return;
    }

    const input = readStdinJson();
    const sessionId = input.session_id || "default";
    const now = Date.now();
    const state = loadState();

    // prune stale sessions
    for (const [k, v] of Object.entries(state)) {
      if (typeof v !== "number" || now - v > STATE_TTL_MS) delete state[k];
    }

    const last = state[sessionId] || 0;
    const intervalMs = REFRESH_MIN * 60 * 1000;

    if (last === 0) {
      // first prompt of a session we haven't seen: record baseline silently
      // (SessionStart already injected the time)
      state[sessionId] = now;
      saveState(state);
    } else if (now - last >= intervalMs) {
      console.log(timeLine());
      state[sessionId] = now;
      saveState(state);
    }
    return;
  }

  // unknown mode: do nothing, exit 0 so we never block Claude Code
}

try {
  main();
} catch {
  process.exit(0);
}
