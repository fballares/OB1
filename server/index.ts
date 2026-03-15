import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note", "question", "decision"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- Vocabulary Validation ---

interface VocabularyConfig {
  context: string[];
  type: string[];
  source: string[];
}

const DEFAULT_VOCABULARY: VocabularyConfig = {
  context: ["research", "personal", "tools"],
  type: ["observation", "task", "idea", "reference", "person_note", "question", "decision"],
  source: ["mcp"],
};

const vocabulary: VocabularyConfig = (() => {
  const raw = Deno.env.get("VOCABULARY_CONFIG");
  if (!raw) return DEFAULT_VOCABULARY;
  try {
    return JSON.parse(raw) as VocabularyConfig;
  } catch {
    return DEFAULT_VOCABULARY;
  }
})();

function validateMetadata(
  metadata: Record<string, unknown>
): { validated: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const validated = { ...metadata };

  for (const [field, allowedValues] of Object.entries(vocabulary)) {
    const value = metadata[field];
    if (value && typeof value === "string" && !allowedValues.includes(value)) {
      warnings.push(`Unknown ${field}: "${value}" (allowed: ${allowedValues.join(", ")})`);
      if (!Array.isArray(validated._unrecognized)) validated._unrecognized = [];
      (validated._unrecognized as string[]).push(`${field}:${value}`);
    }
  }

  return { validated, warnings };
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// Tool 1: Semantic Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
      context: z.string().optional().describe("Filter to a specific context silo (e.g. research, personal, tools)"),
    },
  },
  async ({ query, limit, threshold, context }) => {
    try {
      const qEmb = await getEmbedding(query);
      const filter: Record<string, unknown> = {};
      if (context) filter.context = context;
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter,
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }

      const results = data.map(
        (
          t: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            similarity: number;
            created_at: string;
          },
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `ID: ${t.id}`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (m.context) parts.push(`Context: ${m.context}`);
          if (m.document_id) parts.push(`Document: ${m.document_id}`);
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, context, document_id, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note, question, decision"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
      context: z.string().optional().describe("Filter by context silo (e.g. research, personal, tools)"),
      document_id: z.string().optional().describe("Filter by document group ID"),
    },
  },
  async ({ limit, type, topic, person, days, context, document_id }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (context) q = q.contains("metadata", { context });
      if (document_id) q = q.contains("metadata", { document_id });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = data.map(
        (
          t: { id: string; content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          const ctx = m.context ? `[${m.context}] ` : "";
          return `${i + 1}. ${ctx}[${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""}) ID: ${t.id}\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};
      const contexts: Record<string, number> = {};
      const documentIds = new Set<string>();

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (m.context) contexts[m.context as string] = (contexts[m.context as string] || 0) + 1;
        if (m.document_id) documentIds.add(m.document_id as string);
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(contexts).length) {
        lines.push("", "Contexts:");
        for (const [k, v] of sort(contexts)) lines.push(`  ${k}: ${v}`);
      }

      if (documentIds.size) {
        lines.push("", `Unique documents: ${documentIds.size}`);
      }

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems. Optionally provide context, document_id, or full metadata_override to bypass auto-extraction.",
    inputSchema: {
      content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
      context: z.string().optional().describe("Context silo for this thought (e.g. research, personal, tools)"),
      document_id: z.string().optional().describe("Group ID for chunks from the same source document (e.g. newport_2016)"),
      metadata_override: z.string().optional().describe("JSON string of metadata to use instead of LLM extraction. Must include at least 'type' and 'topics'. Bypasses auto-extraction to save an API call and give full control over tagging."),
    },
  },
  async ({ content, context, document_id, metadata_override }) => {
    try {
      let metadata: Record<string, unknown>;
      let embedding: number[];

      if (metadata_override) {
        try {
          metadata = JSON.parse(metadata_override);
        } catch {
          return {
            content: [{ type: "text" as const, text: "Failed to parse metadata_override — must be valid JSON." }],
            isError: true,
          };
        }
        // Still need embedding even when skipping LLM extraction
        embedding = await getEmbedding(content);
      } else {
        [embedding, metadata] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);
      }

      // Layer on context and document_id (these take precedence)
      if (context) metadata.context = context;
      if (document_id) metadata.document_id = document_id;
      metadata.source = "mcp";

      // Validate against vocabulary
      const { validated, warnings } = validateMetadata(metadata);

      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: validated,
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
          isError: true,
        };
      }

      const meta = validated as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (meta.context) confirmation += ` [${meta.context}]`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;
      if (meta.document_id) confirmation += ` | Doc: ${meta.document_id}`;
      if (warnings.length) confirmation += `\n⚠️ ${warnings.join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Update Thought Metadata
server.registerTool(
  "update_thought",
  {
    title: "Update Thought",
    description:
      "Update metadata on an existing thought. Use this to retroactively tag thoughts with context, document_id, type, or topics. Does not change content or regenerate embeddings.",
    inputSchema: {
      id: z.string().describe("UUID of the thought to update"),
      context: z.string().optional().describe("Set context silo (e.g. research, personal, tools)"),
      document_id: z.string().optional().describe("Set document group ID"),
      type: z.string().optional().describe("Set type (observation, task, idea, reference, person_note, question, decision)"),
      topics: z.array(z.string()).optional().describe("Replace existing topics with this list"),
      add_topics: z.array(z.string()).optional().describe("Add topics to existing list without replacing"),
    },
  },
  async ({ id, context, document_id, type, topics, add_topics }) => {
    try {
      // Fetch existing thought
      const { data: existing, error: fetchError } = await supabase
        .from("thoughts")
        .select("metadata")
        .eq("id", id)
        .single();

      if (fetchError || !existing) {
        return {
          content: [{ type: "text" as const, text: `Thought not found: ${fetchError?.message || "no match for ID"}` }],
          isError: true,
        };
      }

      // Merge metadata
      const merged: Record<string, unknown> = { ...(existing.metadata || {}) };
      if (context !== undefined) merged.context = context;
      if (document_id !== undefined) merged.document_id = document_id;
      if (type !== undefined) merged.type = type;
      if (topics !== undefined) merged.topics = topics;
      if (add_topics !== undefined) {
        const current = Array.isArray(merged.topics) ? (merged.topics as string[]) : [];
        merged.topics = [...new Set([...current, ...add_topics])];
      }

      // Validate against vocabulary
      const { validated, warnings } = validateMetadata(merged);

      const { error: updateError } = await supabase
        .from("thoughts")
        .update({ metadata: validated })
        .eq("id", id);

      if (updateError) {
        return {
          content: [{ type: "text" as const, text: `Update failed: ${updateError.message}` }],
          isError: true,
        };
      }

      let confirmation = `Updated thought ${id}`;
      if (context) confirmation += ` → context: ${context}`;
      if (document_id) confirmation += ` → doc: ${document_id}`;
      if (type) confirmation += ` → type: ${type}`;
      if (topics) confirmation += ` → topics: ${topics.join(", ")}`;
      if (add_topics) confirmation += ` → added topics: ${add_topics.join(", ")}`;
      if (warnings.length) confirmation += `\n⚠️ ${warnings.join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth Check ---

const app = new Hono();

app.all("*", async (c) => {
  // Accept access key via header OR URL query parameter
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
