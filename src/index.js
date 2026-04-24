import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import rateLimit from "express-rate-limit";

import logger from "./utils/logger.js";
import errorMiddleware from "./utils/errorMiddleware.js";
import catchAsync from "./utils/catchAsync.js";

import {
  processAndUpsert,
  processFileAndUpsert,
  processScrapedData,
  searchPinecone,
  deleteIds,
  generateResponse,
  checkRagHealth,
  agentKnowledgedDelete,
} from "./services/rag.service.js";
import { createEmbedding } from "./services/embedding.service.js";
import { webScraperService } from "./services/webScraper.service.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Security
app.use(helmet());

// Performance
app.use(compression());

// Logging
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined", { stream: { write: (message) => logger.info(message.trim()) } }));
}

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // lower limit for RAG as it is expensive
  message: "Too many requests to RAG service, please try again later",
});
app.use("/rag", limiter);

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(",") 
      : [];
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked for RAG service origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/", (req, res) => {
  res.send("RAG Service is running");
});

// Detailed Availability Check
app.get("/rag/available", catchAsync(async (req, res) => {
  const health = await checkRagHealth();
  res.json(health.overall);
}));

// Process and Upsert Knowledge
app.post("/process", catchAsync(async (req, res) => {
  const { companyId, name, type, agentId, sourceId, content, metadata } = req.body;
  logger.info(`Processing knowledge for company: ${companyId}`);

  if (!companyId || !content || !sourceId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const docs = await processAndUpsert({
    companyId,
    name,
    type,
    agentId,
    sourceId,
    content,
    metadata,
  });

  res.json({ success: true, docs });
}));

// Process and Upsert File Knowledge
app.post("/process-file", catchAsync(async (req, res) => {
  const { companyId, agentId, sourceId, name, filePath, mimeType, metadata } = req.body;
  logger.info(`Processing file knowledge for company: ${companyId}`);

  if (!companyId || !filePath || !sourceId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const docs = await processFileAndUpsert({
    companyId,
    agentId,
    sourceId,
    name,
    filePath,
    mimeType,
    metadata,
  });

  res.json({ success: true, docs });
}));

// Search Pinecone
app.post("/search", catchAsync(async (req, res) => {
  const { query, agentId, companyId, limit } = req.body;
  logger.info(`Search request for company: ${companyId}`);

  if (!query || !companyId) {
    return res.status(400).json({ error: "Missing query or companyId" });
  }

  const results = await searchPinecone({
    query,
    agentId,
    companyId,
    limit,
  });

  res.json({ success: true, results });
}));

// Generate Response
app.post("/generate", catchAsync(async (req, res) => {
  const { query, contextChunks, systemPrompt } = req.body;
  logger.info("Generating AI response");

  if (!query || !contextChunks) {
    return res.status(400).json({ error: "Missing query or contextChunks" });
  }

  const response = await generateResponse({
    query,
    contextChunks,
    systemPrompt,
  });

  res.json({ success: true, response });
}));

// Scrape Website and Index
app.post("/scrape-and-index", catchAsync(async (req, res) => {
  const { url, companyId, agentId, websiteId } = req.body;
  if (!url || !companyId || !agentId || !websiteId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  logger.info(`Starting scrape for ${url}`);
  const scrapeResult = await webScraperService(url);

  if (!scrapeResult || !scrapeResult.items || scrapeResult.items.length === 0) {
    return res.status(200).json({ success: true, docs: [] });
  }

  try {
    logger.info(`Deleting previous vectors for websiteId=${websiteId}`);
    await deleteIds([websiteId], companyId);
  } catch (delErr) {
    logger.warn(`Pre-index deletion warning: ${delErr?.message || delErr}`);
  }

  const docs = await processScrapedData({
    items: scrapeResult.items,
    companyId,
    agentId,
    websiteId,
  });

  res.json({ success: true, docs, pageCount: scrapeResult.pageCount });
}));

// Delete Knowledge
app.post("/delete", catchAsync(async (req, res) => {
  const { ids, companyId } = req.body;
  if (!ids || !Array.isArray(ids) || !companyId) {
    return res.status(400).json({ error: "Missing ids array or companyId" });
  }

  await deleteIds(ids, companyId);
  res.json({ success: true, message: "Deleted successfully" });
}));

app.delete("/delete-knowledge-of-agent/:agentId/:companyId", catchAsync(async (req, res) => {
  const { agentId, companyId } = req.params;
  await agentKnowledgedDelete(agentId, companyId);
  res.json({ success: true, message: "Deleted successfully" });
}));

// Generate Embedding (Utility)
app.post("/embed", catchAsync(async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });

  const embedding = await createEmbedding(text);
  res.json({ success: true, embedding });
}));

// Error Handling
app.use(errorMiddleware);

const server = app.listen(PORT, () => {
  logger.info(`RAG Service running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});
server.setTimeout(300000); // 5 minutes timeout for heavy processing

// Graceful Shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received. Shutting down RAG service...");
  server.close(() => {
    logger.info("RAG Service process terminated.");
    process.exit(0);
  });
});

