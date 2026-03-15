# Agent Memory Integration — Dual Memory with OpenClaw

This guide covers three things:

1. **Slack capture format** — how to structure text for maximum context extraction
2. **OpenClaw skill** — giving Jen MCP access to your Open Brain
3. **Conversation routing** — how "remember" vs "Jen, remember" triggers the right memory

---

## The Two Memory Systems

| System | What It Is | Where It Lives | Who Owns It |
|--------|-----------|----------------|-------------|
| **Open Brain** | Your personal knowledge base — thoughts, decisions, observations, research | Supabase (thoughts table via MCP) | You |
| **Jen's Memory** | Agent workspace memory — your preferences, routines, how you like things done | QMD / Markdown files in Jen's workspace | Jen |

**The rule:** Open Brain is *your* memory. Jen's QMD is *her* memory about you. Both are valuable. Both should be searchable. The difference is intent.

| You say... | What happens |
|------------|-------------|
| "Remember that Sarah is leaving her job" | Jen captures to **Open Brain** (your memory) |
| "Remind me what I said about the API redesign" | Jen searches **Open Brain** (your memory) |
| "Jen, remember that I prefer dark roast coffee" | Jen writes to **her own QMD memory** (agent memory) |
| "Jen, how do I like my coffee?" | Jen searches **her QMD memory** first |
| "What do we know about the Martinez project?" | Jen searches **both** — Open Brain for your captured thoughts, QMD for any agent notes |

---

## Part 1: Slack Capture Format

When you capture thoughts — whether through Jen or directly in Slack — structure them for maximum metadata extraction. The more context in the text, the better the tagging.

### The Anatomy of a Good Capture

```
[context] [type signal] [the actual content] [people] [dates] [action items]
```

You don't need rigid formatting. Natural language works. But including these elements gives the metadata extractor (or your `metadata_override`) the best material.

### Format Templates

#### Quick Thought (minimum viable capture)
```
Research: Thermodynamic attractors may explain emergent consciousness patterns
```
Extracts: `context: research`, `topics: [thermodynamic attractors, consciousness]`, `type: observation`

#### Decision
```
Personal: Decided to switch to the 7am workout slot because the gym is empty before 8
```
Extracts: `context: personal`, `type: decision`, `topics: [fitness, schedule]`

#### Person Note
```
Met David Kim at the product meetup — he leads ML infrastructure at Stripe, interested in our embedding pipeline
```
Extracts: `type: person_note`, `people: [David Kim]`, `topics: [ML infrastructure, embeddings, Stripe]`

#### Task / Action Item
```
Need to send the Q3 budget to Marcus by Friday March 21
```
Extracts: `type: task`, `people: [Marcus]`, `action_items: [send Q3 budget]`, `dates_mentioned: [2025-03-21]`

#### Research Note with Source
```
Research: Carter & Wills (2021) argue that attention mechanisms in transformers are a form of learned compression — relevant to our embedding quality work
```
When using `metadata_override`, you can add `document_id: carter_wills_2021` to group all notes from this source.

#### Question
```
Research: Is there a way to do incremental re-embedding when the model changes, or do we have to re-embed the entire corpus?
```
Extracts: `type: question`, `context: research`, `topics: [embeddings, migration]`

### Context Prefixes

Start your message with the context to guarantee correct silo assignment:

| Prefix | Context | Use For |
|--------|---------|---------|
| `Research:` | research | Papers, technical notes, learning |
| `Personal:` | personal | Life, home, health, relationships |
| `Tools:` | tools | Meta-notes about your systems, configs, workflows |

If you skip the prefix, the thought captures without a context (still searchable, just not siloed). You can always tag it later with `update_thought`.

### Capture via Conversation with Jen

The most natural flow — just talk to Jen:

> **You:** Remember that the landlord said the roof inspection is scheduled for April 10th and we need to clear the gutters before then
>
> **Jen:** *(captures to Open Brain with context: personal, type: observation, people: [landlord], dates: [2025-04-10], action_items: [clear gutters])*
>
> Captured as observation [personal] — home maintenance, roof inspection | People: landlord | Actions: clear gutters

> **You:** Research note: the Anthropic constitutional AI paper uses a hierarchy of principles rather than flat RLHF — worth comparing to our safety layer design
>
> **Jen:** *(captures to Open Brain with context: research)*
>
> Captured as reference [research] — constitutional AI, safety, RLHF

### Bulk Capture with metadata_override

When migrating notes or doing batch tagging, use `metadata_override` to skip the LLM call:

```json
{
  "content": "Carter & Wills argue that attention = learned compression",
  "context": "research",
  "document_id": "carter_wills_2021",
  "metadata_override": "{\"type\":\"reference\",\"topics\":[\"attention mechanisms\",\"compression\"],\"people\":[\"Carter\",\"Wills\"]}"
}
```

---

## Part 2: OpenClaw Skill — Open Brain Memory

Create this skill so Jen can read and write to your Open Brain via MCP.

### File Structure

```
~/.openclaw/skills/open-brain/
└── SKILL.md
```

### SKILL.md

