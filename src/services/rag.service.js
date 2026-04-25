import { chunkText } from "../utils/chunkText.js";
import { createEmbedding } from "./embedding.service.js";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenAI } from "@google/genai";
import axios from "axios";
import logger from "../utils/logger.js";
import { processFile } from "../utils/fileProcessor.js";

const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || "chatbot-index";
const pineconeIndex = pc.index({ name: PINECONE_INDEX_NAME });

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

let cachedIndexDimension = null;
async function getIndexDimension() {
  if (cachedIndexDimension) return cachedIndexDimension;
  try {
    const description = await pc.describeIndex(PINECONE_INDEX_NAME);
    cachedIndexDimension = description.dimension || 768;
    logger.debug(`Detected Pinecone index dimension: ${cachedIndexDimension}`);
  } catch (error) {
    logger.warn(`Failed to describe index, defaulting to 768: ${error.message}`);
    cachedIndexDimension = 768;
  }
  return cachedIndexDimension;
}

function padEmbedding(embedding, targetDimension) {
  if (embedding.length >= targetDimension) return embedding;
  return [
    ...embedding,
    ...new Array(targetDimension - embedding.length).fill(0),
  ];
}

function getChunkText(chunk) {
  return (
    chunk.metadata?.answer ||
    chunk.metadata?.content ||
    chunk.content ||
    ""
  ).trim();
}

function detectIntent(title, content) {
  const text = `${title} ${content}`.toLowerCase();
  if (text.includes("who")) return "about";
  if (text.includes("price")) return "pricing";
  if (text.includes("how")) return "how-to";
  if (text.includes("contact")) return "contact";
  return "general";
}

export async function processAndUpsert({
  companyId,
  name,
  type = "text",
  agentId,
  sourceId,
  parentId,
  content,
  metadata,
}) {
  const chunks = chunkText(content);
  const docs = [];
  const records = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000));

    const enrichedText = `
Title: ${name || ""}
Agent: ${agentId}
Type: ${type}
Source: ${metadata?.url || metadata?.title || "text"}

Content:
${chunk}
`;

    const embedding = await createEmbedding(enrichedText);

    if (!embedding || embedding.length === 0) {
      logger.warn(`Skipping chunk ${i} due to empty embedding.`);
      continue;
    }

    // Pad embedding if necessary
    const indexDim = await getIndexDimension();
    const paddedEmbedding = padEmbedding(embedding, indexDim);

    docs.push({
      name,
      type,
      agentId,
      companyId,
      sourceId: `${sourceId}-${i}`,
      content: chunk,
      embedding: paddedEmbedding,
      metadata,
    });

    records.push({
      id: `${sourceId}-${i}`,
      values: paddedEmbedding,
      metadata: {
        text: chunk,
        agentId: agentId?.toString?.() || agentId,
        companyId: companyId?.toString?.() || companyId,
        sourceId: `${sourceId}-${i}`,
        parentId: parentId || sourceId,
        originalMetadata: metadata ? JSON.stringify(metadata) : "",
        name,
        type,
        intent: detectIntent(name, chunk),
        createdAt: new Date().toISOString(),
      },
    });
  }

  if (records.length) {
    await pineconeIndex.upsert({
      namespace: String(companyId),
      records,
    });
  }

  return docs;
}

export async function processFileAndUpsert({
  companyId,
  agentId,
  sourceId,
  name,
  filePath,
  mimeType,
  metadata = {},
}) {
  logger.info(`Processing file for company: ${companyId}, file: ${name}`);

  // 1. Extract text from file
  const content = await processFile(filePath, mimeType);

  if (!content || content.trim().length === 0) {
    throw new Error("Empty document content extracted");
  }

  // 2. Process and Upsert using existing logic
  return await processAndUpsert({
    companyId,
    name,
    type: "file",
    agentId,
    sourceId,
    content,
    metadata,
  });
}

export async function processScrapedData({
  items,
  companyId,
  agentId,
  websiteId,
}) {
  const allDocs = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (!item.text || !item.text.trim()) {
      logger.warn(
        `Skipping item ${i + 1}/${items.length}: ${item.url} (Empty content)`,
      );
      continue;
    }

    logger.info(`Processing item ${i + 1}/${items.length}: ${item.url}`);

    const docs = await processAndUpsert({
      companyId,
      name: item.title,
      type: "website",
      agentId,
      sourceId: `${websiteId}-${i}`,
      parentId: websiteId,
      content: `
      Title: ${item.title || ""}
      URL: ${item.url || ""}
      
      Content:
      ${item.text}`,
      metadata: {
        url: item.url,
        title: item.title,
        text: item.text,
      },
    });

    allDocs.push(...docs);
  }

  return allDocs;
}

