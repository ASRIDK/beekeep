# Hive

A local, split-pane app to run, watch and lead a hive of Claude agents ("bees"). It runs on your own Claude subscription login, on your own computer, for you only.

## Start

You need macOS, Node 24 (`nvm install 24`) and Claude Code, signed in with your subscription (`claude auth login`).

```sh
npm install      # once
bin/hive         # starts Hive if needed and opens its window
bin/hive app     # optional: builds a small Mac app into ~/Applications
bin/hive help    # every command
```

To type just `hive` anywhere, put a link or a small wrapper to `bin/hive` in a folder on your PATH, such as `~/.local/bin`.

After an update, run `bin/hive stop`, then `bin/hive`. Your data is brought forward by itself and a copy of the old file is kept next to it in `~/.hive`.

## Use

- **Bees.** Add workers, and a queen to lead them. Enter sends an order; "Stop and do now" (Command Enter) interrupts. Your orders always go first.
- **Queen.** Give her a goal. She proposes a plan; nothing starts before your yes. Hive runs the tasks in order, side by side where possible, keeps two tasks off the same file, and wakes her when the plan ends, a task fails or a bee asks. Plans stop at their limits.
- **Needs you.** Plans, questions, shell commands, web pages and anything outside a bee's folder. "Always allow" covers only that exact command, site or tool, and can be taken back under Edit.
- **Map and learning.** Links between bees get stronger when their messages and work help (her scores, your thumbs). This decides whom bees trust; it does not train Claude.
- **Spaces.** Vertical tabs, each with its own folder, panes, bees, branch, pull request, ports and latest notice.
- **Panes.** Bees, terminals, SSH, Claude Code, browser, plans, map, board, notices, usage, rules. Layout and terminals come back after a restart.
- **Claude Code panes** are the full Claude Code with your own setup, plus Hive's MCP tools. They ring when they need you and resume their conversation.
- **Notices** from bees, plans, Claude panes, `hive notify` and terminal programs (OSC 9, 99, 777), with a macOS alert when no window is in front.
- **Rules** give orders daily, regularly, or when a bee finishes.
- **Project commands** come from a `hive.json` in the space's folder: `{ "commands": [{ "name": "Dev server", "run": "npm run dev" }] }`. They ask for your yes first, and again whenever the file changes.
- **Usage guard.** Holds new work below 20% of the 5-hour window or 10% of the week (Usage pane). Needs `quota-axi`.

| Keys | |
| --- | --- |
| Command D, Shift D | Split right, down |
| Command K | Task a bee |
| Command P | Commands |
| Command 1 to 9, B | Go to space, show or hide spaces |
| Command T, Shift L | New terminal, new browser |
| Command I, Shift U | Notices, jump to newest |
| Command F, +, -, 0 | Find in terminal, text size |
| Option Command arrows | Move between panes |
| Command Shift ] and [ | Next and previous tab |

## What a bee may do

| | Look | Work | Full |
| --- | --- | --- | --- |
| Read and search its folder, search the web | yes | yes | yes |
| Open a web page, read outside its folder | asks | asks | asks |
| Create and edit files in its folder | no | yes | yes |
| Edit protected files or outside its folder | no | asks | asks |
| Run a shell command, even a read-only one | no | asks, if given | asks, if given |
| Helpers, to-do lists, skills, notebooks, questions | if given | if given | yes |
| Schedules, cloud sessions, background commands | no | no | no |

MCP servers, skills, the browser and the folder's own Claude setup are given per bee under Abilities. Each makes the bee heavier. An order from the queen never gives a bee more permission than it has.

**Shell.** Off for new bees; it roughly doubles what a worker costs (about 12,100 tokens to start instead of 7,700). When on, approved commands are confined by default: they can change only the bee's folder, cannot read your keys or Hive's own data, need a separate yes for each website, and cannot leave the sandbox. A bee you un-confine runs approved commands with your full rights.

**Own git copy.** A bee can work in a complete, separate copy under `~/hive-copies`, on its own branch. It cannot touch your repository. "Bring into my repository" (under Edit) adds its commits there as a branch; nothing of yours changes until you merge it. Hive never deletes copies. Do not run git inside a copy yourself: a bee may have changed its settings.

Orders from the command line and from other Claude sessions can never approve anything.

## Other Claude sessions

```sh
claude mcp add hive -- /full/path/to/bin/hive mcp
```

They can list bees, give orders, check on them, and use the board.

## How it is built

`server/` runs on Node without a build step; `web/` is the window; `mac/` is the Mac app.

```sh
npm test            # no Claude usage
npm run test:live   # live bee checks on Haiku, uses a little of your plan
node scripts/live-abilities.ts   # sandbox, git copy, skills, MCP, browser and more, live
node scripts/live-team.ts   # a live queen building a page, uses the most
npm run typecheck
```

`HIVE_HOME`, `HIVE_WORK`, `HIVE_PORT` and `HIVE_DIST` change where things live.
