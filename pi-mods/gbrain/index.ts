// Gives a Pi minion its own GBrain, the way `gbrain setup claude-code` does
// for a Claude Code minion. GBrain has no Pi support of its own yet (its Pi
// pull request, garrytan/gbrain#6319, is unmerged), so this does three jobs:
//
//   - runs the minion's brain as an MCP server for the whole chat, through
//     Pi's built-in MCP support, so its memory tools are there;
//   - before each prompt, asks that server for what the brain knows about
//     the prompt (`gbrain hook user-prompt`) and adds it as a hidden message;
//   - when a chat ends, imports it into the brain with its facts. Pi writes
//     chats in OpenClaw's format, because OpenClaw is built on Pi, so
//     GBrain's OpenClaw reader takes them as they are.
//
// It does nothing in a minion without a brain: the brain is $GBRAIN_HOME,
// or gbrain/ in the minion's folder, which the launcher makes the working
// folder. Every step fails open, so a broken brain never stops Pi.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const RECALL_TIMEOUT_MS = 3000;
const DIGEST_TIMEOUT_MS = 5000;
// The server starts with the chat, but the first prompt can come first.
const FIRST_PROMPT_WAIT_MS = 10000;
const MAX_CONTEXT_CHARS = 20000;

function gbrainBin(): string {
	if (process.env.GBRAIN_BIN) return process.env.GBRAIN_BIN;
	const bun = join(homedir(), ".bun/bin/gbrain");
	return existsSync(bun) ? bun : "gbrain";
}

// Runs `gbrain hook <name>` with a hook payload on stdin and returns stdout,
// or "" on any failure or timeout.
function runHook(bin: string, env: NodeJS.ProcessEnv, name: string, payload: object, timeoutMs: number): Promise<string> {
	return new Promise((resolve) => {
		let out = "";
		let done = false;
		const finish = () => {
			if (!done) {
				done = true;
				resolve(out);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, ["hook", name], { env, stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			return finish();
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			out = "";
			finish();
		}, timeoutMs);
		child.stdout?.on("data", (d) => (out += d.toString()));
		child.on("error", () => {
			clearTimeout(timer);
			out = "";
			finish();
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) out = "";
			finish();
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(payload));
	});
}

// The user-prompt hook prints one JSON object with the context to add.
function contextOf(stdout: string): string {
	for (const line of stdout.split("\n").reverse()) {
		if (!line.trim().startsWith("{")) continue;
		try {
			const text = JSON.parse(line)?.hookSpecificOutput?.additionalContext;
			return typeof text === "string" ? text.trim() : "";
		} catch {}
	}
	return "";
}

// True when the last recall failed only because the brain's server was not
// up yet. GBrain records each hook's outcome in this file.
function serverNotUp(home: string): boolean {
	try {
		const lines = readFileSync(join(home, ".gbrain/integrations/hooks/heartbeat.jsonl"), "utf8").trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1]);
		// no_serve: the server has not written its secret yet;
		// ipc_unavailable: it has, but is not answering yet.
		return last.event === "user-prompt" && (last.reason === "no_serve" || last.reason === "ipc_unavailable");
	} catch {
		return false;
	}
}

export default function (pi: any) {
	if (process.env.GBRAIN_HOOKS === "0") return;
	const dir = process.cwd();
	const home = process.env.GBRAIN_HOME || join(dir, "gbrain");
	if (!existsSync(join(home, ".gbrain"))) return;

	const bin = gbrainBin();
	const brainEnv = { GBRAIN_HOME: home, GBRAIN_SOURCE: "default" };
	const env = { ...process.env, ...brainEnv };
	const name = basename(dir);

	// Kimchi loads Pi extensions too, but may not have Pi's MCP support.
	try {
		pi.registerMcpServer(`gbrain-${name}`, {
			command: bin,
			args: ["serve", "--surface", "full"],
			env: { PATH: process.env.PATH ?? "", HOME: homedir(), ...brainEnv },
			description: `${name}'s long-term memory (GBrain): recall what you know, search notes and past chats, and remember new facts.`,
			// The full surface has well over a hundred tools. The everyday
			// ones are always declared; the rest are found with tool_search.
			exposure: "deferred",
			toolExposure: { recall: "direct", search: "direct", query: "direct", get_page: "direct", remember: "direct" },
		});
	} catch {}

	let digest: Promise<string> | null = null;
	let firstPrompt = true;

	pi.on("session_start", async (_event: any, ctx: any) => {
		// Not awaited, so startup never waits; it rides the first prompt.
		digest = runHook(bin, env, "session-start", { hook_event_name: "SessionStart", cwd: dir, source: "startup" }, DIGEST_TIMEOUT_MS);
		firstPrompt = true;
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		if (event?.messageType && event.messageType !== "user") return;
		const parts: string[] = [];
		if (digest) {
			const d = (await digest).trim();
			digest = null;
			if (d) parts.push(d);
		}
		// No transcript_path: this GBrain only reads Claude Code and Codex
		// chat files there, and recall works from the prompt alone.
		const payload = {
			hook_event_name: "UserPromptSubmit",
			session_id: ctx.sessionManager?.getSessionId?.(),
			cwd: dir,
			prompt: typeof event?.prompt === "string" ? event.prompt : "",
		};
		let context = contextOf(await runHook(bin, env, "user-prompt", payload, RECALL_TIMEOUT_MS));
		const deadline = Date.now() + FIRST_PROMPT_WAIT_MS;
		while (!context && firstPrompt && serverNotUp(home) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1000));
			context = contextOf(await runHook(bin, env, "user-prompt", payload, RECALL_TIMEOUT_MS));
		}
		firstPrompt = false;
		if (context) parts.push(context);
		const content = parts.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
		if (!content) return;
		return { message: { customType: "gbrain-context", content, display: false } };
	});

	pi.on("session_shutdown", async (event: any, ctx: any) => {
		// Only on quit. On /new, /resume or /fork Pi keeps running and its
		// brain server keeps the brain locked, so the import would fail;
		// that chat is caught at the next quit instead.
		if (event?.reason !== "quit") return;
		const sessions = ctx.sessionManager?.getSessionDir?.();
		if (typeof sessions !== "string" || !existsSync(sessions)) return;
		// Every chat touched in the last week, which also catches chats from
		// runs that crashed. Re-importing an unchanged chat is free; a chat
		// that changed is imported again and its facts are replaced.
		// Detached, so Pi exits without waiting; it starts once the brain
		// server has let go of the brain.
		const log = join(home, "capture.log");
		const script = [
			'sleep 2; echo "== $(date -Is) quit" >> "$3"',
			'files=$(find "$2" -maxdepth 1 -name "*.jsonl" -mtime -7)',
			'[ -n "$files" ] && "$1" transcripts ingest $files --format openclaw --facts >> "$3" 2>&1',
		].join("; ");
		try {
			const child = spawn("sh", ["-c", script, "sh", bin, sessions, log], { env, stdio: "ignore", detached: true });
			child.on("error", () => {});
			child.unref();
		} catch {}
	});
}
