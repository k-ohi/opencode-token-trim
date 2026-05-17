# 💸 Token-Saving OpenCode Interceptor

**We are paying for tokens. I wanted to stop wasting them on stuff the AI doesn't need to read.**

This is a forked/patched version of the [opencode-interceptor](https://github.com/cortexkit/opencode-interceptor) plugin.

The original plugin lets you **intercept and inspect** what opencode sends to your AI provider (great for debugging).

**We made it save money.** Every single request opencode makes to the AI provider (GPT, Claude, Gemini, whatever) comes with ~69,000 characters of **fat** — duplicate instructions, bloated tool descriptions, examples nobody asked for, and the same skill list twice.

We cut all that out. The AI still behaves the same. You just stop paying for text it was ignoring anyway.

**From 69,000 chars → 22,000 chars. 68% smaller. That's ~12,000 tokens saved per turn.**

---

## The results

| | Before | After | Savings |
|---|---|---|---|
| **System prompt** | ~25,300 chars | ~7,500 chars | **70% smaller** |
| **Tool descriptions** | ~44,000 chars | ~14,500 chars | **67% smaller** |
| **Total per request** | **~69,000 chars (~19,800 tokens)** | **~22,000 chars (~7,700 tokens)** | **~68% smaller** |

**A simple "hi" used to cost 19,800 tokens. Now it costs 7,700.**
Over 12,000 tokens saved. Every. Single. Message. That adds up fast.

---

## What exactly did we cut? (plain English)
### Layer 1: System prompt (8 regexes)
| # | What | Why |
|---|---|---|
| 1 | **Duplicate conciseness paragraph** — "Keep your responses short" | Already said by "minimize output tokens" — exact same rule, different words |
| 2 | **All 9 `<example>` blocks** — "user: 2+2 → assistant: 4" | The instructions already say "be concise" — don't need 9 examples of it |
| 3 | **Standalone "be concise" under Tool usage policy** — "You MUST answer concisely with fewer than 4 lines" | Third copy of the same rule in different wording |
| 4 | **Full `<available_skills>` XML block** (~8,700 chars) | The skill list ALSO appears in the skill tool description — kept one, killed the duplicate |
| 5 | **Verbose refusal guidance** — 2 sentences of "don't say why, don't be preachy" | Replaced with 1 sentence that says the same thing |
| 6 | **Emoji restriction** — "Only use emojis if user asks" | Emoji control through AGENTS.md incase we want more emojis for better visual expression |
| 7 | **Long opencode/WebFetch instruction** — 6 examples about when to check docs | Compressed to 1 line: "when they ask about opencode, check the docs" |
| 8 | **Model identification** — "powered by deepseek-v4-flash-free" | The AI doesn't need to know what model it is |
### Layer 2: Tool descriptions (14 trims)
Every tool description got shortened:
| Tool | Before | After |
|---|---|---|
| **bash** | ~10,500 chars | ~1,500 chars |
| **todowrite** | ~8,800 chars | ~500 chars |
| **task** | ~4,600 chars | ~1,700 chars |
| **edit** | ~1,850 chars | ~300 chars |
| **read** | ~1,500 chars | ~300 chars |
| **glob** | ~900 chars | ~200 chars |
| **grep** | ~1,100 chars | ~200 chars |
| **question** | ~1,300 chars | ~250 chars |
| **write** | ~800 chars | ~200 chars |
| **webfetch** | ~1,000 chars | ~200 chars |
| **websearch** | ~900 chars | ~250 chars |
| **skill** | ~9,000 chars | ~8,000 chars (kept the skill list, trimmed the preamble only) |
### Layer 3: Fetch-level trim (1 trim)
| What | Why |
|---|---|
| **Skill tool preamble** (~950 chars) — "The skill will inject... Tool output includes..." nonsense | Runs right before the API call. Strips the describeSkill() boilerplate but keeps the skill list intact. |

### How the trimming works

Three tricks working together:

1. **Plugin hooks** — opencode lets plugins modify tool descriptions (`tool.definition`) and the system prompt (`experimental.chat.system.transform`) as they're being built. We hooked into those and replaced long descriptions with short ones.

2. **Fetch interceptor** — right before the request flies out to the AI provider, we grab it, scan it, and strip the skill tool's redundant introductory bloat (~950 chars of "The skill will inject... Tool output includes..." nonsense). The actual skill list stays because the AI needs it to know which skills exist.

3. **Regex on the assembled text** — we use text patterns to find and remove specific duplicate paragraphs and example blocks.

Everything is **fail-safe**. If the patterns don't match (e.g. opencode updates and changes the wording), nothing crashes — the text just passes through untouched.

---

## How to use this

### 1. Add to opencode config

Open your opencode config (`~/.config/opencode/opencode.json` or wherever yours lives) and add this plugin:

```json
{
  "plugin": [
    "file:////absolute/path/to/opencode-interceptor/src/index.ts"
  ]
}
```

### 2. Restart opencode

Close and reopen opencode. That's it.

---

## You still get the original intercept features

The original `/intercept` commands still work:

- `/intercept` — see status
- `/intercept on` — start capturing requests
- `/intercept off` — stop capturing
- Dumps go to a temp directory (see `/intercept` for the actual path)

---
### Emoji control — fully yours 🤪
We removed the hardcoded "no emojis" rule from the system prompt.
Now **you** decide.
Use your own Rule or add any of these to your `AGENTS.md`:
| Preference | Add to AGENTS.md |
|---|---|
| Original | `Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.` |
| Occasional | `Use emojis occasionally for tone.` |
| Full expression | `Use emojis in all communication for better visual expression.` |
| Maximum chaos | `Use emojis liberally. Be as expressive as possible.` |

## What we DIDN'T change

- All behavioral rules stay intact (proactiveness, conventions, code style, security guard, etc.)
- The AI still knows every skill it can invoke
- The skill list is still there — just in one place instead of two
- The AGENTS.md instructions are untouched
- The `name` parameter descriptions on every tool are untouched

We only removed **duplicates** and **unnecessary fluff**. Nothing the AI needs to do its job was taken away.
