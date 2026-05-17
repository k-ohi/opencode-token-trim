import type { Plugin } from "@opencode-ai/plugin";
import { executeInterceptCommand } from "./intercept/command";
import { INTERCEPT_COMMAND_NAME } from "./intercept/constants";
import { installInterceptFetch } from "./intercept/fetch";
import { cleanupExpiredInterceptArtifacts } from "./intercept/retention";
import { recordInterceptAnomaly, refreshActiveInterceptSession } from "./intercept/state";

const HANDLED_SENTINEL = "__OPENCODE_INTERCEPTOR_COMMAND_HANDLED__";

type NotificationRequest = {
    path: { id: string };
    body: {
        noReply: true;
        agent?: string;
        model?: {
            providerID: string;
            modelID: string;
        };
        variant?: string;
        parts: Array<{
            type: "text";
            text: string;
            ignored: true;
        }>;
    };
};

type PluginSessionClient = {
    prompt?: (input: NotificationRequest) => Promise<unknown> | unknown;
    promptAsync?: (input: NotificationRequest) => Promise<unknown>;
};

type LiveNotificationParams = {
    agent?: string;
    variant?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
};

const liveNotificationParamsBySession = new Map<string, LiveNotificationParams>();

type ChatMessageInput = Parameters<NonNullable<Awaited<ReturnType<Plugin>>["chat.message"]>>[0];
type ChatParamsInput = Parameters<NonNullable<Awaited<ReturnType<Plugin>>["chat.params"]>>[0];

function extractLiveNotificationParams(input: {
    agent?: string;
    variant?: string;
    model?: { providerID?: string; modelID?: string };
}): LiveNotificationParams {
    return {
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.model?.providerID && input.model.modelID
            ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } }
            : {}),
    };
}

function rememberLiveNotificationParams(
    sessionId: string | undefined,
    input: ChatMessageInput | ChatParamsInput,
): void {
    if (!sessionId) {
        return;
    }

    const next = {
        ...(liveNotificationParamsBySession.get(sessionId) ?? {}),
        ...extractLiveNotificationParams(input),
    };

    liveNotificationParamsBySession.set(sessionId, next);
}

async function sendIgnoredMessage(
    ctx: Parameters<Plugin>[0],
    sessionId: string,
    text: string,
    params: LiveNotificationParams = {},
) {
    const session = ctx.client.session as PluginSessionClient | undefined;
    const request: NotificationRequest = {
        path: { id: sessionId },
        body: {
            noReply: true,
            ...params,
            parts: [{ type: "text", text, ignored: true }],
        },
    };

    if (typeof session?.prompt === "function") {
        await Promise.resolve(session.prompt(request));
        return;
    }

    if (typeof session?.promptAsync === "function") {
        await session.promptAsync(request);
        return;
    }

    throw new Error("OpenCode session prompt API is unavailable for ignored replies.");
}

function syncActiveSession(sessionId?: string | null): void {
    refreshActiveInterceptSession(sessionId);
}

function throwHandledSentinel(): never {
    throw new Error(`${HANDLED_SENTINEL}:${INTERCEPT_COMMAND_NAME}`);
}

function safeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const plugin: Plugin = async (ctx) => {
    cleanupExpiredInterceptArtifacts()
        .then((cleanup) => {
            for (const warning of cleanup.warnings) {
                recordInterceptAnomaly({
                    scope: "cleanup",
                    phase: warning.phase,
                    message: warning.message,
                });
            }
        })
        .catch((error) => {
            recordInterceptAnomaly({
                scope: "cleanup",
                phase: "startup",
                message: `Unexpected cleanup failure: ${safeErrorMessage(error)}`,
            });
        });

    installInterceptFetch();

    return {
        config: async (config) => {
            config.command = {
                ...(config.command ?? {}),
                [INTERCEPT_COMMAND_NAME]: {
                    template: INTERCEPT_COMMAND_NAME,
                    description:
                        "Show interception status or toggle the local HTTP interception scaffold.",
                },
            };
        },
        "chat.message": async (input) => {
            syncActiveSession(input.sessionID);
            rememberLiveNotificationParams(input.sessionID, input);
        },
        "chat.params": async (input) => {
            syncActiveSession(input.sessionID);
            rememberLiveNotificationParams(input.sessionID, input);
        },
        "command.execute.before": async (input) => {
            if (input.command !== INTERCEPT_COMMAND_NAME) {
                return;
            }

            syncActiveSession(input.sessionID);
            await sendIgnoredMessage(
                ctx,
                input.sessionID,
                executeInterceptCommand({
                    argumentsText: input.arguments,
                    sessionId: input.sessionID,
                }),
                liveNotificationParamsBySession.get(input.sessionID) ?? {},
            );
            throwHandledSentinel();
        },
        "tool.definition": async (input, output) => {
            if (input.toolID === "bash") {
                output.description = `Executes a Windows PowerShell (5.1) command. OS: win32, Shell: powershell.
Use \`workdir\` param to run in different directory; do NOT cd inside commands.
Use the system temp directory for scratch work outside the workspace (e.g. /tmp or AppData/Local/Temp) + "/opencode" that already exists and is pre-approved for external directory access.

IMPORTANT: This tool is for terminal ops (git, npm, docker). NOT for file ops.
Use the specialized tools instead:
  File search → glob (NOT Get-ChildItem)
  Content search → grep (NOT Select-String)
  File reading → read
  File editing → edit
  File writing → write
  Communication → output text (NOT Write-Output/Write-Host)

# PowerShell notes
- Chain: \`cmd1; if ($?) { cmd2 }\`
- Double quotes for interpolated, single for verbatim strings
- Use full cmdlet names (Get-ChildItem, Set-Content, Remove-Item, New-Item)
- Native exe with spaces: use \`& "path\\to\\exe" args\`
- Escape special chars with backtick

# Execution
- Verify parent dirs exist via Test-Path before creating in them
- Always quote paths with spaces
- Batch independent commands in parallel calls
- Do NOT use && (not supported), do NOT cd inside commands

# Output
- Command arg required. Timeout defaults to 120s. Truncated at 2000 lines / 50KB output

# Git (only when asked)
- Safety: never --force, --amend (unless 3 conditions met), -i, skip hooks, or commit secrets
- To commit: inspect status/diff/log parallelly, draft msg, stage + commit + verify
- For PR: inspect status/diff/log/remote, analyze commits, push + gh pr create
- Return PR URL when done`;
            }

            if (input.toolID === "todowrite") {
                output.description = `Create/manage task list to track progress on multi-step work.

## When to use
3+ distinct steps, non-trivial work, user provides multiple tasks, or new instructions arrive.

## When NOT to use
Single straightforward task, informational requests, <3 trivial steps.

## States
pending -> in_progress (max 1) -> completed | cancelled

## Rules
- Update in real time; don't batch completions
- Keep exactly one in_progress at a time
- Mark completed only after work + verification done`;
            }

            if (input.toolID === "task") {
                output.description = `Launch subagent to handle complex multi-step tasks.

Use for: executing slash commands. Specify subagent_type to pick agent type.
Do NOT use for: simple file reads, single-target searches, or trivial tasks.

Usage:
1. Launch multiple agents in parallel when tasks are independent
2. Agent result is not visible to user — summarize it back
3. Provide detailed autonomous prompts; specify code vs research clearly
4. Reuse task_id to resume a prior subagent session`;
            }

            if (input.toolID === "skill") {
                output.description = `Load a specialized skill when the task at hand matches one listed in the system prompt. Inject skill instructions and resources into current conversation.`;
            }

            if (input.toolID === "edit") {
                output.description = `Performs exact string replacements in files.

Usage:
- Must use Read tool at least once before editing — tool errors otherwise
- Preserve exact indentation from source (tabs/spaces after line number prefix)
- Prefer editing existing files; don't write new files unless essential
- No emojis in files unless user asks
- FAILS if oldString not found or found multiple times — use replaceAll for global renames`;
            }

            if (input.toolID === "read") {
                output.description = `Read a file or directory from the local filesystem. Supports images and PDFs.

Usage:
- filePath must be absolute. Returns up to 2000 lines by default.
- Offset is 1-indexed. Line format: "<line>: <content>"
- Read larger windows instead of tiny repeated slices
- Parallel reads when you know multiple files exist`;
            }

            if (input.toolID === "glob") {
                output.description = `Fast file pattern matching. Supports globs like "**/*.js". Returns paths sorted by mtime.

Batch multiple independent searches in a single response for efficiency.
For open-ended or multi-round searches, prefer a semantic search tool or the Task tool.`;
            }

            if (input.toolID === "grep") {
                output.description = `Fast content search via regex across any codebase size.

Supports full regex + include filter (e.g. "*.ts"). Returns file paths & line numbers.
Batch multiple independent searches in a single response for efficiency.
For counting matches use rg directly via bash. For open-ended or multi-round searches, prefer a semantic search tool or the Task tool.`;
            }

            if (input.toolID === "question") {
                output.description = `Ask the user questions during execution.

Use for: preferences, clarifications, implementation choices, or offering options.
- Custom "Type your own answer" auto-added; answers as label arrays
- Set multiple: true for multi-select
- Put recommended option first, append "(Recommended)"`;
            }

            if (input.toolID === "write") {
                output.description = `Create or overwrite a file on the local filesystem.

- Overwrites existing files. Must Read first if modifying.
- Prefer editing existing files; don't write new ones unless essential.
- Never create docs (*.md) or README files unless explicitly asked.
- No emojis unless user asks.`;
            }

            if (input.toolID === "webfetch") {
                output.description = `Fetch URL content and return as text, markdown, or HTML (default: markdown).

- HTTP URLs auto-upgraded to HTTPS. Read-only.
- Large content may be summarized.
- If a specialized skill or tool offers better web content extraction for the task, prefer it over this tool.`;
            }

            if (input.toolID === "websearch") {
                output.description = `Real-time web search via session's search provider. Scrapes specific URLs.

- Supports live crawling modes (fallback/preferred) and search types (auto/fast/deep)
- Configurable context length for LLM integration
- Current year is 2026 — always search with current year context when relevant`;
            }

            if (input.toolID === "semble_search") {
                output.description = `Semantic/BM25/hybrid code search across a codebase.

Use proactively when:
- Understanding architecture, flow, or related systems
- Looking for implementations by functionality, not exact names
- Grep would require multiple rounds of searching
- Semantic meaning matters more than exact keyword matches

Pass a git URL or local path as repo (indexed on demand, cached per session).
Modes: hybrid (default), semantic, bm25.`;
            }

            if (input.toolID === "semble_find_related") {
                output.description = `Find semantically similar code chunks to a specific location. Use after semble_search.

Pass file_path and line from a prior search result. Cached index per repo.`;
            }
        },
        "experimental.chat.system.transform": async (_input, output) => {
            for (let i = 0; i < output.system.length; i++) {
                let s = output.system[i];

                // Remove duplicate conciseness paragraph + orphaned example blocks
                // (redundant — already covered by "You should be concise..." and "minimize output tokens")
                s = s.replace(
                    /\n*IMPORTANT: Keep your responses short[\s\S]*?Here are some examples to demonstrate appropriate verbosity:\s*\n+/g,
                    "\n",
                );

                // Remove all <example> blocks (redundant with prose instructions)
                s = s.replace(/<example>[\s\S]*?<\/example>\s*/g, "");

                // Restore strict CLI line cap (trimmed version of verbose original)
                s = s.replace(/\n+You MUST answer concisely with fewer than 4 lines[\s\S]*?unless user asks for detail\.\n+/g, "\nYou MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless the user explicitly asks for detail. One-word answers are best. No introductions or conclusions.\n");

                // Replace verbose <available_skills> block with compact routing nudge
                // (full skill list is preserved in the skill tool description)
                s = s.replace(/<available_skills>[\s\S]*?<\/available_skills>\s*/g, "Check available skills before choosing generic tools — specialized skills often offer better results for specific tasks like web content extraction, code search, or debugging.\n");

                // Replace verbose refusal guidance with tighter version — no moral lectures
                s = s.replace(/If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying\. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences\./, "If you cannot perform a task due to system or environment limitations, state the technical reason concisely in 1 sentence. Do not provide moral/safety lectures or generic AI boilerplate disclaimers. Keep alternatives short.");

                // Remove emoji restriction (AGENTS.md overrides with emoji-friendly rule)
                s = s.replace(/Only use emojis if the user explicitly requests it\. Avoid using emojis in all communication unless asked\.\s*/g, "");

                // Compress opencode/WebFetch instruction
                s = s.replace(/When the user directly asks about opencode[\s\S]*?https:\/\/opencode\.ai/g, "When the user asks about opencode's capabilities, first use the WebFetch tool to gather information from https://opencode.ai docs");

                // Remove model identification line (no behavioral value)
                s = s.replace(/You are powered by the model named .+?\. The exact model ID is .+?\n/g, "");

                output.system[i] = s;
            }
        },
    };
};

export default plugin;