export async function deleteIds(ids, companyId) {
  try {
    // Delete by sourceId (exact match for old data)
    await pineconeIndex.deleteMany({
      namespace: String(companyId),
      filter: { sourceId: { $in: ids } },
    });

    // Delete by parentId (for new data)
    await pineconeIndex.deleteMany({
      namespace: String(companyId),
      filter: { parentId: { $in: ids } },
    });
  } catch (error) {
    logger.error("Error deleting IDs from Pinecone:", error);
  }
}

export async function searchPinecone({
  query,
  agentId,
  companyId,
  limit = 10,
}) {
  const queryEmbedding = await createEmbedding(query);
  const indexDim = await getIndexDimension();
  const paddedEmbedding = padEmbedding(queryEmbedding, indexDim);

  try {
    const results = await pineconeIndex.query({
      vector: paddedEmbedding,
      topK: limit,
      includeMetadata: true,
      namespace: String(companyId),
      filter: { agentId: agentId?.toString?.() || agentId },
    });

    return results.matches.map((m) => {
      let metadata = m.metadata || {};
      if (metadata.originalMetadata) {
        try {
          const parsed = JSON.parse(metadata.originalMetadata);
          metadata = { ...metadata, ...parsed };
        } catch (e) {}
      }
      return {
        content: m.metadata?.text || "",
        metadata,
        sourceId: m.metadata?.sourceId || m.id,
        score: m.score || 0,
      };
    });
  } catch (error) {
    logger.error("Pinecone Search Error:", error);
    return {
      status: "ERROR",
      chunks: [],
    };
  }
}

export async function generateResponse({ query, contextChunks, systemPrompt }) {
  const STRONG_SCORE = 0.65;
  const WEAK_SCORE = 0.45;

  const strongChunks = contextChunks.filter((c) => c.score >= STRONG_SCORE);
  const weakChunks = contextChunks.filter((c) => c.score >= WEAK_SCORE);

  const selectedChunks =
    strongChunks.length > 0 ? strongChunks.slice(0, 3) : weakChunks.slice(0, 2);

  const contextText = selectedChunks.map(getChunkText).join("\n\n");

  //   const prompt = `
  // ${systemPrompt || "You are a precise question-answering AI."}

  // Strict Rules:
  // 1. You are a specialized support agent. Your knowledge is STRICTLY limited to the provided Context.
  //    - If the message is simple like "hello", "hi", "how are you", etc., respond with a simple greeting
  //    - if you analyze that question is not full or not clear that answer as per that like example 'how to" then say please provide more details etc...
  //    - You can analyze ans where you have to proivde answers like 'Thank you", 'Goodbye', etc.
  //      in the SAME JSON format described below and set "found": true.
  // 2. Answer ONLY using the information from the Context and speak like an agent of that company.
  // 3. NEVER use your internal training data, general knowledge, or assumptions.
  // 4. If the exact answer is NOT found in the Context, you MUST respond EXACTLY in the following JSON format
  //    and nothing else:

  // {
  //   "answer": "I'm sorry, I can't help with that. Is there anything else I can assist you with?",
  //   "found": false
  // }

  // 5. If the answer IS found in the Context, you MUST respond in the following JSON format:

  // {
  //   "answer": "<your answer here>",
  //   "found": true
  // }

  // 6. Do NOT make up features, services, or facts that are not explicitly stated in the Context only can give greeting on follow up questions.
  // 7. Keep answers concise (2–3 sentences max).
  // 8. You MUST return ONLY valid JSON. No markdown, no extra text, no explanations.

  // Context:
  // ${contextText}

  // Question:
  // ${query}
  // `;

  const prompt = `
${systemPrompt || "You are a precise question-answering AI."}

You are a customer support agent for this company.

DECISION RULES (follow in order):

STEP 1: Message Type Classification
First, classify the user message into ONE of these types:
A) Greeting / courtesy (hello, hi, thanks, thank you, goodbye, nice, great, ok, etc.)
B) Incomplete or unclear question (e.g. "how to", "tell me", "what about this")
C) Factual question that requires information
D) Opinion / affirmation (e.g. "that's great", "good score")
E) If query is plus point or profitable for company then ask visitor to contact company directly.

STEP 1.5: Default Entity Assumption (VERY IMPORTANT)
If the user message refers to something that normally belongs to a specific person or entity
(e.g. "resume", "profile", "education", "experience", "contact")
AND the user does NOT explicitly mention a name,
you MUST assume the question refers to the PRIMARY entity described in the Context. 

- if you can't find valid or multiple things and do not differentiate real answer then ask follow up question to clarify. otherwise Do Not Ask Follow Up Question.
- Do NOT refuse
- Do NOT treat it as incomplete
- Answer using the Context as if the entity was specified

STEP 2: How to respond
- If type A, B, or D:
  - Respond politely and naturally
  - Do NOT require the Context
  - Set "found": true

- If type C:
  - You MUST use ONLY the provided Context
  - Do NOT use general knowledge or assumptions
  - Speak like a company support agent

STEP 3: Fallback rule (VERY IMPORTANT)
- If and ONLY IF the message is type C
  AND the required information is NOT present in the Context,
  you MUST respond EXACTLY with: and for sometime you can change the answer but not the format.

{
  "answer": "I'm sorry, I can't help with that. Is there anything else I can assist you with?", 
  "found": false
}

OUTPUT RULES:
- If you respond normally, use this JSON format:

{
  "answer": "<your answer here>",
  "found": true
}

- Keep answers concise (max 2–3 sentences)
- Do NOT invent facts
- Do NOT copy large text verbatim from the Context
- Return ONLY valid JSON
- No markdown, no explanations, no extra text

 if visitor send this msg "I would like to speak to a human agent." then you must respond with:

{
  "answer": "At header please click on 'Request Human' button to speak to a human agent.",
  "found": true
}

Context:
${contextText}

User Message:
${query}
`;

  try {
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    // const result = await axios.post(
    //   "http://localhost:5678/webhook-test/37956eda-ff6b-4a79-9282-7a7bed8df9eb",
    //   {
    //     prompt,
    //   },
    // );
    logger.debug("Gemini Response:", result);

    let rawText =
      result.candidates?.[0]?.content?.parts?.[0]?.text ||
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "{}";

    // Clean up potential markdown formatting from LLM response
    rawText = rawText
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    logger.debug("Cleaned Text:", rawText);

    const parsedAnswer = JSON.parse(rawText) || {
      answer:
        "I'm sorry, I can't help with that. Is there anything else I can assist you with?",
      found: false,
    };
    logger.debug("Parsed Answer:", parsedAnswer);

    return parsedAnswer;
  } catch (e) {
    logger.error("Gemini Generation Error:", e);
    return {
      status: "ERROR",
      answer:
        "I'm sorry, I'm having trouble generating a response right now. Please try again later.",
      found: false,
    };
  }
}

