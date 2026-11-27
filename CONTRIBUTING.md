# Contributing to beekeep

Thanks for wanting to help. beekeep is young, so there is plenty to do, and small pull requests are very welcome. Issues marked [good first issue](https://github.com/ASRIDK/beekeep/labels/good%20first%20issue) are a good place to start; [help wanted](https://github.com/ASRIDK/beekeep/labels/help%20wanted) ones are bigger.

Not sure where to start, or want to check an idea first? Open a [discussion](https://github.com/ASRIDK/beekeep/discussions) or comment on an issue.

## Set up (about five minutes)

You need Node 24 and git. Claude Code or Codex are only needed to try bees for real; the tests never call them.

```sh
git clone https://github.com/ASRIDK/beekeep && cd beekeep
npm install
npm test                        # about 180 tests, no AI involved
node scripts/screen-check.ts    # drives the terminal screen in a hidden terminal
bin/beekeep                     # the real thing, with your own Claude Code or Codex
```

Run your own beekeep without touching anyone else's: `BEEKEEP_HOME=/tmp/bk BEEKEEP_PORT=3199 bin/beekeep`.

## How it fits together

| Folder | What lives there |
| --- | --- |
| `server/hive.ts` | the bees: their orders, queue, approvals and history |
| `server/team.ts` | the queen's plans, tasks, messages between bees, learning links |
| `server/policy.ts` | what a bee may do without asking; read this before touching anything about permissions |
| `server/driver.ts` | Claude Code bees, through the Claude Agent SDK |
| `server/codex.ts` | Codex bees, through `codex app-server` |
| `server/http.ts`, `server/rpc.ts` | the local server and every request it accepts |
| `tui/` | the terminal screen (Ink, written without JSX so Node runs it directly) |
| `web/` | the browser window (React) |
| `test/` | tests; `test/fake-codex.mjs` stands in for Codex |

The server owns everything. The terminal screen and the window are views over one socket, so closing them never stops a bee.

## Add your agent

Want bees on Gemini CLI, OpenCode, Aider or anything else? This is the most useful kind of contribution, and it is self-contained.

1. Write `server/<agent>.ts` exporting a starter: `(bee, hooks) => Promise<Driver>`. A `Driver` has `send(text, told)`, `interrupt()` and `close()` (see `server/driver.ts`).
2. Turn the agent's events into the messages beekeep already understands, the same ones the Claude Agent SDK sends: text as `{ type: 'assistant', message: { content: [{ type: 'text', text }] } }`, a tool call as a `tool_use` block, its outcome as a `tool_result`, and the end of a turn as `{ type: 'result', ... }`. `server/codex.ts` does exactly this; copy its shape.
3. Every action that could reach beyond the bee's folder must pass `hooks.judge(tool, input)`, and when that says `ask`, `hooks.ask(...)`. Name tools as Claude Code does (`Bash`, `Write`, `WebFetch`, ...), so the existing rules apply unchanged.
4. Start the agent with a clean setup (none of the person's own hooks, plugins or saved approvals) and never handle its login: let the agent's own CLI log in.
5. Add a stand-in for the agent's protocol in `test/` and tests like `test/codex.test.ts`, then add the agent to `AGENTS` in `server/types.ts` and pick it in `server/main.ts`.

## Rules that keep people safe

beekeep runs AI agents on people's computers, so a few things are not up for trade:

- A bee never approves its own actions, and nothing reachable by a bee, a web page, the command line or MCP can approve, change a bee, or start a plan. Only the person, from the screen or the window.
- Orders never widen what a bee may do. "Always allow" stays narrow: one exact command, one site, one tool.
- beekeep never handles a Claude, OpenAI or other login, and never shares one person's plan with others.
- Text from bees, files and web pages is shown as text only (see `plain()` in `tui/format.ts`).

If a change touches `policy.ts`, `http.ts`, `rpc.ts`, `api.ts` or a driver's approval handling, say so in the pull request and add a test that fails without it.

## Pull requests

- Keep each one about one thing. Draft pull requests are welcome for early feedback.
- `npx tsc --noEmit` and `npm test` must pass; CI runs them on macOS and Linux with Node 22 and 24.
- Write commit messages and user-facing text in plain English, as if explaining to a colleague.
- New behaviour needs a test. A bug fix needs a test that failed before the fix.

## Reporting problems

Bugs and ideas: [open an issue](https://github.com/ASRIDK/beekeep/issues/new/choose). Security problems: please report them privately, as described in [SECURITY.md](SECURITY.md).

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
