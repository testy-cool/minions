# minion

Small AI agents that each live in their own folder. Each one has its own
instructions, memory, skills, MCP servers and chat history, and nothing
leaks between them. They run on [Pi](https://github.com/earendil-works/pi),
or on Claude Code.

Write-up with screenshots: https://testy.cool/blog/lab-notes/minions-agents-in-their-own-folder

## A minion is a folder

```
agents/researcher/
  AGENTS.md    who it is and what it does
  memory/      what it remembers about you and its job
  skills/      its skills, linked from the skills on this machine
  mcp.json     its MCP servers (Pi minions)
  sessions/    every chat, with a list it can search (Pi minions)
```

New minions start as a copy of `agents/default`.

## Commands

```
minion init                  create an agent, asking questions
minion new <name> "<role>"   create an agent without questions
minion new <name> "<role>" --claude
                             the same, running on Claude Code
minion ls                    list agents
minion model <name>          pick its model and thinking level
minion skills <name>         pick its skills (tab to toggle)
minion mcp <name>            pick its MCP servers (tab to toggle)
minion face <name> [photo]   draw its portrait
minion <name>                start a new chat
minion <name> -p "<msg>"     one message, print the reply
minion <name> -c             continue the last chat
minion <name> @N             continue chat number N
```

`minion` with no arguments prints the full list.

## Setup

1. Install [Pi](https://github.com/earendil-works/pi), `fzf` and `python3`.
2. Install the Pi packages it loads:
   ```
   pi install npm:pi-hermes-memory
   pi install npm:pi-mcporter
   pi install npm:@tintinweb/pi-subagents
   ```
3. Clone the portraits into `vendor/`:
   ```
   git clone https://github.com/testy-cool/pi-agent-portrait vendor/pi-agent-portrait
   ```
4. Put `bin/minion` on your `PATH`. Agents live in `agents/` next to `bin/`,
   or in `$MINIONS_HOME`.

`minion face` draws with the Codex CLI when it is installed. Otherwise it
uses Azure OpenAI: set `AZURE_IMAGE_ENDPOINT`, `AZURE_IMAGE_KEY` and
`AZURE_IMAGE_MODEL`, in the environment or in `~/.config/minion/env`.

## Claude Code mods

Claude Code minions load `claude-mods/minion-avatar`. It plays the minion's
portrait above the prompt and shows what the agent is doing right now. The
activity part is ported from
[What's Agent Doing](https://github.com/tzafrir/whats-agent-doing) by Tzafrir
Rehan (MIT, license kept beside it).

`claude-mods/side` is a side pane that lists the agent's doubts when asked,
and keeps private notes that never reach the agent.

## License

MIT