export async function checkRagHealth() {
  const health = {
    pinecone: { status: "unknown", message: "" },
    gemini: { status: "unknown", message: "" },
    embedding: { status: "unknown", message: "" },
    overall: false,
  };

  const timeout = (ms) =>
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms),
    );

  const HEALTH_TIMEOUT = 5000; // 5 seconds timeout for each check

  try {
    const checks = [
      // 1. Check Pinecone
      (async () => {
        try {
          await Promise.race([
            pc.describeIndex(PINECONE_INDEX_NAME),
            timeout(HEALTH_TIMEOUT),
          ]);
          health.pinecone.status = "ok";
        } catch (error) {
          health.pinecone.status = "error";
          health.pinecone.message = error.message;
        }
      })(),

      // 2. Check Gemini
      (async () => {
        try {
          const model = ai.getGenerativeModel({ model: "gemini-2.5-flash" });
          await Promise.race([
            model.countTokens({
              contents: [{ role: "user", parts: [{ text: "ping" }] }],
            }),
            timeout(HEALTH_TIMEOUT),
          ]);
          health.gemini.status = "ok";
        } catch (error) {
          health.gemini.status = "error";
          health.gemini.message = error.message;
        }
      })(),

      // 3. Check Embedding
      (async () => {
        try {
          await Promise.race([
            createEmbedding("health check"),
            timeout(HEALTH_TIMEOUT),
          ]);
          health.embedding.status = "ok";
        } catch (error) {
          health.embedding.status = "error";
          health.embedding.message = error.message;
        }
      })(),
    ];

    await Promise.all(checks);

    health.overall =
      health.pinecone.status === "ok" &&
      health.gemini.status === "ok" &&
      health.embedding.status === "ok";

    return health;
  } catch (error) {
    logger.error("Health Check Failed:", error);
    return { ...health, overall: false, error: error.message };
  }
}

export async function agentKnowledgedDelete(agentId, companyId) {
  try {
    await pineconeIndex.deleteMany({
      namespace: String(companyId),
      filter: { agentId: agentId?.toString?.() || agentId },
    });
    return { success: true, message: "Deleted successfully" };
  } catch (error) {
    logger.error("Error deleting agent knowledge:", error);
    throw error;
  }
}

export async function purgeCompany(companyId) {
  try {
    await pineconeIndex.namespace(String(companyId)).deleteAll();
    return { success: true, message: "Company purged successfully" };
  } catch (error) {
    logger.error("Error purging company knowledge:", error);
    throw error;
  }
}
