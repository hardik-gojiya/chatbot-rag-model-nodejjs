import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY,
});

const embeddingCache = new Map();
const MAX_CACHE_SIZE = 1000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createEmbedding(text, retries = 5, initialDelay = 1000) {
  if (!text || !text.trim()) {
    console.warn("Empty text provided to createEmbedding. Skipping.");
    return [];
  }

  if (embeddingCache.has(text)) {
    return embeddingCache.get(text);
  }

  let currentDelay = initialDelay;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: [text],
        config: {
          outputDimensionality: 768,
        },
      });

      const embedding = response.embeddings[0].values;

      if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
      }
      embeddingCache.set(text, embedding);

      return embedding;
    } catch (error) {
      // Check for rate limit/quota errors (429 or RESOURCE_EXHAUSTED)
      const isRateLimit =
        error.status === 429 ||
        (error.error && error.error.code === 429) ||
        error.message?.includes("RESOURCE_EXHAUSTED") ||
        error.message?.includes("429");

      if (isRateLimit && attempt < retries) {
        console.warn(
          `Rate limit hit. Retrying in ${currentDelay}ms... (Attempt ${
            attempt + 1
          }/${retries})`
        );
        await delay(currentDelay);
        currentDelay *= 2; // Exponential backoff
        continue;
      }

      console.error("Gemini Embedding Error:", error);
      throw error;
    }
  }
}
