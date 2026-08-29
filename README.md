# claude-timeaware

Keep Claude Code anchored to the current date **and time** — at session start, on every resume, and throughout long sessions.

## The problem

Resume a Claude Code conversation you left on Tuesday, and it often still acts like it's Tuesday. Ask it something time-of-day dependent, and it has no idea whether it's 9 am or 6 pm.

Doesn't Claude Code already know the date? Partly — it injects today's date **once, at the top of the context**. But:

- **It never includes the clock time or timezone.** Anything involving "this morning", business hours, timestamps, or "how long did this take" is guesswork.
- **Models anchor on what's nearby.** In a resumed or days-long conversation, the context is full of the old day's dates — and a single line buried thousands of tokens up loses to all of it.

Existing fixes are MCP servers exposing a `get_current_time` *tool* — but Claude doesn't know it doesn't know the time, so it rarely calls the tool. This package takes the other approach: **unconditional injection via hooks**, placed where the model is actually looking — right next to your latest message. No MCP server, no tool schemas in context, no dependencies.

## Install

```bash
npx claude-timeaware init
```

That's it. Every new Claude Code session — including **resumes** — now starts with:

```
[claude-timeaware] Current date/time: Thursday 2026-08-27, 14:32 UTC+04:00 (Asia/Dubai). Trust this over any date you assume from training data or earlier in this conversation.
```

### Long sessions

Sessions can run for hours, so the session-start timestamp goes stale. Two options:

```bash
npx claude-timeaware init --refresh 30   # re-inject at most every 30 minutes
npx claude-timeaware init --every        # re-inject on every user message
```

`--refresh` keeps the transcript tidy; `--every` guarantees the model always has the current minute next to your prompt. Either way it's one short line (~30 tokens), so the context cost is negligible.

### Project-scoped install

```bash
npx claude-timeaware init --project
```

Writes to `./.claude/` instead of `~/.claude/`, with the hook runtime stored inside the project and referenced via `$CLAUDE_PROJECT_DIR` — so you can commit it and it works on every teammate's machine, no absolute paths.

## Where does the time show up?

The line is injected into **Claude's context** — the model reads it and reasons with it. It isn't a clock widget in the terminal UI; you can see the injected lines in transcript view (**Ctrl+O**). If you also want a visible clock in your terminal, pair this with Claude Code's [statusline](https://docs.claude.com/en/docs/claude-code/statusline) — that one is for your eyes, this one is for the model's.

## How it works

- `init` copies a small zero-dependency Node script to `~/.claude/hooks/claude-timeaware.mjs` (or `./.claude/hooks/` with `--project`) and merges hook entries into your Claude Code settings:
  - **SessionStart** → prints the date/time line; Claude Code adds hook stdout to context. Fires on new sessions *and* resumes — exactly when staleness bites.
  - **UserPromptSubmit** (with `--refresh`/`--every`) → prints the line on your cadence, tracked per `session_id` so throttled mode never spams.
- Merging is **idempotent**: re-running replaces our entries, never duplicates them, keeps your other hooks untouched, and preserves your configured refresh mode unless you change it.
- **Safe**: a `.bak` of `settings.json` is written before every change; the hook exits 0 on any error so it can never block your session.

## Commands

```
claude-timeaware init [--refresh <minutes> | --every] [--project]   install / update hooks
claude-timeaware uninstall [--project]                              remove our hooks, leave everything else
claude-timeaware status [--project]                                 show what's installed
```

## Why not an MCP server?

| | MCP time server | claude-timeaware |
|---|---|---|
| Claude must decide to call it | ✅ (and usually doesn't) | ❌ injected unconditionally |
| Tool schema tokens in every request | yes | no |
| Extra process per session | yes | no (runs for ~50 ms at session start) |
| Helps resumed / long sessions | no | SessionStart fires on resume; `--refresh` / `--every` |

## Requirements

- Node.js ≥ 18 (already required by Claude Code)
- Works on macOS, Linux, and Windows

## License

MIT
