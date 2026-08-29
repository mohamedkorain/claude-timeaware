import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "bin", "cli.mjs");
const HOOK = join(root, "src", "hook.mjs");

function freshHome() {
  return mkdtempSync(join(tmpdir(), "timeaware-test-"));
}

function run(home, args, { cwd } = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    cwd: cwd ?? home,
    encoding: "utf8",
  });
}

function settings(home) {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
}

function ourHooks(s, event) {
  return (s.hooks?.[event] ?? [])
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => h.command?.includes("claude-timeaware"));
}

test("init installs SessionStart hook and runtime", () => {
  const home = freshHome();
  run(home, ["init"]);
  const s = settings(home);
  assert.equal(ourHooks(s, "SessionStart").length, 1);
  assert.equal(ourHooks(s, "UserPromptSubmit").length, 0);
  assert.ok(existsSync(join(home, ".claude", "hooks", "claude-timeaware.mjs")));
});

test("init is idempotent and preserves other hooks", () => {
  const home = freshHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } })
  );
  run(home, ["init"]);
  run(home, ["init"]);
  const s = settings(home);
  assert.equal(ourHooks(s, "SessionStart").length, 1, "no duplicates after re-init");
  const all = s.hooks.SessionStart.flatMap((g) => g.hooks);
  assert.ok(all.some((h) => h.command === "echo mine"), "keeps other hooks");
});

test("bare init preserves an existing --refresh interval", () => {
  const home = freshHome();
  run(home, ["init", "--refresh", "30"]);
  run(home, ["init"]);
  const s = settings(home);
  const prompt = ourHooks(s, "UserPromptSubmit");
  assert.equal(prompt.length, 1);
  assert.match(prompt[0].command, / prompt 30$/);
});

test("--every installs a prompt hook with interval 0", () => {
  const home = freshHome();
  run(home, ["init", "--every"]);
  const s = settings(home);
  assert.match(ourHooks(s, "UserPromptSubmit")[0].command, / prompt 0$/);
});

test("--project writes portable $CLAUDE_PROJECT_DIR command and local runtime", () => {
  const home = freshHome();
  const proj = mkdtempSync(join(tmpdir(), "timeaware-proj-"));
  run(home, ["init", "--project"], { cwd: proj });
  const s = JSON.parse(readFileSync(join(proj, ".claude", "settings.json"), "utf8"));
  const cmd = ourHooks(s, "SessionStart")[0].command;
  assert.ok(cmd.includes("$CLAUDE_PROJECT_DIR"), `command is portable: ${cmd}`);
  assert.ok(!cmd.includes(home), "no absolute home path in committed settings");
  assert.ok(existsSync(join(proj, ".claude", "hooks", "claude-timeaware.mjs")), "runtime is project-local");
});

test("uninstall removes only our hooks", () => {
  const home = freshHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } })
  );
  run(home, ["init", "--refresh", "15"]);
  run(home, ["uninstall"]);
  const s = settings(home);
  assert.equal(ourHooks(s, "SessionStart").length, 0);
  assert.equal(s.hooks.UserPromptSubmit, undefined);
  assert.ok(s.hooks.SessionStart.flatMap((g) => g.hooks).some((h) => h.command === "echo mine"));
});

test("hook session mode prints a well-formed time line", () => {
  const out = execFileSync(process.execPath, [HOOK, "session"], { encoding: "utf8" });
  assert.match(out, /^\[claude-timeaware\] Current date\/time: \w+ \d{4}-\d{2}-\d{2}, \d{2}:\d{2} UTC[+-]\d{2}:\d{2} \(.+\)\./);
});

test("hook prompt mode with interval 0 always prints", () => {
  const out = execFileSync(process.execPath, [HOOK, "prompt", "0"], { encoding: "utf8", input: "{}" });
  assert.match(out, /Current date\/time/);
});

test("hook prompt mode with interval stays silent on first prompt", () => {
  const home = freshHome();
  const out = execFileSync(process.execPath, [HOOK, "prompt", "30"], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: "s1" }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(out, "");
});