```markdown
---
name: open-brain
description: Search and capture to Francis's Open Brain — his personal knowledge base with semantic search. Use this for HIS memories, not agent workspace memories.
metadata: {"openclaw":{"requires":{"env":["OPEN_BRAIN_MCP_URL","OPEN_BRAIN_ACCESS_KEY"]}}}
---

# Open Brain — Francis's Personal Memory

You have access to Francis's Open Brain via MCP tools. This is HIS memory — a persistent knowledge base with semantic vector search across everything he has captured: decisions, observations, research notes, people, tasks, ideas, and questions.

## When to Use Open Brain (Francis's Memory)

Use the Open Brain MCP tools when:

- Francis says **"remember"**, **"save this"**, **"note that"**, **"capture this"** → `capture_thought`
- Francis asks **"what did I say about..."**, **"remind me..."**, **"find my notes on..."** → `search_thoughts`
- Francis asks **"what have I captured recently?"**, **"show me my tasks"** → `list_thoughts`
- Francis asks **"how many thoughts do I have?"**, **"what topics come up most?"** → `thought_stats`
- Francis wants to **retag or reclassify** an existing thought → `update_thought`
- You need to **research context** before answering a question Francis asked — search Open Brain first to see if he has prior notes on the topic

## When NOT to Use Open Brain

Do NOT use Open Brain when:

- Francis says **"Jen, remember..."** or **"Jen, note that I prefer..."** → write to YOUR workspace memory (memory/YYYY-MM-DD.md) instead. These are instructions about how Francis likes things done, his preferences, and your operating notes about him.
- You need to recall how Francis likes his coffee, his communication preferences, or routines → check YOUR memory first (QMD / memory files)

## The Routing Rule

| Trigger phrase | Target | Tool |
|---------------|--------|------|
| "remember [something]" | Open Brain | `capture_thought` |
| "save this / note that / capture" | Open Brain | `capture_thought` |
| "remind me about..." | Open Brain | `search_thoughts` |
| "what did I say about..." | Open Brain | `search_thoughts` |
| "Jen, remember that I..." | Your workspace memory | `memory/YYYY-MM-DD.md` |
| "Jen, I prefer..." | Your workspace memory | `memory/YYYY-MM-DD.md` |
| "what do we know about X?" | BOTH | Search Open Brain + your memory |
| General question about a topic | BOTH if relevant | Check Open Brain for prior context |

## Capture Guidelines

When capturing to Open Brain, structure the thought for maximum retrieval:

1. **Set the context** — always include `context` when you can infer it:
   - `research` — learning, papers, technical notes
   - `personal` — life, home, health, relationships, family
   - `tools` — meta-notes about systems, workflows, configurations

2. **Let the type be auto-extracted** unless Francis specifies — the LLM does a good job with: observation, task, idea, reference, person_note, question, decision

3. **Include people by name** in the content when relevant — the extractor picks them up

4. **Include dates** when mentioned — use natural language, the extractor converts to YYYY-MM-DD

5. **For bulk/migration captures**, use `metadata_override` as a JSON string to skip the LLM call and tag precisely

## Search Guidelines

When searching Open Brain:

1. **Default search** — use `search_thoughts` with a natural language query. Semantic search handles synonym matching.

2. **Scoped search** — if Francis is asking about a specific domain, add `context` filter:
   - "find my research on transformers" → `search_thoughts(query: "transformers", context: "research")`
   - "what personal notes do I have about the house?" → `search_thoughts(query: "house", context: "personal")`

3. **Browsing** — use `list_thoughts` with filters when Francis wants to see recent captures:
   - "show my tasks" → `list_thoughts(type: "task")`
   - "what did I capture this week?" → `list_thoughts(days: 7)`
   - "show my research from this week" → `list_thoughts(context: "research", days: 7)`

4. **Dual search** — when Francis asks a broad question like "what do we know about X?", search BOTH Open Brain and your QMD memory, then synthesize the results. Present Open Brain results as "from your notes" and QMD results as "from my notes about you."

## Proactive Memory Use

When Francis brings up a topic in conversation:

1. **Before answering**, silently search Open Brain to see if he has prior context on the topic
2. **Weave in** any relevant prior thoughts naturally: "Based on your earlier note about X..."
3. **Don't over-search** — only search when the topic seems like something Francis may have captured before
4. **Surface connections** — if a search reveals related thoughts across contexts, mention the connection: "You also had a research note about this same pattern..."
```

### Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    entries: {
      "open-brain": {
        enabled: true,
        env: {
          OPEN_BRAIN_MCP_URL: "https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-mcp",
          OPEN_BRAIN_ACCESS_KEY: "your-access-key"
        }
      }
    }
  }
}
```

### MCP Connection

Jen needs MCP access to the Open Brain Edge Function. Since she already has MCP connected, verify the five tools are available:

1. `search_thoughts` — semantic search with optional context filter
2. `list_thoughts` — browse with filters (type, topic, person, context, document_id, days)
3. `thought_stats` — summary stats with context breakdown
4. `capture_thought` — save with context, document_id, optional metadata_override
5. `update_thought` — retroactively tag existing thoughts

---

## Part 3: Conversation Routing — How It Works in Practice

### The Memory Decision Tree

```
Francis says something about remembering
│
├── Contains "Jen, remember" / "Jen, note that I" / "Jen, I prefer"
│   └── → Write to Jen's workspace memory (QMD / memory/YYYY-MM-DD.md)
│        This is about Francis's preferences, routines, or instructions TO Jen
│
├── Contains "remember" / "save" / "note that" / "capture" (without "Jen,")
│   └── → Capture to Open Brain via capture_thought
│        This is Francis's own knowledge he wants stored permanently
│
├── Contains "remind me" / "what did I say" / "find my notes"
│   └── → Search Open Brain via search_thoughts
│
├── Contains "what do we know about" / broad topic question
│   └── → Search BOTH Open Brain AND Jen's QMD memory
│        Present results from each source clearly labeled
│
└── General conversation about a topic
    └── → Jen silently checks Open Brain for prior context
         Weaves in relevant findings naturally
```

### Example Conversations

**Capturing to YOUR memory (Open Brain):**

> **You:** Remember that the board meeting is moved to April 3rd and Tom wants the revenue slides updated
>
> **Jen:** Captured as task [personal] — board meeting, revenue slides | People: Tom | Actions: update revenue slides | Dates: 2025-04-03

**Capturing to JEN'S memory (QMD):**

> **You:** Jen, remember that when I ask for meeting summaries, I want bullet points not paragraphs
>
> **Jen:** Got it — I've noted that you prefer bullet-point meeting summaries. I'll format them that way going forward.
>
> *(Jen writes to memory/2025-03-15.md: "Francis prefers bullet-point format for meeting summaries, not paragraphs.")*

**Searching YOUR memory:**

> **You:** What did I capture about the API redesign?
>
> **Jen:** *(calls search_thoughts with query "API redesign")*
>
> Found 3 thoughts:
> - [Mar 2] Decision: Going with REST over GraphQL because the team knows it better
> - [Mar 5] Observation: The current API has 47 endpoints, 12 are unused
> - [Mar 8] Task: Need to draft the migration timeline by end of month

**Dual search (both memories):**

> **You:** What do we know about the Martinez project?
>
> **Jen:** From your notes:
> - [Feb 28] You captured that Martinez Corp wants a pilot program starting Q3
> - [Mar 1] You noted that Lisa Martinez is the decision-maker, reports to their CTO
>
> From my notes:
> - You asked me to always CC david@martinez.com when drafting emails about this project
> - You prefer the short proposal format (2 pages max) for Martinez communications

**Proactive context (Jen searches silently):**

> **You:** I'm prepping for the Martinez call tomorrow
>
> **Jen:** *(silently searches Open Brain for "Martinez")*
>
> Before you prep — you had a few notes on this. Lisa Martinez is the decision-maker (reports to their CTO), and they want a pilot starting Q3. You also noted that their budget concern was around the integration timeline, not the price. Want me to pull up anything else?

---

## Part 4: AGENTS.md Integration

Add these routing instructions to Jen's `AGENTS.md` file so they persist across sessions:

```markdown
## Memory Routing

You have access to TWO memory systems:

1. **Open Brain** (Francis's memory) — via MCP tools (search_thoughts, capture_thought, list_thoughts, thought_stats, update_thought). This is Francis's personal knowledge base.

2. **Your workspace memory** (your memory about Francis) — via memory/YYYY-MM-DD.md and MEMORY.md files. This is YOUR notes about his preferences, routines, and instructions.

### Routing rules:

- "remember [X]" / "save this" / "note that" / "capture" → Open Brain (`capture_thought`)
- "Jen, remember [X]" / "Jen, I prefer" / "Jen, note that I" → YOUR workspace memory
- "remind me about X" / "what did I say about" → Open Brain (`search_thoughts`)
- "what do we know about X" → Search BOTH, present results labeled by source
- When Francis brings up a topic, silently check Open Brain for prior context before answering

### Context assignment:

When capturing to Open Brain, always set context:
- `research` — learning, papers, technical exploration
- `personal` — life, home, health, family, career
- `tools` — systems, workflows, configurations

If unsure, ask Francis: "Should I file this as research, personal, or tools?"
```

---

## Quick Reference Card

| I say... | Jen does... | Where |
|----------|------------|-------|
| "Remember that..." | `capture_thought` | Open Brain |
| "Research: [note]" | `capture_thought` with `context: research` | Open Brain |
| "Personal: [note]" | `capture_thought` with `context: personal` | Open Brain |
| "Remind me about X" | `search_thoughts` | Open Brain |
| "Show my recent tasks" | `list_thoughts(type: "task")` | Open Brain |
| "Tag that thought as research" | `update_thought` | Open Brain |
| "Jen, remember I like..." | Write to `memory/YYYY-MM-DD.md` | Jen's QMD |
| "Jen, how do I like my..." | `memory_search` | Jen's QMD |
| "What do we know about X?" | Search both, label results | Both |
| "My thought stats" | `thought_stats` | Open Brain |
