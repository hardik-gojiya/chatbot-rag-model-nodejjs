import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  processAndUpsert,
  processScrapedData,
  searchPinecone,
  deleteIds,
  generateResponse,
  checkRagHealth,
} from "./services/rag.service.js";
import { createEmbedding } from "./services/embedding.service.js";
import { webScraperService } from "./services/webScraper.service.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Increase server timeout to 5 minutes
const server = app.listen(PORT, () => {
  console.log(`RAG Service running on port ${PORT}`);
});
server.setTimeout(300000);

// Health check
app.get("/", (req, res) => {
  res.send("RAG Service is running");
});

// Detailed Availability Check
app.get("/rag/available", async (req, res) => {
  try {
    const health = await checkRagHealth();
    res.json(health.overall);
  } catch (error) {
    console.error("Error in /rag/available:", error);
    res.json(false);
  }
});

// Process and Upsert Knowledge
app.post("/process", async (req, res) => {
  try {
    const { companyId, name, type, agentId, sourceId, content, metadata } =
      req.body;

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
  } catch (error) {
    console.error("Error in /process:", error);
    res.status(500).json({ error: error.message });
  }
});

// Search Pinecone
app.post("/search", async (req, res) => {
  try {
    console.log("Search request recieved.");
    const { query, agentId, companyId, limit } = req.body;

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
  } catch (error) {
    console.error("Error in /search:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate Response
app.post("/generate", async (req, res) => {
  try {
    const { query, contextChunks, systemPrompt } = req.body;

    if (!query || !contextChunks) {
      return res.status(400).json({ error: "Missing query or contextChunks" });
    }

    const response = await generateResponse({
      query,
      contextChunks,
      systemPrompt,
    });

    res.json({ success: true, response });
  } catch (error) {
    console.error("Error in /generate:", error);
    res.status(500).json({ error: error.message });
  }
});

// Scrape Website and Index
app.post("/scrape-and-index", async (req, res) => {
  try {
    const { url, companyId, agentId, websiteId } = req.body;
    if (!url || !companyId || !agentId || !websiteId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log(`Starting scrape for ${url}`);
    const scrapeResult = await webScraperService(url);

    if (
      !scrapeResult ||
      !scrapeResult.items ||
      scrapeResult.items.length === 0
    ) {
      return res.status(200).json({ success: true, docs: [] });
    }

    console.log(
      `Scraped ${scrapeResult.items.length} pages. Starting processing...`,
    );
    const docs = await processScrapedData({
      items: scrapeResult.items,
      companyId,
      agentId,
      websiteId,
    });

    res.json({ success: true, docs, pageCount: scrapeResult.pageCount });
  } catch (error) {
    console.error("Error in /scrape-and-index:", error);
    res.status(500).json({ error: error.message });
  }
});

// Scrape Website (Legacy/Raw)
app.post("/scrape", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Missing url" });
    }

    const scrapeResult = await webScraperService(url);
    if (!scrapeResult) {
      return res.status(500).json({ error: "Scraping failed" });
    }

    res.json({
      success: true,
      items: scrapeResult.items,
      pageCount: scrapeResult.pageCount,
    });
  } catch (error) {
    console.error("Error in /scrape:", error);
    res.status(500).json({ error: error.message });
  }
});

// Delete Knowledge
app.post("/delete", async (req, res) => {
  try {
    const { ids, companyId } = req.body;

    if (!ids || !Array.isArray(ids) || !companyId) {
      return res.status(400).json({ error: "Missing ids array or companyId" });
    }

    await deleteIds(ids, companyId);

    res.json({ success: true, message: "Deleted successfully" });
  } catch (error) {
    console.error("Error in /delete:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate Embedding (Utility)
app.post("/embed", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    const embedding = await createEmbedding(text);
    res.json({ success: true, embedding });
  } catch (error) {
    console.error("Error in /embed:", error);
    res.status(500).json({ error: error.message });
  }
});
