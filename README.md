# AI Test Case Generator — Agentic QA Pipeline

A Node.js + Express API that uses an **autonomous AI agent** to generate high-quality QA test cases from a software requirement.

## Architecture

```
POST /generate
      │
      ▼
  QA Agent (index.js)
      │
      ├─ Tool: search_knowledge_base  ──► RAG Vector Store (Vectra + OpenAI embeddings)
      │         (retrieves QA best practices)
      │
      ├─ Tool: generate_test_cases    ──► OpenAI gpt-4o-mini
      │         (grounded generation using retrieved context)
      │
      ├─ Tool: validate_test_cases    ──► OpenAI gpt-4o-mini
      │         (LLM evaluates its own output, score 0–10)
      │
      └─ Tool: revise_test_cases      ──► OpenAI gpt-4o-mini  (only if score < 8)
                (self-correction / reflection loop)
                      │
                      ▼
              MongoDB (TestCase model)
                      │
                      ▼
              JSON Response (output + agentTrace + reflection)
```

See [architecture.mmd](architecture.mmd) for the full Mermaid diagram.

## Key Capabilities

| Capability | Details |
|---|---|
| **RAG pipeline** | Vector knowledge base seeded with QA best-practice documents. Vectra + OpenAI `text-embedding-3-small`. |
| **Agentic tool-calling** | The LLM autonomously decides which tools to invoke and in what order using OpenAI function-calling. |
| **Reflection / self-correction** | After generation, the agent scores its own output (0–10). If score < 8, it revises automatically. |
| **Fallback mode** | When OpenAI is unavailable (missing/invalid key or quota exceeded), returns template-based test cases so API remains usable. |
| **Graceful DB handling** | If MongoDB URI is missing/placeholder/unreachable, API still responds; persistence is skipped safely. |

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express 5
- **LLM:** OpenAI `gpt-4o-mini` (chat completions + function-calling)
- **Embeddings:** OpenAI `text-embedding-3-small`
- **Vector Store:** Vectra (local, file-based — no external service required)
- **Database:** MongoDB + Mongoose
- **Config:** dotenv

## Project Structure

```text
ai-test-generator/
├── index.js                  # Express app + agentic pipeline loop
├── .env.example              # Environment variable template
├── architecture.mmd          # Mermaid architecture diagram
├── package.json
├── agents/
│   ├── tools.js              # OpenAI tool definitions (4 tools)
│   ├── knowledgeBase.js      # RAG — Vectra vector store + embeddings
│   └── reflection.js         # Self-reflection and revision module
├── models/
│   └── TestCase.js           # Mongoose schema
└── data/
    └── qa-knowledge-index/   # Auto-created vector index (gitignore this)
```

## Prerequisites

- Node.js 18+
- MongoDB (Atlas free tier or local) — optional for persistence
- OpenAI API key with billing enabled — optional for AI mode (fallback works without it)

## Environment Variables

Copy `.env.example` to `.env` and fill in your real values:

```env
OPENAI_API_KEY=your-openai-api-key-here
MONGO_URI=your-mongodb-connection-string-here
PORT=3000
```

> **Security:** Never commit `.env` to source control. The `.env.example` file is safe to commit.

## Install & Run

```bash
npm install
node index.js
```

Server starts at `http://localhost:3000`.

## API Reference

### `POST /generate`

Runs the full agentic pipeline and returns generated test cases.

**Request body:**

```json
{
  "requirement": "User should login using email and password"
}
```

**Success response (`200`):**

```json
{
  "requirement": "User should login using email and password",
  "output": "...generated test cases...",
  "_id": "...",
  "createdAt": "...",
  "__v": 0,
  "agentTrace": [
    { "tool": "search_knowledge_base", "args": { "query": "login authentication" }, "result": "..." },
    { "tool": "generate_test_cases",   "args": { "requirement": "...", "knowledge_context": "..." }, "result": "..." },
    { "tool": "validate_test_cases",   "args": { "test_cases": "...", "requirement": "..." }, "result": "{\"score\":9,...}" }
  ],
  "reflection": {
    "score": 9,
    "issues": [],
    "summary": "Test cases are comprehensive and well-structured.",
    "revised": false
  }
}
```

> Note: `_id`, `createdAt`, and `__v` are present only when MongoDB persistence succeeds.

**Error responses:**
- `400` — Missing `requirement` field
- `500` — Unexpected server error

### `GET /health`

Returns server status.

```json
{ "status": "ok", "timestamp": "2026-03-25T10:00:00.000Z" }
```

## How the Agent Works

1. **RAG retrieval** — The agent calls `search_knowledge_base` to fetch the most relevant QA guidelines from the embedded knowledge base (boundary value analysis, equivalence partitioning, security testing, etc.)
2. **Grounded generation** — The agent calls `generate_test_cases`, passing the retrieved context alongside the requirement so the output is grounded in known standards.
3. **Validation** — The agent calls `validate_test_cases`; the LLM scores its own output from 0–10 and identifies any gaps.
4. **Reflection** — If score < 8, the agent calls `revise_test_cases` and produces an improved version.
5. **Persistence** — The final output is saved to MongoDB and returned with full trace + reflection metadata.

## Runtime Notes

- If `MONGO_URI` is a placeholder/demo value, startup logs: `MongoDB disabled...` and the API continues without DB writes.
- If OpenAI returns `401` (invalid key) or `429` (quota), API returns a fallback test suite with a `warning` message.
- For full agent mode output (`agentTrace` + `reflection`), set a valid `OPENAI_API_KEY` and restart the server.
