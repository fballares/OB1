# Fork Management — fballares/OB1

This document describes how this fork is structured and how to keep it in sync with the upstream project.

## Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `https://github.com/fballares/OB1.git` | Your fork — push your work here |
| `upstream` | `https://github.com/NateBJones-Projects/OB1.git` | Author's repo — pull updates from here |

## Branches

| Branch | Purpose | Push to |
|--------|---------|---------|
| `main` | Mirror of upstream. Never commit custom changes here. | `origin/main` |
| `francis/metadata-architecture` | Custom working branch with local enhancements | `origin/francis/metadata-architecture` |

## Syncing with Upstream

When the author publishes updates, pull them into your `main` and then rebase your custom branch:

```bash
# 1. Update main from upstream
git checkout main
git fetch upstream
git merge upstream/main
git push origin main

# 2. Rebase your custom branch onto the updated main
git checkout francis/metadata-architecture
git rebase main
git push origin francis/metadata-architecture --force-with-lease
```

Use `--force-with-lease` (not `--force`) after rebase — it's safer because it checks that nobody else has pushed to the branch.

If you prefer merge over rebase (preserves commit history but creates merge commits):

```bash
git checkout francis/metadata-architecture
git merge main
git push origin francis/metadata-architecture
```

## Comparing Against Main

To see what your custom branch has changed relative to the upstream:

```bash
# Summary of changed files
git diff main --stat

# Full diff
git diff main

# Just the commit log
git log main..francis/metadata-architecture --oneline
```

## Custom Changes (francis/metadata-architecture)

### Single-Table Metadata Architecture (server/index.ts)

Instead of creating separate tables per domain, all data stays in the `thoughts` table with structured metadata for filtering:

- **`context`** field — silo thoughts into `research`, `personal`, `tools` (or custom values)
- **`document_id`** field — group chunks from the same source document
- **`metadata_override`** on capture — bypass LLM extraction for full control over tagging
- **`update_thought`** tool — retroactively tag existing thoughts
- **Vocabulary validation** — controlled vocabulary via `VOCABULARY_CONFIG` Supabase Secret; unknown values are stored and flagged, never rejected
- **Expanded types** — added `question` and `decision` to the type vocabulary

No database schema changes were required. The existing JSONB column, GIN index, and `match_thoughts` filter parameter already support all new fields.

### Optional: Set Vocabulary Config

```bash
supabase secrets set VOCABULARY_CONFIG='{"context":["research","personal","tools"],"type":["observation","task","idea","reference","person_note","question","decision"]}'
```

Update the vocabulary by changing the secret — no code redeployment needed.

## Creating New Custom Branches

For future enhancements, branch off `main` (not your custom branch) to keep changes isolated:

```bash
git checkout main
git checkout -b francis/new-feature
# ... make changes ...
git push -u origin francis/new-feature
```

Then merge into your main custom branch when ready:

```bash
git checkout francis/metadata-architecture
git merge francis/new-feature
```
