/**
 * index.js  — QA Agent API
 *
 * Agentic pipeline with:
 *  1. RAG  – retrieves relevant QA best practices from a vector knowledge base
 *  2. Tool-calling  – LLM decides which tools to invoke (search, generate, validate, revise)
 *  3. Reflection / self-correction  – agent evaluates its own output and revises if score < 8
 */

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const OpenAI = require('openai');

const TestCase = require('./models/TestCase');
const { TOOL_DEFINITIONS } = require('./agents/tools');
const knowledgeBase = require('./agents/knowledgeBase');
const { reflect, revise } = require('./agents/reflection');

// ─────────────────────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const apiKey = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey });

const mongoUri = process.env.MONGO_URI;
const isMongoUriConfigured = Boolean(
  mongoUri
    && !mongoUri.includes('your-mongodb-connection-string-here')
    && !mongoUri.includes('testuser:testpass@cluster0.mongodb.net')
);

if (isMongoUriConfigured) {
  mongoose
    .connect(mongoUri)
    .then(() => console.log('MongoDB Connected'))
    .catch((err) => console.error('MongoDB error:', err.message));
} else {
  console.warn('MongoDB disabled: set a valid MONGO_URI in .env to enable persistence.');
}

/**
 * Attempt to persist a test case record. Returns the saved document on
 * success, or null if MongoDB is unavailable (so the API still responds).
 */
async function safeSave(requirement, output) {
  try {
    return await TestCase.create({ requirement, output });
  } catch (dbErr) {
    console.error('[DB] Save skipped:', dbErr.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Tool executor — maps LLM tool-call names → real functions
// ─────────────────────────────────────────────────────────────

async function executeTool(name, args, openaiClient) {
  console.log(`[Agent] Executing tool: ${name}`);

  switch (name) {

    case 'search_knowledge_base': {
      const results = await knowledgeBase.search(args.query, args.top_k || 3);
      return results.join('\n\n---\n\n');
    }

    case 'generate_test_cases': {
      const prompt = `You are a Senior QA Engineer. Using the QA guidelines below, generate
comprehensive test artifacts for the requirement.

QA Guidelines (from knowledge base):
${args.knowledge_context}

Requirement:
${args.requirement}

Output the following four sections:
1. Test Scenarios
2. Test Cases (include: Preconditions, Steps, Expected Result for each)
3. Edge Cases
4. Negative Cases`;

      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
      });
      return response.choices[0].message.content;
    }

    case 'validate_test_cases': {
      const prompt = `You are a QA Lead. Review these test cases against the requirement.
Return a JSON object with keys:
- "score": integer 0-10
- "issues": array of strings
- "summary": one-sentence assessment

Requirement: ${args.requirement}

Test Cases:
${args.test_cases}`;

      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });
      return response.choices[0].message.content;
    }

    case 'revise_test_cases': {
      const prompt = `You are a Senior QA Engineer. Improve the test cases below by
addressing every issue listed.

Original Requirement: ${args.requirement}

Issues to fix:
${args.validation_feedback}

Original Test Cases:
${args.original_test_cases}

Return the complete improved test cases with all four sections.`;

      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
      });
      return response.choices[0].message.content;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Agentic loop
// Uses OpenAI tool-calling: the LLM decides which tools to call
// and in what sequence until it decides it is done.
// ─────────────────────────────────────────────────────────────

async function runAgent(requirement) {
  const systemPrompt = `You are an autonomous QA Agent. Your goal is to generate high-quality,
comprehensive test cases for a given software requirement.

You have access to the following tools — use them in this recommended order:
1. search_knowledge_base — retrieve relevant QA best practices first
2. generate_test_cases   — generate test cases using the knowledge context
3. validate_test_cases   — evaluate the quality of the generated test cases
4. revise_test_cases     — if the score is below 8, revise the test cases

Always start by searching the knowledge base. Always validate before finishing.
Only call revise_test_cases if the validation score is below 8.
When you are satisfied with the quality, stop calling tools and return the final
test cases as your plain-text response.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Generate test cases for the following requirement:\n\n${requirement}` },
  ];

  const agentTrace = [];
  const MAX_ITERATIONS = 8;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];

    // LLM decided to stop — final text response
    if (choice.finish_reason === 'stop') {
      return { output: choice.message.content, agentTrace };
    }

    // LLM wants to call one or more tools
    if (choice.finish_reason === 'tool_calls') {
      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);
        const toolResult = await executeTool(toolName, toolArgs, openai);

        agentTrace.push({ tool: toolName, args: toolArgs, result: toolResult });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
        });
      }
      continue;
    }

    console.warn('[Agent] Unexpected finish_reason:', choice.finish_reason);
    break;
  }

  // Fallback: extract last generated test case from trace
  const lastGenerate = [...agentTrace].reverse()
    .find((t) => t.tool === 'generate_test_cases' || t.tool === 'revise_test_cases');
  return {
    output: lastGenerate ? lastGenerate.result : 'Agent did not produce output.',
    agentTrace,
  };
}

// ─────────────────────────────────────────────────────────────
// Fallback (no API key / quota exceeded)
// ─────────────────────────────────────────────────────────────

function generateFallbackTestCases(requirement) {
  return `[FALLBACK — OpenAI unavailable]

Test Scenarios:
1. Verify the main happy path for: ${requirement}
2. Verify validation rules related to: ${requirement}
3. Verify error handling and user feedback for: ${requirement}

Test Cases:
1. Enter valid input → confirm expected result is shown.
2. Submit with one invalid input → confirm validation message appears.
3. Retry after correcting input → confirm success.
4. Verify data is persisted correctly after success.

Edge Cases:
1. Minimum allowed input values.
2. Maximum allowed input values.
3. Leading/trailing spaces in user input.
4. Slow network / delayed server response.

Negative Cases:
1. Missing required fields.
2. Invalid format input.
3. Unauthorized access attempt.
4. Duplicate / already-used input values.`;
}

// ─────────────────────────────────────────────────────────────
// POST /generate  — main endpoint
// ─────────────────────────────────────────────────────────────

app.post('/generate', async (req, res) => {
  const { requirement } = req.body;

  if (!requirement) {
    return res.status(400).json({ error: 'The requirement field is required.' });
  }

  if (!apiKey) {
    const output = generateFallbackTestCases(requirement);
    const saved = await safeSave(requirement, output);
    return res.status(200).json({
      ...(saved ? saved.toObject() : { requirement, output }),
      agentTrace: [],
      reflection: null,
      warning: 'OPENAI_API_KEY is not set. Returned local fallback test cases.',
    });
  }

  try {
    console.log('[Agent] Starting agentic pipeline for:', requirement);
    const { output: rawOutput, agentTrace } = await runAgent(requirement);

    console.log('[Reflection] Evaluating generated output…');
    const reflectionResult = await reflect(rawOutput, requirement);
    console.log(`[Reflection] Score: ${reflectionResult.score}/10 | Issues: ${reflectionResult.issues.length}`);

    let finalOutput = rawOutput;

    if (reflectionResult.needsRevision) {
      console.log('[Reflection] Score below threshold — requesting revision…');
      finalOutput = await revise(rawOutput, reflectionResult.issues, requirement);
    }

    const saved = await safeSave(requirement, finalOutput);

    return res.status(200).json({
      ...(saved ? saved.toObject() : { requirement, output: finalOutput }),
      agentTrace,
      reflection: {
        score: reflectionResult.score,
        issues: reflectionResult.issues,
        summary: reflectionResult.summary,
        revised: reflectionResult.needsRevision,
      },
    });

  } catch (error) {
    console.error('[Agent] Error:', error.message);

    const isQuotaError = error.status === 429 || error.code === 'insufficient_quota';
    const isAuthError  = error.status === 401 || error.code === 'invalid_api_key';

    if (isQuotaError || isAuthError) {
      const output = generateFallbackTestCases(requirement);
      const saved = await safeSave(requirement, output);
      return res.status(200).json({
        ...(saved ? saved.toObject() : { requirement, output }),
        agentTrace: [],
        reflection: null,
        warning: isAuthError
          ? 'OpenAI API key is invalid or not set. Returned local fallback test cases.'
          : 'OpenAI quota exceeded. Returned local fallback test cases instead.',
      });
    }

    return res.status(error.status || 500).json({
      error: error.message || 'Something went wrong.',
      details: error.code || null,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`QA Agent API running on port ${port}`);
});